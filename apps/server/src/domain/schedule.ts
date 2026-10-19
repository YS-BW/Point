/**
 * Single follow-up plan (Schedule), its occurrences and the auditable Decision (WP1b.4).
 *
 * A Schedule belongs to one Job revision and materializes at most two absolute reminders: an optional
 * advance reminder and the due reminder. All times are absolute UTC milliseconds; a past time is valid
 * (missed windows are merged, not shifted). This module is pure: no IO, no SDK types, no clock reads.
 */

export type ScheduleStatus = 'active' | 'cancelled' | 'done';
export type OccurrenceState = 'pending' | 'delivered' | 'skipped';
export type FollowupChoice = 'deliver' | 'skip';

/** The only decision policy in this slice; persisted on every Decision for audit. */
export const FOLLOWUP_POLICY = 'point.followup.v1' as const;
export type FollowupPolicy = typeof FOLLOWUP_POLICY;

/** Hard product limit: one schedule reminds at most twice. */
export const MAX_REMINDERS = 2;
/** One schedule materializes at most two occurrences (advance + due). */
export const MAX_OCCURRENCES = 2;

export type Schedule = Readonly<{
  id: string;
  jobId: string;
  revision: number;
  sourceChatId: string;
  status: ScheduleStatus;
  occurrenceIds: string[];
  createdAt: number;
  updatedAt: number;
}>;

export type Occurrence = Readonly<{
  id: string;
  scheduleId: string;
  jobId: string;
  revision: number;
  index: number;
  dueAt: number;
  state: OccurrenceState;
  reason: string | null;
}>;

export type Decision = Readonly<{
  id: string;
  scheduleId: string;
  jobId: string;
  revision: number;
  occurrenceIds: string[];
  choice: FollowupChoice;
  reason: string;
  policy: FollowupPolicy;
  createdAt: number;
}>;

export type ScheduleFollowup = Readonly<{
  requestId: string;
  jobId: string;
  expectedRevision: number;
  dueAt: number;
  advanceAt?: number;
  sourceChatId?: string;
}>;

export type CancelFollowup = Readonly<{requestId: string; scheduleId: string}>;

export type ScheduleFollowupResult = Readonly<{scheduleId: string; occurrenceIds: string[]}>;
export type CancelFollowupResult = Readonly<{scheduleId: string; status: ScheduleStatus}>;
export type FollowupCommandResult = ScheduleFollowupResult | CancelFollowupResult;

export type ScheduleErrorCode =
  | 'INVALID_COMMAND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_MISMATCH'
  | 'JOB_NOT_FOUND'
  | 'JOB_TERMINAL'
  | 'JOB_NOT_READY'
  | 'SCHEDULE_EXISTS'
  | 'SCHEDULE_NOT_FOUND';

/** Transport-independent domain failure, like `JobError` and `ArtifactError`. */
export class ScheduleError extends Error {
  constructor(readonly code: ScheduleErrorCode) {
    super(code);
    this.name = 'ScheduleError';
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const OWNER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CHAT_ID_PATTERN = /^[1-9][0-9]*$/;
/** Largest safe epoch millisecond accepted by `Date`-based scheduling. */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

const SCHEDULE_TRANSITIONS: Readonly<Record<ScheduleStatus, readonly ScheduleStatus[]>> = {
  active: ['cancelled', 'done'],
  cancelled: [],
  done: [],
};

const OCCURRENCE_TRANSITIONS: Readonly<Record<OccurrenceState, readonly OccurrenceState[]>> = {
  pending: ['delivered', 'skipped'],
  delivered: [],
  skipped: [],
};

export function canTransitionSchedule(from: ScheduleStatus, to: ScheduleStatus): boolean {
  return SCHEDULE_TRANSITIONS[from].includes(to);
}

export function canTransitionOccurrence(from: OccurrenceState, to: OccurrenceState): boolean {
  return OCCURRENCE_TRANSITIONS[from].includes(to);
}

export function isActiveSchedule(schedule: Readonly<{status: ScheduleStatus}>): boolean {
  return schedule.status === 'active';
}

/** Occurrence ids are deterministic in `(scheduleId, index)`, so a schedule lists exactly its two windows. */
export function occurrenceIdFor(scheduleId: string, index: number): string {
  return `${scheduleId}-o${index}`;
}

export function isOccurrenceIdFor(occurrenceId: string, scheduleId: string, index: number): boolean {
  return occurrenceId === occurrenceIdFor(scheduleId, index);
}

/**
 * Materialize the occurrences of one schedule: the optional advance reminder first (index 0), the due
 * reminder last. The caller has already validated `advanceAt < dueAt`.
 */
export function createOccurrences(
  scheduleId: string,
  jobId: string,
  revision: number,
  times: Readonly<{dueAt: number; advanceAt?: number}>,
): Occurrence[] {
  const pairs: ReadonlyArray<Readonly<{dueAt: number; index: number}>> = times.advanceAt === undefined
    ? [{dueAt: times.dueAt, index: 0}]
    : [{dueAt: times.advanceAt, index: 0}, {dueAt: times.dueAt, index: 1}];
  return pairs.map(({dueAt, index}) => ({
    id: occurrenceIdFor(scheduleId, index),
    scheduleId,
    jobId,
    revision,
    index,
    dueAt,
    state: 'pending',
    reason: null,
  }));
}

export type FollowupEvaluationInput = Readonly<{
  /** Current Job, or undefined when it does not exist (treated as no longer deliverable). */
  job: Readonly<{status: string; revision: number}> | undefined;
  scheduleRevision: number;
  /** Occurrences of this schedule already delivered before this batch. */
  deliveredCount: number;
  /** Occurrences in the batch being judged now (missed windows are merged into one batch). */
  batchSize: number;
}>;

export type FollowupEvaluation = Readonly<{choice: FollowupChoice; reason: string}>;

/**
 * Auditable follow-up policy `point.followup.v1` (contract §4.5). The order is deliberate: a cancelled
 * Job wins over a stale revision, a Job that is not `ready` is never reminded, and only a current ready
 * Job under the reminder cap produces a delivery. Every outcome is recorded as a Decision.
 */
export function evaluateFollowup(input: FollowupEvaluationInput): FollowupEvaluation {
  if (!input.job || input.job.status === 'cancelled') return {choice: 'skip', reason: 'job-cancelled'};
  if (input.job.revision !== input.scheduleRevision) return {choice: 'skip', reason: 'stale-revision'};
  if (input.job.status !== 'ready') return {choice: 'skip', reason: 'job-not-ready'};
  if (input.deliveredCount + input.batchSize > MAX_REMINDERS) return {choice: 'skip', reason: 'reminder-cap'};
  return {choice: 'deliver', reason: 'due-reminder'};
}

function strictObject(input: unknown, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ScheduleError('INVALID_COMMAND');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new ScheduleError('INVALID_COMMAND');
  }
  return value;
}

function parseRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) throw new ScheduleError('INVALID_COMMAND');
  return value;
}

function parseOwnerId(value: unknown, code: ScheduleErrorCode = 'INVALID_COMMAND'): string {
  if (typeof value !== 'string' || !OWNER_ID_PATTERN.test(value)) throw new ScheduleError(code);
  return value;
}

function parseExpectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ScheduleError('INVALID_COMMAND');
  return value;
}

function parseTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_EPOCH_MS) {
    throw new ScheduleError('INVALID_COMMAND');
  }
  return value;
}

function parseChatId(value: unknown): string {
  if (typeof value !== 'string' || !CHAT_ID_PATTERN.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ScheduleError('INVALID_COMMAND');
  }
  return value;
}

/**
 * `schedule({requestId, jobId, expectedRevision, dueAt, advanceAt?, sourceChatId?})`: strict input, no
 * coercion. Absolute times may be in the past; `advanceAt`, when present, must be strictly before `dueAt`.
 */
export function parseScheduleFollowup(input: unknown): ScheduleFollowup {
  const value = strictObject(input,
    ['requestId', 'jobId', 'expectedRevision', 'dueAt', 'advanceAt', 'sourceChatId'],
    ['requestId', 'jobId', 'expectedRevision', 'dueAt']);
  const dueAt = parseTime(value.dueAt);
  const command: {
    requestId: string; jobId: string; expectedRevision: number; dueAt: number;
    advanceAt?: number; sourceChatId?: string;
  } = {
    requestId: parseRequestId(value.requestId),
    jobId: parseOwnerId(value.jobId),
    expectedRevision: parseExpectedRevision(value.expectedRevision),
    dueAt,
  };
  if (Object.hasOwn(value, 'advanceAt')) {
    const advanceAt = parseTime(value.advanceAt);
    if (advanceAt >= dueAt) throw new ScheduleError('INVALID_COMMAND');
    command.advanceAt = advanceAt;
  }
  if (Object.hasOwn(value, 'sourceChatId')) command.sourceChatId = parseChatId(value.sourceChatId);
  return command;
}

/** `cancel({requestId, scheduleId})`: only the schedule's own lifecycle, never the Job. */
export function parseCancelFollowup(input: unknown): CancelFollowup {
  const value = strictObject(input, ['requestId', 'scheduleId'], ['requestId', 'scheduleId']);
  return {requestId: parseRequestId(value.requestId), scheduleId: parseOwnerId(value.scheduleId)};
}

/** Opaque schedule id at the query boundary. */
export function isScheduleId(value: unknown): value is string {
  return typeof value === 'string' && OWNER_ID_PATTERN.test(value);
}

/** Opaque Job id at the query boundary. */
export function isFollowupJobId(value: unknown): value is string {
  return typeof value === 'string' && OWNER_ID_PATTERN.test(value);
}
