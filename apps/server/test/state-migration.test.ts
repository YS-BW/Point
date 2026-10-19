import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat, copyFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry, defineDocFamily, type Cursor, type JsonObject } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openRuntime } from '../src/runtime/open.js';
import { migrateRuntime, MigrationError } from '../src/runtime/migrate.js';
import { Meta } from '../src/storage/meta.js';
import {
  ChatsIndex, Events, JobsIndex, Memory, MetaV2, RequestsIndex, ResourcesIndex,
  type StateMetaV2,
} from '../src/storage/state.js';
import { Attempts, Jobs } from '../src/storage/job.js';
import { Deliveries } from '../src/storage/delivery.js';
import { Profile, ProfileReceipts } from '../src/storage/profile.js';
import { Schedules } from '../src/storage/schedule.js';
import { Artifacts } from '../src/storage/artifact.js';
import { CreateChatReceipts } from '../src/storage/chats.js';
import {
  ResourceOperations, Resources, type ResourceOperationDocument, type ResourceDocument,
} from '../src/storage/resource.js';

const LegacyChatV1 = defineDocFamily({
  kind: 'point.chat', version: 1, scope: 'session', family: true,
  initial: (chat: Readonly<{id: string; name: string; createdAt: number}>) => ({...chat}),
});
const LegacyJobV1 = defineDocFamily({
  kind: 'point.job', version: 1, scope: 'session', family: true,
  initial: (job: JsonObject) => ({...job}),
});
const LegacyDeliveryV1 = defineDocFamily({
  kind: 'point.delivery', version: 1, scope: 'session', family: true,
  initial: (delivery: JsonObject) => ({...delivery}),
});

async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'point-migration-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

async function harnessAt(dir: string): Promise<Harness> {
  return Harness.open(await openNodeSqliteStorage(join(dir, 'state.sqlite')),
    {models: createModels(), registry: createRegistry()}, context);
}

/** Build a representative pre-WP3 (v1) database: entities, receipts, profile map, unresolved resource. */
async function v1Fixture(dir: string, instanceId = 'legacy-instance'): Promise<void> {
  const harness = await harnessAt(dir);
  try {
    await harness.commit(async tx => {
      const meta = await tx.doc(Meta);
      meta.instanceId = instanceId;
      await tx.doc(LegacyChatV1, '2', {id: '2', name: 'v1 聊天', createdAt: 11});
      const profile = await tx.doc(Profile);
      profile.entries = {
        tone: {key: 'tone', value: '简洁', kind: 'preference', sourceChatId: '2', updatedAt: 12},
        goal: {key: 'goal', value: '发布', kind: 'fact', sourceChatId: '2', updatedAt: 13},
      };
      await tx.doc(ProfileReceipts, 'profile-1', 'fp');
      const createReceipt = await tx.doc(CreateChatReceipts, 'chat-create-1', 'v1 聊天');
      createReceipt.result = {id: '2', name: 'v1 聊天', createdAt: 11};
      await tx.doc(LegacyJobV1, 'job-1', {
        id: 'job-1', title: '旧任务', prompt: '做', requirements: [], revision: 1, status: 'ready',
        sourceChatId: '2', executionChatId: '9', currentAttemptId: 'job-1-1',
        result: '完成', artifactId: 'job-1-1:call-1', error: null, createdAt: 20, updatedAt: 21,
      });
      await tx.doc(Attempts, 'job-1-1', {
        id: 'job-1-1', jobId: 'job-1', revision: 1, status: 'completed', taskId: '5',
        conversationId: '9', artifactId: 'job-1-1:call-1', result: '完成', error: null,
        startedAt: 20, endedAt: 21,
      });
      await tx.doc(LegacyDeliveryV1, 'delivery-1', {
        id: 'delivery-1', jobId: 'job-1', scheduleId: 'schedule-1', occurrenceIds: ['schedule-1-o0'],
        revision: 1, channel: 'notification', status: 'unknown', attempts: 1, result: null,
        error: 'interrupted', attemptToken: 'token-1', workerId: '7', attemptStartedAt: 22, deadline: 23,
        createdAt: 22, updatedAt: 23,
      });
      await tx.doc(Schedules, 'schedule-1', {
        id: 'schedule-1', jobId: 'job-1', revision: 1, sourceChatId: '2', status: 'active',
        occurrenceIds: ['schedule-1-o0'], createdAt: 24, updatedAt: 24,
      });
      await tx.doc(Artifacts, 'job-1-1:call-1', {
        id: 'job-1-1:call-1', jobId: 'job-1', attemptId: 'job-1-1', revision: 1, name: 'r.md',
        path: join(dir, 'workspace', 'jobs', 'job-1', 'job-1-1', 'r.md'),
        sha256: 'a'.repeat(64), bytes: 3, state: 'sealed', createdAt: 25, sealedAt: 26,
      });
      await tx.doc(Resources, 'browser:primary', {
        present: true,
        value: {id: 'browser:primary', owner: 'owner-a', lease: {owner: 'owner-a', expiresAt: 1_000, epoch: 1},
          controlEpoch: 1, revision: 2, state: 'leased'},
      } satisfies ResourceDocument);
      await tx.doc(ResourceOperations, 'op-1', {
        present: true,
        value: {
          id: 'op-1', requestId: 'req-1', resourceId: 'browser:primary', controlEpoch: 1,
          state: 'unknown', revision: 2, fingerprint: 'fp', result: null, observation: 'disconnected',
          owner: 'owner-a', effect: {kind: 'browser.navigate', payload: {url: 'https://example.com'}, payloadHash: 'h'},
          attemptToken: 'tok', attemptStartedAt: 30, deadline: 40, evidence: null, observer: null,
        },
      } satisfies ResourceOperationDocument);
    }, context);
  } finally { await harness.close(context); }
}

async function scanStored(dir: string, kind: string): Promise<Array<{key: string; value: Readonly<Record<string, unknown>>}>> {
  const storage = await openNodeSqliteStorage(join(dir, 'state.sqlite'));
  try {
    const items: Array<{key: string; value: Readonly<Record<string, unknown>>}> = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await storage.scanDocuments({scope: {kind: 'session'}, at: 'current', kind}, 100, cursor, context);
      for (const record of page.items) {
        const document = await storage.document(record.id, 'current', context);
        if (document !== undefined && document.record.key !== undefined) {
          items.push({key: document.record.key, value: document.value});
        }
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return items;
  } finally { await storage.close(context); }
}

async function inspect<T>(dir: string, fn: (harness: Harness) => Promise<T>): Promise<T> {
  const harness = await harnessAt(dir);
  try { return await fn(harness); } finally { await harness.close(context); }
}

async function formatOf(dir: string): Promise<number | undefined> {
  return inspect(dir, async harness => {
    const v2 = await harness.snapshot(MetaV2, context) as StateMetaV2 | undefined;
    if (v2 !== undefined) return v2.format;
    return (await harness.snapshot(Meta, context))?.format;
  });
}

function sdkTableCounts(dir: string): Record<string, number> {
  const db = new DatabaseSync(join(dir, 'state.sqlite'), {readOnly: true});
  try {
    const counts: Record<string, number> = {};
    for (const table of ['conversations', 'entries', 'tasks', 'submissions']) {
      const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n: number};
      counts[table] = row.n;
    }
    return counts;
  } finally { db.close(); }
}

test('v1 -> v2 migration is one commit, backs up online and preserves product semantics', {timeout: 30000}, async t => {
  const dir = await directory(t);
  await v1Fixture(dir);
  const sdkBefore = sdkTableCounts(dir);
  const result = await migrateRuntime(dir);
  assert.equal(result.status, 'migrated');
  if (result.status !== 'migrated') return;
  assert.ok(result.backupPath.endsWith('.sqlite'));
  assert.ok(result.backupBytes > 0);
  assert.deepEqual([result.counts.chats, result.counts.jobs, result.counts.attempts, result.counts.memory],
    [1, 1, 1, 2]);
  // The backup is a self-contained SQLite snapshot of the format-1 database, no WAL sidecars.
  assert.deepEqual((await readdir(join(dir, 'backups'))).length, 1);
  assert.equal((await readdir(join(dir, 'backups')))[0]?.endsWith('.sqlite'), true);

  await inspect(dir, async harness => {
    const meta = await harness.snapshot(MetaV2, context) as StateMetaV2;
    assert.deepEqual([meta.format, meta.instanceId], [2, 'legacy-instance']);
    assert.ok(meta.migratedAt > 0);
    assert.equal(await harness.snapshot(Meta, context), undefined, 'legacy metadata is retired in the same commit');
    assert.equal(await harness.snapshot(Profile, context), undefined, 'legacy profile map is retired');
    assert.deepEqual((await harness.snapshot(ChatsIndex, '2', context))?.name, 'v1 聊天');
    assert.deepEqual([(await harness.snapshot(JobsIndex, 'job-1', context))?.status], ['ready']);
    assert.equal((await harness.snapshot(Memory, 'tone', context))?.value, '简洁');
    assert.equal((await harness.snapshot(Memory, 'goal', context))?.revision, 1);
    assert.equal((await harness.snapshot(ResourcesIndex, 'browser:primary', context))?.state, 'leased');
    assert.equal((await harness.snapshot(RequestsIndex, 'point.command.chat-create:chat-create-1', context))?.terminal, false);
    const storedEvents = await scanStored(join(dir), 'point.event');
    assert.equal(storedEvents.length, 1, 'migration appends exactly one bounded state.migrated event');
    assert.equal(storedEvents[0]?.value.type, 'state.migrated');
    assert.equal((await harness.snapshot(Events, storedEvents[0]!.key, context))?.data?.['chats'], 1);
    // Unresolved records survive unchanged and are never replayed.
    const delivery = await harness.snapshot(Deliveries, 'delivery-1', context);
    assert.deepEqual([delivery?.status, delivery?.error], ['unknown', 'interrupted']);
    const operation = await harness.snapshot(ResourceOperations, 'op-1', context);
    assert.deepEqual([operation?.present, operation?.value?.state], [true, 'unknown']);
    const schedule = await harness.snapshot(Schedules, 'schedule-1', context);
    assert.equal(schedule?.status, 'active');
  });

  // Public queries still return the pre-migration values.
  const runtime = await openRuntime(dir);
  try {
    assert.equal((await runtime.chats.get('2'))?.name, 'v1 聊天');
    assert.equal((await runtime.jobs.get('job-1'))?.title, '旧任务');
    assert.deepEqual((await runtime.profile.list()).map(entry => [entry.key, entry.value]), [['goal', '发布'], ['tone', '简洁']]);
  } finally { await runtime.close(); }

  // SDK-owned history tables are never rewritten by a product-state migration.
  assert.deepEqual(sdkTableCounts(dir), sdkBefore);
  // The migration is a single Durable commit: every written v2 document shares one revision seq.
  const raw = new DatabaseSync(join(dir, 'state.sqlite'), {readOnly: true});
  try {
    const rows = raw.prepare(`SELECT DISTINCT r.seq AS seq FROM document_revisions r
      JOIN documents d ON d.id = r.document_id
      WHERE d.kind IN ('"point.meta"', '"point.chats"', '"point.jobs"', '"point.memory"',
        '"point.requests"', '"point.event"', '"point.resources"', '"point.chat"', '"point.job"')`).all() as Array<{seq: number}>;
    assert.equal(rows.length, 1, `migration must be one commit, saw seqs ${rows.map(row => row.seq).join(',')}`);
  } finally { raw.close(); }

  // Re-running is an idempotent no-op and creates no second backup.
  const again = await migrateRuntime(dir);
  assert.deepEqual(again, {status: 'already-migrated', instanceId: 'legacy-instance'});
  assert.equal((await readdir(join(dir, 'backups'))).length, 1);
  assert.equal(await formatOf(dir), 2);
});
test('a failed pre-commit step rolls the whole migration back and can be retried', {timeout: 30000}, async t => {
  const dir = await directory(t);
  await v1Fixture(dir);
  await assert.rejects(migrateRuntime(dir, {beforeCommit: () => { throw new Error('injected'); }}),
    (error: unknown) => error instanceof MigrationError && error.code === 'MIGRATION_FAILED');
  assert.equal(await formatOf(dir), 1);
  await inspect(dir, async harness => {
    assert.equal(await harness.snapshot(MetaV2, context), undefined);
    assert.equal(await harness.snapshot(ChatsIndex, '2', context), undefined);
    assert.equal(await harness.snapshot(Memory, 'tone', context), undefined);
  });
  const retried = await migrateRuntime(dir);
  assert.equal(retried.status, 'migrated');
});

test('a backup failure aborts before any rewrite and leaves format 1', {timeout: 30000}, async t => {
  const dir = await directory(t);
  await v1Fixture(dir);
  const blocker = join(dir, 'not-a-directory');
  await writeFile(blocker, 'x', 'utf8');
  await assert.rejects(migrateRuntime(dir, {backupDir: join(blocker, 'backups')}),
    (error: unknown) => error instanceof MigrationError && error.code === 'MIGRATION_BACKUP_FAILED');
  assert.equal(await formatOf(dir), 1);
  await inspect(dir, async harness => {
    assert.equal(await harness.snapshot(MetaV2, context), undefined);
    assert.equal(await harness.snapshot(ChatsIndex, '2', context), undefined);
  });
});

test('a pre-v2 snapshot starts read-only and can be migrated explicitly', {timeout: 30000}, async t => {
  const dir = await directory(t);
  await v1Fixture(dir);
  const reader = await openRuntime(dir, undefined, {mode: 'read-only'});
  try {
    assert.equal(reader.readOnly, true);
    assert.equal((await reader.chats.get('2'))?.name, 'v1 聊天');
    assert.deepEqual((await reader.profile.list()).map(entry => entry.key), ['goal', 'tone']);
    await assert.rejects(reader.chats.create({requestId: 'blocked', name: 'nope'}), /READ_ONLY/);
  } finally { await reader.close(); }
  assert.equal(await formatOf(dir), 1);
  assert.equal((await migrateRuntime(dir)).status, 'migrated');
});

test('a restored pre-migration backup returns to a working format-1 database', {timeout: 30000}, async t => {
  const dir = await directory(t);
  await v1Fixture(dir);
  const migrated = await migrateRuntime(dir);
  assert.equal(migrated.status, 'migrated');
  if (migrated.status !== 'migrated') return;
  await rm(join(dir, 'state.sqlite'), {force: true});
  await rm(join(dir, 'state.sqlite-wal'), {force: true});
  await rm(join(dir, 'state.sqlite-shm'), {force: true});
  await copyFile(migrated.backupPath, join(dir, 'state.sqlite'));
  assert.equal(await formatOf(dir), 1);
  const reader = await openRuntime(dir, undefined, {mode: 'read-only'});
  try {
    assert.equal((await reader.chats.get('2'))?.name, 'v1 聊天');
  } finally { await reader.close(); }
  await assert.rejects(openRuntime(dir), /MIGRATION_REQUIRED/);
  // The restored v1 database can be migrated again.
  assert.equal((await migrateRuntime(dir)).status, 'migrated');
});

test('SIGKILL before and after the migration commit is safely re-runnable', {timeout: 60000}, async t => {
  for (const mode of ['before', 'after'] as const) {
    const dir = await directory(t);
    await v1Fixture(dir);
    const script = `
      import { migrateRuntime } from ${JSON.stringify(new URL('../src/runtime/migrate.js', import.meta.url).href)};
      await migrateRuntime(process.argv[1], ${mode === 'before'
        ? "{beforeCommit: () => { process.kill(process.pid, 'SIGKILL'); }}"
        : "{afterCommit: () => { process.kill(process.pid, 'SIGKILL'); }}"});
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], {stdio: 'ignore'});
    t.after(() => { child.kill('SIGKILL'); });
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    if (mode === 'before') {
      assert.equal(await formatOf(dir), 1, 'a kill before the commit leaves format 1');
      assert.equal((await migrateRuntime(dir)).status, 'migrated');
    } else {
      assert.equal(await formatOf(dir), 2, 'a kill after the commit leaves format 2');
      const again = await migrateRuntime(dir);
      assert.equal(again.status, 'already-migrated');
      const backups = await readdir(join(dir, 'backups'));
      assert.equal(backups.length, 1, 'already-migrated never creates another backup');
    }
  }
});

test('migration rejects a v2 metadata with a mismatched engine instead of already-migrated', {timeout: 20000}, async t => {
  const dir = await directory(t);
  const runtime = await openRuntime(dir);
  await runtime.close();
  await inspect(dir, async harness => {
    await harness.commit(async tx => { (await tx.doc(MetaV2)).engine = 'pi-durable@0.0.0'; }, context);
  });
  await assert.rejects(migrateRuntime(dir),
    (error: unknown) => error instanceof MigrationError && error.code === 'MIGRATION_INCOMPATIBLE');
  await inspect(dir, async harness => {
    assert.equal((await harness.snapshot(MetaV2, context))?.engine, 'pi-durable@0.0.0');
  });
});

test('migration refuses an unknown/higher product format without writing', {timeout: 20000}, async t => {
  const dir = await directory(t);
  const runtime = await openRuntime(dir);
  await runtime.close();
  await inspect(dir, async harness => {
    await harness.commit(async tx => { (await tx.doc(MetaV2)).format = 3; }, context);
  });
  await assert.rejects(migrateRuntime(dir),
    (error: unknown) => error instanceof MigrationError && error.code === 'MIGRATION_INCOMPATIBLE');
  assert.equal(await formatOf(dir), 3);
});
