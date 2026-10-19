import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider, fauxAssistantMessage, type FauxResponseStep} from '@earendil-works/pi-ai/providers/faux';
import {openRuntime, type ModelBinding} from '../src/runtime/open.js';
import {guardedModels} from '../src/runtime/model-guard.js';
import {Harness, MemoryStorage, createRegistry, type GenerationHooks, type HookApi} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {ModelCalls} from '../src/storage/conversation.js';

function provider(responses: FauxResponseStep[]) {
  const faux = fauxProvider({tokensPerSecond: 100000});
  faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return {faux, binding: {models, model: {provider: 'faux', modelId: 'faux-1'}} satisfies ModelBinding};
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {release = resolve;});
  return {promise, release};
}
async function eventually(read: () => Promise<string>, expected: string) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (await read() === expected) return;
    await delay(5);
  }
  assert.fail(`Did not observe ${expected}`);
}
async function fixture(responses: FauxResponseStep[]) {
  const dir = await mkdtemp(join(tmpdir(), 'point-experience-'));
  const p = provider(responses);
  const runtime = await openRuntime(dir, p.binding);
  const chat = await runtime.chats.create({requestId: 'chat', name: '给小王的方案'});
  return {...p, runtime, chat, dir, async close() {await runtime.close(); await rm(dir, {recursive: true, force: true});}};
}

test('用户发消息后离开，返回看到同一条输入与完整回答；断线重试不会重复调用模型', {timeout: 10000}, async () => {
  const f = await fixture([fauxAssistantMessage('小王你好，项目说明如下。')]);
  try {
    const input = {chatId: f.chat.id, requestId: 'send:1', text: '帮我起草给小王的项目说明'};
    const [first, retry] = await Promise.all([f.runtime.conversation.send(input), f.runtime.conversation.send(input)]);
    assert.deepEqual(first, retry);
    // Only read-only polling: no wait() call to enable the SDK scheduler on the client's behalf.
    await eventually(async () => (await f.runtime.conversation.status(first.commandId)).status, 'answered');
    assert.equal((await f.runtime.conversation.status(first.commandId)).status, 'answered');
    await assert.rejects(f.runtime.conversation.send({...input, text: '不同要求'}), /IDEMPOTENCY_CONFLICT/);
    const history = await f.runtime.conversation.history(f.chat.id);
    assert.deepEqual(history.items.map(x => [x.role, x.text]), [['user', input.text], ['assistant', '小王你好，项目说明如下。']]);
    assert.equal(f.faux.state.callCount, 1);
    await f.runtime.close();
    const reopened = await openRuntime(f.dir); // viewing does not require a provider
    try {
      assert.deepEqual(await reopened.conversation.history(f.chat.id), history);
      assert.equal((await reopened.conversation.status(first.commandId)).status, 'answered');
    } finally {await reopened.close();}
  } finally {await f.close();}
});

test('用户在撰写中补充预算，先完成当前轮，再带着历史处理补充', {timeout: 10000}, async () => {
  const entered = gate(), release = gate();
  const f = await fixture([
    async () => {entered.release(); await release.promise; return fauxAssistantMessage('这是初稿。');},
    request => {
      const contents = JSON.stringify(request.messages);
      for (const text of ['帮我写方案', '这是初稿。', '预算控制在五千以内']) assert.ok(contents.includes(text));
      return fauxAssistantMessage('已将预算调整到五千以内。');
    },
  ]);
  try {
    const first = await f.runtime.conversation.send({chatId: f.chat.id, requestId: '1', text: '帮我写方案'});
    await entered.promise;
    const second = await f.runtime.conversation.send({chatId: f.chat.id, requestId: '2', text: '预算控制在五千以内'});
    await eventually(async () => (await f.runtime.conversation.status(second.commandId)).status, 'queued');
    assert.equal(f.faux.state.callCount, 1);
    release.release();
    assert.equal((await f.runtime.conversation.wait(first.commandId)).status, 'answered');
    assert.equal((await f.runtime.conversation.wait(second.commandId)).status, 'answered');
    assert.deepEqual((await f.runtime.conversation.history(f.chat.id)).items.map(x => x.text),
      ['帮我写方案', '这是初稿。', '预算控制在五千以内', '已将预算调整到五千以内。']);
  } finally {release.release(); await f.close();}
});

test('停止旧方案和排队要求后换方向；重发旧停止命令不会取消新问题', {timeout: 10000}, async () => {
  const entered = gate();
  const f = await fixture([
    async (_request, options) => {
      entered.release();
      await new Promise<void>(resolve => {if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener('abort', () => resolve(), {once: true});});
      return fauxAssistantMessage('旧方案不应作为完成结果交付');
    },
    fauxAssistantMessage('一、目标是什么？二、预算多少？三、何时交付？'),
  ]);
  try {
    const old = await f.runtime.conversation.send({chatId: f.chat.id, requestId: '1', text: '写一份详细方案'});
    await entered.promise;
    const queued = await f.runtime.conversation.send({chatId: f.chat.id, requestId: '2', text: '再附上报价'});
    await eventually(async () => (await f.runtime.conversation.status(queued.commandId)).status, 'queued');
    const stopInput = {chatId: f.chat.id, requestId: 'stop'};
    const stop = await f.runtime.conversation.stop(stopInput);
    const next = await f.runtime.conversation.send({chatId: f.chat.id, requestId: '3', text: '先帮我列三个问题'});
    assert.equal((await f.runtime.conversation.wait(stop.commandId)).status, 'stopped');
    assert.deepEqual(await f.runtime.conversation.stop(stopInput), stop);
    assert.equal((await f.runtime.conversation.wait(old.commandId)).status, 'unanswered');
    assert.equal((await f.runtime.conversation.wait(queued.commandId)).status, 'unanswered');
    assert.equal((await f.runtime.conversation.wait(next.commandId)).status, 'answered');
    assert.equal(f.faux.state.callCount, 2);
  } finally {await f.close();}
});

test('项目聊天忙碌时另开旅行聊天，不串历史，也不必等待项目完成', {timeout: 10000}, async () => {
  const entered = gate(), release = gate();
  const f = await fixture([
    async () => {entered.release(); await release.promise; return fauxAssistantMessage('项目答复');},
    request => {assert.ok(!JSON.stringify(request.messages).includes('项目保密预算')); return fauxAssistantMessage('旅行答复');},
  ]);
  try {
    const first = await f.runtime.conversation.send({chatId: f.chat.id, requestId: '1', text: '项目保密预算'});
    await entered.promise;
    const travel = await f.runtime.chats.create({requestId: 'travel', name: '旅行'});
    const second = await f.runtime.conversation.send({chatId: travel.id, requestId: '1', text: '周末去哪走走'});
    assert.equal((await f.runtime.conversation.wait(second.commandId)).status, 'answered');
    assert.equal((await f.runtime.conversation.status(first.commandId)).status, 'running');
    release.release(); await f.runtime.conversation.wait(first.commandId);
  } finally {release.release(); await f.close();}
});

test('供应商失败时显示未回答，不把已接收当作完成；下一条消息仍可继续', {timeout: 10000}, async () => {
  const f = await fixture([
    fauxAssistantMessage('', {stopReason: 'error', errorMessage: 'sensitive-provider-diagnostic'}),
    fauxAssistantMessage('现在可以继续了'),
  ]);
  try {
    const first = await f.runtime.conversation.send({chatId: f.chat.id, requestId: '1', text: '帮我看看方案'});
    assert.equal((await f.runtime.conversation.wait(first.commandId)).status, 'unanswered');
    assert.ok(!(JSON.stringify(await f.runtime.conversation.history(f.chat.id))).includes('sensitive-provider-diagnostic'));
    const next = await f.runtime.conversation.send({chatId: f.chat.id, requestId: '2', text: '继续讨论'});
    assert.equal((await f.runtime.conversation.wait(next.commandId)).status, 'answered');
    assert.equal(f.faux.state.callCount, 2);
  } finally {await f.close();}
});

test('服务在模型处理期间被强杀，用户回来看到未回答，系统没有偷偷重发', {timeout: 15000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-conversation-crash-'));
  const child = fork(new URL('./fixtures/conversation-crash.js', import.meta.url), [dir], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  let errors = '';
  child.stderr?.on('data', chunk => {errors += String(chunk);});
  const exited = once(child, 'exit');
  try {
    const identity = await Promise.race([
      once(child, 'message', {signal: AbortSignal.timeout(10000)}).then(([message]) => message as {chatId: string; commandId: string}),
      exited.then(() => {throw new Error(`Child exited before request: ${errors}`);}),
    ]);
    child.kill('SIGKILL'); await exited;
    const p = provider([fauxAssistantMessage('新请求的回答')]);
    const reopened = await openRuntime(dir, p.binding);
    try {
      assert.equal((await reopened.conversation.wait(identity.commandId)).status, 'unanswered');
      assert.equal(p.faux.state.callCount, 0);
      const history = await reopened.conversation.history(identity.chatId);
      assert.deepEqual(history.items.map(item => item.text), ['给小王写方案']);
      const next = await reopened.conversation.send({chatId: identity.chatId, requestId: 'new-request', text: '那先帮我列个提纲'});
      assert.equal((await reopened.conversation.wait(next.commandId)).status, 'answered');
      assert.equal(p.faux.state.callCount, 1);
    } finally {await reopened.close();}
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; await rm(dir, {recursive: true, force: true});
  }
});

test('没有调用身份标记时拒绝模型请求，即使钩子缺失也不能绕过保护', async () => {
  const p = provider([fauxAssistantMessage('不该调用')]);
  const guard = guardedModels(p.binding.models, () => {throw new Error('Must not reach runtime');});
  const result = await guard.models.streamSimple(p.faux.getModel(), {messages: []}).result();
  assert.equal(result.errorMessage, 'MODEL_GUARD_REQUIRED');
  assert.equal(p.faux.state.callCount, 0);
});

test('用户停止恰好发生在派发前：记录明确未发出，供应商不会收到请求', async () => {
  const p = provider([]);
  const h = await Harness.open(new MemoryStorage(), {models: createModels(), registry: createRegistry()}, context);
  try {
    const guard = guardedModels(p.binding.models, () => h);
    const hooks = guard.extension.hooks![0]!.handlers as GenerationHooks;
    const tagged = await hooks.beforeRequest({messages: []}, {taskId: 1, conversationId: 1} as HookApi, context);
    assert.ok(tagged);
    const response = await guard.models.streamSimple(p.faux.getModel(), {messages: [...tagged.messages]}, {signal: AbortSignal.abort()}).result();
    assert.equal(response.stopReason, 'error');
    assert.equal((await h.snapshot(ModelCalls, '1', context))?.state, 'failed');
    assert.equal(p.faux.state.callCount, 0);
  } finally {await h.close(context);}
});

test('点击停止时服务中断，恢复旧停止流程不会杀掉后来发出的新问题', {timeout: 15000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-stop-crash-'));
  const child = fork(new URL('./fixtures/conversation-crash.js', import.meta.url), [dir, 'stopping'], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  let errors = ''; child.stderr?.on('data', chunk => {errors += String(chunk);});
  const exited = once(child, 'exit');
  try {
    const identity = await Promise.race([
      once(child, 'message', {signal: AbortSignal.timeout(10000)}).then(([message]) => message as {chatId: string; commandId: string; stopId: string; nextId: string}),
      exited.then(() => {throw new Error(errors);}),
    ]);
    child.kill('SIGKILL'); await exited;
    const p = provider([fauxAssistantMessage('三个问题')]);
    const r = await openRuntime(dir, p.binding);
    try {
      assert.equal((await r.conversation.wait(identity.stopId)).status, 'stopped');
      assert.equal((await r.conversation.wait(identity.commandId)).status, 'unanswered');
      assert.equal((await r.conversation.wait(identity.nextId)).status, 'answered');
      assert.equal(p.faux.state.callCount, 1);
      assert.deepEqual(await r.conversation.stop({chatId: identity.chatId, requestId: 'stop-before-crash'}), {commandId: identity.stopId});
      assert.equal((await r.conversation.status(identity.nextId)).status, 'answered');
    } finally {await r.close();}
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited; await rm(dir, {recursive: true, force: true});
  }
});

test('长对话分页返回全部历史，不重复、不跨会话，分页读取耗时受夹具预算约束', {timeout: 10000}, async () => {
  const f = await fixture(Array.from({length: 30}, (_, i) => fauxAssistantMessage(`回复${i}`)));
  try {
    for (let i = 0; i < 30; i++) {
      const receipt = await f.runtime.conversation.send({chatId: f.chat.id, requestId: `turn:${i}`, text: `讨论事项${i}`});
      await f.runtime.conversation.wait(receipt.commandId);
    }
    const start = performance.now();
    const items = [];
    let cursor: string | undefined;
    do {
      const page = await f.runtime.conversation.history(f.chat.id, 7, cursor);
      items.push(...page.items); cursor = page.next;
    } while (cursor);
    assert.ok(performance.now() - start < 5000);
    assert.equal(items.length, 60);
    assert.equal(new Set(items.map(item => item.id)).size, 60);
    assert.equal(items[0]?.text, '讨论事项0');
    assert.equal(items.at(-1)?.text, '回复29');
  } finally {await f.close();}
});

test('空消息、未知会话和未配置模型不会伪装成已接收', async () => {
  const f = await fixture([]);
  try {
    await assert.rejects(f.runtime.conversation.send({chatId: f.chat.id, requestId: 'bad', text: ' '}), /INVALID_COMMAND/);
    await assert.rejects(f.runtime.conversation.send({chatId: '99999', requestId: 'bad', text: '你好'}), /CHAT_NOT_FOUND/);
    assert.equal(f.faux.state.callCount, 0);
    await f.runtime.close();
    const reopened = await openRuntime(f.dir);
    try {await assert.rejects(reopened.conversation.send({chatId: f.chat.id, requestId: 'offline', text: '你好'}), /MODEL_NOT_CONFIGURED/);}
    finally {await reopened.close();}
  } finally {await f.close();}
});
