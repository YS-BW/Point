/**
 * Commit-subscription projection (WP6): turns one committed `CommitPublication` into client frames.
 *
 * State rows cost **zero** extra reads: a `DocumentCommitChange` already carries the exact adopted
 * immutable value (`DocumentCommitChange.value`), so one commit of one job emits one patch operation
 * with no re-read. That is what makes "one commit emits O(changed) frames" true by construction.
 *
 * The only reads are on job lifecycle events: resolving the `runId` (Durable task id) from the exact
 * attempt named in the committed event payload. One document read per lifecycle event, never a scan.
 *
 * `events` is **not** part of the delta contract: it is snapshot-only (a bounded "recent activity"
 * list), so a commit never patches `/events`. See the read-model spec.
 *
 * No row cache is kept either: the previous view lives on the client, and each frame carries only the
 * changed paths. The only state in this module is the subscriber set and each subscriber's bounded
 * queue.
 *
 * Frames are provider-neutral (no AG-UI, no SDK types in `application/**`); the edge maps them.
 */

import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { CommitPublication, Harness, Seq } from '@earendil-works/pi-durable';
import type {
  CommitFrame, CommitStreamPort, CommitSubscription, ReadModelPort,
  StateChat, StateJob, StateMemory, StatePatchOp, StateResource, StateView,
} from '../application/read-model.js';
import { MAX_PATCH_OPERATIONS, STATE_LIMITS, escapePointer } from '../application/read-model.js';
import { Attempts } from '../storage/job.js';

/** Bounded queue per subscriber; exceeding it ends that subscription with a resync signal. */
const MAX_QUEUED_FRAMES = 1024;
/** Bounded projection backlog; a slow projection ends subscribers with a resync instead of growing. */
const MAX_PENDING_PUBLICATIONS = 1024;
/** `events` is snapshot-only; it never participates in delta generation or degradation decisions. */
const DELTA_FAMILIES = ['chats', 'jobs', 'resources', 'memory'] as const;

export type CommitStreamDeps = Readonly<{
  getHarness: () => Harness;
  readModel: ReadModelPort;
}>;

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Map one committed document value to its state row. Returns undefined when the document kind is not
 * part of the state view (events are projected as CUSTOM instead, see below).
 */
type Mapped =
  | Readonly<{family: 'chats'; row: StateChat}>
  | Readonly<{family: 'jobs'; row: StateJob}>
  | Readonly<{family: 'resources'; row: StateResource}>
  | Readonly<{family: 'memory'; row: StateMemory}>;

function mapDocument(kind: string, key: string, value: Readonly<Record<string, unknown>>): Mapped | undefined {
  switch (kind) {
    case 'point.chats':
      return {family: 'chats', row: {
        id: key, name: text(value.name), revision: num(value.revision),
        createdAt: num(value.createdAt), updatedAt: num(value.updatedAt),
      }};
    case 'point.jobs':
      return {family: 'jobs', row: {
        id: key, revision: num(value.revision), status: text(value.status, 'unknown'),
        updatedAt: num(value.updatedAt),
      }};
    case 'point.resources':
      return {family: 'resources', row: {
        id: key, owner: typeof value.owner === 'string' ? value.owner : null,
        state: text(value.state, 'unknown'), controlEpoch: num(value.controlEpoch),
        revision: num(value.revision), leaseExpiresAt: optionalNum(value.leaseExpiresAt),
        updatedAt: num(value.updatedAt),
      }};
    case 'point.memory':
      // The memory body is never projected into state (it is read through GET /v1/profile).
      return {family: 'memory', row: {
        key, kind: text(value.kind, 'fact'), sourceChatId: text(value.sourceChatId),
        revision: num(value.revision), updatedAt: num(value.updatedAt),
      }};
    default:
      return undefined;
  }
}

/** Family of a `point.event` document value, used to derive CUSTOM frames from the same commit. */
function eventTypeOf(value: Readonly<Record<string, unknown>>): string {
  return text(value.type);
}

const TERMINAL_JOB_EVENTS = new Set(['job.ready', 'job.failed', 'job.cancelled']);

export function commitStreamRuntime(deps: CommitStreamDeps): CommitStreamPort {
  return {
    subscribe(options?: Readonly<{
      truncatedFamilies?: readonly string[];
      /** Row counts observed in the initial snapshot, per delta-managed family. */
      counts?: Readonly<Record<string, number>>;
    }>): CommitSubscription {
      /**
       * Once a family's snapshot is truncated, a delta can no longer be proven equal to the bounded
       * authoritative view: an insert can silently evict the oldest row, and without a row cache the
       * projection cannot name the evicted id. Rather than emit an incomplete patch, every commit
       * touching a degraded family is projected as a fresh bounded snapshot. Small libraries (the
       * roadmap fixture) stay on the cheap delta path; large ones get correctness over bandwidth.
       */
      const degraded = new Set(options?.truncatedFamilies ?? []);
      /**
       * Approximate row counts for delta-managed families, seeded from the snapshot once the caller
       * knows it (`setBaseline`). Every `add` counts as a row even when it updated an existing one, so
       * this can only *over*-estimate: it may trigger an occasional extra snapshot, never miss an
       * eviction. A family that crosses its bound mid-stream degrades to a bounded snapshot instead of
       * silently drifting from the authoritative view.
       *
       * Until the baseline is set the counts are unknown, and an unknown family is treated as
       * degraded: emitting a snapshot is always honest, whereas emitting a delta could hide eviction.
       */
      const counts: Record<string, number> = {...options?.counts};
      let baselineReady = false;
      const limits: Record<string, number> = {...STATE_LIMITS};
      type Sink = {
        queue: CommitFrame[];
        wake: (() => void) | undefined;
        ended: boolean;
        overflowed: boolean;
        closed: Promise<void>;
        finish: () => void;
      };
      const sinks = new Set<Sink>();
      let unsubscribe: (() => void) | undefined;
      let started = false;
      let stopped = false;
      const detach = (): void => { stopped = true; unsubscribe?.(); unsubscribe = undefined; };
      /**
       * Strictly serial drain. The projection may await (bulk snapshot, run-id resolution), so two
       * commits projected concurrently could emit frames out of seq order and a client replaying by
       * frame cursor would apply a higher seq before a lower one. One chain keeps emit order equal to
       * commit order.
       */
      let chain: Promise<void> = Promise.resolve();
      /** Pending publications behind the drain; a slow projection must not grow this without bound. */
      let pending = 0;
      const failAll = (): void => {
        detach();
        // A projection error is a broken derived view: every subscriber must resync rather than wait
        // for a frame that will never come. Silent frame loss would violate the binding contract.
        for (const sink of sinks) {
          if (sink.ended) continue;
          sink.overflowed = true;
          sink.ended = true;
          sink.queue.length = 0;
          const wake = sink.wake;
          sink.wake = undefined;
          wake?.();
          sink.finish();
        }
      };
      const enqueue = (publication: CommitPublication): void => {
        if (stopped) return;
        pending += 1;
        if (pending > MAX_PENDING_PUBLICATIONS) {
          pending -= 1;
          failAll();
          return;
        }
        chain = chain
          .then(() => stopped ? undefined : project(publication))
          .catch(() => failAll())
          .finally(() => { pending -= 1; });
      };

      const emit = (frame: CommitFrame): void => {
        for (const sink of sinks) {
          if (sink.ended) continue;
          if (sink.queue.length >= MAX_QUEUED_FRAMES) {
            // A slow consumer must not grow without bound. End only this subscription; the caller
            // turns this into an explicit resync rather than silently dropping frames.
            sink.overflowed = true;
            sink.ended = true;
            sink.queue.length = 0;
            const wake = sink.wake;
            sink.wake = undefined;
            wake?.();
            sink.finish();
            continue;
          }
          sink.queue.push(frame);
          const wake = sink.wake;
          sink.wake = undefined;
          wake?.();
        }
      };

      let stateSeq = -1;
      const project = async (publication: CommitPublication): Promise<void> => {
        const seq = Number(publication.seq);
        const patch: StatePatchOp[] = [];
        /** Job ids whose index row changed, for the ACTIVITY projection. */
        const jobRows = new Map<string, StateJob>();
        /** Job events from the same commit drive CUSTOM lifecycle frames. */
        const jobEvents: Array<{type: string; jobId: string; attemptId?: string}> = [];

        for (const change of publication.changes) {
          if (change.type === 'entry') {
            // Visible history change: the thread stream re-reads a bounded snapshot for that thread.
            // The entry record itself is not projected here (application layer owns no messages).
            const role = change.value.model?.[0]?.role;
            if (role === 'user' || role === 'assistant') {
              emit({type: 'messages_changed', seq, threadId: String(change.value.conversationId)});
            }
            continue;
          }
          if (change.type === 'document') {
            const kind = change.record.kind;
            const key = change.record.key;
            if (key === undefined) continue;
            if (kind === 'point.event') {
              if (change.value !== null) {
                const type = eventTypeOf(change.value);
                const aggregate = text(change.value.aggregate);
                const aggregateId = text(change.value.aggregateId);
                const rawAttempt = change.value.data;
                const attemptId = rawAttempt !== null && typeof rawAttempt === 'object'
                  && !Array.isArray(rawAttempt) && typeof (rawAttempt as {attemptId?: unknown}).attemptId === 'string'
                  ? (rawAttempt as {attemptId: string}).attemptId : undefined;
                if (aggregate === 'job' && aggregateId !== '') {
                  jobEvents.push({type, jobId: aggregateId, ...(attemptId === undefined ? {} : {attemptId})});
                }
              }
              continue;
            }
            const mapped = change.value === null
              ? undefined : mapDocument(kind, key, change.value);
            if (change.value === null) {
              // Retirement of a state-family document: the row leaves the view.
              const family = ({'point.chats': 'chats', 'point.jobs': 'jobs',
                'point.resources': 'resources', 'point.memory': 'memory'} as const)[kind as
                'point.chats' | 'point.jobs' | 'point.resources' | 'point.memory'];
              if (family !== undefined) {
                patch.push({op: 'remove', path: `/${family}/${escapePointer(key)}`});
              }
              continue;
            }
            if (mapped === undefined) continue;
            const id = mapped.family === 'memory'
              ? (mapped.row as StateMemory).key : (mapped.row as {id: string}).id;
            patch.push({
              // `add` on an existing object member replaces it (RFC 6902), so one op covers insert
              // and update; clients must tolerate that, since replay may overlap a snapshot.
              op: 'add', path: `/${mapped.family}/${escapePointer(id)}`, value: mapped.row,
            });
            if (mapped.family === 'jobs') jobRows.set(id, mapped.row as StateJob);
          }
        }

        let crossed = false;
        let unknownBound = false;
        for (const op of patch) {
          if (op.op !== 'add') continue;
          const family = op.path.split('/')[1];
          if (family === undefined || !(DELTA_FAMILIES as readonly string[]).includes(family)) continue;
          const current = counts[family];
          if (current === undefined) { unknownBound = true; continue; }
          counts[family] = current + 1;
          const limit = limits[family];
          if (limit !== undefined && counts[family]! > limit) crossed = true;
        }
        const touchesDegraded = [...degraded].some(family =>
          (DELTA_FAMILIES as readonly string[]).includes(family)
          && patch.some(op => op.path.startsWith(`/${family}/`)));
        if (!baselineReady && patch.some(op => {
          const family = op.path.split('/')[1];
          return family !== undefined && (DELTA_FAMILIES as readonly string[]).includes(family);
        })) {
          unknownBound = true;
        }
        if (seq <= stateSeq) {
          // A newer authoritative snapshot already contains these state changes.
        } else if (patch.length > MAX_PATCH_OPERATIONS) {
          // Bulk change (migration/rebuild): a giant patch is worse than one honest snapshot.
          const view = await deps.readModel.state();
          stateSeq = view.seq;
          for (const family of Object.keys(view.truncated ?? {})) degraded.add(family);
          emit({type: 'state_snapshot', seq, view, reason: 'bulk_change'});
        } else if (touchesDegraded || crossed || unknownBound) {
          const view = await deps.readModel.state();
          // Re-seed from the authoritative view: the snapshot is the new base for counting.
          for (const family of DELTA_FAMILIES) {
            counts[family] = Object.keys(view[family] as Record<string, unknown>).length;
          }
          stateSeq = view.seq;
          for (const family of Object.keys(view.truncated ?? {})) degraded.add(family);
          emit({type: 'state_snapshot', seq, view, reason: 'bounded_view'});
        } else if (patch.length > 0) {
          emit({type: 'state_delta', seq, patch});
        }

        for (const [jobId, row] of jobRows) {
          emit({
            type: 'activity_snapshot', seq, messageId: `job-${jobId}`, activityType: 'point.job',
            content: {jobId, status: row.status, revision: row.revision, updatedAt: row.updatedAt},
          });
        }

        // CUSTOM lifecycle frames are derived from the product events committed alongside the change,
        // so there is no previous-state tracking and no extra read.
        for (const event of jobEvents) {
          if (event.type !== 'job.running' && !TERMINAL_JOB_EVENTS.has(event.type)) continue;
          const identity = await resolveRunIdentity(deps.getHarness(), event.attemptId);
          if (event.type === 'job.running') {
            emit({
              type: 'custom', seq, name: 'point.job.started',
              value: {jobId: event.jobId, ...identity},
            });
            continue;
          }
          emit({
            type: 'custom', seq, name: 'point.job.finished',
            value: {jobId: event.jobId, status: event.type.slice('job.'.length), ...identity},
          });
        }
      };

      const attach = (): void => {
        if (started) return;
        started = true;
        unsubscribe = deps.getHarness().subscribeCommits(publication => {
          // The SDK requires the listener not to block and not to call Session APIs, so it only
          // appends to the serial chain; the drain loop does the awaiting.
          enqueue(publication);
        });
      };

      // Attach and register the sink synchronously: a commit that lands between `subscribe()` and the
      // first `next()` must not be lost, which is what lazy attachment in the generator body would do.
      attach();
      let finish!: () => void;
      const closed = new Promise<void>(resolve => { finish = resolve; });
      const sink: Sink = {queue: [], wake: undefined, ended: false, overflowed: false, closed, finish};
      sinks.add(sink);
      return {
        events: {
          async *[Symbol.asyncIterator](): AsyncGenerator<CommitFrame> {
            try {
              while (true) {
                while (sink.queue.length > 0) yield sink.queue.shift()!;
                if (sink.overflowed) throw new Error('OBSERVATION_RESYNC_REQUIRED');
                if (sink.ended) return;
                await new Promise<void>(resolve => { sink.wake = resolve; });
              }
            } finally {
              sink.ended = true;
              sinks.delete(sink);
              if (sinks.size === 0) detach();
            }
          },
        },
        setBaseline(meta): void {
          for (const family of meta.truncatedFamilies ?? []) degraded.add(family);
          for (const [family, count] of Object.entries(meta.counts ?? {})) {
            counts[family] = Math.max(counts[family] ?? 0, count);
          }
          baselineReady = true;
        },
        async cancel(): Promise<void> {
          for (const sink of sinks) {
            sink.ended = true;
            const wake = sink.wake;
            sink.wake = undefined;
            wake?.();
            sink.finish();
          }
          sinks.clear();
          detach();
        },
      };
    },
  };
}

/**
 * Resolve the durable identity behind a job lifecycle event. `attemptId` comes from the committed
 * event payload, so the frame is attributed to the attempt that actually produced it — never to a
 * newer attempt that replaced it before the projection drained. `runId` is that attempt's Durable
 * task id: one document read by exact id, and omitted (never faked) when the attempt has no task.
 */
async function resolveRunIdentity(
  harness: Harness, attemptId: string | undefined,
): Promise<Readonly<{runId?: string; attemptId?: string}>> {
  if (attemptId === undefined) return {};
  const attempt = await harness.snapshot(Attempts, attemptId, context);
  const taskId = attempt?.taskId;
  return {
    attemptId,
    ...(typeof taskId === 'string' && /^[1-9][0-9]*$/.test(taskId) ? {runId: taskId} : {}),
  };
}

/** Re-exported so the edge can keep SDK types out of its own imports. */
export type CommitSeq = Seq;
