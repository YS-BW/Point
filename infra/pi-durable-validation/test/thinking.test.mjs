import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openService } from '../src/service.mjs';

// No model requests: verify the persisted configuration with the real model catalog.
test('Thinking defaults follow Pi model capabilities and migrate persisted chats without losing history', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'point-thinking-'));
  const options = { dataDir, model: 'deepseek/deepseek-flash' };
  let service = await openService(options);
  t.after(async () => { if (service) await service.close(); });
  assert.equal((await service.snapshot()).thinkingLevel, 'high');
  const side = await service.createChat({ name: 'Existing topic' });
  const fork = await service.createChat({ name: 'Forked topic', mode: 'fork' });
  const rootId = service.root.id;
  await service.root.commit(tx => tx.appendEntry(rootId, {
    kind: 'point.message', data: { chatId: 'main', text: 'KEEP_THINKING_HISTORY_418' },
    model: [{ role: 'user', content: 'KEEP_THINKING_HISTORY_418', timestamp: Date.now() }],
  }), BACKGROUND_CONTEXT);
  // Emulate the old prototype's saved off settings.
  for (const id of [rootId, side.conversationId, fork.conversationId]) {
    const conversation = await service.harness.conversation(id, BACKGROUND_CONTEXT);
    await conversation.configure({ thinkingLevel: 'off' }, BACKGROUND_CONTEXT);
  }
  await service.close(); service = undefined;
  service = await openService(options);
  assert.equal(service.root.id, rootId);
  for (const id of [rootId, side.conversationId, fork.conversationId]) {
    const conversation = await service.harness.conversation(id, BACKGROUND_CONTEXT);
    assert.equal((await conversation.agent(BACKGROUND_CONTEXT)).thinkingLevel, 'high');
  }
  assert.match(JSON.stringify(await service.chatContext('main')), /KEEP_THINKING_HISTORY_418/);
  await service.close(); service = undefined;
  service = await openService({ ...options, thinkingLevel: 'off' });
  assert.equal((await service.snapshot()).thinkingLevel, 'off');
  assert.equal((await (await service.harness.conversation(side.conversationId, BACKGROUND_CONTEXT)).agent(BACKGROUND_CONTEXT)).thinkingLevel, 'off');
});

test('Thinking stays off for a non-reasoning model and rejects unknown settings', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'point-thinking-faux-'));
  const service = await openService({ dataDir });
  t.after(() => service.close());
  assert.equal((await service.snapshot()).thinkingLevel, 'off');
  await assert.rejects(openService({ dataDir: join(dataDir, 'invalid'), thinkingLevel: 'invalid' }), /Invalid thinking level/);
});
