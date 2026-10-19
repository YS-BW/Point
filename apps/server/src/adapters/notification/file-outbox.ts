/**
 * File-outbox notification adapter (WP2 real adapters, task 3.2).
 *
 * One durable JSON record per delivery id in an explicitly configured directory. A record is created
 * atomically (0600 temp file -> fsync -> hard link to the final name -> fsync directory), so a reader
 * sees either no record or the complete one. Replaying the same delivery/payload returns the original
 * outcome and never appends a second record; a different payload under the same delivery id is a
 * deterministic `failed`/`outbox-conflict` result (never a throw, so the delivery worker does not
 * mistake it for an unknown remote outcome). A file in the outbox proves only that the local record was
 * written; it never claims the remote channel has been reached.
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type {
  NotificationDetail, NotificationPort, NotificationRequest, NotificationResult,
} from '../../application/delivery.js';
import { isDeliveryId } from '../../domain/delivery.js';

export type FileOutboxOptions = Readonly<{
  /** Explicit absolute directory. No implicit default: absent configuration is fail-closed. */
  dir: string;
  /** Maximum accepted record size, including the redacted envelope. */
  maxRecordBytes?: number;
}>;

export type FileOutboxConfigErrorCode = 'OUTBOX_DIR_REQUIRED' | 'OUTBOX_DIR_INVALID' | 'OUTBOX_MAX_RECORD_INVALID';
export class FileOutboxConfigError extends Error {
  constructor(readonly code: FileOutboxConfigErrorCode) {
    super(code);
    this.name = 'FileOutboxConfigError';
  }
}

export type OutboxErrorCode =
  | 'OUTBOX_INVALID_DELIVERY_ID'
  | 'OUTBOX_INVALID_REQUEST'
  | 'OUTBOX_RECORD_TOO_LARGE'
  | 'OUTBOX_CORRUPT'
  | 'OUTBOX_IO';

export class OutboxError extends Error {
  constructor(readonly code: OutboxErrorCode) {
    super(code);
    this.name = 'OutboxError';
  }
}

export const DEFAULT_OUTBOX_MAX_RECORD_BYTES = 1_048_576;
const PAYLOAD_HASH = /^[0-9a-f]{64}$/;

/** Canonical record; stable field order is part of the on-disk contract. */
export type OutboxRecord = Readonly<{
  deliveryId: string;
  target: string;
  title: string;
  text: string;
  payloadHash: string;
  outcome: 'delivered';
  code: 'outbox-written';
  writtenAt: number;
}>;

function detail(classification: string): NotificationDetail {
  return {classification};
}

/**
 * A committed local record is evidence of local acceptance only. The outcome is deliberately
 * `unknown` so the delivery runtime never turns a file in this outbox into a claim that a remote
 * channel delivered the notification; a future channel dispatcher/reconcile must settle it.
 */
function localAccepted(): NotificationResult {
  return {outcome: 'unknown', code: 'outbox-written', detail: detail('local-only')};
}
function failed(code: string): NotificationResult {
  return {outcome: 'failed', code, detail: detail('client')};
}

function canonicalPayload(request: Readonly<{deliveryId: string; target: string; title: string; text: string}>): string {
  return JSON.stringify({
    deliveryId: request.deliveryId,
    target: request.target,
    title: request.title,
    text: request.text,
  });
}

/** Hash of the canonical request payload; used for replay/conflict detection. */
export function outboxPayloadHash(request: Readonly<{deliveryId: string; target: string; title: string; text: string}>): string {
  return createHash('sha256').update(canonicalPayload(request)).digest('hex');
}

function assertDeliveryId(deliveryId: unknown): asserts deliveryId is string {
  if (!isDeliveryId(deliveryId) || deliveryId === '.' || deliveryId === '..') {
    throw new OutboxError('OUTBOX_INVALID_DELIVERY_ID');
  }
}

function assertRequest(request: NotificationRequest): void {
  assertDeliveryId(request.deliveryId);
  if (typeof request.target !== 'string' || typeof request.title !== 'string' || typeof request.text !== 'string') {
    throw new OutboxError('OUTBOX_INVALID_REQUEST');
  }
}

/** Final record path for one delivery inside an absolute outbox directory. */
export function outboxRecordPath(dir: string, deliveryId: string): string {
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new FileOutboxConfigError('OUTBOX_DIR_INVALID');
  assertDeliveryId(deliveryId);
  const root = resolve(dir);
  const path = join(root, `${deliveryId}.json`);
  if (!path.startsWith(root + sep)) throw new OutboxError('OUTBOX_INVALID_DELIVERY_ID');
  return path;
}

function parseRecord(value: unknown, deliveryId: string): OutboxRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OutboxError('OUTBOX_CORRUPT');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['code', 'deliveryId', 'outcome', 'payloadHash', 'target', 'text', 'title', 'writtenAt'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new OutboxError('OUTBOX_CORRUPT');
  }
  const {target, title, text, payloadHash, outcome, code, writtenAt} = record;
  if (record.deliveryId !== deliveryId
    || typeof target !== 'string' || typeof title !== 'string' || typeof text !== 'string'
    || typeof payloadHash !== 'string' || !PAYLOAD_HASH.test(payloadHash)
    || outcome !== 'delivered' || code !== 'outbox-written'
    || typeof writtenAt !== 'number' || !Number.isSafeInteger(writtenAt) || writtenAt < 0) {
    throw new OutboxError('OUTBOX_CORRUPT');
  }
  const expectedHash = outboxPayloadHash({deliveryId, target, title, text});
  if (expectedHash !== payloadHash) throw new OutboxError('OUTBOX_CORRUPT');
  return {deliveryId, target, title, text, payloadHash, outcome: 'delivered', code: 'outbox-written', writtenAt};
}

function serializeRecord(record: OutboxRecord): string {
  return JSON.stringify({
    deliveryId: record.deliveryId,
    target: record.target,
    title: record.title,
    text: record.text,
    payloadHash: record.payloadHash,
    outcome: record.outcome,
    code: record.code,
    writtenAt: record.writtenAt,
  });
}

/**
 * Read and validate the durable outbox record for one delivery. `undefined` means no record; a
 * malformed, oversized, mismatched or symlinked record throws `OUTBOX_CORRUPT` (never followed).
 */
export async function readOutboxRecord(
  dir: string, deliveryId: string, maxRecordBytes = DEFAULT_OUTBOX_MAX_RECORD_BYTES,
): Promise<OutboxRecord | undefined> {
  const path = outboxRecordPath(dir, deliveryId);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    if (code === 'ELOOP' || code === 'EMLINK') throw new OutboxError('OUTBOX_CORRUPT');
    throw new OutboxError('OUTBOX_IO');
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new OutboxError('OUTBOX_CORRUPT');
    if (stats.size > maxRecordBytes) throw new OutboxError('OUTBOX_CORRUPT');
    const content = await handle.readFile({encoding: 'utf8'});
    if (Buffer.byteLength(content, 'utf8') > maxRecordBytes) throw new OutboxError('OUTBOX_CORRUPT');
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new OutboxError('OUTBOX_CORRUPT');
    }
    return parseRecord(value, deliveryId);
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Build the file-outbox notification port. Without an explicit absolute directory the factory throws;
 * nothing is ever written to an implicit location.
 */
export type StructuredOutboxPort = Readonly<{
  send(request: NotificationRequest): Promise<NotificationResult>;
}>;

export function createFileOutboxNotificationAdapter(options: FileOutboxOptions): StructuredOutboxPort {
  if (typeof options.dir !== 'string' || options.dir.trim() === '') throw new FileOutboxConfigError('OUTBOX_DIR_REQUIRED');
  if (!isAbsolute(options.dir)) throw new FileOutboxConfigError('OUTBOX_DIR_INVALID');
  const directory = resolve(options.dir);
  const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_OUTBOX_MAX_RECORD_BYTES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > 64 * 1_048_576) {
    throw new FileOutboxConfigError('OUTBOX_MAX_RECORD_INVALID');
  }

  async function existingOutcome(
    deliveryId: string, payloadHash: string,
  ): Promise<NotificationResult | undefined> {
    const existing = await readOutboxRecord(directory, deliveryId, maxRecordBytes);
    if (existing === undefined) return undefined;
    return existing.payloadHash === payloadHash ? localAccepted() : failed('outbox-conflict');
  }

  return {
    async send(request: NotificationRequest): Promise<NotificationResult> {
      try {
        assertRequest(request);
        const canonical = canonicalPayload(request);
        if (Buffer.byteLength(canonical, 'utf8') > maxRecordBytes) return failed('outbox-too-large');
        const payloadHash = outboxPayloadHash(request);
        await mkdir(directory, {recursive: true, mode: 0o700});
        const realDirectory = await realpath(directory);
        const path = outboxRecordPath(realDirectory, request.deliveryId);

        // Fast replay path: a committed record wins without writing anything.
        const replay = await existingOutcome(request.deliveryId, payloadHash);
        if (replay !== undefined) return replay;

        const record: OutboxRecord = {
          deliveryId: request.deliveryId,
          target: request.target,
          title: request.title,
          text: request.text,
          payloadHash,
          outcome: 'delivered',
          code: 'outbox-written',
          writtenAt: Date.now(),
        };
        const content = serializeRecord(record);
        const temporary = join(realDirectory, `.${randomUUID()}.tmp`);
        try {
          const handle = await open(temporary, 'wx', 0o600);
          try {
            await handle.writeFile(content, 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          try {
            // Hard link publishes the complete file atomically and never overwrites an existing record.
            await link(temporary, path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            // A concurrent writer won the name: compare against the committed record.
            const replayAfterRace = await existingOutcome(request.deliveryId, payloadHash);
            return replayAfterRace ?? failed('outbox-conflict');
          } finally {
            await unlink(temporary).catch(() => undefined);
          }
          await fsyncDirectory(realDirectory);
          return localAccepted();
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          if (error instanceof OutboxError) {
            return failed(error.code === 'OUTBOX_CORRUPT' ? 'outbox-corrupt' : 'outbox-write-error');
          }
          return failed('outbox-write-error');
        }
      } catch (error) {
        if (error instanceof OutboxError) {
          if (error.code === 'OUTBOX_INVALID_DELIVERY_ID' || error.code === 'OUTBOX_INVALID_REQUEST') {
            return failed('outbox-invalid-request');
          }
          if (error.code === 'OUTBOX_CORRUPT') return failed('outbox-corrupt');
          if (error.code === 'OUTBOX_RECORD_TOO_LARGE') return failed('outbox-too-large');
          return failed('outbox-write-error');
        }
        return failed('outbox-write-error');
      }
    },
  };
}
