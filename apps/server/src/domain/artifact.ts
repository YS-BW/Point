/**
 * Pure artifact rules for WP1b.3: identity, name/size/hash validation, the
 * writing -> sealed transition and the verification vocabulary.
 *
 * Only a `sealed` artifact whose file still matches its recorded sha256/bytes may
 * be treated as success; `writing`, `unknown` and `failed` never are. No IO and no
 * platform imports here: the runtime layer owns files and hashing, the application
 * layer owns commands and ports.
 */

export type ArtifactState = 'writing' | 'sealed' | 'unknown' | 'failed';

export type Artifact = Readonly<{
  id: string;
  jobId: string;
  attemptId: string;
  revision: number;
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  state: ArtifactState;
  createdAt: number;
  sealedAt?: number;
}>;

export type ArtifactErrorCode =
  | 'INVALID_COMMAND'
  | 'ARTIFACT_CONFLICT'
  | 'ARTIFACT_TOO_LARGE'
  | 'ARTIFACT_WRITE_FAILED'
  | 'NOT_EXECUTION_CONVERSATION'
  | 'JOB_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  | 'STALE_ATTEMPT'
  | 'JOB_NOT_RUNNING';

/** Stable artifact codes; the runtime tool maps them to tool error results. */
export class ArtifactError extends Error {
  constructor(readonly code: ArtifactErrorCode) {
    super(code);
    this.name = 'ArtifactError';
  }
}

/** UTF-8 content limit from the contract (256 KiB). */
export const MAX_ARTIFACT_BYTES = 262_144;

const ARTIFACT_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const ARTIFACT_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const OWNER_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PATH_LENGTH = 4096;

const encoder = new TextEncoder();

/** UTF-8 byte length of a string, without importing a platform module. */
export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

/** File name rule: safe characters only, never `.`, `..` or any `..` sequence. */
export function isArtifactName(value: unknown): value is string {
  return typeof value === 'string'
    && ARTIFACT_NAME.test(value)
    && value !== '.'
    && !value.includes('..');
}

export function isArtifactId(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_ID.test(value);
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

/** Job/attempt ids are path segments, so they exclude path separators and `..`. */
export function isArtifactOwnerId(value: unknown): value is string {
  return typeof value === 'string' && OWNER_ID.test(value) && value !== '.' && !value.includes('..');
}

function assertOwnerId(value: unknown): asserts value is string {
  if (!isArtifactOwnerId(value)) throw new ArtifactError('INVALID_COMMAND');
}

function assertCount(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ArtifactError('INVALID_COMMAND');
  }
}

function assertPath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || Array.from(value).length > MAX_PATH_LENGTH || /\p{Cc}/u.test(value)) {
    throw new ArtifactError('INVALID_COMMAND');
  }
}

export type ArtifactInput = Readonly<{
  id: string;
  jobId: string;
  attemptId: string;
  revision: number;
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  createdAt: number;
}>;

/** A new artifact starts as `writing`: the intent is durable before any file exists. */
export function initialArtifact(input: ArtifactInput): Artifact {
  if (!isArtifactId(input.id)) throw new ArtifactError('INVALID_COMMAND');
  assertOwnerId(input.jobId);
  assertOwnerId(input.attemptId);
  assertCount(input.revision);
  if (!isArtifactName(input.name)) throw new ArtifactError('INVALID_COMMAND');
  assertPath(input.path);
  if (!isSha256(input.sha256)) throw new ArtifactError('INVALID_COMMAND');
  assertCount(input.bytes);
  if (input.bytes > MAX_ARTIFACT_BYTES) throw new ArtifactError('ARTIFACT_TOO_LARGE');
  assertCount(input.createdAt);
  return {
    id: input.id,
    jobId: input.jobId,
    attemptId: input.attemptId,
    revision: input.revision,
    name: input.name,
    path: input.path,
    sha256: input.sha256,
    bytes: input.bytes,
    state: 'writing',
    createdAt: input.createdAt,
  };
}

/** writing/unknown/failed -> sealed; sealing twice is a no-op returning the same value. */
export function sealArtifact(artifact: Artifact, sealedAt: number): Artifact {
  assertCount(sealedAt);
  if (artifact.state === 'sealed') return artifact;
  return {...artifact, state: 'sealed', sealedAt};
}

/** Any non-sealed state -> failed. A sealed artifact is never downgraded. */
export function failArtifact(artifact: Artifact): Artifact {
  if (artifact.state === 'sealed' || artifact.state === 'failed') return artifact;
  return {...artifact, state: 'failed'};
}

export type ArtifactVerifyReason =
  | 'NOT_SEALED'
  | 'FILE_MISSING'
  | 'FILE_UNREADABLE'
  | 'HASH_MISMATCH'
  | 'SIZE_MISMATCH';

/** Verification outcome for one artifact: only `verified === true` counts as success. */
export type ArtifactVerification = Readonly<{
  artifact: Artifact;
  verified: boolean;
  reason?: ArtifactVerifyReason;
}>;
