import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  createRegistry, Harness, MemoryStorage, type TaskId,
} from '@earendil-works/pi-durable';
import {
  DeliveryError, completeDelivery, failDelivery, initialDelivery, isDeliveryId, markDeliveryUnknown,
  parseDelivery, reportText, startDelivery, type Delivery,
} from '../src/domain/delivery.js';
import type { Job } from '../src/domain/job.js';
import { Deliveries } from '../src/storage/delivery.js';
import { Jobs } from '../src/storage/job.js';
import { Artifacts, artifactDocument } from '../src/storage/artifact.js';
import { deliveryCommands, type SessionDocumentScanner } from '../src/application/delivery.js';
import { deliveryRuntime } from '../src/runtime/deliveries.js';

function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof DeliveryError, `expected DeliveryError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  const base = initialDelivery({
    id: 'delivery-1', jobId: 'job-1', scheduleId: 'schedule-1', occurrenceIds: ['schedule-1-o0'],
    revision: 1, channel: 'chat', createdAt: 1,
  });
  return {...base, ...overrides};
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1', title: '季度报告', prompt: '写报告', requirements: [], revision: 1, status: 'ready',
    sourceChatId: '2', executionChatId: '9', currentAttemptId: 'job-1-1',
    result: '报告结果文本', artifactId: 'artifact-1', error: null, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

type Fixture = {
  harness: Harness;
  runtime: ReturnType<typeof deliveryRuntime>;
  conversationId: number;
  setDeliveries(values: Delivery[]): void;
};

let deliverySequence = 0;

async function fixture(t: TestContext, seed: {job?: Job; deliveries?: Delivery[]} = {}): Promise<Fixture> {
  const seeded: Delivery[] = [];
  const scan: SessionDocumentScanner = async kind => kind === 'point.delivery'
    ? seeded.map(item => ({key: item.id, value: item as unknown as Readonly<Record<string, unknown>>}))
    : [];
  let harness!: Harness;
  const runtime = deliveryRuntime({getHarness: () => harness, scan});
  const registry = createRegistry();
  registry.install(runtime.extension);
  harness = await Harness.open(new MemoryStorage(), {models: createModels(), registry}, context);
  t.after(() => harness.close(context));
  // Create the source conversation explicitly and use its real id.
  const created = await harness.createConversation({ownership: {kind: 'ownerless'}}, context);
  const sourceChatId = Number(created.id);
  const seedJob = seed.job ?? job();
  const jobDoc = {...seedJob, sourceChatId: String(sourceChatId)};
  await harness.commit(async tx => {
    await tx.doc(Jobs, jobDoc.id, jobDoc);
    await tx.doc(Artifacts, 'artifact-1', artifactDocument({
      id: 'artifact-1', jobId: jobDoc.id, attemptId: 'job-1-1', revision: 1, name: 'report.md',
      path: '/tmp/workspace/jobs/job-1/job-1-1/artifact-1/report.md', sha256: 'a'.repeat(64),
      bytes: 10, state: 'sealed', createdAt: 1, sealedAt: 2,
    }));
    for (const item of seed.deliveries ?? []) await tx.doc(Deliveries, item.id, item);
  }, context);
  seeded.push(...(seed.deliveries ?? []));
  return {
    harness, runtime, conversationId: sourceChatId,
    setDeliveries(values: Delivery[]) { seeded.length = 0; seeded.push(...values); },
  };
}

async function runTask(f: Fixture, task: 'report' | 'notify', deliveryId: string): Promise<void> {
  const options = {conversationId: f.conversationId as never, ownership: {kind: 'conversation'} as const, background: true};
  const taskId = task === 'report'
    ? await f.harness.commit(tx => tx.createTask(f.runtime.ReportTask, {deliveryId}, options), context) as TaskId
    : await f.harness.commit(tx => tx.createTask(f.runtime.NotifyTask, {deliveryId}, options), context) as TaskId;
  f.harness.resume();
  await f.harness.waitForTask(taskId, context);
}

async function reportEntries(harness: Harness, conversationId: number) {
  const conversation = await harness.conversation(conversationId as never, context);
  assert.ok(conversation);
  const page = await conversation.entries({order: 'ascending'}, 50, undefined, context);
  return page.items.filter(entry => entry.kind === 'point.report');
}

/* -------------------------------------------------------------------------- */
/* Domain                                                                      */
/* -------------------------------------------------------------------------- */

test('delivery value transitions are strict and terminal states are idempotent', () => {
  const intent = delivery();
  assert.deepEqual([intent.status, intent.attempts, intent.result, intent.error], ['intent', 0, null, null]);
  const attempting = startDelivery(intent, 10);
  assert.deepEqual([attempting.status, attempting.attempts], ['attempting', 1]);
  const done = completeDelivery(attempting, 'delivered', 11);
  assert.deepEqual([done.status, done.result], ['done', 'delivered']);
  // T1: repeating complete/fail on a terminal record is an idempotent read, not an invalid transition.
  assert.equal(completeDelivery(done, 'again', 12), done, 'done is terminal');
  assert.equal(failDelivery(done, 'err', 12), done, 'failing a done delivery returns the original value');
  assert.throws(() => startDelivery(done, 12), hasCode('INVALID_TRANSITION'));
  const failed = failDelivery(intent, 'notification-failed', 11);
  assert.deepEqual([failed.status, failed.error], ['failed', 'notification-failed']);
  assert.equal(failDelivery(failed, 'other', 12), failed, 'failed is terminal');
  assert.equal(completeDelivery(failed, 'delivered', 12), failed, 'completing a failed delivery returns the original value');
  assert.throws(() => startDelivery(failed, 12), hasCode('INVALID_TRANSITION'));
  const unknown = markDeliveryUnknown(attempting, 'notification-unknown', 12);
  assert.deepEqual([unknown.status, unknown.error], ['unknown', 'notification-unknown']);
  assert.equal(failDelivery(unknown, 'other', 13), unknown, 'unknown is terminal');
  assert.equal(completeDelivery(unknown, 'delivered', 13), unknown);
  assert.throws(() => markDeliveryUnknown(intent, 'x', 12), hasCode('INVALID_TRANSITION'),
    'only an attempted delivery can be unknown');
  assert.throws(() => markDeliveryUnknown(delivery({status: 'unknown'}), 'again', 12), hasCode('INVALID_TRANSITION'),
    'unknown is terminal and cannot be re-marked');
});

test('report text names the job, result and artifact, and delivery ids are strict', () => {
  const text = reportText({title: '季度报告', result: '报告结果文本', artifactId: 'artifact-1'});
  for (const fragment of ['季度报告', '报告结果文本', 'artifact-1']) assert.ok(text.includes(fragment), fragment);
  const withPath = reportText({title: 't', result: 'r', artifactId: 'a', artifactPath: '/tmp/x/report.md'});
  assert.ok(withPath.includes('/tmp/x/report.md'));
  assert.equal(isDeliveryId('delivery:1'), true);
  assert.equal(isDeliveryId(''), false);
  assert.equal(isDeliveryId(7), false);
  assert.equal(parseDelivery(delivery())?.id, 'delivery-1');
  assert.equal(parseDelivery(null), undefined);
  assert.equal(parseDelivery({...delivery(), status: 'bogus'}), undefined);
});

test('delivery commands return undefined for unknown/invalid ids', async t => {
  const f = await fixture(t);
  const seeded = delivery({id: 'delivery-a'});
  f.setDeliveries([seeded, delivery({id: 'delivery-b', createdAt: 2})]);
  const commands = deliveryCommands({
    async load(id) { return id === 'delivery-a' ? seeded : undefined; },
    async list(jobId) {
      void jobId;
      return [seeded];
    },
  });
  assert.equal((await commands.get('delivery-a'))?.id, 'delivery-a');
  assert.equal(await commands.get('missing'), undefined);
  assert.equal(await commands.get('bad id'), undefined);
  assert.deepEqual((await commands.list('job-1')).map(item => item.id), ['delivery-a']);
});

/* -------------------------------------------------------------------------- */
/* Report task: one chat entry per delivery                                    */
/* -------------------------------------------------------------------------- */

test('the report task appends one chat entry and completes the delivery', {timeout: 15000}, async t => {
  const f = await fixture(t, {deliveries: [delivery()]});
  await runTask(f, 'report', 'delivery-1');
  const stored = await f.harness.snapshot(Deliveries, 'delivery-1', context);
  assert.equal(stored?.status, 'done');
  assert.equal(stored?.attempts, 1);
  assert.equal(stored?.result, 'delivered');
  const entries = await reportEntries(f.harness, f.conversationId);
  assert.equal(entries.length, 1, 'one delivery appends exactly one entry');
  const text = JSON.stringify(entries[0]?.model);
  assert.ok(text.includes('季度报告'));
  assert.ok(text.includes('报告结果文本'));
  assert.ok(text.includes('artifact-1'));
  assert.ok(text.includes('/tmp/workspace/jobs/job-1/job-1-1/artifact-1/report.md'));
  const data = entries[0]?.data as {jobId?: string; deliveryId?: string} | undefined;
  assert.deepEqual([data?.jobId, data?.deliveryId], ['job-1', 'delivery-1']);
});

test('re-running a report for a completed delivery is an idempotent no-op', {timeout: 15000}, async t => {
  const f = await fixture(t, {deliveries: [delivery({status: 'done', attempts: 1, result: 'delivered'})]});
  await runTask(f, 'report', 'delivery-1');
  assert.equal((await reportEntries(f.harness, f.conversationId)).length, 0,
    'a non-intent delivery never appends a chat entry');
  assert.equal((await f.harness.snapshot(Deliveries, 'delivery-1', context))?.status, 'done');
});

test('a report for a stale job revision fails without writing the chat', {timeout: 15000}, async t => {
  const f = await fixture(t, {
    job: job({revision: 2}),
    deliveries: [delivery({revision: 1})],
  });
  await runTask(f, 'report', 'delivery-1');
  const stored = await f.harness.snapshot(Deliveries, 'delivery-1', context);
  assert.deepEqual([stored?.status, stored?.error], ['failed', 'job-not-current']);
  assert.equal((await reportEntries(f.harness, f.conversationId)).length, 0, 'a stale report writes nothing');
});

test('a report for a cancelled job fails without writing the chat', {timeout: 15000}, async t => {
  const f = await fixture(t, {
    job: job({status: 'cancelled'}),
    deliveries: [delivery()],
  });
  await runTask(f, 'report', 'delivery-1');
  const stored = await f.harness.snapshot(Deliveries, 'delivery-1', context);
  assert.deepEqual([stored?.status, stored?.error], ['failed', 'job-not-current']);
  assert.equal((await reportEntries(f.harness, f.conversationId)).length, 0);
});

test('a report for a non-ready job fails as job-not-ready without writing the chat', {timeout: 15000}, async t => {
  const f = await fixture(t, {job: job({status: 'running'}), deliveries: [delivery()]});
  await runTask(f, 'report', 'delivery-1');
  const stored = await f.harness.snapshot(Deliveries, 'delivery-1', context);
  assert.deepEqual([stored?.status, stored?.error], ['failed', 'job-not-ready']);
  assert.equal((await reportEntries(f.harness, f.conversationId)).length, 0,
    'a non-ready job never gets a chat report');
});

test('a report for a non-chat delivery channel is skipped', {timeout: 15000}, async t => {
  const f = await fixture(t, {deliveries: [delivery({channel: 'notification'})]});
  await runTask(f, 'report', 'delivery-1');
  assert.equal((await f.harness.snapshot(Deliveries, 'delivery-1', context))?.status, 'intent',
    'the report task leaves a notification delivery untouched');
  assert.equal((await reportEntries(f.harness, f.conversationId)).length, 0);
});
