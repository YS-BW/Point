/**
 * Artifact application boundary: the idempotent save flow (writing intent ->
 * atomic file -> sealed record) and verification. Ports keep persistence and
 * filesystem concerns out of the domain; hashing and time are injected so this
 * module stays platform independent.
 */

import {
  ArtifactError,
  MAX_ARTIFACT_BYTES,
  failArtifact,
  initialArtifact,
  isArtifactId,
  isArtifactName,
  isArtifactOwnerId,
  isSha256,
  sealArtifact,
  utf8Bytes,
  type Artifact,
  type ArtifactVerification,
  type ArtifactVerifyReason,
} from '../domain/artifact.js';

/** Persistence port. `save` is the atomic seal/record boundary. */
export interface ArtifactStore {
  load(artifactId: string): Promise<Artifact | undefined>;
  /**
   * Atomically persist one artifact state. Creating is allowed; a sealed document
   * is never overwritten; a different sha256/name/path/identity is ARTIFACT_CONFLICT.
   * Returns the committed value (which may already be sealed by a concurrent call).
   */
  save(artifact: Artifact): Promise<Artifact>;
}

export type ArtifactFileInspection =
  | Readonly<{status: 'read'; sha256: string; bytes: number}>
  | Readonly<{status: 'missing'}>
  | Readonly<{status: 'unreadable'}>;

/** Filesystem port: the only place that touches artifact bytes. */
export interface ArtifactFilePort {
  /** tmp (same directory) -> fsync -> rename; never exposes a partial file. */
  write(artifact: Artifact, content: string): Promise<void>;
  /** Recompute sha256/bytes from the recorded path; never deletes evidence. */
  inspect(artifact: Artifact): Promise<ArtifactFileInspection>;
}

export type SaveArtifactInput = Readonly<{
  artifactId: string;
  jobId: string;
  attemptId: string;
  revision: number;
  name: string;
  path: string;
  content: string;
}>;

export interface ArtifactCommands {
  /** Idempotent by artifactId + sha256; rejects different content with ARTIFACT_CONFLICT. */
  save(input: SaveArtifactInput): Promise<Artifact>;
  get(artifactId: string): Promise<Artifact | undefined>;
  /** Undefined when the document is missing; `verified` is true only for a sealed, matching file. */
  verify(artifactId: string): Promise<ArtifactVerification | undefined>;
}

export type ArtifactCommandOptions = Readonly<{
  sha256(content: string): string;
  now(): number;
}>;

function failure(artifact: Artifact, reason: ArtifactVerifyReason): ArtifactVerification {
  return {artifact, verified: false, reason};
}

function assertSaveInput(input: SaveArtifactInput): void {
  if (!isArtifactId(input.artifactId)
    || !isArtifactOwnerId(input.jobId)
    || !isArtifactOwnerId(input.attemptId)
    || !Number.isSafeInteger(input.revision) || input.revision < 0
    || !isArtifactName(input.name)
    || typeof input.path !== 'string' || !input.path || Array.from(input.path).length > 4096
    || /\p{Cc}/u.test(input.path)
    || typeof input.content !== 'string') {
    throw new ArtifactError('INVALID_COMMAND');
  }
}

export function artifactCommands(
  store: ArtifactStore,
  files: ArtifactFilePort,
  options: ArtifactCommandOptions,
): ArtifactCommands {
  return {
    async save(input) {
      assertSaveInput(input);
      const sha256 = options.sha256(input.content);
      if (!isSha256(sha256)) throw new ArtifactError('INVALID_COMMAND');
      const bytes = utf8Bytes(input.content);
      if (bytes > MAX_ARTIFACT_BYTES) throw new ArtifactError('ARTIFACT_TOO_LARGE');

      const existing = await store.load(input.artifactId);
      if (existing !== undefined) {
        if (existing.jobId !== input.jobId
          || existing.attemptId !== input.attemptId
          || existing.revision !== input.revision
          || existing.name !== input.name
          || existing.path !== input.path
          || existing.sha256 !== sha256) {
          throw new ArtifactError('ARTIFACT_CONFLICT');
        }
        if (existing.state === 'sealed') return existing;
      }

      const writing = existing ?? initialArtifact({
        id: input.artifactId,
        jobId: input.jobId,
        attemptId: input.attemptId,
        revision: input.revision,
        name: input.name,
        path: input.path,
        sha256,
        bytes,
        createdAt: options.now(),
      });
      // Record the intent before creating any file: a crash here leaves `writing`,
      // which verification can never mistake for success.
      const current = existing === undefined ? await store.save(writing) : writing;
      if (current.state === 'sealed') return current;

      try {
        await files.write(current, input.content);
      } catch {
        // Best effort: mark the intent failed, but leave the record for verification
        // either way. A failed seal attempt must never look like success.
        try { await store.save(failArtifact(current)); } catch { /* keep writing for audit */ }
        throw new ArtifactError('ARTIFACT_WRITE_FAILED');
      }

      const committed = await store.save(sealArtifact(current, options.now()));
      if (committed.state !== 'sealed') throw new ArtifactError('ARTIFACT_CONFLICT');
      return committed;
    },

    async get(artifactId) {
      if (!isArtifactId(artifactId)) return undefined;
      return store.load(artifactId);
    },

    async verify(artifactId) {
      if (!isArtifactId(artifactId)) return undefined;
      const artifact = await store.load(artifactId);
      if (artifact === undefined) return undefined;
      if (artifact.state !== 'sealed') return failure(artifact, 'NOT_SEALED');
      const inspection = await files.inspect(artifact);
      if (inspection.status === 'missing') return failure(artifact, 'FILE_MISSING');
      if (inspection.status === 'unreadable') return failure(artifact, 'FILE_UNREADABLE');
      if (inspection.sha256 !== artifact.sha256) return failure(artifact, 'HASH_MISMATCH');
      if (inspection.bytes !== artifact.bytes) return failure(artifact, 'SIZE_MISMATCH');
      return {artifact, verified: true};
    },
  };
}
