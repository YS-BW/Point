/**
 * Pure delivery rules for WP1b.4: one Delivery is one auditable attempt to put a
 * finished Job in front of the user, either back into the source chat or through an
 * external notification channel.
 *
 * The tri-state is the invariant: a durable `intent` is recorded before any effect,
 * the attempt is recorded before the effect runs, and the outcome can only be
 * `done`, `unknown` or `failed`. `unknown` is terminal here: it is never retried or
 * replayed automatically. No IO, no platform or SDK imports.
 */

export type DeliveryChannel = 'chat' | 'notification';

export type DeliveryStatus = 'intent' | 'attempting' | 'done' | 'unknown' | 'failed';

export type Delivery = Readonly<{
  id: string;
  jobId: string;
  scheduleId: string;
  occurrenceIds: string[];
  revision: number;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  attempts: number;
  result: string | null;
  error: string | null;
  /** Attempt fencing (P0-3): only the recorded token may settle an in-flight attempt. */
  attemptToken: string | null;
  /** Durable worker that owns the attempt; the completing NotifyTask's id proves a dead previous invocation. */
  workerId: string | null;
  attemptStartedAt: number | null;
  /** Absolute deadline for the in-flight attempt; expiry permits explicit recovery only. */
  deadline: number | null;
  createdAt: number;
  updatedAt: number;
}>;

export type DeliveryErrorCode =
  | 'INVALID_COMMAND'
  | 'DELIVERY_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'STALE_ATTEMPT'
  | 'RECOVERY_NOT_ALLOWED'
  | 'DELIVERY_INCOMPATIBLE';

export class DeliveryError extends Error {
  constructor(readonly code: DeliveryErrorCode) {
    super(code);
    this.name = 'DeliveryError';
  }
}

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;

export function isDeliveryId(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function assertIdentifier(value: unknown): asserts value is string {
  if (!isDeliveryId(value)) throw new DeliveryError('INVALID_COMMAND');
}

function assertCount(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DeliveryError('INVALID_COMMAND');
  }
}

function assertText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 512) throw new DeliveryError('INVALID_COMMAND');
}

export type CreateDelivery = Readonly<{
  id: string;
  jobId: string;
  scheduleId: string;
  occurrenceIds: string[];
  revision: number;
  channel: DeliveryChannel;
  createdAt: number;
}>;

/** A new Delivery starts as `intent`; only the owning task advances it. */
export function initialDelivery(input: CreateDelivery): Delivery {
  assertIdentifier(input.id);
  assertIdentifier(input.jobId);
  assertIdentifier(input.scheduleId);
  assertCount(input.revision);
  if (input.channel !== 'chat' && input.channel !== 'notification') throw new DeliveryError('INVALID_COMMAND');
  if (!Array.isArray(input.occurrenceIds) || !input.occurrenceIds.every(isDeliveryId)) {
    throw new DeliveryError('INVALID_COMMAND');
  }
  assertCount(input.createdAt);
  return {
    id: input.id,
    jobId: input.jobId,
    scheduleId: input.scheduleId,
    occurrenceIds: [...input.occurrenceIds],
    revision: input.revision,
    channel: input.channel,
    status: 'intent',
    attempts: 0,
    result: null,
    error: null,
    attemptToken: null,
    workerId: null,
    attemptStartedAt: null,
    deadline: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

/** intent -> attempting, recorded before the external action runs (legacy token-less helper). */
export function startDelivery(delivery: Delivery, now: number): Delivery {
  assertCount(now);
  if (delivery.status !== 'intent') throw new DeliveryError('INVALID_TRANSITION');
  return {...delivery, status: 'attempting', attempts: delivery.attempts + 1, updatedAt: now};
}

export type DeliveryAttempt = Readonly<{
  /** CAS identity of this invocation; only this token may settle the attempt. */
  token: string;
  /** Stable worker identity (the Durable task id), used to prove a dead previous invocation. */
  workerId: string;
  startedAt: number;
  /** Absolute deadline; the attempt is expired from this instant onwards. */
  deadline: number;
}>;

export type DeliveryAttemptState = 'idle' | 'live' | 'expired';

/** intent -> attempting with token, worker identity, start time and absolute deadline. */
export function startDeliveryAttempt(delivery: Delivery, attempt: DeliveryAttempt): Delivery {
  assertIdentifier(attempt.token);
  assertIdentifier(attempt.workerId);
  assertCount(attempt.startedAt);
  assertCount(attempt.deadline);
  if (attempt.deadline < attempt.startedAt) throw new DeliveryError('INVALID_COMMAND');
  if (delivery.status !== 'intent') throw new DeliveryError('INVALID_TRANSITION');
  return {
    ...delivery,
    status: 'attempting',
    attempts: delivery.attempts + 1,
    result: null,
    error: null,
    attemptToken: attempt.token,
    workerId: attempt.workerId,
    attemptStartedAt: attempt.startedAt,
    deadline: attempt.deadline,
    updatedAt: attempt.startedAt,
  };
}

/**
 * `idle` when no attempt is in flight; `live` while the recorded deadline has not passed; `expired`
 * after it. A version-2 `attempting` document without a token/deadline is treated as expired
 * (fail-closed, recoverable explicitly, never auto-replayed).
 */
export function deliveryAttemptState(delivery: Delivery, now: number): DeliveryAttemptState {
  assertCount(now);
  if (delivery.status !== 'attempting') return 'idle';
  if (delivery.attemptToken === null || delivery.workerId === null
    || delivery.attemptStartedAt === null || delivery.deadline === null) return 'expired';
  return now >= delivery.deadline ? 'expired' : 'live';
}

export type DeliverySettlement =
  | Readonly<{status: 'done'; result: string | null}>
  | Readonly<{status: 'failed' | 'unknown'; error: string}>;

/**
 * Token-CAS settlement of an in-flight attempt: only the matching token may transition it. A
 * terminal delivery is returned untouched (idempotent repeat); a mismatched token is `STALE_ATTEMPT`
 * and must leave the record to the worker/recovery that won.
 */
export function settleDeliveryAttempt(
  delivery: Delivery, settlement: DeliverySettlement, input: Readonly<{token: string; now: number}>,
): Delivery {
  assertIdentifier(input.token);
  assertCount(input.now);
  if (isTerminal(delivery.status)) return delivery;
  if (delivery.status !== 'attempting') throw new DeliveryError('INVALID_TRANSITION');
  if (delivery.attemptToken !== input.token) throw new DeliveryError('STALE_ATTEMPT');
  if (settlement.status === 'done') {
    if (settlement.result !== null) assertText(settlement.result);
    return {...delivery, status: 'done', result: settlement.result, error: null, updatedAt: input.now};
  }
  assertText(settlement.error);
  return {...delivery, status: settlement.status, result: null, error: settlement.error, updatedAt: input.now};
}

/** Explicit recovery of an expired attempt: only after its recorded deadline; never automatic replay. */
export function recoverExpiredDeliveryAttempt(
  delivery: Delivery, input: Readonly<{now: number; reason: string}>,
): Delivery {
  assertCount(input.now);
  assertText(input.reason);
  if (delivery.status !== 'attempting') throw new DeliveryError('INVALID_TRANSITION');
  if (delivery.deadline === null || input.now < delivery.deadline) {
    throw new DeliveryError('RECOVERY_NOT_ALLOWED');
  }
  return {...delivery, status: 'unknown', result: null, error: input.reason, updatedAt: input.now};
}

/**
 * Recovery of an attempt whose exact worker is provably dead: the same Durable task resumed, so its
 * previous invocation cannot still be running. This is the only live-deadline recovery path and is
 * never used for a concurrent different worker.
 */
export function recoverInterruptedDeliveryAttempt(
  delivery: Delivery, input: Readonly<{now: number; reason: string}>,
): Delivery {
  assertCount(input.now);
  assertText(input.reason);
  if (delivery.status !== 'attempting') throw new DeliveryError('INVALID_TRANSITION');
  return {...delivery, status: 'unknown', result: null, error: input.reason, updatedAt: input.now};
}

function isTerminal(status: DeliveryStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'unknown';
}

/**
 * attempting -> done. A terminal Delivery is returned untouched, so repeated
 * settlement is idempotent; non-terminal illegal transitions still throw.
 */
export function completeDelivery(delivery: Delivery, result: string | null, now: number): Delivery {
  assertCount(now);
  if (result !== null) assertText(result);
  if (isTerminal(delivery.status)) return delivery;
  if (delivery.status !== 'attempting') throw new DeliveryError('INVALID_TRANSITION');
  return {...delivery, status: 'done', result, error: null, updatedAt: now};
}

/**
 * intent|attempting -> failed (a known failure; never retried automatically).
 * Terminal Deliveries are returned untouched, like any other repeated settlement.
 */
export function failDelivery(delivery: Delivery, error: string, now: number): Delivery {
  assertCount(now);
  assertText(error);
  if (isTerminal(delivery.status)) return delivery;
  if (delivery.status !== 'intent' && delivery.status !== 'attempting') {
    throw new DeliveryError('INVALID_TRANSITION');
  }
  return {...delivery, status: 'failed', result: null, error, updatedAt: now};
}

/** attempting -> unknown: the conservative terminal state for an unconfirmed effect. */
export function markDeliveryUnknown(delivery: Delivery, error: string, now: number): Delivery {
  assertCount(now);
  assertText(error);
  if (delivery.status !== 'attempting') throw new DeliveryError('INVALID_TRANSITION');
  return {...delivery, status: 'unknown', result: null, error, updatedAt: now};
}

export type DeliveryReportInput = Readonly<{
  title: string;
  result: string | null;
  artifactId: string | null;
  artifactPath?: string;
}>;

/**
 * Human-readable report used for the chat entry and the notification text. It never
 * claims more than the Job/Artifact documents actually say.
 */
export function reportText(input: DeliveryReportInput): string {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new DeliveryError('INVALID_COMMAND');
  const lines = [`工作「${input.title}」已完成。`];
  const result = input.result?.trim();
  if (result) lines.push(result);
  if (input.artifactId === null) {
    lines.push('产物：无');
  } else {
    assertIdentifier(input.artifactId);
    lines.push(input.artifactPath === undefined
      ? `产物：${input.artifactId}`
      : `产物：${input.artifactId}（${input.artifactPath}）`);
  }
  return lines.join('\n');
}

/** Defensive parse of a stored/scanned document; never throws. */
export function parseDelivery(value: unknown): Delivery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isDeliveryId(record.id)
    || !isDeliveryId(record.jobId)
    || !isDeliveryId(record.scheduleId)
    || !Array.isArray(record.occurrenceIds)
    || !record.occurrenceIds.every(isDeliveryId)
    || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision) || record.revision < 0
    || (record.channel !== 'chat' && record.channel !== 'notification')
    || !['intent', 'attempting', 'done', 'unknown', 'failed'].includes(record.status as string)
    || typeof record.attempts !== 'number' || !Number.isSafeInteger(record.attempts) || record.attempts < 0
    || (record.result !== null && typeof record.result !== 'string')
    || (record.error !== null && typeof record.error !== 'string')
    || (record.attemptToken !== null && (typeof record.attemptToken !== 'string' || !isDeliveryId(record.attemptToken)))
    || (record.workerId !== null && (typeof record.workerId !== 'string' || !isDeliveryId(record.workerId)))
    || (record.attemptStartedAt !== null && (typeof record.attemptStartedAt !== 'number'
      || !Number.isSafeInteger(record.attemptStartedAt) || record.attemptStartedAt < 0))
    || (record.deadline !== null && (typeof record.deadline !== 'number'
      || !Number.isSafeInteger(record.deadline) || record.deadline < 0))
    || typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0
    || typeof record.updatedAt !== 'number' || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) {
    return undefined;
  }
  return {
    id: record.id,
    jobId: record.jobId,
    scheduleId: record.scheduleId,
    occurrenceIds: [...record.occurrenceIds] as string[],
    revision: record.revision,
    channel: record.channel,
    status: record.status as DeliveryStatus,
    attempts: record.attempts,
    result: record.result,
    error: record.error,
    attemptToken: record.attemptToken,
    workerId: record.workerId,
    attemptStartedAt: record.attemptStartedAt,
    deadline: record.deadline,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
