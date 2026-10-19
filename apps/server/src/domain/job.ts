/**
 * Product Job and execution Attempt: two identities, one relationship (agent-core.md #2).
 *
 * A Job is what the user asked for and keeps the product result. An Attempt is one execution of one
 * Job revision. Recovering after a crash resumes the same Attempt (and its Durable task); amending or
 * retrying creates a new Attempt. Only the current Attempt of the current revision may complete the Job
 * (revision fence); an older Attempt may keep its records for audit but never overwrite a newer revision.
 *
 * This module is pure: no IO, no SDK types, no timestamps read from the environment. The caller supplies
 * `now`.
 */

export type JobStatus = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';
export type AttemptStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'superseded';

/** Product work. `revision` fences every result write; `currentAttemptId` names the only attempt allowed to finish it. */
export type Job = Readonly<{
  id: string;
  title: string;
  prompt: string;
  requirements: string[];
  revision: number;
  status: JobStatus;
  sourceChatId: string;
  executionChatId: string | null;
  currentAttemptId: string | null;
  result: string | null;
  artifactId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}>;

/** One execution attempt. Its own `revision` is the Job revision it was started for. */
export type Attempt = Readonly<{
  id: string;
  jobId: string;
  revision: number;
  status: AttemptStatus;
  taskId: string | null;
  conversationId: string;
  artifactId: string | null;
  result: string | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}>;

/** Keyed by execution conversation id; the only authority that tells the artifact tool which job/attempt it serves. */
export type JobExecution = Readonly<{jobId: string; attemptId: string; revision: number}>;

export type StartJob = Readonly<{
  requestId: string;
  title: string;
  prompt: string;
  requirements: string[];
  sourceChatId: string;
}>;

export type AmendJob = Readonly<{
  requestId: string;
  jobId: string;
  expectedRevision: number;
  prompt?: string;
  requirements?: string[];
}>;

export type CancelJob = Readonly<{requestId: string; jobId: string; expectedRevision: number}>;

export type StartJobResult = Readonly<{jobId: string; revision: number; attemptId: string}>;
export type AmendJobResult = Readonly<{jobId: string; revision: number; attemptId: string}>;
export type CancelJobResult = Readonly<{jobId: string; status: 'cancelled'}>;

export type JobCommandResult = StartJobResult | CancelJobResult;

export type JobErrorCode =
  | 'INVALID_COMMAND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REVISION_MISMATCH'
  | 'JOB_NOT_FOUND'
  | 'JOB_TERMINAL'
  | 'CHAT_NOT_FOUND'
  | 'ARTIFACT_REQUIRED';

/** Transport-independent domain failure, like `CommandError` and `ProfileError`. */
export class JobError extends Error {
  constructor(readonly code: JobErrorCode) {
    super(code);
    this.name = 'JobError';
  }
}

export const MAX_TITLE_CHARS = 200;
export const MAX_PROMPT_CHARS = 32000;
export const MAX_REQUIREMENTS = 20;
export const MAX_REQUIREMENT_CHARS = 2000;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const JOB_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CHAT_ID_PATTERN = /^[1-9][0-9]*$/;
const CONTROL_CHARS = /\p{Cc}/u;

/**
 * Attempt IDs are deterministic in `(jobId, revision)`. That keeps `attempts(jobId)` derivable from the Job
 * revision without a second index document: revisions 1..N name exactly the attempts that ever existed.
 */
export function attemptIdFor(jobId: string, revision: number): string {
  return `${jobId}-${revision}`;
}

/** True when `attemptId` is exactly the identity of the attempt for `jobId` at `revision`. */
export function isAttemptIdFor(attemptId: string, jobId: string, revision: number): boolean {
  return attemptId === attemptIdFor(jobId, revision);
}

const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  // `queued` from a non-cancelled status is an amendment: the revision grows and the work is queued again.
  queued: ['queued', 'running', 'cancelled'],
  running: ['queued', 'ready', 'failed', 'cancelled'],
  ready: ['queued', 'cancelled'],
  failed: ['queued', 'cancelled'],
  cancelled: [],
};

const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  queued: ['running', 'cancelled', 'superseded'],
  running: ['completed', 'failed', 'cancelled', 'superseded'],
  completed: ['superseded'],
  failed: ['superseded'],
  cancelled: [],
  superseded: [],
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function canTransitionAttempt(from: AttemptStatus, to: AttemptStatus): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

/** Cancellation may start from any live or settled attempt that is not already cancelled. */
export function canCancelJob(job: Readonly<{status: JobStatus}>): boolean {
  return job.status !== 'cancelled';
}

/** A cancelled Job is terminal and cannot be amended; every other status may take a new revision. */
export function canAmendJob(job: Readonly<{status: JobStatus}>): boolean {
  return job.status !== 'cancelled';
}

/** `REVISION_MISMATCH` unless the caller reasons about exactly the current Job revision. */
export function assertExpectedRevision(job: Readonly<{revision: number}>, expectedRevision: number): void {
  if (job.revision !== expectedRevision) throw new JobError('REVISION_MISMATCH');
}

/**
 * Where an attempt stands relative to its Job, for the attempt task's fence:
 * - cancelled: the Job or the attempt is cancelled; do not write a result.
 * - superseded: the attempt is not the current one, or its revision is old; never overwrite the Job.
 * - current: this attempt may decide the Job result, still subject to the artifact requirement.
 */
export function attemptDisposition(
  job: Readonly<{status: JobStatus; revision: number; currentAttemptId: string | null}>,
  attempt: Readonly<{id: string; status: AttemptStatus; revision: number}>,
): 'cancelled' | 'superseded' | 'current' {
  if (job.status === 'cancelled' || attempt.status === 'cancelled') return 'cancelled';
  if (job.currentAttemptId !== attempt.id || job.revision !== attempt.revision) return 'superseded';
  return 'current';
}

/**
 * The only artifact that may make a Job ready: sealed, verified against its file, and owned by exactly this
 * Job/Attempt/revision. Writing/unknown/failed artifacts are never success (jobs-and-artifacts.md §4).
 */
export function sealedArtifactMatches(
  artifact: Readonly<{state: string; jobId: string; attemptId: string; revision: number}>,
  job: Readonly<{id: string}>,
  attempt: Readonly<{id: string; revision: number}>,
  verified: boolean,
): boolean {
  return verified
    && artifact.state === 'sealed'
    && artifact.jobId === job.id
    && artifact.attemptId === attempt.id
    && artifact.revision === attempt.revision;
}

function strictObject(input: unknown, keys: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new JobError('INVALID_COMMAND');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new JobError('INVALID_COMMAND');
  }
  return value;
}

function parseRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) throw new JobError('INVALID_COMMAND');
  return value;
}

function parseJobId(value: unknown): string {
  if (typeof value !== 'string' || !JOB_ID_PATTERN.test(value)) throw new JobError('INVALID_COMMAND');
  return value;
}

function parseChatId(value: unknown): string {
  if (typeof value !== 'string' || !CHAT_ID_PATTERN.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new JobError('INVALID_COMMAND');
  }
  return value;
}

function parseExpectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new JobError('INVALID_COMMAND');
  return value;
}

function parseTitle(value: unknown): string {
  if (typeof value !== 'string') throw new JobError('INVALID_COMMAND');
  const title = value.trim();
  if (!title || Array.from(title).length > MAX_TITLE_CHARS || CONTROL_CHARS.test(title)) throw new JobError('INVALID_COMMAND');
  return title;
}

function parsePrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PROMPT_CHARS) throw new JobError('INVALID_COMMAND');
  return value;
}

function parseRequirements(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_REQUIREMENTS) throw new JobError('INVALID_COMMAND');
  return value.map(item => {
    if (typeof item !== 'string') throw new JobError('INVALID_COMMAND');
    const requirement = item.trim();
    if (!requirement || Array.from(requirement).length > MAX_REQUIREMENT_CHARS) throw new JobError('INVALID_COMMAND');
    return requirement;
  });
}

/** `start({requestId, title, prompt, requirements?, sourceChatId})`: strict input, no coercion, no ignored fields. */
export function parseStartJob(input: unknown): StartJob {
  const value = strictObject(input, ['requestId', 'title', 'prompt', 'requirements', 'sourceChatId'],
    ['requestId', 'title', 'prompt', 'sourceChatId']);
  return {
    requestId: parseRequestId(value.requestId),
    title: parseTitle(value.title),
    prompt: parsePrompt(value.prompt),
    // Explicit `undefined` is rejected like any other non-array value: strict input, no coercion.
    requirements: Object.hasOwn(value, 'requirements') ? parseRequirements(value.requirements) : [],
    sourceChatId: parseChatId(value.sourceChatId),
  };
}

/** `amend({requestId, jobId, expectedRevision, prompt?, requirements?})`: at least one editable field. */
export function parseAmendJob(input: unknown): AmendJob {
  const value = strictObject(input, ['requestId', 'jobId', 'expectedRevision', 'prompt', 'requirements'],
    ['requestId', 'jobId', 'expectedRevision']);
  const hasPrompt = Object.hasOwn(value, 'prompt');
  const hasRequirements = Object.hasOwn(value, 'requirements');
  if (!hasPrompt && !hasRequirements) throw new JobError('INVALID_COMMAND');
  const command: {requestId: string; jobId: string; expectedRevision: number; prompt?: string; requirements?: string[]} = {
    requestId: parseRequestId(value.requestId),
    jobId: parseJobId(value.jobId),
    expectedRevision: parseExpectedRevision(value.expectedRevision),
  };
  if (hasPrompt) command.prompt = parsePrompt(value.prompt);
  if (hasRequirements) command.requirements = parseRequirements(value.requirements);
  return command;
}

/** `cancel({requestId, jobId, expectedRevision})`: optimistic revision check, then one atomic cancellation. */
export function parseCancelJob(input: unknown): CancelJob {
  const value = strictObject(input, ['requestId', 'jobId', 'expectedRevision'],
    ['requestId', 'jobId', 'expectedRevision']);
  return {
    requestId: parseRequestId(value.requestId),
    jobId: parseJobId(value.jobId),
    expectedRevision: parseExpectedRevision(value.expectedRevision),
  };
}

/** Opaque Job id at the command/query boundary; generated as a UUID by the runtime. */
export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID_PATTERN.test(value);
}

/** Validate an opaque attempt id used to compute storage keys; the owner (runtime) knows the expected shape. */
export function isAttemptId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value);
}

/** Artifact ids are `${attemptId}:${callId}`; the artifact domain owns their exact grammar, this only guards IO. */
export function isArtifactIdQuery(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512 && !CONTROL_CHARS.test(value);
}
