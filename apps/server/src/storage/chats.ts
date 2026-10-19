import { defineDocFamily } from '@earendil-works/pi-durable';
import type { Chat } from '../domain/chat.js';

export type ChatDocument = Chat;

export const Chats = defineDocFamily({
  kind: 'point.chat', version: 2, scope: 'session', family: true,
  initial: (chat: ChatDocument) => ({...chat}),
  // v2 is a versioned shape freeze: the Chat fields are stable, so migration is the identity.
  migrate: value => value as unknown as ChatDocument,
});

/** Immutable command outcome, not the current state of the conversation. */
export const CreateChatReceipts = defineDocFamily({
  kind: 'point.command.chat-create', version: 1, scope: 'session', family: true,
  initial: (name: string): {name: string; result: Chat | null} => ({name, result: null}),
});
