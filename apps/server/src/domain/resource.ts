/**
 * Pure resource-boundary rules: lease/control-epoch fencing and the side-effect
 * operation state machine. No IO, no SDK, no platform modules.
 *
 * `revision` is the storage CAS counter: every successful write increments it by
 * one. It never participates in command semantics. `controlEpoch` fences control:
 * takeover and re-acquisition after expiry increment it, and any caller holding an
 * old epoch is rejected with STALE_CONTROL.
 */

export type ResourceId = string;
export type OwnerId = string;
export type ControlEpoch = number;

export type Lease = Readonly<{
  owner: OwnerId;
  expiresAt: number;
  epoch: ControlEpoch;
}>;

export type ResourceState = 'idle' | 'leased';

export type Resource = Readonly<{
  id: ResourceId;
  owner: OwnerId | null;
  lease: Lease | null;
  controlEpoch: ControlEpoch;
  revision: number;
  state: ResourceState;
}>;

export type OperationState = 'intent' | 'attempting' | 'done' | 'unknown' | 'failed';

export type ResourceOperation = Readonly<{
  id: string;
  requestId: string;
  resourceId: ResourceId;
  controlEpoch: ControlEpoch;
  state: OperationState;
  revision: number;
  fingerprint: string;
  result?: unknown;
  observation?: string;
}>;

export type ResourceErrorCode =
  | 'INVALID_COMMAND' | 'RESOURCE_NOT_FOUND' | 'RESOURCE_BUSY' | 'LEASE_EXPIRED'
  | 'STALE_CONTROL' | 'RESOURCE_CONFLICT' | 'OPERATION_NOT_FOUND'
  | 'INVALID_TRANSITION' | 'IDEMPOTENCY_CONFLICT';

/** Stable error codes; the future API error mapping reads `code`, never the message. */
export class ResourceError extends Error {
  constructor(readonly code: ResourceErrorCode) {
    super(code);
    this.name = 'ResourceError';
  }
}

const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TTL_MS = 86_400_000;
const MAX_OBSERVATION_LENGTH = 512;

/** ID/owner rule from the contract: ASCII only, 1..128 characters. */
export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isTtlMs(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value >= 1 && value <= MAX_TTL_MS;
}

export function isObservationText(value: unknown): value is string {
  return typeof value === 'string' && Array.from(value).length <= MAX_OBSERVATION_LENGTH;
}

function assertOwner(value: unknown): asserts value is OwnerId {
  if (!isIdentifier(value)) throw new ResourceError('INVALID_COMMAND');
}

function assertTtl(value: unknown): asserts value is number {
  if (!isTtlMs(value)) throw new ResourceError('INVALID_COMMAND');
}

function assertEpoch(value: unknown): asserts value is number {
  if (!isSafeNonNegativeInteger(value)) throw new ResourceError('INVALID_COMMAND');
}

function assertTime(value: unknown): asserts value is number {
  if (!isSafeNonNegativeInteger(value)) throw new ResourceError('INVALID_COMMAND');
}

function assertObservation(value: unknown): asserts value is string | undefined {
  if (value !== undefined && !isObservationText(value)) throw new ResourceError('INVALID_COMMAND');
}

function expiry(now: number, ttlMs: number): number {
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) throw new ResourceError('INVALID_COMMAND');
  return expiresAt;
}

function activeLease(resource: Resource, now: number): Lease | null {
  const lease = resource.lease;
  return lease !== null && lease.expiresAt > now ? lease : null;
}

export function initialResource(id: ResourceId): Resource {
  if (!isIdentifier(id)) throw new ResourceError('INVALID_COMMAND');
  return {id, owner: null, lease: null, controlEpoch: 0, revision: 0, state: 'idle'};
}

/**
 * Acquire an idle or expired resource. A live lease held by the same owner is a
 * no-op (same reference, no epoch/revision bump); another live owner is RESOURCE_BUSY.
 */
export function acquire(
  resource: Resource,
  input: Readonly<{owner: OwnerId; ttlMs: number}>,
  now: number,
): Resource {
  assertTime(now);
  assertOwner(input.owner);
  assertTtl(input.ttlMs);
  const lease = activeLease(resource, now);
  if (lease) {
    if (lease.owner === input.owner) return resource;
    throw new ResourceError('RESOURCE_BUSY');
  }
  const controlEpoch = resource.controlEpoch + 1;
  return {
    ...resource,
    owner: input.owner,
    lease: {owner: input.owner, expiresAt: expiry(now, input.ttlMs), epoch: controlEpoch},
    controlEpoch,
    revision: resource.revision + 1,
    state: 'leased',
  };
}

export function renew(
  resource: Resource,
  input: Readonly<{owner: OwnerId; epoch: ControlEpoch; ttlMs: number}>,
  now: number,
): Resource {
  assertTime(now);
  assertOwner(input.owner);
  assertEpoch(input.epoch);
  assertTtl(input.ttlMs);
  const lease = activeLease(resource, now);
  if (lease === null) throw new ResourceError('LEASE_EXPIRED');
  if (lease.owner !== input.owner || lease.epoch !== input.epoch) throw new ResourceError('STALE_CONTROL');
  return {...resource, lease: {...lease, expiresAt: expiry(now, input.ttlMs)}, revision: resource.revision + 1};
}

export function release(
  resource: Resource,
  input: Readonly<{owner: OwnerId; epoch: ControlEpoch}>,
): Resource {
  assertOwner(input.owner);
  assertEpoch(input.epoch);
  const lease = resource.lease;
  if (lease === null) {
    // Already idle: releasing again is a no-op, but only for the current control
    // epoch; a stale epoch must never look like a successful release.
    if (resource.controlEpoch !== input.epoch) throw new ResourceError('STALE_CONTROL');
    return resource;
  }
  if (lease.owner !== input.owner || lease.epoch !== input.epoch) throw new ResourceError('STALE_CONTROL');
  return {...resource, owner: null, lease: null, revision: resource.revision + 1, state: 'idle'};
}

/** Take control of the resource regardless of the current lease; old epochs fence out. */
export function takeover(
  resource: Resource,
  input: Readonly<{owner: OwnerId; ttlMs: number}>,
  now: number,
): Resource {
  assertTime(now);
  assertOwner(input.owner);
  assertTtl(input.ttlMs);
  const controlEpoch = resource.controlEpoch + 1;
  return {
    ...resource,
    owner: input.owner,
    lease: {owner: input.owner, expiresAt: expiry(now, input.ttlMs), epoch: controlEpoch},
    controlEpoch,
    revision: resource.revision + 1,
    state: 'leased',
  };
}

/** Clear an expired lease. Does not bump controlEpoch; revision only changes on write. */
export function expire(resource: Resource, now: number): Resource {
  assertTime(now);
  const lease = resource.lease;
  if (lease === null || now < lease.expiresAt) return resource;
  return {...resource, owner: null, lease: null, revision: resource.revision + 1, state: 'idle'};
}

/** Reject callers whose control epoch no longer matches the resource. */
export function assertControl(resource: Resource, epoch: ControlEpoch): void {
  assertEpoch(epoch);
  if (epoch !== resource.controlEpoch) throw new ResourceError('STALE_CONTROL');
}

/* -------------------------------------------------------------------------- */
/* Side-effect operation state machine                                         */
/* -------------------------------------------------------------------------- */

export type Settlement = Readonly<{state: 'done' | 'failed'; result?: unknown}>;
export type Reconciliation = Readonly<{state: 'done' | 'failed'; observation?: string; result?: unknown}>;

function assertSettlementState(value: unknown): asserts value is 'done' | 'failed' {
  if (value !== 'done' && value !== 'failed') throw new ResourceError('INVALID_COMMAND');
}

function withResult(operation: ResourceOperation, result: unknown): ResourceOperation {
  return result === undefined ? operation : {...operation, result};
}

/** intent -> attempting. The external action has not happened yet at this point. */
export function attempt(operation: ResourceOperation): ResourceOperation {
  if (operation.state !== 'intent') throw new ResourceError('INVALID_TRANSITION');
  return {...operation, state: 'attempting', revision: operation.revision + 1};
}

/**
 * attempting -> done | failed. Terminal operations are returned untouched, so a
 * repeated settlement is idempotent and never writes again.
 */
export function settle(operation: ResourceOperation, settlement: Settlement): ResourceOperation {
  assertSettlementState(settlement.state);
  if (operation.state === 'done' || operation.state === 'failed') return operation;
  if (operation.state !== 'attempting') throw new ResourceError('INVALID_TRANSITION');
  return withResult(
    {...operation, state: settlement.state, revision: operation.revision + 1},
    settlement.result,
  );
}

/**
 * intent -> failed cancellation. Used when control is lost before dispatch (stale
 * epoch or vanished resource): the effect must never run, and the intent is closed
 * with the stable error code as its result.
 */
export function cancel(operation: ResourceOperation, code: string): ResourceOperation {
  if (!isIdentifier(code)) throw new ResourceError('INVALID_COMMAND');
  if (operation.state !== 'intent') throw new ResourceError('INVALID_TRANSITION');
  return {...operation, state: 'failed', revision: operation.revision + 1, result: code};
}

/**
 * attempting -> unknown. `unknown` is a conservative terminal state: it can only
 * be reconciled by observation, never re-attempted and never replayed.
 */
export function markUnknown(operation: ResourceOperation, observation?: string): ResourceOperation {
  assertObservation(observation);
  if (operation.state !== 'attempting') throw new ResourceError('INVALID_TRANSITION');
  return {
    ...operation,
    state: 'unknown',
    revision: operation.revision + 1,
    ...(observation === undefined ? {} : {observation}),
  };
}

/** unknown -> done | failed, settled by an external observation. */
export function reconcile(operation: ResourceOperation, reconciliation: Reconciliation): ResourceOperation {
  assertSettlementState(reconciliation.state);
  assertObservation(reconciliation.observation);
  if (operation.state === 'done' || operation.state === 'failed') return operation;
  if (operation.state !== 'unknown') throw new ResourceError('INVALID_TRANSITION');
  const settled = withResult(
    {...operation, state: reconciliation.state, revision: operation.revision + 1},
    reconciliation.result,
  );
  return reconciliation.observation === undefined ? settled : {...settled, observation: reconciliation.observation};
}
