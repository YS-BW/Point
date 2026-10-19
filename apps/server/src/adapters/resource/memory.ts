/**
 * In-memory `ResourceStore`. Test/sample only: nothing is persisted, there is no
 * Durable document, no crash recovery and no multi-process safety. It exists to
 * prove the application/domain contract (revision CAS, receipts, operation lookup)
 * and must never be presented as a production store.
 *
 * Concurrency note: `commit` validates and applies synchronously, so this store
 * alone cannot reproduce the application's load -> commit race. Tests that need
 * that window wrap this store: after `load` resolves, write a competing
 * takeover/acquire into the inner store before handing the stale resource back to
 * the application. The application's resource guard must then fail with
 * `RESOURCE_CONFLICT`/`STALE_CONTROL` instead of accepting the stale precondition.
 */

import type { CommandReceipt, ResourceMutation, ResourceStore } from '../../application/resource.js';
import { ResourceError, type Resource, type ResourceOperation } from '../../domain/resource.js';

/** Deep copy so callers can never mutate the store's internal records. */
function deepCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => deepCopy(item)) as unknown as T;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const key of Object.keys(source)) target[key] = deepCopy(source[key]);
  return target as T;
}

function receiptKey(resourceId: string, requestId: string): string {
  return `${resourceId.length}:${resourceId}/${requestId.length}:${requestId}`;
}

export function memoryResourceStore(): ResourceStore {
  const resources = new Map<string, Resource>();
  const operations = new Map<string, ResourceOperation>();
  /** resourceId -> requestId -> operationId, enforcing the operation idempotency key. */
  const operationRequests = new Map<string, Map<string, string>>();
  const receipts = new Map<string, CommandReceipt>();

  return {
    async load(id) {
      const resource = resources.get(id);
      return resource === undefined ? undefined : deepCopy(resource);
    },

    async loadOperation(id) {
      const operation = operations.get(id);
      return operation === undefined ? undefined : deepCopy(operation);
    },

    async findOperation(resourceId, requestId) {
      const operationId = operationRequests.get(resourceId)?.get(requestId);
      if (operationId === undefined) return undefined;
      const operation = operations.get(operationId);
      return operation === undefined ? undefined : deepCopy(operation);
    },

    async loadReceipt(resourceId, requestId) {
      const receipt = receipts.get(receiptKey(resourceId, requestId));
      return receipt === undefined ? undefined : deepCopy(receipt);
    },

    async commit(resourceId, mutation) {
      // Phase 1: validate every write without touching the maps. Any failure aborts
      // the whole mutation, so a commit can never leave "half state" behind.
      const resourceWrite = mutation.resource;
      if (resourceWrite !== undefined) {
        if (resourceWrite.value.id !== resourceId) throw new ResourceError('INVALID_COMMAND');
        const current = resources.get(resourceId);
        if (resourceWrite.expectedRevision === undefined) {
          if (current !== undefined) throw new ResourceError('RESOURCE_CONFLICT');
        } else if (current === undefined || current.revision !== resourceWrite.expectedRevision) {
          throw new ResourceError('RESOURCE_CONFLICT');
        }
      }

      const operationWrite = mutation.operation;
      if (operationWrite !== undefined) {
        if (operationWrite.value.resourceId !== resourceId) throw new ResourceError('INVALID_COMMAND');
        const current = operations.get(operationWrite.value.id);
        if (operationWrite.expectedRevision === undefined) {
          if (current !== undefined) throw new ResourceError('RESOURCE_CONFLICT');
        } else if (current === undefined || current.revision !== operationWrite.expectedRevision) {
          throw new ResourceError('RESOURCE_CONFLICT');
        }
        const indexed = operationRequests.get(resourceId)?.get(operationWrite.value.requestId);
        if (indexed !== undefined && indexed !== operationWrite.value.id) throw new ResourceError('RESOURCE_CONFLICT');
      }

      const receiptWrite = mutation.receipt;
      const key = receiptWrite === undefined ? undefined : receiptKey(resourceId, receiptWrite.requestId);
      if (receiptWrite !== undefined && key !== undefined) {
        const existing = receipts.get(key);
        if (existing !== undefined && existing.fingerprint !== receiptWrite.receipt.fingerprint) {
          throw new ResourceError('IDEMPOTENCY_CONFLICT');
        }
      }

      // Phase 2: apply. No await between the checks above and these writes.
      if (resourceWrite !== undefined) resources.set(resourceId, deepCopy(resourceWrite.value));
      if (operationWrite !== undefined) {
        const value = deepCopy(operationWrite.value);
        operations.set(value.id, value);
        let byRequest = operationRequests.get(resourceId);
        if (byRequest === undefined) {
          byRequest = new Map();
          operationRequests.set(resourceId, byRequest);
        }
        byRequest.set(value.requestId, value.id);
      }
      if (receiptWrite !== undefined && key !== undefined && !receipts.has(key)) {
        // A replay keeps the first receipt (and therefore the first result).
        receipts.set(key, deepCopy(receiptWrite.receipt));
      }
    },
  };
}
