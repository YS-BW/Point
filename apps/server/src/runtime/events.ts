/**
 * Product event timeline helper (WP3).
 *
 * Events are appended in the same commit as the state change they describe. They are a rebuildable
 * projection source, never a second source of truth: every event is derived from a state transition
 * that is also committed, and dropping the timeline cannot change product state.
 */

import { randomUUID } from 'node:crypto';
import type { Tx } from '@earendil-works/pi-durable';
import { Events, type ProductEvent } from '../storage/state.js';

export type ProductEventType =
  | 'chat.created'
  | 'memory.saved'
  | 'memory.forgotten'
  | 'job.started'
  | 'job.amended'
  | 'job.running'
  | 'job.ready'
  | 'job.failed'
  | 'job.cancelled'
  | 'attempt.started'
  | 'attempt.completed'
  | 'attempt.failed'
  | 'attempt.cancelled'
  | 'attempt.superseded'
  | 'schedule.created'
  | 'schedule.cancelled'
  | 'followup.decided'
  | 'delivery.intent'
  | 'delivery.done'
  | 'delivery.failed'
  | 'delivery.unknown'
  | 'artifact.sealed'
  | 'resource.updated'
  | 'resource.operation.settled'
  | 'state.migrated';

export type ProductEventInput = Readonly<{
  type: ProductEventType;
  aggregate: string;
  aggregateId: string;
  revision: number;
  /** Wall-clock milliseconds; defaults to the caller's clock. */
  at?: number;
  data?: Readonly<Record<string, unknown>> | null;
}>;

function eventData(value: Readonly<Record<string, unknown>> | null | undefined): ProductEvent['data'] {
  if (value === null || value === undefined) return null;
  const output: Record<string, string | number | boolean | null> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= 16 || key.length > 64) break;
    if (typeof raw === 'string') {
      output[key] = raw.slice(0, 512);
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      output[key] = raw;
    } else if (typeof raw === 'boolean' || raw === null) {
      output[key] = raw;
    } else {
      continue;
    }
    count += 1;
  }
  return count === 0 ? null : output;
}

/** Append one product event to the caller's transaction (same commit as the state change). */
export async function appendEvent(tx: Tx, input: ProductEventInput): Promise<ProductEvent> {
  const at = input.at ?? Date.now();
  const event: ProductEvent = {
    id: randomUUID(),
    type: input.type,
    aggregate: input.aggregate,
    aggregateId: input.aggregateId,
    revision: input.revision,
    at,
    data: eventData(input.data),
  };
  await tx.doc(Events, event.id, {
    id: event.id,
    type: event.type,
    aggregate: event.aggregate,
    aggregateId: event.aggregateId,
    revision: event.revision,
    at: event.at,
    data: event.data,
  });
  return event;
}
