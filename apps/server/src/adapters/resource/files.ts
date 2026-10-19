/**
 * Hardened local-file resource capability (OpenSpec agent-resource-adapter-safety 2.1).
 *
 * The adapter is explicit: a factory must be given an absolute root directory, which is
 * canonicalized with `realpath` once and never re-derived from caller input. Every path is
 * relative to that root, lexically validated, and checked against symlinks on each component
 * before use. Writes are `tmp (O_CREAT|O_EXCL|O_NOFOLLOW, 0600) -> fstat -> fsync ->
 * atomic rename -> fsync directory -> read-back hash`, so a crash can leave an orphan temp
 * file but never a half-written destination that is reported as success.
 *
 * Effects run only through the secure resource protocol (`beginOperation` stores the
 * canonical payload/hash, `runOperation` resolves the registered kind). A filesystem failure
 * before the rename is a known `failed` outcome; anything after the rename is `unknown`
 * because the destination may already be visible, and is reconciled by observation only.
 *
 * Remaining OS-level limitation: Node has no `openat`/`renameat`, so the check-before-rename
 * window cannot be made fully atomic. We re-canonicalize the parent and re-check the target
 * immediately before the rename and reject a swapped parent/target; a hostile process that
 * wins the last microsecond is out of scope (documented in the adapter README).
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  EffectFailure,
  type EffectDefinition,
  type RegisteredEffect,
  type ResourceCommands,
  type ResourceEffectPort,
} from '../../application/resource.js';
import {
  ResourceError,
  assertSecureOperation,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type ResourceOperation,
} from '../../domain/resource.js';

/** Registered capability kind; the only effect this adapter dispatches. */
export const FILE_EFFECT_KIND = 'file.write';
/** Evidence discriminator written by this capability. */
export const FILE_EVIDENCE_KIND = 'file';

/** Hard content bound. Larger content must travel as an Artifact reference, never a payload. */
export const MAX_FILE_BYTES = 262_144;
/** Payload envelope bound (content plus path/hash/bytes fields). */
export const MAX_PAYLOAD_BYTES = MAX_FILE_BYTES + 4_096;
/** Persisted result bound. */
export const MAX_RESULT_BYTES = 4_096;
/** Evidence bound; the application also enforces its own hard 8 KiB cap. */
export const MAX_EVIDENCE_BYTES = 4_096;
/** Longest accepted relative path, in characters. */
export const MAX_PATH_CHARS = 1_024;
/** Longest accepted path component, matching common filesystem limits. */
export const MAX_PATH_SEGMENT_CHARS = 255;
/** One listing returns at most this many entries. */
export const MAX_LIST_ENTRIES = 256;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const O_NOFOLLOW = (constants as Readonly<Record<string, number | undefined>>).O_NOFOLLOW ?? 0;
const O_DIRECTORY = (constants as Readonly<Record<string, number | undefined>>).O_DIRECTORY ?? 0;

export type FileAdapterErrorCode =
  | 'FILE_INVALID_COMMAND'
  | 'FILE_ROOT_REQUIRED'
  | 'FILE_ROOT_UNAVAILABLE'
  | 'FILE_PATH_REJECTED'
  | 'FILE_SYMLINK_REJECTED'
  | 'FILE_NOT_REGULAR'
  | 'FILE_NOT_DIRECTORY'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'FILE_IO'
  | 'FILE_EVIDENCE_REJECTED';

/** Stable adapter failures. Not a domain error: the capability is the only authority on files. */
export class FileAdapterError extends Error {
  constructor(readonly code: FileAdapterErrorCode) {
    super(code);
    this.name = 'FileAdapterError';
  }
}

export type FileWriteRequest = Readonly<{
  operationId: string;
  requestId: string;
  resourceId: string;
  controlEpoch: number;
  path: string;
  content: string;
  /** Absolute deadline; the operation also has the runtime's configured default window. */
  deadline?: number;
}>;

export type FileReadRequest = Readonly<{path: string}>;
export type FileListRequest = Readonly<{directory?: string}>;
export type FileInspectRequest = Readonly<{path: string}>;

export type FileReconcileRequest = Readonly<{
  operationId: string;
  /** Requested settlement; when omitted it follows the observed file/hash truth. */
  status?: 'done' | 'failed';
  observation?: string;
  /** Required only to recover an expired attempt whose live worker is gone. */
  owner?: string;
}>;

export type FileWriteResult = Readonly<{path: string; sha256: string; bytes: number}>;
export type FileReadResult = Readonly<{path: string; sha256: string; bytes: number; content: string}>;
export type FileObservation = Readonly<{
  path: string; exists: boolean; regular: boolean; sha256: string | null; bytes: number | null;
}>;
export type FileListEntry = Readonly<{
  name: string; kind: 'file' | 'directory'; bytes?: number;
}>;
export type FileListResult = Readonly<{
  directory: string; entries: readonly FileListEntry[]; truncated: boolean;
}>;

export type FileAdapterHooks = Readonly<{
  /**
   * Fault-injection seam for tests only: runs after the temporary file is durable and
   * before the atomic rename. Production composition must not set it.
   */
  beforeRename?: (context: Readonly<{root: string; path: string; temporary: string; target: string}>) => void | Promise<void>;
  /**
   * Fault-injection seam for tests only: runs after the rename. A throw here becomes an
   * `unknown` operation (the file may already be visible), which is reconciled by observation.
   */
  afterRename?: (context: Readonly<{root: string; path: string; target: string}>) => void | Promise<void>;
}>;

export type FileResourceAdapter = Readonly<{
  /** Canonical absolute root fixed at construction. */
  readonly root: string;
  /** Registered capability for `openRuntime({resources: {effects}})`. */
  readonly registered: RegisteredEffect;
  /** Secure write: beginOperation -> registered effect -> runOperation. */
  write(request: FileWriteRequest): Promise<ResourceOperation>;
  read(request: FileReadRequest): Promise<FileReadResult>;
  list(request?: FileListRequest): Promise<FileListResult>;
  inspect(request: FileInspectRequest): Promise<FileObservation>;
  /** Observation-only recovery of an `unknown`/expired operation; never replays the write. */
  reconcile(request: FileReconcileRequest): Promise<ResourceOperation>;
}>;

/* -------------------------------------------------------------------------- */
/* Strict parsing                                                              */
/* -------------------------------------------------------------------------- */

function fail(code: FileAdapterErrorCode): never {
  throw new FileAdapterError(code);
}

function object(input: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('FILE_INVALID_COMMAND');
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    fail('FILE_INVALID_COMMAND');
  }
  return value;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') fail('FILE_INVALID_COMMAND');
  const chars = Array.from(value);
  if (chars.length < 1 || chars.length > max) fail('FILE_INVALID_COMMAND');
  return value;
}

/** Relative path segments after lexical validation; no `..`, no absolute path, no controls. */
function pathSegments(value: unknown): {path: string; segments: string[]} {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_CHARS) fail('FILE_PATH_REJECTED');
  if (value.includes('\u0000') || value.includes('\\') || /\p{Cc}/u.test(value)) fail('FILE_PATH_REJECTED');
  if (isAbsolute(value)) fail('FILE_PATH_REJECTED');
  const segments = value.split('/');
  if (segments.length === 0) fail('FILE_PATH_REJECTED');
  const cleaned: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') fail('FILE_PATH_REJECTED');
    if (Array.from(segment).length > MAX_PATH_SEGMENT_CHARS) fail('FILE_PATH_REJECTED');
    cleaned.push(segment);
  }
  if (cleaned.length === 0) fail('FILE_PATH_REJECTED');
  return {path: cleaned.join('/'), segments: cleaned};
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

function parseWritePayload(value: unknown): FileWritePayload {
  if (!isJsonObject(value)) fail('FILE_PATH_REJECTED');
  const record = value as unknown as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'bytes,content,path,sha256') fail('FILE_PATH_REJECTED');
  const {path} = pathSegments(record.path);
  if (typeof record.content !== 'string') fail('FILE_PATH_REJECTED');
  const content = record.content;
  const bytes = byteLength(content);
  if (bytes > MAX_FILE_BYTES) fail('FILE_TOO_LARGE');
  if (record.bytes !== bytes) fail('FILE_PATH_REJECTED');
  if (typeof record.sha256 !== 'string' || !SHA256_HEX.test(record.sha256)) fail('FILE_PATH_REJECTED');
  if (record.sha256 !== sha256Hex(content)) fail('FILE_PATH_REJECTED');
  return {path, content, sha256: record.sha256, bytes};
}

type FileWritePayload = Readonly<{path: string; content: string; sha256: string; bytes: number}>;

function parseWriteResult(
  value: unknown,
  evidence?: unknown,
  payload?: unknown,
): FileWriteResult {
  if (!isJsonObject(value)) throw new ResourceError('RESULT_REJECTED');
  const record = value as unknown as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'bytes,path,sha256') throw new ResourceError('RESULT_REJECTED');
  let result: FileWriteResult;
  try {
    const {path} = pathSegments(record.path);
    if (typeof record.sha256 !== 'string' || !SHA256_HEX.test(record.sha256)) throw new ResourceError('RESULT_REJECTED');
    if (typeof record.bytes !== 'number' || !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
      throw new ResourceError('RESULT_REJECTED');
    }
    result = {path, sha256: record.sha256, bytes: record.bytes};
  } catch (error) {
    if (error instanceof ResourceError) throw error;
    throw new ResourceError('RESULT_REJECTED');
  }
  // The application always supplies the persisted payload for secure settlement. A result is
  // only valid when it restates that payload; for reconciliation it must also agree with the
  // evidence's observed bytes/hash, so a schema-valid but contradictory result is rejected.
  if (payload !== undefined) {
    const bound = parseWritePayload(payload);
    if (result.path !== bound.path || result.sha256 !== bound.sha256 || result.bytes !== bound.bytes) {
      throw new ResourceError('RESULT_REJECTED');
    }
    if (evidence !== undefined) {
      const observed = parseEvidence(evidence, payload);
      // A `done` reconciliation must restate the evidence it was proven by.
      if (result.path !== observed.path || result.sha256 !== observed.sha256 || result.bytes !== observed.bytes) {
        throw new ResourceError('RESULT_REJECTED');
      }
    }
  } else if (evidence !== undefined) {
    throw new ResourceError('RESULT_REJECTED');
  }
  return result;
}

/**
 * Evidence is this capability's observation of the managed path. When checked against the
 * persisted payload it must prove that observation: same path, a regular existing file with
 * exactly the accepted sha256/bytes. A mismatching/missing file therefore cannot be used as
 * evidence; an `unknown` write stays unknown until the file matches the accepted payload.
 */
function parseEvidence(value: unknown, payload?: unknown): JsonObject {
  if (!isJsonObject(value)) throw new ResourceError('INVALID_EVIDENCE');
  const record = value as unknown as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'bytes,exists,kind,path,regular,sha256') throw new ResourceError('INVALID_EVIDENCE');
  try {
    const {path} = pathSegments(record.path);
    if (record.kind !== FILE_EVIDENCE_KIND) throw new ResourceError('INVALID_EVIDENCE');
    if (typeof record.exists !== 'boolean' || typeof record.regular !== 'boolean') {
      throw new ResourceError('INVALID_EVIDENCE');
    }
    if (record.regular && !record.exists) throw new ResourceError('INVALID_EVIDENCE');
    if (record.regular) {
      if (typeof record.sha256 !== 'string' || !SHA256_HEX.test(record.sha256)) throw new ResourceError('INVALID_EVIDENCE');
      if (typeof record.bytes !== 'number' || !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
        throw new ResourceError('INVALID_EVIDENCE');
      }
    } else if (record.sha256 !== null || record.bytes !== null) {
      throw new ResourceError('INVALID_EVIDENCE');
    }
    if (payload !== undefined) {
      const bound = parseWritePayload(payload);
      if (path !== bound.path || record.exists !== true || record.regular !== true
        || record.sha256 !== bound.sha256 || record.bytes !== bound.bytes) {
        throw new ResourceError('INVALID_EVIDENCE');
      }
    }
    return {...record, path} as JsonObject;
  } catch (error) {
    if (error instanceof ResourceError) throw error;
    throw new ResourceError('INVALID_EVIDENCE');
  }
}

/* -------------------------------------------------------------------------- */
/* Filesystem primitives                                                       */
/* -------------------------------------------------------------------------- */

async function lstatMaybe(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function abortBefore(invocation: {signal: AbortSignal; deadline: number} | undefined): void {
  if (invocation === undefined) return;
  if (invocation.signal.aborted || Date.now() >= invocation.deadline) {
    throw new EffectFailure('failed', 'DEADLINE_EXCEEDED');
  }
}

function abortedAfter(invocation: {signal: AbortSignal; deadline: number} | undefined): boolean {
  return invocation !== undefined && (invocation.signal.aborted || Date.now() >= invocation.deadline);
}

/** Canonical root: absolute, existing directory, resolved once. Absent configuration fails closed. */
async function canonicalRoot(rootDir: unknown): Promise<string> {
  if (typeof rootDir !== 'string' || rootDir.length === 0 || rootDir.length > MAX_PATH_CHARS
    || rootDir.includes('\u0000') || !isAbsolute(rootDir)) {
    throw new FileAdapterError('FILE_ROOT_REQUIRED');
  }
  let canonical: string;
  try {
    canonical = await realpath(rootDir);
  } catch {
    throw new FileAdapterError('FILE_ROOT_UNAVAILABLE');
  }
  const info = await lstatMaybe(canonical);
  if (info === undefined || !info.isDirectory()) throw new FileAdapterError('FILE_ROOT_UNAVAILABLE');
  return canonical;
}

class FileWorkspace {
  constructor(readonly root: string, readonly hooks: FileAdapterHooks) {}

  /** Parent directory inside the root, with every component checked and created as needed. */
  async parentDirectory(segments: readonly string[], create: boolean): Promise<{directory: string; target: string}> {
    if (segments.length === 0) throw new FileAdapterError('FILE_PATH_REJECTED');
    let directory = this.root;
    for (const segment of segments.slice(0, -1)) {
      const next = join(directory, segment);
      let info = await lstatMaybe(next);
      if (info === undefined) {
        if (!create) throw new FileAdapterError('FILE_NOT_FOUND');
        try {
          await mkdir(next, {mode: 0o700});
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            // Lost a creation race; the lstat below revalidates the winner.
          } else throw new FileAdapterError('FILE_IO');
        }
        info = await lstatMaybe(next);
        if (info === undefined) throw new FileAdapterError('FILE_IO');
      }
      if (info.isSymbolicLink()) throw new FileAdapterError('FILE_SYMLINK_REJECTED');
      if (!info.isDirectory()) throw new FileAdapterError('FILE_NOT_DIRECTORY');
      directory = next;
    }
    // A canonical child of a canonical root must equal itself; a difference means a symlink
    // (or a replaced ancestor) and must never be written through.
    const canonical = await realpath(directory);
    if (canonical !== directory) throw new FileAdapterError('FILE_SYMLINK_REJECTED');
    const name = segments[segments.length - 1]!;
    return {directory, target: join(directory, name)};
  }

  /** Target may be absent; an existing target must be a regular file, never a symlink. */
  async assertTarget(target: string): Promise<void> {
    const info = await lstatMaybe(target);
    if (info === undefined) return;
    if (info.isSymbolicLink()) throw new FileAdapterError('FILE_SYMLINK_REJECTED');
    if (!info.isFile()) throw new FileAdapterError('FILE_NOT_REGULAR');
  }

  /** Read a regular file without following a symlink; bounded by MAX_FILE_BYTES. */
  async readRegular(path: unknown): Promise<FileReadResult> {
    const {segments} = pathSegments(path);
    const {target} = await this.parentDirectory(segments, false);
    await this.assertTarget(target);
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new FileAdapterError('FILE_NOT_FOUND');
      if (code === 'ELOOP') throw new FileAdapterError('FILE_SYMLINK_REJECTED');
      throw new FileAdapterError('FILE_IO');
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new FileAdapterError('FILE_NOT_REGULAR');
      if (info.size > MAX_FILE_BYTES) throw new FileAdapterError('FILE_TOO_LARGE');
      const content = await handle.readFile();
      return {
        path: segments.join('/'),
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: content.byteLength,
        content: content.toString('utf8'),
      };
    } catch (error) {
      if (error instanceof FileAdapterError) throw error;
      throw new FileAdapterError('FILE_IO');
    } finally {
      await handle.close();
    }
  }

  /** Observation used by reconcile/evidence: never follows a target symlink and never throws for absence. */
  async observe(path: unknown): Promise<FileObservation> {
    const {path: relative, segments} = pathSegments(path);
    let directory: string;
    try {
      ({directory} = await this.parentDirectory(segments, false));
    } catch (error) {
      if (error instanceof FileAdapterError && (error.code === 'FILE_NOT_FOUND')) {
        return {path: relative, exists: false, regular: false, sha256: null, bytes: null};
      }
      throw error;
    }
    const target = join(directory, segments[segments.length - 1]!);
    const info = await lstatMaybe(target);
    if (info === undefined) return {path: relative, exists: false, regular: false, sha256: null, bytes: null};
    if (!info.isFile()) return {path: relative, exists: true, regular: false, sha256: null, bytes: null};
    try {
      const read = await this.readRegular(relative);
      return {path: relative, exists: true, regular: true, sha256: read.sha256, bytes: read.bytes};
    } catch {
      // A regular file that cannot be read is observed as present but unverified; reconcile
      // settles it as failed rather than inventing success.
      return {path: relative, exists: true, regular: false, sha256: null, bytes: null};
    }
  }

  async list(request: FileListRequest | undefined): Promise<FileListResult> {
    const raw = request === undefined ? undefined : object(request, ['directory'], []).directory;
    let directory = this.root;
    let relative = '';
    if (raw !== undefined) {
      const parsed = pathSegments(raw);
      relative = parsed.path;
      directory = (await this.parentDirectory([...parsed.segments, ''], false)).directory;
    }
    const entries: FileListEntry[] = [];
    let truncated = false;
    let dirents;
    try {
      dirents = await readdir(directory, {withFileTypes: true});
    } catch {
      throw new FileAdapterError('FILE_IO');
    }
    for (const dirent of [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (dirent.isSymbolicLink()) continue; // never present a symlink as a managed entry
      if (dirent.isDirectory()) {
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push({name: dirent.name, kind: 'directory'});
        continue;
      }
      if (!dirent.isFile()) continue;
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        break;
      }
      const info = await lstatMaybe(join(directory, dirent.name));
      if (info === undefined || !info.isFile()) continue;
      entries.push({name: dirent.name, kind: 'file', bytes: info.size});
    }
    return {directory: relative, entries, truncated};
  }

  /** The secure write: temp -> fsync -> rename -> fsync dir -> read-back verification. */
  async write(payload: FileWritePayload, invocation: {signal: AbortSignal; deadline: number} | undefined): Promise<FileWriteResult> {
    abortBefore(invocation);
    const {segments} = pathSegments(payload.path);
    const {directory, target} = await this.parentDirectory(segments, true);
    await this.assertTarget(target);
    abortBefore(invocation);
    const temporary = join(directory, `.point-file-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    } catch {
      throw new EffectFailure('failed', 'FILE_IO');
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new EffectFailure('failed', 'FILE_NOT_REGULAR');
      if ((info.mode & 0o077) !== 0) throw new EffectFailure('failed', 'FILE_PERMISSION_REJECTED');
      await handle.writeFile(payload.content, 'utf8');
      await handle.sync();
      const after = await handle.stat();
      if (!after.isFile() || after.size !== payload.bytes) throw new EffectFailure('failed', 'FILE_VERIFY_MISMATCH');
      if ((after.mode & 0o077) !== 0) throw new EffectFailure('failed', 'FILE_PERMISSION_REJECTED');
    } catch (error) {
      await this.cleanup(directory, temporary);
      if (error instanceof EffectFailure) throw error;
      throw new EffectFailure('failed', 'FILE_IO');
    } finally {
      await handle.close().catch(() => undefined);
    }

    // Last pre-commit check: the parent must still be the same canonical directory and the
    // target must still not be a symlink. This narrows the check-to-rename window; see the
    // module header for the OS limitation that remains.
    try {
      abortBefore(invocation);
      await this.hooks.beforeRename?.({root: this.root, path: payload.path, temporary, target});
      const canonical = await realpath(directory);
      if (canonical !== directory) throw new EffectFailure('failed', 'FILE_PATH_REJECTED');
      await this.assertTarget(target);
      if (abortedAfter(invocation)) throw new EffectFailure('failed', 'DEADLINE_EXCEEDED');
    } catch (error) {
      await this.cleanup(directory, temporary);
      if (error instanceof EffectFailure) throw error;
      if (error instanceof FileAdapterError) throw new EffectFailure('failed', error.code);
      throw new EffectFailure('failed', 'FILE_PATH_REJECTED');
    }

    try {
      await rename(temporary, target);
    } catch {
      await this.cleanup(directory, temporary);
      throw new EffectFailure('failed', 'FILE_IO');
    }

    // From here the destination may already be visible: every failure is `unknown`.
    try {
      await this.hooks.afterRename?.({root: this.root, path: payload.path, target});
      const directoryHandle = await open(directory, constants.O_RDONLY | O_DIRECTORY);
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
      const readBack = await this.readRegular(payload.path);
      if (readBack.sha256 !== payload.sha256 || readBack.bytes !== payload.bytes) {
        throw new EffectFailure('unknown', 'FILE_VERIFY_MISMATCH');
      }
      if (abortedAfter(invocation)) throw new EffectFailure('unknown', 'DEADLINE_EXCEEDED_AFTER_COMMIT');
      return {path: payload.path, sha256: payload.sha256, bytes: payload.bytes};
    } catch (error) {
      if (error instanceof EffectFailure) throw error;
      throw new EffectFailure('unknown', 'FILE_IO_AFTER_COMMIT');
    }
  }

  /** Remove a temp file only while the parent is still the expected canonical directory. */
  async cleanup(directory: string, temporary: string): Promise<void> {
    try {
      if (await realpath(directory) === directory) await rm(temporary, {force: true});
    } catch {
      // Best effort: a hostile parent swap must not make cleanup delete outside the root.
    }
  }

  evidence(observation: FileObservation): JsonObject {
    return {
      kind: FILE_EVIDENCE_KIND,
      path: observation.path,
      exists: observation.exists,
      regular: observation.regular,
      sha256: observation.sha256,
      bytes: observation.bytes,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Capability definition and effect                                            */
/* -------------------------------------------------------------------------- */

export const FILE_WRITE_DEFINITION: EffectDefinition = {
  kind: FILE_EFFECT_KIND,
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
  maxResultBytes: MAX_RESULT_BYTES,
  maxEvidenceBytes: MAX_EVIDENCE_BYTES,
  validatePayload(payload: JsonObject) {
    try {
      parseWritePayload(payload);
    } catch {
      throw new ResourceError('PAYLOAD_REJECTED');
    }
  },
  validateResult(result: JsonValue, evidence?: JsonObject, payload?: JsonObject) {
    parseWriteResult(result, evidence, payload);
  },
  validateEvidence(evidence: JsonObject, payload?: JsonObject) {
    parseEvidence(evidence, payload);
  },
};

function registeredEffect(workspace: FileWorkspace): RegisteredEffect {
  const effect: ResourceEffectPort = {
    async invoke(operation, invocation) {
      try {
        assertSecureOperation(operation);
        const payload = parseWritePayload(operation.effect.payload);
        return await workspace.write(payload, invocation);
      } catch (error) {
        if (error instanceof EffectFailure) throw error;
        if (error instanceof FileAdapterError) throw new EffectFailure('failed', error.code);
        if (error instanceof ResourceError) throw new EffectFailure('failed', 'FILE_PAYLOAD_REJECTED');
        throw new EffectFailure('unknown', 'FILE_IO_UNKNOWN');
      }
    },
  };
  return {definition: FILE_WRITE_DEFINITION, effect};
}

/**
 * Explicit factory for the composition root: the registered capability, ready to inject as
 * `openRuntime(dir, binding, {resources: {effects: createEffectRegistry([effect])}})`. Absent
 * or unusable root configuration fails closed.
 */
export async function createFileResourceEffect(
  rootDir: string,
  options: Readonly<{hooks?: FileAdapterHooks}> = {},
): Promise<RegisteredEffect> {
  const root = await canonicalRoot(rootDir);
  return registeredEffect(new FileWorkspace(root, options.hooks ?? {}));
}

/* -------------------------------------------------------------------------- */
/* High-level adapter                                                          */
/* -------------------------------------------------------------------------- */

function parseWriteRequest(input: unknown): FileWriteRequest {
  const value = object(input, ['operationId', 'requestId', 'resourceId', 'controlEpoch', 'path', 'content', 'deadline'],
    ['operationId', 'requestId', 'resourceId', 'controlEpoch', 'path', 'content']);
  return {
    operationId: text(value.operationId, 128),
    requestId: text(value.requestId, 128),
    resourceId: text(value.resourceId, 128),
    controlEpoch: value.controlEpoch as number,
    path: typeof value.path === 'string' ? value.path : fail('FILE_INVALID_COMMAND'),
    content: typeof value.content === 'string' ? value.content : fail('FILE_INVALID_COMMAND'),
    ...(value.deadline === undefined ? {} : {deadline: value.deadline as number}),
  };
}

/**
 * Hardened file capability over one explicit root and the runtime's secure resource port.
 * `write` accepts an operation (beginOperation + runOperation); `read`/`list`/`inspect` are
 * read-only observations; `reconcile` settles `unknown` from file evidence and never replays.
 */
export async function createFileResourceAdapter(
  rootDir: string,
  resources: ResourceCommands,
  options: Readonly<{hooks?: FileAdapterHooks}> = {},
): Promise<FileResourceAdapter> {
  if (!resources || typeof resources.beginOperation !== 'function' || typeof resources.runOperation !== 'function') {
    throw new FileAdapterError('FILE_INVALID_COMMAND');
  }
  const root = await canonicalRoot(rootDir);
  const workspace = new FileWorkspace(root, options.hooks ?? {});
  const registered = registeredEffect(workspace);

  return {
    root,
    registered,
    async write(input) {
      const request = parseWriteRequest(input);
      // Validate the path/content fully before creating any Durable intent.
      const payload: FileWritePayload = (() => {
        try {
          return parseWritePayload({
            path: request.path,
            content: request.content,
            sha256: sha256Hex(request.content),
            bytes: byteLength(request.content),
          });
        } catch (error) {
          if (error instanceof FileAdapterError) throw error;
          throw new FileAdapterError('FILE_PATH_REJECTED');
        }
      })();
      if (payload.bytes > MAX_FILE_BYTES) throw new FileAdapterError('FILE_TOO_LARGE');
      const operation = await resources.beginOperation({
        operationId: request.operationId,
        requestId: request.requestId,
        resourceId: request.resourceId,
        controlEpoch: request.controlEpoch,
        effect: {
          kind: FILE_EFFECT_KIND,
          payload: {path: payload.path, content: payload.content, sha256: payload.sha256, bytes: payload.bytes},
        },
        ...(request.deadline === undefined ? {} : {deadline: request.deadline}),
      });
      // The secure registry is bound at runtime construction; passing one here is rejected.
      return resources.runOperation(operation.id);
    },
    async read(input) {
      const request = object(input, ['path'], ['path']);
      return workspace.readRegular(request.path);
    },
    async list(input) {
      return workspace.list(input as FileListRequest | undefined);
    },
    async inspect(input) {
      const request = object(input, ['path'], ['path']);
      return workspace.observe(request.path);
    },
    async reconcile(input) {
      const request = object(input, ['operationId', 'status', 'observation', 'owner'],
        ['operationId']);
      const operationId = text(request.operationId, 128);
      let operation: ResourceOperation;
      try {
        operation = await resources.runOperation(operationId);
      } catch (error) {
        if (!(error instanceof ResourceError)) throw error;
        if (error.code !== 'RECOVERY_REQUIRED') throw error;
        if (request.owner === undefined) throw error;
        operation = await resources.recoverOperation({
          operationId, observer: text(request.owner, 128), reason: 'file-adapter-observation',
        });
      }
      if (operation.state !== 'unknown') return operation;
      assertSecureOperation(operation);
      const payload = parseWritePayload(operation.effect.payload);
      const observed = await workspace.observe(payload.path);
      const matches = observed.exists && observed.regular && observed.sha256 === payload.sha256
        && observed.bytes === payload.bytes;
      // Evidence is bound to the accepted payload: a missing/tampered file cannot be used as
      // proof for either settlement, so the operation stays unknown for an explicit operator
      // decision instead of being settled on contradictory evidence.
      if (!matches) throw new FileAdapterError('FILE_EVIDENCE_REJECTED');
      const status = request.status === 'done' || request.status === 'failed' ? request.status : 'done';
      return resources.observeOperation({
        operationId,
        status,
        evidence: workspace.evidence(observed),
        observer: operation.owner,
        payloadHash: operation.effect.payloadHash,
        controlEpoch: operation.controlEpoch,
        ...(status === 'done' ? {result: {path: payload.path, sha256: payload.sha256, bytes: payload.bytes}} : {}),
        ...(request.observation === undefined ? {} : {observation: text(request.observation, 512)}),
      });
    },
  };
}
