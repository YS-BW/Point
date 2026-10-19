/**
 * Provider-neutral run projection consumed by the AG-UI edge. Pure types only: no SDK
 * and no AG-UI import may appear here (see AGENTS.md invariants #1/#9). The runtime
 * produces these events from the public Durable event stream; `api/agui/**` maps them
 * to AG-UI wire events.
 */

/** Token counters derived from the conversation usage ledger (see README for the caveat). */
export type AgentUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}>;

/** One truthful projection event for exactly one foreground run. */
export type AgentRunEvent =
  | Readonly<{type: 'messages_snapshot'; messages: {id: string; role: 'user' | 'assistant'; content: string}[]}>
  | Readonly<{type: 'message_start'; messageId: string}>
  | Readonly<{type: 'text_delta'; messageId: string; delta: string}>
  | Readonly<{type: 'message_end'; messageId: string}>
  | Readonly<{type: 'tool_start'; toolCallId: string; toolName: string; argsJson: string}>
  | Readonly<{type: 'tool_end'; toolCallId: string; isError: boolean}>
  | Readonly<{type: 'tool_result'; toolCallId: string; content: string; isError: boolean}>
  | Readonly<{type: 'step_start'; name: string}>
  | Readonly<{type: 'step_end'; name: string}>
  | Readonly<{type: 'run_end'; outcome: 'success' | 'cancelled'; usage?: AgentUsage}>;

export type AgentRunRequest = Readonly<{chatId: string; text: string; requestId: string}>;

export interface AgentRunStream {
  readonly events: AsyncIterable<AgentRunEvent>;
  /** Stop observing the run; idempotent. Does not cancel the run (use the `stop` command). */
  cancel(): Promise<void>;
}

/**
 * Starts exactly one run: admits the input through the existing conversation command
 * and rejects (before any event) when admission fails. Events are filtered to the run
 * started by this request; unrelated/follow-up runs are never mixed into the stream.
 */
export interface AgentRunPort {
  start(request: AgentRunRequest, signal: AbortSignal): Promise<AgentRunStream>;
}
