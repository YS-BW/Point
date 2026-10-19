import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineDocFamily, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { chatCommands } from '../src/application/chats.js';
import { CommandError, parseCreateChat } from '../src/domain/chat.js';
import { durableChatStore } from '../src/runtime/chats.js';
import { openRuntime } from '../src/runtime/open.js';
import { Chats, CreateChatReceipts } from '../src/storage/chats.js';

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'point-chat-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
async function inspect<T>(dir: string, fn: (h: Harness) => Promise<T>) {
  const h = await Harness.open(await openNodeSqliteStorage(join(dir, 'state.sqlite')),
    {models: createModels(), registry: createRegistry()}, context);
  try { return await fn(h); } finally { await h.close(context); }
}
const command = {requestId: 'create:one', name: '项目计划'};
const code = (expected: string) => (error: unknown) => error instanceof CommandError && error.code === expected;

test('create input is strict and normalization is explicit', async () => {
  let writes = 0;
  const service = chatCommands({async create() { writes++; throw new Error('unexpected write'); }, async get() { throw new Error('unexpected read'); }});
  for (const input of [null, [], {}, {...command, requestId: ''}, {...command, requestId: ' key'}, {...command, requestId: 'x'.repeat(129)},
    {...command, name: ' '}, {...command, name: 'x\n'}, {...command, name: '😀'.repeat(121)}, {...command, extra: true}, {...command, name: 123}]) {
    await assert.rejects(service.create(input), code('INVALID_COMMAND'));
  }
  assert.equal(writes, 0);
  assert.deepEqual(parseCreateChat({...command, name: '  项目计划  '}), command);
  assert.equal(parseCreateChat({...command, name: '😀'.repeat(120)}).name.length, 240);
  for (const id of ['', '0', '-1', '01', 'abc', '9007199254740992']) assert.equal(await service.get(id), undefined);
});

test('concurrent retries create one conversation; conflicts cannot mutate the original', async t => {
  const dir = await directory(t);
  const runtime = await openRuntime(dir);
  let id: string;
  try {
    const results = await Promise.all(Array.from({length: 20}, () => runtime.chats.create(command)));
    id = results[0]!.id;
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.deepEqual(await runtime.chats.create({...command, name: ' 项目计划 '}), results[0]);
    await assert.rejects(runtime.chats.create({...command, name: '另一件事'}), code('IDEMPOTENCY_CONFLICT'));
    const copy = await runtime.chats.get(id);
    assert.ok(copy);
    (copy as {name: string}).name = 'caller mutation';
    assert.equal((await runtime.chats.get(id))?.name, command.name);
    assert.equal(await runtime.chats.get('999999'), undefined);
  } finally { await runtime.close(); }
  const reopened = await openRuntime(dir);
  try {
    assert.equal((await reopened.chats.create(command)).id, id);
    assert.equal((await reopened.chats.get(id))?.name, command.name);
    await assert.rejects(reopened.chats.create({...command, name: 'changed'}), code('IDEMPOTENCY_CONFLICT'));
  } finally { await reopened.close(); }
  await inspect(dir, async h => h.commit(async tx => {
    assert.equal((await tx.scanConversations({}, 100)).items.length, 2); // root + chat
  }, context));
});

test('different keys create independent conversations, including concurrent conflicting payloads', async t => {
  const runtime = await openRuntime(await directory(t));
  try {
    const results = await Promise.allSettled(['first', 'second'].map(name => runtime.chats.create({...command, name})));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = results.find(r => r.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && code('IDEMPOTENCY_CONFLICT')(rejected.reason));
    const first = results.find(r => r.status === 'fulfilled');
    assert.ok(first?.status === 'fulfilled');
    const other = await runtime.chats.create({...command, requestId: 'create:two'});
    assert.notEqual(other.id, first.value.id);
  } finally { await runtime.close(); }
});

test('a rejected commit leaves no receipt, metadata or conversation and permits retry', async t => {
  const dir = await directory(t);
  await (await openRuntime(dir)).close();
  await inspect(dir, async h => {
    let stagedId = '';
    const store = durableChatStore({snapshot: h.snapshot.bind(h), commit: (change, c) => h.commit(async tx => {
      const staged = await change(tx);
      stagedId = (staged as {id: string}).id;
      throw new Error('test rollback after all writes staged');
    }, c)});
    await assert.rejects(chatCommands(store).create(command), /test rollback/);
    assert.equal(await h.snapshot(CreateChatReceipts, command.requestId, context), undefined);
    assert.equal(await h.snapshot(Chats, stagedId, context), undefined);
    await h.commit(async tx => assert.equal((await tx.scanConversations({}, 100)).items.length, 1), context);
    const chat = await chatCommands(durableChatStore(h)).create(command);
    assert.deepEqual(await h.snapshot(Chats, chat.id, context), chat);
  });
});

test('future receipt version is refused without rewriting the original value', async t => {
  const dir = await directory(t);
  await (await openRuntime(dir)).close();
  const Future = defineDocFamily({kind: 'point.command.chat-create', version: 2, scope: 'session', family: true,
    initial: (name: string) => ({name, future: true})});
  await inspect(dir, async h => {
    await h.commit(async tx => { await tx.doc(Future, command.requestId, command.name); }, context);
    await assert.rejects(chatCommands(durableChatStore(h)).create(command));
    assert.deepEqual(await h.snapshot(Future, command.requestId, context), {name: command.name, future: true});
    await h.commit(async tx => assert.equal((await tx.scanConversations({}, 100)).items.length, 1), context);
  });
});

for (const boundary of ['before', 'after'] as const) {
  test(`SIGKILL ${boundary} commit: restart observes all or nothing and retry is safe`, {timeout: 15000}, async t => {
    const dir = await directory(t);
    await (await openRuntime(dir)).close();
    const child = fork(new URL('./fixtures/chat-crash.js', import.meta.url), [dir, boundary], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    const exited = once(child, 'exit');
    try {
      const message = await Promise.race([
        once(child, 'message', {signal: AbortSignal.timeout(10000)}).then(([value]) => value as {id: string}),
        exited.then(() => { throw new Error(`child exited before boundary: ${stderr}`); }),
      ]);
      child.kill('SIGKILL');
      await exited;
      await inspect(dir, async h => {
        const count = boundary === 'before' ? 1 : 2;
        await h.commit(async tx => assert.equal((await tx.scanConversations({}, 100)).items.length, count), context);
        const receipt = await h.snapshot(CreateChatReceipts, command.requestId, context);
        assert.equal(Boolean(receipt), boundary === 'after');
        assert.equal(Boolean(await h.snapshot(Chats, message.id, context)), boundary === 'after');
      });
      const runtime = await openRuntime(dir);
      try {
        const chat = await runtime.chats.create(command);
        if (boundary === 'after') assert.equal(chat.id, message.id);
        assert.deepEqual(await runtime.chats.create(command), chat);
        assert.deepEqual(await runtime.chats.get(chat.id), chat);
      } finally { await runtime.close(); }
      await inspect(dir, async h => h.commit(async tx => assert.equal((await tx.scanConversations({}, 100)).items.length, 2), context));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
}
