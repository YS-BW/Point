/**
 * Artifact runtime: restricted workspace paths, hardened atomic writes, sha256
 * computation, the durable store adapter and verification.
 *
 * The writer mirrors the hardened file-resource adapter (P0-5): the workspace root
 * is canonicalized with `realpath`, every path component is `lstat`ed (symlinks and
 * non-directories rejected) and `realpath`-checked, the destination must be a regular
 * file, the temporary file is `O_CREAT|O_EXCL|O_NOFOLLOW` at 0600 and `fstat`ed as a
 * regular file, the parent is re-canonicalized immediately before the rename, and the
 * published file is read back and hash/bytes-compared before success is reported.
 *
 * A crash can leave a `writing` record or an orphan temp file; neither is success.
 * Verification re-reads the file through `O_NOFOLLOW` and never deletes evidence.
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
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

const O_NOFOLLOW = (constants as Readonly<Record<string, number | undefined>>).O_NOFOLLOW ?? 0;

/** Fault-injection seams for the hardening tests only; production composition never sets them. */
export type ArtifactFileHooks = Readonly<{
  beforeRename?: (context: Readonly<{root: string; target: string; temporary: string}>) => void | Promise<void>;
  afterRename?: (context: Readonly<{root: string; target: string}>) => void | Promise<void>;
}>;

export function workspaceDir(dataDir: string): string {
  return join(dataDir, 'workspace');
}

/** Resolve a path and require it to stay inside the workspace root (lexical construction only). */
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

function sha256Buffer(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Relative component path of one artifact below the canonical workspace root. */
function artifactRelativePath(artifact: Artifact): string {
  if (!isArtifactOwnerId(artifact.jobId) || !isArtifactOwnerId(artifact.attemptId) || !isArtifactName(artifact.name)) {
    throw new ArtifactError('INVALID_COMMAND');
  }
  return join('jobs', artifact.jobId, artifact.attemptId, artifactDirectoryName(artifact.id), artifact.name);
}

/**
 * The stored absolute path is part of the durable record; it must point exactly at the canonical
 * component layout. A forged/relocated path is rejected instead of being written to.
 */
function assertStoredPath(workspace: string, artifact: Artifact): string {
  const relative = artifactRelativePath(artifact);
  const expected = join(resolve(workspace), relative);
  if (resolve(artifact.path) !== expected) throw new ArtifactError('INVALID_COMMAND');
  return relative;
}

async function canonicalRoot(workspace: string, create: boolean): Promise<string> {
  if (create) await mkdir(workspace, {recursive: true, mode: 0o700});
  return realpath(workspace);
}

/**
 * Walk (and, for writes, create) every component below the canonical root. Each component must be
 * a real directory whose `realpath` is itself: a symlink anywhere in the chain is rejected, and the
 * canonical comparison catches a parent swapped between the `lstat` and the next step.
 */
async function secureDirectory(root: string, components: readonly string[], create: boolean): Promise<string> {
  let current = root;
  for (const component of components) {
    const next = join(current, component);
    if (create) {
      try {
        await mkdir(next, {mode: 0o700});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const stats = await lstat(next);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new ArtifactError('INVALID_COMMAND');
    const canonical = await realpath(next);
    if (canonical !== next) throw new ArtifactError('INVALID_COMMAND');
    current = canonical;
  }
  return current;
}

async function verifyWrittenFile(target: string, artifact: Artifact): Promise<void> {
  const handle = await open(target, constants.O_RDONLY | O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new ArtifactError('INVALID_COMMAND');
    const content = await handle.readFile();
    if (content.byteLength !== artifact.bytes || sha256Buffer(content) !== artifact.sha256) {
      throw new ArtifactError('ARTIFACT_WRITE_FAILED');
    }
  } finally {
    await handle.close();
  }
}

/** File port over one workspace: hardened component checks, 0600 temp file, fsync, rename, read-back. */
export function artifactFiles(workspace: string, hooks?: ArtifactFileHooks): ArtifactFilePort {
  return {
    async write(artifact, content) {
      assertStoredPath(workspace, artifact);
      let temporaryPath: string | undefined;
      try {
        const root = await canonicalRoot(workspace, true);
        const directory = await secureDirectory(
          root, ['jobs', artifact.jobId, artifact.attemptId, artifactDirectoryName(artifact.id)], true);
        const target = join(directory, artifact.name);
        const existing = await lstat(target).catch(() => undefined);
        if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
          throw new ArtifactError('INVALID_COMMAND');
        }
        temporaryPath = join(directory, `.${randomUUID()}.tmp`);
        const handle = await open(
          temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
        try {
          if (!(await handle.stat()).isFile()) throw new ArtifactError('INVALID_COMMAND');
          await handle.writeFile(content, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await hooks?.beforeRename?.({root, target, temporary: temporaryPath});
        // Re-check immediately before publishing: canonical parent, regular destination, regular temp.
        const parentNow = await realpath(directory);
        if (parentNow !== directory) throw new ArtifactError('INVALID_COMMAND');
        if (!(await lstat(temporaryPath)).isFile()) throw new ArtifactError('INVALID_COMMAND');
        const targetNow = await lstat(target).catch(() => undefined);
        if (targetNow !== undefined && (!targetNow.isFile() || targetNow.isSymbolicLink())) {
          throw new ArtifactError('INVALID_COMMAND');
        }
        await rename(temporaryPath, target);
        await hooks?.afterRename?.({root, target});
        const directoryHandle = await open(directory, 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
        // Never report success before the published bytes match the recorded sha256/bytes.
        await verifyWrittenFile(target, artifact);
      } catch (error) {
        if (temporaryPath !== undefined) await rm(temporaryPath, {force: true}).catch(() => undefined);
        if (error instanceof ArtifactError) throw error;
        throw new ArtifactError('ARTIFACT_WRITE_FAILED');
      }
    },

    async inspect(artifact) {
      try {
        assertStoredPath(workspace, artifact);
      } catch {
        return {status: 'unreadable'};
      }
      let directory: string;
      try {
        const root = await canonicalRoot(workspace, false);
        directory = await secureDirectory(
          root, ['jobs', artifact.jobId, artifact.attemptId, artifactDirectoryName(artifact.id)], false);
      } catch (error) {
        return isMissing(error) ? {status: 'missing'} : {status: 'unreadable'};
      }
      let handle;
      try {
        handle = await open(join(directory, artifact.name), constants.O_RDONLY | O_NOFOLLOW);
      } catch (error) {
        return isMissing(error) ? {status: 'missing'} : {status: 'unreadable'};
      }
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) return {status: 'unreadable'};
        const content = await handle.readFile();
        return {status: 'read', sha256: sha256Buffer(content), bytes: content.byteLength};
      } catch {
        return {status: 'unreadable'};
      } finally {
        await handle.close();
      }
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
      // The durable record must describe the canonical component layout before it is committed.
      assertStoredPath(workspace, artifact);
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
