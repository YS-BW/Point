/**
 * Resource application boundary: strict command parsing, idempotent receipts,
 * atomic writes through `ResourceStore`, and the effect port that keeps external
 * side effects in the `intent -> attempting -> done | failed | unknown` machine.
 *
 * Platform independent: no `node:` imports, no SDK imports, no crypto. The default
 * fingerprint is a pure canonical JSON serialization; a composition root that needs
 * hashing injects its own `fingerprint`.
 */

import {
  ResourceError,
  acquire,
  assertControl,
  attempt,
  cancel,
  initialResource,
  isIdentifier,
  isObservationText,
  isSafeNonNegativeInteger,
  isTtlMs,
  markUnknown,
  reconcile,
  release,
  renew,
  settle,
  takeover,
  type Resource,
  type ResourceId,
  type ResourceOperation,
} from '../domain/resource.js';

export type CommandReceipt = Readonly<{fingerprint: string; result: unknown}>;

export type ResourceMutation = Readonly<{
  /** Multiple records of one business result must land in a single commit. */
  resource?: Readonly<{value: Resource; expectedRevision: number | undefined}>;
  operation?: Readonly<{value: ResourceOperation; expectedRevision: number | undefined}>;
  receipt?: Readonly<{requestId: string; receipt: CommandReceipt}>;
}>;

export interface ResourceStore {
  load(id: ResourceId): Promise<Resource | undefined>;
  loadOperation(id: string): Promise<ResourceOperation | undefined>;
  findOperation(resourceId: ResourceId, requestId: string): Promise<ResourceOperation | undefined>;
  loadReceipt(resourceId: ResourceId, requestId: string): Promise<CommandReceipt | undefined>;
  /** Atomic commit; any CAS failure throws RESOURCE_CONFLICT and nothing is applied. */
  commit(resourceId: ResourceId, mutation: ResourceMutation): Promise<void>;
}

/** External abilities implement only this port. `unknown` is reconciled by observation, never retried here. */
export interface ResourceEffectPort {
  invoke(operation: ResourceOperation): Promise<unknown>;
}

/** Adapters use a known failure for "definitely happened"; every other throw becomes `unknown`. */
export class EffectFailure extends Error {
  constructor(readonly certainty: 'failed' | 'unknown', readonly code: string) {
    super(code);
    this.name = 'EffectFailure';
  }
}

export interface ResourceCommands {
  acquire(input: unknown): Promise<Resource>;
  renew(input: unknown): Promise<Resource>;
  release(input: unknown): Promise<Resource>;
  takeover(input: unknown): Promise<Resource>;
  read(id: string): Promise<Resource | undefined>;

  beginOperation(input: unknown): Promise<ResourceOperation>;
  /** Idempotent execution: dispatch only from `intent`; `attempting` becomes `unknown` without dispatch. */
  runOperation(operationId: string, effect: ResourceEffectPort): Promise<ResourceOperation>;
  /** Reconcile only `unknown`; `done`/`failed` are returned as-is; `intent`/`attempting` are rejected. */
  observeOperation(input: unknown): Promise<ResourceOperation>;
}

/** Deterministic serialization used as the default idempotency fingerprint (no crypto). */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(item => serializeCanonical(item)).join(',')}]`;
      const record = value as Record<string, unknown>;
      const fields = Object.keys(record)
        .filter(key => record[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${serializeCanonical(record[key])}`);
      return `{${fields.join(',')}}`;
    }
    default:
      return 'null';
  }
}

/* -------------------------------------------------------------------------- */
/* Strict input parsing: no coercion, no partial commands.                     */
/* -------------------------------------------------------------------------- */

function parseObject(
  input: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ResourceError('INVALID_COMMAND');
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new ResourceError('INVALID_COMMAND');
  }
  return value;
}

function identifier(value: unknown): string {
  if (!isIdentifier(value)) throw new ResourceError('INVALID_COMMAND');
  return value;
}

function epoch(value: unknown): number {
  if (!isSafeNonNegativeInteger(value)) throw new ResourceError('INVALID_COMMAND');
  return value;
}

function ttlMs(value: unknown): number {
  if (!isTtlMs(value)) throw new ResourceError('INVALID_COMMAND');
  return value;
}

type AcquireCommand = Readonly<{
  command: 'acquire'; resourceId: string; requestId: string; owner: string; ttlMs: number;
}>;
type RenewCommand = Readonly<{
  command: 'renew'; resourceId: string; requestId: string; owner: string; epoch: number; ttlMs: number;
}>;
type ReleaseCommand = Readonly<{
  command: 'release'; resourceId: string; requestId: string; owner: string; epoch: number;
}>;
type TakeoverCommand = Readonly<{
  command: 'takeover'; resourceId: string; requestId: string; owner: string; ttlMs: number;
}>;
type BeginOperationCommand = Readonly<{
  command: 'beginOperation'; operationId: string; requestId: string; resourceId: string; controlEpoch: number;
}>;
type ObserveOperationCommand = Readonly<{
  command: 'observeOperation'; operationId: string; status: 'done' | 'failed'; observation?: string; result?: unknown;
}>;

function parseAcquire(input: unknown): AcquireCommand {
  const value = parseObject(input, ['resourceId', 'requestId', 'owner', 'ttlMs'], ['resourceId', 'requestId', 'owner', 'ttlMs']);
  return {
    command: 'acquire',
    resourceId: identifier(value.resourceId),
    requestId: identifier(value.requestId),
    owner: identifier(value.owner),
    ttlMs: ttlMs(value.ttlMs),
  };
}

function parseRenew(input: unknown): RenewCommand {
  const value = parseObject(
    input,
    ['resourceId', 'requestId', 'owner', 'epoch', 'ttlMs'],
    ['resourceId', 'requestId', 'owner', 'epoch', 'ttlMs'],
  );
  return {
    command: 'renew',
    resourceId: identifier(value.resourceId),
    requestId: identifier(value.requestId),
    owner: identifier(value.owner),
    epoch: epoch(value.epoch),
    ttlMs: ttlMs(value.ttlMs),
  };
}

function parseRelease(input: unknown): ReleaseCommand {
  const value = parseObject(
    input,
    ['resourceId', 'requestId', 'owner', 'epoch'],
    ['resourceId', 'requestId', 'owner', 'epoch'],
  );
  return {
    command: 'release',
    resourceId: identifier(value.resourceId),
    requestId: identifier(value.requestId),
    owner: identifier(value.owner),
    epoch: epoch(value.epoch),
  };
}

function parseTakeover(input: unknown): TakeoverCommand {
  const value = parseObject(input, ['resourceId', 'requestId', 'owner', 'ttlMs'], ['resourceId', 'requestId', 'owner', 'ttlMs']);
  return {
    command: 'takeover',
    resourceId: identifier(value.resourceId),
    requestId: identifier(value.requestId),
    owner: identifier(value.owner),
    ttlMs: ttlMs(value.ttlMs),
  };
}

function parseBeginOperation(input: unknown): BeginOperationCommand {
  const value = parseObject(
    input,
    ['operationId', 'requestId', 'resourceId', 'controlEpoch'],
    ['operationId', 'requestId', 'resourceId', 'controlEpoch'],
  );
  return {
    command: 'beginOperation',
    operationId: identifier(value.operationId),
    requestId: identifier(value.requestId),
    resourceId: identifier(value.resourceId),
    controlEpoch: epoch(value.controlEpoch),
  };
}

function parseObserveOperation(input: unknown): ObserveOperationCommand {
  const value = parseObject(
    input,
    ['operationId', 'status', 'observation', 'result'],
    ['operationId', 'status'],
  );
  const status = value.status;
  if (status !== 'done' && status !== 'failed') throw new ResourceError('INVALID_COMMAND');
  const observation = value.observation;
  if (observation !== undefined && !isObservationText(observation)) throw new ResourceError('INVALID_COMMAND');
  return {
    command: 'observeOperation',
    operationId: identifier(value.operationId),
    status,
    ...(observation === undefined ? {} : {observation}),
    ...(Object.hasOwn(value, 'result') ? {result: value.result} : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Idempotency-keyed resource write. The receipt is checked before touching the
 * resource, so a replay returns the first result even when the lease has moved on.
 * The resource change and the receipt always share one `store.commit`.
 *
 * `createIfMissing` is reserved for `acquire`: the first acquire registers the
 * resource with `initialResource` in the same commit as its lease and receipt.
 * Every other command reports RESOURCE_NOT_FOUND for a missing resource.
 */
async function mutateResource(
  store: ResourceStore,
  now: () => number,
  fingerprint: (value: unknown) => string,
  resourceId: string,
  requestId: string,
  command: unknown,
  apply: (resource: Resource, timestamp: number) => Resource,
  createIfMissing = false,
): Promise<Resource> {
  const expectedFingerprint = fingerprint(command);
  const existing = await store.loadReceipt(resourceId, requestId);
  if (existing !== undefined) {
    if (existing.fingerprint !== expectedFingerprint) throw new ResourceError('IDEMPOTENCY_CONFLICT');
    return existing.result as Resource;
  }
  const timestamp = now();
  const loaded = await store.load(resourceId);
  if (loaded === undefined && !createIfMissing) throw new ResourceError('RESOURCE_NOT_FOUND');
  const current = loaded ?? initialResource(resourceId);
  const next = apply(current, timestamp);
  const receipt: CommandReceipt = {fingerprint: expectedFingerprint, result: next};
  // The read precondition and the write share one CAS. A no-op still writes the
  // guard with the same revision (never incrementing it), so a concurrent takeover
  // between the load above and this commit fails closed instead of returning a
  // stale success. Receipt and guard always land in the same commit.
  const mutation: ResourceMutation = {
    resource: {value: next, expectedRevision: loaded === undefined ? undefined : current.revision},
    receipt: {requestId, receipt},
  };
  await store.commit(resourceId, mutation);
  return next;
}

/** Control fence for pending intents: returns the stable code when dispatch must be cancelled. */
function controlFailure(resource: Resource, epoch: number): 'STALE_CONTROL' | null {
  try {
    assertControl(resource, epoch);
    return null;
  } catch (error) {
    if (error instanceof ResourceError && error.code === 'STALE_CONTROL') return 'STALE_CONTROL';
    throw error;
  }
}

/** Bounded retries when the attempt CAS loses to a concurrent change under the same epoch. */
const MAX_ATTEMPT_RETRIES = 2;

/** Close a pending intent as failed without ever dispatching; the thrown code stays stable. */
async function cancelIntent(
  store: ResourceStore,
  operation: ResourceOperation,
  code: 'STALE_CONTROL' | 'RESOURCE_NOT_FOUND',
): Promise<never> {
  const cancelled = cancel(operation, code);
  await store.commit(operation.resourceId, {operation: {value: cancelled, expectedRevision: operation.revision}});
  throw new ResourceError(code);
}

/** Dispatch exactly once; any failure that is not a known `failed` is conservatively `unknown`. */
async function dispatch(effect: ResourceEffectPort, operation: ResourceOperation): Promise<ResourceOperation> {
  try {
    const result = await effect.invoke(operation);
    return settle(operation, {state: 'done', result});
  } catch (error) {
    if (error instanceof EffectFailure) {
      // A known failure keeps the adapter code on the operation so the outcome
      // stays auditable after the application swallows the exception.
      if (error.certainty === 'failed') return settle(operation, {state: 'failed', result: error.code});
      return markUnknown(operation);
    }
    return markUnknown(operation);
  }
}

export function resourceCommands(
  store: ResourceStore,
  now: () => number,
  fingerprint: (value: unknown) => string = canonicalJson,
): ResourceCommands {
  return {
    async acquire(input) {
      const command = parseAcquire(input);
      // First acquire is the registration entry point: it creates the resource.
      return mutateResource(store, now, fingerprint, command.resourceId, command.requestId, command,
        (resource, timestamp) => acquire(resource, {owner: command.owner, ttlMs: command.ttlMs}, timestamp),
        true);
    },

    async renew(input) {
      const command = parseRenew(input);
      return mutateResource(store, now, fingerprint, command.resourceId, command.requestId, command,
        (resource, timestamp) => renew(
          resource,
          {owner: command.owner, epoch: command.epoch, ttlMs: command.ttlMs},
          timestamp,
        ));
    },

    async release(input) {
      const command = parseRelease(input);
      return mutateResource(store, now, fingerprint, command.resourceId, command.requestId, command,
        resource => release(resource, {owner: command.owner, epoch: command.epoch}));
    },

    async takeover(input) {
      const command = parseTakeover(input);
      return mutateResource(store, now, fingerprint, command.resourceId, command.requestId, command,
        (resource, timestamp) => takeover(resource, {owner: command.owner, ttlMs: command.ttlMs}, timestamp));
    },

    async read(id) {
      // IDs are opaque at the application boundary; reject invalid forms without I/O.
      if (!isIdentifier(id)) return undefined;
      return store.load(id);
    },

    async beginOperation(input) {
      const command = parseBeginOperation(input);
      const expectedFingerprint = fingerprint(command);
      const existing = await store.findOperation(command.resourceId, command.requestId);
      if (existing !== undefined) {
        if (existing.fingerprint !== expectedFingerprint) throw new ResourceError('IDEMPOTENCY_CONFLICT');
        return existing;
      }
      const resource = await store.load(command.resourceId);
      if (resource === undefined) throw new ResourceError('RESOURCE_NOT_FOUND');
      assertControl(resource, command.controlEpoch);
      const operation: ResourceOperation = {
        id: command.operationId,
        requestId: command.requestId,
        resourceId: command.resourceId,
        controlEpoch: command.controlEpoch,
        state: 'intent',
        revision: 0,
        fingerprint: expectedFingerprint,
      };
      // The control check and the operation creation share one CAS: a takeover
      // between the load above and this commit makes the guard fail instead of
      // accepting an operation under an already fenced epoch.
      await store.commit(command.resourceId, {
        resource: {value: resource, expectedRevision: resource.revision},
        operation: {value: operation, expectedRevision: undefined},
      });
      return operation;
    },

    async runOperation(operationId, effect) {
      if (!isIdentifier(operationId)) throw new ResourceError('INVALID_COMMAND');
      if (!effect || typeof effect.invoke !== 'function') throw new ResourceError('INVALID_COMMAND');
      const operation = await store.loadOperation(operationId);
      if (operation === undefined) throw new ResourceError('OPERATION_NOT_FOUND');
      // Recovery: an interrupted `attempting` operation must first become `unknown`
      // and must never call the external effect again.
      if (operation.state === 'attempting') {
        const unknown = markUnknown(operation);
        await store.commit(operation.resourceId, {operation: {value: unknown, expectedRevision: operation.revision}});
        return unknown;
      }
      // done / failed / unknown are terminal here: return as-is, never dispatch.
      if (operation.state !== 'intent') return operation;
      // Control fence before dispatch: a pending intent whose epoch was taken over
      // (or whose resource vanished) must be cancelled, never executed.
      const loaded = await store.load(operation.resourceId);
      if (loaded === undefined) return cancelIntent(store, operation, 'RESOURCE_NOT_FOUND');
      let resource: Resource = loaded;
      const blocked = controlFailure(resource, operation.controlEpoch);
      if (blocked !== null) return cancelIntent(store, operation, blocked);
      const dispatching = attempt(operation);
      let retries = 0;
      for (;;) {
        try {
          // The read precondition and the attempt write share one CAS: a takeover
          // between the load above and this commit cancels the intent below instead
          // of letting a stale epoch dispatch the effect.
          await store.commit(operation.resourceId, {
            operation: {value: dispatching, expectedRevision: operation.revision},
            resource: {value: resource, expectedRevision: resource.revision},
          });
          break;
        } catch (error) {
          if (!(error instanceof ResourceError) || error.code !== 'RESOURCE_CONFLICT') throw error;
          if (retries >= MAX_ATTEMPT_RETRIES) throw error;
          retries += 1;
          // Re-read the fence input after losing the CAS. Stale epoch or a vanished
          // resource closes the intent as failed; an unchanged epoch may retry.
          const reread = await store.load(operation.resourceId);
          if (reread === undefined) return cancelIntent(store, operation, 'RESOURCE_NOT_FOUND');
          const rereadBlocked = controlFailure(reread, operation.controlEpoch);
          if (rereadBlocked !== null) return cancelIntent(store, operation, rereadBlocked);
          resource = reread;
        }
      }
      const settled = await dispatch(effect, dispatching);
      // If this write fails the operation stays `attempting` in storage and the
      // recovery path above turns it into `unknown` on the next run.
      await store.commit(operation.resourceId, {operation: {value: settled, expectedRevision: dispatching.revision}});
      return settled;
    },

    async observeOperation(input) {
      const command = parseObserveOperation(input);
      const operation = await store.loadOperation(command.operationId);
      if (operation === undefined) throw new ResourceError('OPERATION_NOT_FOUND');
      if (operation.state === 'done' || operation.state === 'failed') return operation;
      if (operation.state !== 'unknown') throw new ResourceError('INVALID_TRANSITION');
      const reconciled = reconcile(operation, {
        state: command.status,
        ...(command.observation === undefined ? {} : {observation: command.observation}),
        ...(command.result === undefined ? {} : {result: command.result}),
      });
      await store.commit(operation.resourceId, {operation: {value: reconciled, expectedRevision: operation.revision}});
      return reconciled;
    },
  };
}
