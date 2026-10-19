import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux';
import {
  JobError, MAX_REQUIREMENTS, MAX_REQUIREMENT_CHARS, MAX_TITLE_CHARS,
  assertExpectedRevision, attemptDisposition, attemptIdFor, canAmendJob, canCancelJob,
  canTransitionAttempt, canTransitionJob, isAttemptId, isJobId, parseAmendJob, parseCancelJob, parseStartJob,
  sealedArtifactMatches, type Attempt, type Job,
} from '../src/domain/job.js';
import { jobCommands, type JobStore } from '../src/application/job.js';
import { openRuntime, type ModelBinding, type Runtime } from '../src/runtime/open.js';
import { artifactPath, workspaceDir } from '../src/runtime/artifacts.js';

function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof JobError, `expected JobError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

const start = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  requestId: 'start:1', title: '写一份方案', prompt: '给我一份方案', requirements: ['包含预算'], sourceChatId: '2', ...overrides,
});
const amend = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  requestId: 'amend:1', jobId: 'job-1', expectedRevision: 1, prompt: '换个方向', ...overrides,
});
const cancel = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  requestId: 'cancel:1', jobId: 'job-1', expectedRevision: 1, ...overrides,
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1', title: '写一份方案', prompt: '给我一份方案', requirements: ['包含预算'],
    revision: 1, status: 'running', sourceChatId: '2', executionChatId: '9', currentAttemptId: 'job-1-1',
    result: null, artifactId: null, error: null, createdAt: 1, updatedAt: 1, ...overrides,
  };
}
function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: 'job-1-1', jobId: 'job-1', revision: 1, status: 'running', taskId: '11', conversationId: '9',
    artifactId: null, result: null, error: null, startedAt: 1, endedAt: null, ...overrides,
  };
}

test('start/amend/cancel input is strict, trimmed and bounded', () => {
  assert.deepEqual(parseStartJob(start({title: '  写方案  ', requirements: ['  预算  ', ' 交付 ']})), {
    requestId: 'start:1', title: '写方案', prompt: '给我一份方案', requirements: ['预算', '交付'], sourceChatId: '2',
  });
  // Omitting `requirements` defaults to an empty list; an explicit non-array is invalid.
  const {requirements: _omitted, ...withoutRequirements} = start();
  assert.deepEqual(parseStartJob(withoutRequirements), {
    requestId: 'start:1', title: '写一份方案', prompt: '给我一份方案', requirements: [], sourceChatId: '2',
  }, 'requirements are optional and default to empty');
  assert.throws(() => parseStartJob(start({requirements: undefined})), hasCode('INVALID_COMMAND'),
    'an explicit non-array requirements value is invalid instead of being coerced');
  for (const input of [
    null, [], {}, {requestId: 'r', title: 't', prompt: 'p'}, start({extra: true}),
    start({requestId: ''}), start({requestId: 'bad id'}), start({title: ''}), start({title: '   '}),
    start({title: 'x'.repeat(MAX_TITLE_CHARS + 1)}), start({title: 'a\u0000b'}),
    start({prompt: ''}), start({prompt: '   '}), start({prompt: 7}),
    start({prompt: 'x'.repeat(32001)}), start({sourceChatId: '0'}), start({sourceChatId: 'abc'}),
    start({requirements: 'budget'}), start({requirements: [7]}),
    start({requirements: Array.from({length: MAX_REQUIREMENTS + 1}, () => 'x')}),
    start({requirements: ['x'.repeat(MAX_REQUIREMENT_CHARS + 1)]}), start({requirements: ['   ']}),
  ]) {
    assert.throws(() => parseStartJob(input), hasCode('INVALID_COMMAND'), `accepted ${JSON.stringify(input)}`);
  }
  assert.deepEqual(parseAmendJob(amend()), {requestId: 'amend:1', jobId: 'job-1', expectedRevision: 1, prompt: '换个方向'});
  assert.deepEqual(parseAmendJob(amend({requirements: ['新要求']})),
    {requestId: 'amend:1', jobId: 'job-1', expectedRevision: 1, prompt: '换个方向', requirements: ['新要求']});
  for (const input of [null, [], {}, amend({prompt: undefined}), amend({expectedRevision: 0}),
    amend({expectedRevision: 1.5}), amend({jobId: ''}), amend({extra: true}), amend({prompt: '   '}),
    amend({requirements: 'x'})]) {
    assert.throws(() => parseAmendJob(input), hasCode('INVALID_COMMAND'), `accepted ${JSON.stringify(input)}`);
  }
  assert.deepEqual(parseCancelJob(cancel()), {requestId: 'cancel:1', jobId: 'job-1', expectedRevision: 1});
  for (const input of [null, {}, cancel({expectedRevision: 0}), cancel({jobId: 'bad id'}), cancel({extra: true})]) {
    assert.throws(() => parseCancelJob(input), hasCode('INVALID_COMMAND'));
  }
  for (const id of ['job-1', 'a.b_c:d']) assert.equal(isJobId(id), true);
  for (const id of ['', '../x', 'bad id', 7]) assert.equal(isJobId(id), false);
  assert.equal(isAttemptId('job-1-1'), true);
});

test('attempt ids are deterministic in (jobId, revision)', () => {
  assert.equal(attemptIdFor('job-1', 1), 'job-1-1');
  assert.equal(attemptIdFor('job-1', 2), 'job-1-2');
  assert.notEqual(attemptIdFor('job-1', 1), attemptIdFor('job-1', 2));
});

test('job and attempt state machines only allow the documented transitions', () => {
  assert.equal(canTransitionJob('queued', 'running'), true);
  assert.equal(canTransitionJob('running', 'ready'), true);
  assert.equal(canTransitionJob('ready', 'queued'), true, 'amendment re-queues a settled job');
  assert.equal(canTransitionJob('cancelled', 'queued'), false, 'cancelled is terminal');
  assert.equal(canTransitionAttempt('queued', 'running'), true);
  assert.equal(canTransitionAttempt('running', 'completed'), true);
  assert.equal(canTransitionAttempt('running', 'superseded'), true);
  assert.equal(canTransitionAttempt('superseded', 'completed'), false);
  assert.equal(canTransitionAttempt('cancelled', 'running'), false);
  assert.equal(canCancelJob({status: 'ready'}), true);
  assert.equal(canCancelJob({status: 'cancelled'}), false);
  assert.equal(canAmendJob({status: 'failed'}), true);
  assert.equal(canAmendJob({status: 'cancelled'}), false);
});

test('revision fence and attempt disposition decide who may finish a job', () => {
  assert.doesNotThrow(() => assertExpectedRevision({revision: 3}, 3));
  assert.throws(() => assertExpectedRevision({revision: 3}, 2), hasCode('REVISION_MISMATCH'));
  assert.equal(attemptDisposition(job(), attempt()), 'current');
  assert.equal(attemptDisposition(job({status: 'cancelled'}), attempt()), 'cancelled');
  assert.equal(attemptDisposition(job(), attempt({status: 'cancelled'})), 'cancelled');
  assert.equal(attemptDisposition(job({currentAttemptId: 'job-1-2'}), attempt()), 'superseded',
    'an older attempt may never overwrite the current one');
  assert.equal(attemptDisposition(job({revision: 2}), attempt()), 'superseded');
});

test('only a sealed, verified artifact of the current job/attempt may make it ready', () => {
  const sealed = {state: 'sealed', jobId: 'job-1', attemptId: 'job-1-1', revision: 1};
  assert.equal(sealedArtifactMatches(sealed, job(), attempt(), true), true);
  assert.equal(sealedArtifactMatches(sealed, job(), attempt(), false), false, 'unverified is never success');
  assert.equal(sealedArtifactMatches({...sealed, state: 'writing'}, job(), attempt(), true), false);
  assert.equal(sealedArtifactMatches({...sealed, state: 'unknown'}, job(), attempt(), true), false);
  assert.equal(sealedArtifactMatches({...sealed, state: 'failed'}, job(), attempt(), true), false);
  assert.equal(sealedArtifactMatches({...sealed, jobId: 'other'}, job(), attempt(), true), false);
  assert.equal(sealedArtifactMatches({...sealed, attemptId: 'job-1-2'}, job(), attempt(), true), false);
  assert.equal(sealedArtifactMatches({...sealed, revision: 0}, job(), attempt(), true), false);
});

test('job commands parse before touching the store and query ids are opaque', async () => {
  const calls: string[] = [];
  let lastStart: unknown;
  const store: JobStore = {
    async start(command) { calls.push('start'); lastStart = command; return {jobId: 'job-1', revision: 1, attemptId: 'job-1-1'}; },
    async amend() { calls.push('amend'); return {jobId: 'job-1', revision: 2, attemptId: 'job-1-2'}; },
    async cancel() { calls.push('cancel'); return {jobId: 'job-1', status: 'cancelled'}; },
    async get(id) { calls.push(`get:${id}`); return job({id}); },
    async attempts(id) { calls.push(`attempts:${id}`); return [attempt()]; },
    async artifact(id) { calls.push(`artifact:${id}`); return undefined; },
  };
  const commands = jobCommands(store);
  await assert.rejects(commands.start(null), hasCode('INVALID_COMMAND'));
  await assert.rejects(commands.amend({}), hasCode('INVALID_COMMAND'));
  await assert.rejects(commands.cancel({}), hasCode('INVALID_COMMAND'));
  assert.deepEqual(calls, [], 'invalid input never reaches the store');
  assert.deepEqual(await commands.start(start()), {jobId: 'job-1', revision: 1, attemptId: 'job-1-1'});
  assert.deepEqual(lastStart, {
    requestId: 'start:1', title: '写一份方案', prompt: '给我一份方案', requirements: ['包含预算'], sourceChatId: '2',
  });
  assert.deepEqual(await commands.amend(amend()), {jobId: 'job-1', revision: 2, attemptId: 'job-1-2'});
  assert.deepEqual(await commands.cancel(cancel()), {jobId: 'job-1', status: 'cancelled'});
  assert.equal(await commands.get(''), undefined);
  assert.deepEqual(await commands.attempts('../bad'), []);
  assert.equal(await commands.artifact(''), undefined);
  assert.deepEqual(calls, ['start', 'amend', 'cancel'], 'invalid query ids do no IO');
  assert.equal((await commands.get('job-1'))?.id, 'job-1');
});

/* -------------------------------------------------------------------------- */
/* Runtime integration: faux model + tools + attempt task                      */
/* -------------------------------------------------------------------------- */

function provider(responses: FauxResponseStep[]) {
  const faux = fauxProvider({tokensPerSecond: 100000});
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const binding: ModelBinding = {models, model: {provider: 'faux', modelId: 'faux-1'}};
  return {faux, binding};
}

async function runtimeFixture(t: TestContext, responses: FauxResponseStep[]) {
  const dir = await mkdtemp(join(tmpdir(), 'point-job-'));
  const p = provider(responses);
  const runtime = await openRuntime(dir, p.binding);
  t.after(async () => { await runtime.close(); await rm(dir, {recursive: true, force: true}); });
  return {runtime, faux: p.faux, dir};
}

const toolStep = (name: string, content: string): FauxResponseStep =>
  fauxAssistantMessage([fauxToolCall('save_artifact', {name, content})], {stopReason: 'toolUse'});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return {promise, release};
}

async function waitForJob(runtime: Runtime, jobId: string, expected: readonly Job['status'][], timeoutMs = 15000): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await runtime.jobs.get(jobId);
    if (current && expected.includes(current.status)) return current;
    if (Date.now() > deadline) assert.fail(`job ${jobId} stayed ${current?.status ?? 'missing'}`);
    await delay(5);
  }
}

async function waitForAttempt(runtime: Runtime, jobId: string, status: Attempt['status'], timeoutMs = 10000): Promise<Attempt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempts = await runtime.jobs.attempts(jobId);
    const found = attempts.find(item => item.status === status);
    if (found) return found;
    if (Date.now() > deadline) assert.fail(`no attempt reached ${status}`);
    await delay(5);
  }
}

let sourceChatSequence = 0;
async function source(runtime: Runtime, name = '来源') {
  sourceChatSequence += 1;
  return runtime.chats.create({requestId: `source-chat-${sourceChatSequence}`, name});
}

test('start runs one attempt: save_artifact seals a verified file and the final answer makes the job ready', {timeout: 30000}, async t => {
  const content = '# Plan\n\n预算五千\n';
  const f = await runtimeFixture(t, [toolStep('plan.md', content), fauxAssistantMessage('最终回答：方案已完成')]);
  const chat = await source(f.runtime);
  const started = await f.runtime.jobs.start({
    requestId: 'start:1', title: '写方案', prompt: '请产出方案', requirements: ['包含预算'], sourceChatId: chat.id,
  });
  assert.deepEqual([started.revision, started.attemptId], [1, `${started.jobId}-1`]);

  const ready = await waitForJob(f.runtime, started.jobId, ['ready']);
  assert.equal(ready.result, '最终回答：方案已完成');
  assert.ok(ready.artifactId);
  assert.equal(ready.currentAttemptId, started.attemptId);
  const attempts = await f.runtime.jobs.attempts(started.jobId);
  assert.equal(attempts.length, 1);
  const attempt = attempts[0]!;
  assert.deepEqual([attempt.id, attempt.status, attempt.result, attempt.artifactId],
    [started.attemptId, 'completed', ready.result, ready.artifactId]);

  const view = await f.runtime.jobs.artifact(ready.artifactId);
  assert.ok(view);
  assert.equal(view.verified, true);
  assert.equal(view.artifact.state, 'sealed');
  assert.equal(view.artifact.jobId, started.jobId);
  assert.equal(view.artifact.attemptId, started.attemptId);
  assert.equal(view.artifact.sha256, createHash('sha256').update(content, 'utf8').digest('hex'));
  assert.equal(view.artifact.bytes, Buffer.byteLength(content));
  assert.equal(view.artifact.path,
    artifactPath(workspaceDir(f.dir), started.jobId, started.attemptId, ready.artifactId!, 'plan.md'));
  assert.equal(await readFile(view.artifact.path, 'utf8'), content);
  assert.equal(f.faux.state.callCount, 2, 'one tool round plus the final answer');

  // Tampering after sealing is reported, never hidden or "repaired".
  const { writeFile } = await import('node:fs/promises');
  await writeFile(view.artifact.path, 'tampered');
  const tampered = await f.runtime.jobs.artifact(ready.artifactId);
  assert.deepEqual([tampered?.verified, tampered?.reason], [false, 'HASH_MISMATCH']);
  assert.equal(tampered?.artifact.state, 'sealed');
});

test('a final answer without a sealed artifact fails the attempt and the job instead of going ready', {timeout: 30000}, async t => {
  const f = await runtimeFixture(t, [fauxAssistantMessage('只回答，不产出文件')]);
  const chat = await source(f.runtime);
  const started = await f.runtime.jobs.start({
    requestId: 'start:no-artifact', title: '无产物任务', prompt: '随便聊聊', sourceChatId: chat.id,
  });
  const failed = await waitForJob(f.runtime, started.jobId, ['failed']);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'ARTIFACT_REQUIRED');
  assert.equal(failed.result, null);
  assert.equal(failed.artifactId, null);
  const attempt = (await f.runtime.jobs.attempts(started.jobId))[0]!;
  assert.deepEqual([attempt.status, attempt.error, attempt.artifactId], ['failed', 'ARTIFACT_REQUIRED', null]);
});

test('amend creates a new revision/attempt, supersedes the old one and never lets the old result win', {timeout: 40000}, async t => {
  const f = await runtimeFixture(t, [
    toolStep('v1.md', 'version one'), fauxAssistantMessage('第一版回答'),
    toolStep('v2.md', 'version two'), fauxAssistantMessage('第二版回答'),
  ]);
  const chat = await source(f.runtime);
  const started = await f.runtime.jobs.start({
    requestId: 'start:1', title: '写方案', prompt: '第一版', sourceChatId: chat.id,
  });
  const firstReady = await waitForJob(f.runtime, started.jobId, ['ready']);
  const firstArtifact = firstReady.artifactId!;

  const amended = await f.runtime.jobs.amend({
    requestId: 'amend:1', jobId: started.jobId, expectedRevision: 1, prompt: '第二版', requirements: ['新要求'],
  });
  assert.deepEqual([amended.revision, amended.attemptId], [2, `${started.jobId}-2`]);
  const secondReady = await waitForJob(f.runtime, started.jobId, ['ready']);
  assert.deepEqual([secondReady.revision, secondReady.result, secondReady.currentAttemptId],
    [2, '第二版回答', amended.attemptId]);
  assert.notEqual(secondReady.artifactId, firstArtifact);

  const attempts = await f.runtime.jobs.attempts(started.jobId);
  assert.equal(attempts.length, 2);
  assert.deepEqual([attempts[0]?.id, attempts[0]?.status, attempts[0]?.result],
    [started.attemptId, 'superseded', '第一版回答'], 'the old attempt keeps its result for audit');
  assert.deepEqual([attempts[1]?.status, attempts[1]?.result], ['completed', '第二版回答']);
  assert.equal(attempts[0]?.artifactId, firstArtifact);

  // A superseded attempt's artifact stays verifiable evidence.
  const oldView = await f.runtime.jobs.artifact(firstArtifact);
  assert.deepEqual([oldView?.verified, oldView?.artifact.state], [true, 'sealed']);

  // Replays and revision fences at the command boundary.
  assert.deepEqual(await f.runtime.jobs.amend({
    requestId: 'amend:1', jobId: started.jobId, expectedRevision: 1, prompt: '第二版', requirements: ['新要求'],
  }), amended);
  await assert.rejects(f.runtime.jobs.amend({
    requestId: 'amend:1', jobId: started.jobId, expectedRevision: 1, prompt: '另一版',
  }), hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(f.runtime.jobs.amend({
    requestId: 'amend:stale', jobId: started.jobId, expectedRevision: 1, prompt: '第三版',
  }), hasCode('REVISION_MISMATCH'));
});

test('amending while the old attempt is in flight supersedes it without overwriting the new result', {timeout: 40000}, async t => {
  const entered = gate();
  const release = gate();
  const f = await runtimeFixture(t, [
    async () => { entered.release(); await release.promise; return fauxAssistantMessage('旧版回答'); },
    toolStep('new.md', 'new version'), fauxAssistantMessage('新版回答'),
  ]);
  const chat = await source(f.runtime);
  const started = await f.runtime.jobs.start({
    requestId: 'start:race', title: '竞态任务', prompt: '第一版', sourceChatId: chat.id,
  });
  await entered.promise;
  const amended = await f.runtime.jobs.amend({
    requestId: 'amend:race', jobId: started.jobId, expectedRevision: 1, requirements: ['新要求'],
  });
  release.release();
  const ready = await waitForJob(f.runtime, started.jobId, ['ready']);
  assert.deepEqual([ready.revision, ready.result, ready.currentAttemptId], [2, '新版回答', amended.attemptId]);
  const attempts = await f.runtime.jobs.attempts(started.jobId);
  assert.deepEqual([attempts[0]?.status, attempts[0]?.result], ['superseded', null],
    'the stale attempt never commits a result over the new revision');
  assert.deepEqual([attempts[1]?.status, attempts[1]?.result], ['completed', '新版回答']);
  assert.equal(f.faux.state.callCount, 3);
});

test('cancel propagates to the attempt, never produces a result and keeps sealed evidence readable', {timeout: 30000}, async t => {
  const entered = gate();
  const release = gate();
  const f = await runtimeFixture(t, [async () => { entered.release(); await release.promise; return fauxAssistantMessage('不该成功'); }]);
  const chat = await source(f.runtime);
  const started = await f.runtime.jobs.start({
    requestId: 'start:cancel', title: '取消任务', prompt: '产出', sourceChatId: chat.id,
  });
  await entered.promise;
  assert.deepEqual(await f.runtime.jobs.cancel({
    requestId: 'cancel:1', jobId: started.jobId, expectedRevision: 1,
  }), {jobId: started.jobId, status: 'cancelled'});
  release.release();
  await waitForAttempt(f.runtime, started.jobId, 'cancelled');
  const cancelled = (await f.runtime.jobs.get(started.jobId))!;
  assert.deepEqual([cancelled.status, cancelled.result, cancelled.artifactId],
    ['cancelled', null, null]);
  const attempt = (await f.runtime.jobs.attempts(started.jobId))[0]!;
  assert.deepEqual([attempt.status, attempt.result, attempt.artifactId], ['cancelled', null, null]);
  // Repeating the same request replays; a new key on an already cancelled job is an idempotent no-op.
  assert.deepEqual(await f.runtime.jobs.cancel({
    requestId: 'cancel:1', jobId: started.jobId, expectedRevision: 1,
  }), {jobId: started.jobId, status: 'cancelled'});
  assert.deepEqual(await f.runtime.jobs.cancel({
    requestId: 'cancel:2', jobId: started.jobId, expectedRevision: 1,
  }), {jobId: started.jobId, status: 'cancelled'});
  await assert.rejects(f.runtime.jobs.amend({
    requestId: 'amend:after-cancel', jobId: started.jobId, expectedRevision: 1, prompt: '还想改',
  }), hasCode('JOB_TERMINAL'));
  await assert.rejects(f.runtime.jobs.cancel({
    requestId: 'cancel:stale', jobId: started.jobId, expectedRevision: 2,
  }), hasCode('REVISION_MISMATCH'));
  assert.equal(await readdir(join(f.dir, 'workspace', 'jobs', started.jobId)).catch(() => 'missing'), 'missing');
});

test('start/amend/cancel are idempotent per receipt key and strict about input and chat identity', {timeout: 40000}, async t => {
  const f = await runtimeFixture(t, [
    toolStep('a.md', 'A'), fauxAssistantMessage('A done'),
    toolStep('b.md', 'B'), fauxAssistantMessage('B done'),
  ]);
  const chat = await source(f.runtime);
  const input = {requestId: 'start:same', title: '任务', prompt: '产出文件', sourceChatId: chat.id};
  const first = await f.runtime.jobs.start(input);
  assert.deepEqual(await f.runtime.jobs.start(input), first, 'the same key and content replays the first result');
  await assert.rejects(f.runtime.jobs.start({...input, title: '另一件事'}), hasCode('IDEMPOTENCY_CONFLICT'));
  // Finish the first attempt before starting another: the faux response queue is global to the provider.
  await waitForJob(f.runtime, first.jobId, ['ready']);
  // The start receipt key includes the source chat, so another chat may reuse the same requestId.
  const otherChat = await f.runtime.chats.create({requestId: 'source-chat-b', name: '另一来源'});
  const second = await f.runtime.jobs.start({...input, sourceChatId: otherChat.id});
  assert.notEqual(second.jobId, first.jobId);
  await waitForJob(f.runtime, second.jobId, ['ready']);
  assert.notEqual((await f.runtime.jobs.get(first.jobId))?.artifactId,
    (await f.runtime.jobs.get(second.jobId))?.artifactId);

  for (const invalid of [null, [], {}, {...input, title: ''}, {...input, extra: true},
    {...input, requestId: 'bad id'}, {...input, requirements: 'x'}]) {
    await assert.rejects(f.runtime.jobs.start(invalid), hasCode('INVALID_COMMAND'));
  }
  await assert.rejects(f.runtime.jobs.start({...input, requestId: 'missing-chat', sourceChatId: '999999'}),
    hasCode('CHAT_NOT_FOUND'));
  await assert.rejects(f.runtime.jobs.cancel({requestId: 'cancel:missing', jobId: 'missing-job', expectedRevision: 1}),
    hasCode('JOB_NOT_FOUND'));
  await assert.rejects(f.runtime.jobs.amend({requestId: 'amend:missing', jobId: 'missing-job', expectedRevision: 1, prompt: 'x'}),
    hasCode('JOB_NOT_FOUND'));
  assert.equal(await f.runtime.jobs.get('missing-job'), undefined);
  assert.deepEqual(await f.runtime.jobs.attempts('missing-job'), []);
  assert.equal(await f.runtime.jobs.artifact('missing-artifact'), undefined);

  // A read-only host without a model fails closed instead of silently starting.
  const dir = await mkdtemp(join(tmpdir(), 'point-job-nomodel-'));
  const readOnly = await openRuntime(dir);
  try {
    const chatWithoutModel = await readOnly.chats.create({requestId: 'chat', name: '无模型'});
    await assert.rejects(readOnly.jobs.start({...input, requestId: 'no-model', sourceChatId: chatWithoutModel.id}),
      /MODEL_NOT_CONFIGURED/);
  } finally {
    await readOnly.close();
    await rm(dir, {recursive: true, force: true});
  }
});

test('SIGKILL during an in-flight model call resumes the same attempt without replay or fake success', {timeout: 40000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-job-crash-'));
  const child = fork(new URL('./fixtures/job-crash.js', import.meta.url), [dir, 'model-pending'], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const exited = once(child, 'exit');
  try {
    let started: {jobId: string; attemptId: string} | undefined;
    const identity = await new Promise<{jobId: string; attemptId: string}>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`crash fixture timed out: ${stderr}`)), 25000);
      child.on('message', (message: unknown) => {
        const event = message as {event?: string; jobId?: string; attemptId?: string};
        if (event.event === 'started' && event.jobId && event.attemptId) started = {jobId: event.jobId, attemptId: event.attemptId};
        if (event.event === 'model-requested' && started) {
          clearTimeout(timer);
          resolve(started);
        }
      });
      child.once('exit', () => reject(new Error(`crash fixture exited before the model request: ${stderr}`)));
    });
    child.kill('SIGKILL');
    await exited;

    const faux = fauxProvider({tokensPerSecond: 100000});
    faux.setResponses([]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = await openRuntime(dir, {models, model: {provider: 'faux', modelId: 'faux-1'}});
    try {
      const job = await waitForJob(runtime, identity.jobId, ['failed', 'ready', 'cancelled']);
      assert.equal(job.status, 'failed', 'an unresolved in-flight model call is never faked as success');
      assert.deepEqual([job.result, job.artifactId], [null, null]);
      const attempts = await runtime.jobs.attempts(identity.jobId);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]?.id, identity.attemptId, 'recovery reuses the same attempt identity');
      assert.equal(attempts[0]?.status, 'failed');
      assert.equal(faux.state.callCount, 0, 'the guarded model call is not replayed after restart');
      assert.equal(await readdir(join(dir, 'workspace', 'jobs', identity.jobId)).catch(() => 'missing'), 'missing',
        'a failed attempt produces no artifact');
    } finally {
      await runtime.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(dir, {recursive: true, force: true});
  }
});

test('amend and cancel may share one requestId without colliding receipts', {timeout: 40000}, async t => {
  const f = await runtimeFixture(t, [
    toolStep('v1.md', 'one'), fauxAssistantMessage('一版'),
    toolStep('v2.md', 'two'), fauxAssistantMessage('二版'),
  ]);
  const chat = await source(f.runtime);
  const started = await f.runtime.jobs.start({
    requestId: 'start:shared', title: '共享 requestId', prompt: '版本一', sourceChatId: chat.id,
  });
  await waitForJob(f.runtime, started.jobId, ['ready']);
  const amended = await f.runtime.jobs.amend({
    requestId: 'shared-key', jobId: started.jobId, expectedRevision: 1, prompt: '版本二',
  });
  await waitForJob(f.runtime, started.jobId, ['ready']);
  assert.equal((await f.runtime.jobs.get(started.jobId))?.revision, 2);
  const cancelled = await f.runtime.jobs.cancel({
    requestId: 'shared-key', jobId: started.jobId, expectedRevision: 2,
  });
  assert.deepEqual(cancelled, {jobId: started.jobId, status: 'cancelled'});
  // Each command key replays its own first result: neither receipt shadows the other.
  assert.deepEqual(await f.runtime.jobs.amend({
    requestId: 'shared-key', jobId: started.jobId, expectedRevision: 1, prompt: '版本二',
  }), amended);
  assert.deepEqual(await f.runtime.jobs.cancel({
    requestId: 'shared-key', jobId: started.jobId, expectedRevision: 2,
  }), cancelled);
});

test('cancel keeps a completed attempt intact and leaves its sealed artifact verifiable', {timeout: 40000}, async t => {
  const f = await runtimeFixture(t, [toolStep('done.md', 'done'), fauxAssistantMessage('完成回答')]);
  const chat = await source(f.runtime);
  const started = await f.runtime.jobs.start({
    requestId: 'start:cancel-ready', title: '完成后取消', prompt: '产出', sourceChatId: chat.id,
  });
  const ready = await waitForJob(f.runtime, started.jobId, ['ready']);
  const before = (await f.runtime.jobs.attempts(started.jobId))[0]!;
  assert.equal(before.status, 'completed');
  assert.deepEqual(await f.runtime.jobs.cancel({
    requestId: 'cancel:ready', jobId: started.jobId, expectedRevision: 1,
  }), {jobId: started.jobId, status: 'cancelled'});
  const after = (await f.runtime.jobs.attempts(started.jobId))[0]!;
  assert.deepEqual([after.status, after.result, after.artifactId, after.endedAt],
    ['completed', before.result, before.artifactId, before.endedAt],
    'cancelling a settled job does not rewrite the completed attempt');
  const cancelledJob = (await f.runtime.jobs.get(started.jobId))!;
  assert.equal(cancelledJob.status, 'cancelled');
  assert.deepEqual([cancelledJob.result, cancelledJob.artifactId], [ready.result, ready.artifactId],
    'cancelling keeps the settled result and artifact reference for audit');
  const view = await f.runtime.jobs.artifact(ready.artifactId!);
  assert.deepEqual([view?.verified, view?.artifact.state], [true, 'sealed']);
});

test('cancel leaves a failed attempt failed with its stable error', {timeout: 30000}, async t => {
  const f = await runtimeFixture(t, [fauxAssistantMessage('没有产物')]);
  const chat = await source(f.runtime);
  const started = await f.runtime.jobs.start({
    requestId: 'start:cancel-failed', title: '失败后取消', prompt: '产出', sourceChatId: chat.id,
  });
  const failed = await waitForJob(f.runtime, started.jobId, ['failed']);
  assert.equal(failed.error, 'ARTIFACT_REQUIRED');
  await f.runtime.jobs.cancel({requestId: 'cancel:failed', jobId: started.jobId, expectedRevision: 1});
  const attempt = (await f.runtime.jobs.attempts(started.jobId))[0]!;
  assert.deepEqual([attempt.status, attempt.error], ['failed', 'ARTIFACT_REQUIRED'],
    'cancelling a failed job does not rewrite the failed attempt');
  assert.equal((await f.runtime.jobs.get(started.jobId))?.status, 'cancelled');
});
