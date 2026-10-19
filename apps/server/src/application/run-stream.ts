/**
 * Run-stream types (WP6): observe one background execution.
 *
 * `runId` is the Durable task id (a persistent identity), not the transient AG-UI run id used by the
 * foreground `POST /v1/agent` stream. Observation is read-only: disconnecting never cancels the task,
 * and an interrupted observation never claims the execution failed.
 */

/** One observed execution frame, provider-neutral. */
export type RunFrameBody =
  | Readonly<{type: 'run_started'; runId: string; threadId: string}>
  | Readonly<{type: 'activity_snapshot'; runId: string; activityType: string; content: Readonly<Record<string, unknown>>}>
  | Readonly<{type: 'run_finished'; runId: string; status: string}>;

export type RunStreamHandle = Readonly<{
  frames: AsyncIterable<RunFrameBody>;
  /** Stop observing. Idempotent; does not cancel the task. */
  close(): Promise<void>;
}>;

export interface RunStreamPort {
  /**
   * Observe one execution. Rejects with `RUN_NOT_FOUND` before opening when the id names no Durable task.
   * Reconnect resumes from the current state (it does not replay events missed while offline, because
   * the engine exposes no commit-history enumeration).
   */
  open(runId: string): Promise<RunStreamHandle>;
}
