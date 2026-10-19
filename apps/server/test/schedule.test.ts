import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT as backgroundContext } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import {
  FOLLOWUP_POLICY, MAX_OCCURRENCES, MAX_REMINDERS, ScheduleError,
  canTransitionOccurrence, canTransitionSchedule, createOccurrences, evaluateFollowup,
  isActiveSchedule, isOccurrenceIdFor, occurrenceIdFor, parseCancelFollowup, parseScheduleFollowup,
  type Schedule,
} from '../src/domain/schedule.js';
import { openRuntime, type ModelBinding, type Runtime } from '../src/runtime/open.js';
import { Jobs } from '../src/storage/job.js';
import { memoryNotificationAdapter, type MemoryNotificationAdapter } from '../src/adapters/notification/memory.js';

function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ScheduleError, `expected ScheduleError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

const schedule = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  requestId: 'schedule:1', jobId: 'job-1', expectedRevision: 1, dueAt: 1_000, ...overrides,
});

function scheduleRecord(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1', jobId: 'job-1', revision: 1, sourceChatId: '2', status: 'active',
    occurrenceIds: ['schedule-1-o0'], createdAt: 1, updatedAt: 1, ...overrides,
  };
}

test('schedule input is strict: absolute times, optional advance window and revision fence', () => {
  assert.deepEqual(parseScheduleFollowup(schedule()), {
    requestId: 'schedule:1', jobId: 'job-1', expectedRevision: 1, dueAt: 1000,
  });
  assert.deepEqual(parseScheduleFollowup(schedule({advanceAt: 500, sourceChatId: '2'})), {
    requestId: 'schedule:1', jobId: 'job-1', expectedRevision: 1, dueAt: 1000, advanceAt: 500, sourceChatId: '2',
  });
  // Absolute times in the past are valid: missed windows are merged, never shifted.
  assert.equal(parseScheduleFollowup(schedule({dueAt: 1})).dueAt, 1);

  for (const invalid of [
    null, [], {}, {requestId: 'r', jobId: 'j', expectedRevision: 1}, schedule({extra: true}),
    schedule({requestId: ''}), schedule({requestId: 'bad id'}), schedule({jobId: ''}),
    schedule({expectedRevision: 0}), schedule({expectedRevision: 1.5}), schedule({expectedRevision: '1'}),
    schedule({dueAt: -1}), schedule({dueAt: 1.5}), schedule({dueAt: 8_640_000_000_000_001}), schedule({dueAt: '1000'}),
    schedule({advanceAt: 1000}), schedule({advanceAt: 1001, dueAt: 1000}),
    schedule({advanceAt: '500'}), schedule({sourceChatId: '0'}), schedule({sourceChatId: 'abc'}),
  ]) {
    assert.throws(() => parseScheduleFollowup(invalid), hasCode('INVALID_COMMAND'), `accepted ${JSON.stringify(invalid)}`);
  }
  assert.deepEqual(parseCancelFollowup({requestId: 'cancel:1', scheduleId: 'schedule-1'}),
    {requestId: 'cancel:1', scheduleId: 'schedule-1'});
  for (const invalid of [null, {}, {requestId: 'cancel:1'}, {scheduleId: 'schedule-1'},
    {requestId: 'cancel:1', scheduleId: 'schedule-1', extra: true}, {requestId: 'bad id', scheduleId: 'schedule-1'}]) {
    assert.throws(() => parseCancelFollowup(invalid), hasCode('INVALID_COMMAND'));
  }
});

test('one schedule materializes the advance window first and the due window last, at most twice', () => {
  const dueOnly = createOccurrences('schedule-1', 'job-1', 1, {dueAt: 2000});
  assert.equal(dueOnly.length, 1);
  assert.deepEqual(dueOnly[0], {
    id: 'schedule-1-o0', scheduleId: 'schedule-1', jobId: 'job-1', revision: 1,
    index: 0, dueAt: 2000, state: 'pending', reason: null,
  });
  const both = createOccurrences('schedule-1', 'job-1', 2, {advanceAt: 500, dueAt: 2000});
  assert.equal(both.length, MAX_OCCURRENCES);
  assert.deepEqual(both.map(item => [item.index, item.id, item.dueAt]), [
    [0, 'schedule-1-o0', 500],
    [1, 'schedule-1-o1', 2000],
  ]);
  assert.equal(occurrenceIdFor('schedule-1', 1), 'schedule-1-o1');
  assert.equal(isOccurrenceIdFor('schedule-1-o1', 'schedule-1', 1), true);
  assert.equal(isOccurrenceIdFor('schedule-1-o0', 'schedule-1', 1), false);
});

test('schedule/occurrence state machines are terminal once settled', () => {
  assert.equal(canTransitionSchedule('active', 'done'), true);
  assert.equal(canTransitionSchedule('active', 'cancelled'), true);
  assert.equal(canTransitionSchedule('done', 'active'), false);
  assert.equal(canTransitionSchedule('cancelled', 'done'), false);
  assert.equal(canTransitionOccurrence('pending', 'delivered'), true);
  assert.equal(canTransitionOccurrence('pending', 'skipped'), true);
  assert.equal(canTransitionOccurrence('delivered', 'skipped'), false);
  assert.equal(isActiveSchedule({status: 'active'}), true);
  assert.equal(isActiveSchedule({status: 'done'}), false);
});

test('the followup policy is auditable, ordered and caps reminders', () => {
  assert.deepEqual(evaluateFollowup({job: undefined, scheduleRevision: 1, deliveredCount: 0, batchSize: 1}),
    {choice: 'skip', reason: 'job-cancelled'});
  assert.deepEqual(evaluateFollowup({job: {status: 'cancelled', revision: 1}, scheduleRevision: 1, deliveredCount: 0, batchSize: 1}),
    {choice: 'skip', reason: 'job-cancelled'}, 'a cancelled job wins over a stale revision');
  assert.deepEqual(evaluateFollowup({job: {status: 'ready', revision: 2}, scheduleRevision: 1, deliveredCount: 0, batchSize: 1}),
    {choice: 'skip', reason: 'stale-revision'});
  assert.deepEqual(evaluateFollowup({job: {status: 'ready', revision: 1}, scheduleRevision: 1, deliveredCount: 0, batchSize: 1}),
    {choice: 'deliver', reason: 'due-reminder'});
  assert.deepEqual(evaluateFollowup({job: {status: 'ready', revision: 1}, scheduleRevision: 1, deliveredCount: 1, batchSize: 1}),
    {choice: 'deliver', reason: 'due-reminder'}, 'the second reminder is still within the cap');
  assert.deepEqual(evaluateFollowup({job: {status: 'ready', revision: 1}, scheduleRevision: 1, deliveredCount: 2, batchSize: 1}),
    {choice: 'skip', reason: 'reminder-cap'});
  assert.deepEqual(evaluateFollowup({job: {status: 'ready', revision: 1}, scheduleRevision: 1, deliveredCount: 1, batchSize: 2}),
    {choice: 'skip', reason: 'reminder-cap'}, 'a merged batch may not exceed the cap either');
  assert.deepEqual(evaluateFollowup({job: {status: 'ready', revision: 1}, scheduleRevision: 1, deliveredCount: 0, batchSize: 2}),
    {choice: 'deliver', reason: 'due-reminder'});
  assert.equal(MAX_REMINDERS, 2);
  assert.equal(FOLLOWUP_POLICY, 'point.followup.v1');
});

test('unused schedule state remains a value object', () => {
  const pending = scheduleRecord();
  assert.equal(isActiveSchedule(pending), true);
  assert.deepEqual(pending.occurrenceIds, ['schedule-1-o0']);
});


/* -------------------------------------------------------------------------- */
/* Runtime integration: follow-up task, decisions and delivery                 */
/* -------------------------------------------------------------------------- */

function provider(responses: FauxResponseStep[]) {
  const faux = fauxProvider({tokensPerSecond: 100000});
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const binding: ModelBinding = {models, model: {provider: 'faux', modelId: 'faux-1'}};
  return {faux, binding};
}

const toolStep = (content: string): FauxResponseStep =>
  fauxAssistantMessage([fauxToolCall('save_artifact', {name: 'report.md', content})], {stopReason: 'toolUse'});

type Fixture = {
  runtime: Runtime;
  faux: ReturnType<typeof fauxProvider>;
  adapter: MemoryNotificationAdapter;
  dir: string;
};

async function fixture(t: TestContext, responses: FauxResponseStep[], script: 'delivered' | 'failed' | 'unknown' = 'delivered'): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'point-schedule-'));
  const p = provider(responses);
  const adapter = memoryNotificationAdapter(script);
  const runtime = await openRuntime(dir, p.binding, {notification: adapter.port});
  t.after(async () => { await runtime.close(); await rm(dir, {recursive: true, force: true}); });
  return {runtime, faux: p.faux, adapter, dir};
}

/** Create a source chat and a ready Job (one tool round + one final answer). */
let readyJobSequence = 0;
async function readyJob(runtime: Runtime) {
  readyJobSequence += 1;
  const sequence = readyJobSequence;
  const chat = await runtime.chats.create({requestId: `source-chat-${sequence}`, name: `计划来源${sequence}`});
  const started = await runtime.jobs.start({
    requestId: `schedule-job-${sequence}`, title: '季度报告', prompt: '请产出报告', sourceChatId: chat.id,
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    const job = await runtime.jobs.get(started.jobId);
    if (job?.status === 'ready') return {chat, job};
    if (job?.status === 'failed') assert.fail(`job failed: ${job.error}`);
    if (Date.now() > deadline) assert.fail(`job stayed ${job?.status}`);
    await delay(5);
  }
}

async function waitForJobStatus(runtime: Runtime, jobId: string, statuses: readonly string[], timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await runtime.jobs.get(jobId);
    if (job && statuses.includes(job.status)) return job;
    if (Date.now() > deadline) assert.fail(`job ${jobId} stayed ${job?.status ?? 'missing'}`);
    await delay(5);
  }
}

/** Mutate a Job document while the runtime is closed (used to force a wake-time status race). */
async function setJobStatusWhileClosed(dir: string, jobId: string, status: 'running' | 'failed') {
  const storage = await openNodeSqliteStorage(join(dir, 'state.sqlite'));
  const harness = await Harness.open(storage, {models: createModels(), registry: createRegistry()}, backgroundContext);
  try {
    const current = await harness.snapshot(Jobs, jobId, backgroundContext);
    assert.ok(current, 'the seeded job exists');
    await harness.commit(async tx => {
      const draft = await tx.doc(Jobs, jobId, {...current});
      draft.status = status;
      draft.updatedAt = Date.now();
    }, backgroundContext);
  } finally {
    await harness.close(backgroundContext);
  }
}

async function waitForSchedule(runtime: Runtime, scheduleId: string, status: Schedule['status'], timeoutMs = 15000): Promise<Schedule> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const schedule = await runtime.followups.get(scheduleId);
    if (schedule && schedule.status === status) return schedule;
    if (Date.now() > deadline) assert.fail(`schedule ${scheduleId} stayed ${schedule?.status ?? 'missing'}`);
    await delay(10);
  }
}

async function assistantEntries(runtime: Runtime, chatId: string): Promise<string[]> {
  const history = await runtime.conversation.history(chatId);
  return history.items.filter(item => item.role === 'assistant').map(item => item.text);
}

test('schedule materializes absolute occurrences and rejects stale or cancelled jobs', {timeout: 30000}, async t => {
  const f = await fixture(t, [toolStep('report'), fauxAssistantMessage('完成'), toolStep('second'), fauxAssistantMessage('完成二')]);
  const {chat, job} = await readyJob(f.runtime);
  const dueAt = Date.now() + 60_000;
  const scheduled = await f.runtime.followups.schedule({
    requestId: 'schedule:1', jobId: job.id, expectedRevision: 1, dueAt,
  });
  assert.equal(scheduled.occurrenceIds.length, 1);
  const schedule = await f.runtime.followups.get(scheduled.scheduleId);
  assert.deepEqual([schedule?.status, schedule?.revision, schedule?.sourceChatId], ['active', 1, chat.id]);
  const occurrences = await f.runtime.followups.occurrences(scheduled.scheduleId);
  assert.deepEqual(occurrences.map(item => [item.index, item.dueAt, item.state]), [[0, dueAt, 'pending']]);
  assert.deepEqual(await f.runtime.followups.decisions(job.id), []);
  assert.deepEqual(await f.runtime.followups.deliveries(job.id), []);

  // Two occurrences: the advance window first, the due window last. One schedule per Job revision,
  // so the second plan belongs to a second ready Job.
  const second = await readyJob(f.runtime);
  const withAdvance = await f.runtime.followups.schedule({
    requestId: 'schedule:2', jobId: second.job.id, expectedRevision: 1, dueAt: dueAt + 1000, advanceAt: dueAt - 1000,
  });
  assert.equal(withAdvance.occurrenceIds.length, MAX_OCCURRENCES);
  const ordered = await f.runtime.followups.occurrences(withAdvance.scheduleId);
  assert.deepEqual(ordered.map(item => item.dueAt), [dueAt - 1000, dueAt + 1000]);
  assert.deepEqual(ordered.map(item => item.index), [0, 1]);

  // Idempotency and strict input at the command boundary.
  assert.deepEqual(await f.runtime.followups.schedule({
    requestId: 'schedule:1', jobId: job.id, expectedRevision: 1, dueAt,
  }), scheduled);
  await assert.rejects(f.runtime.followups.schedule({
    requestId: 'schedule:1', jobId: job.id, expectedRevision: 1, dueAt: dueAt + 1,
  }), (error: unknown) => error instanceof ScheduleError && error.code === 'IDEMPOTENCY_CONFLICT');
  await assert.rejects(f.runtime.followups.schedule({
    requestId: 'schedule:stale', jobId: job.id, expectedRevision: 2, dueAt,
  }), (error: unknown) => error instanceof ScheduleError && error.code === 'REVISION_MISMATCH');
  await assert.rejects(f.runtime.followups.schedule({
    requestId: 'schedule:missing', jobId: 'missing-job', expectedRevision: 1, dueAt,
  }), (error: unknown) => error instanceof ScheduleError && error.code === 'JOB_NOT_FOUND');
  for (const invalid of [null, {}, {...scheduled, expectedRevision: 0}, {requestId: 'x', jobId: job.id, expectedRevision: 1, dueAt: -1}]) {
    await assert.rejects(f.runtime.followups.schedule(invalid),
      (error: unknown) => error instanceof ScheduleError && error.code === 'INVALID_COMMAND');
  }

  // Cancelling stops future reminders and never changes the Job.
  const cancelled = await f.runtime.followups.cancel({requestId: 'cancel:1', scheduleId: scheduled.scheduleId});
  assert.deepEqual(cancelled, {scheduleId: scheduled.scheduleId, status: 'cancelled'});
  assert.deepEqual((await f.runtime.followups.occurrences(scheduled.scheduleId)).map(item => [item.state, item.reason]),
    [['skipped', 'cancelled']]);
  assert.equal((await f.runtime.followups.get(scheduled.scheduleId))?.status, 'cancelled');
  assert.deepEqual((await f.runtime.followups.cancel({requestId: 'cancel:1', scheduleId: scheduled.scheduleId})),
    {scheduleId: scheduled.scheduleId, status: 'cancelled'});
  await assert.rejects(f.runtime.followups.cancel({requestId: 'cancel:missing', scheduleId: 'missing-schedule'}),
    (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_NOT_FOUND');
  assert.equal((await f.runtime.jobs.get(job.id))?.status, 'ready');
  await f.runtime.followups.cancel({requestId: 'cancel:advance', scheduleId: withAdvance.scheduleId});
});

test('missed advance and due windows merge into one decision, one chat report and one notification', {timeout: 30000}, async t => {
  const f = await fixture(t, [toolStep('report'), fauxAssistantMessage('完成')]);
  const {chat, job} = await readyJob(f.runtime);
  const scheduled = await f.runtime.followups.schedule({
    requestId: 'merge', jobId: job.id, expectedRevision: 1, dueAt: Date.now() - 1000, advanceAt: Date.now() - 5000,
  });
  await waitForSchedule(f.runtime, scheduled.scheduleId, 'done');
  const decisions = await f.runtime.followups.decisions(job.id);
  assert.equal(decisions.length, 1, 'missed windows merge into one auditable decision');
  assert.deepEqual([decisions[0]?.choice, decisions[0]?.occurrenceIds.length], ['deliver', 2]);
  const occurrences = await f.runtime.followups.occurrences(scheduled.scheduleId);
  assert.deepEqual(occurrences.map(item => item.state), ['delivered', 'delivered']);
  const deliveries = await f.runtime.followups.deliveries(job.id);
  assert.deepEqual(deliveries.map(item => [item.channel, item.status]).sort(),
    [['chat', 'done'], ['notification', 'done']]);
  assert.equal(f.adapter.calls.length, 1, 'one notification for the merged batch');
  assert.equal((await assistantEntries(f.runtime, chat.id)).length, 1, 'one chat report for the merged batch');
});

test('two reminder rounds deliver at most twice and never create a third', {timeout: 40000}, async t => {
  const f = await fixture(t, [toolStep('report'), fauxAssistantMessage('完成')]);
  const {chat, job} = await readyJob(f.runtime);
  const dueAt = Date.now() + 500;
  const scheduled = await f.runtime.followups.schedule({
    requestId: 'two-rounds', jobId: job.id, expectedRevision: 1, dueAt, advanceAt: Date.now() - 1000,
  });
  await waitForSchedule(f.runtime, scheduled.scheduleId, 'done', 30000);
  const decisions = await f.runtime.followups.decisions(job.id);
  assert.equal(decisions.length, 2, 'each wake batch has its own decision');
  assert.deepEqual(decisions.map(item => item.choice), ['deliver', 'deliver']);
  const deliveries = await f.runtime.followups.deliveries(job.id);
  assert.equal(deliveries.length, 4, 'two rounds x (chat + notification)');
  assert.equal(f.adapter.calls.length, 2);
  assert.equal((await assistantEntries(f.runtime, chat.id)).length, 2);
  // No third reminder exists: both occurrences are settled.
  assert.deepEqual((await f.runtime.followups.occurrences(scheduled.scheduleId)).map(item => item.state),
    ['delivered', 'delivered']);
});

test('a cancelled schedule never wakes into a delivery', {timeout: 30000}, async t => {
  const f = await fixture(t, [toolStep('report'), fauxAssistantMessage('完成')]);
  const {chat, job} = await readyJob(f.runtime);
  const scheduled = await f.runtime.followups.schedule({
    requestId: 'cancel-before-wake', jobId: job.id, expectedRevision: 1, dueAt: Date.now() + 400,
  });
  await f.runtime.followups.cancel({requestId: 'cancel:before-wake', scheduleId: scheduled.scheduleId});
  await delay(700);
  assert.equal((await f.runtime.followups.get(scheduled.scheduleId))?.status, 'cancelled');
  assert.deepEqual(await f.runtime.followups.decisions(job.id), []);
  assert.deepEqual(await f.runtime.followups.deliveries(job.id), []);
  assert.equal(f.adapter.calls.length, 0);
  assert.equal((await assistantEntries(f.runtime, chat.id)).length, 0);
});

test('a job cancelled before the wake is skipped as job-cancelled', {timeout: 30000}, async t => {
  const f = await fixture(t, [toolStep('report'), fauxAssistantMessage('完成')]);
  const {job} = await readyJob(f.runtime);
  const scheduled = await f.runtime.followups.schedule({
    requestId: 'job-cancel', jobId: job.id, expectedRevision: 1, dueAt: Date.now() + 400,
  });
  await f.runtime.jobs.cancel({requestId: 'cancel-job', jobId: job.id, expectedRevision: 1});
  await waitForSchedule(f.runtime, scheduled.scheduleId, 'done', 20000);
  const decisions = await f.runtime.followups.decisions(job.id);
  assert.deepEqual(decisions.map(item => [item.choice, item.reason]), [['skip', 'job-cancelled']]);
  assert.deepEqual(await f.runtime.followups.deliveries(job.id), []);
  assert.equal(f.adapter.calls.length, 0);
});

test('an amended job revision before the wake is skipped as stale-revision', {timeout: 40000}, async t => {
  const f = await fixture(t, [
    toolStep('v1'), fauxAssistantMessage('第一版'),
    toolStep('v2'), fauxAssistantMessage('第二版'),
  ]);
  const {job} = await readyJob(f.runtime);
  const scheduled = await f.runtime.followups.schedule({
    requestId: 'stale-revision', jobId: job.id, expectedRevision: 1, dueAt: Date.now() + 400,
  });
  await f.runtime.jobs.amend({requestId: 'amend-before-wake', jobId: job.id, expectedRevision: 1, prompt: '第二版'});
  await waitForSchedule(f.runtime, scheduled.scheduleId, 'done', 20000);
  const decisions = await f.runtime.followups.decisions(job.id);
  assert.deepEqual(decisions.map(item => [item.choice, item.reason]), [['skip', 'stale-revision']]);
  assert.deepEqual(await f.runtime.followups.deliveries(job.id), []);
  assert.equal(f.adapter.calls.length, 0);
});

test('closing before the due time resumes on the absolute time and delivers once', {timeout: 40000}, async t => {
  const f = await fixture(t, [toolStep('report'), fauxAssistantMessage('完成')]);
  const {chat, job} = await readyJob(f.runtime);
  const scheduled = await f.runtime.followups.schedule({
    requestId: 'restart-before-due', jobId: job.id, expectedRevision: 1, dueAt: Date.now() + 600,
  });
  await f.runtime.close();
  const adapter = memoryNotificationAdapter('delivered');
  const p = provider([]);
  const reopened = await openRuntime(f.dir, p.binding, {notification: adapter.port});
  try {
    const done = await waitForSchedule(reopened, scheduled.scheduleId, 'done', 20000);
    assert.equal(done.status, 'done');
    assert.equal((await reopened.followups.occurrences(scheduled.scheduleId)).filter(item => item.state === 'delivered').length, 1);
    assert.equal((await reopened.followups.deliveries(job.id)).length, 2);
    assert.equal(adapter.calls.length, 1);
    assert.equal((await assistantEntries(reopened, chat.id)).length, 1);
    await delay(400);
    assert.equal(adapter.calls.length, 1, 'the reminder is not repeated after recovery');
    assert.equal((await assistantEntries(reopened, chat.id)).length, 1);
  } finally {
    await reopened.close();
  }
});

test('SIGKILL before the due time still fires the follow-up exactly once', {timeout: 60000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-followup-crash-'));
  const child = fork(new URL('./fixtures/followup-crash.js', import.meta.url), [dir, 'before-due'], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const exited = once(child, 'exit');
  try {
    const scheduled = await new Promise<{jobId: string; scheduleId: string; chatId: string}>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`followup fixture timed out: ${stderr}`)), 30000);
      child.on('message', (message: unknown) => {
        const event = message as {event?: string; jobId?: string; scheduleId?: string; chatId?: string};
        if (event.event === 'scheduled' && event.jobId && event.scheduleId && event.chatId) {
          clearTimeout(timer);
          resolve({jobId: event.jobId, scheduleId: event.scheduleId, chatId: event.chatId});
        }
      });
      child.once('exit', () => reject(new Error(`followup fixture exited early: ${stderr}`)));
    });
    child.kill('SIGKILL');
    await exited;

    const adapter = memoryNotificationAdapter('delivered');
    const p = provider([]);
    const runtime = await openRuntime(dir, p.binding, {notification: adapter.port});
    try {
      await waitForSchedule(runtime, scheduled.scheduleId, 'done', 25000);
      assert.equal((await runtime.followups.decisions(scheduled.jobId)).length, 1);
      assert.equal((await runtime.followups.deliveries(scheduled.jobId)).length, 2);
      assert.equal((await runtime.followups.occurrences(scheduled.scheduleId)).filter(item => item.state === 'delivered').length, 1);
      assert.equal(adapter.calls.length, 1);
      assert.equal((await assistantEntries(runtime, scheduled.chatId)).length, 1);
      await delay(400);
      assert.equal(adapter.calls.length, 1, 'recovery never repeats a delivered reminder');
    } finally {
      await runtime.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(dir, {recursive: true, force: true});
  }
});


test('schedule requires a ready job and allows only one schedule per revision', {timeout: 40000}, async t => {
  const f = await fixture(t, [toolStep('running'), fauxAssistantMessage('运行完成'), fauxAssistantMessage('没有产物')]);
  // A running Job is not eligible: scheduling is only for settled work.
  const chat = await f.runtime.chats.create({requestId: 'running-chat', name: '运行来源'});
  const running = await f.runtime.jobs.start({
    requestId: 'running-job', title: '运行中任务', prompt: '请产出', sourceChatId: chat.id,
  });
  await assert.rejects(f.runtime.followups.schedule({
    requestId: 'schedule:running', jobId: running.jobId, expectedRevision: 1, dueAt: Date.now() + 60_000,
  }), (error: unknown) => error instanceof ScheduleError && error.code === 'JOB_NOT_READY');
  const ready = await waitForJobStatus(f.runtime, running.jobId, ['ready', 'failed']);
  assert.equal(ready.status, 'ready');

  // B1/P1: exactly one schedule for a (jobId, revision); a second one is rejected.
  const dupDueAt = Date.now() + 60_000;
  const first = await f.runtime.followups.schedule({
    requestId: 'schedule:dup-1', jobId: running.jobId, expectedRevision: 1, dueAt: dupDueAt,
  });
  await assert.rejects(f.runtime.followups.schedule({
    requestId: 'schedule:dup-2', jobId: running.jobId, expectedRevision: 1, dueAt: dupDueAt,
  }), (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_EXISTS');
  // The same request key still replays its first result.
  assert.deepEqual(await f.runtime.followups.schedule({
    requestId: 'schedule:dup-1', jobId: running.jobId, expectedRevision: 1, dueAt: dupDueAt,
  }), first);
  await f.runtime.followups.cancel({requestId: 'schedule:dup-cleanup', scheduleId: first.scheduleId});

  // A failed Job is also not ready any more.
  const failedChat = await f.runtime.chats.create({requestId: 'failed-chat', name: '失败来源'});
  const failedJob = await f.runtime.jobs.start({
    requestId: 'failed-job', title: '失败任务', prompt: '请产出', sourceChatId: failedChat.id,
  });
  const failed = await waitForJobStatus(f.runtime, failedJob.jobId, ['failed']);
  assert.equal(failed.error, 'ARTIFACT_REQUIRED');
  await assert.rejects(f.runtime.followups.schedule({
    requestId: 'schedule:failed', jobId: failedJob.jobId, expectedRevision: 1, dueAt: Date.now() + 60_000,
  }), (error: unknown) => error instanceof ScheduleError && error.code === 'JOB_NOT_READY');
});

test('a job that is no longer ready at the wake is skipped as job-not-ready', {timeout: 40000}, async t => {
  const f = await fixture(t, [toolStep('report'), fauxAssistantMessage('完成')]);
  const {job} = await readyJob(f.runtime);
  const scheduled = await f.runtime.followups.schedule({
    requestId: 'wake-not-ready', jobId: job.id, expectedRevision: 1, dueAt: Date.now() + 600,
  });
  // Force the Job out of `ready` at the same revision while the runtime is closed.
  await f.runtime.close();
  await setJobStatusWhileClosed(f.dir, job.id, 'running');
  const adapter = memoryNotificationAdapter('delivered');
  const p = provider([]);
  const reopened = await openRuntime(f.dir, p.binding, {notification: adapter.port});
  try {
    await waitForSchedule(reopened, scheduled.scheduleId, 'done', 20000);
    const decisions = await reopened.followups.decisions(job.id);
    assert.deepEqual(decisions.map(item => [item.choice, item.reason]), [['skip', 'job-not-ready']]);
    assert.deepEqual(await reopened.followups.deliveries(job.id), []);
    assert.equal(adapter.calls.length, 0);
  } finally {
    await reopened.close();
  }
});
