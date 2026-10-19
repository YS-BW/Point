/**
 * Durable `ResourceStore` for WP2 real adapters.
 *
 * All reads go through committed snapshots; `commit` uses only the transaction
 * (`tx.doc`) and never calls `snapshot()` inside the callback. Every touched family
 * member is seeded with its absent envelope, so presence and revision are validated
 * inside the same commit that writes; a failed CAS throws before any draft is mutated
 * and therefore leaves no document, index entry, or receipt behind.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness } from '@earendil-works/pi-durable';
import type { ResourceStore } from '../application/resource.js';
import { ResourceError, type ResourceOperation } from '../domain/resource.js';
import {
  ABSENT_COMMAND, ABSENT_OPERATION, ABSENT_OPERATION_REQUEST, ABSENT_RESOURCE,
  ResourceCommandReceipts, ResourceOperationRequests, ResourceOperations, Resources,
  commandDocument, commandFromDocument, operationDocument, operationFromDocument,
  resourceDocument, resourceFromDocument, resourceRequestKey,
} from '../storage/resource.js';

/** The part of Harness this store needs; everything else is the owning runtime's concern. */
export type ResourceHarness = Pick<Harness, 'snapshot' | 'commit'>;

/** Translate a Durable version/migration rejection into the stable resource code. */
function incompatible(error: unknown): never {
  if (error instanceof ResourceError) throw error;
  if (error instanceof Error && /version|migration/i.test(error.message)) {
    throw new ResourceError('OPERATION_INCOMPATIBLE');
  }
  throw error;
}

export function durableResourceStore(harness: ResourceHarness): ResourceStore {
  async function loadOperation(id: string): Promise<ResourceOperation | undefined> {
    let document;
    try {
      document = await harness.snapshot(ResourceOperations, id, BACKGROUND_CONTEXT);
    } catch (error) {
      incompatible(error);
    }
    if (document === undefined || !document.present || document.value === null) return undefined;
    return operationFromDocument(document.value);
  }

  return {
    async load(id) {
      const document = await harness.snapshot(Resources, id, BACKGROUND_CONTEXT);
      if (document === undefined || !document.present || document.value === null) return undefined;
      return resourceFromDocument(document.value);
    },

    loadOperation,

    async findOperation(resourceId, requestId) {
      const index = await harness.snapshot(
        ResourceOperationRequests, resourceRequestKey(resourceId, requestId), BACKGROUND_CONTEXT);
      if (index === undefined || !index.present || index.operationId === null) return undefined;
      return loadOperation(index.operationId);
    },

    async loadReceipt(resourceId, requestId) {
      const document = await harness.snapshot(
        ResourceCommandReceipts, resourceRequestKey(resourceId, requestId), BACKGROUND_CONTEXT);
      return document === undefined ? undefined : commandFromDocument(document);
    },

    async commit(resourceId, mutation) {
      await harness.commit(async (tx): Promise<void> => {
        // Phase 1: read self-seeded drafts and validate every CAS precondition. Drafts
        // are only mutated in phase 2, so any throw aborts the commit with nothing written.
        const resourceWrite = mutation.resource;
        const resourceDraft = resourceWrite === undefined
          ? undefined
          : await tx.doc(Resources, resourceId, ABSENT_RESOURCE);
        if (resourceWrite !== undefined && resourceDraft !== undefined) {
          if (resourceWrite.value.id !== resourceId) throw new ResourceError('INVALID_COMMAND');
          const current = resourceDraft.present && resourceDraft.value !== null ? resourceDraft.value : undefined;
          if (resourceWrite.expectedRevision === undefined) {
            if (current !== undefined) throw new ResourceError('RESOURCE_CONFLICT');
          } else if (current === undefined || current.revision !== resourceWrite.expectedRevision) {
            throw new ResourceError('RESOURCE_CONFLICT');
          }
        }

        const operationWrite = mutation.operation;
        let operationDraft;
        try {
          operationDraft = operationWrite === undefined
            ? undefined
            : await tx.doc(ResourceOperations, operationWrite.value.id, ABSENT_OPERATION);
        } catch (error) {
          incompatible(error);
        }
        const requestKey = operationWrite === undefined
          ? undefined
          : resourceRequestKey(resourceId, operationWrite.value.requestId);
        const requestDraft = requestKey === undefined
          ? undefined
          : await tx.doc(ResourceOperationRequests, requestKey, ABSENT_OPERATION_REQUEST);
        if (operationWrite !== undefined && operationDraft !== undefined && requestDraft !== undefined) {
          if (operationWrite.value.resourceId !== resourceId) throw new ResourceError('INVALID_COMMAND');
          const current = operationDraft.present && operationDraft.value !== null ? operationDraft.value : undefined;
          if (operationWrite.expectedRevision === undefined) {
            if (current !== undefined) throw new ResourceError('RESOURCE_CONFLICT');
          } else if (current === undefined || current.revision !== operationWrite.expectedRevision) {
            throw new ResourceError('RESOURCE_CONFLICT');
          }
          if (operationWrite.expectedAttemptToken !== undefined) {
            // Token CAS: a settlement may only win while its attempt token is current.
            const currentToken = current === undefined || current.effect === null ? null : current.attemptToken;
            if (currentToken !== operationWrite.expectedAttemptToken) throw new ResourceError('RESOURCE_CONFLICT');
          }
          const indexed = requestDraft.present ? requestDraft.operationId : null;
          if (indexed !== null && indexed !== operationWrite.value.id) throw new ResourceError('RESOURCE_CONFLICT');
        }

        const receiptWrite = mutation.receipt;
        const receiptKey = receiptWrite === undefined
          ? undefined
          : resourceRequestKey(resourceId, receiptWrite.requestId);
        const receiptDraft = receiptKey === undefined
          ? undefined
          : await tx.doc(ResourceCommandReceipts, receiptKey, ABSENT_COMMAND);
        const receiptDocument = receiptWrite === undefined ? undefined : commandDocument(receiptWrite.receipt);
        if (receiptDocument !== undefined && receiptDraft !== undefined) {
          // Same key with a different fingerprint conflicts; the first receipt is kept.
          if (receiptDraft.present && receiptDraft.fingerprint !== receiptDocument.fingerprint) {
            throw new ResourceError('IDEMPOTENCY_CONFLICT');
          }
        }

        // Phase 2: apply. No awaits between the final check above and these writes.
        if (resourceWrite !== undefined && resourceDraft !== undefined) {
          resourceDraft.present = true;
          resourceDraft.value = resourceDocument(resourceWrite.value);
        }
        if (operationWrite !== undefined && operationDraft !== undefined && requestDraft !== undefined) {
          operationDraft.present = true;
          operationDraft.value = operationDocument(operationWrite.value);
          // `(resourceId, requestId)` -> operationId is written in the same commit as the
          // operation itself, so a crash can never expose the operation without its index.
          requestDraft.present = true;
          requestDraft.operationId = operationWrite.value.id;
        }
        if (receiptDocument !== undefined && receiptDraft !== undefined && !receiptDraft.present) {
          receiptDraft.present = true;
          receiptDraft.fingerprint = receiptDocument.fingerprint;
          receiptDraft.result = receiptDocument.result;
        }
      }, BACKGROUND_CONTEXT);
    },
  };
}
