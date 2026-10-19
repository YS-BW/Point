import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  createRegistry, Harness, MemoryStorage, type ConversationId, type TaskId,
} from '@earendil-works/pi-durable';
import type { NotificationPort, NotificationRequest, NotificationSendResult } from '../src/application/delivery.js';
import {
  DeliveryError, deliveryAttemptState, initialDelivery, parseDelivery, recoverExpiredDeliveryAttempt,
  recoverInterruptedDeliveryAttempt, settleDeliveryAttempt, startDeliveryAttempt, type Delivery,
} from '../src/domain/delivery.js';
import type { Job } from '../src/domain/job.js';
import { Deliveries } from '../src/storage/delivery.js';
import { Jobs } from '../src/storage/job.js';
import { deliveryRuntime } from '../src/runtime/deliveries.js';

function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof DeliveryError, `expected DeliveryError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

function job(sourceChatId: string): Job {
  return {
    id: 'job-1', title: '季度报告', prompt: '写报告', requirements: [], revision: 1, status: 'ready',
    sourceChatId, executionChatId: '9', currentAttemptId: 'job-1-1',
    result: '报告结果文本', artifactId: null, error: null, createdAt: 1, updatedAt: 1,
  };
}

function notificationDelivery(): Delivery {
  return initialDelivery({
    id: 'notify-1', jobId: 'job-1', scheduleId: 'schedule-1', occurrenceIds: ['schedule-1-o0'],
    revision: 1, channel: 'notification', createdAt: 1,
  });
}

type Fixture = {
  harness: Harness;
  deliveryId: string;
  stored: () => Promise<Delivery | undefined>;
  update: (value: Delivery) => Promise<void>;
  enqueue: () => Promise<TaskId>;
  start: () => void;
  wait: (taskId: TaskId) => Promise<unknown>;
};

async function fixture(
  t: TestContext,
  options: Readonly<{adapter?: NotificationPort; deadlineMs?: number; prepare?: (base: Delivery) => Delivery}> = {},
): Promise<Fixture> {
  let harness!: Harness;
  const runtime = deliveryRuntime({
    getHarness: () => harness,
    ...(options.adapter === undefined ? {} : {notification: options.adapter}),
    ...(options.deadlineMs === undefined ? {} : {deadlineMs: options.deadlineMs}),
  });
  const registry = createRegistry();
  registry.install(runtime.extension);
  harness = await Harness.open(new MemoryStorage(), {models: createModels(), registry}, context);
  t.after(() => harness.close(context));
  const conversation = await harness.createConversation({ownership: {kind: 'ownerless'}}, context);
  const seedJob = job(String(conversation.id));
  const base = notificationDelivery();
  await harness.commit(async tx => {
    await tx.doc(Jobs, seedJob.id, seedJob);
    const draft = await tx.doc(Deliveries, base.id, base);
    if (options.prepare !== undefined) Object.assign(draft, options.prepare(base));
  }, context);
  const enqueue = async () => await harness.commit(tx => tx.createTask(runtime.NotifyTask, {deliveryId: base.id}, {
    conversationId: conversation.id as ConversationId, ownership: {kind: 'conversation'}, background: true,
  }), context) as TaskId;
  return {
    harness,
    deliveryId: base.id,
    stored: async () => await harness.snapshot(Deliveries, base.id, context),
    update: async value => {
      await harness.commit(async tx => {
        const draft = await tx.doc(Deliveries, base.id, base);
        Object.assign(draft, value);
      }, context);
    },
    enqueue,
    start: () => harness.resume(),
    wait: async taskId => await harness.waitForTask(taskId, context),
  };
}

type SettledTask = Awaited<ReturnType<Harness['waitForTask']>>;

function settledStatus(task: SettledTask): string {
  const outcome = task.state.outcome;
  assert.equal(outcome.status, 'completed');
  return (outcome.result as {status: string}).status;
}

function gateAdapter() {
  let releaseGate!: () => void;
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  let enteredResolve!: () => void;
  const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
  const calls: NotificationRequest[] = [];
  const port: NotificationPort = {
    async send(request) {
      calls.push({...request});
      enteredResolve();
      await gate;
      return 'delivered';
    },
  };
  return {port, calls, entered, release: releaseGate};
}

function resultAdapter(result: NotificationSendResult) {
  const calls: NotificationRequest[] = [];
  const port: NotificationPort = {
    async send(request) {
      calls.push({...request});
      return result;
    },
  };
  return {port, calls};
}

test('delivery attempt fencing: token CAS, live/expired, explicit recovery only', () => {
  const base = notificationDelivery();
  const started = startDeliveryAttempt(base, {token: 'token-1', workerId: 'worker-1', startedAt: 100, deadline: 200});
  assert.deepEqual([started.status, started.attempts, started.attemptToken, started.workerId],
    ['attempting', 1, 'token-1', 'worker-1']);
  assert.equal(deliveryAttemptState(base, 100), 'idle');
  assert.equal(deliveryAttemptState(started, 199), 'live');
  assert.equal(deliveryAttemptState(started, 200), 'expired');
  assert.throws(() => settleDeliveryAttempt(started, {status: 'done', result: 'delivered'}, {token: 'other', now: 150}),
    hasCode('STALE_ATTEMPT'));
  const done = settleDeliveryAttempt(started, {status: 'done', result: 'delivered'}, {token: 'token-1', now: 150});
  assert.deepEqual([done.status, done.result], ['done', 'delivered']);
  assert.equal(settleDeliveryAttempt(done, {status: 'unknown', error: 'x'}, {token: 'token-1', now: 160}), done,
    'a terminal settlement is idempotent');
  assert.throws(() => recoverExpiredDeliveryAttempt(started, {now: 150, reason: 'x'}), hasCode('RECOVERY_NOT_ALLOWED'),
    'a live attempt is not recoverable');
  const expired = recoverExpiredDeliveryAttempt(started, {now: 200, reason: 'attempt-deadline-expired'});
  assert.deepEqual([expired.status, expired.error], ['unknown', 'attempt-deadline-expired']);
  const interrupted = recoverInterruptedDeliveryAttempt(started, {now: 150, reason: 'interrupted'});
  assert.deepEqual([interrupted.status, interrupted.error], ['unknown', 'interrupted']);
  assert.throws(() => startDeliveryAttempt(started, {token: 'token-2', workerId: 'worker-2', startedAt: 160, deadline: 260}),
    hasCode('INVALID_TRANSITION'));
});

test('a concurrent NotifyTask leaves a live send untouched and reports in-progress', {timeout: 20000}, async t => {
  const gated = gateAdapter();
  const f = await fixture(t, {adapter: gated.port, deadlineMs: 60_000});
  const first = await f.enqueue();
  f.start();
  await gated.entered;
  const firstRecord = await f.stored();
  assert.deepEqual([firstRecord?.status, firstRecord?.attempts], ['attempting', 1]);

  const second = await f.enqueue();
  const secondSettled = await f.wait(second) as SettledTask;
  assert.equal(settledStatus(secondSettled), 'in-progress');
  const during = await f.stored();
  assert.equal(during?.status, 'attempting', 'a live different worker never marks unknown');
  assert.equal(during?.error, null);

  gated.release();
  await f.wait(first);
  const settled = await f.stored();
  assert.deepEqual([settled?.status, settled?.result, settled?.attempts], ['done', 'delivered', 1]);
  assert.equal(gated.calls.length, 1, 'the provider is called exactly once');
});

test('the same Durable task resuming recovers its interrupted attempt without replay', {timeout: 20000}, async t => {
  const adapter = resultAdapter('delivered');
  const f = await fixture(t, {adapter: adapter.port});
  const taskId = await f.enqueue();
  const now = Date.now();
  await f.update(startDeliveryAttempt(notificationDelivery(), {
    token: 'dead-invocation-token', workerId: String(taskId), startedAt: now - 100, deadline: now + 60_000,
  }));
  f.start();
  await f.wait(taskId);
  const record = await f.stored();
  assert.deepEqual([record?.status, record?.error], ['unknown', 'interrupted']);
  assert.equal(adapter.calls.length, 0, 'an interrupted send is never replayed');
});

test('an expired attempt is recovered explicitly without calling the provider', {timeout: 20000}, async t => {
  const adapter = resultAdapter('delivered');
  const f = await fixture(t, {adapter: adapter.port});
  const now = Date.now();
  await f.update(startDeliveryAttempt(notificationDelivery(), {
    token: 'expired-token', workerId: 'old-worker', startedAt: now - 60_000, deadline: now - 1,
  }));
  const taskId = await f.enqueue();
  f.start();
  await f.wait(taskId);
  const record = await f.stored();
  assert.deepEqual([record?.status, record?.error], ['unknown', 'attempt-deadline-expired']);
  assert.equal(adapter.calls.length, 0);
});

test('a late success after the deadline is never persisted as done', {timeout: 20000}, async t => {
  const calls: NotificationRequest[] = [];
  const slow: NotificationPort = {
    async send(request) {
      calls.push({...request});
      await new Promise(resolve => setTimeout(resolve, 60));
      return 'delivered';
    },
  };
  const f = await fixture(t, {adapter: slow, deadlineMs: 30});
  const taskId = await f.enqueue();
  f.start();
  await f.wait(taskId);
  const record = await f.stored();
  assert.deepEqual([record?.status, record?.error], ['unknown', 'attempt-deadline-expired']);
  assert.equal(calls.length, 1, 'a deadline is not retried');
});

test('structured notification outcomes persist only redacted code/status/classification', {timeout: 20000}, async t => {
  const unknownAdapter = resultAdapter({
    outcome: 'unknown', code: 'http-server-error', status: 503,
    detail: {classification: 'server', body: 'SECRET-PROVIDER-BODY', token: 'SECRET-TOKEN'},
  });
  const unknownFixture = await fixture(t, {adapter: unknownAdapter.port});
  const unknownTask = await unknownFixture.enqueue();
  unknownFixture.start();
  await unknownFixture.wait(unknownTask);
  const unknown = await unknownFixture.stored();
  assert.deepEqual([unknown?.status, unknown?.error],
    ['unknown', 'notification-unknown:http-server-error:503:server']);
  const serialized = JSON.stringify(unknown);
  for (const secret of ['SECRET-PROVIDER-BODY', 'SECRET-TOKEN']) assert.ok(!serialized.includes(secret));
  assert.ok(!unknown!.error!.includes(unknown!.attemptToken!));
  const replayTask = await unknownFixture.enqueue();
  await unknownFixture.wait(replayTask);
  assert.equal(unknownAdapter.calls.length, 1, 'unknown is terminal and never resent');
  assert.deepEqual(await unknownFixture.stored(), unknown);

  const failedAdapter = resultAdapter({
    outcome: 'failed', code: 'http-client-error', status: 422, detail: {classification: 'client'},
  });
  const failedFixture = await fixture(t, {adapter: failedAdapter.port});
  const failedTask = await failedFixture.enqueue();
  failedFixture.start();
  await failedFixture.wait(failedTask);
  const failed = await failedFixture.stored();
  assert.deepEqual([failed?.status, failed?.error],
    ['failed', 'notification-failed:http-client-error:422:client']);
});

test('legacy plain-string notification outcomes keep the historical error value', {timeout: 20000}, async t => {
  const failedFixture = await fixture(t, {adapter: resultAdapter('failed').port});
  const failedTask = await failedFixture.enqueue();
  failedFixture.start();
  await failedFixture.wait(failedTask);
  assert.deepEqual([(await failedFixture.stored())?.status, (await failedFixture.stored())?.error],
    ['failed', 'notification-failed']);

  const unknownFixture = await fixture(t, {adapter: resultAdapter('unknown').port});
  const unknownTask = await unknownFixture.enqueue();
  unknownFixture.start();
  await unknownFixture.wait(unknownTask);
  assert.deepEqual([(await unknownFixture.stored())?.status, (await unknownFixture.stored())?.error],
    ['unknown', 'notification-unknown']);
});

test('the delivery document version rejects legacy records instead of migrating them', () => {
  assert.equal(Deliveries.definition.version, 2);
  const legacy = {...notificationDelivery()} as Record<string, unknown>;
  delete legacy.attemptToken;
  delete legacy.workerId;
  delete legacy.attemptStartedAt;
  delete legacy.deadline;
  assert.equal(parseDelivery(legacy), undefined, 'a version-1 shape is not accepted as a v2 delivery');
});
