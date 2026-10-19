import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createRegistry, defineDocFamily, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
  ResourceError, acquire as acquireState, initialResource,
  type Resource, type ResourceOperation,
} from '../src/domain/resource.js';
import {
  createEffectRegistry, resourceCommands,
  type EffectDefinition, type EffectRegistry, type ResourceCommands, type ResourceEffectPort, type ResourceMutation,
} from '../src/application/resource.js';
import { durableResourceStore } from '../src/runtime/resources.js';
import { openRuntime, type Runtime } from '../src/runtime/open.js';
import {
  ResourceCommandReceipts, ResourceOperationRequests, ResourceOperations, Resources,
  resourceRequestKey,
} from '../src/storage/resource.js';

const RESOURCE_ID = 'browser:primary';
const OWNER = 'owner-a';
const OTHER_OWNER = 'owner-b';
const START = 1_000_000;

function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ResourceError, `expected ResourceError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'point-resource-durable-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

async function openHarness(dir: string): Promise<Harness> {
  return Harness.open(await openNodeSqliteStorage(join(dir, 'state.sqlite')),
    {models: createModels(), registry: createRegistry()}, context);
}

function operation(overrides: Partial<ResourceOperation> = {}): ResourceOperation {
  return {
    id: 'op-1', requestId: 'req-1', resourceId: RESOURCE_ID, controlEpoch: 1,
    state: 'intent', revision: 0, fingerprint: 'fingerprint', ...overrides,
  };
}

const command = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  resourceId: RESOURCE_ID, requestId: 'req-1', owner: OWNER, ttlMs: 120_000, ...overrides,
});

/** One registered test capability used by every secure dispatch in this suite. */
const EFFECT_KIND = 'test.effect';
const TEST_EVIDENCE = {kind: 'test', sha256: 'a'.repeat(64)};

const effectDefinition: EffectDefinition = {
  kind: EFFECT_KIND,
  maxPayloadBytes: 1024,
  maxResultBytes: 1024,
  maxEvidenceBytes: 512,
  validatePayload(payload) {
    if (typeof payload.value !== 'string' || payload.value.length === 0) throw new ResourceError('INVALID_COMMAND');
  },
  validateResult(result) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new ResourceError('RESULT_REJECTED');
  },
  validateEvidence(evidence) {
    if (evidence.kind !== 'test' || typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256)) {
      throw new ResourceError('INVALID_EVIDENCE');
    }
  },
};

const secureOperationInput = (
  controlEpoch: number, deadline: number, overrides: Readonly<Record<string, unknown>> = {},
) => ({
  operationId: 'op-1', requestId: 'req-1', resourceId: RESOURCE_ID, controlEpoch,
  effect: {kind: EFFECT_KIND, payload: {value: 'payload-1'}},
  deadline,
  ...overrides,
});

function registryFor(
  script: (operation: ResourceOperation, invocation?: {signal: AbortSignal; deadline: number}) => Promise<unknown>,
) {
  const calls: ResourceOperation[] = [];
  const effect: ResourceEffectPort = {
    async invoke(operation, invocation) {
      calls.push(operation);
      return script(operation, invocation);
    },
  };
  const registry: EffectRegistry = createEffectRegistry([{definition: effectDefinition, effect}]);
  return {calls, registry};
}

async function assertNoDocuments(
  harness: Harness,
  keys: Readonly<{resourceId: string; operationId: string; requestId: string}>,
) {
  assert.equal(await harness.snapshot(Resources, keys.resourceId, context), undefined, 'no resource document');
  assert.equal(await harness.snapshot(ResourceOperations, keys.operationId, context), undefined, 'no operation document');
  assert.equal(await harness.snapshot(ResourceOperationRequests,
    resourceRequestKey(keys.resourceId, keys.requestId), context), undefined, 'no request index');
  assert.equal(await harness.snapshot(ResourceCommandReceipts,
    resourceRequestKey(keys.resourceId, keys.requestId), context), undefined, 'no receipt');
}

/* -------------------------------------------------------------------------- */
/* Durable store: one-commit CAS, index and receipts                           */
/* -------------------------------------------------------------------------- */

test('resource, operation, request index and receipt commit together and survive reopen', async t => {
  const dir = await directory(t);
  let harness = await openHarness(dir);
  try {
    const store = durableResourceStore(harness);
    const resource = acquireState(initialResource(RESOURCE_ID), {owner: OWNER, ttlMs: 1000}, START);
    const op = operation();
    const receipt = {fingerprint: 'fp-1', result: resource};
    const mutation: ResourceMutation = {
      resource: {value: resource, expectedRevision: undefined},
      operation: {value: op, expectedRevision: undefined},
      receipt: {requestId: 'req-1', receipt},
    };
    await store.commit(RESOURCE_ID, mutation);
    assert.deepEqual(await store.load(RESOURCE_ID), resource);
    assert.deepEqual(await store.loadOperation('op-1'), op);
    assert.deepEqual(await store.findOperation(RESOURCE_ID, 'req-1'), op);
    assert.deepEqual(await store.loadReceipt(RESOURCE_ID, 'req-1'), receipt);
  } finally {
    await harness.close(context);
  }

  // Reopen the same SQLite file: every record is still there with the same values.
  harness = await openHarness(dir);
  try {
    const store = durableResourceStore(harness);
    const resource = acquireState(initialResource(RESOURCE_ID), {owner: OWNER, ttlMs: 1000}, START);
    assert.deepEqual(await store.load(RESOURCE_ID), resource);
    assert.deepEqual(await store.loadOperation('op-1'), operation());
    assert.deepEqual(await store.findOperation(RESOURCE_ID, 'req-1'), operation());
    assert.deepEqual(await store.loadReceipt(RESOURCE_ID, 'req-1'), {fingerprint: 'fp-1', result: resource});
  } finally {
    await harness.close(context);
  }
});

test('a failed operation CAS leaves no resource, operation, index or receipt behind', async t => {
  const dir = await directory(t);
  const harness = await openHarness(dir);
  t.after(() => harness.close(context));
  const store = durableResourceStore(harness);
  const resource = acquireState(initialResource(RESOURCE_ID), {owner: OWNER, ttlMs: 1000}, START);
  await assert.rejects(store.commit(RESOURCE_ID, {
    resource: {value: resource, expectedRevision: undefined},
    operation: {value: operation(), expectedRevision: 42},
    receipt: {requestId: 'req-1', receipt: {fingerprint: 'fp', result: resource}},
  }), hasCode('RESOURCE_CONFLICT'));
  await assertNoDocuments(harness, {resourceId: RESOURCE_ID, operationId: 'op-1', requestId: 'req-1'});
});

test('a conflicting receipt aborts the resource and operation writes in the same commit', async t => {
  const dir = await directory(t);
  const harness = await openHarness(dir);
  t.after(() => harness.close(context));
  const store = durableResourceStore(harness);
  const initial = initialResource(RESOURCE_ID);
  await store.commit(RESOURCE_ID, {
    resource: {value: initial, expectedRevision: undefined},
    receipt: {requestId: 'req-1', receipt: {fingerprint: 'fp-1', result: initial}},
  });
  const leased = acquireState(initial, {owner: OWNER, ttlMs: 1000}, START);
  await assert.rejects(store.commit(RESOURCE_ID, {
    resource: {value: leased, expectedRevision: 0},
    operation: {value: operation(), expectedRevision: undefined},
    receipt: {requestId: 'req-1', receipt: {fingerprint: 'fp-2', result: leased}},
  }), hasCode('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(await store.load(RESOURCE_ID), initial, 'the resource write was rolled back');
  assert.equal(await store.loadOperation('op-1'), undefined, 'the operation write was rolled back');
  assert.deepEqual(await store.loadReceipt(RESOURCE_ID, 'req-1'),
    {fingerprint: 'fp-1', result: initial}, 'the first receipt is kept');
});

test('an operation request index collision aborts the whole commit', async t => {
  const dir = await directory(t);
  const harness = await openHarness(dir);
  t.after(() => harness.close(context));
  const store = durableResourceStore(harness);
  const resource = acquireState(initialResource(RESOURCE_ID), {owner: OWNER, ttlMs: 1000}, START);
  const first = operation({id: 'op-1', requestId: 'req-1'});
  await store.commit(RESOURCE_ID, {
    resource: {value: resource, expectedRevision: undefined},
    operation: {value: first, expectedRevision: undefined},
    receipt: {requestId: 'req-1', receipt: {fingerprint: 'fp-1', result: resource}},
  });
  // Same (resourceId, requestId) may not be rebound to another operation.
  await assert.rejects(store.commit(RESOURCE_ID, {
    operation: {value: operation({id: 'op-2', requestId: 'req-1'}), expectedRevision: undefined},
    receipt: {requestId: 'req-1', receipt: {fingerprint: 'fp-2', result: resource}},
  }), hasCode('RESOURCE_CONFLICT'));
  assert.equal(await store.loadOperation('op-2'), undefined, 'the second operation was not written');
  assert.deepEqual(await store.findOperation(RESOURCE_ID, 'req-1'), first, 'the index still points at the first operation');
  assert.deepEqual(await store.loadReceipt(RESOURCE_ID, 'req-1'), {fingerprint: 'fp-1', result: resource});
});

test('a guard write with the same revision is allowed and does not bump the revision', async t => {
  const dir = await directory(t);
  const harness = await openHarness(dir);
  t.after(() => harness.close(context));
  const store = durableResourceStore(harness);
  const initial = initialResource(RESOURCE_ID);
  await store.commit(RESOURCE_ID, {resource: {value: initial, expectedRevision: undefined}});
  await store.commit(RESOURCE_ID, {
    resource: {value: initial, expectedRevision: 0},
    receipt: {requestId: 'req-guard', receipt: {fingerprint: 'fp', result: initial}},
  });
  const loaded = await store.load(RESOURCE_ID);
  assert.equal(loaded?.revision, 0, 'a no-op guard never increments revision');
  assert.equal((await store.loadReceipt(RESOURCE_ID, 'req-guard'))?.fingerprint, 'fp');
});

test('commit validates with transaction reads only: no snapshot inside the commit', async t => {
  const dir = await directory(t);
  const harness = await openHarness(dir);
  t.after(() => harness.close(context));
  let snapshots = 0;
  const facade = {
    snapshot: (...args: Parameters<Harness['snapshot']>) => {
      snapshots += 1;
      return (harness.snapshot as (...rest: Parameters<Harness['snapshot']>) => ReturnType<Harness['snapshot']>)(...args);
    },
    commit: harness.commit.bind(harness),
  } as unknown as Pick<Harness, 'snapshot' | 'commit'>;
  const store = durableResourceStore(facade);
  const resource = acquireState(initialResource(RESOURCE_ID), {owner: OWNER, ttlMs: 1000}, START);
  await store.commit(RESOURCE_ID, {
    resource: {value: resource, expectedRevision: undefined},
    operation: {value: operation(), expectedRevision: undefined},
    receipt: {requestId: 'req-1', receipt: {fingerprint: 'fp', result: resource}},
  });
  assert.equal(snapshots, 0, 'the store commit must not call snapshot()');
});

test('load and loadOperation return detached copies of the durable state', async t => {
  const dir = await directory(t);
  const harness = await openHarness(dir);
  t.after(() => harness.close(context));
  const store = durableResourceStore(harness);
  const resource = acquireState(initialResource(RESOURCE_ID), {owner: OWNER, ttlMs: 1000}, START);
  await store.commit(RESOURCE_ID, {
    resource: {value: resource, expectedRevision: undefined},
    operation: {value: operation(), expectedRevision: undefined},
    receipt: {requestId: 'req-1', receipt: {fingerprint: 'fp', result: resource}},
  });
  const loaded = await store.load(RESOURCE_ID);
  assert.ok(loaded);
  (loaded as {owner: string | null}).owner = 'caller-mutation';
  (loaded as {lease: unknown}).lease = null;
  assert.deepEqual(await store.load(RESOURCE_ID), resource, 'caller mutation never reaches the store');
  const loadedOperation = await store.loadOperation('op-1');
  assert.ok(loadedOperation);
  (loadedOperation as {state: string}).state = 'done';
  (loadedOperation as {observation?: string}).observation = 'caller-mutation';
  assert.equal((await store.loadOperation('op-1'))?.state, 'intent');
  // Nested JSON results are cloned too, not shared with the session document cache.
  const nested = {fingerprint: 'fp-nested', result: {ok: true, detail: {path: '/tmp/a'}}};
  await store.commit(RESOURCE_ID, {
    receipt: {requestId: 'req-nested', receipt: nested},
  });
  const receipt = await store.loadReceipt(RESOURCE_ID, 'req-nested');
  assert.ok(receipt);
  (receipt.result as {detail: {path: string}}).detail.path = 'caller-mutation';
  assert.equal(((await store.loadReceipt(RESOURCE_ID, 'req-nested'))?.result as {detail: {path: string}}).detail.path,
    '/tmp/a');
});

/* -------------------------------------------------------------------------- */
/* openRuntime: real SQLite persistence and reopen behavior                     */
/* -------------------------------------------------------------------------- */

test('openRuntime resources persist across close/reopen with receipts and no double owner', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const input = command();
  let runtime = await openRuntime(dir);
  let first: Resource;
  try {
    first = await runtime.resources.acquire(input);
    assert.deepEqual([first.state, first.owner, first.controlEpoch, first.revision], ['leased', OWNER, 1, 1]);
    assert.deepEqual(await runtime.resources.acquire({...input}), first, 'the receipt is durable');
    await assert.rejects(runtime.resources.acquire({...input, owner: OTHER_OWNER}), hasCode('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(runtime.resources.acquire({...input, requestId: 'req-2', owner: OTHER_OWNER}), hasCode('RESOURCE_BUSY'));
    const sameOwner = await runtime.resources.acquire({...input, requestId: 'req-3', ttlMs: 300_000});
    assert.equal(sameOwner.revision, first.revision, 'same-owner no-op keeps the revision');
  } finally {
    await runtime.close();
  }

  runtime = await openRuntime(dir);
  try {
    const restored = await runtime.resources.read(RESOURCE_ID);
    assert.deepEqual(restored, first, 'lease/owner/epoch/revision survive reopen');
    assert.deepEqual(await runtime.resources.acquire(input), first, 'the first receipt replays after reopen');
    await assert.rejects(runtime.resources.acquire({...input, owner: OTHER_OWNER}), hasCode('IDEMPOTENCY_CONFLICT'));
    const concurrent = await Promise.allSettled([
      runtime.resources.acquire({...input, requestId: 'race-a', owner: OWNER, ttlMs: 300_000}),
      runtime.resources.acquire({...input, requestId: 'race-b', owner: OTHER_OWNER, ttlMs: 300_000}),
    ]);
    const fulfilled = concurrent.filter((result): result is PromiseFulfilledResult<Resource> => result.status === 'fulfilled');
    const rejected = concurrent.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'the same-owner race is a no-op success');
    assert.equal(rejected.length, 1, 'the other owner is busy and never wins the lease');
    assert.equal((rejected[0]!.reason as ResourceError).code, 'RESOURCE_BUSY');
    assert.equal((await runtime.resources.read(RESOURCE_ID))?.owner, OWNER);
    // Only the owner may release; the epoch fence survives reopen.
    await assert.rejects(runtime.resources.release({resourceId: RESOURCE_ID, requestId: 'r1', owner: OWNER, epoch: 0}),
      hasCode('STALE_CONTROL'));
    const released = await runtime.resources.release({resourceId: RESOURCE_ID, requestId: 'r2', owner: OWNER, epoch: 1});
    assert.deepEqual([released.state, released.owner, released.revision], ['idle', null, first.revision + 1]);
    const taken = await runtime.resources.takeover({resourceId: RESOURCE_ID, requestId: 'take', owner: OTHER_OWNER, ttlMs: 300_000});
    assert.deepEqual([taken.owner, taken.controlEpoch], [OTHER_OWNER, 2]);
    await assert.rejects(runtime.resources.renew({resourceId: RESOURCE_ID, requestId: 'stale-renew', owner: OWNER, epoch: 1, ttlMs: 100}),
      hasCode('STALE_CONTROL'));
  } finally {
    await runtime.close();
  }

  runtime = await openRuntime(dir);
  try {
    const final = await runtime.resources.read(RESOURCE_ID);
    assert.deepEqual([final?.owner, final?.controlEpoch, final?.state], [OTHER_OWNER, 2, 'leased']);
  } finally {
    await runtime.close();
  }
});

test('an operation whose effect is unknown is persisted and never replayed after reopen', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const effect = registryFor(async () => { throw new Error('socket hang up'); });
  const deadline = Date.now() + 60_000;
  let operationId: string;
  let payloadHash: string;
  let runtime = await openRuntime(dir, undefined, {resources: {effects: effect.registry}});
  try {
    const resource = await runtime.resources.acquire(command());
    const op = await runtime.resources.beginOperation(secureOperationInput(resource.controlEpoch, deadline));
    operationId = op.id;
    assert.ok(op.effect, 'the intent persists the registered effect binding');
    payloadHash = op.effect.payloadHash;
    assert.deepEqual([op.owner, op.effect.kind], [OWNER, EFFECT_KIND]);
    assert.equal(effect.calls.length, 0, 'beginOperation never invokes the effect');
    const unknown = await runtime.resources.runOperation(op.id, effect.registry);
    assert.equal(unknown.state, 'unknown');
    assert.equal(effect.calls.length, 1, 'the effect was attempted once before it became unknown');
  } finally {
    await runtime.close();
  }

  runtime = await openRuntime(dir, undefined, {resources: {effects: effect.registry}});
  try {
    const recovered = await runtime.resources.runOperation(operationId, effect.registry);
    assert.equal(recovered.state, 'unknown', 'the durable unknown state survives reopen');
    assert.equal(effect.calls.length, 1, 'unknown is never replayed automatically');
    assert.equal((await runtime.resources.runOperation(operationId, effect.registry)).state, 'unknown');
    const reconciled = await runtime.resources.observeOperation({
      operationId, status: 'done', result: {ok: true}, evidence: TEST_EVIDENCE,
      observer: OWNER, payloadHash, controlEpoch: 1,
    });
    assert.deepEqual([reconciled.state, reconciled.result], ['done', {ok: true}]);
    assert.deepEqual(reconciled.evidence, TEST_EVIDENCE);
    assert.equal(reconciled.observer, OWNER);
  } finally {
    await runtime.close();
  }

  runtime = await openRuntime(dir, undefined, {resources: {effects: effect.registry}});
  try {
    assert.equal((await runtime.resources.runOperation(operationId, effect.registry)).state, 'done');
    assert.equal(effect.calls.length, 1, 'a reconciled terminal operation is never dispatched');
    // The secure beginOperation request index is durable and still idempotent (same payload/deadline).
    const original = await runtime.resources.beginOperation(secureOperationInput(1, deadline));
    assert.deepEqual([original.id, original.state], ['op-1', 'done']);
    await assert.rejects(runtime.resources.beginOperation(secureOperationInput(1, deadline, {operationId: 'op-2'})),
      hasCode('IDEMPOTENCY_CONFLICT'));
  } finally {
    await runtime.close();
  }
});

test('an intent operation survives reopen and is only dispatched when explicitly run', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const effect = registryFor(async () => ({ok: true}));
  const deadline = Date.now() + 60_000;
  let operationId: string;
  let runtime = await openRuntime(dir, undefined, {resources: {effects: effect.registry}});
  try {
    const resource = await runtime.resources.acquire(command());
    const op = await runtime.resources.beginOperation(secureOperationInput(resource.controlEpoch, deadline));
    operationId = op.id;
    assert.equal(op.state, 'intent');
    assert.equal(effect.calls.length, 0, 'creating an intent never invokes the effect');
  } finally {
    await runtime.close();
  }
  runtime = await openRuntime(dir, undefined, {resources: {effects: effect.registry}});
  try {
    const done = await runtime.resources.runOperation(operationId, effect.registry);
    assert.deepEqual([done.state, done.result], ['done', {ok: true}]);
    assert.equal(effect.calls.length, 1, 'an intent is dispatched exactly once on explicit run');
    const again = await runtime.resources.runOperation(operationId, effect.registry);
    assert.equal(again.state, 'done');
    assert.equal(effect.calls.length, 1, 'the terminal operation is never re-dispatched');
  } finally {
    await runtime.close();
  }
});

test('resource reads return detached copies and unknown ids are undefined', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const runtime = await openRuntime(dir);
  try {
    const leased = await runtime.resources.acquire(command());
    const copy = await runtime.resources.read(RESOURCE_ID);
    assert.ok(copy);
    (copy as {owner: string}).owner = 'caller-mutation';
    assert.equal((await runtime.resources.read(RESOURCE_ID))?.owner, leased.owner);
    assert.equal(await runtime.resources.read('missing:resource'), undefined);
    assert.equal(await runtime.resources.read('bad id'), undefined);
  } finally {
    await runtime.close();
  }
});

/** A v2 family definition used only to plant an unsupported future document. */
const FutureResources = defineDocFamily({
  kind: 'point.resource', version: 2, scope: 'session', family: true,
  initial: (document: {present: boolean; value: {id: string} | null}) => ({...document}),
});

async function writeFutureResourceDocument(dir: string) {
  const harness = await openHarness(dir);
  try {
    await harness.commit(async tx => {
      await tx.doc(FutureResources, RESOURCE_ID, {present: true, value: {id: RESOURCE_ID}});
    }, context);
  } finally {
    await harness.close(context);
  }
}

test('a newer stored resource document version is rejected instead of silently read', {timeout: 40000}, async t => {
  // A populated directory without app metadata is refused, even when the only document is a future family.
  const fresh = await directory(t);
  await writeFutureResourceDocument(fresh);
  await assert.rejects(openRuntime(fresh), /UNRECOGNIZED_DATA/);

  // With metadata present, openRuntime opens and typed access to the future document is rejected.
  const dir = await directory(t);
  const first = await openRuntime(dir);
  await first.close();
  await writeFutureResourceDocument(dir);
  const reopened = await openRuntime(dir);
  try {
    await assert.rejects(reopened.resources.read(RESOURCE_ID), /has newer version 2 than 1/);
  } finally {
    await reopened.close();
  }
});

/* -------------------------------------------------------------------------- */
/* SIGKILL windows: attempting is recovered explicitly, intent is never auto-run */
/* -------------------------------------------------------------------------- */

type CrashIdentity = {
  resourceId: string;
  operationId: string;
  controlEpoch: number;
  deadline: number;
  payloadHash: string;
};
type ChildMessage = {
  event?: string;
  operationId?: string;
  resourceId?: string;
  controlEpoch?: number;
  deadline?: number;
  payloadHash?: string;
  message?: string;
};

async function crashIdentity(dir: string, mode: 'attempting' | 'intent') {
  const child = fork(new URL('./fixtures/resource-crash.js', import.meta.url), [dir, mode], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const exited = once(child, 'exit');
  try {
    const identity = await new Promise<CrashIdentity>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`resource crash fixture timed out: ${stderr}`)), 25000);
      let started: CrashIdentity | undefined;
      child.on('message', (message: unknown) => {
        const event = message as ChildMessage;
        if (event.event === 'error') {
          clearTimeout(timer);
          reject(new Error(String(event.message)));
        }
        if (event.event === 'started' && event.resourceId && event.operationId
          && event.controlEpoch !== undefined && event.deadline !== undefined && event.payloadHash) {
          started = {
            resourceId: event.resourceId, operationId: event.operationId, controlEpoch: event.controlEpoch,
            deadline: event.deadline, payloadHash: event.payloadHash,
          };
          if (mode === 'intent') {
            clearTimeout(timer);
            resolve(started);
          }
        }
        if (event.event === 'effect-invoked' && started) {
          clearTimeout(timer);
          resolve(started);
        }
      });
      child.once('exit', () => reject(new Error(`resource fixture exited early: ${stderr}`)));
    });
    child.kill('SIGKILL');
    await exited;
    return identity;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited.catch(() => undefined);
  }
}

test('SIGKILL after the effect started: restart recovers unknown and never replays', {timeout: 60000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-resource-crash-'));
  try {
    const identity = await crashIdentity(dir, 'attempting');
    // The durable document is `attempting` with a live token and a deadline (intent was committed first).
    const inspector = await openHarness(dir);
    try {
      const stored = await inspector.snapshot(ResourceOperations, identity.operationId, context);
      assert.equal(stored?.present, true);
      assert.equal(stored?.value?.state, 'attempting', 'the effect was recorded before it ran');
      assert.equal(typeof stored?.value?.attemptToken, 'string', 'a live attempt token is durable');
      assert.equal(stored?.value?.deadline, identity.deadline);
      assert.equal(stored?.value?.effect?.payloadHash, identity.payloadHash);
    } finally {
      await inspector.close(context);
    }

    // Only an expired deadline allows explicit recovery (never heuristic concurrent unknown).
    await delay(Math.max(0, identity.deadline - Date.now()) + 50);
    const effect = registryFor(async () => ({ok: true}));
    let runtime = await openRuntime(dir, undefined, {resources: {effects: effect.registry}});
    try {
      const recovered = await runtime.resources.recoverOperation({
        operationId: identity.operationId, observer: OWNER, reason: 'worker-killed',
      });
      assert.equal(recovered.state, 'unknown');
      assert.match(recovered.observation ?? '', /^recovered:/);
      assert.equal((await runtime.resources.runOperation(identity.operationId, effect.registry)).state, 'unknown');
      assert.equal(effect.calls.length, 0, 'the unknown effect is never replayed');
    } finally {
      await runtime.close();
    }
    // The unknown state is durable, not a per-process opinion.
    const after = await openHarness(dir);
    try {
      assert.equal((await after.snapshot(ResourceOperations, identity.operationId, context))?.value?.state, 'unknown');
    } finally {
      await after.close(context);
    }

    // Evidence-bound reconciliation settles it; a terminal operation is never dispatched again.
    runtime = await openRuntime(dir, undefined, {resources: {effects: effect.registry}});
    try {
      const reconciled = await runtime.resources.observeOperation({
        operationId: identity.operationId, status: 'done', result: {ok: true}, evidence: TEST_EVIDENCE,
        observer: OWNER, payloadHash: identity.payloadHash, controlEpoch: identity.controlEpoch,
      });
      assert.equal(reconciled.state, 'done');
      assert.equal((await runtime.resources.runOperation(identity.operationId, effect.registry)).state, 'done');
      assert.equal(effect.calls.length, 0, 'a reconciled operation is never replayed');
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('SIGKILL before dispatch: intent survives, is never auto-run, and runs exactly once when asked', {timeout: 60000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-resource-crash-intent-'));
  try {
    const identity = await crashIdentity(dir, 'intent');
    const inspector = await openHarness(dir);
    try {
      const stored = await inspector.snapshot(ResourceOperations, identity.operationId, context);
      assert.equal(stored?.value?.state, 'intent', 'the intent is durable before any effect');
      assert.equal(stored?.value?.effect?.payloadHash, identity.payloadHash);
      assert.equal(stored?.value?.attemptToken, null, 'an intent has no attempt token yet');
    } finally {
      await inspector.close(context);
    }

    const effect = registryFor(async () => ({ok: true}));
    const runtime = await openRuntime(dir, undefined, {resources: {effects: effect.registry}});
    try {
      const receipt = await runtime.resources.runOperation(identity.operationId, effect.registry);
      assert.deepEqual([receipt.state, receipt.result], ['done', {ok: true}]);
      assert.equal(effect.calls.length, 1, 'an intent is dispatched exactly once when explicitly run');
      await runtime.resources.runOperation(identity.operationId, effect.registry);
      assert.equal(effect.calls.length, 1, 'the terminal operation is not replayed');
    } finally {
      await runtime.close();
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
