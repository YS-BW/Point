/**
 * Bounded request-ledger cleanup (WP3).
 *
 * Cleanup is an explicit command over the `point.requests` discovery index. It removes only receipts
 * that are (a) older than the retention window, (b) outside the protected most-recent `keepCount`
 * window, and (c) no longer referenced by an active/attempting/unresolved record. Anything it cannot
 * prove terminal is kept and reported with a reason; the operation is fail-closed.
 */

import type { Harness, TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Attempts, JobCommandReceipts, Jobs } from '../storage/job.js';
import { CreateChatReceipts } from '../storage/chats.js';
import { ProfileReceipts } from '../storage/profile.js';
import { FollowupCommandReceipts, Schedules } from '../storage/schedule.js';
import { ResourceCommandReceipts, ResourceOperations } from '../storage/resource.js';
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

/** Bounded request-ledger cleanup helper; exported below as `cleanupReceipts`. */
export async function cleanupReceipts(
  deps: ReceiptCleanupDeps, options: ReceiptCleanupOptions = {},
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
  const removals: RequestIndexEntry[] = [];
  let kept = 0;
  for (const entry of entries) {
    const key = pageKey(entry);
    if (protectNewest.has(key)) { bump('protectedNewest'); kept += 1; continue; }
    if (timestamp - entry.createdAt <= keepMs) { bump('young'); kept += 1; continue; }
    let reason: string | undefined;
    try {
      reason = await protectedReason(entry, harness, unresolved);
    } catch {
      reason = 'error';
    }
    if (reason !== undefined) { bump(reason); kept += 1; continue; }
    if (removals.length >= MAX_RECEIPTS_PER_CLEANUP) { bump('limit'); kept += 1; continue; }
    removals.push(entry);
  }

  const removedKeys = removals.map(pageKey);
  if (!options.dryRun && removals.length > 0) {
    await harness.commit(async tx => {
      for (const entry of removals) {
        await retireReceipt(tx, entry.family, entry.receiptKey);
        await tx.retireDoc(RequestsIndex, entry.key);
      }
    }, context);
  }
  return {
    scanned: entries.length,
    removed: options.dryRun ? 0 : removals.length,
    kept,
    dryRun: options.dryRun === true,
    reasons,
    removedKeys,
  };
}
