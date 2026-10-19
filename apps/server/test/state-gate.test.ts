import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineDocFamily, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openRuntime } from '../src/runtime/open.js';
import { Meta } from '../src/storage/meta.js';
import { MetaV2, PRODUCT_STATE_ENGINE, type StateMetaV2 } from '../src/storage/state.js';
import { Chats } from '../src/storage/chats.js';

/** The pre-v2 chat token, used only to build v1 fixture databases. */
const LegacyChatV1 = defineDocFamily({
  kind: 'point.chat', version: 1, scope: 'session', family: true,
  initial: (chat: Readonly<{id: string; name: string; createdAt: number}>) => ({...chat}),
});

const disposers = new WeakMap<TestContext, (() => unknown | Promise<unknown>)[]>();
function cleanup(t: TestContext, dispose: () => unknown | Promise<unknown>) {
  let stack = disposers.get(t);
  if (!stack) {
    stack = []; disposers.set(t, stack);
    t.after(async () => {
      for (const release of [...(disposers.get(t) ?? [])].reverse()) await release();
    });
  }
  stack.push(dispose);
}

async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'point-state-gate-'));
  cleanup(t, () => rm(dir, {recursive: true, force: true}));
  return dir;
}

async function edit(dir: string, fn: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, 'state.sqlite')), {models: createModels(), registry: createRegistry()}, context);
  try { await fn(harness); } finally { await harness.close(context); }
}

/** A v1 database: legacy meta plus a legacy chat entity, exactly the pre-WP3 shape. */
async function v1Fixture(dir: string, instanceId = 'legacy-instance'): Promise<void> {
  await edit(dir, async harness => {
    await harness.commit(async tx => {
      const meta = await tx.doc(Meta);
      meta.instanceId = instanceId;
      await tx.doc(LegacyChatV1, '2', {id: '2', name: 'v1 聊天', createdAt: 7});
    }, context);
  });
}

test('a fresh database is created directly as state format 2', async t => {
  const dir = await directory(t);
  const runtime = await openRuntime(dir);
  try {
    assert.equal(runtime.readOnly, false);
    assert.ok(runtime.instanceId.length > 0);
    const chat = await runtime.chats.create({requestId: 'c1', name: 'v2 聊天'});
    assert.equal(chat.name, 'v2 聊天');
  } finally { await runtime.close(); }
  await edit(dir, async harness => {
    const meta = await harness.snapshot(MetaV2, context) as StateMetaV2 | undefined;
    assert.equal(meta?.format, 2);
    assert.equal(meta?.engine, PRODUCT_STATE_ENGINE);
    assert.equal(meta?.migratedAt, 0);
    assert.ok(meta && meta.instanceId.length > 0);
    // No legacy metadata was written; the v2 singleton is the only product-format authority.
    assert.equal(await harness.snapshot(Meta, context), undefined);
  });
});

test('a v1 database is refused for writes without migration and stays format 1', async t => {
  const dir = await directory(t);
  await v1Fixture(dir);
  await assert.rejects(openRuntime(dir), /MIGRATION_REQUIRED/);
  // The refused open did not rewrite the format.
  await edit(dir, async harness => {
    assert.equal((await harness.snapshot(Meta, context))?.format, 1);
    assert.equal(await harness.snapshot(MetaV2, context), undefined);
    assert.equal((await harness.snapshot(Chats, '2', context))?.name, 'v1 聊天');
  });
});

test('a v1 database opens read-only, serves queries and refuses product writes', async t => {
  const dir = await directory(t);
  await v1Fixture(dir, 'legacy-read-only');
  const runtime = await openRuntime(dir, undefined, {mode: 'read-only'});
  try {
    assert.equal(runtime.readOnly, true);
    assert.equal(runtime.instanceId, 'legacy-read-only');
    assert.equal((await runtime.chats.get('2'))?.name, 'v1 聊天');
    await assert.rejects(runtime.chats.create({requestId: 'nope', name: 'should fail'}), /READ_ONLY/);
    assert.equal((await runtime.chats.get('2'))?.name, 'v1 聊天');
  } finally { await runtime.close(); }
  // Nothing was migrated by a read-only open.
  await edit(dir, async harness => {
    assert.equal((await harness.snapshot(Meta, context))?.format, 1);
    assert.equal(await harness.snapshot(MetaV2, context), undefined);
  });
});

test('a newer or unknown v2 format is refused without rewriting the metadata', async t => {
  for (const format of [3, 0]) {
    const dir = await directory(t);
    const runtime = await openRuntime(dir);
    await runtime.close();
    await edit(dir, async harness => {
      await harness.commit(async tx => { (await tx.doc(MetaV2)).format = format; }, context);
    });
    await assert.rejects(openRuntime(dir), /UNSUPPORTED_DATA_FORMAT/);
    await edit(dir, async harness => {
      assert.equal((await harness.snapshot(MetaV2, context))?.format, format);
    });
  }
});

test('a v2 database with a mismatched engine is refused as unsupported', async t => {
  const dir = await directory(t);
  const runtime = await openRuntime(dir);
  await runtime.close();
  await edit(dir, async harness => {
    await harness.commit(async tx => { (await tx.doc(MetaV2)).engine = 'pi-durable@0.0.0'; }, context);
  });
  await assert.rejects(openRuntime(dir), /UNSUPPORTED_DATA_FORMAT/);
});

test('a half-migrated database with both metadata kinds is refused as ambiguous', async t => {
  const dir = await directory(t);
  const runtime = await openRuntime(dir);
  await runtime.close();
  await edit(dir, async harness => {
    await harness.commit(async tx => {
      const legacy = await tx.doc(Meta);
      legacy.instanceId = 'legacy';
    }, context);
  });
  await assert.rejects(openRuntime(dir), /UNRECOGNIZED_DATA/);
});

test('a legacy metadata with an unknown format is unsupported, not migrated', async t => {
  const dir = await directory(t);
  await edit(dir, async harness => {
    await harness.commit(async tx => {
      const meta = await tx.doc(Meta);
      meta.format = 2;
      meta.instanceId = 'legacy';
    }, context);
  });
  await assert.rejects(openRuntime(dir), /UNSUPPORTED_DATA_FORMAT/);
  await assert.rejects(openRuntime(dir, undefined, {mode: 'read-only'}), /UNSUPPORTED_DATA_FORMAT/);
});

test('read-only format 2 opens queries and guards writes', async t => {
  const dir = await directory(t);
  const writer = await openRuntime(dir);
  const chat = await writer.chats.create({requestId: 'c2', name: '已有聊天'});
  await writer.close();
  const reader = await openRuntime(dir, undefined, {mode: 'read-only'});
  try {
    assert.equal(reader.readOnly, true);
    assert.equal((await reader.chats.get(chat.id))?.name, '已有聊天');
    await assert.rejects(reader.chats.create({requestId: 'c3', name: '写'}), /READ_ONLY/);
    await assert.rejects(reader.jobs.start({requestId: 'j1', title: 't', prompt: 'p', sourceChatId: chat.id}),
      /READ_ONLY|MODEL_NOT_CONFIGURED/);
  } finally { await reader.close(); }
});
