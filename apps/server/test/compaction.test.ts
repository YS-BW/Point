import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { parseCompactCommand } from '../src/application/conversation.js';
import { openRuntime, type ModelBinding, type Runtime } from '../src/runtime/open.js';
import { guardedModels } from '../src/runtime/model-guard.js';
import { ModelCalls } from '../src/storage/conversation.js';

type CapturedRequest = {messages: ReadonlyArray<{role: string; content: unknown}>};

function provider(responses: FauxResponseStep[]) {
  const faux = fauxProvider({tokensPerSecond: 100000});
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return {faux, binding: {models, model: {provider: 'faux', modelId: 'faux-1'}} satisfies ModelBinding};
}

const capture = (captures: CapturedRequest[], text: string): FauxResponseStep => (request: unknown) => {
  captures.push(request as CapturedRequest);
  return fauxAssistantMessage(text);
};

async function fixture(t: TestContext, responses: FauxResponseStep[]) {
  const dir = await mkdtemp(join(tmpdir(), 'point-compact-'));
  const p = provider(responses);
  const runtime = await openRuntime(dir, p.binding);
  t.after(async () => { await runtime.close(); await rm(dir, {recursive: true, force: true}); });
  return {runtime, faux: p.faux, binding: p.binding, dir};
}

async function answered(runtime: Runtime, chatId: string, requestId: string, text: string) {
  const receipt = await runtime.conversation.send({chatId, requestId, text});
  assert.equal((await runtime.conversation.wait(receipt.commandId)).status, 'answered');
}

/** A conversation long enough for `keepRecentTokens=8192` to leave compactable history. */
async function seedLongHistory(runtime: Runtime, chatId: string, turns = 5) {
  for (let index = 0; index < turns; index += 1) {
    await answered(runtime, chatId, `seed-${index}`, `第${index}段：${'甲乙丙丁'.repeat(2250)}`);
  }
}

function compactHandlers(guard: ReturnType<typeof guardedModels>) {
  const hook = guard.extension.hooks?.find(registration => registration.task === 'pi.compaction');
  assert.ok(hook, 'the guard installs a compaction hook');
  return hook!.handlers as unknown as {
    beforeCompact(compaction: unknown, api: unknown, context: unknown): Promise<unknown>;
  };
}

test('compact input is explicit, normalization is bounded and status ids are validated', () => {
  assert.deepEqual(parseCompactCommand({chatId: '1', requestId: 'c1'}), {kind: 'compact', chatId: '1', requestId: 'c1'});
  assert.deepEqual(parseCompactCommand({chatId: '1', requestId: 'c1', instructions: '  聚焦决定  '}),
    {kind: 'compact', chatId: '1', requestId: 'c1', instructions: '聚焦决定'});
  for (const input of [
    null, [], {}, {chatId: '1'}, {requestId: 'c1'}, {chatId: '1', requestId: 'c1', extra: true},
    {chatId: '0', requestId: 'c1'}, {chatId: 'abc', requestId: 'c1'}, {chatId: 1, requestId: 'c1'},
    {chatId: '1', requestId: ''}, {chatId: '1', requestId: 'bad id'},
    {chatId: '1', requestId: 'c1', instructions: 7},
    {chatId: '1', requestId: 'c1', instructions: ''},
    {chatId: '1', requestId: 'c1', instructions: '   '},
    {chatId: '1', requestId: 'c1', instructions: 'x'.repeat(4001)},
    {chatId: '1', requestId: 'c1', instructions: 'a\u0000b'},
  ]) {
    assert.throws(() => parseCompactCommand(input), /INVALID_COMMAND/, `accepted ${JSON.stringify(input)}`);
  }
});

test('compact requires a model and an existing chat and rejects wrong command kinds', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'point-compact-nomodel-'));
  const noModel = await openRuntime(dir);
  try {
    const chat = await noModel.chats.create({requestId: 'chat', name: '无模型'});
    await assert.rejects(noModel.conversation.compact({chatId: chat.id, requestId: 'c1'}), /MODEL_NOT_CONFIGURED/);
  } finally {
    await noModel.close();
    await rm(dir, {recursive: true, force: true});
  }

  const f = await fixture(t, [fauxAssistantMessage('unused')]);
  const missing = {chatId: '424242', requestId: 'missing-chat'};
  await assert.rejects(f.runtime.conversation.compact(missing), /CHAT_NOT_FOUND/);
  for (const input of [null, [], {}, {chatId: '424242'}, {requestId: 'missing-chat'},
    {...missing, extra: true}, {...missing, chatId: '0'}, {...missing, requestId: 'bad id'},
    {...missing, instructions: 7}, {...missing, instructions: '   '},
    {...missing, instructions: 'x'.repeat(4001)}, {...missing, instructions: 'a\u0000b'}]) {
    await assert.rejects(f.runtime.conversation.compact(input), /INVALID_COMMAND/, `accepted ${JSON.stringify(input)}`);
  }
  // A compact command id is not a send command id and vice versa.
  await assert.rejects(f.runtime.conversation.compactStatus('not-a-task'), /INVALID_COMMAND/);
  await assert.rejects(f.runtime.conversation.compactStatus('424242'), /COMMAND_NOT_FOUND/);
});

test('manual compact completes, keeps history, exposes the summary and records the model call', {timeout: 30000}, async t => {
  const captures: CapturedRequest[] = [];
  const responses: FauxResponseStep[] = [
    ...Array.from({length: 5}, (_, index) => fauxAssistantMessage(`ok-${index}`)),
    fauxAssistantMessage('## Goal\nsummary-marker-alpha'),
    capture(captures, 'after-compact'),
  ];
  const f = await fixture(t, responses);
  const chat = await f.runtime.chats.create({requestId: 'chat', name: '长对话'});
  await seedLongHistory(f.runtime, chat.id);
  const before = await f.runtime.conversation.history(chat.id);
  assert.equal(before.items.length, 10);

  const receipt = await f.runtime.conversation.compact({
    chatId: chat.id, requestId: 'compact:1', instructions: 'focus on decisions',
  });
  const accepted = await f.runtime.conversation.compactStatus(receipt.commandId);
  assert.ok(['accepted', 'running', 'completed'].includes(accepted.status), `unexpected ${accepted.status}`);
  const state = await f.runtime.conversation.compactWait(receipt.commandId);
  assert.equal(state.status, 'completed');
  assert.ok(state.entryId, 'the summary entry id is exposed');
  assert.ok(state.taskId, 'the inner compaction task id is exposed');
  assert.deepEqual(await f.runtime.conversation.compactStatus(receipt.commandId), state, 'status is terminal afterwards');

  assert.deepEqual(await f.runtime.conversation.history(chat.id), before,
    'compaction never deletes or rewrites the original history');
  const callsAfterCompaction = f.faux.state.callCount;
  assert.deepEqual(await f.runtime.conversation.compact({
    chatId: chat.id, requestId: 'compact:1', instructions: 'focus on decisions',
  }), receipt, 'the same request key replays the accepted command');
  assert.equal(f.faux.state.callCount, callsAfterCompaction, 'a replay never runs the compaction again');

  await answered(f.runtime, chat.id, 'after', '继续');
  assert.ok(JSON.stringify(captures[0]).includes('summary-marker-alpha'),
    'requests after compaction carry the summary in model context');

  // The compaction model call is durably recorded under the inner task id, and stays queryable after restart.
  await f.runtime.close();
  const h = await Harness.open(await openNodeSqliteStorage(join(f.dir, 'state.sqlite')),
    {models: createModels(), registry: createRegistry()}, context);
  try {
    assert.deepEqual(await h.snapshot(ModelCalls, state.taskId!, context), {chatId: chat.id, state: 'done'});
  } finally {
    await h.close(context);
  }
  const reopened = await openRuntime(f.dir);
  try {
    const persisted = await reopened.conversation.compactStatus(receipt.commandId);
    assert.equal(persisted.status, 'completed');
    assert.equal(persisted.entryId, state.entryId);
    assert.equal(persisted.taskId, state.taskId);
  } finally {
    await reopened.close();
  }
});

test('compact is idempotent per request key and a no-cut compaction completes without an entry', {timeout: 15000}, async t => {
  const f = await fixture(t, [fauxAssistantMessage('only answer')]);
  const chat = await f.runtime.chats.create({requestId: 'chat', name: '短对话'});
  const message = await f.runtime.conversation.send({chatId: chat.id, requestId: 's1', text: '短'});
  await f.runtime.conversation.wait(message.commandId);
  const receipt = await f.runtime.conversation.compact({chatId: chat.id, requestId: 'compact:short'});
  assert.deepEqual(await f.runtime.conversation.compact({
    chatId: chat.id, requestId: 'compact:short',
  }), receipt);
  await assert.rejects(f.runtime.conversation.compact({
    chatId: chat.id, requestId: 'compact:short', instructions: 'different',
  }), /IDEMPOTENCY_CONFLICT/);
  const state = await f.runtime.conversation.compactWait(receipt.commandId);
  assert.equal(state.status, 'completed');
  assert.equal(state.entryId, undefined, 'nothing to compact means no summary entry');
  assert.ok(state.taskId);
  assert.equal(f.faux.state.callCount, 1, 'a no-cut compaction never calls the model');
  await assert.rejects(f.runtime.conversation.compactStatus(message.commandId), /COMMAND_NOT_FOUND/,
    'a send command is not a compaction command');
  assert.equal((await f.runtime.conversation.history(chat.id)).items.length, 2);
});

test('compaction model calls fail closed without a permit or with an ambiguous permit set', async () => {
  const p = provider([fauxAssistantMessage('must not be used')]);
  const h = await Harness.open(new MemoryStorage(), {models: createModels(), registry: createRegistry()}, context);
  try {
    const guard = guardedModels(p.binding.models, () => h);
    const model = p.faux.getModel();
    const request = {messages: [{role: 'user' as const, content: 'summarize', timestamp: 0}]};
    for (const options of [undefined, {sessionId: 'unknown-session'}]) {
      const message = await guard.models.completeSimple(model, request, options);
      assert.equal(message.stopReason, 'error');
      assert.equal(message.errorMessage, 'MODEL_GUARD_REQUIRED');
    }
    const handlers = compactHandlers(guard);
    const api = (taskId: number) => ({taskId, conversationId: 22, snapshot: async () => ({sessionId: 'ambiguous-session'})});
    await handlers.beforeCompact({}, api(11), context);
    await handlers.beforeCompact({}, api(12), context);
    const ambiguous = await guard.models.completeSimple(model, request, {sessionId: 'ambiguous-session'});
    assert.equal(ambiguous.errorMessage, 'MODEL_GUARD_REQUIRED');
    assert.equal(p.faux.state.callCount, 0, 'the provider is never called without exactly one live permit');
  } finally {
    await h.close(context);
  }
});

test('a single compaction permit admits one guarded call, records ModelCalls done and is one-shot', async () => {
  const p = provider([fauxAssistantMessage('## Goal\npermitted-summary')]);
  const h = await Harness.open(new MemoryStorage(), {models: createModels(), registry: createRegistry()}, context);
  try {
    const guard = guardedModels(p.binding.models, () => h);
    const handlers = compactHandlers(guard);
    await handlers.beforeCompact({}, {
      taskId: 71, conversationId: 22, snapshot: async () => ({sessionId: 'permitted-session'}),
    }, context);
    const request = {messages: [{role: 'user' as const, content: 'summarize', timestamp: 0}]};
    const message = await guard.models.completeSimple(p.faux.getModel(), request, {sessionId: 'permitted-session'});
    assert.equal(message.stopReason, 'stop');
    assert.equal(p.faux.state.callCount, 1);
    assert.deepEqual(await h.snapshot(ModelCalls, '71', context), {chatId: '22', state: 'done'});
    // The permit is consumed: a second call for the same session is fail-closed, not replayed.
    const replay = await guard.models.completeSimple(p.faux.getModel(), request, {sessionId: 'permitted-session'});
    assert.equal(replay.errorMessage, 'MODEL_GUARD_REQUIRED');
    assert.equal(p.faux.state.callCount, 1);
  } finally {
    await h.close(context);
  }
});

test('a persisted non-new ModelCalls record blocks recovery: no provider call, no state overwrite', async () => {
  const p = provider([fauxAssistantMessage('must not be used')]);
  const h = await Harness.open(new MemoryStorage(), {models: createModels(), registry: createRegistry()}, context);
  try {
    const guard = guardedModels(p.binding.models, () => h);
    const handlers = compactHandlers(guard);
    const request = {messages: [{role: 'user' as const, content: 'summarize', timestamp: 0}]};
    // `done` is covered by the permit test above; recovery must also refuse a lost attempt and a
    // conservatively unknown result without replaying the provider.
    for (const [taskId, chatId, state] of [[81, 22, 'unknown'], [82, 23, 'attempting']] as const) {
      await h.commit(async tx => {
        const call = await tx.doc(ModelCalls, String(taskId), String(chatId));
        call.state = state;
      }, context);
      await handlers.beforeCompact({}, {
        taskId, conversationId: chatId, snapshot: async () => ({sessionId: `resume-${taskId}`}),
      }, context);
      const message = await guard.models.completeSimple(p.faux.getModel(), request, {sessionId: `resume-${taskId}`});
      assert.equal(message.stopReason, 'error');
      assert.equal(message.errorMessage, 'MODEL_RESULT_NOT_RECOVERABLE');
      assert.deepEqual(await h.snapshot(ModelCalls, String(taskId), context), {chatId: String(chatId), state},
        'a non-new record is never overwritten or replayed');
    }
    assert.equal(p.faux.state.callCount, 0, 'the provider is never called for a non-recoverable result');
  } finally {
    await h.close(context);
  }
});

test('compact receipts are scoped per chat, so one request key can be used in two chats', {timeout: 15000}, async t => {
  const f = await fixture(t, []);
  const first = await f.runtime.chats.create({requestId: 'chat-a', name: '对话A'});
  const second = await f.runtime.chats.create({requestId: 'chat-b', name: '对话B'});
  const firstReceipt = await f.runtime.conversation.compact({chatId: first.id, requestId: 'shared-key'});
  const secondReceipt = await f.runtime.conversation.compact({chatId: second.id, requestId: 'shared-key'});
  assert.notEqual(firstReceipt.commandId, secondReceipt.commandId,
    'the same request key in another chat is a different command');
  assert.deepEqual(await f.runtime.conversation.compact({chatId: first.id, requestId: 'shared-key'}), firstReceipt,
    'the same chat and key replays its own command');
  assert.deepEqual(await f.runtime.conversation.compact({chatId: second.id, requestId: 'shared-key'}), secondReceipt);
  const firstState = await f.runtime.conversation.compactWait(firstReceipt.commandId);
  const secondState = await f.runtime.conversation.compactWait(secondReceipt.commandId);
  assert.equal(firstState.status, 'completed');
  assert.equal(secondState.status, 'completed');
  assert.equal(firstState.entryId, undefined, 'empty conversations are no-cut compactions');
  assert.equal(secondState.entryId, undefined);
  assert.equal(f.faux.state.callCount, 0, 'no-cut compactions never call the model');
});
