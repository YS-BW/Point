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

/** Bounded, already-redacted failure context. Never credentials, URLs with userinfo, or response bodies. */
export type NotificationDetail = Readonly<Record<string, string | number | boolean | null>>;

/**
 * Structured notification outcome. The three-state `outcome` stays the only dispatch decision; `code`,
 * `status` and the bounded `detail` are audit hints and must never carry secrets or response bodies.
 */
export type NotificationResult = Readonly<{
  outcome: NotificationOutcome;
  code?: string;
  status?: number;
  detail?: NotificationDetail;
}>;

/** Adapters may return the historical string outcome or the structured result; both mean the same three states. */
export type NotificationSendResult = NotificationOutcome | NotificationResult;

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
  send(request: NotificationRequest): Promise<NotificationSendResult>;
}

/** Normalize a port result to the structured form without changing its meaning. */
export function notificationResult(result: NotificationSendResult): NotificationResult {
  return typeof result === 'string' ? {outcome: result} : result;
}

/** The only dispatch decision: the tri-state outcome. Structured hints never change it. */
export function notificationOutcome(result: NotificationSendResult): NotificationOutcome {
  return typeof result === 'string' ? result : result.outcome;
}

function auditSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

/**
 * Redacted audit string persisted in `Delivery.error`. A legacy plain-string result keeps the exact
 * historical value; a structured result appends only adapter-provided `code`, `status` and
 * `detail.classification`. `detail` itself, headers, tokens, URLs and response bodies never enter it.
 */
export function notificationAuditError(
  result: NotificationSendResult, fallback: 'notification-failed' | 'notification-unknown',
): string {
  const structured = notificationResult(result);
  const parts: string[] = [fallback];
  if (structured.code !== undefined) {
    const code = auditSegment(structured.code);
    if (code !== '') parts.push(code);
  }
  if (structured.status !== undefined && Number.isSafeInteger(structured.status)) {
    parts.push(String(structured.status));
  }
  const classification = structured.detail?.classification;
  if (typeof classification === 'string') {
    const value = auditSegment(classification);
    if (value !== '') parts.push(value);
  }
  return parts.join(':');
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
