import { parseCreateChat, type Chat, type CreateChat } from '../domain/chat.js';

/** The implementation must commit the conversation, metadata and receipt atomically. */
export interface ChatStore {
  create(command: CreateChat): Promise<Chat>;
  get(id: string): Promise<Chat | undefined>;
}
export interface ChatCommands {
  create(input: unknown): Promise<Chat>;
  get(id: string): Promise<Chat | undefined>;
}
export function chatCommands(store: ChatStore): ChatCommands {
  return {
    async create(input) { return store.create(parseCreateChat(input)); },
    async get(id) {
      // IDs are opaque at the application boundary; reject invalid forms without I/O.
      if (typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id))) return undefined;
      return store.get(id);
    },
  };
}
