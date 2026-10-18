import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { fork, spawn } from 'node:child_process';
import { api, delay } from '../src/util.mjs';
import { ROOT, RUN_DIR, launch, stop, get, post, until, jobDone, faultReached, cli } from './helpers.mjs';

const evidence = [];
const rounds = Number(process.env.POINT_CRASH_ROUNDS ?? 10);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 30) throw new Error('POINT_CRASH_ROUNDS must be 1..30');
function scenario(name, fn, timeout = 60000) {
  test(name, { timeout }, async t => {
    const started = Date.now();
    const details = {};
    try { await fn(t, details); evidence.push({ name, status: 'passed', ms: Date.now() - started, ...details }); }
    catch (error) { evidence.push({ name, status: 'failed', error: error.message, ...details }); throw error; }
  });
}
after(async () => {
  const report = { version: '1.3.0', model: 'faux/faux-1', crashRoundsPerPoint: rounds, runDirectory: RUN_DIR, tests: evidence };
  await writeFile(join(RUN_DIR, 'results.json'), JSON.stringify(report, null, 2));
  await mkdir(join(ROOT, 'runtime'), { recursive: true });
  await writeFile(join(ROOT, 'runtime/latest-results.json'), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${join(RUN_DIR, 'results.json')}`);
});

scenario('CLI uses real tools, deduplicates input, and retains preferences/history after SIGKILL', async (t, details) => {
  let daemon = await launch(t);
  await cli(daemon, 'chat', '/file 来自真实 write 工具');
  assert.equal(await readFile(join(daemon.directory, 'workspace/from-agent.txt'), 'utf8'), '来自真实 write 工具');
  await cli(daemon, 'chat', '/remember 回答风格=简洁');
  const first = await cli(daemon, '--request-id', 'repeat-chat', 'chat', '你好');
  const repeated = await cli(daemon, '--request-id', 'repeat-chat', 'chat', '你好');
  assert.equal(first.submissionId, repeated.submissionId);
  const originalRoot = (await get(daemon)).rootId;
  await stop(daemon, 'SIGKILL');
  daemon = await launch(t, { directory: daemon.directory });
  const preferences = await cli(daemon, 'chat', '/preferences');
  assert.match(preferences.text, /简洁/);
  assert.equal((await get(daemon)).rootId, originalRoot);
  assert((await get(daemon, '/history')).some(entry => entry.kind === 'pi.assistant'));
  details.submissionId = first.submissionId;
});

scenario('CLI exits while background work continues and main chat remains usable', async (t, details) => {
  const daemon = await launch(t);
  const job = await cli(daemon, '--delay', '350', 'start', '比较三个测试方案');
  assert.notEqual((await get(daemon, `/jobs/${job.id}`)).status, 'done');
  const answer = await cli(daemon, 'chat', '后台工作时还能聊天吗');
  assert.match(answer.text, /还能聊天/);
  assert.notEqual((await get(daemon, `/jobs/${job.id}`)).status, 'done');
  const completed = await jobDone(daemon, job.id);
  assert.match(await readFile(join(daemon.directory, 'workspace', completed.artifact), 'utf8'), /三个测试方案/);
  const reused = await post(daemon, '/jobs', { prompt: '去重测试', requestId: 'same-job', delayMs: 0 });
  const again = await post(daemon, '/jobs', { prompt: '去重测试', requestId: 'same-job', delayMs: 0 });
  assert.equal(reused.id, again.id);
  details.jobId = job.id;
});

scenario('A revision reuses its child conversation and only publishes the newest answer', async (t, details) => {
  const daemon = await launch(t);
  const job = await post(daemon, '/jobs', { prompt: '整理比较报告', delayMs: 180 });
  await until(() => get(daemon, `/jobs/${job.id}`), value => value.status === 'running');
  await cli(daemon, 'amend', job.id, '更关注隐私设计');
  const completed = await jobDone(daemon, job.id);
  assert.equal(completed.revision, 2);
  assert.equal(completed.conversationId, job.conversationId);
  assert.match(completed.result, /更关注隐私设计/);
  const reports = (await get(daemon, '/history')).filter(entry => entry.kind === 'point.result' && entry.data.jobId === job.id);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].data.revision, 2);
  details.conversationId = job.conversationId;
});

scenario('Stopping main chat preserves background jobs; cancelling one job leaves another alone', async t => {
  const daemon = await launch(t);
  const first = await post(daemon, '/jobs', { prompt: '将被取消的任务', delayMs: 1000 });
  const second = await post(daemon, '/jobs', { prompt: '独立任务', delayMs: 250 });
  const answering = post(daemon, '/chat', { text: '/slow' });
  await until(() => get(daemon, '/history'), entries => entries.some(entry => entry.model?.some(message => message.content?.some?.(part => part.type === 'toolCall' && part.name === 'pause'))));
  await post(daemon, '/chat/stop', {});
  assert.equal((await answering).status, 'unanswered');
  assert.notEqual((await get(daemon, `/jobs/${first.id}`)).status, 'cancelled');
  await cli(daemon, 'cancel', first.id);
  await jobDone(daemon, second.id);
  assert.equal((await get(daemon, `/jobs/${first.id}`)).status, 'cancelled');
  assert(!(await get(daemon, '/history')).some(entry => entry.kind === 'point.result' && entry.data.jobId === first.id));
});

scenario('A timer missed during downtime catches up once and remains done after another restart', async (t, details) => {
  let daemon = await launch(t);
  const job = await post(daemon, '/jobs', { prompt: '需要跟进', delayMs: 0, followupAfterMs: 250 });
  await jobDone(daemon, job.id);
  await stop(daemon, 'SIGKILL');
  await delay(320);
  daemon = await launch(t, { directory: daemon.directory });
  const followed = await until(() => get(daemon, `/jobs/${job.id}`), value => value.followup?.status === 'done');
  const wakeHistory = await get(daemon, `/history?conversation=${followed.followup.conversationId}`);
  assert(wakeHistory.some(entry => entry.kind === 'pi.user'));
  assert(wakeHistory.some(entry => entry.kind === 'pi.assistant'));
  await stop(daemon, 'SIGKILL');
  daemon = await launch(t, { directory: daemon.directory });
  const reminders = (await get(daemon, '/history')).filter(entry => entry.kind === 'point.followup' && entry.data.jobId === job.id);
  assert.equal(reminders.length, 1);
  assert(reminders[0].data.answerEntry);
  details.reminderCount = reminders.length;
});

scenario('Rescheduling invalidates the old timer; cancellation survives restart', async t => {
  let daemon = await launch(t);
  const job = await post(daemon, '/jobs', { prompt: '改期测试', delayMs: 0, followupAfterMs: 180 });
  await jobDone(daemon, job.id);
  const updated = await cli(daemon, 'after', job.id, '600');
  await delay(240);
  assert(!(await get(daemon, '/history')).some(entry => entry.kind === 'point.followup'));
  assert.equal((await get(daemon, `/jobs/${job.id}`)).followup.taskId, updated.followup.taskId);
  await cli(daemon, 'cancel', job.id);
  await stop(daemon, 'SIGKILL');
  await delay(650);
  daemon = await launch(t, { directory: daemon.directory });
  assert(!(await get(daemon, '/history')).some(entry => entry.kind === 'point.followup'));
});

scenario('SIGKILL at tool/model/artifact/report boundaries recovers the same work without duplicate reports', async (t, details) => {
  details.cases = [];
  for (const point of ['tool-after-effect', 'after-model', 'after-artifact', 'before-report']) {
    for (let round = 0; round < rounds; round++) {
      let daemon = await launch(t, { fault: point });
      const job = await post(daemon, '/jobs', { prompt: `恢复 ${point} ${round}`, delayMs: 0, requestId: 'original' });
      await faultReached(daemon, point);
      await stop(daemon, 'SIGKILL');
      daemon = await launch(t, { directory: daemon.directory });
      const again = await post(daemon, '/jobs', { prompt: '客户端重试', requestId: 'original' });
      assert.equal(again.id, job.id);
      const completed = await jobDone(daemon, job.id);
      assert.equal(completed.workerId, job.workerId);
      assert.equal(completed.conversationId, job.conversationId);
      assert.equal((await get(daemon, '/history')).filter(entry => entry.kind === 'point.result' && entry.data.jobId === job.id).length, 1);
      assert.match(await readFile(join(daemon.directory, 'workspace', completed.artifact), 'utf8'), /恢复/);
      assert.deepEqual((await get(daemon)).reports, []);
      details.cases.push({ point, round: round + 1, jobId: job.id, workerId: job.workerId, reports: 1 });
      await stop(daemon);
    }
  }
}, 120000);

scenario('Idempotent receiver keeps one external effect after crash between effect and acknowledgement', async (t, details) => {
  const sink = await launch(t, { script: 'sink.mjs' });
  details.cases = [];
  for (let round = 0; round < rounds; round++) {
    let daemon = await launch(t, { sink, fault: 'after-effect' });
    const job = await post(daemon, '/jobs', { prompt: '模拟投递结果', delayMs: 0 });
    await faultReached(daemon, 'after-effect');
    await stop(daemon, 'SIGKILL');
    daemon = await launch(t, { sink, directory: daemon.directory });
    const completed = await jobDone(daemon, job.id);
    const ledger = await api(sink.url + '/deliveries');
    const requests = ledger.requests.filter(row => row.key === job.delivery.key);
    const effects = ledger.effects.filter(row => row.key === job.delivery.key);
    assert.equal(requests.length, 2);
    assert.equal(effects.length, 1);
    assert.equal(completed.delivery.attempts, 2);
    details.cases.push({ round: round + 1, requests: requests.length, effects: effects.length });
    await stop(daemon);
  }
}, 120000);

scenario('Unsafe delivery becomes unknown after crash and does not silently send again', async (t, details) => {
  const sink = await launch(t, { script: 'sink.mjs', extra: ['--no-idempotency'] });
  let daemon = await launch(t, { sink, unsafe: true, fault: 'after-effect' });
  const job = await post(daemon, '/jobs', { prompt: '无法幂等的外部投递', delayMs: 0 });
  await faultReached(daemon, 'after-effect');
  await stop(daemon, 'SIGKILL');
  daemon = await launch(t, { sink, unsafe: true, directory: daemon.directory });
  await until(() => get(daemon, `/jobs/${job.id}`), value => value.status === 'unknown');
  const ledger = await api(sink.url + '/deliveries');
  assert.equal(ledger.requests.length, 1);
  assert.equal(ledger.effects.length, 1);
  assert(!(await get(daemon, '/history')).some(entry => entry.kind === 'point.result'));
  details.externalRequests = 1;
  details.deliveryStatus = 'unknown';
});

scenario('State stream reconnects from a snapshot; duplicate data-directory owners are rejected', async t => {
  const daemon = await launch(t);
  const abort = new AbortController();
  const response = await fetch(daemon.url + '/events', { signal: abort.signal });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: state/);
  abort.abort();
  await reader.cancel().catch(() => {});
  const job = await post(daemon, '/jobs', { prompt: '断线后完成的工作', delayMs: 0 });
  await jobDone(daemon, job.id);
  const reconnectedAbort = new AbortController();
  const reconnected = await fetch(daemon.url + '/events', { signal: reconnectedAbort.signal });
  const reconnectedReader = reconnected.body.getReader();
  assert.match(new TextDecoder().decode((await reconnectedReader.read()).value), new RegExp(job.id));
  reconnectedAbort.abort();
  await reconnectedReader.cancel().catch(() => {});
  const second = fork(join(ROOT, 'src/server.mjs'), ['--port', '0', '--data', daemon.directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let error = '';
  second.stderr.on('data', chunk => { error += chunk; });
  const [code] = await once(second, 'exit');
  assert.notEqual(code, 0);
  assert.match(error, /live owner/);
  assert.match((await post(daemon, '/chat', { text: '服务仍可用' })).text, /仍可用/);
});

scenario('Tool failures cannot be turned into a successful job by a confident model answer', async t => {
  const daemon = await launch(t, { extra: ['--fail-step'] });
  const job = await post(daemon, '/jobs', { prompt: '错误工具测试', delayMs: 0 });
  const failed = await until(() => get(daemon, `/jobs/${job.id}`), value => value.status === 'failed');
  assert.match(failed.error, /verified tool receipts/);
  assert(!(await get(daemon, '/history')).some(entry => entry.kind === 'point.result'));
});

scenario('An unreachable receiver leaves delivery unknown rather than reporting success', async t => {
  const daemon = await launch(t, { sink: { url: 'http://127.0.0.1:1' } });
  const job = await post(daemon, '/jobs', { prompt: '无法确认的投递', delayMs: 0 });
  const unknown = await until(() => get(daemon, `/jobs/${job.id}`), value => value.status === 'unknown');
  assert.equal(unknown.delivery.status, 'unknown');
  assert(!(await get(daemon, '/history')).some(entry => entry.kind === 'point.result'));
});

scenario('Interactive CLI receives completion and follow-up events and can quit without stopping the daemon', async t => {
  const daemon = await launch(t);
  const client = spawn(process.execPath, [join(ROOT, 'src/cli.mjs'), '--url', daemon.url], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  client.stdout.on('data', chunk => { output += chunk; });
  client.stderr.on('data', chunk => { output += chunk; });
  t.after(() => { if (client.exitCode === null) client.kill('SIGKILL'); });
  await until(async () => output, value => value.includes('Point Durable CLI'));
  client.stdin.write('/start CLI 持续监听\n');
  const state = await until(() => get(daemon), value => value.jobs.length === 1);
  const job = state.jobs[0];
  await jobDone(daemon, job.id);
  await until(async () => output, value => value.includes('[完成]'));
  await post(daemon, `/jobs/${job.id}/followup`, { afterMs: 30 });
  await until(async () => output, value => value.includes('[跟进]'));
  const exiting = once(client, 'exit');
  client.stdin.write('/quit\n');
  const [code] = await exiting;
  assert.equal(code, 0);
  assert.equal((await get(daemon, '/health')).ok, true);
});
