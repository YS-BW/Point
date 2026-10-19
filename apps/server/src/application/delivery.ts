/**
 * Delivery application boundary: the query surface over durable Delivery documents
 * and the notification port. External channels implement only `NotificationPort`;
 * the delivery tasks and the tri-state rules stay in runtime/domain.
 */

import { isDeliveryId, type Delivery } from '../domain/delivery.js';

/** Re-exported for runtime consumers (plan-impl reads Delivery values). */
export type {Delivery, DeliveryChannel, DeliveryStatus} from '../domain/delivery.js';

/** Persistence port for delivery queries. */
export interface DeliveryStore {
  load(deliveryId: string): Promise<Delivery | undefined>;
  list(jobId?: string): Promise<Delivery[]>;
}

export type NotificationOutcome = 'delivered' | 'failed' | 'unknown';

export type NotificationRequest = Readonly<{
  deliveryId: string;
  target: string;
  title: string;
  text: string;
}>;

/**
 * External notification capability. Only this port may leave the process; callers
 * must record the attempt before calling and record done/failed/unknown after. A
 * thrown error or `unknown` is never retried automatically.
 */
export interface NotificationPort {
  send(request: NotificationRequest): Promise<NotificationOutcome>;
}

export interface DeliveryCommands {
  get(deliveryId: string): Promise<Delivery | undefined>;
  /** Newest-last by createdAt, then id; `jobId` filters one Job. */
  list(jobId?: string): Promise<Delivery[]>;
}

/** One materialized current document of a family kind, as `open.ts` scans them. */
export type ScannedDocument = Readonly<{
  key: string;
  value: Readonly<Record<string, unknown>>;
}>;

/**
 * Session document scan supplied by the composition root (`storage.scanDocuments`
 * plus `storage.document`). Harness/Session expose no document scan of their own.
 */
export type SessionDocumentScanner = (kind: string) => Promise<readonly ScannedDocument[]>;

function compareDeliveries(left: Delivery, right: Delivery): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function deliveryCommands(store: DeliveryStore): DeliveryCommands {
  return {
    async get(deliveryId) {
      if (!isDeliveryId(deliveryId)) return undefined;
      return store.load(deliveryId);
    },
    async list(jobId) {
      if (jobId !== undefined && !isDeliveryId(jobId)) return [];
      const deliveries = await store.list(jobId);
      return [...deliveries].sort(compareDeliveries);
    },
  };
}
