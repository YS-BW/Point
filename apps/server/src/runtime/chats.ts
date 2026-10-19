import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness } from '@earendil-works/pi-durable';
import type { ChatStore } from '../application/chats.js';
import { CommandError } from '../domain/chat.js';
import { Chats, CreateChatReceipts, type ChatDocument } from '../storage/chats.js';
import { appendEvent } from './events.js';
import { indexReceipt, writeChatIndex } from './state-index.js';

export function durableChatStore(harness: Pick<Harness, 'commit' | 'snapshot'>): ChatStore {
  return {
    create(command) {
      return harness.commit(async tx => {
        const receipt = await tx.doc(CreateChatReceipts, command.requestId, command.name);
        if (receipt.name !== command.name) throw new CommandError('IDEMPOTENCY_CONFLICT');
        if (receipt.result) return {...receipt.result};
        const conversation = await tx.createConversation({ownership: {kind: 'ownerless'}});
        const now = Date.now();
        const chat = {id: String(conversation.id), name: command.name, createdAt: now};
        await tx.doc(Chats, chat.id, chat as ChatDocument);
        // v2 derived families, same commit: read-side index, event timeline and request ledger.
        await writeChatIndex(tx, chat, now);
        await appendEvent(tx, {
          type: 'chat.created', aggregate: 'chat', aggregateId: chat.id, revision: 0, at: now,
          data: {name: chat.name},
        });
        await indexReceipt(tx, {
          family: 'point.command.chat-create', receiptKey: command.requestId,
          referencedId: chat.id, terminal: true, createdAt: now,
        });
        receipt.result = chat;
        return {...chat};
      }, BACKGROUND_CONTEXT);
    },
    async get(id) {
      const chat = await harness.snapshot(Chats, id, BACKGROUND_CONTEXT);
      return chat ? {...chat} : undefined;
    },
  };
}
