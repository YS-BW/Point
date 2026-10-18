import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, RUN_DIR, launch, stop, get, post, until, jobDone, faultReached } from './helpers.mjs';
import { delay } from '../src/util.mjs';

const evidence = [];
const rounds = Number(process.env.POINT_CRASH_ROUNDS ?? 10);
const contextText = context => JSON.stringify(context.messages);
const makeChat = (daemon, name, mode = 'fresh', sourceChatId = 'main') => post(daemon, '/chats', { name, mode, sourceChatId });
const say = (daemon, chatId, text) => post(daemon, '/chat', { text, chatId });
async function notified(daemon, id) {
  await jobDone(daemon, id);
  return until(() => get(daemon, `/jobs/${id}`), job => job.notification?.status === 'done');
}
function scenario(name, run, timeout = 60000) {
  test(name, { timeout }, async t => {
    const started = Date.now(), details = {};
    try { await run(t, details); evidence.push({ name, status: 'passed', ms: Date.now() - started, ...details }); }
    catch (error) { evidence.push({ name, status: 'failed', error: error.message }); throw error; }
  });
}
after(async () => {
  const report = { version: '1.3.0', model: 'faux/faux-1', crashRoundsPerPoint: rounds, runDirectory: RUN_DIR, tests: evidence };
  await writeFile(join(RUN_DIR, 'conversation-results.json'), JSON.stringify(report, null, 2));
  await writeFile(join(ROOT, 'runtime/latest-conversation-results.json'), JSON.stringify(report, null, 2));
  console.log(`Conversation evidence: ${join(RUN_DIR, 'conversation-results.json')}`);
});

scenario('Fresh and forked topic chats keep independent contexts and stable identities across restart', async (t, details) => {
  let daemon = await launch(t);
  await say(daemon, 'main', 'FORK_BEFORE_482：旅行目的地是杭州');
  const fork = await makeChat(daemon, '旅行', 'fork');
  const fresh = await makeChat(daemon, '全新话题');
  await say(daemon, 'main', 'FORK_AFTER_615：主会话后续消息');
  await say(daemon, fork.id, 'SIDE_ONLY_759：安排两天行程');
  await say(daemon, fresh.id, 'FRESH_ONLY_951：聊读书');
  const forkContext = contextText(await get(daemon, `/chats/${fork.id}/context`));
  const freshContext = contextText(await get(daemon, `/chats/${fresh.id}/context`));
  const mainContext = contextText(await get(daemon, '/chats/main/context'));
  assert.match(forkContext, /FORK_BEFORE_482/);
  assert.doesNotMatch(forkContext, /FORK_AFTER_615|FRESH_ONLY_951/);
  assert.doesNotMatch(freshContext, /FORK_BEFORE_482|SIDE_ONLY_759/);
  assert.doesNotMatch(mainContext, /SIDE_ONLY_759|FRESH_ONLY_951/);
  await post(daemon, `/chats/${fork.id}/update`, { name: '杭州旅行' });
  await stop(daemon, 'SIGKILL');
  daemon = await launch(t, { directory: daemon.directory });
  const restored = (await get(daemon, '/chats')).find(chat => chat.id === fork.id);
  assert.equal(restored.conversationId, fork.conversationId);
  assert.equal(restored.name, '杭州旅行');
  assert.match(contextText(await get(daemon, `/chats/${fork.id}/context`)), /SIDE_ONLY_759/);
  details.chatId = fork.id;
});

scenario('Explicit shared memory reaches every model context, tracks provenance, and forgets across restart', async t => {
  let daemon = await launch(t);
  const side = await makeChat(daemon, '偏好');
  await say(daemon, 'main', '先建立主对话');
  await post(daemon, '/memory', { key: '城市', value: '杭州', kind: 'preference', chatId: side.id, requestId: 'remember-city' });
  assert.equal((await say(daemon, 'main', '/recall 城市')).text, '杭州');
  assert.equal((await get(daemon, '/memory'))[0].sourceChatId, side.id);
  await post(daemon, '/memory', { key: '城市', value: '苏州', chatId: 'main', requestId: 'correct-city' });
  // Retrying a committed old tool write cannot overwrite the newer correction.
  await post(daemon, '/memory', { key: '城市', value: '杭州', kind: 'preference', chatId: side.id, requestId: 'remember-city' });
  assert.equal((await say(daemon, side.id, '/recall 城市')).text, '苏州');
  await stop(daemon, 'SIGKILL');
  daemon = await launch(t, { directory: daemon.directory });
  assert.equal((await say(daemon, 'main', '/recall 城市')).text, '苏州');
  await post(daemon, '/memory/forget', { key: '城市', requestId: 'forget-city' });
  assert.equal((await say(daemon, side.id, '/recall 城市')).text, '没有保存这项记忆');
  assert.deepEqual(await get(daemon, '/memory'), []);
});

scenario('Topic work inherits its context and delivers model-visible answers to the configured chats', async t => {
  const daemon = await launch(t);
  const side = await makeChat(daemon, '行程');
  await say(daemon, side.id, 'TRIP_CONTEXT_328：带长辈出行，每天少走路');
  const job = await post(daemon, '/jobs', { prompt: '比较两个行程方案', chatId: side.id, delayMs: 10 });
  await say(daemon, 'main', '后台期间仍可交流');
  await notified(daemon, job.id);
  const workerHistory = JSON.stringify(await get(daemon, `/history?conversation=${job.conversationId}`));
  assert.match(workerHistory, /TRIP_CONTEXT_328/);
  assert.match(contextText(await get(daemon, `/chats/${side.id}/context`)), new RegExp(job.id));
  assert.doesNotMatch(contextText(await get(daemon, '/chats/main/context')), new RegExp(job.id));
  const second = await post(daemon, '/jobs', { prompt: 'MAIN_HANDOFF_834：整理最后结论', chatId: side.id, sourceChatId: 'main', delayMs: 0 });
  const completed = await notified(daemon, second.id);
  assert.deepEqual(Object.keys(completed.notification.deliveries).sort(), ['main', side.id].sort());
  assert.match(contextText(await get(daemon, '/chats/main/context')), /MAIN_HANDOFF_834/);
  assert.match(await readFile(join(daemon.directory, 'workspace', completed.artifact), 'utf8'), /MAIN_HANDOFF_834/);
});

scenario('Sharing a topic summarizes the original history and main can continue from its conclusions', async t => {
  const daemon = await launch(t);
  const side = await makeChat(daemon, '采购');
  await say(daemon, side.id, 'DECISION_742：已经决定买 A，B 仅是备选');
  const share = await post(daemon, `/chats/${side.id}/share`, { requestId: 'share-once' });
  const duplicate = await post(daemon, `/chats/${side.id}/share`, { requestId: 'share-once' });
  assert.equal(share.id, duplicate.id);
  await until(() => get(daemon), state => state.shares.find(item => item.id === share.id)?.status === 'done');
  const main = await get(daemon, '/chats/main/context');
  assert.match(contextText(main), /DECISION_742/);
  assert(main.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('DECISION_742')));
  assert.deepEqual(await get(daemon, '/memory'), []);
});

scenario('Archiving preserves work and routes later results and follow-ups to main; restoration retains history', async t => {
  const daemon = await launch(t);
  const side = await makeChat(daemon, '归档中的工作');
  await say(daemon, side.id, 'ARCHIVE_HISTORY_456');
  const job = await post(daemon, '/jobs', { prompt: '归档后继续完成', chatId: side.id, delayMs: 150, followupAfterMs: 80 });
  await post(daemon, `/chats/${side.id}/update`, { status: 'archived' });
  await assert.rejects(say(daemon, side.id, '不应进入归档会话'), /archived/);
  await assert.rejects(post(daemon, '/chats/main/update', { status: 'archived' }), /stays active/);
  const completed = await notified(daemon, job.id);
  assert.deepEqual(Object.keys(completed.notification.deliveries), ['main']);
  await until(() => get(daemon, `/jobs/${job.id}`), item => item.followup?.status === 'done');
  const rootHistory = await get(daemon, '/history');
  assert(rootHistory.some(entry => entry.kind === 'point.followup' && entry.model?.length));
  await post(daemon, `/chats/${side.id}/update`, { status: 'active' });
  assert.match(contextText(await get(daemon, `/chats/${side.id}/context`)), /ARCHIVE_HISTORY_456/);
  assert.equal((await say(daemon, side.id, '继续这个主题')).status, 'done');
});

scenario('Model tools create persistent chats without copying an unfinished tool call', async t => {
  const daemon = await launch(t);
  await say(daemon, 'main', 'MODEL_FORK_682：前置背景');
  const reply = await say(daemon, 'main', '/fork 模型创建的侧聊');
  const chat = JSON.parse(reply.text);
  assert.equal(chat.mode, 'fork');
  const context = await get(daemon, `/chats/${chat.id}/context`);
  assert.match(contextText(context), /MODEL_FORK_682/);
  assert(!context.messages.some(message => message.role === 'assistant' && message.content?.some?.(part => part.type === 'toolCall' && part.name === 'create_chat')));
  assert.equal((await say(daemon, chat.id, '在这里继续')).status, 'done');
});

scenario('Rescheduling withdraws a queued follow-up without changing a conversation mid-tool', async t => {
  const daemon = await launch(t);
  const job = await post(daemon, '/jobs', { prompt: '等待会话空闲的跟进', delayMs: 0 });
  await notified(daemon, job.id);
  await post(daemon, '/chat', { text: '/slow', wait: false });
  await until(() => get(daemon, '/state?chatId=main'), state => state.active.live?.tools?.some(tool => tool.name === 'pause'));
  const scheduled = await post(daemon, `/jobs/${job.id}/followup`, { afterMs: 0 });
  const oldId = scheduled.followup.taskId;
  await until(() => get(daemon, '/inspect'), state => state.submissions.some(item => item.requestId === `followup-publish:${oldId}` && item.status === 'queued'));
  assert(!(await get(daemon, '/history')).some(entry => entry.kind === 'point.followup'));
  await post(daemon, `/jobs/${job.id}/followup`, { afterMs: 5000 });
  await post(daemon, '/chat/stop', {});
  assert(!(await get(daemon, '/history')).some(entry => entry.kind === 'point.followup' && entry.data.planId === oldId));
  await post(daemon, `/jobs/${job.id}/cancel`, {});
  assert.deepEqual((await get(daemon)).reports, []);
});

scenario('Cancelling a job withdraws its queued model notification and preserves the existing artifact', async t => {
  const daemon = await launch(t);
  await post(daemon, '/chat', { text: '/slow', wait: false });
  await until(() => get(daemon, '/state?chatId=main'), state => state.active.live?.tools?.some(tool => tool.name === 'pause'));
  const job = await post(daemon, '/jobs', { prompt: '排队中的完成通知', delayMs: 0 });
  const completed = await jobDone(daemon, job.id);
  await until(() => get(daemon, '/inspect'), state => state.submissions.some(item => item.requestId === `report:${job.id}:main` && item.status === 'queued'));
  await post(daemon, `/jobs/${job.id}/cancel`, {});
  await post(daemon, '/chat/stop', {});
  assert(!(await get(daemon, '/history')).some(entry => entry.kind === 'point.report-input' && entry.data.jobId === job.id));
  assert.match(await readFile(join(daemon.directory, 'workspace', completed.artifact), 'utf8'), /排队中的完成通知/);
  assert.equal((await get(daemon, `/jobs/${job.id}`)).notification.status, 'cancelled');
  assert.deepEqual((await get(daemon)).reports, []);
});

scenario('SIGKILL around model notification admission/publication never duplicates either chat delivery', async (t, details) => {
  details.cases = [];
  for (const point of ['after-notification-submit', 'before-notification-publish']) {
    for (let round = 0; round < rounds; round++) {
      let daemon = await launch(t, { fault: point });
      const side = await makeChat(daemon, '可靠交付');
      const job = await post(daemon, '/jobs', { prompt: '恢复后两处收到结果', chatId: side.id, notifyMain: true, delayMs: 0 });
      await faultReached(daemon, point);
      await stop(daemon, 'SIGKILL');
      daemon = await launch(t, { directory: daemon.directory });
      await notified(daemon, job.id);
      for (const chat of ['main', side.id]) {
        const id = chat === 'main' ? 1 : side.conversationId;
        const history = await get(daemon, `/history?conversation=${id}`);
        assert.equal(history.filter(entry => entry.kind === 'point.report-input' && entry.data.jobId === job.id).length, 1);
        assert.equal((await get(daemon)).events.filter(event => event.type === 'reply' && event.jobId === job.id && event.chatId === chat).length, 1);
      }
      details.cases.push({ point, round: round + 1, jobId: job.id });
      await stop(daemon);
    }
  }
}, 120000);

scenario('Native compaction shrinks active context, preserves original history and retains shared memory', async t => {
  const daemon = await launch(t);
  await post(daemon, '/memory', { key: '压缩后偏好', value: '中文短句', chatId: 'main' });
  for (let index = 0; index < 6; index++) await say(daemon, 'main', `COMPACT_ORIGINAL_${index} ` + '资料'.repeat(6000));
  const before = await get(daemon, '/chats/main/context');
  const compacted = await post(daemon, '/chats/main/compact', { wait: true, instructions: '保留原始决定和未完成事项。' });
  assert.equal(compacted.outcome.status, 'completed');
  const after = await get(daemon, '/chats/main/context');
  assert.equal(after.head.kind, 'pi.compaction');
  assert(contextText(after).length < contextText(before).length);
  assert.match(JSON.stringify(await get(daemon, '/history')), /COMPACT_ORIGINAL_0/);
  let cursor, originalFound = false;
  do {
    const page = await get(daemon, `/chats/main/messages?limit=3${cursor ? '&cursor=' + encodeURIComponent(JSON.stringify(cursor)) : ''}`);
    originalFound ||= page.messages.some(message => message.text.includes('COMPACT_ORIGINAL_0'));
    cursor = page.next;
  } while (cursor);
  assert(originalFound);
  assert.equal((await say(daemon, 'main', '/recall 压缩后偏好')).text, '中文短句');
});

scenario('Interactive CLI switches topics, stops an in-flight answer, and shares memory without blocking input', async t => {
  const daemon = await launch(t);
  const client = spawn(process.execPath, [join(ROOT, 'src/cli.mjs'), '--url', daemon.url], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  client.stdout.on('data', chunk => { output += chunk; });
  client.stderr.on('data', chunk => { output += chunk; });
  t.after(() => { if (client.exitCode === null) client.kill('SIGKILL'); });
  await until(async () => output, text => text.includes('Point Durable CLI'));
  client.stdin.write('/new 旅行\n');
  await until(async () => output, text => text.includes('── 旅行'));
  const side = (await get(daemon, '/chats')).find(chat => chat.name === '旅行');
  client.stdin.write('/slow\n');
  await until(() => get(daemon, `/state?chatId=${side.id}`), state => state.active.live?.tools?.some(tool => tool.name === 'pause'));
  const stoppedAt = Date.now();
  client.stdin.write('/stop\n');
  await until(async () => output, text => text.includes('已停止当前会话'));
  assert(Date.now() - stoppedAt < 1500);
  client.stdin.write('/remember 城市=杭州\n');
  await until(async () => output, text => text.includes('已保存：城市'));
  client.stdin.write('/main\n');
  await until(async () => output, text => text.includes('── 主会话'));
  client.stdin.write('/recall 城市\n');
  await until(async () => output, text => text.includes('[Point·主会话] 杭州'));
  client.stdin.write('/quit\n');
  const [code] = await once(client, 'exit');
  assert.equal(code, 0);
  assert.equal((await get(daemon, '/health')).ok, true);
});
