/**
 * Runtime side of the AG-UI projection: consumes only public pi-durable APIs
 * (`watchEvents`, `Harness.submission`) and emits the
 * provider-neutral events from `application/agent-stream.ts`. No AG-UI type may appear
 * here; the edge (`api/agui/**`) owns the wire protocol.
 */

import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  watchEvents,
  type AgentEvent, type AgentEventStream, type EntryRecord, type Harness, type SubmissionId,
} from '@earendil-works/pi-durable';
import type { ConversationId } from '@earendil-works/pi-durable';
import { canonicalJson } from '../application/resource.js';
import type { ConversationCommands } from '../application/conversation.js';
import type {
  AgentRunEvent, AgentRunPort, AgentRunRequest, AgentRunStream,
} from '../application/agent-stream.js';

/** Stop projecting when the run stops making progress; prevents a hung stream. */
const IDLE_TIMEOUT_MS = 120_000;
const SETTLE_TIMEOUT_MS = 5_000;
const TOOL_RESULT_CHARS = 8_192;
const CANCELLED_REASONS = new Set(['aborted', 'stopped', 'cancelled']);

function bound(text: string): string {
  const chars = Array.from(text);
  return chars.length <= TOOL_RESULT_CHARS ? text : `${chars.slice(0, TOOL_RESULT_CHARS).join('')}…[truncated]`;
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map(item => {
    if (item === null || typeof item !== 'object') return '';
    const part = item as {type?: unknown; text?: unknown};
    return part.type === 'text' && typeof part.text === 'string' ? part.text : '';
  }).join('');
}

/** One tool result string for the edge; the Durable entry is authoritative when present. */
function toolResult(event: Extract<AgentEvent, {type: 'tool_execution_end'}>): {content: string; isError: boolean} {
  if (event.entry !== undefined) {
    const message = event.entry.model?.[0];
    if (message !== undefined && message.role === 'toolResult') {
      return {content: bound(textOfContent(message.content)), isError: message.isError === true};
    }
  }
  if (event.result !== undefined) {
    const value = event.result.structuredOutput ?? event.result.details ?? event.result.diagnostics;
    return {content: bound(value === undefined ? '' : canonicalJson(value as never)), isError: event.result.isError};
  }
  return {content: '', isError: false};
}

function assistantEntry(entry: EntryRecord | undefined): boolean {
  return entry?.model?.[0]?.role === 'assistant';
}

export function agentRuntime(conversation: ConversationCommands, getHarness: () => Harness): AgentRunPort {
  return {
    async start(request: AgentRunRequest, signal: AbortSignal): Promise<AgentRunStream> {
      if (!/^[1-9][0-9]*$/.test(request.chatId)) throw new Error('CHAT_NOT_FOUND');
      const harness = getHarness();
      const conversationId = Number(request.chatId) as ConversationId;
      // Attach before admission so the run cannot start unseen.
      const stream = await watchEvents(harness, conversationId, context);
      let stopped: Promise<unknown> | undefined;
      const stop = (): Promise<unknown> => stopped ??= stream.stop().catch(() => undefined);
      let command;
      try {
        command = await conversation.send({chatId: request.chatId, text: request.text, requestId: request.requestId});
      } catch (error) {
        await stop();
        throw error;
      }
      const marker = `point-command:${command.commandId}`;
      return {
        events: project(stream, marker, harness, conversationId, signal, stop, conversation, command.commandId),
        cancel: async () => { await stop(); },
      };
    },
  };
}

async function* project(
  stream: AgentEventStream,
  marker: string,
  harness: Harness,
  conversationId: ConversationId,
  signal: AbortSignal,
  stop: () => Promise<unknown>,
  conversation: ConversationCommands,
  commandId: string,
): AsyncGenerator<AgentRunEvent> {
  const queue: AgentEvent[] = [];
  const streamId = randomUUID();
  let overflow = false;
  let wake: (() => void) | undefined;
  const notify = (): void => { const resume = wake; wake = undefined; resume?.(); };
  stream.start(async events => {
    // A slow transport must not create an unbounded second event backlog.
    if (queue.length + events.length > 1024) { overflow = true; queue.length = 0; }
    else if (!overflow) queue.push(...events);
    notify();
  });
  let onAbort: () => void;
  const aborted = new Promise<void>(resolve => { onAbort = resolve; });
  if (signal.aborted) onAbort!();
  else signal.addEventListener('abort', onAbort!, {once: true});
  let submissionId: string | undefined;
  let activeRun = false;
  let runEnded = false;
  let settled: {status: 'done'} | {status: 'unanswered'; reason: string} | undefined;
  const pendingRunStarts: Extract<AgentEvent, {type: 'run_start'}>[] = [];
  let message: {id: string; content: Map<number, string>; emitted: string} | undefined;
  let messageSeq = 0;
  let turn = 0;
  let step: string | undefined;
  const openTools = new Set<string>();
  let lastActivity = Date.now();

  const bindSubmission = (id: string): void => {
    if (submissionId !== undefined) return;
    submissionId = id;
    for (const start of pendingRunStarts.splice(0)) {
      if (start.inputs.some(input => String(input) === id)) activeRun = true;
    }
  };

  try {
    while (true) {
      if (overflow) throw new Error('OBSERVATION_RESYNC_REQUIRED');
      while (queue.length > 0) {
        const event = queue.shift()!;
        lastActivity = Date.now();
        if (event.type === 'snapshot') throw new Error('OBSERVATION_RESYNC_REQUIRED');
        if (event.type === 'submission') {
          const record = event.record;
          if (record.requestId === marker) {
            bindSubmission(String(record.id));
            if (record.status === 'done') settled = {status: 'done'};
            else if (record.status === 'unanswered') settled = {status: 'unanswered', reason: record.reason};
          }
          continue;
        }
        if (event.type === 'run_start') {
          if (submissionId === undefined) pendingRunStarts.push(event);
          else if (event.inputs.some(input => String(input) === submissionId)) activeRun = true;
          continue;
        }
        if (!activeRun) continue;
        switch (event.type) {
          case 'message_start':
            if (event.message.role === 'assistant') {
              message = {id: `draft-${streamId}-${++messageSeq}`, content: new Map(), emitted: ''};
              yield {type: 'message_start', messageId: message.id};
            }
            break;
          case 'message_update': {
            if (message === undefined) break;
            const current = message;
            const reconcile = function* (): Generator<AgentRunEvent> {
              const full = [...current.content.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, text]) => text)
                .join('');
              if (!full.startsWith(current.emitted)) return;
              const suffix = full.slice(current.emitted.length);
              current.emitted = full;
              if (suffix.length > 0) yield {type: 'text_delta', messageId: current.id, delta: suffix};
            };
            for (const change of event.changes) {
              if (change.type === 'text_delta') {
                current.content.set(change.contentIndex, (current.content.get(change.contentIndex) ?? '') + change.delta);
                yield* reconcile();
              } else if (change.type === 'block' && change.block.type === 'text') {
                current.content.set(change.contentIndex, change.block.text);
                yield* reconcile();
              } else if (change.type === 'message') {
                current.content.clear();
                for (const [index, block] of change.message.content.entries()) {
                  if (block.type === 'text') current.content.set(index, block.text);
                }
                yield* reconcile();
              }
            }
            break;
          }
          case 'message_end':
            if (message !== undefined && assistantEntry(event.entry)) {
              const model = event.entry?.model?.[0];
              if (model !== undefined && model.role === 'assistant') {
                let index = 0;
                for (const block of model.content) {
                  if (block.type === 'text') message.content.set(index, block.text);
                  index += 1;
                }
                const full = [...message.content.entries()]
                  .sort(([left], [right]) => left - right).map(([, text]) => text).join('');
                if (full.startsWith(message.emitted) && full.length > message.emitted.length) {
                  yield {type: 'text_delta', messageId: message.id, delta: full.slice(message.emitted.length)};
                }
              }
              yield {type: 'message_end', messageId: message.id};
              message = undefined;
            }
            break;
          case 'tool_execution_start':
            openTools.add(event.toolCallId);
            yield {
              type: 'tool_start', toolCallId: event.toolCallId, toolName: event.toolName,
              argsJson: canonicalJson(event.args as never),
            };
            break;
          case 'tool_execution_end': {
            if (!openTools.delete(event.toolCallId)) break;
            const result = toolResult(event);
            yield {type: 'tool_end', toolCallId: event.toolCallId, isError: result.isError};
            yield {type: 'tool_result', toolCallId: event.toolCallId, content: result.content, isError: result.isError};
            break;
          }
          case 'turn_start':
            step = `turn-${++turn}`;
            yield {type: 'step_start', name: step};
            break;
          case 'turn_end':
            if (step !== undefined) { yield {type: 'step_end', name: step}; step = undefined; }
            break;
          case 'run_end':
            if (event.inputs.some(input => String(input) === submissionId)) {
              activeRun = false;
              runEnded = true;
            }
            break;
          default:
            break;
        }
      }
      if (settled !== undefined) break;
      if (runEnded && submissionId !== undefined) {
        settled = await settle(harness, submissionId);
        break;
      }
      if (signal.aborted) return;
      // Also observe the durable command: retries attach after submission events already happened.
      const status = await conversation.status(commandId);
      if (status.status === 'answered') { settled = {status: 'done'}; break; }
      if (status.status === 'stopped') { settled = {status: 'unanswered', reason: 'stopped'}; break; }
      if (status.status === 'failed' || status.status === 'unanswered') {
        settled = {status: 'unanswered', reason: 'failed'}; break;
      }
      if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) throw new Error('OBSERVATION_TIMEOUT');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>(resolve => { wake = resolve; }), aborted,
          new Promise<void>(resolve => { timer = setTimeout(resolve, 200); }),
        ]);
      } finally { clearTimeout(timer); wake = undefined; }
    }
    // Reconcile provisional stream messages against the single authoritative history.
    // Bounded full snapshot; never label an incomplete page as the whole history.
    const messages: {id: string; role: 'user' | 'assistant'; content: string}[] = [];
    let cursor: string | undefined;
    let pages = 0, bytes = 0;
    do {
      const page = await conversation.history(String(conversationId), 100, cursor);
      messages.push(...page.items.map(item => ({id: item.id, role: item.role, content: item.text})));
      cursor = page.next;
      bytes += Buffer.byteLength(JSON.stringify(page.items), 'utf8');
      if (++pages > 1000 || bytes > 8 * 1024 * 1024 || messages.length > 10000) throw new Error('OBSERVATION_RESYNC_REQUIRED');
    } while (cursor !== undefined);
    yield {type: 'messages_snapshot', messages};
    if (settled!.status === 'done') {
      yield {type: 'run_end', outcome: 'success'};
    } else if (CANCELLED_REASONS.has(settled!.reason)) {
      yield {type: 'run_end', outcome: 'cancelled'};
    } else {
      throw new Error(settled!.reason === 'no_model' ? 'MODEL_NOT_CONFIGURED' : 'RUN_FAILED');
    }
  } finally {
    signal.removeEventListener('abort', onAbort!);
    await stop();
  }
}

async function settle(harness: Harness, submissionId: string): Promise<{status: 'done'} | {status: 'unanswered'; reason: string}> {
  const submission = await harness.submission(Number(submissionId) as SubmissionId, context);
  if (submission === undefined) throw new Error('RUN_FAILED');
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('OBSERVATION_TIMEOUT')), SETTLE_TIMEOUT_MS);
    timer.unref?.();
  });
  const record = await Promise.race([submission.wait(context), timeout]);
  return record.status === 'done' ? {status: 'done'} : {status: 'unanswered', reason: record.reason};
}
