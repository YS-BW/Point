import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  createFileOutboxNotificationAdapter, FileOutboxConfigError, OutboxError,
  outboxPayloadHash, outboxRecordPath, readOutboxRecord,
} from '../src/adapters/notification/file-outbox.js';
import type { NotificationRequest } from '../src/application/delivery.js';

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'point-outbox-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

function request(overrides: Partial<NotificationRequest> = {}): NotificationRequest {
  return {deliveryId: 'delivery-1', target: 'test', title: '季度提醒', text: '报告已完成', ...overrides};
}

function hasConfigCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof FileOutboxConfigError, `expected config error, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('file outbox configuration is explicit and fail-closed', () => {
  assert.throws(() => createFileOutboxNotificationAdapter({} as unknown as {dir: string}), hasConfigCode('OUTBOX_DIR_REQUIRED'));
  assert.throws(() => createFileOutboxNotificationAdapter({dir: ''}), hasConfigCode('OUTBOX_DIR_REQUIRED'));
  assert.throws(() => createFileOutboxNotificationAdapter({dir: 'relative/outbox'}), hasConfigCode('OUTBOX_DIR_INVALID'));
  assert.throws(() => createFileOutboxNotificationAdapter({dir: '/tmp/x', maxRecordBytes: 1}), hasConfigCode('OUTBOX_MAX_RECORD_INVALID'));
});

test('file outbox writes one atomic 0600 canonical record', {timeout: 10000}, async t => {
  const dir = await tempDir(t);
  const outbox = createFileOutboxNotificationAdapter({dir});
  const input = request();
  const result = await outbox.send(input);
  // A local outbox write is local acceptance only: never a claim of remote delivery.
  assert.deepEqual([result.outcome, result.code, result.detail?.classification],
    ['unknown', 'outbox-written', 'local-only']);
  assert.deepEqual(await readdir(dir), ['delivery-1.json']);
  const path = join(dir, 'delivery-1.json');
  const stats = await stat(path);
  assert.equal(stats.mode & 0o777, 0o600, 'record is created 0600');
  const content = await readFile(path, 'utf8');
  const record = JSON.parse(content) as Record<string, unknown>;
  assert.deepEqual(record, {
    deliveryId: 'delivery-1',
    target: 'test',
    title: '季度提醒',
    text: '报告已完成',
    payloadHash: outboxPayloadHash(input),
    outcome: 'delivered',
    code: 'outbox-written',
    writtenAt: record.writtenAt,
  });
  assert.equal(typeof record.writtenAt, 'number');
  assert.equal((await realpath(dir)) !== '', true);
  const observed = await readOutboxRecord(dir, 'delivery-1');
  assert.equal(observed?.payloadHash, outboxPayloadHash(input));
});

test('file outbox replays the same payload after restart without a duplicate record', {timeout: 10000}, async t => {
  const dir = await tempDir(t);
  const outbox = createFileOutboxNotificationAdapter({dir});
  const input = request();
  const first = await outbox.send(input);
  const second = await outbox.send(input);
  assert.deepEqual(second, first);
  assert.deepEqual(await readdir(dir), ['delivery-1.json']);
  const before = await readFile(join(dir, 'delivery-1.json'), 'utf8');

  // Restart: a fresh adapter reads the committed record instead of appending another one.
  const reopened = createFileOutboxNotificationAdapter({dir});
  assert.deepEqual(await reopened.send(input), first);
  assert.deepEqual(await readdir(dir), ['delivery-1.json']);
  assert.equal(await readFile(join(dir, 'delivery-1.json'), 'utf8'), before);
});

test('file outbox rejects a different payload for the same delivery deterministically', {timeout: 10000}, async t => {
  const dir = await tempDir(t);
  const outbox = createFileOutboxNotificationAdapter({dir});
  await outbox.send(request({text: '第一版内容'}));
  const before = await readFile(join(dir, 'delivery-1.json'), 'utf8');
  const conflict = await outbox.send(request({text: '第二版内容'}));
  assert.deepEqual([conflict.outcome, conflict.code], ['failed', 'outbox-conflict']);
  assert.equal(await readFile(join(dir, 'delivery-1.json'), 'utf8'), before, 'the first record is never overwritten');
  assert.deepEqual(await readdir(dir), ['delivery-1.json']);
  const observed = await readOutboxRecord(dir, 'delivery-1');
  assert.equal(observed?.text, '第一版内容');
});

test('concurrent file outbox sends converge on one record', {timeout: 15000}, async t => {
  const dir = await tempDir(t);
  const first = createFileOutboxNotificationAdapter({dir});
  const second = createFileOutboxNotificationAdapter({dir});
  const outcomes = await Promise.all(
    Array.from({length: 10}, (_, index) => (index % 2 === 0 ? first : second).send(request())),
  );
  assert.ok(outcomes.every(result => result.outcome === 'unknown' && result.code === 'outbox-written'));
  assert.deepEqual(await readdir(dir), ['delivery-1.json']);
  assert.equal((await readOutboxRecord(dir, 'delivery-1'))?.deliveryId, 'delivery-1');
});

test('corrupt, oversized and symlinked outbox records fail closed without touching evidence', {timeout: 15000}, async t => {
  const dir = await tempDir(t);
  const outbox = createFileOutboxNotificationAdapter({dir});
  const recordPath = outboxRecordPath(dir, 'delivery-1');

  await writeFile(recordPath, 'not-json', 'utf8');
  assert.deepEqual(await outbox.send(request()), {
    outcome: 'failed', code: 'outbox-corrupt', detail: {classification: 'client'},
  });
  assert.equal(await readFile(recordPath, 'utf8'), 'not-json');
  await assert.rejects(readOutboxRecord(dir, 'delivery-1'),
    (error: unknown) => error instanceof OutboxError && error.code === 'OUTBOX_CORRUPT');

  const bounded = createFileOutboxNotificationAdapter({dir, maxRecordBytes: 1024});
  assert.deepEqual((await bounded.send(request({text: 'x'.repeat(2000)}))).code, 'outbox-too-large');

  const victim = join(dirname(dir), `${basename(dir)}-victim.txt`);
  t.after(() => rm(victim, {force: true}));
  await writeFile(victim, 'outside-evidence', 'utf8');
  await rm(recordPath, {force: true});
  await symlink(victim, recordPath);
  assert.deepEqual((await outbox.send(request())).code, 'outbox-corrupt');
  assert.equal(await readFile(victim, 'utf8'), 'outside-evidence', 'a symlink target is never written or followed');
});

test('file outbox refuses path-like delivery ids and never writes outside its directory', {timeout: 10000}, async t => {
  const dir = await tempDir(t);
  const outbox = createFileOutboxNotificationAdapter({dir});
  for (const deliveryId of ['../escape', 'a/b', '.', '..']) {
    assert.deepEqual((await outbox.send(request({deliveryId}))).code, 'outbox-invalid-request', deliveryId);
  }
  assert.deepEqual(await readdir(dir), []);
  await assert.rejects(async () => outboxRecordPath(dir, '../escape'),
    (error: unknown) => error instanceof OutboxError && error.code === 'OUTBOX_INVALID_DELIVERY_ID');
});

test('observe helpers distinguish a missing record from a valid one', {timeout: 10000}, async t => {
  const dir = await tempDir(t);
  assert.equal(await readOutboxRecord(dir, 'delivery-1'), undefined);
  assert.equal(outboxRecordPath(dir, 'delivery-1'), join(dir, 'delivery-1.json'));
  const outbox = createFileOutboxNotificationAdapter({dir});
  await outbox.send(request());
  assert.equal((await readOutboxRecord(dir, 'delivery-1'))?.outcome, 'delivered');
});
