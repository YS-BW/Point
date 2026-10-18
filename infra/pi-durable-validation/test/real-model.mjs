import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, RUN_DIR, launch, stop, get, post, jobDone, until } from './helpers.mjs';

const model = process.env.POINT_REAL_MODEL ?? 'deepseek/deepseek-flash';
const auth = process.env.POINT_AUTH_FILE ?? fileURLToPath(new URL('../../../server/.pi/agent/auth.json', import.meta.url));
try { await access(auth); }
catch {
  if (!process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_API_KEY) {
    console.log('SKIPPED: no API-key file/environment is available. Set POINT_AUTH_FILE and POINT_REAL_MODEL.');
    process.exit(0);
  }
}
const cleanups = [];
const testContext = { after: fn => { cleanups.push(fn); } };
const started = Date.now();
await writeFile(join(ROOT, 'runtime/real-model-results.json'), JSON.stringify({ status: 'running', model, startedAt: new Date().toISOString() }, null, 2));
let daemon;
try {
  let authFile;
  try { await access(auth); authFile = auth; } catch { /* Environment credential. */ }
  daemon = await launch(testContext, { model, auth: authFile, directory: join(RUN_DIR, 'real-model') });
  const marker = `point-durable-${crypto.randomUUID()}`;
  const reply = await post(daemon, '/chat', {
    text: `请实际调用 write 工具，在当前目录写入 real-model.txt，内容必须精确为 ${marker}，再调用 read 工具核对，然后简短回复。`,
  });
  assert.equal(reply.status, 'done');
  assert.equal((await readFile(join(daemon.directory, 'workspace/real-model.txt'), 'utf8')).trim(), marker);
  await post(daemon, '/chat', {
    text: '请调用 remember 工具，保存用户明确要求的长期饮食偏好：key 为 饮食要求，value 为 不吃辣，kind 为 preference。不要创建任务。',
  });
  assert((await get(daemon, '/memory')).some(item => item.key === '饮食要求' && item.value.includes('不吃辣')));
  const side = await post(daemon, '/chats', { name: '真实任务验收', mode: 'fresh' });
  const memoryReply = await post(daemon, '/chat', { chatId: side.id, text: '根据已经保存的长期记忆，我的饮食要求是什么？只简短回答。' });
  assert.match(memoryReply.text, /不吃辣/);
  const left = 37 + Math.floor(Math.random() * 10), right = 58 + Math.floor(Math.random() * 10);
  const expected = `A+B=${left + right}`;
  const resultFile = `calculation-${crypto.randomUUID()}.txt`;
  await post(daemon, '/chat', { chatId: side.id,
    text: `本主题的任务背景：A=${left}，B=${right}。仅把这两个参数作为当前会话背景，暂不计算、不执行工具、不存共享记忆。下一条会交代工作。`,
  });
  await post(daemon, '/chat', {
    chatId: side.id,
    text: `请实际调用 start_job 工具把任务交给后台：读取当前主题此前给出的 A 和 B，计算它们的和，用 write 在当前目录创建 ${resultFile}，内容精确为 A+B=计算结果（等号后直接是数字），再 read 核对。最后报告结果和文件名。不要调用 work_step。title 设为 real-model-report，notifyMain 设为 true，delayMs 为 0。工具返回后立即简短确认，不等待结果。`,
  });
  const state = await get(daemon);
  assert.equal(state.jobs.length, 1);
  const job = state.jobs.at(-1);
  assert.equal(job.chatId, side.id);
  assert.equal(job.verifySteps, false);
  const completed = await jobDone(daemon, job.id, 90000);
  const artifact = await readFile(join(daemon.directory, 'workspace', completed.artifact), 'utf8');
  assert(artifact.length > 20);
  assert.equal((await readFile(join(daemon.directory, 'workspace', resultFile), 'utf8')).trim(), expected);
  await until(() => get(daemon, `/jobs/${job.id}`), item => item.notification?.status === 'done', 90000);
  const mainHistory = await get(daemon, '/history');
  const sideHistory = await get(daemon, `/history?conversation=${side.conversationId}`);
  const workerHistory = await get(daemon, `/history?conversation=${job.conversationId}`);
  const tools = history => history.flatMap(entry => entry.model ?? []).flatMap(message => message.content ?? []).filter(part => part.type === 'toolCall').map(part => part.name);
  const calls = tools(mainHistory);
  for (const name of ['write', 'read', 'remember']) assert(calls.includes(name));
  assert(tools(sideHistory).includes('start_job'));
  // The inherited topic history also contains start_job; the worker itself must actually write and read.
  const workerCalls = tools(workerHistory);
  assert(workerCalls.includes('write') && workerCalls.includes('read'));
  assert(!workerCalls.includes('work_step'));
  const recalled = await post(daemon, '/chat', { text: '刚才后台计算得到的 A+B 是多少？只回答数字，不调用工具。' });
  assert.match(recalled.text, new RegExp(String(left + right)));
  const share = await post(daemon, `/chats/${side.id}/share`, {});
  await until(() => get(daemon), current => current.shares.find(item => item.id === share.id)?.status === 'done', 90000);
  await post(daemon, `/jobs/${job.id}/followup`, { afterMs: 100 });
  await until(() => get(daemon, `/jobs/${job.id}`), item => item.followup?.status === 'done', 90000);
  const reminderHistory = await get(daemon, `/history?conversation=${side.conversationId}`);
  assert(reminderHistory.some(entry => entry.kind === 'point.followup' && entry.model?.length));
  const rootId = (await get(daemon)).rootId;
  await stop(daemon, 'SIGKILL');
  daemon = await launch(testContext, { model, auth: authFile, directory: daemon.directory });
  assert.equal((await get(daemon)).rootId, rootId);
  assert((await get(daemon, '/chats')).some(chat => chat.id === side.id && chat.conversationId === side.conversationId));
  const remembered = await post(daemon, '/chat', { text: '根据保存的记忆，我的饮食要求是什么？简短回答。' });
  assert.match(remembered.text, /不吃辣/);
  const result = {
    status: 'passed', model, ms: Date.now() - started, dataDirectory: daemon.directory,
    mainToolCalls: calls, workerToolCalls: workerCalls, jobId: job.id, chatId: side.id, workerConversationId: job.conversationId,
    calculation: expected, resultFile, artifact: completed.artifact,
    sharedMemory: true, inheritedTaskContext: true, mainUnderstandsResult: true, shareToMain: true, modelFollowup: true, survivesRestart: true,
    usage: (await get(daemon)).usage,
  };
  await writeFile(join(ROOT, 'runtime/real-model-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await writeFile(join(ROOT, 'runtime/real-model-results.json'), JSON.stringify({ status: 'failed', model, ms: Date.now() - started, error: error.message }, null, 2));
  throw error;
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  if (daemon) await stop(daemon);
}
