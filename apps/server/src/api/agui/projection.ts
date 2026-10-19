/**
 * Maps provider-neutral runtime events to AG-UI 1.0 wire events for exactly one run.
 * Tracks open message/step/tool entities so cancellation and errors close them before
 * the final boundary; truncation simply stops without a boundary.
 */

import type { AgentRunEvent, AgentUsage } from '../../application/agent-stream.js';
import type { AguiEvent } from './events.js';
import { PROTOCOL_VERSION } from './events.js';

export type FrameWriter = (event: AguiEvent) => Promise<void>;

export class RunProjection {
  private openMessage: string | undefined;
  private readonly openSteps: string[] = [];
  private readonly openTools = new Set<string>();
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
        if (this.openMessage !== undefined) await this.closeMessage();
        this.openMessage = event.messageId;
        await this.writer({type: 'TEXT_MESSAGE_START', messageId: event.messageId, role: 'assistant'});
        return;
      case 'text_delta':
        await this.writer({type: 'TEXT_MESSAGE_CONTENT', messageId: event.messageId, delta: event.delta});
        return;
      case 'message_end':
        if (this.openMessage === event.messageId) {
          await this.closeMessage();
        } else {
          await this.writer({type: 'TEXT_MESSAGE_END', messageId: event.messageId});
        }
        return;
      case 'tool_start':
        this.openTools.add(event.toolCallId);
        await this.writer({
          type: 'TOOL_CALL_START', toolCallId: event.toolCallId, toolCallName: event.toolName,
          ...(this.openMessage === undefined ? {} : {parentMessageId: this.openMessage}),
        });
        // The SDK exposes structured argument deltas, not raw JSON fragments; one full,
        // truthful args frame is emitted instead of faking incremental tokens.
        await this.writer({type: 'TOOL_CALL_ARGS', toolCallId: event.toolCallId, delta: event.argsJson});
        return;
      case 'tool_end':
        if (this.openTools.delete(event.toolCallId)) {
          await this.writer({type: 'TOOL_CALL_END', toolCallId: event.toolCallId});
        }
        return;
      case 'tool_result':
        await this.writer({
          type: 'TOOL_CALL_RESULT', messageId: `tool-${++this.toolResultSeq}`,
          toolCallId: event.toolCallId, content: event.content, role: 'tool',
        });
        return;
      case 'step_start':
        this.openSteps.push(event.name);
        await this.writer({type: 'STEP_STARTED', stepName: event.name});
        return;
      case 'step_end':
        this.removeStep(event.name);
        await this.writer({type: 'STEP_FINISHED', stepName: event.name});
        return;
      case 'run_end':
        return;
      default:
        return;
    }
  }

  /** Close every open entity (LIFO) without ending the run. */
  async closeEntities(): Promise<void> {
    for (const toolCallId of [...this.openTools].reverse()) {
      this.openTools.delete(toolCallId);
      await this.writer({type: 'TOOL_CALL_END', toolCallId});
    }
    for (let index = this.openSteps.length - 1; index >= 0; index -= 1) {
      const stepName = this.openSteps[index]!;
      this.openSteps.splice(index, 1);
      await this.writer({type: 'STEP_FINISHED', stepName});
    }
    await this.closeMessage();
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

  private async closeMessage(): Promise<void> {
    if (this.openMessage === undefined) return;
    const messageId = this.openMessage;
    this.openMessage = undefined;
    await this.writer({type: 'TEXT_MESSAGE_END', messageId});
  }

  private removeStep(name: string): void {
    const index = this.openSteps.lastIndexOf(name);
    if (index >= 0) this.openSteps.splice(index, 1);
  }
}
