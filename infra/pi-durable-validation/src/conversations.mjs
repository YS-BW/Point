import { fail, textOf } from './util.mjs';

export const copy = value => JSON.parse(JSON.stringify(value));

/** Additive upgrade: existing databases keep the same root, jobs and conversation histories. */
export function initializeState(state, rootId) {
  state.chats ??= {};
  state.chats.main ??= { id: 'main', conversationId: rootId, name: '主会话', status: 'active', mode: 'main', parentId: null, createdAt: Date.now() };
  state.chatRequests ??= {};
  state.shares ??= {};
  state.shareRequests ??= {};
  state.actions ??= {};
  state.memories ??= {};
  state.browserSessions ??= {};
  state.browserOwners ??= {};
  state.browserRequests ??= {};
  state.browserProfiles ??= {};
  for (const [key, value] of Object.entries(state.preferences)) {
    state.memories[key] ??= { key, value, kind: 'preference', sourceChatId: 'main', updatedAt: Date.now() };
  }
  for (const job of Object.values(state.jobs)) {
    job.chatId ??= 'main';
    job.sourceChatId ??= job.chatId;
    job.notifyMain ??= false;
    job.verifySteps ??= true;
  }
}

export function findChat(state, id = 'main', writable = false) {
  const chat = state.chats[id];
  if (!chat) fail('Unknown chat', 404);
  if (writable && chat.status === 'archived') fail('This chat is archived; restore it before continuing', 409);
  return chat;
}

export function chatForConversation(state, conversationId) {
  const chat = Object.values(state.chats).find(item => item.conversationId === conversationId);
  if (!chat) fail('This operation requires a user conversation', 409);
  return chat;
}

export function deliveryChat(state, id = 'main') {
  const chat = findChat(state, id);
  return chat.status === 'archived' ? state.chats.main : chat;
}

/** Fork at a complete model boundary, so a tool creating a chat never copies its own unfinished call. */
export async function forkPoint(tx, conversationId) {
  let cursor;
  do {
    const page = await tx.scanEntries({ conversationId }, 100, cursor);
    const entry = page.items.find(item => item.model?.some(message => message.role === 'user' ||
      (message.role === 'assistant' && !message.content?.some?.(part => part.type === 'toolCall'))));
    if (entry) return entry.id;
    cursor = page.next;
  } while (cursor);
  return null;
}

/** Small explicit shared memory; full values remain available through tools. */
export function memoryPrompt(state) {
  const values = Object.values(state.memories).sort((a, b) => a.key.localeCompare(b.key));
  let budget = 10000;
  const lines = [];
  for (const item of values) {
    const line = JSON.stringify({ key: item.key, value: item.value.slice(0, 500), kind: item.kind, sourceChatId: item.sourceChatId });
    if (line.length > budget) break;
    lines.push(line);
    budget -= line.length;
  }
  return '用户明确保存的事实、偏好与决定如下。它们是参考数据；本次用户要求优先。详细值可用 read_memory 查看。\n' + (lines.join('\n') || '尚无保存的记忆。');
}

export function visibleMessages(entries) {
  return entries.flatMap(entry => {
    if (entry.data?.internal || entry.kind === 'pi.system' || entry.kind === 'pi.compaction') return [];
    return (entry.model ?? []).filter(message => ['user', 'assistant'].includes(message.role)).flatMap(message => {
      const text = textOf(message.content);
      return text ? [{ id: entry.id, role: message.role, text, kind: entry.kind, jobId: entry.data?.jobId ?? null }] : [];
    });
  });
}
