export type CommandReceipt = {commandId: string};
export type ConversationResult = {
  status: 'answered' | 'unanswered' | 'stopped' | 'failed';
  answerEntryId?: string;
};
export type HistoryItem = {id: string; role: 'user' | 'assistant'; text: string; interrupted: boolean};
export interface ConversationCommands {
  send(input: unknown): Promise<CommandReceipt>;
  stop(input: unknown): Promise<CommandReceipt>;
  wait(commandId: string): Promise<ConversationResult>;
  status(commandId: string): Promise<{status: 'accepted' | 'queued' | 'running' | ConversationResult['status']; answerEntryId?: string}>;
  history(chatId: string, limit?: number, cursor?: string): Promise<{items: HistoryItem[]; next?: string}>;
}
