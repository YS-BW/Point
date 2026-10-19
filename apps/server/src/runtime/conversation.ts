import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { configure, defineTask, type Harness, type ModelRef, type Extension, type ConversationId, type TaskId, type SubmissionId, type Cursor } from '@earendil-works/pi-durable';
import { CommandError } from '../domain/chat.js';
import { parseConversationCommand, type ConversationCommand } from '../domain/conversation-command.js';
import type { ConversationCommands, ConversationResult, HistoryItem } from '../application/conversation.js';
import { Chats } from '../storage/chats.js';
import { CommandHead, CommandReceipts } from '../storage/conversation.js';

type Input = ConversationCommand & {previous: number};
type Result = {submissionId: number} | {stopped: true};
export function conversationRuntime(getHarness: () => Harness, model: ModelRef | undefined, guard: Extension) {
  const Command = defineTask<Input, {phase: 'order'} | {phase: 'execute'}, Result>({
    name: 'point.conversation.command', version: 1, initial: () => ({phase: 'order'}),
    phases: {
      async order(task, runtime, ctx) {
        await runtime.commit(() => task.input.previous
          ? {status: 'waiting', checkpoint: {phase: 'execute'}, on: [task.input.previous as TaskId], policy: 'allSettled'}
          : {status: 'running', checkpoint: {phase: 'execute'}}, ctx);
      },
      async execute(task, runtime, ctx) {
        const conversation = await runtime.conversation(Number(task.input.chatId) as ConversationId, ctx);
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

  async function admit(input: unknown, kind: 'send' | 'stop') {
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
      if (model) await configure(tx, Number(command.chatId) as ConversationId, {model, extensions: [guard], tools: []});
      const taskId = await tx.createTask(Command, {...command, previous: head.taskId}, {
        conversationId: Number(command.chatId) as ConversationId, ownership: {kind: 'conversation'}, background: true,
      });
      receipt.taskId = head.taskId = taskId;
      return String(taskId);
    }, context);
    h.resume();
    return {commandId};
  }
  const commands: ConversationCommands = {
    send: input => admit(input, 'send'), stop: input => admit(input, 'stop'),
    async status(commandId) {
      if (!/^[1-9][0-9]*$/.test(commandId) || !Number.isSafeInteger(Number(commandId))) throw new CommandError('INVALID_COMMAND');
      const h = getHarness();
      const task = await h.getTask(Number(commandId) as TaskId<Result>, context);
      if (!task || task.kind !== Command.definition.name) throw new Error('COMMAND_NOT_FOUND');
      if (task.state.status !== 'terminal' && task.state.status !== 'completing') return {status: 'accepted'};
      if (task.state.outcome.status !== 'completed') return {status: 'failed'};
      const result = task.state.outcome.result;
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
      if (!/^[1-9][0-9]*$/.test(commandId) || !Number.isSafeInteger(Number(commandId))) throw new CommandError('INVALID_COMMAND');
      const h = getHarness();
      const record = await h.getTask(Number(commandId) as TaskId, context);
      if (!record || record.kind !== Command.definition.name) throw new Error('COMMAND_NOT_FOUND');
      const task = await h.waitForTask(Number(commandId) as TaskId<Result>, context);
      if (task.state.outcome.status !== 'completed') return {status: 'failed'};
      const result = task.state.outcome.result;
      if ('stopped' in result) return {status: 'stopped'};
      const submission = await h.submission(result.submissionId as SubmissionId, context);
      if (!submission) return {status: 'failed'};
      const settled = await submission.wait(context);
      return settled.status === 'done' && settled.answer !== undefined
        ? {status: 'answered', answerEntryId: String(settled.answer)} : {status: 'unanswered'};
    },
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
      for (const entry of page.items) for (const message of entry.model ?? []) {
        if (message.role !== 'user' && message.role !== 'assistant') continue;
        const text = typeof message.content === 'string' ? message.content
          : message.content.filter(part => part.type === 'text').map(part => part.text).join('');
        if (text) items.push({id: String(entry.id), role: message.role, text,
          interrupted: message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason)});
      }
      return {...(page.next === undefined ? {} : {next: JSON.stringify(page.next)}), items};
    },
  };
  return {commands, extension: {name: 'point.conversation', tasks: [Command]} satisfies Extension};
}
