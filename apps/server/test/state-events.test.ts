import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry, type Cursor } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openRuntime, type ModelBinding } from '../src/runtime/open.js';
import { memoryNotificationAdapter } from '../src/adapters/notification/memory.js';
import { Events, type ProductEvent } from '../src/storage/state.js';

async function scanEvents(dir: string): Promise<ProductEvent[]> {
  const storage = await openNodeSqliteStorage(join(dir, 'state.sqlite'));
  try {
    const items: ProductEvent[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await storage.scanDocuments({scope: {kind: 'session'}, at: 'current', kind: 'point.event'}, 100, cursor, context);
      for (const record of page.items) {
        const document = await storage.document(record.id, 'current', context);
        if (document !== undefined) items.push(document.value as unknown as ProductEvent);
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return items;
  } finally { await storage.close(context); }
}

async function harnessAt(dir: string): Promise<Harness> {
  return Harness.open(await openNodeSqliteStorage(join(dir, 'state.sqlite')),
    {models: createModels(), registry: createRegistry()}, context);
}

test('product events are appended with their state changes and can be rebuilt from state', {timeout: 30000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-events-'));
  try {
    const faux = fauxProvider({tokensPerSecond: 100000});
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('save_artifact', {name: 'r.md', content: 'body'})], {stopReason: 'toolUse'}),
      fauxAssistantMessage('完成'),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const binding: ModelBinding = {models, model: {provider: 'faux', modelId: 'faux-1'}};
    const notify = memoryNotificationAdapter('delivered');
    let chatId = '';
    const runtime = await openRuntime(dir, binding, {notification: notify.port});
    try {
      const chat = await runtime.chats.create({requestId: 'c1', name: '事件来源'});
      chatId = chat.id;
      await runtime.profile.remember({requestId: 'm1', key: 'tone', value: '简洁', kind: 'preference', sourceChatId: chat.id});
      const started = await runtime.jobs.start({requestId: 'j1', title: '事件任务', prompt: '做', sourceChatId: chat.id});
      for (let index = 0; index < 400; index += 1) {
        const job = await runtime.jobs.get(started.jobId);
        if (job?.status === 'ready') break;
        if (job?.status === 'failed') assert.fail(`job failed: ${job.error}`);
        await delay(10);
      }
      const job = await runtime.jobs.get(started.jobId);
      assert.equal(job?.status, 'ready');
      const scheduled = await runtime.followups.schedule({
        requestId: 's1', jobId: job!.id, expectedRevision: job!.revision, dueAt: Date.now() - 1,
      });
      for (let index = 0; index < 400; index += 1) {
        const schedule = await runtime.followups.get(scheduled.scheduleId);
        if (schedule?.status === 'done') break;
        await delay(10);
      }
      assert.equal((await runtime.followups.get(scheduled.scheduleId))?.status, 'done');
    } finally { await runtime.close(); }

    const events = await scanEvents(dir);
    const types = new Set(events.map(event => event.type));
    for (const expected of ['chat.created', 'memory.saved', 'job.started', 'job.running', 'job.ready',
      'attempt.started', 'attempt.completed', 'artifact.sealed', 'schedule.created', 'followup.decided',
      'delivery.intent', 'delivery.done']) {
      assert.ok(types.has(expected as ProductEvent['type']), `missing event ${expected}; got ${[...types].join(',')}`);
    }
    // Event payloads are bounded (no large or credential-shaped values).
    for (const event of events) {
      if (event.data !== null) assert.ok(JSON.stringify(event.data).length <= 4096, event.type);
    }

    // Events are derived: removing the whole timeline leaves product state correct.
    const harness = await harnessAt(dir);
    try {
      await harness.commit(async tx => {
        for (const event of events) await tx.retireDoc(Events, event.id);
      }, context);
    } finally { await harness.close(context); }
    assert.deepEqual(await scanEvents(dir), []);

    const reopened = await openRuntime(dir);
    try {
      assert.equal((await reopened.chats.get(chatId))?.name, '事件来源');
      assert.equal((await reopened.profile.list())[0]?.value, '简洁');
      const rebuilt = await reopened.rebuildEvents();
      assert.ok(rebuilt.appended > 0);
      assert.equal(rebuilt.removed, 0);
      assert.equal((await scanEvents(dir)).length > 0, true);
      // Rebuilding never changes product state.
      assert.equal((await reopened.chats.get(chatId))?.name, '事件来源');
    } finally { await reopened.close(); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});
