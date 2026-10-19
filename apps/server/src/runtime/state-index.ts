/**
 * v2 read-side index writers (WP3).
 *
 * Every index entry is written in the same transaction as the entity change it reflects. Indexes are
 * derived facts: migration rebuilds them from entity documents, and losing one must never change a
 * product decision.
 */

import type { Tx } from '@earendil-works/pi-durable';
import type { ResourceValue } from '../storage/resource.js';
import {
  ChatsIndex, JobsIndex, RequestsIndex, ResourcesIndex, requestIndexKey,
  type ChatIndexEntry, type JobIndexEntry, type RequestIndexEntry, type ResourceIndexEntry,
} from '../storage/state.js';

export async function writeChatIndex(
  tx: Tx, chat: Readonly<{id: string; name: string; createdAt: number}>, updatedAt: number,
): Promise<void> {
  const entry: ChatIndexEntry = {
    id: chat.id, name: chat.name, revision: 0, createdAt: chat.createdAt, updatedAt,
  };
  await tx.doc(ChatsIndex, chat.id, entry);
}

export async function writeJobIndex(
  tx: Tx, job: Readonly<{id: string; revision: number; status: string; updatedAt: number}>,
): Promise<void> {
  const entry: JobIndexEntry = {
    id: job.id, revision: job.revision, status: job.status, updatedAt: job.updatedAt,
  };
  await tx.doc(JobsIndex, job.id, entry);
}

export async function writeResourceIndex(tx: Tx, resource: Readonly<ResourceValue>): Promise<void> {
  const entry: ResourceIndexEntry = {
    id: resource.id,
    owner: resource.owner,
    state: resource.state,
    controlEpoch: resource.controlEpoch,
    revision: resource.revision,
    leaseExpiresAt: resource.lease === null ? null : resource.lease.expiresAt,
    updatedAt: Date.now(),
  };
  await tx.doc(ResourcesIndex, resource.id, entry);
}

export type ReceiptIndexInput = Readonly<{
  /** Receipt document kind, for example `point.command.job`. */
  family: string;
  /** Receipt family member key. */
  receiptKey: string;
  /** Entity the receipt protects, when the receipt shape exposes one. */
  referencedId?: string | null;
  /** Whether the receipt's business outcome is terminal (safe for retention cleanup). */
  terminal: boolean;
  createdAt?: number;
}>;

/** Index one request receipt so bounded cleanup can find it without scanning every receipt family. */
export async function indexReceipt(tx: Tx, input: ReceiptIndexInput): Promise<void> {
  const createdAt = input.createdAt ?? Date.now();
  const key = requestIndexKey(input.family, input.receiptKey);
  const entry: RequestIndexEntry = {
    key,
    family: input.family,
    receiptKey: input.receiptKey,
    referencedId: input.referencedId ?? null,
    terminal: input.terminal,
    createdAt,
  };
  await tx.doc(RequestsIndex, key, entry);
}
