/**
 * Maps provider-neutral runtime events to AG-UI 1.0 wire events for exactly one run.
 * Tracks open entities on a single creation-order stack so cancellation and errors close
 * them in strict global LIFO order before the final boundary; truncation stops without a
 * boundary and closes nothing.
 */

import type { AgentRunEvent, AgentUsage } from '../../application/agent-stream.js';
import type { AguiEvent } from './events.js';
import { PROTOCOL_VERSION } from './events.js';

export type FrameWriter = (event: AguiEvent) => Promise<void>;

type OpenEntity =
  | Readonly<{kind: 'message'; messageId: string}>
  | Readonly<{kind: 'step'; stepName: string}>
  | Readonly<{kind: 'tool'; toolCallId: string}>;

export class RunProjection {
  private readonly open: OpenEntity[] = [];
  private toolResultSeq = 0;

  constructor(
    private readonly writer: FrameWriter,
    private readonly identity: Readonly<{threadId: string; runId: string}>,
  ) {}

  async started(): Promise<void> {
    await this.writer({
      type: 'RUN_STARTED',
      threadId: this.identity.threadId,
      runId: this.identity.runId,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  async handle(event: AgentRunEvent): Promise<void> {
    switch (event.type) {
      case 'message_start':
        this.open.push({kind: 'message', messageId: event.messageId});
        await this.writer({type: 'TEXT_MESSAGE_START', messageId: event.messageId, role: 'assistant'});
        return;
      case 'text_delta':
        await this.writer({type: 'TEXT_MESSAGE_CONTENT', messageId: event.messageId, delta: event.delta});
        return;
      case 'message_end':
        this.remove(entity => entity.kind === 'message' && entity.messageId === event.messageId);
        await this.writer({type: 'TEXT_MESSAGE_END', messageId: event.messageId});
        return;
      case 'tool_start': {
        const parentMessageId = this.enclosingMessage();
        this.open.push({kind: 'tool', toolCallId: event.toolCallId});
        await this.writer({
          type: 'TOOL_CALL_START', toolCallId: event.toolCallId, toolCallName: event.toolName,
          ...(parentMessageId === undefined ? {} : {parentMessageId}),
        });
        // The SDK exposes structured argument deltas, not raw JSON fragments; one full,
        // truthful args frame is emitted instead of faking incremental tokens.
        await this.writer({type: 'TOOL_CALL_ARGS', toolCallId: event.toolCallId, delta: event.argsJson});
        return;
      }
      case 'tool_end':
        this.remove(entity => entity.kind === 'tool' && entity.toolCallId === event.toolCallId);
        await this.writer({type: 'TOOL_CALL_END', toolCallId: event.toolCallId});
        return;
      case 'tool_result':
        await this.writer({
          type: 'TOOL_CALL_RESULT', messageId: `tool-${++this.toolResultSeq}`,
          toolCallId: event.toolCallId, content: event.content, role: 'tool',
        });
        return;
      case 'step_start':
        this.open.push({kind: 'step', stepName: event.name});
        await this.writer({type: 'STEP_STARTED', stepName: event.name});
        return;
      case 'step_end':
        this.remove(entity => entity.kind === 'step' && entity.stepName === event.name);
        await this.writer({type: 'STEP_FINISHED', stepName: event.name});
        return;
      case 'run_end':
        return;
      default:
        return;
    }
  }

  /** Close every still-open entity in strict global reverse-creation order. */
  async closeEntities(): Promise<void> {
    while (this.open.length > 0) {
      const entity = this.open.pop()!;
      if (entity.kind === 'tool') {
        await this.writer({type: 'TOOL_CALL_END', toolCallId: entity.toolCallId});
      } else if (entity.kind === 'message') {
        await this.writer({type: 'TEXT_MESSAGE_END', messageId: entity.messageId});
      } else {
        await this.writer({type: 'STEP_FINISHED', stepName: entity.stepName});
      }
    }
  }

  async finish(outcome: 'success' | 'cancelled', usage: AgentUsage): Promise<void> {
    await this.closeEntities();
    await this.writer({
      type: 'RUN_FINISHED',
      threadId: this.identity.threadId,
      runId: this.identity.runId,
      protocolVersion: PROTOCOL_VERSION,
      outcome,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        totalTokens: usage.totalTokens,
      },
    });
  }

  async error(code: string, message: string): Promise<void> {
    await this.closeEntities();
    await this.writer({type: 'RUN_ERROR', message, ...(code.length === 0 ? {} : {code})});
  }

  private enclosingMessage(): string | undefined {
    for (let index = this.open.length - 1; index >= 0; index -= 1) {
      const entity = this.open[index]!;
      if (entity.kind === 'message') return entity.messageId;
    }
    return undefined;
  }

  private remove(match: (entity: OpenEntity) => boolean): void {
    for (let index = this.open.length - 1; index >= 0; index -= 1) {
      if (match(this.open[index]!)) {
        this.open.splice(index, 1);
        return;
      }
    }
  }
}
