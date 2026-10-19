import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  acquire, assertControl, expire, initialResource, release, renew, takeover,
  ResourceError, type Resource, type ResourceOperation,
} from '../src/domain/resource.js';
import { resourceCommands, type ResourceMutation, type ResourceStore } from '../src/application/resource.js';
import { memoryResourceStore } from '../src/adapters/resource/memory.js';

const RESOURCE_ID = 'browser:primary';
const OWNER = 'owner-a';
const OTHER_OWNER = 'owner-b';
const START = 1_000_000;

function clock(start = START) {
  let current = start;
  return { now: () => current, advance(ms: number) { current += ms; } };
}

/** Validate the stable ResourceError code; error messages are not part of the contract. */
function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ResourceError, `expected ResourceError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

function assertInvariants(resource: Resource) {
  assert.ok(Number.isSafeInteger(resource.controlEpoch) && resource.controlEpoch >= 0, 'controlEpoch is a safe non-negative integer');
  assert.ok(Number.isSafeInteger(resource.revision) && resource.revision >= 0, 'revision is a safe non-negative integer');
  assert.equal(resource.state === 'leased', resource.lease !== null, 'state is leased iff a lease exists');
  if (resource.lease === null) {
    assert.equal(resource.owner, null);
    return;
  }
  assert.equal(resource.owner, resource.lease.owner);
  assert.equal(resource.lease.epoch, resource.controlEpoch);
  assert.ok(Number.isSafeInteger(resource.lease.expiresAt));
}

/**
 * Memory store plus a commit counter, so "invalid input writes nothing" is observable.
 * `seed` writes the empty resource directly; only `acquire` creates a missing resource,
 * every other command reports RESOURCE_NOT_FOUND.
 */
function fixture(start = START) {
  const time = clock(start);
  const inner = memoryResourceStore();
  const stats = { commits: 0 };
  const store: ResourceStore = {
    load: id => inner.load(id),
    loadOperation: id => inner.loadOperation(id),
    findOperation: (resourceId, requestId) => inner.findOperation(resourceId, requestId),
    loadReceipt: (resourceId, requestId) => inner.loadReceipt(resourceId, requestId),
    commit: async (resourceId, mutation) => {
      stats.commits += 1;
      return inner.commit(resourceId, mutation);
    },
  };
  const seed = async (id = RESOURCE_ID) => {
    await inner.commit(id, { resource: { value: initialResource(id), expectedRevision: undefined } });
  };
  return { time, inner, stats, seed, commands: resourceCommands(store, time.now) };
}

const command = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  resourceId: RESOURCE_ID, requestId: 'req-1', owner: OWNER, ttlMs: 500, ...overrides,
});

test('initial resource is idle at epoch zero with no lease; malformed ids are rejected', () => {
  for (const id of ['r', RESOURCE_ID, 'a.b_c-d:1']) {
    const resource = initialResource(id);
    assert.deepEqual(resource, { id, owner: null, lease: null, controlEpoch: 0, revision: 0, state: 'idle' });
    assertInvariants(resource);
  }
  for (const bad of ['', ' ', 'has space', '名字', 'a/b', 'x'.repeat(129), null, 7, undefined]) {
    assert.throws(() => initialResource(bad as unknown as string), hasCode('INVALID_COMMAND'));
  }
});

test('acquire grants the first lease and refuses a second owner with RESOURCE_BUSY', () => {
  const idle = initialResource(RESOURCE_ID);
  const leased = acquire(idle, { owner: OWNER, ttlMs: 500 }, 1000);
  assert.deepEqual(leased, {
    id: RESOURCE_ID,
    owner: OWNER,
    lease: { owner: OWNER, expiresAt: 1500, epoch: 1 },
    controlEpoch: 1,
    revision: 1,
    state: 'leased',
  });
  assertInvariants(leased);
  assert.deepEqual(idle, initialResource(RESOURCE_ID), 'pure transitions must not mutate their input');
  assert.throws(() => acquire(leased, { owner: OTHER_OWNER, ttlMs: 500 }, 1200), hasCode('RESOURCE_BUSY'));
  // "有效租约" is strictly expiresAt > now, so the instant of expiry is already free.
  assert.throws(() => acquire(leased, { owner: OTHER_OWNER, ttlMs: 500 }, 1499), hasCode('RESOURCE_BUSY'));
});

test('repeated acquire by the same owner returns the same lease without bumping the epoch', () => {
  const leased = acquire(initialResource(RESOURCE_ID), { owner: OWNER, ttlMs: 500 }, 1000);
  const again = acquire(leased, { owner: OWNER, ttlMs: 9000 }, 1200);
  assert.deepEqual(again, leased);
  assert.equal(again.controlEpoch, 1);
  assert.equal(again.revision, 1);
  assert.equal(again.lease?.expiresAt, 1500, 'the original lease is returned untouched');
});

test('acquire after expiry takes over with an incremented epoch', () => {
  const leased = acquire(initialResource(RESOURCE_ID), { owner: OWNER, ttlMs: 500 }, 1000);
  const next = acquire(leased, { owner: OTHER_OWNER, ttlMs: 200 }, 1500);
  assert.deepEqual(next, {
    id: RESOURCE_ID,
    owner: OTHER_OWNER,
    lease: { owner: OTHER_OWNER, expiresAt: 1700, epoch: 2 },
    controlEpoch: 2,
    revision: 2,
    state: 'leased',
  });
  assertInvariants(next);
  assert.throws(() => renew(next, { owner: OWNER, epoch: 1, ttlMs: 100 }, 1600), hasCode('STALE_CONTROL'));
});

test('renew extends a live lease and rejects expired or stale control', () => {
  const leased = acquire(initialResource(RESOURCE_ID), { owner: OWNER, ttlMs: 500 }, 1000);
  const renewed = renew(leased, { owner: OWNER, epoch: 1, ttlMs: 1000 }, 1200);
  assert.equal(renewed.controlEpoch, 1);
  assert.equal(renewed.revision, 2);
  assert.deepEqual(renewed.lease, { owner: OWNER, expiresAt: 2200, epoch: 1 });
  assertInvariants(renewed);
  assert.throws(() => renew(leased, { owner: OTHER_OWNER, epoch: 1, ttlMs: 100 }, 1200), hasCode('STALE_CONTROL'));
  assert.throws(() => renew(leased, { owner: OWNER, epoch: 0, ttlMs: 100 }, 1200), hasCode('STALE_CONTROL'));
  assert.throws(() => renew(leased, { owner: OWNER, epoch: 1, ttlMs: 100 }, 1500), hasCode('LEASE_EXPIRED'));
});

test('release clears the lease once and rejects other owners or stale epochs', () => {
  const leased = acquire(initialResource(RESOURCE_ID), { owner: OWNER, ttlMs: 500 }, 1000);
  const released = release(leased, { owner: OWNER, epoch: 1 });
  assert.deepEqual(released, { id: RESOURCE_ID, owner: null, lease: null, controlEpoch: 1, revision: 2, state: 'idle' });
  assertInvariants(released);
  assert.throws(() => release(leased, { owner: OTHER_OWNER, epoch: 1 }), hasCode('STALE_CONTROL'));
  assert.throws(() => release(leased, { owner: OWNER, epoch: 0 }), hasCode('STALE_CONTROL'));
  // Releasing an already idle resource with the current epoch is idempotent.
  assert.deepEqual(release(released, { owner: OWNER, epoch: 1 }), released);
  assert.throws(() => release(released, { owner: OWNER, epoch: 2 }), hasCode('STALE_CONTROL'));
});

test('takeover replaces the owner, increments the epoch and fences the old control', () => {
  const leased = acquire(initialResource(RESOURCE_ID), { owner: OWNER, ttlMs: 5000 }, 1000);
  const taken = takeover(leased, { owner: OTHER_OWNER, ttlMs: 7000 }, 2000);
  assert.deepEqual(taken, {
    id: RESOURCE_ID,
    owner: OTHER_OWNER,
    lease: { owner: OTHER_OWNER, expiresAt: 9000, epoch: 2 },
    controlEpoch: 2,
    revision: 2,
    state: 'leased',
  });
  assertInvariants(taken);
  assert.throws(() => renew(taken, { owner: OWNER, epoch: 1, ttlMs: 100 }, 2100), hasCode('STALE_CONTROL'));
  assert.throws(() => release(taken, { owner: OWNER, epoch: 1 }), hasCode('STALE_CONTROL'));
  assert.throws(() => assertControl(taken, 1), hasCode('STALE_CONTROL'));
  assert.doesNotThrow(() => assertControl(taken, 2));
  const idleTaken = takeover(initialResource(RESOURCE_ID), { owner: OWNER, ttlMs: 100 }, 10);
  assert.equal(idleTaken.controlEpoch, 1);
  for (const invalid of [
    { owner: OWNER, ttlMs: 0 },
    { owner: OWNER, ttlMs: 86_400_001 },
    { owner: OWNER, ttlMs: 1.5 },
    { owner: '', ttlMs: 100 },
    { owner: 'bad owner', ttlMs: 100 },
  ]) {
    assert.throws(() => takeover(taken, invalid, 3000), hasCode('INVALID_COMMAND'));
  }
});

test('expire clears only elapsed leases and never bumps the epoch', () => {
  const leased = acquire(initialResource(RESOURCE_ID), { owner: OWNER, ttlMs: 500 }, 1000);
  assert.deepEqual(expire(leased, 1499), leased);
  const expired = expire(leased, 1500);
  assert.deepEqual(expired, { id: RESOURCE_ID, owner: null, lease: null, controlEpoch: 1, revision: 2, state: 'idle' });
  assert.deepEqual(expire(expired, 5000), expired);
  assert.deepEqual(expire(initialResource(RESOURCE_ID), 5000), initialResource(RESOURCE_ID));
  const reacquired = acquire(expired, { owner: OTHER_OWNER, ttlMs: 100 }, 5000);
  assert.equal(reacquired.controlEpoch, 2);
  assertInvariants(reacquired);
});

test('non-acquire commands on a missing resource report RESOURCE_NOT_FOUND and never create it', async () => {
  const f = fixture();
  const attempts: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ['renew', () => f.commands.renew({ ...command(), epoch: 0 })],
    ['release', () => f.commands.release({ resourceId: RESOURCE_ID, requestId: 'req-1', owner: OWNER, epoch: 0 })],
    ['takeover', () => f.commands.takeover(command())],
    ['beginOperation', () => f.commands.beginOperation({ operationId: 'op', requestId: 'req', resourceId: RESOURCE_ID, controlEpoch: 0 })],
  ];
  for (const [name, attempt] of attempts) await assert.rejects(attempt(), hasCode('RESOURCE_NOT_FOUND'), `${name} must not create a missing resource`);
  assert.equal(f.stats.commits, 0);
  assert.equal(await f.commands.read(RESOURCE_ID), undefined);
});

test('acquire creates a missing resource and commits the first lease exactly once, replay included', async () => {
  // Lead arbitration: acquire on a missing resource creates `initialResource` and
  // leases it in one commit; other resource commands never create.
  const f = fixture();
  const input = command();
  const first = await f.commands.acquire(input);
  assert.deepEqual(await f.commands.read(RESOURCE_ID), first, 'the initial resource is created by the same command');
  assert.equal(first.state, 'leased');
  assert.equal(first.owner, OWNER);
  assert.equal(first.controlEpoch, 1);
  assertInvariants(first);
  assert.equal(f.stats.commits, 1);
  assert.deepEqual(await f.commands.acquire({ ...input }), first);
  assert.equal(f.stats.commits, 1, 'replaying the same request must not commit');
  const sameOwner = await f.commands.acquire({ ...input, requestId: 'req-2', ttlMs: 9000 });
  assert.equal(sameOwner.controlEpoch, 1);
  assert.equal(sameOwner.revision, first.revision);
  await assert.rejects(f.commands.acquire({ ...input, requestId: 'req-3', owner: OTHER_OWNER }), hasCode('RESOURCE_BUSY'));
});

test('resource write commands reject a reused request key with different content', async () => {
  const f = fixture();
  const acquired = await f.commands.acquire(command());
  await assert.rejects(f.commands.acquire({ ...command(), owner: OTHER_OWNER }), hasCode('IDEMPOTENCY_CONFLICT'));
  const renewInput = {
    resourceId: RESOURCE_ID, requestId: 'renew-key', owner: OWNER, epoch: acquired.controlEpoch, ttlMs: 1000,
  };
  await f.commands.renew(renewInput);
  await assert.rejects(f.commands.renew({ ...renewInput, ttlMs: 2000 }), hasCode('IDEMPOTENCY_CONFLICT'));
  const takeoverInput = { resourceId: RESOURCE_ID, requestId: 'takeover-key', owner: OTHER_OWNER, ttlMs: 1000 };
  const taken = await f.commands.takeover(takeoverInput);
  await assert.rejects(f.commands.takeover({ ...takeoverInput, ttlMs: 2000 }), hasCode('IDEMPOTENCY_CONFLICT'));
  const releaseInput = { resourceId: RESOURCE_ID, requestId: 'release-key', owner: OTHER_OWNER, epoch: taken.controlEpoch };
  await f.commands.release(releaseInput);
  await assert.rejects(f.commands.release({ ...releaseInput, owner: OWNER }), hasCode('IDEMPOTENCY_CONFLICT'));
});

test('read returns detached copies and undefined for unknown resources', async () => {
  const f = fixture();
  await f.seed();
  const leased = await f.commands.acquire(command());
  const copy = await f.commands.read(RESOURCE_ID);
  assert.ok(copy);
  (copy as { owner: string }).owner = 'caller-mutation';
  assert.equal((await f.commands.read(RESOURCE_ID))?.owner, leased.owner);
  assert.equal(await f.commands.read('missing:resource'), undefined);
});

test('renew, release and expiry follow the lease rules through the command layer', async () => {
  const f = fixture();
  await f.seed();
  const acquired = await f.commands.acquire(command());
  const renewed = await f.commands.renew({
    resourceId: RESOURCE_ID, requestId: 'renew-1', owner: OWNER, epoch: acquired.controlEpoch, ttlMs: 2000,
  });
  assert.equal(renewed.lease?.expiresAt, START + 2000);
  assert.equal(renewed.revision, acquired.revision + 1);
  await assert.rejects(f.commands.renew({
    resourceId: RESOURCE_ID, requestId: 'renew-2', owner: OTHER_OWNER, epoch: 1, ttlMs: 100,
  }), hasCode('STALE_CONTROL'));
  await assert.rejects(f.commands.renew({
    resourceId: RESOURCE_ID, requestId: 'renew-3', owner: OWNER, epoch: 0, ttlMs: 100,
  }), hasCode('STALE_CONTROL'));
  f.time.advance(2000);
  await assert.rejects(f.commands.renew({
    resourceId: RESOURCE_ID, requestId: 'renew-4', owner: OWNER, epoch: 1, ttlMs: 100,
  }), hasCode('LEASE_EXPIRED'));
  const reacquired = await f.commands.acquire({ ...command(), requestId: 'req-after-expiry', owner: OTHER_OWNER });
  assert.equal(reacquired.controlEpoch, 2);
  const released = await f.commands.release({
    resourceId: RESOURCE_ID, requestId: 'release-1', owner: OTHER_OWNER, epoch: 2,
  });
  assert.equal(released.state, 'idle');
  assert.equal(released.owner, null);
  assert.deepEqual(await f.commands.release({
    resourceId: RESOURCE_ID, requestId: 'release-1', owner: OTHER_OWNER, epoch: 2,
  }), released);
  await assert.rejects(f.commands.release({
    resourceId: RESOURCE_ID, requestId: 'release-2', owner: OTHER_OWNER, epoch: 1,
  }), hasCode('STALE_CONTROL'));
});

test('takeover fences the previous epoch for renew, release and beginOperation', async () => {
  const f = fixture();
  await f.seed();
  const first = await f.commands.acquire(command());
  const taken = await f.commands.takeover({
    resourceId: RESOURCE_ID, requestId: 'takeover-1', owner: OTHER_OWNER, ttlMs: 5000,
  });
  assert.equal(taken.controlEpoch, 2);
  assert.equal(taken.owner, OTHER_OWNER);
  assertInvariants(taken);
  await assert.rejects(f.commands.renew({
    resourceId: RESOURCE_ID, requestId: 'stale-renew', owner: OWNER, epoch: first.controlEpoch, ttlMs: 100,
  }), hasCode('STALE_CONTROL'));
  await assert.rejects(f.commands.release({
    resourceId: RESOURCE_ID, requestId: 'stale-release', owner: OWNER, epoch: first.controlEpoch,
  }), hasCode('STALE_CONTROL'));
  await assert.rejects(f.commands.beginOperation({
    operationId: 'stale-op', requestId: 'stale-op', resourceId: RESOURCE_ID, controlEpoch: first.controlEpoch,
  }), hasCode('STALE_CONTROL'));
  const current = await f.commands.beginOperation({
    operationId: 'current-op', requestId: 'current-op', resourceId: RESOURCE_ID, controlEpoch: taken.controlEpoch,
  });
  assert.equal(current.state, 'intent');
  assert.equal((await f.commands.read(RESOURCE_ID))?.owner, OTHER_OWNER);
});

test('invalid commands are rejected with INVALID_COMMAND and write nothing', async () => {
  const f = fixture();
  const base = command();
  const invalid: ReadonlyArray<readonly [string, unknown]> = [
    ['acquire', null], ['acquire', []], ['acquire', {}],
    ['acquire', { ...base, extra: true }],
    ['acquire', { ...base, resourceId: '' }],
    ['acquire', { ...base, resourceId: 'x'.repeat(129) }],
    ['acquire', { ...base, resourceId: 7 }],
    ['acquire', { ...base, requestId: 'bad id' }],
    ['acquire', { ...base, requestId: '' }],
    ['acquire', { ...base, owner: '' }],
    ['acquire', { ...base, owner: 'bad owner' }],
    ['acquire', { ...base, ttlMs: 0 }],
    ['acquire', { ...base, ttlMs: 86_400_001 }],
    ['acquire', { ...base, ttlMs: 1.5 }],
    ['acquire', { ...base, ttlMs: '500' }],
    ['renew', { ...base, epoch: -1 }],
    ['renew', { ...base, epoch: 1.5 }],
    ['renew', { ...base, epoch: 9_007_199_254_740_992 }],
    ['renew', { ...base, epoch: '1' }],
    ['renew', { ...base, epoch: undefined }],
    ['release', { ...base, epoch: -1 }],
    ['release', { ...base, epoch: 1.5 }],
    ['takeover', { ...base, ttlMs: 0 }],
    ['beginOperation', { operationId: '', requestId: 'r', resourceId: RESOURCE_ID, controlEpoch: 0 }],
    ['beginOperation', { operationId: 'op', requestId: 'r', resourceId: RESOURCE_ID, controlEpoch: -1 }],
    ['beginOperation', { operationId: 'op', requestId: 'r', resourceId: RESOURCE_ID, controlEpoch: 1.5 }],
    ['beginOperation', { operationId: 'op', requestId: 'r', resourceId: RESOURCE_ID, controlEpoch: 0, extra: true }],
    ['beginOperation', { operationId: 'op', requestId: 'r', resourceId: RESOURCE_ID }],
    ['observeOperation', { operationId: 'op', status: 'attempted' }],
    ['observeOperation', { operationId: 'op' }],
    ['observeOperation', { operationId: 'op', status: 'done', observation: 'x'.repeat(513) }],
    ['observeOperation', { operationId: 'op', status: 'done', extra: true }],
  ];
  for (const [name, input] of invalid) {
    const method = f.commands[name as 'acquire'];
    await assert.rejects(Promise.resolve(method(input)), hasCode('INVALID_COMMAND'),
      `${name} accepted invalid input: ${JSON.stringify(input)}`);
  }
  assert.equal(f.stats.commits, 0, 'invalid input must not reach the store');
  assert.equal(await f.commands.read(RESOURCE_ID), undefined);
});

test('invalid mutations on an existing resource leave it untouched', async () => {
  const f = fixture();
  await f.seed();
  const leased = await f.commands.acquire(command());
  const commits = f.stats.commits;
  await assert.rejects(f.commands.renew({ ...command(), requestId: 'bad-renew', epoch: -1 }), hasCode('INVALID_COMMAND'));
  await assert.rejects(f.commands.release({ resourceId: RESOURCE_ID, requestId: 'bad-release', owner: OWNER, epoch: '1' }), hasCode('INVALID_COMMAND'));
  assert.equal(f.stats.commits, commits);
  assert.deepEqual(await f.commands.read(RESOURCE_ID), leased);
});

test('memory store applies resource, operation and receipt atomically or not at all', async () => {
  const store = memoryResourceStore();
  const initial = initialResource(RESOURCE_ID);
  await store.commit(RESOURCE_ID, { resource: { value: initial, expectedRevision: undefined } });
  const leased = acquire(initial, { owner: OWNER, ttlMs: 1000 }, START);
  const operation: ResourceOperation = {
    id: 'op-atomic', requestId: 'req-atomic', resourceId: RESOURCE_ID,
    controlEpoch: 1, state: 'intent', revision: 0, fingerprint: 'fp',
  };
  const receipt = { fingerprint: 'fp', result: leased };
  await store.commit(RESOURCE_ID, {
    resource: { value: leased, expectedRevision: 0 },
    operation: { value: operation, expectedRevision: undefined },
    receipt: { requestId: 'req-atomic', receipt },
  });
  assert.deepEqual(await store.load(RESOURCE_ID), leased);
  assert.deepEqual(await store.loadOperation('op-atomic'), operation);
  assert.deepEqual(await store.loadReceipt(RESOURCE_ID, 'req-atomic'), receipt);

  // Any failing CAS aborts the whole mutation: no resource, operation or receipt write.
  const failingResource: ResourceMutation = {
    resource: { value: { ...leased, revision: 9 }, expectedRevision: 99 },
    operation: { value: { ...operation, id: 'op-lost', requestId: 'req-lost' }, expectedRevision: undefined },
    receipt: { requestId: 'req-lost', receipt: { fingerprint: 'lost', result: leased } },
  };
  await assert.rejects(store.commit(RESOURCE_ID, failingResource), hasCode('RESOURCE_CONFLICT'));
  assert.deepEqual(await store.load(RESOURCE_ID), leased);
  assert.equal(await store.loadOperation('op-lost'), undefined);
  assert.equal(await store.loadReceipt(RESOURCE_ID, 'req-lost'), undefined);

  const failingOperation: ResourceMutation = {
    resource: { value: { ...leased, revision: leased.revision + 1 }, expectedRevision: leased.revision },
    operation: { value: { ...operation, revision: 0, state: 'attempting' }, expectedRevision: 42 },
  };
  await assert.rejects(store.commit(RESOURCE_ID, failingOperation), hasCode('RESOURCE_CONFLICT'));
  assert.deepEqual(await store.load(RESOURCE_ID), leased);
  assert.deepEqual(await store.loadOperation('op-atomic'), operation);

  const failingReceipt: ResourceMutation = {
    resource: { value: { ...leased, revision: leased.revision + 1 }, expectedRevision: leased.revision },
    receipt: { requestId: 'req-atomic', receipt: { fingerprint: 'different', result: leased } },
  };
  await assert.rejects(store.commit(RESOURCE_ID, failingReceipt), hasCode('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(await store.load(RESOURCE_ID), leased);
});

test('domain and application resource modules stay platform independent and define no Durable tasks', async () => {
  const serverRoot = fileURLToPath(new URL('../..', import.meta.url));
  const sources: ReadonlyArray<readonly [string, string]> = [
    ['src/domain/resource.ts', await readFile(join(serverRoot, 'src/domain/resource.ts'), 'utf8')],
    ['src/application/resource.ts', await readFile(join(serverRoot, 'src/application/resource.ts'), 'utf8')],
  ];
  const specifiers = (source: string) => [...source.matchAll(/from\s+(['"])([^'"]+)\1|import\s*\(\s*(['"])([^'"]+)\3\s*\)/g)]
    .map(match => match[2] ?? match[4] ?? '');
  for (const [file, source] of sources) {
    for (const specifier of specifiers(source)) {
      assert.ok(!specifier.startsWith('node:'), `${file} must not import node builtins (${specifier})`);
      assert.ok(!specifier.startsWith('@earendil-works/'), `${file} must not import the Durable SDK (${specifier})`);
      assert.ok(!specifier.includes('adapters'), `${file} must not import adapters (${specifier})`);
    }
    assert.equal(/\bdefineTask\b/.test(source), false, `${file} must not define Durable tasks`);
  }
});
