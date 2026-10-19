/**
 * Resource application boundary.
 *
 * Version-1 commands (no `options.secure`) keep the memory/callback behaviour used by
 * the original contract tests. Secure mode (used by `openRuntime`) binds every
 * operation to a registered effect kind and a bounded canonical payload, fences
 * dispatch on owner + live lease + epoch + attempt token, hands the adapter an
 * AbortSignal/deadline, requires evidence-bound reconciliation and rejects the
 * version-1 callback contract.
 *
 * Platform independent: no `node:` imports, no SDK imports, no crypto. Canonical JSON
 * and payload hashing are pure/injected (composition root injects sha256).
 */

import {
  ResourceError,
  acquire,
  assertControl,
  assertSecureOperation,
  attempt,
  attemptWithToken,
  cancel,
  initialResource,
  isIdentifier,
  isJsonObject,
  isObservationText,
  isSafeNonNegativeInteger,
  isTtlMs,
  markAttemptUnknown,
  markUnknown,
  reconcile,
  reconcileWithEvidence,
  release,
  renew,
  settle,
  settleAttempt,
  takeover,
  type JsonObject,
  type JsonValue,
  type Resource,
  type ResourceEffect,
  type ResourceErrorCode,
  type ResourceId,
  type ResourceOperation,
  type SecureResourceOperation,
} from '../domain/resource.js';

export type CommandReceipt = Readonly<{fingerprint: string; result: unknown}>;

export type ResourceMutation = Readonly<{
  /** Multiple records of one business result must land in a single commit. */
  resource?: Readonly<{value: Resource; expectedRevision: number | undefined}>;
  operation?: Readonly<{
    value: ResourceOperation;
    expectedRevision: number | undefined;
    /** Secure CAS: the settlement only wins while this attempt token is still current. */
    expectedAttemptToken?: string | null;
  }>;
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

export type EffectInvocation = Readonly<{
  /** Aborted by the application on deadline. */
  signal: AbortSignal;
  /** Absolute deadline in milliseconds (same value persisted on the operation). */
  deadline: number;
}>;

/**
 * External abilities implement only this port. Secure adapters receive the invocation
 * options; version-1 test callbacks may ignore the second argument.
 */
export interface ResourceEffectPort {
  invoke(operation: ResourceOperation, invocation?: EffectInvocation): Promise<unknown>;
}

/** A capability's bounds and schema checks; adapters own the concrete rules. */
export interface EffectDefinition {
  readonly kind: string;
  readonly maxPayloadBytes: number;
  readonly maxResultBytes: number;
  readonly maxEvidenceBytes: number;
  /** Reject non-JSON/unsafe/oversized payloads for this capability. */
  validatePayload(payload: JsonObject): void;
  /** Version-1 compatibility overload (adapters may ignore the binding arguments). */
  validateResult(result: JsonValue): void;
  /**
   * Reject results that must not be persisted as `done`. The persisted payload (and,
   * for reconciliation, the evidence) is supplied so a result cannot be forged with
   * schema-valid values that contradict the capability's payload/evidence.
   */
  validateResult(result: JsonValue, evidence: JsonObject | undefined, payload: JsonObject): void;
  /** Version-1 compatibility overload (adapters may ignore the binding argument). */
  validateEvidence(evidence: JsonObject): void;
  /**
   * Reject evidence that is not this capability's proof for the persisted payload
   * (schema/hash/bytes/path/redaction/size). The same evidence must also be accepted
   * by `validateResult` for a `done` reconciliation.
   */
  validateEvidence(evidence: JsonObject, payload: JsonObject): void;
}

export type RegisteredEffect = Readonly<{
  definition: EffectDefinition;
  effect: ResourceEffectPort;
}>;

/** Closed registry of capability kinds; callers cannot substitute dynamic effects. */
export interface EffectRegistry {
  resolve(kind: string): RegisteredEffect | undefined;
}

/** Convenience registry builder used by secure tests and adapter factories. */
export function createEffectRegistry(entries: readonly RegisteredEffect[]): EffectRegistry {
  const byKind = new Map<string, RegisteredEffect>();
  for (const entry of entries) {
    if (!isIdentifier(entry.definition.kind) || byKind.has(entry.definition.kind)) {
      throw new ResourceError('INVALID_COMMAND');
    }
    byKind.set(entry.definition.kind, entry);
  }
  return {resolve: kind => byKind.get(kind)};
}

/** Adapters use a known failure for "definitely happened"; every other throw becomes `unknown`. */
export class EffectFailure extends Error {
  constructor(readonly certainty: 'failed' | 'unknown', readonly code: string) {
    super(code);
    this.name = 'EffectFailure';
  }
}

export type ResourceCommandOptions = Readonly<{
  /** Enables the secure effect protocol; absent keeps the version-1 test contract. */
  secure?: true;
  effects?: EffectRegistry;
  /** Hash of the canonical payload; composition injects sha256 (default canonical text). */
  hash?: (canonical: string) => string;
  /** Attempt token factory; composition injects a UUID (default deterministic counter). */
  token?: () => string;
  /** Default absolute deadline window for secure operations without an explicit deadline. */
  deadlineMs?: number;
}>;

export interface ResourceCommands {
  acquire(input: unknown): Promise<Resource>;
  renew(input: unknown): Promise<Resource>;
  release(input: unknown): Promise<Resource>;
  takeover(input: unknown): Promise<Resource>;
  read(id: string): Promise<Resource | undefined>;

  beginOperation(input: unknown): Promise<ResourceOperation>;
  /**
   * Secure mode dispatches only the effect registered on this command instance.
   * No caller-supplied registry is accepted; the extra overloads exist only for
   * source compatibility and are rejected at runtime.
   */
  runOperation(operationId: string): Promise<ResourceOperation>;
  runOperation(operationId: string, registry: EffectRegistry): Promise<ResourceOperation>;
  /** Version-1 compatibility only: callback dispatch, not available in secure mode. */
  runOperation(operationId: string, effect: ResourceEffectPort): Promise<ResourceOperation>;
  /** Secure recovery of an expired `attempting` attempt (explicit, never automatic). */
  recoverOperation(input: unknown): Promise<ResourceOperation>;
  /** Secure mode: evidence/observer/payload-bound reconciliation of `unknown`. */
  observeOperation(input: unknown): Promise<ResourceOperation>;
}

/* -------------------------------------------------------------------------- */
/* Canonical JSON / JSON boundaries                                            */
/* -------------------------------------------------------------------------- */

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

/** Strict JSON conversion; a value that cannot be persisted faithfully is rejected. */
function toJsonValue(value: unknown): JsonValue {
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

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

function assertHashText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384 || /\p{Cc}/u.test(value)) {
    throw new ResourceError('INVALID_COMMAND');
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
  command: 'beginOperation';
  operationId: string;
  requestId: string;
  resourceId: string;
  controlEpoch: number;
  effect?: Readonly<{kind: string; payload: JsonObject}>;
  deadline?: number;
}>;
type ObserveOperationCommand = Readonly<{
  command: 'observeOperation';
  operationId: string;
  status: 'done' | 'failed';
  observation?: string;
  result?: unknown;
  evidence?: JsonObject;
  observer?: string;
  payloadHash?: string;
  controlEpoch?: number;
}>;
type RecoverOperationCommand = Readonly<{
  command: 'recoverOperation'; operationId: string; observer: string; reason: string;
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

function parseBeginOperation(input: unknown, secure: boolean): BeginOperationCommand {
  const allowed = secure
    ? ['operationId', 'requestId', 'resourceId', 'controlEpoch', 'effect', 'deadline']
    : ['operationId', 'requestId', 'resourceId', 'controlEpoch'];
  const required = secure
    ? ['operationId', 'requestId', 'resourceId', 'controlEpoch', 'effect']
    : ['operationId', 'requestId', 'resourceId', 'controlEpoch'];
  const value = parseObject(input, allowed, required);
  let effect: Readonly<{kind: string; payload: JsonObject}> | undefined;
  if (secure) {
    const raw = parseObject(value.effect, ['kind', 'payload'], ['kind', 'payload']);
    if (!isJsonObject(raw.payload)) throw new ResourceError('INVALID_COMMAND');
    effect = {kind: identifier(raw.kind), payload: raw.payload};
  }
  const deadline = value.deadline === undefined ? undefined : epoch(value.deadline);
  return {
    command: 'beginOperation',
    operationId: identifier(value.operationId),
    requestId: identifier(value.requestId),
    resourceId: identifier(value.resourceId),
    controlEpoch: epoch(value.controlEpoch),
    ...(effect === undefined ? {} : {effect}),
    ...(deadline === undefined ? {} : {deadline}),
  };
}

function parseObserveOperation(input: unknown, secure: boolean): ObserveOperationCommand {
  const allowed = secure
    ? ['operationId', 'status', 'observation', 'result', 'evidence', 'observer', 'payloadHash', 'controlEpoch']
    : ['operationId', 'status', 'observation', 'result'];
  const required = secure
    ? ['operationId', 'status', 'evidence', 'observer', 'payloadHash', 'controlEpoch']
    : ['operationId', 'status'];
  const value = parseObject(input, allowed, required);
  const status = value.status;
  if (status !== 'done' && status !== 'failed') throw new ResourceError('INVALID_COMMAND');
  const observation = value.observation;
  if (observation !== undefined && !isObservationText(observation)) throw new ResourceError('INVALID_COMMAND');
  const command: ObserveOperationCommand = {
    command: 'observeOperation',
    operationId: identifier(value.operationId),
    status,
    ...(observation === undefined ? {} : {observation}),
    ...(Object.hasOwn(value, 'result') ? {result: value.result} : {}),
  };
  if (!secure) return command;
  if (!isJsonObject(value.evidence)) throw new ResourceError('INVALID_EVIDENCE');
  const observer = identifier(value.observer);
  const payloadHash = value.payloadHash;
  assertHashText(payloadHash);
  return {...command, evidence: value.evidence, observer, payloadHash, controlEpoch: epoch(value.controlEpoch)};
}

function parseRecoverOperation(input: unknown): RecoverOperationCommand {
  const value = parseObject(input, ['operationId', 'observer', 'reason'], ['operationId', 'observer', 'reason']);
  const reason = value.reason;
  if (typeof reason !== 'string' || !reason || Array.from(reason).length > 512) {
    throw new ResourceError('INVALID_COMMAND');
  }
  return {command: 'recoverOperation', operationId: identifier(value.operationId), observer: identifier(value.observer), reason};
}

/* -------------------------------------------------------------------------- */
/* Version-1 resource writes                                                   */
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
function controlFailure(resource: Resource, epochValue: number): 'STALE_CONTROL' | null {
  try {
    assertControl(resource, epochValue);
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

/** Version-1 dispatch exactly once; any failure that is not a known `failed` is `unknown`. */
async function dispatchLegacy(effect: ResourceEffectPort, operation: ResourceOperation): Promise<ResourceOperation> {
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

/* -------------------------------------------------------------------------- */
/* Secure protocol helpers                                                     */
/* -------------------------------------------------------------------------- */

type FenceFailure = 'STALE_CONTROL' | 'LEASE_EXPIRED';

/**
 * Live ownership fence used before dispatch: the resource must still exist, the
 * lease must be unexpired, and owner + epoch must match the stored operation.
 */
function dispatchFence(resource: Resource, operation: SecureResourceOperation, timestamp: number): FenceFailure | null {
  if (resource.controlEpoch !== operation.controlEpoch) return 'STALE_CONTROL';
  const lease = resource.lease;
  if (lease === null || lease.expiresAt <= timestamp) return 'LEASE_EXPIRED';
  if (lease.owner !== operation.owner || lease.epoch !== operation.controlEpoch) return 'STALE_CONTROL';
  return null;
}

async function cancelSecureIntent(
  store: ResourceStore,
  operation: ResourceOperation,
  code: 'STALE_CONTROL' | 'LEASE_EXPIRED' | 'RESOURCE_NOT_FOUND' | 'EFFECT_NOT_REGISTERED' | 'DEADLINE_EXCEEDED',
): Promise<never> {
  const cancelled = cancel(operation, code);
  await store.commit(operation.resourceId, {operation: {value: cancelled, expectedRevision: operation.revision}});
  throw new ResourceError(code);
}

/** Validate a capability result against its persisted payload/evidence before `done`. */
function acceptResult(
  definition: EffectDefinition,
  value: unknown,
  evidence: JsonObject | undefined,
  payload: JsonObject,
): JsonValue {
  const result = toJsonValue(value);
  definition.validateResult(result, evidence, payload);
  if (jsonBytes(result) > definition.maxResultBytes) throw new ResourceError('RESULT_REJECTED');
  return result;
}

/** Validate capability evidence AND its binding to the persisted effect payload. */
function validateEvidence(definition: EffectDefinition, evidence: JsonObject, payload: JsonObject): void {
  definition.validateEvidence(evidence, payload);
  if (jsonBytes(evidence) > definition.maxEvidenceBytes) throw new ResourceError('INVALID_EVIDENCE');
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

export function resourceCommands(
  store: ResourceStore,
  now: () => number,
  fingerprint: (value: unknown) => string = canonicalJson,
  options: ResourceCommandOptions = {},
): ResourceCommands {
  const secure = options.secure === true;
  const hash = options.hash ?? ((canonical: string) => canonical);
  const deadlineMs = options.deadlineMs ?? 30_000;
  let tokenSequence = 0;
  const nextToken = options.token ?? (() => `attempt-${++tokenSequence}`);
  const registry: EffectRegistry = options.effects ?? {resolve: () => undefined};

  async function runSecureOperation(operationId: string, effects: EffectRegistry): Promise<ResourceOperation> {
    if (!isIdentifier(operationId)) throw new ResourceError('INVALID_COMMAND');
    const operation = await store.loadOperation(operationId);
    if (operation === undefined) throw new ResourceError('OPERATION_NOT_FOUND');
    if (operation.state === 'done' || operation.state === 'failed' || operation.state === 'unknown') return operation;
    if (operation.state === 'attempting') {
      assertSecureOperation(operation);
      const timestamp = now();
      // A live attempt is never converted to unknown by a concurrent caller.
      if (operation.attemptToken !== null && operation.deadline > timestamp) throw new ResourceError('IN_PROGRESS');
      throw new ResourceError('RECOVERY_REQUIRED');
    }
    assertSecureOperation(operation);
    const registered = effects.resolve(operation.effect.kind);
    if (registered === undefined) return cancelSecureIntent(store, operation, 'EFFECT_NOT_REGISTERED');
    const timestamp = now();
    if (timestamp >= operation.deadline) return cancelSecureIntent(store, operation, 'DEADLINE_EXCEEDED');
    const loaded = await store.load(operation.resourceId);
    if (loaded === undefined) return cancelSecureIntent(store, operation, 'RESOURCE_NOT_FOUND');
    const blocked = dispatchFence(loaded, operation, timestamp);
    if (blocked !== null) return cancelSecureIntent(store, operation, blocked);

    const attemptToken = nextToken();
    if (!isIdentifier(attemptToken)) throw new ResourceError('INVALID_COMMAND');
    const dispatching = attemptWithToken(operation, {token: attemptToken, startedAt: timestamp, deadline: operation.deadline});
    let guard = loaded;
    let retries = 0;
    for (;;) {
      try {
        await store.commit(operation.resourceId, {
          operation: {value: dispatching, expectedRevision: operation.revision},
          resource: {value: guard, expectedRevision: guard.revision},
        });
        break;
      } catch (error) {
        if (!(error instanceof ResourceError) || error.code !== 'RESOURCE_CONFLICT') throw error;
        const reread = await store.loadOperation(operationId);
        if (reread === undefined) throw new ResourceError('OPERATION_NOT_FOUND');
        if (reread.state !== 'intent') return reread;
        const rereadResource = await store.load(operation.resourceId);
        if (rereadResource === undefined) return cancelSecureIntent(store, reread, 'RESOURCE_NOT_FOUND');
        const rereadBlocked = dispatchFence(rereadResource, reread as SecureResourceOperation, now());
        if (rereadBlocked !== null) return cancelSecureIntent(store, reread, rereadBlocked);
        if (retries >= MAX_ATTEMPT_RETRIES) throw error;
        retries += 1;
        guard = rereadResource;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, operation.deadline - now()));
    let settled: ResourceOperation;
    try {
      let result: unknown;
      let certainty: 'failed' | 'unknown' | 'done' = 'done';
      let code = '';
      try {
        result = await registered.effect.invoke(dispatching, {signal: controller.signal, deadline: operation.deadline});
      } catch (error) {
        if (error instanceof EffectFailure) {
          certainty = error.certainty;
          code = error.code;
        } else {
          certainty = 'unknown';
        }
      }
      const finishedAt = now();
      if (controller.signal.aborted || finishedAt >= operation.deadline) {
        // A late result after the deadline is never turned into success.
        settled = markAttemptUnknown(dispatching, {token: attemptToken, observation: 'deadline-exceeded'});
      } else if (certainty === 'failed') {
        settled = settleAttempt(dispatching, {state: 'failed', token: attemptToken, result: code});
      } else if (certainty === 'unknown') {
        settled = markAttemptUnknown(dispatching, {token: attemptToken, observation: code || 'effect-unknown'});
      } else {
        try {
          settled = settleAttempt(dispatching, {
            state: 'done', token: attemptToken,
            result: acceptResult(registered.definition, result, undefined, operation.effect.payload),
          });
        } catch (error) {
          if (!(error instanceof ResourceError)) throw error;
          // The effect may have happened, so an unusable result is unknown, never success.
          settled = markAttemptUnknown(dispatching, {token: attemptToken, observation: 'result-rejected'});
        }
      }
    } finally {
      clearTimeout(timer);
    }

    try {
      await store.commit(operation.resourceId, {
        operation: {value: settled, expectedRevision: dispatching.revision, expectedAttemptToken: attemptToken},
      });
    } catch (error) {
      if (error instanceof ResourceError && error.code === 'RESOURCE_CONFLICT') {
        // Another worker (or an explicit recovery) won the CAS: report the current truth.
        const reread = await store.loadOperation(operationId);
        if (reread === undefined) throw new ResourceError('OPERATION_NOT_FOUND');
        if (reread.state !== 'attempting') return reread;
      }
      throw error;
    }
    return settled;
  }

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
      const command = parseBeginOperation(input, secure);
      if (!secure) {
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
        await store.commit(command.resourceId, {
          resource: {value: resource, expectedRevision: resource.revision},
          operation: {value: operation, expectedRevision: undefined},
        });
        return operation;
      }

      if (command.effect === undefined) throw new ResourceError('INVALID_COMMAND');
      // The fingerprint only needs canonical payload + hash, so a replay can be
      // detected (and returned) before capability validation: a config change must
      // never turn an accepted operation into an error.
      const payloadHash = hash(canonicalJson(command.effect.payload));
      assertHashText(payloadHash);
      const timestamp = now();
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new ResourceError('INVALID_COMMAND');
      const operationDeadline = command.deadline ?? timestamp + deadlineMs;
      if (!Number.isSafeInteger(operationDeadline)) throw new ResourceError('INVALID_COMMAND');
      const effectFingerprint = fingerprint({
        command: 'beginOperation',
        operationId: command.operationId,
        requestId: command.requestId,
        resourceId: command.resourceId,
        controlEpoch: command.controlEpoch,
        effectKind: command.effect.kind,
        payloadHash,
        // The command identity uses the caller's deadline (null when omitted), never
        // the resolved default: a replay later must not look like a different command.
        deadline: command.deadline ?? null,
      });
      const existing = await store.findOperation(command.resourceId, command.requestId);
      if (existing !== undefined) {
        if (existing.fingerprint !== effectFingerprint) throw new ResourceError('IDEMPOTENCY_CONFLICT');
        assertSecureOperation(existing);
        return existing;
      }
      const registered = registry.resolve(command.effect.kind);
      if (registered === undefined) throw new ResourceError('EFFECT_NOT_REGISTERED');
      registered.definition.validatePayload(command.effect.payload);
      if (jsonBytes(command.effect.payload) > registered.definition.maxPayloadBytes) {
        throw new ResourceError('PAYLOAD_REJECTED');
      }
      const resource = await store.load(command.resourceId);
      if (resource === undefined) throw new ResourceError('RESOURCE_NOT_FOUND');
      const lease = resource.lease;
      if (lease === null || lease.expiresAt <= timestamp) throw new ResourceError('LEASE_EXPIRED');
      if (lease.epoch !== command.controlEpoch) throw new ResourceError('STALE_CONTROL');
      const normalizedPayload = toJsonValue(command.effect.payload) as JsonObject;
      const effect: ResourceEffect = {kind: command.effect.kind, payload: normalizedPayload, payloadHash};
      const operation: SecureResourceOperation = {
        id: command.operationId,
        requestId: command.requestId,
        resourceId: command.resourceId,
        controlEpoch: command.controlEpoch,
        state: 'intent',
        revision: 0,
        fingerprint: effectFingerprint,
        owner: lease.owner,
        effect,
        attemptToken: null,
        attemptStartedAt: null,
        deadline: operationDeadline,
      };
      await store.commit(command.resourceId, {
        resource: {value: resource, expectedRevision: resource.revision},
        operation: {value: operation, expectedRevision: undefined},
      });
      return operation;
    },

    async runOperation(operationId: string, effectOrRegistry?: ResourceEffectPort | EffectRegistry) {
      if (secure) {
        // The registry is runtime-owned: a caller may omit the argument or hand back
        // the exact bound registry, but a substitute registry of the same kind is
        // rejected before any operation read or effect invocation.
        if (effectOrRegistry !== undefined && effectOrRegistry !== registry) {
          throw new ResourceError('INVALID_COMMAND');
        }
        return runSecureOperation(operationId, registry);
      }
      const effect = effectOrRegistry as ResourceEffectPort;
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
          await store.commit(operation.resourceId, {
            operation: {value: dispatching, expectedRevision: operation.revision},
            resource: {value: resource, expectedRevision: resource.revision},
          });
          break;
        } catch (error) {
          if (!(error instanceof ResourceError) || error.code !== 'RESOURCE_CONFLICT') throw error;
          if (retries >= MAX_ATTEMPT_RETRIES) throw error;
          retries += 1;
          const reread = await store.load(operation.resourceId);
          if (reread === undefined) return cancelIntent(store, operation, 'RESOURCE_NOT_FOUND');
          const rereadBlocked = controlFailure(reread, operation.controlEpoch);
          if (rereadBlocked !== null) return cancelIntent(store, operation, rereadBlocked);
          resource = reread;
        }
      }
      const settled = await dispatchLegacy(effect, dispatching);
      await store.commit(operation.resourceId, {operation: {value: settled, expectedRevision: dispatching.revision}});
      return settled;
    },

    async recoverOperation(input) {
      if (!secure) throw new ResourceError('INVALID_COMMAND');
      const command = parseRecoverOperation(input);
      const operation = await store.loadOperation(command.operationId);
      if (operation === undefined) throw new ResourceError('OPERATION_NOT_FOUND');
      assertSecureOperation(operation);
      if (operation.state === 'unknown') return operation;
      if (operation.state !== 'attempting') throw new ResourceError('INVALID_TRANSITION');
      if (command.observer !== operation.owner) throw new ResourceError('STALE_CONTROL');
      const timestamp = now();
      if (operation.deadline > timestamp) throw new ResourceError('RECOVERY_REQUIRED');
      const recovered = markAttemptUnknown(operation, {observation: `recovered:${command.reason}`});
      try {
        await store.commit(operation.resourceId, {
          operation: {value: recovered, expectedRevision: operation.revision, expectedAttemptToken: operation.attemptToken},
        });
      } catch (error) {
        if (error instanceof ResourceError && error.code === 'RESOURCE_CONFLICT') {
          const reread = await store.loadOperation(command.operationId);
          if (reread === undefined) throw new ResourceError('OPERATION_NOT_FOUND');
          if (reread.state === 'unknown') return reread;
        }
        throw error;
      }
      return recovered;
    },

    async observeOperation(input) {
      const command = parseObserveOperation(input, secure);
      const operation = await store.loadOperation(command.operationId);
      if (operation === undefined) throw new ResourceError('OPERATION_NOT_FOUND');
      if (operation.state === 'done' || operation.state === 'failed') return operation;
      if (operation.state !== 'unknown') throw new ResourceError('INVALID_TRANSITION');
      if (!secure) {
        const reconciled = reconcile(operation, {
          state: command.status,
          ...(command.observation === undefined ? {} : {observation: command.observation}),
          ...(command.result === undefined ? {} : {result: command.result}),
        });
        await store.commit(operation.resourceId, {operation: {value: reconciled, expectedRevision: operation.revision}});
        return reconciled;
      }
      assertSecureOperation(operation);
      if (command.evidence === undefined || command.observer === undefined
        || command.payloadHash === undefined || command.controlEpoch === undefined) {
        throw new ResourceError('INVALID_EVIDENCE');
      }
      // Observer binding: only the owner of this exact control epoch may reconcile.
      if (command.observer !== operation.owner) throw new ResourceError('STALE_CONTROL');
      if (command.controlEpoch !== operation.controlEpoch) throw new ResourceError('STALE_CONTROL');
      if (command.payloadHash !== operation.effect.payloadHash) throw new ResourceError('INVALID_EVIDENCE');
      const resource = await store.load(operation.resourceId);
      if (resource === undefined) throw new ResourceError('RESOURCE_NOT_FOUND');
      if (resource.controlEpoch !== operation.controlEpoch) throw new ResourceError('STALE_CONTROL');
      const currentOwner = resource.lease?.owner ?? resource.owner;
      if (currentOwner !== operation.owner) throw new ResourceError('STALE_CONTROL');
      const registered = registry.resolve(operation.effect.kind);
      if (registered === undefined) throw new ResourceError('EFFECT_NOT_REGISTERED');
      validateEvidence(registered.definition, command.evidence, operation.effect.payload);
      const result = command.result === undefined
        ? undefined
        : acceptResult(registered.definition, command.result, command.evidence, operation.effect.payload);
      const reconciled = reconcileWithEvidence(operation, {
        state: command.status,
        evidence: command.evidence,
        observer: command.observer,
        payloadHash: command.payloadHash,
        ...(result === undefined ? {} : {result}),
        ...(command.observation === undefined ? {} : {observation: command.observation}),
      });
      await store.commit(operation.resourceId, {operation: {value: reconciled, expectedRevision: operation.revision}});
      return reconciled;
    },
  } satisfies ResourceCommands;
}

export type { ResourceErrorCode };
