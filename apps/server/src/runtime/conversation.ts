import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  CompactionEntry, CompactionTask, configure, defineTask, ProviderDoc,
  type CompactionResult, type ConversationId, type Cursor, type Extension, type Harness,
  type ModelRef, type SubmissionId, type TaskId, type Tx,
} from '@earendil-works/pi-durable';
import { CommandError } from '../domain/chat.js';
import { parseConversationCommand, type ConversationCommand } from '../domain/conversation-command.js';
import {
  parseCompactCommand,
  type CompactCommand, type CompactionCommandState, type ConversationCommands, type ConversationResult, type HistoryItem,
} from '../application/conversation.js';
import { Chats } from '../storage/chats.js';
import { CommandHead, CompactReceipts, CommandReceipts } from '../storage/conversation.js';
import { indexReceipt } from './state-index.js';

type Input = (ConversationCommand | CompactCommand) & {previous: number};
type Result = {submissionId: number} | {stopped: true} | {compactionTaskId: number};

const TASK_ID = /^[1-9][0-9]*$/;
const isTaskId = (value: string) => TASK_ID.test(value) && Number.isSafeInteger(Number(value));

export function conversationRuntime(getHarness: () => Harness, model: ModelRef | undefined, extensions: readonly Extension[]) {
  const Command = defineTask<Input, {phase: 'order'} | {phase: 'execute'}, Result>({
    name: 'point.conversation.command', version: 1, initial: () => ({phase: 'order'}),
    phases: {
      async order(task, runtime, ctx) {
        await runtime.commit(() => task.input.previous
          ? {status: 'waiting', checkpoint: {phase: 'execute'}, on: [task.input.previous as TaskId], policy: 'allSettled'}
          : {status: 'running', checkpoint: {phase: 'execute'}}, ctx);
      },
      async execute(task, runtime, ctx) {
        const conversationId = Number(task.input.chatId) as ConversationId;
        if (task.input.kind === 'compact') {
          // Transaction boundary: the admission commit wrote the receipt and this command task; this
          // execution commit creates the inner `pi.compaction` task and settles the command. The inner
          // task is the real execution identity (it owns the summary and its model call), so a completed
          // command only means the work was accepted. The SDK's `pi.live.compactions` display status is
          // not registered for this direct creation (UI-only; the public ConversationHandle has no
          // compact(), and the command task must stay self-contained and replayable).
          const input = {reason: 'manual' as const, ...(task.input.instructions === undefined ? {} : {instructions: task.input.instructions})};
          await runtime.commit(async tx => {
            const compaction = await tx.createTask(CompactionTask, input, {
              conversationId, ownership: {kind: 'conversation'}, background: false,
            });
            return {status: 'terminal', outcome: {status: 'completed', result: {compactionTaskId: compaction}}};
          }, ctx);
          return;
        }
        const conversation = await runtime.conversation(conversationId, ctx);
        if (!conversation) throw new Error('CHAT_NOT_FOUND');
        let result: Result;
        if (task.input.kind === 'stop') {
          await conversation.abort(ctx);
          result = {stopped: true};
        } else {
          const submission = await conversation.submit({type: 'input', content: task.input.text,
            requestId: `point-command:${task.id}`, whenBusy: 'followUp'}, ctx);
          result = {submissionId: submission.id};
        }
        await runtime.commit(() => ({status: 'terminal', outcome: {status: 'completed', result}}), ctx);
      },
    },
    async abort(_task, runtime, ctx) {
      await runtime.commit(() => ({status: 'terminal', outcome: {status: 'aborted'}}), ctx);
    },
  });

  function configureAgent(tx: Tx, chatId: string) {
    if (!model) return Promise.resolve();
    return configure(tx, Number(chatId) as ConversationId, {model, extensions, tools: []});
  }

  async function admitMessage(input: unknown, kind: 'send' | 'stop') {
    const command = parseConversationCommand(input, kind);
    const h = getHarness();
    if (!model) throw new Error('MODEL_NOT_CONFIGURED');
    if (!(await h.snapshot(Chats, command.chatId, context))) throw new Error('CHAT_NOT_FOUND');
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const commandId = await h.commit(async tx => {
      const receipt = await tx.doc(CommandReceipts, `${command.chatId}:${command.requestId}`, fingerprint);
      if (receipt.fingerprint !== fingerprint) throw new CommandError('IDEMPOTENCY_CONFLICT');
      if (receipt.taskId) return String(receipt.taskId);
      const head = await tx.doc(CommandHead, command.chatId, null);
      // Conversation configuration and accepted command share this transaction.
      await configureAgent(tx, command.chatId);
      const taskId = await tx.createTask(Command, {...command, previous: head.taskId}, {
        conversationId: Number(command.chatId) as ConversationId, ownership: {kind: 'conversation'}, background: true,
      });
      receipt.taskId = head.taskId = taskId;
      return String(taskId);
    }, context);
    h.resume();
    return {commandId};
  }

  async function admitCompact(input: unknown) {
    const command = parseCompactCommand(input);
    const h = getHarness();
    if (!model) throw new Error('MODEL_NOT_CONFIGURED');
    if (!(await h.snapshot(Chats, command.chatId, context))) throw new Error('CHAT_NOT_FOUND');
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    // One commit: immutable receipt + command task (+ conversation configuration and provider identity).
    // The command task creates the inner compaction task later, in its own execution commit; this commit
    // is the acceptance boundary, not the compaction boundary.
    const commandId = await h.commit(async tx => {
      // Receipt keys are scoped per chat, like send/stop: one requestId may name a compaction in each chat.
      const receipt = await tx.doc(CompactReceipts, `${command.chatId}:${command.requestId}`, fingerprint);
      if (receipt.fingerprint !== fingerprint) throw new CommandError('IDEMPOTENCY_CONFLICT');
      if (receipt.taskId) return String(receipt.taskId);
      const conversationId = Number(command.chatId) as ConversationId;
      // The compaction model call is protected through the persisted provider identity, so it must exist
      // before the inner task can reach its summarize phase.
      await tx.doc(ProviderDoc, conversationId);
      await configureAgent(tx, command.chatId);
      const taskId = await tx.createTask(Command, {...command, previous: 0}, {
        conversationId, ownership: {kind: 'conversation'}, background: true,
      });
      receipt.taskId = taskId;
      await indexReceipt(tx, {
        family: 'point.command.compact', receiptKey: `${command.chatId}:${command.requestId}`,
        referencedId: String(taskId), terminal: false,
      });
      return String(taskId);
    }, context);
    h.resume();
    return {commandId};
  }

  async function commandRecord(commandId: string, harness: Harness) {
    if (!isTaskId(commandId)) throw new CommandError('INVALID_COMMAND');
    const id = Number(commandId) as TaskId<Result>;
    const record = await harness.getTask(id, context);
    if (!record || record.kind !== Command.definition.name) throw new Error('COMMAND_NOT_FOUND');
    return {id, record};
  }

  /** Maps the inner `pi.compaction` task; accepted only means the command itself has not settled. */
  async function compactState(commandId: string, wait: boolean): Promise<CompactionCommandState> {
    const h = getHarness();
    const {id, record} = await commandRecord(commandId, h);
    const settled = wait ? await h.waitForTask(id, context) : record;
    const state = settled.state;
    if (state.status !== 'terminal' && state.status !== 'completing') return {status: 'accepted'};
    if (state.outcome.status !== 'completed') return {status: 'failed'};
    const result = state.outcome.result;
    if (!('compactionTaskId' in result)) throw new Error('COMMAND_NOT_FOUND');
    const innerId = result.compactionTaskId as TaskId<CompactionResult>;
    const taskId = String(innerId);
    if (wait) await h.waitForTask(innerId, context);
    const inner = await h.getTask(innerId, context);
    if (!inner) return {status: 'failed', taskId};
    const innerState = inner.state;
    if (innerState.status !== 'terminal' && innerState.status !== 'completing') return {status: 'running', taskId};
    if (innerState.outcome.status !== 'completed') return {status: 'failed', taskId};
    const outcome = innerState.outcome.result;
    if (outcome.entryId !== undefined) return {status: 'completed', entryId: String(outcome.entryId), taskId};
    if (outcome.submissionId === undefined) return {status: 'completed', taskId};
    const submission = await h.submission(outcome.submissionId as SubmissionId, context);
    if (!submission) return {status: 'failed', taskId};
    if (wait) {
      const finished = await submission.wait(context);
      return finished.status === 'done'
        ? {status: 'completed', entryId: String(finished.entry), taskId} : {status: 'failed', taskId};
    }
    const current = await submission.status(context);
    if (current.status === 'done') return {status: 'completed', entryId: String(current.entry), taskId};
    if (current.status === 'unanswered') return {status: 'failed', taskId};
    return {status: 'running', taskId};
  }

  const commands: ConversationCommands = {
    send: input => admitMessage(input, 'send'),
    stop: input => admitMessage(input, 'stop'),
    compact: admitCompact,
    async status(commandId) {
      if (!isTaskId(commandId)) throw new CommandError('INVALID_COMMAND');
      const h = getHarness();
      const task = await h.getTask(Number(commandId) as TaskId<Result>, context);
      if (!task || task.kind !== Command.definition.name) throw new Error('COMMAND_NOT_FOUND');
      if (task.state.status !== 'terminal' && task.state.status !== 'completing') return {status: 'accepted'};
      if (task.state.outcome.status !== 'completed') return {status: 'failed'};
      const result = task.state.outcome.result;
      if ('compactionTaskId' in result) throw new Error('COMMAND_NOT_FOUND');
      if ('stopped' in result) return {status: 'stopped'};
      const submission = await h.submission(result.submissionId as SubmissionId, context);
      if (!submission) return {status: 'failed'};
      const state = await submission.status(context);
      if (state.status === 'queued') return {status: 'queued'};
      if (state.status === 'placed') return {status: 'running'};
      return state.status === 'done' && state.answer !== undefined
        ? {status: 'answered', answerEntryId: String(state.answer)} : {status: 'unanswered'};
    },
    async wait(commandId): Promise<ConversationResult> {
      if (!model) {
        const state = await commands.status(commandId);
        if (['accepted', 'queued', 'running'].includes(state.status)) throw new Error('MODEL_NOT_CONFIGURED');
        return state as ConversationResult;
      }
      if (!isTaskId(commandId)) throw new CommandError('INVALID_COMMAND');
      const h = getHarness();
      const record = await h.getTask(Number(commandId) as TaskId<Result>, context);
      if (!record || record.kind !== Command.definition.name) throw new Error('COMMAND_NOT_FOUND');
      const task = await h.waitForTask(Number(commandId) as TaskId<Result>, context);
      if (task.state.outcome.status !== 'completed') return {status: 'failed'};
      const result = task.state.outcome.result;
      if ('compactionTaskId' in result) throw new Error('COMMAND_NOT_FOUND');
      if ('stopped' in result) return {status: 'stopped'};
      const submission = await h.submission(result.submissionId as SubmissionId, context);
      if (!submission) return {status: 'failed'};
      const settled = await submission.wait(context);
      return settled.status === 'done' && settled.answer !== undefined
        ? {status: 'answered', answerEntryId: String(settled.answer)} : {status: 'unanswered'};
    },
    compactStatus: commandId => compactState(commandId, false),
    compactWait: commandId => compactState(commandId, true),
    async history(chatId, limit = 50, cursor) {
      if (!/^[1-9][0-9]*$/.test(chatId) || !Number.isSafeInteger(Number(chatId))
        || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new CommandError('INVALID_COMMAND');
      const h = getHarness();
      if (!(await h.snapshot(Chats, chatId, context))) throw new Error('CHAT_NOT_FOUND');
      const conversation = await h.conversation(Number(chatId) as ConversationId, context);
      if (!conversation) throw new Error('CHAT_NOT_FOUND');
      let parsed: Cursor | undefined;
      if (cursor !== undefined) {
        try {
          if (typeof cursor !== 'string' || cursor.length > 4096) throw new Error();
          const value: unknown = JSON.parse(cursor);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          parsed = value as Cursor;
        } catch { throw new CommandError('INVALID_COMMAND'); }
      }
      const page = await conversation.entries({order: 'ascending'}, limit, parsed, context);
      const items: HistoryItem[] = [];
      for (const entry of page.items) {
        // Compaction summaries are context, not chat messages: the projection excludes them.
        if (CompactionEntry.is(entry)) continue;
        for (const [index, message] of (entry.model ?? []).entries()) {
          if (message.role !== 'user' && message.role !== 'assistant') continue;
          const text = typeof message.content === 'string' ? message.content
            : message.content.filter(part => part.type === 'text').map(part => part.text).join('');
          if (text) items.push({id: index === 0 ? String(entry.id) : `${entry.id}:${index}`, role: message.role, text,
            interrupted: message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason)});
        }
      }
      return {...(page.next === undefined ? {} : {next: JSON.stringify(page.next)}), items};
    },
  };
  return {commands, extension: {name: 'point.conversation', tasks: [Command]} satisfies Extension};
}
