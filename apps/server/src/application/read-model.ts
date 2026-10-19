/**
 * Read-model types (WP6): the derived, read-only product view a client renders.
 *
 * These are plain transport-neutral shapes with no SDK and no AG-UI import (AGENTS.md invariant #9
 * and boundary rule: SDK only in runtime/storage, AG-UI only in api). Everything here is a **derived
 * projection** of committed Durable documents: dropping it and re-scanning must not change any
 * product decision.
 *
 * Each family is an object keyed by entity id rather than an array, which is what makes incremental
 * patches idempotent-tolerant: `add` on an existing key replaces it and `remove` on a missing key is
 * ignored, so replaying a frame after a reconnect cannot duplicate or shift entries.
 */

/** One chat row: the fields a UI list needs, no message body. */
export type StateChat = Readonly<{
  id: string;
  name: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}>;

/** One job row: status and revision only, no prompt/result bodies. */
export type StateJob = Readonly<{
  id: string;
  revision: number;
  status: string;
  updatedAt: number;
}>;

/** One resource row: lease and control identity, no capability payload. */
export type StateResource = Readonly<{
  id: string;
  owner: string | null;
  state: string;
  controlEpoch: number;
  revision: number;
  leaseExpiresAt: number | null;
  updatedAt: number;
}>;

/**
 * One memory index row. Deliberately **without** the stored value: state is a list view, and memory
 * bodies are read through `GET /v1/profile`, not duplicated into every state frame.
 */
export type StateMemory = Readonly<{
  key: string;
  kind: string;
  sourceChatId: string;
  revision: number;
  updatedAt: number;
}>;

/** One product event: bounded, already-redacted data. */
export type StateEvent = Readonly<{
  id: string;
  type: string;
  aggregate: string;
  aggregateId: string;
  revision: number;
  at: number;
  data: Readonly<Record<string, string | number | boolean | null>> | null;
}>;

/** Families the read model exposes, in a fixed order used for deterministic patch generation. */
export const STATE_FAMILIES = ['chats', 'jobs', 'resources', 'memory', 'events'] as const;
export type StateFamily = (typeof STATE_FAMILIES)[number];

/** Bounds per family. Exceeding one sets a `truncated` marker instead of silently dropping rows. */
export const STATE_LIMITS: Readonly<Record<StateFamily, number>> = {
  chats: 1_000,
  jobs: 1_000,
  resources: 1_000,
  memory: 200,
  events: 200,
};

export type StateView = Readonly<{
  /** Highest commit sequence this process had observed when the view was built. */
  seq: number;
  chats: Readonly<Record<string, StateChat>>;
  jobs: Readonly<Record<string, StateJob>>;
  resources: Readonly<Record<string, StateResource>>;
  memory: Readonly<Record<string, StateMemory>>;
  events: Readonly<Record<string, StateEvent>>;
  /** Present only for families that hit their bound; clients must fall back to REST paging. */
  truncated?: Readonly<Partial<Record<StateFamily, true>>>;
}>;

/** Durable counts for the gated `/inspect` diagnostic (WP4 deferred them to WP6). */
export type DurableCounts = Readonly<{
  counts: Readonly<Record<string, number>>;
  /**
   * Reserved for a future capped count. The current implementation has no cap, so it always reports
   * exact counts and this is always `false`; the field exists so adding a cap later need not change
   * the response shape.
   */
  truncated: boolean;
}>;

/**
 * One neutral incremental frame derived from a commit. The edge maps these to AG-UI events and
 * assigns the `<commitSeq>:<frameIndex>` cursor. `application/**` must not import AG-UI or the SDK,
 * so the shapes here are plain objects.
 */
export type CommitFrame =
  | Readonly<{type: 'state_delta'; seq: number; patch: readonly StatePatchOp[]}>
  | Readonly<{type: 'state_snapshot'; seq: number; view: StateView; reason: string}>
  | Readonly<{
    type: 'activity_snapshot'; seq: number; messageId: string; activityType: string;
    content: Readonly<Record<string, unknown>>;
  }>
  | Readonly<{type: 'custom'; seq: number; name: string; value: Readonly<Record<string, unknown>>}>
  /** Visible history changed in one conversation; the thread stream turns this into a snapshot. */
  | Readonly<{type: 'messages_changed'; seq: number; threadId: string}>;

/** Snapshot metadata the projection needs to judge bounds; known only after the snapshot is read. */
export type BaselineMeta = Readonly<{
  truncatedFamilies?: readonly string[];
  counts?: Readonly<Record<string, number>>;
}>;

/** One subscription to derived commit frames. */
export type CommitSubscription = Readonly<{
  events: AsyncIterable<CommitFrame>;
  /**
   * Declare the snapshot the client is about to receive. Must be called before consuming frames:
   * frames projected before it are conservatively treated as snapshot-worthy, never as a delta whose
   * eviction behaviour is unknown.
   */
  setBaseline(meta: BaselineMeta): void;
  /** Stop this subscription. Idempotent; releases this subscription’s SDK listener. */
  cancel(): Promise<void>;
}>;

/**
 * Commit-subscription port: frames describe changes to the read model from the next commit onward.
 *
 * `truncatedFamilies` tells the projection which families the initial snapshot had to truncate. Those
 * families can no longer be expressed as a patch (an insert may evict a row whose id the projection
 * cannot name without a cache), so the projection degrades to bounded snapshots for them.
 */
export interface CommitStreamPort {
  subscribe(options?: Readonly<{
    truncatedFamilies?: readonly string[];
    /** Row counts observed in the initial snapshot, used to detect a mid-stream bound crossing. */
    counts?: Readonly<Record<string, number>>;
  }>): CommitSubscription;
}

/**
 * Read-only derived view port. Implemented in `runtime/**` (SDK access lives there) and consumed by
 * the `/v1` transport. Nothing here is authoritative: every value is rebuildable from Durable state,
 * and no product decision may depend on it.
 */
export interface ReadModelPort {
  state(): Promise<StateView>;
  counts(): Promise<DurableCounts>;
}

/** RFC 6902 JSON Patch operation, restricted to what this projection emits. */
export type StatePatchOp =
  | Readonly<{op: 'add'; path: string; value: unknown}>
  | Readonly<{op: 'replace'; path: string; value: unknown}>
  | Readonly<{op: 'remove'; path: string}>;

/** Patch-operation ceiling for one commit; beyond it the projection sends a snapshot instead. */
export const MAX_PATCH_OPERATIONS = 100;

/** Escape one JSON Pointer segment (RFC 6901). */
export function escapePointer(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

