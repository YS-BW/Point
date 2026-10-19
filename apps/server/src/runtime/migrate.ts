/**
 * v1 -> v2 product state migration (WP3).
 *
 * Order is fixed by the contract:
 *   1. acquire the single-writer owner lock and run the SDK storage preflight;
 *   2. detect the product format without writing;
 *   3. create a verified online SQLite snapshot (`backups/pre-migration-<ts>.sqlite`, no WAL copy);
 *   4. rewrite every v2-relevant document, build the read-side indexes, copy profile entries into
 *      `point.memory`, retire the legacy metadata/profile singletons and append one `state.migrated`
 *      event — all in exactly one Durable commit.
 *
 * Any failure before the commit leaves the database at format 1. A re-run after a pre-commit crash is
 * safe; after a post-commit crash the format is already 2 and the command reports `already-migrated`
 * without another backup or rewrite.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import type { JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  Harness, createRegistry,
  type Cursor, type JsonObject, type SessionDocFamilyToken, type Tx,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { acquireOwner } from '../storage/owner.js';
import { preflightStorage } from '../storage/preflight.js';
import { Meta } from '../storage/meta.js';
import {
  Memory, MetaV2, memoryDocument, type MemoryDocument, type StateMetaV2,
} from '../storage/state.js';
import { Chats, CreateChatReceipts, type ChatDocument } from '../storage/chats.js';
import { Attempts, JobCommandReceipts, Jobs } from '../storage/job.js';
import { Artifacts } from '../storage/artifact.js';
import { Deliveries } from '../storage/delivery.js';
import { Profile, ProfileReceipts } from '../storage/profile.js';
import { Decisions, FollowupCommandReceipts, Occurrences, Schedules } from '../storage/schedule.js';
import {
  ResourceCommandReceipts, ResourceOperationRequests, ResourceOperations, Resources,
  type ResourceDocument, type ResourceValue,
} from '../storage/resource.js';
import { CommandHead, CommandReceipts, CompactReceipts, ModelCalls } from '../storage/conversation.js';
import type { Job } from '../domain/job.js';
import type { ProfileEntry } from '../domain/profile.js';
import { appendEvent } from './events.js';
import { indexReceipt, writeChatIndex, writeJobIndex, writeResourceIndex } from './state-index.js';

export class MigrationError extends Error {
  constructor(readonly code:
    | 'MIGRATION_BACKUP_FAILED'
    | 'MIGRATION_FAILED'
    | 'MIGRATION_INCOMPATIBLE', options?: {cause?: unknown}) {
    super(options?.cause instanceof Error ? `${code}: ${options.cause.message}` : code, options);
    this.name = 'MigrationError';
  }
}

export type MigrationCounts = Readonly<{
  chats: number;
  jobs: number;
  attempts: number;
  deliveries: number;
  schedules: number;
  occurrences: number;
  decisions: number;
  artifacts: number;
  resources: number;
  operations: number;
  memory: number;
  receipts: number;
}>;
type MutableCounts = {-readonly [K in keyof MigrationCounts]: number};

export type MigrationResult =
  | Readonly<{status: 'already-migrated'; instanceId: string}>
  | Readonly<{status: 'initialized'; instanceId: string}>
  | Readonly<{
    status: 'migrated';
    instanceId: string;
    migratedAt: number;
    backupPath: string;
    backupBytes: number;
    counts: MigrationCounts;
  }>;

export type MigrationOptions = Readonly<{
  /** Backup directory; defaults to `<dataDir>/backups`. */
  backupDir?: string;
  /** Clock injection for fixtures/tests; defaults to `Date.now`. */
  now?: () => number;
  /** Test-only fault injection: runs inside the migration commit before it returns. */
  beforeCommit?: (tx: Tx) => void | Promise<void>;
  /** Test-only fault injection: runs after the migration commit is durable. */
  afterCommit?: () => void | Promise<void>;
}>;

type Scanned = Readonly<{key: string; value: Readonly<Record<string, unknown>>}>;
type StorageHandle = Awaited<ReturnType<typeof openNodeSqliteStorage>>;

async function scanKind(storage: StorageHandle, kind: string): Promise<Scanned[]> {
  const items: Scanned[] = [];
  let cursor: Cursor | undefined;
  for (;;) {
    const page = await storage.scanDocuments(
      {scope: {kind: 'session'}, at: 'current', kind}, 200, cursor, context);
    for (const record of page.items) {
      const document = await storage.document(record.id, 'current', context);
      if (document === undefined || document.record.key === undefined) continue;
      items.push({key: document.record.key, value: document.value});
    }
    if (page.next === undefined) break;
    cursor = page.next;
  }
  return items;
}

async function backupDatabase(path: string, backupDir: string, at: number): Promise<{path: string; bytes: number}> {
  try {
    await mkdir(backupDir, {recursive: true, mode: 0o700});
  } catch {
    throw new MigrationError('MIGRATION_BACKUP_FAILED');
  }
  let candidate = join(backupDir, `pre-migration-${at}.sqlite`);
  for (let suffix = 1; ; suffix += 1) {
    try {
      await stat(candidate);
      candidate = join(backupDir, `pre-migration-${at}-${suffix}.sqlite`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break;
    }
  }
  try {
    // Node's SQLite online-backup API: a consistent snapshot without copying WAL files.
    const source = new DatabaseSync(path, {readOnly: true});
    try {
      await backup(source, candidate);
    } finally {
      source.close();
    }
    // Verify the snapshot is self-contained and intact; normalize away any WAL sidecars.
    const target = new DatabaseSync(candidate);
    try {
      const integrity = target.prepare('PRAGMA integrity_check').get() as {integrity_check?: unknown};
      if (integrity.integrity_check !== 'ok') throw new Error('BACKUP_INTEGRITY_FAILED');
      target.prepare('PRAGMA journal_mode=DELETE').get();
    } finally {
      target.close();
    }
    return {path: candidate, bytes: (await stat(candidate)).size};
  } catch {
    throw new MigrationError('MIGRATION_BACKUP_FAILED');
  }
}

function emptyCounts(): MutableCounts {
  return {
    chats: 0, jobs: 0, attempts: 0, deliveries: 0, schedules: 0, occurrences: 0,
    decisions: 0, artifacts: 0, resources: 0, operations: 0, memory: 0, receipts: 0,
  };
}

/** Load/validate every current member of one family through its v2 token (may rewrite a base version). */
async function touchFamily<T extends JsonObject, I extends JsonValue>(
  tx: Tx, token: SessionDocFamilyToken<T, I>, documents: readonly Scanned[],
  counts: MutableCounts, field: keyof MigrationCounts,
): Promise<void> {
  for (const document of documents) {
    await tx.doc(token, document.key, document.value as unknown as I);
    counts[field] += 1;
  }
}

/**
 * Migrate the v1 product state at `dataDir` to format 2. Idempotent; never resumes the scheduler and
 * never tolerates a concurrent writer (owner lock). The backup is created before any write.
 */
export async function migrateRuntime(dataDir: string, options: MigrationOptions = {}): Promise<MigrationResult> {
  const now = options.now ?? Date.now;
  const release = acquireOwner(join(dataDir, 'owner.sqlite'));
  let storage: StorageHandle | undefined;
  let harness: Harness | undefined;
  try {
    const path = join(dataDir, 'state.sqlite');
    await preflightStorage(path);
    storage = await openNodeSqliteStorage(path);
    const storageHandle = storage;
    const populated = (await storage.scanConversations({}, 1, undefined, context)).items.length > 0
      || (await storage.scanDocuments({scope: {kind: 'session'}, at: 'current'}, 1, undefined, context)).items.length > 0
      || (await storage.scanTasks({}, 1, undefined, context)).items.length > 0;
    harness = await Harness.open(storage, {models: createModels(), registry: createRegistry()}, context);
    const currentMeta = await harness.snapshot(MetaV2, context) as StateMetaV2 | undefined;
    const legacyMeta = await harness.snapshot(Meta, context);
    if (currentMeta !== undefined) {
      if (legacyMeta !== undefined || currentMeta.format !== 2) throw new MigrationError('MIGRATION_INCOMPATIBLE');
      return {status: 'already-migrated', instanceId: currentMeta.instanceId};
    }
    if (legacyMeta === undefined) {
      if (populated) throw new MigrationError('MIGRATION_INCOMPATIBLE');
      // A fresh database: initialize it directly as v2, matching openRuntime's fresh path.
      const instanceId = randomUUID();
      await harness.root(context, {init: async tx => {
        const meta = await tx.doc(MetaV2);
        meta.instanceId = instanceId;
        meta.migratedAt = 0;
      }});
      return {status: 'initialized', instanceId};
    }
    if (legacyMeta.format !== 1 || legacyMeta.engine !== 'pi-durable@1.3.0'
      || typeof legacyMeta.instanceId !== 'string' || !legacyMeta.instanceId.trim()) {
      throw new MigrationError('MIGRATION_INCOMPATIBLE');
    }

    // Enumerate every current v1 document before the commit (a commit callback may only use `tx`).
    const kinds = [
      'point.chat', 'point.job', 'point.attempt', 'point.delivery', 'point.schedule',
      'point.occurrence', 'point.decision', 'point.artifact', 'point.resource',
      'point.resource-operation', 'point.resource-operation-request', 'point.resource-command',
      'point.command.chat-create', 'point.command.profile',
      'point.conversation.command', 'point.command.compact', 'point.command.job',
      'point.command.followup', 'point.conversation.command-head', 'point.model-call',
    ] as const;
    const scanned = new Map<string, Scanned[]>();
    for (const kind of kinds) scanned.set(kind, await scanKind(storageHandle, kind));
    const docs = (kind: typeof kinds[number]) => scanned.get(kind) ?? [];

    const at = now();
    const backupDir = options.backupDir ?? join(dataDir, 'backups');
    const snapshot = await backupDatabase(path, backupDir, at);
    const counts = emptyCounts();
    const legacyProfile = await harness.snapshot(Profile, context);

    try {
      await harness.commit(async tx => {
        const meta = await tx.doc(MetaV2);
        meta.instanceId = legacyMeta.instanceId;
        meta.migratedAt = at;
        await tx.retireDoc(Meta);

        // v1 -> v2 entity version bumps: the same commit rewrites their base content.
        for (const {key, value} of docs('point.chat')) {
          const legacy = value as {id?: unknown; name?: unknown; createdAt?: unknown};
          const seed: ChatDocument = {
            id: typeof legacy.id === 'string' ? legacy.id : key,
            name: typeof legacy.name === 'string' ? legacy.name : '',
            createdAt: typeof legacy.createdAt === 'number' ? legacy.createdAt : 0,
          };
          const chat = await tx.doc(Chats, key, seed);
          counts.chats += 1;
          await writeChatIndex(tx, chat, chat.createdAt);
        }
        for (const {key, value} of docs('point.job')) {
          const job = await tx.doc(Jobs, key, value as unknown as Job);
          counts.jobs += 1;
          await writeJobIndex(tx, job);
        }
        await touchFamily(tx, Attempts, docs('point.attempt'), counts, 'attempts');
        await touchFamily(tx, Deliveries, docs('point.delivery'), counts, 'deliveries');
        await touchFamily(tx, Schedules, docs('point.schedule'), counts, 'schedules');
        await touchFamily(tx, Occurrences, docs('point.occurrence'), counts, 'occurrences');
        await touchFamily(tx, Decisions, docs('point.decision'), counts, 'decisions');
        await touchFamily(tx, Artifacts, docs('point.artifact'), counts, 'artifacts');
        await touchFamily(tx, ModelCalls, docs('point.model-call'), counts, 'receipts');
        await touchFamily(tx, CommandHead, docs('point.conversation.command-head'), counts, 'receipts');

        // Resources keep their envelope; only the read-side index is new.
        for (const {key, value} of docs('point.resource')) {
          const document = await tx.doc(Resources, key, value as unknown as ResourceDocument);
          counts.resources += 1;
          if (document.present && document.value !== null) {
            await writeResourceIndex(tx, document.value as unknown as ResourceValue);
          }
        }
        await touchFamily(tx, ResourceOperations, docs('point.resource-operation'), counts, 'operations');
        await touchFamily(tx, ResourceOperationRequests, docs('point.resource-operation-request'), counts, 'receipts');
        await touchFamily(tx, ResourceCommandReceipts, docs('point.resource-command'), counts, 'receipts');

        // Profile map -> one `point.memory` document per entry, then retire the single map.
        if (legacyProfile?.entries !== undefined) {
          for (const entry of Object.values(legacyProfile.entries)) {
            await tx.doc(Memory, entry.key, memoryDocument(entry, 1));
            counts.memory += 1;
          }
        }
        await tx.retireDoc(Profile);

        // Request-ledger backfill: discovery index for bounded cleanup. The cleanup command resolves
        // references from the receipt documents themselves, so migration only has to index keys.
        const receiptFamilies: ReadonlyArray<readonly [string, readonly Scanned[]]> = [
          ['point.command.chat-create', docs('point.command.chat-create')],
          ['point.command.profile', docs('point.command.profile')],
          ['point.conversation.command', docs('point.conversation.command')],
          ['point.command.compact', docs('point.command.compact')],
          ['point.command.job', docs('point.command.job')],
          ['point.command.followup', docs('point.command.followup')],
          ['point.resource-command', docs('point.resource-command')],
        ];
        for (const [family, documents] of receiptFamilies) {
          for (const document of documents) {
            await indexReceipt(tx, {family, receiptKey: document.key, terminal: false, createdAt: at});
            counts.receipts += 1;
          }
        }
        // Validate the remaining unchanged receipt families through their tokens (no shape change).
        await touchFamily(tx, CreateChatReceipts, docs('point.command.chat-create'), counts, 'receipts');
        await touchFamily(tx, ProfileReceipts, docs('point.command.profile'), counts, 'receipts');
        await touchFamily(tx, CommandReceipts, docs('point.conversation.command'), counts, 'receipts');
        await touchFamily(tx, CompactReceipts, docs('point.command.compact'), counts, 'receipts');
        await touchFamily(tx, JobCommandReceipts, docs('point.command.job'), counts, 'receipts');
        await touchFamily(tx, FollowupCommandReceipts, docs('point.command.followup'), counts, 'receipts');

        // One bounded migration event: per-entity events would bloat large databases.
        await appendEvent(tx, {
          type: 'state.migrated', aggregate: 'state', aggregateId: 'v2', revision: 2, at,
          data: {
            chats: counts.chats, jobs: counts.jobs, attempts: counts.attempts, deliveries: counts.deliveries,
            schedules: counts.schedules, memory: counts.memory, resources: counts.resources,
            operations: counts.operations, receipts: counts.receipts, backupBytes: snapshot.bytes,
          },
        });
        await options.beforeCommit?.(tx);
      }, context);
    } catch (error) {
      if (error instanceof MigrationError) throw error;
      if (error instanceof Error && /requires migration from version|newer version/i.test(error.message)) {
        throw new MigrationError('MIGRATION_INCOMPATIBLE', {cause: error});
      }
      throw new MigrationError('MIGRATION_FAILED', {cause: error});
    }
    await options.afterCommit?.();
    return {
      status: 'migrated', instanceId: legacyMeta.instanceId, migratedAt: at,
      backupPath: snapshot.path, backupBytes: snapshot.bytes, counts,
    };
  } finally {
    try {
      if (harness !== undefined) await harness.close(context);
      else if (storage !== undefined) await storage.close(context);
    } finally {
      release();
    }
  }
}
