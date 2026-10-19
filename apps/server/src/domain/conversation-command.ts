import { CommandError } from './chat.js';

export type ConversationCommand = {kind: 'send' | 'stop'; chatId: string; requestId: string; text: string};
export function parseConversationCommand(input: unknown, kind: 'send' | 'stop'): ConversationCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CommandError('INVALID_COMMAND');
  const v = input as Record<string, unknown>;
  const keys = kind === 'send' ? ['chatId', 'requestId', 'text'] : ['chatId', 'requestId'];
  if (Object.keys(v).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(v, key))
    || typeof v.chatId !== 'string' || !/^[1-9][0-9]*$/.test(v.chatId) || !Number.isSafeInteger(Number(v.chatId))
    || typeof v.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(v.requestId)
    || (kind === 'send' && (typeof v.text !== 'string' || !v.text.trim() || v.text.length > 32000))) {
    throw new CommandError('INVALID_COMMAND');
  }
  return {kind, chatId: v.chatId, requestId: v.requestId, text: kind === 'send' ? v.text as string : ''};
}
