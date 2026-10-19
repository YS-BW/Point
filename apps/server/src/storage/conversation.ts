import { defineDocFamily } from '@earendil-works/pi-durable';

export const CommandReceipts = defineDocFamily({
  kind: 'point.conversation.command', version: 1, scope: 'session', family: true,
  initial: (fingerprint: string) => ({fingerprint, taskId: 0}),
});
/** Only the previous admission task, not a queue of messages or another execution engine. */
export const CommandHead = defineDocFamily({
  kind: 'point.conversation.command-head', version: 1, scope: 'session', family: true,
  initial: (_: null) => ({taskId: 0}),
});
/** Immutable outcome of a manual compaction command; the accepted intent, not the compaction result. */
export const CompactReceipts = defineDocFamily({
  kind: 'point.command.compact', version: 1, scope: 'session', family: true,
  initial: (fingerprint: string) => ({fingerprint, taskId: 0}),
});
export const ModelCalls = defineDocFamily({
  kind: 'point.model-call', version: 1, scope: 'session', family: true,
  initial: (chatId: string): {chatId: string; state: 'new' | 'attempting' | 'done' | 'unknown' | 'failed'} => ({chatId, state: 'new'}),
});
