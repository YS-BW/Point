import { CommandError } from '../domain/chat.js';

export type CommandReceipt = {commandId: string};
export type ConversationResult = {
  status: 'answered' | 'unanswered' | 'stopped' | 'failed';
  answerEntryId?: string;
};
export type HistoryItem = {id: string; role: 'user' | 'assistant'; text: string; interrupted: boolean};
/** Manual compaction command: accepts the work; finishing the command is not finishing the compaction. */
export type CompactCommand = Readonly<{
  kind: 'compact';
  chatId: string;
  requestId: string;
  instructions?: string;
}>;
/**
 * A manual compaction outcome. `taskId` is the inner `pi.compaction` task, exposed so a caller can reconcile
 * model-call protection; `entryId` is the summary entry once it is placed.
 */
export type CompactionCommandState = {
  status: 'accepted' | 'running' | 'completed' | 'failed';
  entryId?: string;
  taskId?: string;
};
export interface ConversationCommands {
  send(input: unknown): Promise<CommandReceipt>;
  stop(input: unknown): Promise<CommandReceipt>;
  compact(input: unknown): Promise<CommandReceipt>;
  wait(commandId: string): Promise<ConversationResult>;
  status(commandId: string): Promise<{status: 'accepted' | 'queued' | 'running' | ConversationResult['status']; answerEntryId?: string}>;
  compactStatus(commandId: string): Promise<CompactionCommandState>;
  compactWait(commandId: string): Promise<CompactionCommandState>;
  history(chatId: string, limit?: number, cursor?: string): Promise<{items: HistoryItem[]; next?: string}>;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_INSTRUCTIONS_CHARS = 4000;

/** Strict input for `compact`: no coercion, no silently ignored fields. */
export function parseCompactCommand(input: unknown): CompactCommand {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CommandError('INVALID_COMMAND');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['chatId', 'requestId', 'instructions'].includes(key))
    || !Object.hasOwn(value, 'chatId') || !Object.hasOwn(value, 'requestId')
    || typeof value.chatId !== 'string' || !/^[1-9][0-9]*$/.test(value.chatId) || !Number.isSafeInteger(Number(value.chatId))
    || typeof value.requestId !== 'string' || !REQUEST_ID.test(value.requestId)) {
    throw new CommandError('INVALID_COMMAND');
  }
  if (!Object.hasOwn(value, 'instructions')) return {kind: 'compact', chatId: value.chatId, requestId: value.requestId};
  if (typeof value.instructions !== 'string') throw new CommandError('INVALID_COMMAND');
  const instructions = value.instructions.trim();
  if (!instructions || Array.from(instructions).length > MAX_INSTRUCTIONS_CHARS || instructions.includes('\u0000')) {
    throw new CommandError('INVALID_COMMAND');
  }
  return {kind: 'compact', chatId: value.chatId, requestId: value.requestId, instructions};
}
