/**
 * Product state format gate (WP3).
 *
 * `point.meta.format` is the only product-state authority:
 * - format 2: normal read-write open;
 * - format 1 (`point.server.meta`): explicit migration or read-only open only, never a silent
 *   in-place upgrade;
 * - unknown/newer formats: refused before any write, with a stable error;
 * - fresh databases are created directly as format 2.
 *
 * Read-only mode still opens the Durable storage (the SDK has no read-only storage backend), but the
 * product runtime receives a guarded Harness whose `commit`/`resume` refuse writes; the SDK scheduler
 * is never resumed. This is a product-layer guarantee, documented accordingly.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness } from '@earendil-works/pi-durable';
import { Meta, assertCompatible } from '../storage/meta.js';
import { MetaV2, assertStateMetaV2, type StateMetaV2 } from '../storage/state.js';

export type OpenMode = 'read-write' | 'read-only';

export type StateFormatErrorCode =
  | 'MIGRATION_REQUIRED'
  | 'UNSUPPORTED_DATA_FORMAT'
  | 'MISSING_METADATA'
  | 'UNRECOGNIZED_DATA'
  | 'READ_ONLY';

export class StateFormatError extends Error {
  constructor(readonly code: StateFormatErrorCode) {
    super(code);
    this.name = 'StateFormatError';
  }
}

export type DetectedState =
  | Readonly<{format: 2; instanceId: string; migratedAt: number}>
  | Readonly<{format: 1; instanceId: string}>
  | Readonly<{format: 'fresh'}>;

/**
 * Detect the product state format before any product write. `populated` must already be true when the
 * database holds SDK records but no product meta (unrecognized data, not a fresh database).
 */
export async function detectStateFormat(
  harness: Harness, populated: boolean, mode: OpenMode,
): Promise<DetectedState> {
  const current = await harness.snapshot(MetaV2, BACKGROUND_CONTEXT);
  const legacy = await harness.snapshot(Meta, BACKGROUND_CONTEXT);
  if (current !== undefined) {
    if (legacy !== undefined) {
      // A half-migrated database is ambiguous; require an explicit operator decision, never a guess.
      if (legacy.format !== 1) throw new StateFormatError('UNSUPPORTED_DATA_FORMAT');
      throw new StateFormatError('UNRECOGNIZED_DATA');
    }
    try {
      assertStateMetaV2(current as StateMetaV2);
    } catch {
      throw new StateFormatError('UNSUPPORTED_DATA_FORMAT');
    }
    return {format: 2, instanceId: current.instanceId, migratedAt: current.migratedAt};
  }
  if (legacy !== undefined) {
    try {
      assertCompatible(legacy);
    } catch {
      throw new StateFormatError('UNSUPPORTED_DATA_FORMAT');
    }
    if (mode === 'read-write') throw new StateFormatError('MIGRATION_REQUIRED');
    return {format: 1, instanceId: legacy.instanceId};
  }
  if (populated) throw new StateFormatError('UNRECOGNIZED_DATA');
  if (mode === 'read-only') throw new StateFormatError('MISSING_METADATA');
  return {format: 'fresh'};
}

/**
 * Wrap an open Harness so every product mutation through the runtime is refused. Reads pass through;
 * the SDK scheduler is not resumed in read-only mode. Persisted fact writes performed by the SDK's own
 * internals (WAL bookkeeping) are outside this product-layer guarantee.
 */
export function readOnlyGuard(harness: Harness): Harness {
  return new Proxy(harness, {
    get(target, property, receiver) {
      if (property === 'commit') {
        return async (): Promise<never> => { throw new StateFormatError('READ_ONLY'); };
      }
      if (property === 'resume') {
        return (): never => { throw new StateFormatError('READ_ONLY'); };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
