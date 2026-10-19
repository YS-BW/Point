/**
 * Thread-stream types (WP6): the custom SSE binding a client keeps open per chat.
 *
 * The binding is documented in `docs/design/protocol-agui.md` §3.1 and frozen in the read-model spec.
 * Shapes here are provider-neutral: `application/**` must not import AG-UI or the SDK.
 */

import type { StatePatchOp, StateView } from './read-model.js';

/** One visible history row; the same shape the REST history endpoint returns. */
export type MessageRow = Readonly<{id: string; role: 'user' | 'assistant'; content: string}>;

/** Frame bodies the thread stream emits. Run boundaries are explicit so no frame sits outside a run. */
export type ThreadFrameBody =
  | Readonly<{type: 'run_started'; runId: string; sync: boolean; threadId: string}>
  | Readonly<{type: 'run_finished'; runId: string; outcome: 'success'; threadId: string}>
  | Readonly<{type: 'state_snapshot'; view: StateView; reason?: string; truncatedFamilies?: readonly string[]}>
  | Readonly<{type: 'state_delta'; patch: readonly StatePatchOp[]}>
  | Readonly<{type: 'activity_snapshot'; messageId: string; activityType: string; content: Readonly<Record<string, unknown>>}>
  | Readonly<{type: 'custom'; name: string; value: Readonly<Record<string, unknown>>}>
  | Readonly<{type: 'messages_snapshot'; messages: readonly MessageRow[]}>;

/** A frame plus the frame-level cursor clients echo back in `Last-Event-ID`. */
export type CursoredFrame = Readonly<{
  /** `<commitSeq>:<frameIndex>`; unique per frame, monotonic in emission order. */
  cursor: string;
  seq: number;
  body: ThreadFrameBody;
}>;

/** Why a reconnect could not be served by replay. */
export type ResyncReason = 'window_exceeded' | 'unknown_seq' | 'process_restarted';

export type ThreadStreamHandle = Readonly<{
  frames: AsyncIterable<CursoredFrame>;
  /** Stop this connection's stream. Idempotent; never cancels any run or task. */
  close(): Promise<void>;
}>;

/**
 * Thread-stream port. `open` is given the client's last applied frame cursor (from `Last-Event-ID`);
 * an unknown or expired cursor yields an explicit resync instead of a fabricated continuation.
 */
export interface ThreadStreamPort {
  open(threadId: string, lastEventId?: string): Promise<ThreadStreamHandle>;
}
