import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attempt, cancel, markUnknown, reconcile, settle,
  ResourceError, type OperationState, type ResourceOperation,
} from '../src/domain/resource.js';
import {
  EffectFailure, resourceCommands, type ResourceEffectPort, type ResourceStore,
} from '../src/application/resource.js';
import { memoryResourceStore } from '../src/adapters/resource/memory.js';

const RESOURCE_ID = 'browser:primary';
const OWNER = 'owner-a';
const OTHER_OWNER = 'owner-b';
const START = 1_000_000;

/** Validate the stable ResourceError code; error messages are not part of the contract. */
function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ResourceError, `expected ResourceError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

/** A scripted external capability: records every dispatch, runs the supplied script. */
function scriptedEffect(script: (operation: ResourceOperation) => Promise<unknown>) {
  const calls: ResourceOperation[] = [];
  const port: ResourceEffectPort = {
    async invoke(operation) {
      calls.push(operation);
      return script(operation);
    },
  };
  return { calls, port };
}

/** A bare operation record for pure-transition tests. */
function operation(state: OperationState, revision = 0): ResourceOperation {
  return { id: 'op', requestId: 'req', resourceId: RESOURCE_ID, controlEpoch: 1, state, revision, fingerprint: 'fingerprint' };
}

/** Turn a command outcome into either `{value}` or `{error}` without an unhandled rejection. */
async function settled<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(value => ({ value }), error => ({ error }));
}

/**
 * Memory store plus the fault-injection seams used by command-level tests:
 * - `stats.commits` makes "invalid input writes nothing" observable;
 * - `hooks.failSettlement` fails the next `done/unknown/failed` settle commit,
 *   simulating a crash between the external call and the settlement write;
 * - `hooks.hideResource` makes every load resolve to `undefined`, simulating the
 *   resource disappearing (delete/storage loss) mid-operation.
 * Read/write interleavings are simulated by the separate `racingFixture` /
 * `revisionRacingFixture` below, which inject a competing write after `load`.
 */
function fixture() {
  let now = START;
  const inner = memoryResourceStore();
  const stats = { commits: 0 };
  const hooks = { failSettlement: false, hideResource: false };
  const store: ResourceStore = {
    load: id => (hooks.hideResource ? Promise.resolve(undefined) : inner.load(id)),
    loadOperation: id => inner.loadOperation(id),
    findOperation: (resourceId, requestId) => inner.findOperation(resourceId, requestId),
    loadReceipt: (resourceId, requestId) => inner.loadReceipt(resourceId, requestId),
    commit: async (resourceId, mutation) => {
      stats.commits += 1;
      const settled = mutation.operation?.value.state;
      if (hooks.failSettlement && (settled === 'done' || settled === 'unknown' || settled === 'failed')) {
        hooks.failSettlement = false;
        throw new ResourceError('RESOURCE_CONFLICT');
      }
      return inner.commit(resourceId, mutation);
    },
  };
  const commands = resourceCommands(store, () => now);
  const acquire = () => commands.acquire({ resourceId: RESOURCE_ID, requestId: 'acquire', owner: OWNER, ttlMs: 600_000 });
  const begin = (suffix: string, controlEpoch: number) => commands.beginOperation({
    operationId: `op-${suffix}`, requestId: `req-${suffix}`, resourceId: RESOURCE_ID, controlEpoch,
  });
  return { inner, stats, hooks, commands, acquire, begin, advance(ms: number) { now += ms; } };
}

/**
 * Wrapper store that interleaves a competing `takeover` between the application's
 * read and its commit, exactly as an asynchronous real store could: the hook runs
 * after `load` resolves and before the application sees the loaded value.
 */
function racingFixture() {
  let now = START;
  const inner = memoryResourceStore();
  const racer = resourceCommands(inner, () => now);
  const hooks = { afterLoad: undefined as (() => Promise<unknown>) | undefined };
  const store: ResourceStore = {
    async load(id) {
      const value = await inner.load(id);
      const hook = hooks.afterLoad;
      if (hook !== undefined) {
        hooks.afterLoad = undefined;
        await hook();
      }
      return value;
    },
    loadOperation: id => inner.loadOperation(id),
    findOperation: (resourceId, requestId) => inner.findOperation(resourceId, requestId),
    loadReceipt: (resourceId, requestId) => inner.loadReceipt(resourceId, requestId),
    commit: (resourceId, mutation) => inner.commit(resourceId, mutation),
  };
  const commands = resourceCommands(store, () => now);
  const acquire = () => commands.acquire({ resourceId: RESOURCE_ID, requestId: 'acquire', owner: OWNER, ttlMs: 600_000 });
  const takeOver = () => racer.takeover({
    resourceId: RESOURCE_ID, requestId: 'interleaved-takeover', owner: OTHER_OWNER, ttlMs: 600_000,
  });
  return { inner, racer, hooks, commands, acquire, takeOver };
}

/**
 * Wrapper store that injects a same-epoch competing `renew` (revision bump, same
 * control) after each `load`, so guarded attempt commits lose the revision CAS.
 * `arm(count)` enables injection only after test setup, one bump per load.
 */
function revisionRacingFixture() {
  let now = START;
  let injections = 0;
  const inner = memoryResourceStore();
  const racer = resourceCommands(inner, () => now);
  const store: ResourceStore = {
    async load(id) {
      const value = await inner.load(id);
      if (injections > 0) {
        injections -= 1;
        await racer.renew({
          resourceId: RESOURCE_ID, requestId: `interleaved-renew-${injections}`, owner: OWNER,
          epoch: value?.controlEpoch ?? 1, ttlMs: 600_000,
        });
      }
      return value;
    },
    loadOperation: id => inner.loadOperation(id),
    findOperation: (resourceId, requestId) => inner.findOperation(resourceId, requestId),
    loadReceipt: (resourceId, requestId) => inner.loadReceipt(resourceId, requestId),
    commit: (resourceId, mutation) => inner.commit(resourceId, mutation),
  };
  const commands = resourceCommands(store, () => now);
  const acquire = () => commands.acquire({ resourceId: RESOURCE_ID, requestId: 'acquire', owner: OWNER, ttlMs: 600_000 });
  const begin = (suffix: string, controlEpoch: number) => commands.beginOperation({
    operationId: `op-${suffix}`, requestId: `req-${suffix}`, resourceId: RESOURCE_ID, controlEpoch,
  });
  return { inner, commands, acquire, begin, arm(count: number) { injections = count; } };
}

/* -------------------------------------------------------------------------- */
/* Domain state machine (pure transitions)                                     */
/* -------------------------------------------------------------------------- */

test('operation state machine accepts only the legal transitions', () => {
  const intent = operation('intent');
  const attempting = attempt(intent);
  assert.deepEqual(attempting, { ...intent, state: 'attempting', revision: 1 });
  assert.deepEqual(intent, operation('intent'), 'pure transitions never mutate their input');
  const done = settle(attempting, { state: 'done', result: { ok: true } });
  assert.equal(done.state, 'done');
  assert.equal(done.revision, 2);
  assert.deepEqual(done.result, { ok: true });
  const failed = settle(attempting, { state: 'failed' });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.revision, 2);
  const unknown = markUnknown(attempting, 'timed out');
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.revision, 2);
  assert.equal(unknown.observation, 'timed out');
  const reconciledDone = reconcile(unknown, { state: 'done', result: { ok: true }, observation: 'confirmed' });
  assert.equal(reconciledDone.state, 'done');
  assert.equal(reconciledDone.revision, 3);
  assert.deepEqual(reconciledDone.result, { ok: true });
  assert.equal(reconciledDone.observation, 'confirmed');
  assert.equal(reconcile(unknown, { state: 'failed' }).state, 'failed');
});

test('illegal operation transitions are rejected with INVALID_TRANSITION', () => {
  for (const state of ['attempting', 'unknown', 'done', 'failed'] as const) {
    assert.throws(() => attempt(operation(state)), hasCode('INVALID_TRANSITION'), `attempt from ${state}`);
  }
  // intent cannot be settled directly, and unknown may only be reconciled.
  for (const state of ['intent', 'unknown'] as const) {
    assert.throws(() => settle(operation(state), { state: 'done' }), hasCode('INVALID_TRANSITION'), `settle from ${state}`);
  }
  for (const state of ['intent', 'unknown', 'done', 'failed'] as const) {
    assert.throws(() => markUnknown(operation(state)), hasCode('INVALID_TRANSITION'), `markUnknown from ${state}`);
  }
  for (const state of ['intent', 'attempting'] as const) {
    assert.throws(() => reconcile(operation(state), { state: 'done' }), hasCode('INVALID_TRANSITION'), `reconcile from ${state}`);
  }
  // unknown is a conservative terminal: it must never go back to attempting.
  assert.throws(() => attempt(operation('unknown')), hasCode('INVALID_TRANSITION'));
});

test('terminal operation states are idempotent and never rewritten', () => {
  const attempting = attempt(operation('intent'));
  const done = settle(attempting, { state: 'done', result: 'first result' });
  assert.deepEqual(settle(done, { state: 'failed' }), done);
  assert.deepEqual(reconcile(done, { state: 'failed' }), done);
  const failed = settle(attempting, { state: 'failed' });
  assert.deepEqual(settle(failed, { state: 'done' }), failed);
  assert.deepEqual(reconcile(failed, { state: 'done' }), failed);
});

test('operation transitions validate observation and settlement input', () => {
  const attempting = attempt(operation('intent'));
  const unknown = markUnknown(attempting);
  assert.throws(() => markUnknown(attempting, 'x'.repeat(513)), hasCode('INVALID_COMMAND'));
  assert.throws(() => markUnknown(attempting, 7 as unknown as string), hasCode('INVALID_COMMAND'));
  assert.throws(() => reconcile(unknown, { state: 'done', observation: 'x'.repeat(513) }), hasCode('INVALID_COMMAND'));
  assert.throws(() => reconcile(unknown, { state: 'done', observation: 7 as unknown as string }), hasCode('INVALID_COMMAND'));
  assert.throws(() => settle(attempting, { state: 'unknown' as never }), hasCode('INVALID_COMMAND'));
});

test('cancel closes a pending intent as failed with a stable code and nothing else', () => {
  const intent = operation('intent');
  const cancelled = cancel(intent, 'STALE_CONTROL');
  assert.deepEqual(cancelled, { ...intent, state: 'failed', revision: 1, result: 'STALE_CONTROL' });
  assert.deepEqual(intent, operation('intent'), 'cancel must not mutate its input');
  for (const state of ['attempting', 'unknown', 'done', 'failed'] as const) {
    assert.throws(() => cancel(operation(state), 'STALE_CONTROL'), hasCode('INVALID_TRANSITION'), `cancel from ${state}`);
  }
  for (const code of ['', 'bad code', 'x'.repeat(129), 7 as unknown as string]) {
    assert.throws(() => cancel(intent, code), hasCode('INVALID_COMMAND'), `cancel code ${String(code)}`);
  }
  // A cancelled intent is terminal and can never be attempted afterwards.
  assert.throws(() => attempt(cancelled), hasCode('INVALID_TRANSITION'));
});

/* -------------------------------------------------------------------------- */
/* Application commands                                                        */
/* -------------------------------------------------------------------------- */

test('beginOperation requires an existing resource under the current control epoch', async () => {
  const f = fixture();
  await assert.rejects(f.commands.beginOperation({
    operationId: 'op-1', requestId: 'req-1', resourceId: RESOURCE_ID, controlEpoch: 0,
  }), hasCode('RESOURCE_NOT_FOUND'));
  const resource = await f.acquire();
  await assert.rejects(f.commands.beginOperation({
    operationId: 'op-1', requestId: 'req-1', resourceId: RESOURCE_ID, controlEpoch: 0,
  }), hasCode('STALE_CONTROL'));
  const created = await f.commands.beginOperation({
    operationId: 'op-1', requestId: 'req-1', resourceId: RESOURCE_ID, controlEpoch: resource.controlEpoch,
  });
  assert.equal(created.state, 'intent');
  assert.equal(created.id, 'op-1');
  assert.equal(created.requestId, 'req-1');
  assert.equal(created.resourceId, RESOURCE_ID);
  assert.equal(created.controlEpoch, resource.controlEpoch);
  assert.ok(Number.isSafeInteger(created.revision) && created.revision >= 0);
  // Same key and same content replays the original operation; different content conflicts.
  assert.deepEqual(await f.commands.beginOperation({
    operationId: 'op-1', requestId: 'req-1', resourceId: RESOURCE_ID, controlEpoch: resource.controlEpoch,
  }), created);
  await assert.rejects(f.commands.beginOperation({
    operationId: 'op-2', requestId: 'req-1', resourceId: RESOURCE_ID, controlEpoch: resource.controlEpoch,
  }), hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.commands.observeOperation({ operationId: 'missing-operation', status: 'done' }), hasCode('OPERATION_NOT_FOUND'));
});

test('runOperation settles a successful effect once: intent -> attempting -> done', async () => {
  const f = fixture();
  const resource = await f.acquire();
  const created = await f.begin('success', resource.controlEpoch);
  const effect = scriptedEffect(async attempted => {
    assert.equal(attempted.state, 'attempting', 'the external call only happens after the attempt is recorded');
    return { output: 'delivered' };
  });
  const done = await f.commands.runOperation(created.id, effect.port);
  assert.equal(done.state, 'done');
  assert.deepEqual(done.result, { output: 'delivered' });
  assert.equal(effect.calls.length, 1);
  assert.deepEqual(await f.commands.runOperation(created.id, effect.port), done);
  assert.equal(effect.calls.length, 1, 'a done operation is never dispatched again');
});

test('known failures settle failed, unknown failures settle unknown, and neither is replayed', async () => {
  const f = fixture();
  const resource = await f.acquire();
  const knownFailure = scriptedEffect(async () => { throw new EffectFailure('failed', 'PROVIDER_REJECTED'); });
  const failedOperation = await f.begin('known', resource.controlEpoch);
  const failed = await f.commands.runOperation(failedOperation.id, knownFailure.port);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.result, 'PROVIDER_REJECTED', 'a known failure keeps its stable code for audit');
  assert.equal(knownFailure.calls.length, 1);
  assert.deepEqual(await f.commands.runOperation(failedOperation.id, knownFailure.port), failed);
  assert.equal(knownFailure.calls.length, 1, 'a failed operation is never retried automatically');

  const uncertainFailure = scriptedEffect(async () => { throw new EffectFailure('unknown', 'TIMEOUT'); });
  const uncertainOperation = await f.begin('uncertain', resource.controlEpoch);
  assert.equal((await f.commands.runOperation(uncertainOperation.id, uncertainFailure.port)).state, 'unknown');

  const crash = scriptedEffect(async () => { throw new Error('socket hang up'); });
  const crashedOperation = await f.begin('crash', resource.controlEpoch);
  assert.equal((await f.commands.runOperation(crashedOperation.id, crash.port)).state, 'unknown');
  assert.equal(crash.calls.length, 1);
  for (let retry = 0; retry < 3; retry += 1) {
    assert.equal((await f.commands.runOperation(crashedOperation.id, crash.port)).state, 'unknown');
  }
  assert.equal(crash.calls.length, 1, 'unknown may never be replayed automatically');
});

test('a crash before settlement leaves attempting; recovery marks unknown without replaying the effect', async () => {
  const f = fixture();
  const resource = await f.acquire();
  const created = await f.begin('stuck', resource.controlEpoch);
  const effect = scriptedEffect(async () => ({ delivered: true }));
  f.hooks.failSettlement = true;
  await assert.rejects(f.commands.runOperation(created.id, effect.port), hasCode('RESOURCE_CONFLICT'));
  assert.equal(effect.calls.length, 1);
  const stuck = await f.inner.loadOperation(created.id);
  assert.equal(stuck?.state, 'attempting', 'a failed settle write keeps the operation attempting for recovery');
  await assert.rejects(f.commands.observeOperation({ operationId: created.id, status: 'done' }),
    hasCode('INVALID_TRANSITION'), 'attempting must be recovered to unknown before observation');
  const recovered = await f.commands.runOperation(created.id, effect.port);
  assert.equal(recovered.state, 'unknown');
  assert.equal(effect.calls.length, 1, 'recovery must observe, never re-execute');
  const reconciled = await f.commands.observeOperation({
    operationId: created.id, status: 'done', result: { delivered: true }, observation: 'delivery confirmed by provider',
  });
  assert.equal(reconciled.state, 'done');
  assert.deepEqual(reconciled.result, { delivered: true });
  assert.equal(reconciled.observation, 'delivery confirmed by provider');
  assert.deepEqual(await f.commands.runOperation(created.id, effect.port), reconciled);
  assert.equal(effect.calls.length, 1);
});

test('observeOperation only reconciles unknown and returns terminal states unchanged', async () => {
  const f = fixture();
  const resource = await f.acquire();
  const intent = await f.begin('intent', resource.controlEpoch);
  await assert.rejects(f.commands.observeOperation({ operationId: intent.id, status: 'done' }),
    hasCode('INVALID_TRANSITION'), 'intent has not performed an external action yet');
  const pending = await f.begin('pending', resource.controlEpoch);
  const effect = scriptedEffect(async () => 'ok');
  f.hooks.failSettlement = true;
  await assert.rejects(f.commands.runOperation(pending.id, effect.port), hasCode('RESOURCE_CONFLICT'));
  const unknown = await f.commands.runOperation(pending.id, effect.port);
  assert.equal(unknown.state, 'unknown');
  const failed = await f.commands.observeOperation({
    operationId: pending.id, status: 'failed', observation: 'provider says no',
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.observation, 'provider says no');
  // Terminal states are terminal: a later observe does not rewrite them.
  assert.deepEqual(await f.commands.observeOperation({
    operationId: pending.id, status: 'done', result: 'late result',
  }), failed);
  assert.deepEqual(await f.commands.runOperation(pending.id, effect.port), failed);
  assert.equal(effect.calls.length, 1);
});

test('runOperation is fenced by control epoch: a stale operation fails without dispatching', async () => {
  const f = fixture();
  const resource = await f.acquire();
  const created = await f.begin('fenced', resource.controlEpoch);
  const taken = await f.commands.takeover({
    resourceId: RESOURCE_ID, requestId: 'takeover-fence', owner: 'owner-b', ttlMs: 60_000,
  });
  assert.equal(taken.controlEpoch, 2);
  const effect = scriptedEffect(async () => 'must not run');
  await assert.rejects(f.commands.runOperation(created.id, effect.port), hasCode('STALE_CONTROL'));
  assert.equal(effect.calls.length, 0, 'a stale control epoch must never dispatch the effect');
  const stored = await f.inner.loadOperation(created.id);
  assert.equal(stored?.state, 'failed');
  assert.match(JSON.stringify(stored?.result ?? null), /STALE_CONTROL/);
});

test('runOperation fails without dispatching when the resource has disappeared', async () => {
  const f = fixture();
  const resource = await f.acquire();
  const created = await f.begin('vanished', resource.controlEpoch);
  f.hooks.hideResource = true;
  const effect = scriptedEffect(async () => 'must not run');
  await assert.rejects(f.commands.runOperation(created.id, effect.port), hasCode('RESOURCE_NOT_FOUND'));
  assert.equal(effect.calls.length, 0);
  const stored = await f.inner.loadOperation(created.id);
  assert.equal(stored?.state, 'failed');
  assert.match(JSON.stringify(stored?.result ?? null), /RESOURCE_NOT_FOUND/);
});

test('concurrent duplicate beginOperation stores one operation and only one CAS write wins', async () => {
  const f = fixture();
  const resource = await f.acquire();
  const input = {
    operationId: 'op-race', requestId: 'req-race', resourceId: RESOURCE_ID, controlEpoch: resource.controlEpoch,
  };
  const results = await Promise.allSettled([f.commands.beginOperation(input), f.commands.beginOperation({ ...input })]);
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<ResourceOperation> => result.status === 'fulfilled');
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]?.reason instanceof ResourceError);
  assert.equal((rejected[0]!.reason as ResourceError).code, 'RESOURCE_CONFLICT');
  const replay = await f.commands.beginOperation({ ...input });
  assert.deepEqual(replay, fulfilled[0]!.value);
  assert.deepEqual(await f.inner.loadOperation('op-race'), replay);
});

test('concurrent acquire by two owners produces one lease and no double owner', async () => {
  const f = fixture();
  const results = await Promise.allSettled([
    f.commands.acquire({ resourceId: RESOURCE_ID, requestId: 'req-a', owner: OWNER, ttlMs: 1000 }),
    f.commands.acquire({ resourceId: RESOURCE_ID, requestId: 'req-b', owner: 'owner-b', ttlMs: 1000 }),
  ]);
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof f.commands.acquire>>> => result.status === 'fulfilled');
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal((rejected[0]!.reason as ResourceError).code, 'RESOURCE_CONFLICT');
  const stored = await f.commands.read(RESOURCE_ID);
  assert.ok(stored);
  assert.equal(stored.owner, fulfilled[0]!.value.owner);
  assert.equal(stored.lease?.owner, stored.owner);
  assert.equal(stored.controlEpoch, 1);
});

test('concurrent runOperation on one operation never dispatches the effect twice', async () => {
  const f = fixture();
  const resource = await f.acquire();
  const created = await f.begin('run-race', resource.controlEpoch);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const effect = scriptedEffect(async () => { await gate; return 'once'; });
  const firstRun = f.commands.runOperation(created.id, effect.port).then(
    () => undefined,
    (error: unknown) => error,
  );
  // The effect has been invoked, which means the attempt write has already landed.
  while (effect.calls.length === 0) await new Promise<void>(resolve => setImmediate(resolve));
  const recovered = await f.commands.runOperation(created.id, effect.port);
  assert.equal(recovered.state, 'unknown', 'a duplicate sees attempting and recovers it without dispatch');
  assert.equal(effect.calls.length, 1);
  release();
  const firstOutcome = await firstRun;
  assert.ok(firstOutcome instanceof ResourceError, 'the original settlement lost the revision CAS');
  assert.equal(firstOutcome.code, 'RESOURCE_CONFLICT');
  assert.equal(effect.calls.length, 1, 'exactly one external call is dispatched');
  const reconciled = await f.commands.observeOperation({ operationId: created.id, status: 'done', result: 'once' });
  assert.equal(reconciled.state, 'done');
});

test('invalid operation inputs are rejected with INVALID_COMMAND and write nothing', async () => {
  const f = fixture();
  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ['beginOperation', null],
    ['beginOperation', []],
    ['beginOperation', {}],
    ['beginOperation', { operationId: '', requestId: 'r', resourceId: RESOURCE_ID, controlEpoch: 0 }],
    ['beginOperation', { operationId: 'x'.repeat(129), requestId: 'r', resourceId: RESOURCE_ID, controlEpoch: 0 }],
    ['beginOperation', { operationId: 'op', requestId: '', resourceId: RESOURCE_ID, controlEpoch: 0 }],
    ['beginOperation', { operationId: 'op', requestId: 'r', resourceId: '', controlEpoch: 0 }],
    ['beginOperation', { operationId: 'op', requestId: 'r', resourceId: RESOURCE_ID, controlEpoch: -1 }],
    ['beginOperation', { operationId: 'op', requestId: 'r', resourceId: RESOURCE_ID, controlEpoch: 1.5 }],
    ['beginOperation', { operationId: 'op', requestId: 'r', resourceId: RESOURCE_ID, controlEpoch: 9_007_199_254_740_992 }],
    ['beginOperation', { operationId: 'op', requestId: 'r', resourceId: RESOURCE_ID, controlEpoch: '1' }],
    ['beginOperation', { operationId: 'op', requestId: 'r', resourceId: RESOURCE_ID, controlEpoch: 0, extra: true }],
    ['observeOperation', null],
    ['observeOperation', {}],
    ['observeOperation', { operationId: '', status: 'done' }],
    ['observeOperation', { operationId: 'op', status: 'unknown' }],
    ['observeOperation', { operationId: 'op', status: 'attempting' }],
    ['observeOperation', { operationId: 'op', status: 'done', observation: 'x'.repeat(513) }],
    ['observeOperation', { operationId: 'op', status: 'done', observation: 7 }],
    ['observeOperation', { operationId: 'op', status: 'done', extra: true }],
  ];
  for (const [name, input] of invalid) {
    const method = f.commands[name as 'beginOperation'];
    await assert.rejects(Promise.resolve(method(input as never)), hasCode('INVALID_COMMAND'),
      `${name} accepted invalid input: ${JSON.stringify(input)}`);
  }
  assert.equal(f.stats.commits, 0, 'invalid input must not reach the store');
  assert.equal(await f.inner.loadOperation('op'), undefined);
});

test('runOperation reports OPERATION_NOT_FOUND for an unknown operation and dispatches nothing', async () => {
  const f = fixture();
  const effect = scriptedEffect(async () => 'must not run');
  await assert.rejects(f.commands.runOperation('missing-operation', effect.port), hasCode('OPERATION_NOT_FOUND'));
  assert.equal(effect.calls.length, 0);
  assert.equal(f.stats.commits, 0);
});

test('race A: takeover between acquire load and commit cannot return a stale success', async () => {
  const f = racingFixture();
  const acquired = await f.acquire();
  assert.equal(acquired.owner, OWNER);
  f.hooks.afterLoad = f.takeOver;
  const outcome = await settled(f.commands.acquire({
    resourceId: RESOURCE_ID, requestId: 'stale-noop-acquire', owner: OWNER, ttlMs: 600_000,
  }));
  assert.ok(outcome.error !== undefined, `stale acquire must not report success: ${JSON.stringify(outcome.value)}`);
  assert.ok(outcome.error instanceof ResourceError);
  const code = outcome.error.code;
  assert.ok(code === 'RESOURCE_CONFLICT' || code === 'RESOURCE_BUSY' || code === 'STALE_CONTROL', `unexpected ${code}`);
  const stored = await f.inner.load(RESOURCE_ID);
  assert.equal(stored?.owner, OTHER_OWNER, 'the interleaved takeover is the only owner');
  assert.equal(stored?.controlEpoch, 2);
  // A retry observes the new owner instead of the stale one.
  await assert.rejects(f.commands.acquire({
    resourceId: RESOURCE_ID, requestId: 'retry-after-race-a', owner: OWNER, ttlMs: 1000,
  }), hasCode('RESOURCE_BUSY'));
});

test('race B: takeover between beginOperation control check and commit cannot create a stale operation', async () => {
  const f = racingFixture();
  const acquired = await f.acquire();
  f.hooks.afterLoad = f.takeOver;
  const outcome = await settled(f.commands.beginOperation({
    operationId: 'op-stale-epoch', requestId: 'req-stale-epoch', resourceId: RESOURCE_ID, controlEpoch: acquired.controlEpoch,
  }));
  assert.ok(outcome.error !== undefined, 'a stale-epoch operation must not be created');
  assert.ok(outcome.error instanceof ResourceError);
  const code = outcome.error.code;
  assert.ok(code === 'STALE_CONTROL' || code === 'RESOURCE_CONFLICT', `unexpected ${code}`);
  assert.equal(await f.inner.loadOperation('op-stale-epoch'), undefined);
  assert.equal(await f.inner.findOperation(RESOURCE_ID, 'req-stale-epoch'), undefined);
  assert.equal((await f.inner.load(RESOURCE_ID))?.controlEpoch, 2);
});

test('race C: takeover between runOperation fence and attempt commit cannot dispatch the effect', async () => {
  const f = racingFixture();
  const acquired = await f.acquire();
  const created = await f.commands.beginOperation({
    operationId: 'op-race-fence', requestId: 'req-race-fence', resourceId: RESOURCE_ID, controlEpoch: acquired.controlEpoch,
  });
  const effect = scriptedEffect(async () => 'must not run');
  f.hooks.afterLoad = f.takeOver;
  const outcome = await settled(f.commands.runOperation(created.id, effect.port));
  assert.equal(effect.calls.length, 0, 'the effect must never run after control was taken over');
  assert.ok(outcome.error !== undefined, 'a stale attempt must not settle as a success');
  assert.ok(outcome.error instanceof ResourceError);
  const code = outcome.error.code;
  assert.ok(code === 'STALE_CONTROL' || code === 'RESOURCE_CONFLICT', `unexpected ${code}`);
  const stored = await f.inner.loadOperation(created.id);
  assert.notEqual(stored?.state, 'done', 'a stale attempt must not become done');
  assert.equal(stored?.state, 'failed', 'lost control closes the intent as failed');
  assert.equal(stored?.result, 'STALE_CONTROL', 'the stable cancellation code is persisted for audit');
  assert.equal((await f.inner.load(RESOURCE_ID))?.controlEpoch, 2);
  // A cancelled intent is terminal: no later run may dispatch it.
  const replay = await settled(f.commands.runOperation(created.id, effect.port));
  assert.equal(replay.error, undefined);
  assert.equal(effect.calls.length, 0);
});

test('race D: a same-epoch revision race retries the attempt and dispatches the effect exactly once', async () => {
  const f = racingFixture();
  const acquired = await f.acquire();
  const created = await f.commands.beginOperation({
    operationId: 'op-race-retry', requestId: 'req-race-retry', resourceId: RESOURCE_ID, controlEpoch: acquired.controlEpoch,
  });
  // Same owner and same epoch, but a concurrent renew bumps the resource revision.
  f.hooks.afterLoad = async () => {
    await f.racer.renew({
      resourceId: RESOURCE_ID, requestId: 'interleaved-renew', owner: OWNER, epoch: acquired.controlEpoch, ttlMs: 600_000,
    });
  };
  const effect = scriptedEffect(async () => 'delivered-once');
  const done = await f.commands.runOperation(created.id, effect.port);
  assert.equal(done.state, 'done');
  assert.deepEqual(done.result, 'delivered-once');
  assert.equal(effect.calls.length, 1, 'the attempt is retried, the external effect never is');
  assert.equal((await f.inner.load(RESOURCE_ID))?.controlEpoch, 1, 'a same-epoch write must not change control');
});

test('different operation ids on one resource commit concurrently without overwriting each other', async () => {
  const f = fixture();
  const resource = await f.acquire();
  const [first, second] = await Promise.all([
    f.commands.beginOperation({
      operationId: 'op-parallel-a', requestId: 'req-parallel-a', resourceId: RESOURCE_ID, controlEpoch: resource.controlEpoch,
    }),
    f.commands.beginOperation({
      operationId: 'op-parallel-b', requestId: 'req-parallel-b', resourceId: RESOURCE_ID, controlEpoch: resource.controlEpoch,
    }),
  ]);
  assert.equal(first.id, 'op-parallel-a');
  assert.equal(second.id, 'op-parallel-b');
  assert.deepEqual(await f.inner.loadOperation('op-parallel-a'), first);
  assert.deepEqual(await f.inner.loadOperation('op-parallel-b'), second);
  // The request index maps each requestId to its own operation: no overwrite.
  assert.deepEqual(await f.inner.findOperation(RESOURCE_ID, 'req-parallel-a'), first);
  assert.deepEqual(await f.inner.findOperation(RESOURCE_ID, 'req-parallel-b'), second);
  const stored = await f.inner.load(RESOURCE_ID);
  assert.equal(stored?.owner, OWNER);
  assert.equal(stored?.controlEpoch, resource.controlEpoch);
  assert.equal(stored?.revision, resource.revision, 'creating intents does not change the resource');
});

test('race E: exhausted attempt retries throw RESOURCE_CONFLICT without dispatching the effect', async () => {
  const f = revisionRacingFixture();
  const resource = await f.acquire();
  const created = await f.begin('retry-exhausted', resource.controlEpoch);
  const effect = scriptedEffect(async () => 'must not run');
  // Three successive same-epoch revision bumps: every guarded attempt commit loses.
  f.arm(3);
  await assert.rejects(f.commands.runOperation(created.id, effect.port), hasCode('RESOURCE_CONFLICT'));
  assert.equal(effect.calls.length, 0, 'no attempt may reach the effect when every guarded commit conflicts');
  const stored = await f.inner.load(RESOURCE_ID);
  assert.equal(stored?.controlEpoch, 1, 'same-epoch injections never change control');
  assert.equal(stored?.revision, resource.revision + 3, 'each competing renew bumped the revision once');
  const operation = await f.inner.loadOperation(created.id);
  assert.equal(operation?.state, 'intent', 'a failed guarded attempt leaves the intent untouched');
});
