import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Harness } from '@earendil-works/pi-durable';
import type { ProfileStore } from '../application/profile.js';
import { MAX_PROFILE_ENTRIES, ProfileError, type ProfileEntry, type ProfileKind } from '../domain/profile.js';
import { Profile, ProfileReceipts } from '../storage/profile.js';
import {
  MEMORY_COUNTER_KEY, Memory, MemoryCounter, memoryEntry, type MemoryDocument,
} from '../storage/state.js';
import type { SessionDocumentScanner } from './schedules.js';
import { appendEvent } from './events.js';
import { indexReceipt } from './state-index.js';

type HarnessAccess = Pick<Harness, 'commit' | 'snapshot'>;

function fingerprint(command: object): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function sameKey(a: ProfileEntry, b: ProfileEntry): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Durable profile store (v2). Each explicitly saved entry is its own `point.memory` document, so the
 * old single `point.profile` map is no longer the write authority. The legacy map is still read as a
 * fallback for pre-migration read-only databases (migration copies it into `point.memory` and retires
 * it). Remember/forget receipt, memory document, counter, event and receipt index share one commit.
 *
 * Cap and existence are decided **inside the commit**: a pre-commit scan only bootstraps the counter
 * when it does not exist yet; once present, the counter is the authoritative same-transaction count.
 */
export function durableProfileStore(access: () => HarnessAccess, scan?: SessionDocumentScanner): ProfileStore {
  async function memoryDocuments(): Promise<MemoryDocument[]> {
    if (scan === undefined) return [];
    const documents: MemoryDocument[] = [];
    for (const document of await scan('point.memory')) {
      const value = document.value as Partial<MemoryDocument>;
      if (typeof value.key !== 'string' || value.key !== document.key || typeof value.value !== 'string') continue;
      documents.push(value as MemoryDocument);
    }
    return documents.sort((a, b) => sameKey(a, b));
  }

  async function legacyEntries(): Promise<ProfileEntry[]> {
    const profile = await access().snapshot(Profile, context);
    if (!profile) return [];
    return Object.values(profile.entries).map(entry => ({...entry}));
  }

  return {
    async remember(command) {
      const commandFingerprint = fingerprint(command);
      // Bootstrap seed only: used by `tx.doc` when the counter document does not exist yet. Every
      // existing counter is read and updated inside the commit below, so concurrent inserts serialize.
      const seedCount = (await memoryDocuments()).length;
      return access().commit(async tx => {
        const receipt = await tx.doc(ProfileReceipts, command.requestId, commandFingerprint);
        if (receipt.fingerprint !== commandFingerprint) throw new ProfileError('IDEMPOTENCY_CONFLICT');
        if (receipt.entry) return {...receipt.entry};
        const memory = await tx.doc(Memory, command.key, {
          key: command.key, value: '', kind: 'fact', sourceChatId: '', revision: -1, updatedAt: 0,
        });
        const existed = memory.revision !== -1;
        const counter = await tx.doc(MemoryCounter, MEMORY_COUNTER_KEY, seedCount);
        if (!existed && counter.count >= MAX_PROFILE_ENTRIES) throw new ProfileError('PROFILE_LIMIT_REACHED');
        const now = Date.now();
        const entry: ProfileEntry = {
          key: command.key,
          value: command.value,
          kind: command.kind as ProfileKind,
          sourceChatId: command.sourceChatId,
          updatedAt: now,
        };
        memory.value = entry.value;
        memory.kind = entry.kind;
        memory.sourceChatId = entry.sourceChatId;
        memory.updatedAt = entry.updatedAt;
        memory.revision = existed ? memory.revision + 1 : 1;
        if (!existed) counter.count += 1;
        receipt.entry = entry;
        await appendEvent(tx, {
          type: 'memory.saved', aggregate: 'memory', aggregateId: command.key, revision: memory.revision, at: now,
          data: {kind: entry.kind},
        });
        await indexReceipt(tx, {
          family: 'point.command.profile', receiptKey: command.requestId,
          referencedId: command.key, terminal: true, createdAt: now,
        });
        return {...entry};
      }, context);
    },
    async forget(command) {
      const commandFingerprint = fingerprint(command);
      const seedCount = (await memoryDocuments()).length;
      return access().commit(async tx => {
        const receipt = await tx.doc(ProfileReceipts, command.requestId, commandFingerprint);
        if (receipt.fingerprint !== commandFingerprint) throw new ProfileError('IDEMPOTENCY_CONFLICT');
        if (receipt.removed !== null) return {key: command.key, removed: receipt.removed};
        const now = Date.now();
        // Existence is read inside the transaction; an absent entry is probed with a sentinel draft that
        // is retired again in the same commit, so a miss never leaves a current document behind.
        const memory = await tx.doc(Memory, command.key, {
          key: command.key, value: '', kind: 'fact', sourceChatId: '', revision: -1, updatedAt: 0,
        });
        const removed = memory.revision !== -1;
        const counter = await tx.doc(MemoryCounter, MEMORY_COUNTER_KEY, seedCount);
        if (removed) {
          await tx.retireDoc(Memory, command.key);
          counter.count = Math.max(0, counter.count - 1);
        } else {
          await tx.retireDoc(Memory, command.key);
        }
        receipt.removed = removed;
        await appendEvent(tx, {
          type: 'memory.forgotten', aggregate: 'memory', aggregateId: command.key, revision: 0, at: now,
          data: {removed},
        });
        await indexReceipt(tx, {
          family: 'point.command.profile', receiptKey: command.requestId,
          referencedId: command.key, terminal: true, createdAt: now,
        });
        return {key: command.key, removed};
      }, context);
    },
    async list() {
      const memories = await memoryDocuments();
      if (memories.length > 0) return memories.map(memoryEntry);
      // Pre-migration read-only fallback: the legacy single map is still authoritative there.
      const legacy = await legacyEntries();
      return legacy.map(entry => ({...entry})).sort(sameKey);
    },
  };
}
