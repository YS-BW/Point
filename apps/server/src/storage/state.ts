/**
 * Product state format v2 document families (WP3).
 *
 * The product state format lives in `point.meta` (`format: 2`). v2 keeps the existing per-entity
 * document families authoritative (chats/jobs/attempts/deliveries/schedules/artifacts/resources) and
 * adds the sharded read-side families frozen by the WP3 contract:
 *
 * - `point.chats` / `point.jobs` / `point.resources`: minimal indexes over existing entities;
 *   the WP3 roadmap shard name `browser` is realized as `point.resources` on purpose: the WP2
 *   resource model is capability-generic and must not encode a browser-only abstraction;
 * - `point.memory`: one document per explicitly saved profile entry (replaces the single
 *   `point.profile` map, which stays read-only for legacy/export purposes after migration);
 * - `point.requests`: request-ledger index used by bounded receipt cleanup;
 * - `point.event`: rebuildable product-event timeline, appended in the same commit as the state
 *   change it describes.
 *
 * Indexes and events are derived facts, never a second source of truth: every value here can be
 * rebuilt from the entity documents.
 */

import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import type { ProfileEntry, ProfileKind } from '../domain/profile.js';

/** Supported product state format written by this runtime. */
export const PRODUCT_STATE_FORMAT = 2 as const;
/** Engine identity persisted with the product format (must match the pinned Durable version). */
export const PRODUCT_STATE_ENGINE = 'pi-durable@1.3.0' as const;

export type StateMetaV2 = {
  format: number;
  engine: string;
  instanceId: string;
  /** Wall-clock milliseconds of the v1 -> v2 migration; 0 for a database created directly as v2. */
  migratedAt: number;
};

/** The only authority for the product state format. */
export const MetaV2 = defineDoc({
  kind: 'point.meta', version: 1, scope: 'session',
  initial: (): StateMetaV2 => ({
    format: PRODUCT_STATE_FORMAT, engine: PRODUCT_STATE_ENGINE, instanceId: '', migratedAt: 0,
  }),
});

/** Minimal chat index: identity, display name, revision and ordering fields only. */
export type ChatIndexEntry = Readonly<{
  id: string;
  name: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}>;

export const ChatsIndex = defineDocFamily({
  kind: 'point.chats', version: 1, scope: 'session', family: true,
  initial: (entry: ChatIndexEntry) => ({...entry}),
});

/** Minimal job index: the fields a state projection needs without loading the Job itself. */
export type JobIndexEntry = Readonly<{
  id: string;
  revision: number;
  status: string;
  updatedAt: number;
}>;

export const JobsIndex = defineDocFamily({
  kind: 'point.jobs', version: 1, scope: 'session', family: true,
  initial: (entry: JobIndexEntry) => ({...entry}),
});

/** Capability-generic resource index: owner, lease and control revision without the resource payload. */
export type ResourceIndexEntry = Readonly<{
  id: string;
  owner: string | null;
  state: string;
  controlEpoch: number;
  revision: number;
  leaseExpiresAt: number | null;
  updatedAt: number;
}>;

export const ResourcesIndex = defineDocFamily({
  kind: 'point.resources', version: 1, scope: 'session', family: true,
  initial: (entry: ResourceIndexEntry) => ({...entry}),
});

/**
 * Request-ledger index entry. `family` is the receipt document kind, `key` its family key, and
 * `referencedId` the entity the receipt protects (if any). A receipt may only be cleaned when the
 * entry is terminal and its referenced entity is not live/attempting/unknown.
 */
export type RequestIndexEntry = Readonly<{
  /** `${family}:${key}` — stable index key. */
  key: string;
  /** Receipt document kind (e.g. `point.command.job`). */
  family: string;
  /** Receipt family member key. */
  receiptKey: string;
  /** Entity the receipt refers to, when the receipt shape exposes one. */
  referencedId: string | null;
  /** Whether the receipt's business outcome is already terminal. */
  terminal: boolean;
  createdAt: number;
}>;

export const RequestsIndex = defineDocFamily({
  kind: 'point.requests', version: 1, scope: 'session', family: true,
  initial: (entry: RequestIndexEntry) => ({...entry}),
});

export function requestIndexKey(family: string, receiptKey: string): string {
  return `${family}:${receiptKey}`;
}

/** One explicitly saved memory entry; the profile key is the family key. */
export type MemoryDocument = Readonly<{
  key: string;
  value: string;
  kind: ProfileKind;
  sourceChatId: string;
  revision: number;
  updatedAt: number;
}>;

export const Memory = defineDocFamily({
  kind: 'point.memory', version: 1, scope: 'session', family: true,
  initial: (entry: MemoryDocument) => ({...entry}),
});

export function memoryDocument(entry: ProfileEntry, revision: number): MemoryDocument {
  return {
    key: entry.key,
    value: entry.value,
    kind: entry.kind,
    sourceChatId: entry.sourceChatId,
    revision,
    updatedAt: entry.updatedAt,
  };
}

export function memoryEntry(document: Readonly<MemoryDocument>): ProfileEntry {
  return {
    key: document.key,
    value: document.value,
    kind: document.kind,
    sourceChatId: document.sourceChatId,
    updatedAt: document.updatedAt,
  };
}

/** Product-visible event. Data is bounded, already-redacted JSON; it never replaces entity state. */
export type ProductEvent = Readonly<{
  id: string;
  type: string;
  /** Aggregate family, e.g. `chat`, `job`, `schedule`, `delivery`. */
  aggregate: string;
  aggregateId: string;
  revision: number;
  at: number;
  data: Readonly<Record<string, string | number | boolean | null>> | null;
}>;

export const Events = defineDocFamily({
  kind: 'point.event', version: 1, scope: 'session', family: true,
  initial: (event: ProductEvent) => ({...event, data: event.data === null ? null : {...event.data}}),
});

/** Validate the persisted v2 meta shape; unknown/newer formats are refused, never migrated implicitly. */
export function assertStateMetaV2(meta: Readonly<StateMetaV2>): void {
  if (meta.format !== PRODUCT_STATE_FORMAT || meta.engine !== PRODUCT_STATE_ENGINE
    || typeof meta.instanceId !== 'string' || !meta.instanceId.trim()) {
    throw new Error('UNSUPPORTED_DATA_FORMAT');
  }
}
