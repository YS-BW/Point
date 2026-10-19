/**
 * AG-UI 1.0 wire types and SSE framing for `POST /v1/agent`. This is the only place
 * allowed to know AG-UI shapes; runtime/application stay provider-neutral.
 */

export const PROTOCOL_VERSION = '1.0';

export type AguiRunStarted = Readonly<{
  type: 'RUN_STARTED'; threadId: string; runId: string; protocolVersion: string;
}>;
export type AguiRunError = Readonly<{
  type: 'RUN_ERROR'; message: string; code?: string;
}>;
export type AguiUsage = Readonly<{
  inputTokens: number; outputTokens: number; cacheReadTokens: number;
  cacheWriteTokens: number; totalTokens: number;
}>;
export type AguiRunFinished = Readonly<{
  type: 'RUN_FINISHED'; threadId: string; runId: string; protocolVersion: string;
  outcome: 'success' | 'cancelled'; usage: AguiUsage;
}>;
export type AguiTextStart = Readonly<{type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant'}>;
export type AguiTextContent = Readonly<{type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string}>;
export type AguiTextEnd = Readonly<{type: 'TEXT_MESSAGE_END'; messageId: string}>;
export type AguiStepStarted = Readonly<{type: 'STEP_STARTED'; stepName: string}>;
export type AguiStepFinished = Readonly<{type: 'STEP_FINISHED'; stepName: string}>;
export type AguiToolStart = Readonly<{
  type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string; parentMessageId?: string;
}>;
export type AguiToolArgs = Readonly<{type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string}>;
export type AguiToolEnd = Readonly<{type: 'TOOL_CALL_END'; toolCallId: string}>;
export type AguiToolResult = Readonly<{
  type: 'TOOL_CALL_RESULT'; messageId: string; toolCallId: string; content: string; role: 'tool';
}>;
/** `point.*` CUSTOM is the only extension channel; see `ui.ts` for the bounded contract. */
export type AguiCustom = Readonly<{type: 'CUSTOM'; name: string; value: unknown}>;

export type AguiEvent =
  | AguiRunStarted | AguiRunError | AguiRunFinished
  | AguiTextStart | AguiTextContent | AguiTextEnd
  | AguiStepStarted | AguiStepFinished
  | AguiToolStart | AguiToolArgs | AguiToolEnd | AguiToolResult
  | AguiCustom;

/** Exactly one JSON event per SSE `data:` line; no `event:` semantics, no multi-event frames. */
export function sseFrame(event: AguiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Unknown types/fields tolerated by consumers; the encoder never drops known fields. */
export function isAguiEvent(value: unknown): value is AguiEvent {
  if (value === null || typeof value !== 'object') return false;
  const type = (value as {type?: unknown}).type;
  return typeof type === 'string' && /^[A-Z][A-Z0-9_]*$/.test(type);
}
