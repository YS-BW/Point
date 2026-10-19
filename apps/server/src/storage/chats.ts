import { defineDocFamily } from '@earendil-works/pi-durable';
import type { Chat } from '../domain/chat.js';

export const Chats = defineDocFamily({
  kind: 'point.chat', version: 1, scope: 'session', family: true,
  initial: (chat: Chat) => ({...chat}),
});

/** Immutable command outcome, not the current state of the conversation. */
export const CreateChatReceipts = defineDocFamily({
  kind: 'point.command.chat-create', version: 1, scope: 'session', family: true,
  initial: (name: string): {name: string; result: Chat | null} => ({name, result: null}),
});
