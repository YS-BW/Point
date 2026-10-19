/**
 * Durable resource state for WP2 real adapters.
 *
 * Every family member is wrapped in a `{present, value}` envelope. The family seed is
 * the absent envelope (`present: false`), so a commit can tell "this family member was
 * just seeded" from "it already existed" without calling `snapshot()` inside a commit.
 * Stored values are plain JSON: optional domain fields (`result?`, `observation?`) become
 * `null`, and `undefined` never reaches the document.
 *
 * Unknown document versions are rejected by the Durable SDK (`checkRecordVersion`);
 * no migration is installed on purpose.
 */

import type { JsonValue } from '@earendil-works/chord';
import { defineDocFamily } from '@earendil-works/pi-durable';
import {
  ResourceError,
  type JsonObject,
  type OperationState,
  type Resource,
  type ResourceOperation,
  type ResourceState,
} from '../domain/resource.js';
import type { CommandReceipt } from '../application/resource.js';

export type LeaseDocument = Readonly<{
  owner: string;
  expiresAt: number;
  epoch: number;
}>;

export type ResourceValue = Readonly<{
  id: string;
  owner: string | null;
  lease: LeaseDocument | null;
  controlEpoch: number;
  revision: number;
  state: ResourceState;
}>;

/** Nullable/present envelope: `present === false` means "no resource yet". */
export type ResourceDocument = {
  present: boolean;
  value: ResourceValue | null;
};

export type ResourceOperationEffectDocument = Readonly<{
  kind: string;
  payload: JsonObject;
  payloadHash: string;
}>;

/**
 * Version-2 operation document. The secure binding fields are `null` for version-1
 * operations written through the legacy test path; a non-null `effect` marks a
 * secure operation whose attempt fields are significant.
 */
export type ResourceOperationValue = Readonly<{
  id: string;
  requestId: string;
  resourceId: string;
  controlEpoch: number;
  state: OperationState;
  revision: number;
  fingerprint: string;
  result: JsonValue | null;
  observation: string | null;
  owner: string | null;
  effect: ResourceOperationEffectDocument | null;
  attemptToken: string | null;
  attemptStartedAt: number | null;
  deadline: number | null;
  evidence: JsonObject | null;
  observer: string | null;
}>;

export type ResourceOperationDocument = {
  present: boolean;
  value: ResourceOperationValue | null;
};

/** `(resourceId, requestId)` -> operationId index; the family key is the request key. */
export type ResourceOperationRequestDocument = {
  present: boolean;
  operationId: string | null;
};

/** Idempotency receipt for one resource command. */
export type ResourceCommandDocument = {
  present: boolean;
  fingerprint: string | null;
  result: JsonValue | null;
};

export const ABSENT_RESOURCE: ResourceDocument = {present: false, value: null};
export const ABSENT_OPERATION: ResourceOperationDocument = {present: false, value: null};
export const ABSENT_OPERATION_REQUEST: ResourceOperationRequestDocument = {present: false, operationId: null};
export const ABSENT_COMMAND: ResourceCommandDocument = {present: false, fingerprint: null, result: null};

/** Injection-safe key for `(resourceId, requestId)`; identifiers may contain ':'. */
export function resourceRequestKey(resourceId: string, requestId: string): string {
  return `${resourceId.length}:${resourceId}/${requestId.length}:${requestId}`;
}

/** Current resource state; the family key is the resourceId. */
export const Resources = defineDocFamily({
  kind: 'point.resource', version: 1, scope: 'session', family: true,
  initial: (document: ResourceDocument) => ({...document}),
});

/**
 * Whole operation record; the family key is the operationId. Version 2 adds the
 * secure effect/attempt binding. Version-1 documents are rejected by the Durable
 * SDK (no silent migration, no inferred effect).
 */
export const ResourceOperations = defineDocFamily({
  kind: 'point.resource-operation', version: 2, scope: 'session', family: true,
  initial: (document: ResourceOperationDocument) => ({...document}),
});

/** Operation idempotency index; the family key is `resourceRequestKey(resourceId, requestId)`. */
export const ResourceOperationRequests = defineDocFamily({
  kind: 'point.resource-operation-request', version: 1, scope: 'session', family: true,
  initial: (document: ResourceOperationRequestDocument) => ({...document}),
});

/** Command receipt; the family key is `resourceRequestKey(resourceId, requestId)`. */
export const ResourceCommandReceipts = defineDocFamily({
  kind: 'point.resource-command', version: 1, scope: 'session', family: true,
  initial: (document: ResourceCommandDocument) => ({...document}),
});

/** Strict JSON conversion: a value that cannot be stored faithfully is a command error, never silent data loss. */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ResourceError('INVALID_COMMAND');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => toJsonValue(item));
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new ResourceError('INVALID_COMMAND');
    const record: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue;
      record[key] = toJsonValue(item);
    }
    return record;
  }
  throw new ResourceError('INVALID_COMMAND');
}

/** Detach a stored JSON value so callers can never mutate the session's cached document. */
function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function resourceDocument(resource: Resource): ResourceValue {
  return {
    id: resource.id,
    owner: resource.owner,
    lease: resource.lease === null ? null : {
      owner: resource.lease.owner,
      expiresAt: resource.lease.expiresAt,
      epoch: resource.lease.epoch,
    },
    controlEpoch: resource.controlEpoch,
    revision: resource.revision,
    state: resource.state,
  };
}

export function resourceFromDocument(value: ResourceValue): Resource {
  return {
    id: value.id,
    owner: value.owner,
    lease: value.lease === null ? null : {
      owner: value.lease.owner,
      expiresAt: value.lease.expiresAt,
      epoch: value.lease.epoch,
    },
    controlEpoch: value.controlEpoch,
    revision: value.revision,
    state: value.state,
  };
}

export function operationDocument(operation: ResourceOperation): ResourceOperationValue {
  return {
    id: operation.id,
    requestId: operation.requestId,
    resourceId: operation.resourceId,
    controlEpoch: operation.controlEpoch,
    state: operation.state,
    revision: operation.revision,
    fingerprint: operation.fingerprint,
    result: operation.result === undefined ? null : toJsonValue(operation.result),
    observation: operation.observation ?? null,
    owner: operation.owner ?? null,
    effect: operation.effect === undefined ? null : {
      kind: operation.effect.kind,
      payload: cloneJson(operation.effect.payload as JsonValue) as JsonObject,
      payloadHash: operation.effect.payloadHash,
    },
    attemptToken: operation.attemptToken ?? null,
    attemptStartedAt: operation.attemptStartedAt ?? null,
    deadline: operation.deadline ?? null,
    evidence: operation.evidence === undefined ? null : cloneJson(operation.evidence as JsonValue) as JsonObject,
    observer: operation.observer ?? null,
  };
}

export function operationFromDocument(value: ResourceOperationValue): ResourceOperation {
  return {
    id: value.id,
    requestId: value.requestId,
    resourceId: value.resourceId,
    controlEpoch: value.controlEpoch,
    state: value.state,
    revision: value.revision,
    fingerprint: value.fingerprint,
    ...(value.result === null ? {} : {result: cloneJson(value.result)}),
    ...(value.observation === null ? {} : {observation: value.observation}),
    ...(value.effect === null ? {} : {
      owner: value.owner as string,
      effect: {
        kind: value.effect.kind,
        payload: cloneJson(value.effect.payload as JsonValue) as JsonObject,
        payloadHash: value.effect.payloadHash,
      },
      attemptToken: value.attemptToken,
      attemptStartedAt: value.attemptStartedAt,
      deadline: value.deadline as number,
    }),
    ...(value.evidence === null ? {} : {evidence: cloneJson(value.evidence as JsonValue) as JsonObject}),
    ...(value.observer === null ? {} : {observer: value.observer}),
  };
}

export function commandDocument(receipt: CommandReceipt): ResourceCommandDocument {
  return {present: true, fingerprint: receipt.fingerprint, result: toJsonValue(receipt.result)};
}

export function commandFromDocument(document: ResourceCommandDocument): CommandReceipt | undefined {
  if (!document.present || document.fingerprint === null) return undefined;
  return {fingerprint: document.fingerprint, result: document.result === null ? null : cloneJson(document.result)};
}
