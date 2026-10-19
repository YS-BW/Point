import { defineDocFamily, defineEntry } from '@earendil-works/pi-durable';
import type { Delivery } from '../domain/delivery.js';

/**
 * One auditable delivery attempt; latest-only session family keyed by deliveryId.
 *
 * Version 2 adds the attempt fence (`attemptToken/workerId/attemptStartedAt/deadline`). No migration
 * is installed: a version-1 document is rejected by the Durable SDK (stable `DELIVERY_INCOMPATIBLE`
 * at the store boundary) instead of being silently upgraded without a worker identity.
 */
export const Deliveries = defineDocFamily({
  kind: 'point.delivery', version: 2, scope: 'session', family: true,
  initial: (delivery: Delivery) => ({...delivery, occurrenceIds: [...delivery.occurrenceIds]}),
});

/** Bookkeeping payload of the assistant entry a chat delivery appends to the source chat. */
export type ReportEntryData = {
  jobId: string;
  deliveryId: string;
  occurrenceIds: string[];
};

/**
 * Display entry kind for a delivered report: the model sees it as an assistant
 * message, clients can project it by kind, and no model call generated it.
 */
export const ReportEntries = defineEntry<ReportEntryData>('point.report');
