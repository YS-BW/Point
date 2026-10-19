/**
 * Read model over committed Durable documents (WP6).
 *
 * Two hard rules drive this module:
 *
 * 1. **Derived, never authoritative.** Every value here comes from the v2 index documents that WP3
 *    writes in the same commit as the entity change. It never reads entity documents and never
 *    enumerates Durable task records (the roadmap exit criterion: `/v1/state` must not call the
 *    storage task reader). Dropping the whole view and rebuilding it cannot change product state.
 * 2. Index documents do not retain historical content. Current reads are accepted only when no
 *    publication intervened across the entire scan; otherwise they are retried. A mixed view is
 *    never returned; sustained churn ends observation explicitly rather than inventing a cursor.
 */

import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Harness, Seq } from '@earendil-works/pi-durable';
import type {
  DurableCounts, ReadModelPort, StateChat, StateEvent, StateFamily, StateJob, StateMemory,
  StateResource, StateView,
} from '../application/read-model.js';
import { STATE_FAMILIES, STATE_LIMITS } from '../application/read-model.js';
import type { SessionDocumentScanner } from './schedules.js';

export type ReadModelDeps = Readonly<{
  getHarness: () => Harness;
  /** Read-only scan of committed session documents by kind (the SDK has no scan on Session). */
  scan: SessionDocumentScanner;
}>;

/**
 * Families counted by the gated `/inspect` diagnostic, with the exact key reported for each.
 *
 * Only **entity** families are counted; the v2 index families (`point.chats`/`point.jobs`/
 * `point.resources`) are derived mirrors of the same entities and would report the same number
 * under a second name, which is exactly the kind of ambiguity the frozen shape avoids.
 */
const COUNTED_FAMILIES: ReadonlyArray<readonly [string, string]> = [
  ['point.chat', 'chats'],
  ['point.job', 'jobs'],
  ['point.attempt', 'attempts'],
  ['point.resource', 'resources'],
  ['point.resource-operation', 'resourceOperations'],
  ['point.memory', 'memory'],
  ['point.event', 'events'],
  ['point.schedule', 'schedules'],
  ['point.occurrence', 'occurrences'],
  ['point.decision', 'decisions'],
  ['point.delivery', 'deliveries'],
  ['point.artifact', 'artifacts'],
  ['point.requests', 'requests'],
];

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Keep the newest `limit` rows by a timestamp field, reporting whether anything was dropped. */
function bound<T>(
  rows: readonly T[], limit: number, stamp: (row: T) => number,
): {kept: T[]; truncated: boolean} {
  if (rows.length <= limit) return {kept: [...rows], truncated: false};
  const kept = [...rows].sort((left, right) => stamp(right) - stamp(left)).slice(0, limit);
  return {kept, truncated: true};
}

export function readModelRuntime(deps: ReadModelDeps): ReadModelPort {
  let observedSeq = 0;
  let attached = false;

  /**
   * Track the highest commit sequence this process has observed. The listener must not block or call
   * Session APIs (SDK contract), so it only records a number. Attached lazily so a read-only model
   * that is never used does not register a listener.
   */
  function attach(): void {
    if (attached) return;
    attached = true;
    deps.getHarness().subscribeCommits(publication => {
      const seq = Number(publication.seq);
      if (Number.isFinite(seq) && seq > observedSeq) observedSeq = seq;
    });
  }

  async function state(retries = 3): Promise<StateView> {
    attach();
    // Optimistic consistency barrier: these index documents do not retain historical content.
    const seq = observedSeq;

    const chats: StateChat[] = [];
    for (const document of await deps.scan('point.chats')) {
      const value = document.value;
      chats.push({
        // Row identity is the document's stable family key (`record.key`), not the embedded id:
        // a future shape divergence must not silently split the keyed view.
        id: document.key,
        name: text(value.name),
        revision: finiteNumber(value.revision, 0),
        createdAt: finiteNumber(value.createdAt, 0),
        updatedAt: finiteNumber(value.updatedAt, 0),
      });
    }

    const jobs: StateJob[] = [];
    for (const document of await deps.scan('point.jobs')) {
      const value = document.value;
      jobs.push({
        id: document.key,
        revision: finiteNumber(value.revision, 0),
        status: text(value.status, 'unknown'),
        updatedAt: finiteNumber(value.updatedAt, 0),
      });
    }

    const resources: StateResource[] = [];
    for (const document of await deps.scan('point.resources')) {
      const value = document.value;
      resources.push({
        id: document.key,
        owner: typeof value.owner === 'string' ? value.owner : null,
        state: text(value.state, 'unknown'),
        controlEpoch: finiteNumber(value.controlEpoch, 0),
        revision: finiteNumber(value.revision, 0),
        leaseExpiresAt: optionalNumber(value.leaseExpiresAt),
        updatedAt: finiteNumber(value.updatedAt, 0),
      });
    }

    const memory: StateMemory[] = [];
    for (const document of await deps.scan('point.memory')) {
      const value = document.value;
      // The memory body is deliberately omitted: state is a list view, and the value is read through
      // GET /v1/profile. Duplicating it into every state frame would bloat it and widen exposure.
      memory.push({
        key: document.key,
        kind: text(value.kind, 'fact'),
        sourceChatId: text(value.sourceChatId),
        revision: finiteNumber(value.revision, 0),
        updatedAt: finiteNumber(value.updatedAt, 0),
      });
    }

    const events: StateEvent[] = [];
    for (const document of await deps.scan('point.event')) {
      const value = document.value;
      const data = value.data;
      events.push({
        id: document.key,
        type: text(value.type, 'unknown'),
        aggregate: text(value.aggregate),
        aggregateId: text(value.aggregateId),
        revision: finiteNumber(value.revision, 0),
        at: finiteNumber(value.at, 0),
        data: data !== null && typeof data === 'object' && !Array.isArray(data)
          ? data as StateEvent['data'] : null,
      });
    }

    const boundedChats = bound(chats, STATE_LIMITS.chats, row => row.updatedAt);
    const boundedJobs = bound(jobs, STATE_LIMITS.jobs, row => row.updatedAt);
    const boundedResources = bound(resources, STATE_LIMITS.resources, row => row.updatedAt);
    const boundedMemory = bound(memory, STATE_LIMITS.memory, row => row.updatedAt);
    const boundedEvents = bound(events, STATE_LIMITS.events, row => row.at);

    const truncated: Partial<Record<StateFamily, true>> = {};
    if (boundedChats.truncated) truncated.chats = true;
    if (boundedJobs.truncated) truncated.jobs = true;
    if (boundedResources.truncated) truncated.resources = true;
    if (boundedMemory.truncated) truncated.memory = true;
    if (boundedEvents.truncated) truncated.events = true;

    const view: StateView = {
      seq,
      chats: keyBy(boundedChats.kept, row => row.id),
      jobs: keyBy(boundedJobs.kept, row => row.id),
      resources: keyBy(boundedResources.kept, row => row.id),
      memory: keyBy(boundedMemory.kept, row => row.key),
      events: keyBy(boundedEvents.kept, row => row.id),
      ...(Object.keys(truncated).length === 0 ? {} : {truncated}),
    };
    if (observedSeq !== seq) {
      if (retries === 0) throw new Error('OBSERVATION_RESYNC_REQUIRED');
      return state(retries - 1);
    }
    return view;
  }

  async function counts(): Promise<DurableCounts> {
    // Diagnostic only (gated `/inspect`): cost is O(total documents), which is acceptable for an
    // operator endpoint but must not be put on a hot path. Counts are exact, not lower bounds.
    const out: Record<string, number> = {};
    for (const [kind, name] of COUNTED_FAMILIES) out[name] = (await deps.scan(kind)).length;
    return {counts: out, truncated: false};
  }

  return {state, counts};
}

function keyBy<T>(rows: readonly T[], key: (row: T) => string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const row of rows) out[key(row)] = row;
  return out;
}

/** Exported for the stream projection so it can share the same family ordering. */
export { STATE_FAMILIES };

/** Sequence type re-export keeps the SDK type out of `application/**`. */
export type ObservedSeq = Seq;
