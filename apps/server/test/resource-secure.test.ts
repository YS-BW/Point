/**
 * P0 secure resource effect protocol (WP2 real adapters, task 1.1-1.3).
 *
 * Covers: registered kind + bounded canonical payload/hash binding, live
 * owner/lease/epoch dispatch fence, attempt token + explicit recovery, deadline /
 * abort settlement, evidence/observer/payload-bound reconciliation, durable
 * reopen, version-1 operation rejection and fail-closed composition.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { JsonValue as ChordJsonValue } from '@earendil-works/chord';
import {
  MemoryStorage, createRegistry, defineDocFamily, Harness,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
  ResourceError,
  attemptWithToken,
  initialResource,
  markAttemptUnknown,
  reconcileWithEvidence,
  settleAttempt,
  type JsonObject,
  type JsonValue,
  type ResourceOperation,
  type SecureResourceOperation,
} from '../src/domain/resource.js';
import {
  EffectFailure, canonicalJson, createEffectRegistry, resourceCommands,
  type EffectDefinition, type ResourceCommands, type ResourceEffectPort, type RegisteredEffect,
} from '../src/application/resource.js';
import { durableResourceStore, durableResourceStore as importStore } from '../src/runtime/resources.js';
import { ResourceOperations, Resources } from '../src/storage/resource.js';
import { openRuntime, type Runtime } from '../src/runtime/open.js';

const START = 1_000_000;
const RESOURCE_ID = 'test:resource';
const OWNER = 'owner-a';
const KIND = 'test.echo';

function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ResourceError, `expected ResourceError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

function timing(start = START) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) { current += ms; },
    set(value: number) { current = value; },
  };
}

type EffectScript = (operation: SecureResourceOperation, invocation: {signal: AbortSignal; deadline: number}) => Promise<unknown>;

function definition(kind = KIND, limits: Readonly<{payload?: number; result?: number; evidence?: number}> = {}): EffectDefinition {
  return {
    kind,
    maxPayloadBytes: limits.payload ?? 1024,
    maxResultBytes: limits.result ?? 1024,
    maxEvidenceBytes: limits.evidence ?? 512,
    validatePayload(payload: JsonObject): void {
      if (typeof payload.text !== 'string') throw new ResourceError('INVALID_COMMAND');
      if (Object.hasOwn(payload, 'secret')) throw new ResourceError('INVALID_COMMAND');
    },
    validateResult(result: JsonValue, evidence?: JsonObject, payload?: JsonObject): void {
      if (typeof result !== 'object' || result === null || Array.isArray(result)) {
        throw new ResourceError('RESULT_REJECTED');
      }
      const record = result as JsonObject;
      if (record.ok === false) throw new ResourceError('RESULT_REJECTED');
      const expected = typeof payload?.sha256 === 'string' ? payload.sha256 : undefined;
      if (expected !== undefined) {
        // A forged result must match both the persisted payload and the evidence.
        if (record.sha256 !== expected) throw new ResourceError('RESULT_REJECTED');
        if (evidence !== undefined && evidence.sha256 !== expected) throw new ResourceError('RESULT_REJECTED');
      }
    },
    validateEvidence(evidence: JsonObject, payload?: JsonObject): void {
      if (evidence.kind !== KIND || typeof evidence.sha256 !== 'string') {
        throw new ResourceError('INVALID_EVIDENCE');
      }
      const expected = typeof payload?.sha256 === 'string' ? payload.sha256 : undefined;
      if (expected !== undefined && evidence.sha256 !== expected) {
        throw new ResourceError('INVALID_EVIDENCE');
      }
      const expectedPath = typeof payload?.path === 'string' ? payload.path : undefined;
      if (expectedPath !== undefined && evidence.path !== expectedPath) {
        throw new ResourceError('INVALID_EVIDENCE');
      }
    },
  };
}

type Calls = {operation: SecureResourceOperation; invocation?: {signal: AbortSignal; deadline: number}}[];

function effectWith(script: EffectScript, limits?: Readonly<{payload?: number; result?: number; evidence?: number}>): RegisteredEffect & {calls: Calls} {
  const calls: Calls = [];
  const effect: ResourceEffectPort = {
    async invoke(operation, invocation) {
      calls.push({operation: operation as SecureResourceOperation, ...(invocation === undefined ? {} : {invocation})});
      return script(operation as SecureResourceOperation, invocation as {signal: AbortSignal; deadline: number});
    },
  };
  return {definition: definition(KIND, limits), effect, calls};
}

function registryOf(entry: RegisteredEffect) {
  return createEffectRegistry([entry]);
}

function operationInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    operationId: 'op-1',
    requestId: 'op-req-1',
    resourceId: RESOURCE_ID,
    controlEpoch: 1,
    effect: {kind: KIND, payload: {text: 'hello'}},
    ...overrides,
  };
}

async function until(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let index = 0; index < 500; index += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function durableFixture(t: TestContext, script: EffectScript = async () => ({ok: true}), options: Readonly<{deadlineMs?: number; limits?: {payload?: number; result?: number; evidence?: number}}> = {}) {
  const harness = await Harness.open(new MemoryStorage(), {models: createModels(), registry: createRegistry()}, context);
  t.after(() => harness.close(context));
  const time = timing();
  const entry = effectWith(script, options.limits);
  let sequence = 0;
  const commands = resourceCommands(durableResourceStore(harness), time.now, undefined, {
    secure: true,
    effects: registryOf(entry),
    hash: canonical => canonical,
    token: () => `token-${++sequence}`,
    deadlineMs: options.deadlineMs ?? 100_000,
  });
  const resource = await commands.acquire({resourceId: RESOURCE_ID, requestId: 'acquire-1', owner: OWNER, ttlMs: 600_000});
  return {harness, commands, time, entry, resource};
}

/* -------------------------------------------------------------------------- */
/* Domain secure transitions                                                   */
/* -------------------------------------------------------------------------- */

test('secure domain transitions enforce attempt token, payload and evidence binding', () => {
  const base: SecureResourceOperation = {
    id: 'op-1', requestId: 'req-1', resourceId: RESOURCE_ID, controlEpoch: 1,
    state: 'intent', revision: 0, fingerprint: 'fp', owner: OWNER,
    effect: {kind: KIND, payload: {text: 'x'}, payloadHash: 'hash-x'},
    attemptToken: null, attemptStartedAt: null, deadline: 1000,
  };
  const attempting = attemptWithToken(base, {token: 'token-1', startedAt: 10, deadline: 1000}) as SecureResourceOperation;
  assert.equal(attempting.state, 'attempting');
  assert.equal(attempting.attemptToken, 'token-1');
  assert.equal(attempting.revision, 1);
  assert.throws(() => settleAttempt(attempting, {state: 'done', token: 'other'}), hasCode('STALE_ATTEMPT'));
  const done = settleAttempt(attempting, {state: 'done', token: 'token-1', result: {ok: true}});
  assert.equal(done.state, 'done');
  assert.equal(settleAttempt(done, {state: 'done', token: 'token-1'}), done, 'terminal settlement is idempotent');
  assert.throws(() => markAttemptUnknown(attempting, {token: 'other'}), hasCode('STALE_ATTEMPT'));
  const unknown = markAttemptUnknown(attempting, {token: 'token-1', observation: 'timeout'});
  assert.equal(unknown.state, 'unknown');
  assert.throws(() => reconcileWithEvidence(unknown, {
    state: 'done', evidence: {kind: KIND, sha256: 'a'}, observer: OWNER, payloadHash: 'other-hash',
  }), hasCode('INVALID_EVIDENCE'), 'reconcile must reference the persisted payload hash');
  const reconciled = reconcileWithEvidence(unknown, {
    state: 'done', evidence: {kind: KIND, sha256: 'a'}, observer: OWNER, payloadHash: 'hash-x',
  });
  assert.equal(reconciled.state, 'done');
  assert.equal(reconciled.observer, OWNER);
  assert.deepEqual(reconciled.evidence, {kind: KIND, sha256: 'a'});
});

/* -------------------------------------------------------------------------- */
/* beginOperation: effect binding, canonical payload/hash, idempotency         */
/* -------------------------------------------------------------------------- */

test('beginOperation persists kind/payload/hash/owner/deadline and rejects unregistered or bad payloads', async t => {
  const f = await durableFixture(t);
  const created = await f.commands.beginOperation(operationInput()) as SecureResourceOperation;
  assert.equal(created.state, 'intent');
  assert.equal(created.owner, OWNER);
  assert.equal(created.controlEpoch, 1);
  assert.equal(created.effect?.kind, KIND);
  assert.deepEqual(created.effect?.payload, {text: 'hello'});
  assert.equal(created.effect?.payloadHash, canonicalJson({text: 'hello'}));
  assert.equal(created.attemptToken, null);
  assert.equal(created.attemptStartedAt, null);
  assert.equal(created.deadline, START + 100_000);
  assert.match(created.fingerprint, /payloadHash/);

  // Same request key: replay returns the original; different payload/kind/deadline conflicts.
  assert.deepEqual(await f.commands.beginOperation(operationInput()), created);
  await assert.rejects(f.commands.beginOperation(operationInput({effect: {kind: KIND, payload: {text: 'changed'}}})),
    hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.commands.beginOperation(operationInput({effect: {kind: 'test.other', payload: {text: 'hello'}}})),
    hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.commands.beginOperation(operationInput({operationId: 'op-2'})), hasCode('IDEMPOTENCY_CONFLICT'));

  // New request id: unknown kind / invalid payload / oversized payload write nothing.
  for (const [requestId, input, code] of [
    ['op-req-2', operationInput({operationId: 'op-2', requestId: 'op-req-2', effect: {kind: 'test.unknown', payload: {text: 'x'}}}), 'EFFECT_NOT_REGISTERED'],
    ['op-req-3', operationInput({operationId: 'op-3', requestId: 'op-req-3', effect: {kind: KIND, payload: {text: 7}}}), 'INVALID_COMMAND'],
    ['op-req-4', operationInput({operationId: 'op-4', requestId: 'op-req-4', effect: {kind: KIND, payload: {text: 'x'.repeat(2000)}}}), 'PAYLOAD_REJECTED'],
    ['op-req-5', operationInput({operationId: 'op-5', requestId: 'op-req-5', effect: {kind: KIND, payload: {text: 'x', secret: 'do-not-persist'}}}), 'INVALID_COMMAND'],
    ['op-req-6', operationInput({operationId: 'op-6', requestId: 'op-req-6', effect: {kind: KIND, payload: ['not-an-object']}}), 'INVALID_COMMAND'],
  ] as const) {
    await assert.rejects(f.commands.beginOperation(input), hasCode(code), `${requestId}`);
    const found = await importStore(f.harness).findOperation(RESOURCE_ID, requestId);
    assert.equal(found, undefined, `${requestId} must not write an intent`);
  }
  // Missing effect field is a contract violation, not an unbound intent.
  await assert.rejects(f.commands.beginOperation({
    operationId: 'op-7', requestId: 'op-req-7', resourceId: RESOURCE_ID, controlEpoch: 1,
  }), hasCode('INVALID_COMMAND'));
});

test('an omitted deadline is stable for idempotent replay even as the clock advances', async t => {
  const f = await durableFixture(t);
  const first = await f.commands.beginOperation(operationInput());
  f.time.advance(5);
  const replay = await f.commands.beginOperation(operationInput());
  assert.deepEqual(replay, first, 'omitted deadline replay returns the first operation');
  assert.equal(replay.deadline, first.deadline, 'the first resolved deadline is returned, not recomputed');
  // Explicit deadline vs omitted is a different command; the same explicit deadline replays.
  await assert.rejects(f.commands.beginOperation(operationInput({deadline: START + 999_999})), hasCode('IDEMPOTENCY_CONFLICT'));
  const explicit = await f.commands.beginOperation(operationInput({operationId: 'op-dl', requestId: 'op-req-dl', deadline: START + 5_000}));
  assert.equal(explicit.deadline, START + 5_000);
  f.time.advance(10);
  assert.deepEqual(await f.commands.beginOperation(operationInput({operationId: 'op-dl', requestId: 'op-req-dl', deadline: START + 5_000})), explicit);
});

test('payload hash is canonical and stable across key order, and bound to the exact operation', async t => {
  const f = await durableFixture(t);
  const first = await f.commands.beginOperation(operationInput({effect: {kind: KIND, payload: {text: 'abc', n: 1}}}));
  const reordered = await f.commands.beginOperation(operationInput({
    operationId: 'op-2', requestId: 'op-req-2', effect: {kind: KIND, payload: {n: 1, text: 'abc'}},
  }));
  assert.equal(first.effect?.payloadHash, reordered.effect?.payloadHash, 'canonical JSON ignores key order');
  const different = await f.commands.beginOperation(operationInput({
    operationId: 'op-3', requestId: 'op-req-3', effect: {kind: KIND, payload: {text: 'abc', n: 2}},
  }));
  assert.notEqual(first.effect?.payloadHash, different.effect?.payloadHash);
});

/* -------------------------------------------------------------------------- */
/* R1: runOperation is bound to the runtime-owned registry                      */
/* -------------------------------------------------------------------------- */

test('a caller-supplied same-kind registry cannot substitute the runtime-bound effect', async t => {
  const f = await durableFixture(t);
  const op = await f.commands.beginOperation(operationInput());
  // Same kind and definition, different implementation: must never run.
  const substitute = effectWith(async () => ({ok: true}));
  await assert.rejects(f.commands.runOperation(op.id, registryOf(substitute)), hasCode('INVALID_COMMAND'));
  assert.equal(substitute.calls.length, 0, 'the substitute effect is never invoked');
  assert.equal(f.entry.calls.length, 0, 'the bound effect is not invoked either');
  assert.equal((await importStore(f.harness).loadOperation(op.id))?.state, 'intent', 'zero side effects');
  // The runtime-bound effect is dispatched when the caller omits the registry.
  const done = await f.commands.runOperation(op.id);
  assert.equal(done.state, 'done');
  assert.equal(f.entry.calls.length, 1);
  assert.equal(substitute.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Dispatch fence: owner + live lease + epoch                                  */
/* -------------------------------------------------------------------------- */

test('dispatch is fenced by a live lease, owner and control epoch without invoking the effect', async t => {
  const f = await durableFixture(t, async () => ({ok: true}), {deadlineMs: 10_000_000});
  const base = {operationId: 'op-fence', requestId: 'op-fence', resourceId: RESOURCE_ID, controlEpoch: 1, effect: {kind: KIND, payload: {text: 'x'}}};
  
  // Expired lease.
  await f.commands.beginOperation(base);
  f.time.advance(600_001);
  await assert.rejects(f.commands.runOperation('op-fence'), hasCode('LEASE_EXPIRED'));
  assert.equal(f.entry.calls.length, 0, 'expired lease never dispatches');
  const failed = await importStore(f.harness).loadOperation('op-fence');
  assert.equal(failed?.state, 'failed');
  assert.equal(failed?.result, 'LEASE_EXPIRED');

  // Released lease, same epoch: admission may bind the live lease, but dispatch has no owner.
  const leased = await f.commands.acquire({resourceId: RESOURCE_ID, requestId: 'acquire-2', owner: 'owner-b', ttlMs: 600_000});
  const opId = 'op-released';
  await f.commands.beginOperation({
    operationId: opId, requestId: 'op-released', resourceId: RESOURCE_ID, controlEpoch: leased.controlEpoch,
    effect: {kind: KIND, payload: {text: 'x'}},
  });
  await f.commands.release({resourceId: RESOURCE_ID, requestId: 'release-1', owner: 'owner-b', epoch: leased.controlEpoch});
  await assert.rejects(f.commands.runOperation(opId), hasCode('LEASE_EXPIRED'));
  assert.equal(f.entry.calls.length, 0);

  // Takeover bumps the epoch: an operation bound to the old owner is stale.
  const current = await f.commands.acquire({resourceId: RESOURCE_ID, requestId: 'acquire-3', owner: 'owner-b', ttlMs: 600_000});
  const taken = await f.commands.takeover({resourceId: RESOURCE_ID, requestId: 'take-1', owner: OWNER, ttlMs: 600_000});
  const staleOpId = 'op-stale';
  await f.commands.beginOperation({
    operationId: staleOpId, requestId: 'op-stale', resourceId: RESOURCE_ID, controlEpoch: taken.controlEpoch,
    effect: {kind: KIND, payload: {text: 'x'}},
  });
  await f.commands.takeover({resourceId: RESOURCE_ID, requestId: 'take-2', owner: 'owner-b', ttlMs: 600_000});
  await assert.rejects(f.commands.runOperation(staleOpId), hasCode('STALE_CONTROL'));
  assert.equal(f.entry.calls.length, 0, 'stale epoch never dispatches');
  assert.ok(current.controlEpoch >= 3);
});

test('a same-epoch owner mismatch is rejected by the dispatch fence', async t => {
  const f = await durableFixture(t);
  const op = await f.commands.beginOperation(operationInput()) as SecureResourceOperation;
  // Forge a same-epoch lease owned by someone else directly through the store guard.
  const store = importStore(f.harness);
  const resource = await store.load(RESOURCE_ID);
  assert.ok(resource?.lease);
  await store.commit(RESOURCE_ID, {
    resource: {
      value: {...resource, owner: 'owner-z', lease: {owner: 'owner-z', expiresAt: resource.lease.expiresAt, epoch: resource.lease.epoch}},
      expectedRevision: resource.revision,
    },
  });
  await assert.rejects(f.commands.runOperation(op.id), hasCode('STALE_CONTROL'));
  assert.equal(f.entry.calls.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Dispatch, attempt token, concurrency, recovery                              */
/* -------------------------------------------------------------------------- */

test('a fenced dispatch invokes exactly once with signal/deadline and persists the secure settlement', async t => {
  const f = await durableFixture(t, async (operation, invocation) => {
    assert.equal(operation.attemptToken, 'token-1');
    assert.equal(invocation.deadline, START + 100_000);
    assert.equal(invocation.signal.aborted, false);
    return {ok: true, echoed: operation.effect?.payload.text};
  });
  const op = await f.commands.beginOperation(operationInput());
  const done = await f.commands.runOperation(op.id);
  assert.equal(done.state, 'done');
  assert.deepEqual(done.result, {ok: true, echoed: 'hello'});
  assert.equal(f.entry.calls.length, 1);
  assert.equal((done as SecureResourceOperation).attemptToken, 'token-1');
  assert.equal((done as SecureResourceOperation).attemptStartedAt, START);
  // Re-run never dispatches again.
  assert.deepEqual(await f.commands.runOperation(op.id), done);
  assert.equal(f.entry.calls.length, 1);
});

test('a live concurrent attempt returns IN_PROGRESS and never becomes a false unknown', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await durableFixture(t, async () => { await gate; return {ok: true}; });
  const op = await f.commands.beginOperation(operationInput());
  const first = f.commands.runOperation(op.id);
  await until(() => f.entry.calls.length === 1, 'effect invocation');
  await assert.rejects(f.commands.runOperation(op.id), hasCode('IN_PROGRESS'));
  const stored = await importStore(f.harness).loadOperation(op.id);
  assert.equal(stored?.state, 'attempting', 'a live attempt is left untouched');
  assert.equal(stored?.attemptToken, 'token-1');
  release();
  const done = await first;
  assert.equal(done.state, 'done');
  assert.equal(f.entry.calls.length, 1);
});

test('an expired attempt requires explicit recovery; the old worker cannot settle it', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await durableFixture(t, async () => { await gate; return {ok: true}; }, {deadlineMs: 500});
  const op = await f.commands.beginOperation(operationInput());
  const first = f.commands.runOperation(op.id);
  await until(() => f.entry.calls.length === 1, 'effect invocation');
  await assert.rejects(f.commands.runOperation(op.id), hasCode('IN_PROGRESS'));

  // Before the deadline there is no recovery proof.
  await assert.rejects(f.commands.recoverOperation({operationId: op.id, observer: OWNER, reason: 'kill -9'}),
    hasCode('RECOVERY_REQUIRED'));
  await assert.rejects(f.commands.recoverOperation({operationId: op.id, observer: 'owner-x', reason: 'kill -9'}),
    hasCode('STALE_CONTROL'), 'observer authentication precedes the deadline gate');
  f.time.advance(501);
  await assert.rejects(f.commands.recoverOperation({operationId: op.id, observer: 'owner-x', reason: 'kill -9'}),
    hasCode('STALE_CONTROL'));
  const recovered = await f.commands.recoverOperation({operationId: op.id, observer: OWNER, reason: 'kill -9'});
  assert.equal(recovered.state, 'unknown');
  assert.match(recovered.observation ?? '', /recovered:kill -9/);

  release();
  const late = await first;
  assert.equal(late.state, 'unknown', 'the old worker cannot overwrite a recovered attempt');
  assert.equal(f.entry.calls.length, 1, 'recovery never re-dispatches');
});

/* -------------------------------------------------------------------------- */
/* Outcome states, deadline/abort, result bounds                               */
/* -------------------------------------------------------------------------- */

test('known failure settles failed, generic throw settles unknown, and neither replays', async t => {
  const failing = await durableFixture(t, async () => { throw new EffectFailure('failed', 'E_REJECTED'); });
  const op = await failing.commands.beginOperation(operationInput());
  const failed = await failing.commands.runOperation(op.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.result, 'E_REJECTED');
  assert.equal(failing.entry.calls.length, 1);

  const crashing = await durableFixture(t, async () => { throw new Error('socket hang up'); });
  const op2 = await crashing.commands.beginOperation(operationInput());
  const unknown = await crashing.commands.runOperation(op2.id);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.observation, 'effect-unknown');
  assert.deepEqual(await crashing.commands.runOperation(op2.id), unknown);
  assert.equal(crashing.entry.calls.length, 1, 'unknown is never replayed');
});

test('deadline aborts the effect and settles unknown, never a late success', async t => {
  const observed: boolean[] = [];
  const f = await durableFixture(t, async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    return {ok: true};
  }, {deadlineMs: 20});
  const op = await f.commands.beginOperation(operationInput());
  const settled = await f.commands.runOperation(op.id);
  observed.push(f.entry.calls[0]?.invocation?.signal.aborted ?? false);
  assert.equal(settled.state, 'unknown');
  assert.equal(settled.observation, 'deadline-exceeded');
  assert.equal(settled.result, undefined, 'a late result is never persisted as done');
  assert.equal(settled.attemptToken, 'token-1');
});

test('results are bounded and schema-checked: invalid results settle unknown without a result', async t => {
  const tooBig = await durableFixture(t, async () => ({ok: true, blob: 'x'.repeat(500)}), {limits: {result: 64}});
  const op = await tooBig.commands.beginOperation(operationInput());
  const bounded = await tooBig.commands.runOperation(op.id);
  assert.equal(bounded.state, 'unknown');
  assert.equal(bounded.observation, 'result-rejected');
  assert.equal(bounded.result, undefined);

  const badSchema = await durableFixture(t, async () => ({ok: false}));
  const op2 = await badSchema.commands.beginOperation(operationInput());
  const rejected = await badSchema.commands.runOperation(op2.id);
  assert.equal(rejected.state, 'unknown');
  assert.equal(rejected.observation, 'result-rejected');
});

/* -------------------------------------------------------------------------- */
/* Evidence-bound reconciliation                                               */
/* -------------------------------------------------------------------------- */

test('unknown reconciliation requires observer, epoch, payload hash and valid bounded evidence', async t => {
  const f = await durableFixture(t, async () => { throw new Error('timeout'); });
  const op = await f.commands.beginOperation(operationInput()) as SecureResourceOperation;
  const unknown = await f.commands.runOperation(op.id);
  assert.equal(unknown.state, 'unknown');
  const expectedHash = op.effect.payloadHash;
  const evidence = {kind: KIND, sha256: 'a'.repeat(64)};

  await assert.rejects(f.commands.observeOperation({
    operationId: op.id, status: 'done', evidence, observer: 'owner-x', payloadHash: expectedHash, controlEpoch: op.controlEpoch,
  }), hasCode('STALE_CONTROL'), 'forged observer');
  await assert.rejects(f.commands.observeOperation({
    operationId: op.id, status: 'done', evidence, observer: OWNER, payloadHash: expectedHash, controlEpoch: 2,
  }), hasCode('STALE_CONTROL'), 'stale control epoch');
  await assert.rejects(f.commands.observeOperation({
    operationId: op.id, status: 'done', evidence, observer: OWNER, payloadHash: 'other-hash', controlEpoch: op.controlEpoch,
  }), hasCode('INVALID_EVIDENCE'), 'payload hash mismatch');
  await assert.rejects(f.commands.observeOperation({
    operationId: op.id, status: 'done', evidence: {kind: 'other', sha256: 'a'}, observer: OWNER, payloadHash: expectedHash, controlEpoch: op.controlEpoch,
  }), hasCode('INVALID_EVIDENCE'), 'capability evidence schema');
  await assert.rejects(f.commands.observeOperation({
    operationId: op.id, status: 'done', evidence: {kind: KIND, sha256: 'a', padding: 'x'.repeat(600)},
    observer: OWNER, payloadHash: expectedHash, controlEpoch: op.controlEpoch,
  }), hasCode('INVALID_EVIDENCE'), 'evidence size bound');
  assert.equal((await importStore(f.harness).loadOperation(op.id))?.state, 'unknown', 'failed reconciliation leaves unknown untouched');

  const reconciled = await f.commands.observeOperation({
    operationId: op.id, status: 'done', result: {ok: true}, evidence, observer: OWNER,
    payloadHash: expectedHash, controlEpoch: op.controlEpoch, observation: 'provider confirmed',
  });
  assert.equal(reconciled.state, 'done');
  assert.deepEqual(reconciled.result, {ok: true});
  assert.equal(reconciled.observer, OWNER);
  assert.deepEqual(reconciled.evidence, evidence);
  assert.equal(reconciled.observation, 'provider confirmed');
  // Terminal reconciliation is idempotent.
  assert.deepEqual(await f.commands.observeOperation({
    operationId: op.id, status: 'failed', evidence, observer: OWNER, payloadHash: expectedHash, controlEpoch: op.controlEpoch,
  }), reconciled);
});

/* -------------------------------------------------------------------------- */
/* R2: evidence and result must bind to the persisted payload                  */
/* -------------------------------------------------------------------------- */

test('schema-valid evidence and result are rejected unless they match the persisted payload', async t => {
  const digest = 'b'.repeat(64);
  const f = await durableFixture(t, async () => { throw new Error('timeout'); });
  const payload = {text: 'file-content', sha256: digest, path: '/data/target.txt'};
  const op = await f.commands.beginOperation(operationInput({effect: {kind: KIND, payload}})) as SecureResourceOperation;
  assert.equal(op.effect.payloadHash, canonicalJson(payload));
  assert.equal((await f.commands.runOperation(op.id)).state, 'unknown');
  const base = {operationId: op.id, observer: OWNER, payloadHash: op.effect.payloadHash, controlEpoch: op.controlEpoch};

  // Schema-valid evidence with a different hash/path binding is forged.
  await assert.rejects(f.commands.observeOperation({
    ...base, status: 'done', evidence: {kind: KIND, sha256: 'c'.repeat(64), path: '/data/target.txt'},
  }), hasCode('INVALID_EVIDENCE'), 'evidence hash must equal the payload hash');
  await assert.rejects(f.commands.observeOperation({
    ...base, status: 'done', evidence: {kind: KIND, sha256: digest, path: '/elsewhere/file'},
  }), hasCode('INVALID_EVIDENCE'), 'evidence path is capability-bound to the payload');
  assert.equal((await importStore(f.harness).loadOperation(op.id))?.state, 'unknown');

  // Correct evidence but a forged result is rejected and unknown stays unchanged.
  await assert.rejects(f.commands.observeOperation({
    ...base, status: 'done', evidence: {kind: KIND, sha256: digest, path: '/data/target.txt'},
    result: {ok: true, sha256: 'd'.repeat(64)},
  }), hasCode('RESULT_REJECTED'), 'result must agree with evidence and payload');
  assert.equal((await importStore(f.harness).loadOperation(op.id))?.state, 'unknown');

  // Matching evidence + matching result reconciles exactly once.
  const reconciled = await f.commands.observeOperation({
    ...base, status: 'done', evidence: {kind: KIND, sha256: digest, path: '/data/target.txt'},
    result: {ok: true, sha256: digest},
  });
  assert.equal(reconciled.state, 'done');
  assert.deepEqual(reconciled.result, {ok: true, sha256: digest});
});

test('a takeover fences the old owner out of reconciliation', async t => {
  const f = await durableFixture(t, async () => { throw new Error('timeout'); });
  const op = await f.commands.beginOperation(operationInput()) as SecureResourceOperation;
  await f.commands.runOperation(op.id);
  const taken = await f.commands.takeover({resourceId: RESOURCE_ID, requestId: 'take-1', owner: 'owner-b', ttlMs: 600_000});
  await assert.rejects(f.commands.observeOperation({
    operationId: op.id, status: 'done', evidence: {kind: KIND, sha256: 'a'}, observer: OWNER,
    payloadHash: op.effect.payloadHash, controlEpoch: op.controlEpoch,
  }), hasCode('STALE_CONTROL'));
  assert.equal((await importStore(f.harness).loadOperation(op.id))?.state, 'unknown');
  assert.ok(taken.controlEpoch > op.controlEpoch);
});

/* -------------------------------------------------------------------------- */
/* Store-level token CAS                                                       */
/* -------------------------------------------------------------------------- */

test('settlement CAS requires the current attempt token at the store boundary', async t => {
  const f = await durableFixture(t, async () => { throw new Error('x'); });
  const store = importStore(f.harness);
  const op = await f.commands.beginOperation(operationInput()) as SecureResourceOperation;
  const dispatching = attemptWithToken(op, {token: 'token-1', startedAt: START, deadline: op.deadline});
  await store.commit(RESOURCE_ID, {operation: {value: dispatching, expectedRevision: 0, expectedAttemptToken: null}});
  const settled = settleAttempt(dispatching, {state: 'done', token: 'token-1', result: {ok: true}});
  await assert.rejects(store.commit(RESOURCE_ID, {
    operation: {value: settled, expectedRevision: dispatching.revision, expectedAttemptToken: 'token-other'},
  }), hasCode('RESOURCE_CONFLICT'));
  assert.equal((await store.loadOperation(op.id))?.state, 'attempting');
  await store.commit(RESOURCE_ID, {
    operation: {value: settled, expectedRevision: dispatching.revision, expectedAttemptToken: 'token-1'},
  });
  assert.equal((await store.loadOperation(op.id))?.state, 'done');
});

/* -------------------------------------------------------------------------- */
/* Durable reopen + version-1 rejection                                        */
/* -------------------------------------------------------------------------- */

test('secure operation fields survive a durable close/reopen', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'point-secure-reopen-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const entry = effectWith(async () => ({ok: true}));
  const effects = registryOf(entry);
  let runtime: Runtime = await openRuntime(dir, undefined, {resources: {effects}});
  const resource = await runtime.resources.acquire({resourceId: RESOURCE_ID, requestId: 'a-1', owner: OWNER, ttlMs: 600_000});
  await runtime.resources.beginOperation({
    operationId: 'op-reopen', requestId: 'op-reopen', resourceId: RESOURCE_ID,
    controlEpoch: resource.controlEpoch, effect: {kind: KIND, payload: {text: 'persisted'}},
  });
  const done = await runtime.resources.runOperation('op-reopen', effects) as SecureResourceOperation;
  assert.equal(done.state, 'done');
  await runtime.close();

  runtime = await openRuntime(dir, undefined, {resources: {effects}});
  const replayed = await runtime.resources.runOperation('op-reopen');
  assert.equal(replayed.state, 'done');
  assert.deepEqual(replayed.result, {ok: true});
  assert.equal((replayed as SecureResourceOperation).owner, resource.owner);
  assert.equal((replayed as SecureResourceOperation).effect?.kind, KIND);
  assert.equal((replayed as SecureResourceOperation).effect?.payloadHash, done.effect.payloadHash);
  assert.equal((replayed as SecureResourceOperation).attemptToken, done.attemptToken);
  assert.equal((replayed as SecureResourceOperation).attemptStartedAt, done.attemptStartedAt);
  assert.equal((replayed as SecureResourceOperation).deadline, done.deadline);
  // Without a registry the runtime fails closed; the version-1 callback API is rejected.
  await runtime.close();
  runtime = await openRuntime(dir);
  await assert.rejects(runtime.resources.beginOperation({
    operationId: 'op-fail-closed', requestId: 'op-fail-closed', resourceId: RESOURCE_ID,
    controlEpoch: 1, effect: {kind: KIND, payload: {text: 'x'}},
  }), hasCode('EFFECT_NOT_REGISTERED'));
  await assert.rejects(runtime.resources.runOperation('op-reopen', {async invoke() { return 'legacy'; }} as never),
    hasCode('INVALID_COMMAND'), 'callback dispatch is not available through the real runtime');
  await runtime.close();
});

test('version-1 operation documents are rejected with OPERATION_INCOMPATIBLE', async t => {
  assert.equal(Resources.definition.version, 1, 'resource family stays v1');
  assert.equal(ResourceOperations.definition.version, 2, 'operation family is v2');
  const dir = await mkdtemp(join(tmpdir(), 'point-secure-v1-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const created = await openRuntime(dir);
  await created.close();
  type LegacyJsonObject = {[key: string]: ChordJsonValue};
  const LegacyOperations = defineDocFamily<LegacyJsonObject, LegacyJsonObject>({
    kind: 'point.resource-operation', version: 1, scope: 'session', family: true,
    initial: (document: LegacyJsonObject) => ({...document}),
  });
  const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'state.sqlite')),
    {models: createModels(), registry: createRegistry()}, context);
  await harness.commit(tx => tx.doc(LegacyOperations, 'legacy-op', {
    present: true,
    value: {
      id: 'legacy-op', requestId: 'legacy-op', resourceId: RESOURCE_ID, controlEpoch: 1,
      state: 'intent', revision: 0, fingerprint: 'legacy',
      result: null, observation: null,
    },
  }), context);
  await harness.close(context);

  const runtime = await openRuntime(dir, undefined, {resources: {effects: registryOf(effectWith(async () => ({ok: true})))}});
  await assert.rejects(runtime.resources.runOperation('legacy-op'),
    hasCode('OPERATION_INCOMPATIBLE'));
  await assert.rejects(runtime.resources.observeOperation({
    operationId: 'legacy-op', status: 'done', evidence: {kind: KIND, sha256: 'a'}, observer: OWNER,
    payloadHash: 'legacy', controlEpoch: 1,
  }), hasCode('OPERATION_INCOMPATIBLE'));
  await runtime.close();
});

/* -------------------------------------------------------------------------- */
/* Deterministic in-memory store fixture sanity                                */
/* -------------------------------------------------------------------------- */

test('version-1 memory callback commands remain available when secure mode is off', async () => {
  const {memoryResourceStore} = await import('../src/adapters/resource/memory.js');
  const store = memoryResourceStore();
  const commands = resourceCommands(store, () => START);
  const resource = await commands.acquire({resourceId: RESOURCE_ID, requestId: 'legacy-a', owner: OWNER, ttlMs: 1000});
  const op = await commands.beginOperation({operationId: 'legacy-op', requestId: 'legacy-op', resourceId: RESOURCE_ID, controlEpoch: resource.controlEpoch});
  const done = await commands.runOperation(op.id, {async invoke() { return 'legacy-result'; }});
  assert.equal(done.state, 'done');
  assert.equal(done.result, 'legacy-result');
});

/* -------------------------------------------------------------------------- */
/* Helpers used above                                                          */
/* -------------------------------------------------------------------------- */

test('initialResource stays the source of truth for a fresh resource', () => {
  const resource = initialResource(RESOURCE_ID);
  assert.equal(resource.state, 'idle');
  assert.equal(resource.controlEpoch, 0);
});
