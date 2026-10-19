import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  createRegistry, Harness, MemoryStorage, type ConversationId, type TaskId,
} from '@earendil-works/pi-durable';
import {
  initialDelivery, type Delivery,
} from '../src/domain/delivery.js';
import type { Job } from '../src/domain/job.js';
import { Deliveries } from '../src/storage/delivery.js';
import { Jobs } from '../src/storage/job.js';
import { memoryNotificationAdapter } from '../src/adapters/notification/memory.js';
import { deliveryRuntime } from '../src/runtime/deliveries.js';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1', title: '季度报告', prompt: '写报告', requirements: [], revision: 1, status: 'ready',
    sourceChatId: '2', executionChatId: '9', currentAttemptId: 'job-1-1',
    result: '报告结果文本', artifactId: 'artifact-1', error: null, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

function notificationDelivery(overrides: Partial<Delivery> = {}): Delivery {
  const base = initialDelivery({
    id: 'notify-1', jobId: 'job-1', scheduleId: 'schedule-1', occurrenceIds: ['schedule-1-o0'],
    revision: 1, channel: 'notification', createdAt: 1,
  });
  return {...base, ...overrides};
}

type Adapter = ReturnType<typeof memoryNotificationAdapter>;

async function fixture(t: TestContext, options: {
  job?: Job;
  delivery?: Delivery;
  adapter?: Adapter;
  withNotification?: boolean;
} = {}) {
  const adapter = options.adapter ?? memoryNotificationAdapter('delivered');
  let harness!: Harness;
  const runtime = deliveryRuntime({
    getHarness: () => harness,
    ...(options.withNotification === false ? {} : {notification: adapter.port}),
  });
  const registry = createRegistry();
  registry.install(runtime.extension);
  harness = await Harness.open(new MemoryStorage(), {models: createModels(), registry}, context);
  t.after(() => harness.close(context));
  const conversation = await harness.createConversation({ownership: {kind: 'ownerless'}}, context);
  const sourceChatId = Number(conversation.id);
  const seedJob = {...(options.job ?? job()), sourceChatId: String(sourceChatId)};
  const seedDelivery = options.delivery ?? notificationDelivery();
  await harness.commit(async tx => {
    await tx.doc(Jobs, seedJob.id, seedJob);
    await tx.doc(Deliveries, seedDelivery.id, seedDelivery);
  }, context);
  const run = async (deliveryId: string) => {
    const taskId = await harness.commit(tx => tx.createTask(runtime.NotifyTask, {deliveryId}, {
      conversationId: sourceChatId as ConversationId, ownership: {kind: 'conversation'}, background: true,
    }), context) as TaskId;
    harness.resume();
    await harness.waitForTask(taskId, context);
  };
  return {harness, runtime, adapter, sourceChatId, seedJob, seedDelivery, run};
}

async function stored(harness: Harness, id = 'notify-1') {
  return harness.snapshot(Deliveries, id, context);
}

/* -------------------------------------------------------------------------- */
/* Scripted notification adapter                                               */
/* -------------------------------------------------------------------------- */

test('the memory notification adapter is scripted, ordered and records every call', async () => {
  const delivered = memoryNotificationAdapter('delivered');
  assert.equal(await delivered.port.send({deliveryId: 'd1', target: 'test', title: 't', text: 'x'}), 'delivered');
  assert.deepEqual(delivered.calls, [{deliveryId: 'd1', target: 'test', title: 't', text: 'x'}]);

  const scripted = memoryNotificationAdapter(['failed', 'unknown']);
  assert.equal(await scripted.port.send({deliveryId: 'd1', target: 'test', title: 't', text: 'x'}), 'failed');
  assert.equal(await scripted.port.send({deliveryId: 'd2', target: 'test', title: 't', text: 'x'}), 'unknown');
  await assert.rejects(scripted.port.send({deliveryId: 'd3', target: 'test', title: 't', text: 'x'}),
    /NOTIFICATION_SCRIPT_EXHAUSTED/);
  assert.equal(scripted.calls.length, 2, 'exhausted scripts never record a call');

  const throwing = memoryNotificationAdapter('throw');
  await assert.rejects(throwing.port.send({deliveryId: 'd1', target: 'test', title: 't', text: 'x'}),
    /NOTIFICATION_SCRIPTED_THROW/);

  const functional = memoryNotificationAdapter(request => request.deliveryId === 'ok' ? 'delivered' : 'failed');
  assert.equal(await functional.port.send({deliveryId: 'ok', target: 'test', title: 't', text: 'x'}), 'delivered');
  assert.equal(await functional.port.send({deliveryId: 'no', target: 'test', title: 't', text: 'x'}), 'failed');
});

/* -------------------------------------------------------------------------- */
/* Notify task: three outcomes, no fake success, no resend                     */
/* -------------------------------------------------------------------------- */

test('a delivered notification completes the delivery and sends exactly once', {timeout: 15000}, async t => {
  const f = await fixture(t, {adapter: memoryNotificationAdapter('delivered')});
  await f.run('notify-1');
  const record = await stored(f.harness);
  assert.deepEqual([record?.status, record?.attempts, record?.result], ['done', 1, 'delivered']);
  assert.equal(f.adapter.calls.length, 1);
  const request = f.adapter.calls[0]!;
  assert.equal(request.deliveryId, 'notify-1');
  assert.equal(request.target, 'test');
  assert.equal(request.title, '季度报告');
  for (const fragment of ['季度报告', '报告结果文本', 'artifact-1']) assert.ok(request.text.includes(fragment), fragment);
});

test('a failed notification marks the delivery failed and touches nothing else', {timeout: 15000}, async t => {
  const f = await fixture(t, {adapter: memoryNotificationAdapter('failed')});
  const jobBefore = await f.harness.snapshot(Jobs, 'job-1', context);
  await f.run('notify-1');
  const record = await stored(f.harness);
  assert.deepEqual([record?.status, record?.error], ['failed', 'notification-failed']);
  assert.equal(f.adapter.calls.length, 1);
  assert.deepEqual(await f.harness.snapshot(Jobs, 'job-1', context), jobBefore, 'notification failure never changes the Job');
});

test('an unknown notification is never auto-resent', {timeout: 15000}, async t => {
  const f = await fixture(t, {adapter: memoryNotificationAdapter('unknown')});
  await f.run('notify-1');
  const record = await stored(f.harness);
  assert.deepEqual([record?.status, record?.error], ['unknown', 'notification-unknown']);
  assert.equal(f.adapter.calls.length, 1);
  // A second execution of the same delivery is terminal: no resend and no state change.
  await f.run('notify-1');
  assert.equal(f.adapter.calls.length, 1, 'unknown is never replayed');
  assert.deepEqual(await stored(f.harness), record);
});

test('a thrown notification is recorded as unknown, not as a success', {timeout: 15000}, async t => {
  const f = await fixture(t, {adapter: memoryNotificationAdapter('throw')});
  await f.run('notify-1');
  const record = await stored(f.harness);
  assert.deepEqual([record?.status, record?.error], ['unknown', 'notification-unknown']);
  assert.equal(f.adapter.calls.length, 1);
});

test('a repeated notify execution of a done delivery is idempotent', {timeout: 15000}, async t => {
  const f = await fixture(t, {adapter: memoryNotificationAdapter('delivered')});
  await f.run('notify-1');
  await f.run('notify-1');
  assert.equal(f.adapter.calls.length, 1, 'a done delivery is never sent twice');
  assert.equal((await stored(f.harness))?.status, 'done');
});

test('an interrupted attempting delivery becomes unknown without sending', {timeout: 15000}, async t => {
  const f = await fixture(t, {
    delivery: notificationDelivery({status: 'attempting', attempts: 1}),
    adapter: memoryNotificationAdapter('delivered'),
  });
  await f.run('notify-1');
  const record = await stored(f.harness);
  assert.deepEqual([record?.status, record?.error], ['unknown', 'interrupted']);
  assert.equal(f.adapter.calls.length, 0, 'the crash window is never retried');
});

test('without a notification port the delivery fails closed and sends nothing', {timeout: 15000}, async t => {
  const f = await fixture(t, {withNotification: false});
  await f.run('notify-1');
  const record = await stored(f.harness);
  assert.deepEqual([record?.status, record?.error], ['failed', 'NOTIFICATION_NOT_CONFIGURED']);
});

test('a stale or cancelled job fails the notification without sending', {timeout: 15000}, async t => {
  for (const jobOverride of [{revision: 2}, {status: 'cancelled' as const}]) {
    const adapter = memoryNotificationAdapter('delivered');
    const f = await fixture(t, {adapter, job: job(jobOverride)});
    await f.run('notify-1');
    const record = await stored(f.harness);
    assert.deepEqual([record?.status, record?.error], ['failed', 'job-not-current']);
    assert.equal(adapter.calls.length, 0);
  }
});

test('a notification for a non-ready job fails as job-not-ready without sending', {timeout: 15000}, async t => {
  const f = await fixture(t, {job: job({status: 'running'}), adapter: memoryNotificationAdapter('delivered')});
  await f.run('notify-1');
  const record = await stored(f.harness);
  assert.deepEqual([record?.status, record?.error], ['failed', 'job-not-ready']);
  assert.equal(f.adapter.calls.length, 0, 'a non-ready job never reaches the notification channel');
});

test('a repeated notify for a failed delivery does not retry it', {timeout: 15000}, async t => {
  const f = await fixture(t, {adapter: memoryNotificationAdapter(['failed', 'delivered'])});
  await f.run('notify-1');
  assert.equal((await stored(f.harness))?.status, 'failed');
  await f.run('notify-1');
  assert.equal(f.adapter.calls.length, 1, 'failed is terminal in this slice; no retry command exists');
});
