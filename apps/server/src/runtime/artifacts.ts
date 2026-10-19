/**
 * Artifact runtime: restricted workspace paths, atomic tmp -> fsync -> rename
 * writes, sha256 computation, the durable store adapter and verification.
 *
 * A crash can leave a `writing` record or an orphan file; neither is success.
 * Verification re-reads the file and never deletes evidence.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Context, JsonValue } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { JsonObject, SessionDocFamilyToken, Tx } from '@earendil-works/pi-durable';
import {
  artifactCommands,
  type ArtifactCommands,
  type ArtifactFilePort,
  type ArtifactStore,
} from '../application/artifact.js';
import { ArtifactError, isArtifactId, isArtifactName, isArtifactOwnerId, type Artifact } from '../domain/artifact.js';
import { Artifacts, artifactDocument, artifactFromDocument } from '../storage/artifact.js';

/**
 * The subset of Harness/ToolExecutionApi this layer needs: committed document
 * reads plus one atomic commit. Both `Harness` and `ToolExecutionApi` satisfy it.
 */
export type ArtifactDocumentAccess = Readonly<{
  snapshot<T extends JsonObject, I extends JsonValue>(
    token: SessionDocFamilyToken<T, I>, key: string, context: Context,
  ): Promise<Readonly<T> | undefined>;
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
}>;

export function workspaceDir(dataDir: string): string {
  return join(dataDir, 'workspace');
}

/** Resolve a path and require it to stay inside the workspace root. */
function insideWorkspace(workspace: string, path: string): string {
  const root = resolve(workspace);
  const target = resolve(path);
  if (target !== root && !target.startsWith(root + sep)) throw new ArtifactError('INVALID_COMMAND');
  return target;
}

/**
 * Directory name for one artifact, derived from its full artifactId. Keeping the
 * artifactId out of the bare `<name>` path is what stops two calls of the same
 * attempt that save the same file name from overwriting each other. Non-safe
 * characters are replaced; a short digest guarantees uniqueness even when
 * different callIds sanitize to the same string, and the segment stays under the
 * filesystem name limit.
 */
export function artifactDirectoryName(artifactId: string): string {
  if (!isArtifactId(artifactId)) throw new ArtifactError('INVALID_COMMAND');
  const sanitized = artifactId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  return `${sanitized}-${sha256Hex(artifactId).slice(0, 12)}`;
}

/** Absolute artifact path for one artifact/attempt; rejects traversal and unsafe names. */
export function artifactPath(
  workspace: string,
  jobId: string,
  attemptId: string,
  artifactId: string,
  name: string,
): string {
  if (!isArtifactOwnerId(jobId) || !isArtifactOwnerId(attemptId) || !isArtifactName(name)) {
    throw new ArtifactError('INVALID_COMMAND');
  }
  const directory = artifactDirectoryName(artifactId);
  return insideWorkspace(workspace, join(workspace, 'jobs', jobId, attemptId, directory, name));
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** File port over one workspace: 0600 temp file in the target directory, fsync, rename. */
export function artifactFiles(workspace: string): ArtifactFilePort {
  return {
    async write(artifact, content) {
      const target = insideWorkspace(workspace, artifact.path);
      const directory = dirname(target);
      await mkdir(directory, {recursive: true, mode: 0o700});
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, {force: true}).catch(() => undefined);
        throw error;
      }
      // Persist the rename itself: a crash after this point must not lose the file.
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    },

    async inspect(artifact) {
      const target = insideWorkspace(workspace, artifact.path);
      let content: Buffer;
      try {
        content = await readFile(target);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {status: 'missing'} : {status: 'unreadable'};
      }
      return {status: 'read', sha256: createHash('sha256').update(content).digest('hex'), bytes: content.byteLength};
    },
  };
}

/**
 * Write one artifact document inside a caller-owned transaction. Used by the
 * harness store and by the tool, whose sealed commit additionally updates the
 * Attempt document in the same transaction.
 */
export async function writeArtifactDocument(tx: Tx, artifact: Artifact): Promise<Artifact> {
  const draft = await tx.doc(Artifacts, artifact.id, artifactDocument(artifact));
  if (draft.sha256 !== artifact.sha256
    || draft.name !== artifact.name
    || draft.path !== artifact.path
    || draft.jobId !== artifact.jobId
    || draft.attemptId !== artifact.attemptId
    || draft.revision !== artifact.revision) {
    throw new ArtifactError('ARTIFACT_CONFLICT');
  }
  // A sealed document is terminal: a stale caller returns the sealed value instead
  // of downgrading it back to writing/failed.
  if (draft.state === 'sealed') return artifactFromDocument({...draft});
  draft.state = artifact.state;
  draft.bytes = artifact.bytes;
  draft.sealedAt = artifact.sealedAt ?? null;
  return artifactFromDocument({...draft});
}

/** Durable artifact store over the Harness API (job/artifact verification paths). */
export function artifactStore(access: ArtifactDocumentAccess, dataDir: string): ArtifactStore {
  const workspace = workspaceDir(dataDir);
  return {
    async load(artifactId) {
      const document = await access.snapshot(Artifacts, artifactId, BACKGROUND_CONTEXT);
      return document === undefined ? undefined : artifactFromDocument(document);
    },
    async save(artifact) {
      insideWorkspace(workspace, artifact.path);
      return access.commit(tx => writeArtifactDocument(tx, artifact), BACKGROUND_CONTEXT);
    },
  };
}

/** Convenience wiring for runtime consumers that only need get/verify. */
export function artifactCommandsForHarness(access: ArtifactDocumentAccess, dataDir: string): ArtifactCommands {
  return artifactCommands(
    artifactStore(access, dataDir),
    artifactFiles(workspaceDir(dataDir)),
    {sha256: sha256Hex, now: () => Date.now()},
  );
}
