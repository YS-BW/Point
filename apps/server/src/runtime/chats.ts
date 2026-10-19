import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness } from '@earendil-works/pi-durable';
import type { ChatStore } from '../application/chats.js';
import { CommandError } from '../domain/chat.js';
import { Chats, CreateChatReceipts } from '../storage/chats.js';

export function durableChatStore(harness: Pick<Harness, 'commit' | 'snapshot'>): ChatStore {
  return {
    create(command) {
      return harness.commit(async tx => {
        const receipt = await tx.doc(CreateChatReceipts, command.requestId, command.name);
        if (receipt.name !== command.name) throw new CommandError('IDEMPOTENCY_CONFLICT');
        if (receipt.result) return {...receipt.result};
        const conversation = await tx.createConversation({ownership: {kind: 'ownerless'}});
        const chat = {id: String(conversation.id), name: command.name, createdAt: Date.now()};
        await tx.doc(Chats, chat.id, chat);
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
