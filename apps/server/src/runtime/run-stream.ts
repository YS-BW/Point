/** Observe Durable task publications directly; disconnect never cancels or replays execution. */
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Harness, TaskId } from '@earendil-works/pi-durable';
import type { RunFrameBody, RunStreamHandle, RunStreamPort } from '../application/run-stream.js';
import { streamBudget, type StreamBudget } from './stream-budget.js';

const MAX_BUFFERED_FRAMES = 256;
export type RunStreamDeps = Readonly<{
  getHarness: () => Harness;
  budget?: StreamBudget;
  idleTimeoutMs?: number;
}>;
export class RunStreamError extends Error {
  constructor(readonly code: 'RUN_NOT_FOUND') { super(code); this.name = 'RunStreamError'; }
}

type Task = NonNullable<Awaited<ReturnType<Harness['getTask']>>>;
export function runStreamRuntime(deps: RunStreamDeps): RunStreamPort {
  const budget = deps.budget ?? streamBudget();
  return {
    async open(runId: string): Promise<RunStreamHandle> {
      if (!/^[1-9][0-9]*$/.test(runId) || !Number.isSafeInteger(Number(runId))) {
        throw new RunStreamError('RUN_NOT_FOUND');
      }
      const release = budget.acquire();
      const harness = deps.getHarness();
      const taskId = Number(runId) as TaskId;
      const queue: RunFrameBody[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      let failure: string | undefined;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let latest: Task | undefined;
      let ready = false;
      let lastProgress = '';
      const notify = (): void => { const resume = wake; wake = undefined; resume?.(); };
      const cleanup = (): void => { unsubscribe?.(); unsubscribe = undefined; clearTimeout(timer); release(); };
      const fail = (code: string): void => {
        if (ended) return;
        failure = code; ended = true; queue.length = 0; cleanup(); notify();
      };
      const offer = (frame: RunFrameBody): void => {
        if (ended) return;
        if (queue.length >= MAX_BUFFERED_FRAMES) { fail('OBSERVATION_RESYNC_REQUIRED'); return; }
        queue.push(frame); notify();
      };
      const observe = (task: Task): void => {
        if (ended) return;
        const state = task.state as {status: string; phase?: string; outcome?: {status?: string}};
        const progress = JSON.stringify({status: state.status, phase: state.phase});
        if (progress !== lastProgress) {
          lastProgress = progress;
          offer({type: 'activity_snapshot', runId, activityType: 'point.run', content: {
            runId, status: state.status, ...(state.phase === undefined ? {} : {phase: state.phase}),
          }});
        }
        if (state.status === 'terminal') {
          const outcome = state.outcome?.status;
          if (!['completed', 'aborted', 'failed'].includes(outcome ?? '')) {
            fail('OBSERVATION_RESYNC_REQUIRED'); return;
          }
          offer({type: 'run_finished', runId,
            status: outcome === 'completed' ? 'success' : outcome === 'aborted' ? 'cancelled' : 'failed'});
          ended = true; cleanup(); notify();
        } else if (!ended) {
          clearTimeout(timer);
          timer = setTimeout(() => fail('OBSERVATION_TIMEOUT'), deps.idleTimeoutMs ?? 120_000);
          timer.unref?.();
        }
      };
      try {
        // Attach before the initial read; retain the newest publication while that read is pending.
        // The SDK listener performs no Session calls and does not block its mutation line.
        unsubscribe = harness.subscribeCommits(publication => {
          for (const change of publication.changes) {
            if (change.type !== 'task' || change.value.id !== taskId) continue;
            latest = change.value;
            if (ready) observe(change.value);
          }
        });
        const initial = await harness.getTask(taskId, context);
        const task = latest ?? initial;
        if (task === undefined) throw new RunStreamError('RUN_NOT_FOUND');
        offer({type: 'run_started', runId, threadId: String(task.conversationId)});
        ready = true;
        observe(task);
      } catch (error) { cleanup(); throw error; }
      const stop = (): void => { ended = true; queue.length = 0; cleanup(); notify(); };
      return {
        frames: {async *[Symbol.asyncIterator](): AsyncGenerator<RunFrameBody> {
          try {
            while (true) {
              while (queue.length > 0) yield queue.shift()!;
              if (failure !== undefined) throw new Error(failure);
              if (ended) return;
              await new Promise<void>(resolve => { wake = resolve; });
            }
          } finally { stop(); }
        }},
        async close() { stop(); },
      };
    },
  };
}
export { MAX_BUFFERED_FRAMES };
