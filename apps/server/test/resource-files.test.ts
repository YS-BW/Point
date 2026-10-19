/**
 * Hardened file resource adapter tests (OpenSpec agent-resource-adapter-safety 2.1-2.2).
 *
 * These run against a real temporary directory and the real Durable resource runtime
 * (`openRuntime` + secure effect registry); no network, no faux model, no dist build.
 * The fault-injection hooks are test-only seams: `beforeRename` simulates a hostile
 * parent/target swap inside the check-to-rename window, `afterRename` simulates a crash
 * after the file is visible but before settlement.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FILE_EFFECT_KIND, FileAdapterError, MAX_FILE_BYTES,
  createFileResourceAdapter, createFileResourceEffect,
  type FileAdapterHooks,
} from '../src/adapters/resource/files.js';
import { createEffectRegistry } from '../src/application/resource.js';
import { ResourceError, type ResourceOperation } from '../src/domain/resource.js';
import { openRuntime, type Runtime } from '../src/runtime/open.js';

const RESOURCE_ID = 'file:primary';
const OWNER = 'owner-a';
const TTL_MS = 600_000;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof FileAdapterError, `expected FileAdapterError(${expected}), got ${String(error)}`);
  assert.equal(error.code, expected);
  return true;
};
const resourceCode = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof ResourceError, `expected ResourceError(${expected}), got ${String(error)}`);
  assert.equal(error.code, expected);
  return true;
};

type Fixture = Readonly<{
  dir: string;
  root: string;
  dataDir: string;
  runtime: Runtime;
  adapter: Awaited<ReturnType<typeof createFileResourceAdapter>>;
  leaseEpoch: number;
}>;

async function fixture(t: TestContext, hooks?: FileAdapterHooks): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'point-files-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const root = join(dir, 'root');
  const dataDir = join(dir, 'data');
  await mkdir(root, {mode: 0o700});
  const effect = await createFileResourceEffect(root, hooks === undefined ? {} : {hooks});
  const runtime = await openRuntime(dataDir, undefined, {resources: {effects: createEffectRegistry([effect])}});
  const adapter = await createFileResourceAdapter(root, runtime.resources, hooks === undefined ? {} : {hooks});
  const lease = await runtime.resources.acquire({resourceId: RESOURCE_ID, requestId: 'lease-1', owner: OWNER, ttlMs: TTL_MS});
  const fixture: Fixture = {dir, root, dataDir, runtime, adapter, leaseEpoch: lease.controlEpoch};
  t.after(() => runtime.close());
  return fixture;
}

function write(f: Fixture, operationId: string, path: string, content: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return f.adapter.write({
    operationId, requestId: `req-${operationId}`, resourceId: RESOURCE_ID,
    controlEpoch: f.leaseEpoch, path, content, ...overrides,
  });
}

function result(operation: ResourceOperation): {path: string; sha256: string; bytes: number} {
  assert.equal(operation.state, 'done');
  const value = operation.result;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as {path: string; sha256: string; bytes: number};
}

async function noTempFiles(directory: string): Promise<void> {
  const names = await readdir(directory);
  assert.deepEqual(names.filter(name => name.startsWith('.point-file-')), []);
}

test('write is atomic, bounded and leaves a 0600 regular file', async t => {
  const f = await fixture(t);
  const operation = await write(f, 'op-1', 'docs/note.txt', '你好，Point');
  assert.deepEqual(result(operation), {path: 'docs/note.txt', sha256: sha256('你好，Point'), bytes: Buffer.byteLength('你好，Point')});
  const target = join(f.root, 'docs', 'note.txt');
  assert.equal(await readFile(target, 'utf8'), '你好，Point');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  // Created parent directories are private to the owner.
  assert.equal((await stat(join(f.root, 'docs'))).mode & 0o077, 0);
  await noTempFiles(join(f.root, 'docs'));

  // Rewriting replaces the file atomically and never leaves the temp around.
  const rewritten = await write(f, 'op-2', 'docs/note.txt', '第二版');
  assert.equal(result(rewritten).sha256, sha256('第二版'));
  assert.equal(await readFile(target, 'utf8'), '第二版');
  await noTempFiles(join(f.root, 'docs'));

  const read = await f.adapter.read({path: 'docs/note.txt'});
  assert.deepEqual(read, {path: 'docs/note.txt', sha256: sha256('第二版'), bytes: Buffer.byteLength('第二版'), content: '第二版'});
  const listed = await f.adapter.list({directory: 'docs'});
  assert.deepEqual(listed.entries.map(entry => [entry.name, entry.kind]), [['note.txt', 'file']]);
  assert.equal(listed.entries[0]?.bytes, Buffer.byteLength('第二版'));
});

test('paths reject traversal, absolute paths and symlinked components/targets', async t => {
  const f = await fixture(t);
  const outside = join(f.dir, 'outside');
  await mkdir(outside, {mode: 0o700});
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(join(outside, 'secret.txt'), join(f.root, 'link.txt'));
  await symlink(outside, join(f.root, 'out'));

  const badPaths = ['../escape.txt', '/etc/passwd', 'docs/../escape.txt', '..\\escape.txt', ''];
  for (const [index, path] of badPaths.entries()) {
    await assert.rejects(f.adapter.read({path}), code('FILE_PATH_REJECTED'));
    await assert.rejects(write(f, `bad-${index}`, path, 'x'), code('FILE_PATH_REJECTED'));
  }
  // Reading through a target symlink or a symlinked parent is rejected, never followed.
  await assert.rejects(f.adapter.read({path: 'link.txt'}), code('FILE_SYMLINK_REJECTED'));
  await assert.rejects(f.adapter.read({path: 'out/secret.txt'}), code('FILE_SYMLINK_REJECTED'));

  // Writing through either is a known failure: no external file is created or modified.
  const linkWrite = await write(f, 'op-link', 'link.txt', 'must-not-land');
  assert.equal(linkWrite.state, 'failed');
  assert.equal(linkWrite.result, 'FILE_SYMLINK_REJECTED');
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret');

  const parentWrite = await write(f, 'op-parent', 'out/secret.txt', 'must-not-land');
  assert.equal(parentWrite.state, 'failed');
  assert.equal(parentWrite.result, 'FILE_SYMLINK_REJECTED');
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret');
  assert.deepEqual((await readdir(outside)).sort(), ['secret.txt']);

  // The symlink target is observed but never presented as a managed file.
  const inspected = await f.adapter.inspect({path: 'link.txt'});
  assert.deepEqual(inspected, {path: 'link.txt', exists: true, regular: false, sha256: null, bytes: null});
  const rootListing = await f.adapter.list();
  assert.deepEqual(rootListing.entries.map(entry => entry.name), []);
});

test('missing and oversized files fail closed without inventing content', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.read({path: 'nope.txt'}), code('FILE_NOT_FOUND'));
  await writeFile(join(f.root, 'big.bin'), Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
  await assert.rejects(f.adapter.read({path: 'big.bin'}), code('FILE_TOO_LARGE'));
  await assert.rejects(write(f, 'op-big', 'too-big.txt', 'x'.repeat(MAX_FILE_BYTES + 1)), code('FILE_TOO_LARGE'));
  await assert.rejects(readFile(join(f.root, 'too-big.txt')), /ENOENT/);
  // The registered capability rejects oversized payloads at the resource boundary too.
  assert.throws(() => f.adapter.registered.definition.validatePayload({
    path: 'too-big.txt', content: 'x'.repeat(MAX_FILE_BYTES + 1),
    sha256: sha256('x'.repeat(MAX_FILE_BYTES + 1)), bytes: MAX_FILE_BYTES + 1,
  }), resourceCode('PAYLOAD_REJECTED'));
});

test('TOCTOU: a target or parent swapped before rename is rejected, outside stays untouched', async t => {
  const outside = await mkdtemp(join(tmpdir(), 'point-files-outside-'));
  t.after(() => rm(outside, {recursive: true, force: true}));
  const outsideFile = join(outside, 'target.txt');
  await writeFile(outsideFile, 'outside-original');

  // Swap the (absent) destination for a symlink after the temp file is durable.
  let swapped = false;
  const targetSwap = await fixture(t, {
    async beforeRename({target}) {
      await symlink(outsideFile, target);
      swapped = true;
    },
  });
  const targetOperation = await write(targetSwap, 'op-swap-target', 'note.txt', 'attacker-controlled');
  assert.ok(swapped);
  assert.equal(targetOperation.state, 'failed');
  assert.equal(targetOperation.result, 'FILE_SYMLINK_REJECTED');
  assert.equal(await readFile(outsideFile, 'utf8'), 'outside-original');
  await noTempFiles(targetSwap.root);

  // Replace the parent directory with a symlink to an outside directory.
  let parentSwapped = false;
  const parentSwap = await fixture(t, {
    async beforeRename({root}) {
      const parent = join(root, 'sub');
      await rm(join(root, 'sub.moved'), {recursive: true, force: true});
      await rename(parent, join(root, 'sub.moved'));
      await symlink(outside, parent);
      parentSwapped = true;
    },
  });
  const parentOperation = await write(parentSwap, 'op-swap-parent', 'sub/escaped.txt', 'attacker-controlled');
  assert.ok(parentSwapped);
  assert.equal(parentOperation.state, 'failed');
  assert.equal(parentOperation.result, 'FILE_PATH_REJECTED');
  assert.equal((await readdir(outside)).filter(name => name !== 'target.txt').length, 0);
});

test('a failure before rename leaves the previous file and the root untouched', async t => {
  const f = await fixture(t, {
    beforeRename() {
      throw new Error('simulated crash before rename');
    },
  });
  await writeFile(join(f.root, 'keep.txt'), 'original content');
  const operation = await write(f, 'op-before-rename', 'keep.txt', 'replacement');
  assert.equal(operation.state, 'failed');
  assert.equal(operation.result, 'FILE_PATH_REJECTED');
  // The previous file is still the old one, and no temp file leaked.
  assert.equal(await readFile(join(f.root, 'keep.txt'), 'utf8'), 'original content');
  await noTempFiles(f.root);
});

test('unknown-after-rename is reconciled by observation across a restart, never replayed', async t => {
  let renames = 0;
  const f = await fixture(t, {
    afterRename() {
      renames += 1;
      throw new Error('simulated crash after rename');
    },
  });
  const unknown = await write(f, 'op-unknown', 'crash.txt', 'durable content');
  assert.equal(unknown.state, 'unknown');
  assert.equal(renames, 1);
  assert.equal(await readFile(join(f.root, 'crash.txt'), 'utf8'), 'durable content');

  await f.runtime.close();
  // Reopen the same data directory (restart) with a fresh adapter; the operation is unknown.
  const effect = await createFileResourceEffect(f.root);
  const reopened = await openRuntime(f.dataDir, undefined, {resources: {effects: createEffectRegistry([effect])}});
  t.after(() => reopened.close());
  const adapter = await createFileResourceAdapter(f.root, reopened.resources);
  const reconciled = await adapter.reconcile({operationId: 'op-unknown'});
  assert.equal(reconciled.state, 'done');
  assert.deepEqual(reconciled.result, {path: 'crash.txt', sha256: sha256('durable content'), bytes: Buffer.byteLength('durable content')});
  // Replaying reconcile on a terminal operation is a read, not another dispatch.
  const again = await adapter.reconcile({operationId: 'op-unknown'});
  assert.equal(again.state, 'done');
  assert.deepEqual(again.result, reconciled.result);
});

test('bound evidence: a missing or tampered file cannot be settled or forged into done', async t => {
  const f = await fixture(t, {
    afterRename() {
      throw new Error('simulated crash after rename');
    },
  });
  const unknown = await write(f, 'op-tampered', 'tampered.txt', 'accepted content');
  assert.equal(unknown.state, 'unknown');
  await writeFile(join(f.root, 'tampered.txt'), 'tampered content');
  // Evidence is bound to the accepted payload: a tampered file is not valid proof for
  // either settlement, so reconcile refuses and the operation stays unknown.
  await assert.rejects(f.adapter.reconcile({operationId: 'op-tampered'}), code('FILE_EVIDENCE_REJECTED'));
  assert.equal((await f.runtime.resources.runOperation('op-tampered')).state, 'unknown');

  // Schema-valid but payload-contradicting evidence/result are rejected by the capability
  // definition at the resource boundary (P0-4/REDLINE-B), leaving unknown untouched.
  const matching = await write(f, 'op-bound', 'bound.txt', 'real content');
  assert.equal(matching.state, 'unknown');
  const operation = matching as typeof matching & Readonly<{
    effect: Readonly<{payloadHash: string}>; controlEpoch: number; owner: string;
  }>;
  const forgedEvidence = {
    kind: 'file', path: 'bound.txt', exists: true, regular: true,
    sha256: sha256('totally different content'), bytes: Buffer.byteLength('totally different content'),
  };
  const base = {
    operationId: 'op-bound', observer: operation.owner, payloadHash: operation.effect.payloadHash,
    controlEpoch: operation.controlEpoch,
  };
  await assert.rejects(f.runtime.resources.observeOperation({
    ...base, status: 'done', evidence: forgedEvidence,
  }), resourceCode('INVALID_EVIDENCE'));
  const realEvidence = {
    kind: 'file', path: 'bound.txt', exists: true, regular: true,
    sha256: sha256('real content'), bytes: Buffer.byteLength('real content'),
  };
  await assert.rejects(f.runtime.resources.observeOperation({
    ...base, status: 'done', evidence: realEvidence, result: {path: 'bound.txt', sha256: 'f'.repeat(64), bytes: 12},
  }), resourceCode('RESULT_REJECTED'));
  assert.equal((await f.runtime.resources.runOperation('op-bound')).state, 'unknown');
  // The honest observation path settles it once, with a result that restates payload/evidence.
  const reconciled = await f.adapter.reconcile({operationId: 'op-bound'});
  assert.equal(reconciled.state, 'done');
  assert.deepEqual(reconciled.result, {path: 'bound.txt', sha256: sha256('real content'), bytes: Buffer.byteLength('real content')});
});

test('write is idempotent per request and conflicts on different content', async t => {
  let renames = 0;
  const f = await fixture(t, {beforeRename() { renames += 1; }});
  // Case 1: an explicit deadline is part of the command identity and replays exactly.
  const deadline = Date.now() + 60_000;
  const first = await write(f, 'op-idem', 'same.txt', 'same content', {deadline});
  const replay = await write(f, 'op-idem', 'same.txt', 'same content', {deadline});
  assert.equal(result(first).sha256, result(replay).sha256);
  assert.equal(first.id, replay.id);
  assert.equal(renames, 1);
  await assert.rejects(write(f, 'op-idem', 'same.txt', 'different content', {deadline}), resourceCode('IDEMPOTENCY_CONFLICT'));
  assert.equal(renames, 1);

  // Case 2 (regression): an omitted deadline must not include the resolved wall-clock
  // default in the command identity, so replaying after the clock advances returns the
  // first operation (and its persisted deadline) instead of IDEMPOTENCY_CONFLICT.
  const omitted = await write(f, 'op-omitted', 'omitted.txt', 'omitted content');
  assert.equal(omitted.state, 'done');
  await new Promise(resolve => setTimeout(resolve, 10));
  const omittedReplay = await write(f, 'op-omitted', 'omitted.txt', 'omitted content');
  assert.equal(result(omittedReplay).sha256, result(omitted).sha256);
  assert.equal(omittedReplay.id, omitted.id);
  assert.equal(omittedReplay.fingerprint, omitted.fingerprint);
  assert.equal(omittedReplay.deadline, omitted.deadline);
  assert.equal(renames, 2);
});

test('stale control and expired leases fail before the effect runs', async t => {
  const f = await fixture(t);
  await f.runtime.resources.takeover({resourceId: RESOURCE_ID, requestId: 'takeover-1', owner: 'owner-b', ttlMs: TTL_MS});
  await assert.rejects(write(f, 'op-stale', 'stale.txt', 'x'), resourceCode('STALE_CONTROL'));
  await assert.rejects(readFile(join(f.root, 'stale.txt')), /ENOENT/);

  const expired = await fixture(t);
  const acquired = await expired.runtime.resources.acquire({
    resourceId: 'file:expiring', requestId: 'lease-expiring', owner: OWNER, ttlMs: 1,
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  await assert.rejects(expired.adapter.write({
    operationId: 'op-expired', requestId: 'req-expired', resourceId: 'file:expiring',
    controlEpoch: acquired.controlEpoch, path: 'expired.txt', content: 'x',
  }), resourceCode('LEASE_EXPIRED'));
  await assert.rejects(readFile(join(expired.root, 'expired.txt')), /ENOENT/);
});

test('unregistered capabilities and bad roots fail closed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'point-files-closed-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const root = join(dir, 'root');
  await mkdir(root, {mode: 0o700});
  await assert.rejects(createFileResourceEffect(''), code('FILE_ROOT_REQUIRED'));
  await assert.rejects(createFileResourceEffect('relative/root'), code('FILE_ROOT_REQUIRED'));
  await assert.rejects(createFileResourceEffect(join(dir, 'missing')), code('FILE_ROOT_UNAVAILABLE'));
  await writeFile(join(dir, 'file'), 'x');
  await assert.rejects(createFileResourceEffect(join(dir, 'file')), code('FILE_ROOT_UNAVAILABLE'));
  await assert.rejects(createFileResourceAdapter(root, undefined as never), code('FILE_INVALID_COMMAND'));

  // No registered effects: the runtime stays fail-closed and the write intent is not created.
  const runtime = await openRuntime(join(dir, 'data'));
  t.after(() => runtime.close());
  await runtime.resources.acquire({resourceId: RESOURCE_ID, requestId: 'lease-2', owner: OWNER, ttlMs: TTL_MS});
  const resource = await runtime.resources.read(RESOURCE_ID);
  const lease = resource?.lease;
  assert.ok(lease);
  await assert.rejects(runtime.resources.beginOperation({
    operationId: 'op-unregistered', requestId: 'req-unregistered', resourceId: RESOURCE_ID,
    controlEpoch: lease.epoch,
    effect: {kind: FILE_EFFECT_KIND, payload: {path: 'x.txt', content: 'x', sha256: sha256('x'), bytes: 1}},
  }), resourceCode('EFFECT_NOT_REGISTERED'));
  const effect = await createFileResourceEffect(root);
  const adapter = await createFileResourceAdapter(root, runtime.resources);
  // The adapter’s own registered effect is exposed for composition but the runtime above has none.
  assert.equal(adapter.registered.definition.kind, FILE_EFFECT_KIND);
  assert.equal(effect.definition.kind, FILE_EFFECT_KIND);
});
