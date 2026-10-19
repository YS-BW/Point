/**
 * Bounded request-ledger cleanup (WP3).
 *
 * Cleanup is an explicit command over the `point.requests` discovery index. It removes only receipts
 * that are (a) older than the retention window, (b) outside the protected most-recent `keepCount`
 * window, and (c) no longer referenced by an active/attempting/unresolved record. Anything it cannot
 * prove terminal is kept and reported with a reason; the operation is fail-closed.
 */

import type { Harness, TaskId, Tx } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Attempts, JobCommandReceipts, Jobs } from '../storage/job.js';
import type { Job } from '../domain/job.js';
import type { Attempt } from '../domain/job.js';
import { CreateChatReceipts } from '../storage/chats.js';
import { ProfileReceipts } from '../storage/profile.js';
import { FollowupCommandReceipts, Schedules } from '../storage/schedule.js';
import type { Schedule } from '../domain/schedule.js';
import {
  ABSENT_OPERATION, ResourceCommandReceipts, ResourceOperations,
} from '../storage/resource.js';
import { CommandReceipts, CompactReceipts } from '../storage/conversation.js';
import { Events, RequestsIndex, type RequestIndexEntry } from '../storage/state.js';
import { appendEvent, type ProductEventType } from './events.js';
import type { SessionDocumentScanner } from './schedules.js';

export const DEFAULT_RECEIPT_KEEP_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_RECEIPT_KEEP_COUNT = 10_000;
export const MAX_RECEIPTS_PER_CLEANUP = 1_000;

export type ReceiptCleanupOptions = Readonly<{
  /** Age threshold; receipts newer than this are always kept. Default 30 days. */
  keepMs?: number;
  /** Most-recent receipts always kept, regardless of age. Default 10k. */
  keepCount?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Report what would be removed without committing. */
  dryRun?: boolean;
}>;

export type ReceiptCleanupResult = Readonly<{
  scanned: number;
  removed: number;
  kept: number;
  dryRun: boolean;
  reasons: Readonly<Record<string, number>>;
  removedKeys: readonly string[];
}>;

export type ReceiptCleanupDeps = Readonly<{
  getHarness: () => Harness;
  scan: SessionDocumentScanner;
  now?: () => number;
}>;

function emptyReasons(): Record<string, number> {
  return {
    young: 0, protectedNewest: 0, active: 0, attempting: 0, unknown: 0, referenced: 0,
    missingReceipt: 0, error: 0, unindexed: 0, limit: 0,
  };
}

function pageKey(entry: Readonly<RequestIndexEntry>): string {
  return entry.key;
}

function compareOldest(left: Readonly<RequestIndexEntry>, right: Readonly<RequestIndexEntry>): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

type ReceiptValue = Readonly<Record<string, unknown>>;

/** Load one receipt via its concrete family token; unknown families are never deleted (fail-closed). */
async function loadReceipt(
  family: string, receiptKey: string, harness: Harness,
): Promise<ReceiptValue | undefined> {
  switch (family) {
    case 'point.command.chat-create': return harness.snapshot(CreateChatReceipts, receiptKey, context);
    case 'point.command.profile': return harness.snapshot(ProfileReceipts, receiptKey, context);
    case 'point.conversation.command': return harness.snapshot(CommandReceipts, receiptKey, context);
    case 'point.command.compact': return harness.snapshot(CompactReceipts, receiptKey, context);
    case 'point.command.job': return harness.snapshot(JobCommandReceipts, receiptKey, context);
    case 'point.command.followup': return harness.snapshot(FollowupCommandReceipts, receiptKey, context);
    case 'point.resource-command': return harness.snapshot(ResourceCommandReceipts, receiptKey, context);
    default: return undefined;
  }
}

/** Retire one receipt via its concrete family token; unknown families were never scheduled. */
async function retireReceipt(tx: Parameters<Parameters<Harness['commit']>[0]>[0], family: string, receiptKey: string): Promise<void> {
  switch (family) {
    case 'point.command.chat-create': await tx.retireDoc(CreateChatReceipts, receiptKey); return;
    case 'point.command.profile': await tx.retireDoc(ProfileReceipts, receiptKey); return;
    case 'point.conversation.command': await tx.retireDoc(CommandReceipts, receiptKey); return;
    case 'point.command.compact': await tx.retireDoc(CompactReceipts, receiptKey); return;
    case 'point.command.job': await tx.retireDoc(JobCommandReceipts, receiptKey); return;
    case 'point.command.followup': await tx.retireDoc(FollowupCommandReceipts, receiptKey); return;
    case 'point.resource-command': await tx.retireDoc(ResourceCommandReceipts, receiptKey); return;
    default: return;
  }
}

function isReceiptFamily(family: string): boolean {
  return ['point.command.chat-create', 'point.command.profile', 'point.conversation.command',
    'point.command.compact', 'point.command.job', 'point.command.followup',
    'point.resource-command'].includes(family);
}

/**
 * Receipt reference safety. Each receipt shape is inspected from its durable document (the migration
 * index only carries discovery keys); unresolved or active referents protect the receipt.
 */
async function protectedReason(
  entry: Readonly<RequestIndexEntry>,
  harness: Harness,
  unresolvedResources: ReadonlySet<string>,
): Promise<string | undefined> {
  if (!isReceiptFamily(entry.family)) return 'unindexed';
  const receipt = await loadReceipt(entry.family, entry.receiptKey, harness);
  if (receipt === undefined) return 'missingReceipt';
  switch (entry.family) {
    case 'point.command.chat-create':
    case 'point.command.profile':
      return undefined;
    case 'point.conversation.command':
    case 'point.command.compact': {
      const taskId = (receipt as {taskId?: unknown}).taskId;
      if (typeof taskId !== 'number' || !Number.isSafeInteger(taskId) || taskId <= 0) return 'referenced';
      const task = await harness.getTask(Number(taskId) as TaskId, context);
      if (task === undefined) return undefined;
      return task.state.status === 'terminal' ? undefined : 'attempting';
    }
    case 'point.command.job': {
      const result = (receipt as {result?: {jobId?: unknown} | null}).result;
      const jobId = result?.jobId;
      if (typeof jobId !== 'string') return 'referenced';
      const job = await harness.snapshot(Jobs, jobId, context);
      if (job === undefined) return undefined;
      if (job.status === 'queued' || job.status === 'running') return 'active';
      const attempt = job.currentAttemptId === null
        ? undefined : await harness.snapshot(Attempts, job.currentAttemptId, context);
      if (attempt !== undefined && (attempt.status === 'queued' || attempt.status === 'running')) return 'attempting';
      return undefined;
    }
    case 'point.command.followup': {
      const result = (receipt as {result?: {scheduleId?: unknown} | null}).result;
      const scheduleId = result?.scheduleId;
      if (typeof scheduleId !== 'string') return 'referenced';
      const schedule = await harness.snapshot(Schedules, scheduleId, context);
      return schedule === undefined || schedule.status !== 'active' ? undefined : 'active';
    }
    case 'point.resource-command': {
      // The receipt key is `(resourceId, requestId)`; unresolved operations for the resource protect it.
      // Key shape: `<resourceId.length>:<resourceId>/<requestId.length>:<requestId>`.
      const raw = entry.receiptKey;
      const colon = raw.indexOf(':');
      if (colon < 0) return 'referenced';
      const length = Number(raw.slice(0, colon));
      if (!Number.isSafeInteger(length) || length < 1) return 'referenced';
      const resourceId = raw.slice(colon + 1, colon + 1 + length);
      if (resourceId === '') return 'referenced';
      return unresolvedResources.has(resourceId) ? 'unknown' : undefined;
    }
    default:
      return 'unindexed';
  }
}

/** Resource ids that still have an `attempting`/`unknown` operation (protect their request receipts). */
async function unresolvedResourceIds(scan: SessionDocumentScanner): Promise<Set<string>> {
  const unresolved = new Set<string>();
  for (const document of await scan('point.resource-operation')) {
    const value = document.value as {value?: {resourceId?: unknown; state?: unknown} | null};
    const operation = value.value;
    if (!operation || typeof operation.resourceId !== 'string') continue;
    if (operation.state === 'attempting' || operation.state === 'unknown') unresolved.add(operation.resourceId);
  }
  return unresolved;
}

export type EventRebuildResult = Readonly<{removed: number; appended: number}>;

const JOB_EVENT: Readonly<Record<string, ProductEventType>> = {
  queued: 'job.started', running: 'job.running', ready: 'job.ready', failed: 'job.failed', cancelled: 'job.cancelled',
};

/**
 * Rebuild the product event timeline from current entity state. Events are derived facts: this command may
 * retire the existing timeline and re-append a current-state snapshot without changing any product state.
 */
export async function rebuildEventTimeline(
  deps: ReceiptCleanupDeps, options: Readonly<{replace?: boolean}> = {},
): Promise<EventRebuildResult> {
  const harness = deps.getHarness();
  const now = (deps.now ?? Date.now)();
  const append: Array<Parameters<typeof appendEvent>[1]> = [];
  for (const document of await deps.scan('point.chat')) {
    const value = document.value as {id?: unknown; name?: unknown};
    append.push({type: 'chat.created', aggregate: 'chat', aggregateId: document.key, revision: 0, at: now,
      data: {name: typeof value.name === 'string' ? value.name : ''}});
  }
  for (const document of await deps.scan('point.job')) {
    const value = document.value as {revision?: unknown; status?: unknown};
    if (typeof value.status !== 'string') continue;
    append.push({type: JOB_EVENT[value.status] ?? 'job.started', aggregate: 'job', aggregateId: document.key,
      revision: typeof value.revision === 'number' ? value.revision : 0, at: now, data: {status: value.status}});
  }
  for (const document of await deps.scan('point.memory')) {
    append.push({type: 'memory.saved', aggregate: 'memory', aggregateId: document.key, revision: 1, at: now});
  }
  for (const document of await deps.scan('point.resource')) {
    const envelope = document.value as {present?: unknown; value?: {state?: unknown; revision?: unknown}};
    if (envelope.present !== true || envelope.value === undefined) continue;
    append.push({type: 'resource.updated', aggregate: 'resource', aggregateId: document.key,
      revision: typeof envelope.value.revision === 'number' ? envelope.value.revision : 0, at: now,
      data: {state: typeof envelope.value.state === 'string' ? envelope.value.state : ''}});
  }
  for (const document of await deps.scan('point.artifact')) {
    const value = document.value as {state?: unknown; revision?: unknown};
    if (value.state !== 'sealed') continue;
    append.push({type: 'artifact.sealed', aggregate: 'artifact', aggregateId: document.key,
      revision: typeof value.revision === 'number' ? value.revision : 0, at: now});
  }
  for (const document of await deps.scan('point.schedule')) {
    const value = document.value as {status?: unknown; revision?: unknown};
    if (value.status !== 'active') continue;
    append.push({type: 'schedule.created', aggregate: 'schedule', aggregateId: document.key,
      revision: typeof value.revision === 'number' ? value.revision : 0, at: now});
  }
  const existing = options.replace === false ? [] : await deps.scan('point.event');
  await harness.commit(async tx => {
    for (const document of existing) await tx.retireDoc(Events, document.key);
    for (const event of append) await appendEvent(tx, event);
  }, context);
  return {removed: options.replace === false ? 0 : existing.length, appended: append.length};
}


type Candidate = {
  entry: RequestIndexEntry;
  receipt: ReceiptValue;
  job?: ReceiptValue;
  attempt?: ReceiptValue;
  schedule?: ReceiptValue;
  operation?: ReceiptValue;
};

function resultOf(receipt: ReceiptValue): ReceiptValue | undefined {
  const value = receipt.result;
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ReceiptValue : undefined;
}

function resourceIdFromReceiptKey(receiptKey: string): string | undefined {
  // Key shape: `<resourceId.length>:<resourceId>/<requestId.length>:<requestId>`.
  const colon = receiptKey.indexOf(':');
  if (colon < 0) return undefined;
  const length = Number(receiptKey.slice(0, colon));
  if (!Number.isSafeInteger(length) || length < 1) return undefined;
  const resourceId = receiptKey.slice(colon + 1, colon + 1 + length);
  return resourceId === '' ? undefined : resourceId;
}

/** Pre-load the receipt and every entity its protection decision depends on (outside the commit). */
async function preloadCandidate(
  entry: Readonly<RequestIndexEntry>, harness: Harness, unresolved: ReadonlySet<string>,
): Promise<{candidate?: Candidate; reason?: string}> {
  if (!isReceiptFamily(entry.family)) return {reason: 'unindexed'};
  const receipt = await loadReceipt(entry.family, entry.receiptKey, harness);
  if (receipt === undefined) return {reason: 'missingReceipt'};
  const candidate: Candidate = {entry, receipt};
  if (entry.family === 'point.command.chat-create' || entry.family === 'point.command.profile') {
    return {candidate};
  }
  if (entry.family === 'point.conversation.command' || entry.family === 'point.command.compact') {
    if (typeof receipt.taskId !== 'number' || !Number.isSafeInteger(receipt.taskId) || receipt.taskId <= 0) {
      return {reason: 'referenced'};
    }
    return {candidate};
  }
  if (entry.family === 'point.command.job') {
    const jobId = resultOf(receipt)?.jobId;
    if (typeof jobId !== 'string') return {reason: 'referenced'};
    const job = await harness.snapshot(Jobs, jobId, context);
    if (job === undefined) return {reason: 'referenced'};
    candidate.job = job as unknown as ReceiptValue;
    if (typeof job.currentAttemptId === 'string') {
      const attempt = await harness.snapshot(Attempts, job.currentAttemptId, context);
      if (attempt !== undefined) candidate.attempt = attempt as unknown as ReceiptValue;
    }
    return {candidate};
  }
  if (entry.family === 'point.command.followup') {
    const scheduleId = resultOf(receipt)?.scheduleId;
    if (typeof scheduleId !== 'string') return {reason: 'referenced'};
    const schedule = await harness.snapshot(Schedules, scheduleId, context);
    if (schedule !== undefined) candidate.schedule = schedule as unknown as ReceiptValue;
    return {candidate};
  }
  // point.resource-command
  const resourceId = resourceIdFromReceiptKey(entry.receiptKey);
  if (resourceId === undefined) return {reason: 'referenced'};
  const operationId = resultOf(receipt)?.id;
  if (typeof operationId === 'string') {
    const operation = await harness.snapshot(ResourceOperations, operationId, context);
    if (operation !== undefined) candidate.operation = operation as unknown as ReceiptValue;
  }
  if (candidate.operation !== undefined) {
    const state = (candidate.operation.value as {state?: unknown} | null | undefined)?.state;
    if (state === 'attempting') return {reason: 'attempting'};
    if (state === 'unknown') return {reason: 'unknown'};
  }
  if (unresolved.has(resourceId)) return {reason: 'unknown'};
  return {candidate};
}

/** Protection review against the live committed state, called inside the deleting commit. */
async function protectionInTx(tx: Tx, candidate: Readonly<Candidate>): Promise<string | undefined> {
  const {entry} = candidate;
  if (entry.family === 'point.command.chat-create' || entry.family === 'point.command.profile') return undefined;
  if (entry.family === 'point.conversation.command' || entry.family === 'point.command.compact') {
    const taskId = candidate.receipt.taskId;
    if (typeof taskId !== 'number' || !Number.isSafeInteger(taskId) || taskId <= 0) return 'referenced';
    const task = await tx.task(taskId as TaskId);
    return task === undefined || task.state.status === 'terminal' ? undefined : 'attempting';
  }
  if (entry.family === 'point.command.job') {
    if (candidate.job === undefined) return 'referenced';
    const job = await tx.doc(Jobs, String(candidate.job.id), candidate.job as unknown as Job);
    if (job.status === 'queued' || job.status === 'running') return 'active';
    if (job.currentAttemptId === null) return undefined;
    const attemptSeed = candidate.attempt as unknown as Attempt | undefined;
    const attempt = await tx.doc(Attempts, job.currentAttemptId, attemptSeed ?? ({} as Attempt));
    return attempt.status === 'queued' || attempt.status === 'running' ? 'attempting' : undefined;
  }
  if (entry.family === 'point.command.followup') {
    const scheduleId = resultOf(candidate.receipt)?.scheduleId;
    if (typeof scheduleId !== 'string') return 'referenced';
    if (candidate.schedule === undefined) return undefined;
    const schedule = await tx.doc(Schedules, scheduleId, candidate.schedule as unknown as Schedule);
    return schedule.status === 'active' ? 'active' : undefined;
  }
  if (entry.family === 'point.resource-command') {
    const resourceId = resourceIdFromReceiptKey(entry.receiptKey);
    if (resourceId === undefined) return 'referenced';
    const operationId = resultOf(candidate.receipt)?.id;
    if (typeof operationId === 'string') {
      const operation = await tx.doc(ResourceOperations, operationId, ABSENT_OPERATION);
      const state = operation.value?.state;
      if (state === 'attempting') return 'attempting';
      if (state === 'unknown') return 'unknown';
    }
    return undefined;
  }
  return 'unindexed';
}

let cleanupChain: Promise<unknown> = Promise.resolve();

/**
 * Bounded request-ledger cleanup. Candidates are discovered outside the commit, but every reference is
 * re-validated against the committed state inside the deleting transaction, so a concurrent state change
 * can never remove a currently referenced receipt. Cleanup runs are serialized in-process (the server is a
 * single writer); cross-process concurrency is prevented by the directory owner lock.
 */
export async function cleanupReceipts(
  deps: ReceiptCleanupDeps, options: ReceiptCleanupOptions = {},
): Promise<ReceiptCleanupResult> {
  const run = async (): Promise<ReceiptCleanupResult> => cleanupOnce(deps, options);
  const next = cleanupChain.then(run, run);
  cleanupChain = next.catch(() => undefined);
  return next;
}

async function cleanupOnce(
  deps: ReceiptCleanupDeps, options: ReceiptCleanupOptions,
): Promise<ReceiptCleanupResult> {
  const now = options.now ?? deps.now ?? Date.now;
  const keepMs = options.keepMs ?? DEFAULT_RECEIPT_KEEP_MS;
  const keepCount = options.keepCount ?? DEFAULT_RECEIPT_KEEP_COUNT;
  if (!Number.isSafeInteger(keepMs) || keepMs < 0) throw new Error('INVALID_CLEANUP_OPTIONS');
  if (!Number.isSafeInteger(keepCount) || keepCount < 0) throw new Error('INVALID_CLEANUP_OPTIONS');
  const timestamp = now();
  const harness = deps.getHarness();
  const reasons = emptyReasons();
  const bump = (key: string): void => { reasons[key] = (reasons[key] ?? 0) + 1; };
  const entries: RequestIndexEntry[] = [];
  for (const document of await deps.scan('point.requests')) {
    const value = document.value as Partial<RequestIndexEntry>;
    if (typeof value.family !== 'string' || typeof value.receiptKey !== 'string'
      || typeof value.createdAt !== 'number' || typeof value.terminal !== 'boolean') {
      bump('unindexed');
      continue;
    }
    entries.push(value as RequestIndexEntry);
  }
  entries.sort(compareOldest);
  const unresolved = await unresolvedResourceIds(deps.scan);
  const protectNewest = keepCount > 0
    ? new Set(entries.slice(-keepCount).map(pageKey))
    : new Set<string>();

  const candidates: Candidate[] = [];
  let kept = 0;
  for (const entry of entries) {
    if (protectNewest.has(entry.key)) { bump('protectedNewest'); kept += 1; continue; }
    if (timestamp - entry.createdAt <= keepMs) { bump('young'); kept += 1; continue; }
    if (candidates.length >= MAX_RECEIPTS_PER_CLEANUP) { bump('limit'); kept += 1; continue; }
    let loaded;
    try {
      loaded = await preloadCandidate(entry, harness, unresolved);
    } catch {
      bump('error'); kept += 1; continue;
    }
    if (loaded.candidate === undefined) { bump(loaded.reason ?? 'error'); kept += 1; continue; }
    candidates.push(loaded.candidate);
  }

  if (options.dryRun) {
    return {
      scanned: entries.length, removed: 0, kept: kept + candidates.length, dryRun: true, reasons,
      removedKeys: candidates.map(candidate => candidate.entry.key),
    };
  }

  const removedKeys: string[] = [];
  if (candidates.length > 0) {
    await harness.commit(async tx => {
      for (const candidate of candidates) {
        let reason: string | undefined;
        try {
          reason = await protectionInTx(tx, candidate);
        } catch {
          reason = 'error';
        }
        if (reason !== undefined) { bump(reason); kept += 1; continue; }
        await retireReceipt(tx, candidate.entry.family, candidate.entry.receiptKey);
        await tx.retireDoc(RequestsIndex, candidate.entry.key);
        removedKeys.push(candidate.entry.key);
      }
    }, context);
  }
  return {
    scanned: entries.length, removed: removedKeys.length, kept: kept + candidates.length - removedKeys.length,
    dryRun: false, reasons, removedKeys,
  };
}
