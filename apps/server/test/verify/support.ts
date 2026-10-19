/**
 * WP6 independent dynamic-verification support (tester lane, `apps/server/test/verify/**`).
 *
 * This module is intentionally self-contained: it only imports the public composition entry points
 * (`startServer`/`openRuntime`) plus the Durable SQLite storage class it wraps for call counting.
 * It contains no assertions; the sibling `*.test.ts` files own every verdict.
 *
 * Frozen contract under test (openspec/changes/agent-read-model + docs/design/protocol-agui.md):
 * - `GET /v1/state` body is the state object itself: `{seq, chats, jobs, resources, memory, events, truncated?}`.
 * - `GET /v1/threads/:threadId/stream` is a custom SSE binding: sync run on open, `id: <seq>:<frameIndex>`
 *   per frame (frame-level cursor; frames of one commit never share an id).
 * - `Last-Event-ID` inside the retention ring replays only later frames; outside it resyncs with a
 *   `CUSTOM point.stream.resync` event (`window_exceeded` | `unknown_seq` | `process_restarted`).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { TestContext } from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { startServer } from '../../src/bootstrap.js';
import { openRuntime, type ModelBinding, type Runtime } from '../../src/runtime/open.js';

export const TOKEN = 'verify-token-0123456789';
export const AUTH: Readonly<Record<string, string>> = {authorization: `Bearer ${TOKEN}`};
export const JSON_HEADERS: Readonly<Record<string, string>> = {'content-type': 'application/json'};

/* -------------------------------------------------------------------------- */
/* Storage call counter                                                       */
/* -------------------------------------------------------------------------- */

export type StorageCounts = {
  task: number;
  scanTasks: number;
  document: number;
  scanDocuments: number;
  commit: number;
  scanConversations: number;
  conversation: number;
  entry: number;
};

export type StorageCounter = Readonly<{
  counts: StorageCounts;
  /** Counts recorded right now (a copy, safe to keep). */
  snapshot(): StorageCounts;
  /** Document kinds passed to `scanDocuments` since the last call; clears the buffer. */
  takeKinds(): string[];
  restore(): void;
}>;

let installed: StorageCounter | undefined;

/**
 * Wrap every read/write entry point of the Durable SQLite storage class so tests can prove what a
 * request did or did not touch. Verified against the runtime's own storage instance: a product write
 * is observed as exactly one `commit`. `Storage.task` is reached from `session.js` and
 * `transaction.js`, so prototype wrapping observes the real reader, not a stand-in.
 */
export function installStorageCounter(): StorageCounter {
  if (installed !== undefined) throw new Error('storage counter is already installed in this process');
  const scannedKinds: string[] = [];
  const counts: StorageCounts = {
    task: 0, scanTasks: 0, document: 0, scanDocuments: 0, commit: 0,
    scanConversations: 0, conversation: 0, entry: 0,
  };
  const prototype = SqliteStorage.prototype as unknown as Record<string, (...args: never[]) => unknown>;
  const originals = new Map<string, (...args: never[]) => unknown>();
  for (const name of Object.keys(counts) as (keyof StorageCounts)[]) {
    const original = prototype[name];
    if (typeof original !== 'function') throw new Error(`SqliteStorage.prototype.${name} is not a function`);
    originals.set(name, original);
    prototype[name] = function (this: unknown, ...args: never[]) {
      counts[name] += 1;
      // `scanDocuments` names the family it scans: capture it to prove which families were read.
      if (name === 'scanDocuments') {
        const query = args[0] as {kind?: unknown} | undefined;
        if (query !== null && typeof query === 'object' && typeof query.kind === 'string') {
          scannedKinds.push(query.kind);
        }
      }
      return (original as (...inner: never[]) => unknown).apply(this, args);
    };
  }
  const counter: StorageCounter = {
    counts,
    snapshot: () => ({...counts}),
    takeKinds: () => scannedKinds.splice(0, scannedKinds.length),
    restore() {
      for (const [name, original] of originals) prototype[name] = original;
      installed = undefined;
    },
  };
  installed = counter;
  return counter;
}

export function countDelta(before: StorageCounts, after: StorageCounts): StorageCounts {
  const delta = {} as Record<keyof StorageCounts, number>;
  for (const name of Object.keys(before) as (keyof StorageCounts)[]) delta[name] = after[name] - before[name];
  return delta;
}

export function formatCounts(counts: StorageCounts): string {
  return Object.entries(counts).map(([name, value]) => `${name}=${value}`).join(' ');
}

/* -------------------------------------------------------------------------- */
/* Server / runtime fixture                                                   */
/* -------------------------------------------------------------------------- */

export type VerifyServer = Readonly<{
  base: string;
  port: number;
  dir: string;
  runtime: Runtime;
  faux: ReturnType<typeof fauxProvider>;
  close(): Promise<void>;
}>;

export async function makeDataDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'point-verify-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

/**
 * Real `startServer` over a real temporary SQLite database, with an offline faux model so job
 * fixtures settle deterministically. The runtime handle is kept for fixture queries; every
 * product-level assertion goes through the real HTTP surface or the raw socket.
 */
export async function startVerifyServer(
  t: TestContext,
  options: Readonly<{dir?: string; modelResponses?: number; inspect?: boolean; retentionFrames?: number}> = {},
): Promise<VerifyServer> {
  const dir = options.dir ?? await makeDataDir(t);
  const responses = options.modelResponses ?? 32;
  const faux = fauxProvider({tokensPerSecond: 100000});
  faux.setResponses(Array.from({length: responses}, (_, index) => fauxAssistantMessage(`verify-${index}`)));
  const models = createModels();
  models.setProvider(faux.provider);
  const binding: ModelBinding = {models, model: {provider: 'faux', modelId: 'faux-1'}};
  const runtime = await openRuntime(dir, binding,
    options.retentionFrames === undefined ? undefined : {streams: {retentionFrames: options.retentionFrames}});
  const app = await startServer({
    host: '127.0.0.1', port: 0, dataDir: dir, apiToken: TOKEN,
    ...(options.inspect === true ? {apiInspect: true} : {}),
  }, async () => runtime);
  t.after(async () => { await app.close().catch(() => undefined); });
  return {
    base: `http://127.0.0.1:${app.port}`, port: app.port, dir, runtime, faux,
    close: () => app.close(),
  };
}

export type Seed = Readonly<{
  chatIds: string[];
  jobIds: string[];
  /** Job revisions at seed time (all jobs are revision 1). */
  jobRevisions: number[];
}>;

/** Create chats and jobs through the public HTTP writes, then wait for every job to reach a terminal state. */
export async function seed(server: VerifyServer, counts: Readonly<{chats: number; jobs: number}>): Promise<Seed> {
  const chatIds: string[] = [];
  for (let index = 0; index < counts.chats; index += 1) {
    const response = await fetch(`${server.base}/v1/chats`, {
      method: 'POST',
      headers: {'idempotency-key': `verify-chat-${index}`, ...JSON_HEADERS, ...AUTH},
      body: JSON.stringify({name: `verify chat ${index}`}),
    });
    if (response.status !== 200) throw new Error(`chat fixture failed: ${response.status} ${await response.text()}`);
    chatIds.push(String(((await response.json()) as {id: unknown}).id));
  }
  const jobIds: string[] = [];
  const jobRevisions: number[] = [];
  for (let index = 0; index < counts.jobs; index += 1) {
    const chatId = chatIds[index % chatIds.length]!;
    const response = await fetch(`${server.base}/v1/jobs`, {
      method: 'POST',
      headers: {'idempotency-key': `verify-job-${index}`, ...JSON_HEADERS, ...AUTH},
      body: JSON.stringify({title: `verify job ${index}`, prompt: 'do the work', sourceChatId: chatId}),
    });
    if (response.status !== 200) throw new Error(`job fixture failed: ${response.status} ${await response.text()}`);
    const created = (await response.json()) as {jobId: string; revision: number};
    jobIds.push(created.jobId);
    jobRevisions.push(created.revision);
  }
  await settleJobs(server, jobIds);
  return {chatIds, jobIds, jobRevisions};
}

const TERMINAL_JOB_STATUS = new Set(['ready', 'failed', 'cancelled']);

/** Poll through the public read route until every seeded job is terminal (fixture precondition, not a verdict). */
export async function settleJobs(server: VerifyServer, jobIds: readonly string[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const statuses = await Promise.all(jobIds.map(async jobId => (await server.runtime.jobs.get(jobId))?.status));
    if (statuses.every(status => status !== undefined && TERMINAL_JOB_STATUS.has(status))) return;
    if (Date.now() > deadline) {
      throw new Error(`fixture did not settle in ${timeoutMs}ms: ${statuses.join(',')}`);
    }
    await delay(20);
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

export async function getState(server: VerifyServer, headers: Readonly<Record<string, string>> = AUTH): Promise<Response> {
  return fetch(`${server.base}/v1/state`, {headers});
}

export async function readState(server: VerifyServer): Promise<Record<string, unknown>> {
  const response = await getState(server);
  if (response.status !== 200) throw new Error(`GET /v1/state -> ${response.status} ${await response.text()}`);
  return await response.json() as Record<string, unknown>;
}

export async function writeJson(
  server: VerifyServer, path: string, key: string, body: unknown,
): Promise<{status: number; body: unknown}> {
  const response = await fetch(`${server.base}${path}`, {
    method: 'POST',
    headers: {'idempotency-key': key, ...JSON_HEADERS, ...AUTH},
    body: JSON.stringify(body),
  });
  return {status: response.status, body: await response.json()};
}

export async function createChat(server: VerifyServer, name: string, key: string): Promise<string> {
  const result = await writeJson(server, '/v1/chats', key, {name});
  if (result.status !== 200) throw new Error(`chat write failed: ${result.status} ${JSON.stringify(result.body)}`);
  return String((result.body as {id: unknown}).id);
}

export async function amendJob(
  server: VerifyServer, jobId: string, expectedRevision: number, key: string, prompt = 'amended prompt',
): Promise<{jobId: string; revision: number; attemptId: string}> {
  const result = await writeJson(server, `/v1/jobs/${jobId}/amend`, key, {expectedRevision, prompt});
  if (result.status !== 200) throw new Error(`amend failed: ${result.status} ${JSON.stringify(result.body)}`);
  return result.body as {jobId: string; revision: number; attemptId: string};
}

export async function rememberMemory(
  server: VerifyServer, key: string, value: string, sourceChatId: string,
): Promise<void> {
  const result = await writeJson(server, '/v1/profile/remember', `verify-memory-${key}`,
    {key, value, kind: 'preference', sourceChatId});
  if (result.status !== 200) throw new Error(`memory write failed: ${result.status} ${JSON.stringify(result.body)}`);
}

/* -------------------------------------------------------------------------- */
/* Raw-socket SSE client                                                      */
/* -------------------------------------------------------------------------- */

export type SseFrame = Readonly<{id: string | undefined; event: string | undefined; data: string}>;

class ChunkedDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private finished = false;

  get done(): boolean {
    return this.finished;
  }

  push(chunk: Buffer): Buffer {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const parts: Buffer[] = [];
    for (;;) {
      if (this.finished) break;
      const lineEnd = this.buffer.indexOf('\r\n');
      if (lineEnd < 0) break;
      const sizeText = this.buffer.subarray(0, lineEnd).toString('latin1').split(';')[0]!.trim();
      const size = Number.parseInt(sizeText, 16);
      if (!Number.isFinite(size) || size < 0) throw new Error(`invalid chunk size: ${sizeText}`);
      if (size === 0) {
        this.finished = true;
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (this.buffer.length < lineEnd + 2 + size + 2) break;
      parts.push(this.buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
      this.buffer = this.buffer.subarray(lineEnd + 2 + size + 2);
    }
    return Buffer.concat(parts);
  }
}

export type RawStreamInit = Readonly<{
  port: number;
  path: string;
  token?: string;
  lastEventId?: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
}>;

/**
 * Minimal HTTP/1.1 + SSE client written for this verification: it speaks to a raw TCP socket, decodes
 * chunked transfer encoding and parses `id:`/`event:`/`data:` fields itself. No `fetch`, no framework,
 * so a passing verdict cannot come from a shared streaming helper.
 */
export class RawStream {
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;

  private readonly socket: Socket;
  private readonly decoder = new TextDecoder();
  private readonly chunked = new ChunkedDecoder();
  private readonly queue: SseFrame[] = [];
  private readonly waiters: Array<(frame: SseFrame | undefined) => void> = [];
  private headerBuffer: Buffer = Buffer.alloc(0);
  private headerDone = false;
  private bodyMode: 'chunked' | 'length' | 'until-close' = 'until-close';
  private remaining = 0;
  private text = '';
  private streamEnded = false;
  private failure: Error | undefined;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: Error) => void) | undefined;

  private constructor(socket: Socket, status: number, responseHeaders: Record<string, string>) {
    this.socket = socket;
    this.status = status;
    this.responseHeaders = responseHeaders;
    socket.setNoDelay(true);
    socket.on('data', chunk => { this.onData(chunk); });
    socket.on('error', error => { this.fail(error); });
    socket.on('close', () => { this.finish(); });
  }

  static async open(init: RawStreamInit, timeoutMs = 10_000): Promise<RawStream> {
    const socket = connect({host: '127.0.0.1', port: init.port});
    const lines = [
      `${init.method ?? 'GET'} ${init.path} HTTP/1.1`,
      `Host: 127.0.0.1:${init.port}`,
      'Accept: text/event-stream',
      'Cache-Control: no-cache',
      'Connection: keep-alive',
    ];
    if (init.token !== undefined) lines.push(`Authorization: Bearer ${init.token}`);
    if (init.lastEventId !== undefined) lines.push(`Last-Event-ID: ${init.lastEventId}`);
    for (const [name, value] of Object.entries(init.headers ?? {})) lines.push(`${name}: ${value}`);
    const request = `${lines.join('\r\n')}\r\n\r\n`;

    let created: RawStream | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      // The instance is created before the header promise can settle: 'data' cannot fire between
      // construction and the write below because the socket is consumed by the constructor listeners.
      created = new RawStream(socket, 0, {});
      created.readyResolve = resolve;
      created.readyReject = reject;
    });
    socket.write(request);
    const timer = setTimeout(() => created?.readyReject?.(new Error(`no response headers within ${timeoutMs}ms`)), timeoutMs);
    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }
    return created!;
  }

  get ended(): boolean {
    return this.streamEnded;
  }

  get error(): Error | undefined {
    return this.failure;
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) { this.finish(); return; }
    await new Promise<void>(resolve => {
      this.socket.once('close', () => resolve());
      this.socket.destroy();
    });
  }

  /** Next frame, or `undefined` on timeout / stream end. */
  async next(timeoutMs: number): Promise<SseFrame | undefined> {
    const frame = this.queue.shift();
    if (frame !== undefined) return frame;
    if (this.failure !== undefined) throw this.failure;
    if (this.streamEnded) return undefined;
    return await new Promise<SseFrame | undefined>(resolve => {
      const waiter = (value: SseFrame | undefined): void => { clearTimeout(timer); resolve(value); };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async readUntil(predicate: (frame: SseFrame) => boolean, timeoutMs = 15_000): Promise<SseFrame[]> {
    const collected: SseFrame[] = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`readUntil timed out after ${collected.length} frames: ${describeFrames(collected)}`);
      const frame = await this.next(remaining);
      if (frame === undefined) {
        throw new Error(`stream ended before predicate after ${collected.length} frames: ${describeFrames(collected)}`);
      }
      collected.push(frame);
      if (predicate(frame)) return collected;
    }
  }

  /** Read until no frame arrives for `quietMs`, or `maxMs` elapses. */
  async readUntilSilence(quietMs = 400, maxMs = 15_000): Promise<SseFrame[]> {
    const collected: SseFrame[] = [];
    const deadline = Date.now() + maxMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const frame = await this.next(Math.min(quietMs, remaining));
      if (frame === undefined) break;
      collected.push(frame);
    }
    return collected;
  }

  private onData(chunk: Buffer): void {
    if (!this.headerDone) {
      this.headerBuffer = Buffer.concat([this.headerBuffer, chunk]);
      const separator = this.headerBuffer.indexOf('\r\n\r\n');
      if (separator < 0) return;
      const head = this.headerBuffer.subarray(0, separator).toString('latin1');
      const rest = this.headerBuffer.subarray(separator + 4);
      this.headerBuffer = Buffer.alloc(0);
      const [statusLine, ...headerLines] = head.split('\r\n');
      const status = Number((statusLine ?? '').split(' ')[1]);
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      (this as {status: number}).status = status;
      (this as {responseHeaders: Record<string, string>}).responseHeaders = headers;
      this.headerDone = true;
      if ((headers['transfer-encoding'] ?? '').includes('chunked')) this.bodyMode = 'chunked';
      else if (headers['content-length'] !== undefined) {
        this.bodyMode = 'length';
        this.remaining = Number(headers['content-length']);
      }
      this.readyResolve?.();
      if (rest.length > 0) this.onBody(rest);
      return;
    }
    this.onBody(chunk);
  }

  private onBody(chunk: Buffer): void {
    let decoded: Buffer;
    if (this.bodyMode === 'chunked') {
      decoded = this.chunked.push(chunk);
    } else if (this.bodyMode === 'length') {
      const take = Math.min(this.remaining, chunk.length);
      decoded = chunk.subarray(0, take);
      this.remaining -= take;
    } else {
      decoded = chunk;
    }
    if (decoded.length === 0) return;
    this.text += this.decoder.decode(decoded, {stream: true});
    this.drain();
  }

  private drain(): void {
    this.text = this.text.replace(/\r\n/g, '\n');
    let separator = this.text.indexOf('\n\n');
    while (separator >= 0) {
      const block = this.text.slice(0, separator);
      this.text = this.text.slice(separator + 2);
      const frame = parseSseBlock(block);
      if (frame !== undefined) this.push(frame);
      separator = this.text.indexOf('\n\n');
    }
  }

  private push(frame: SseFrame): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(frame);
    else this.queue.push(frame);
  }

  private fail(error: Error): void {
    if (this.failure === undefined) this.failure = error;
    this.readyReject?.(error);
    this.finish();
  }

  private finish(): void {
    this.streamEnded = true;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }
}

function parseSseBlock(block: string): SseFrame | undefined {
  if (block.length === 0) return undefined;
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
    else if (field === 'event') event = value;
  }
  if (data.length === 0) return undefined;
  return {id, event, data: data.join('\n')};
}

export function describeFrames(frames: readonly SseFrame[]): string {
  return frames.map(frame => {
    try {
      const event = JSON.parse(frame.data) as {type?: unknown};
      return `${frame.id ?? '-'}:${String(event.type)}`;
    } catch {
      return `${frame.id ?? '-'}:<unparsed>`;
    }
  }).join(', ');
}

export function frameEvent(frame: SseFrame): Record<string, unknown> {
  const value = JSON.parse(frame.data) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SSE data is not a JSON object: ${frame.data}`);
  }
  return value as Record<string, unknown>;
}

export function frameType(frame: SseFrame): string {
  return String(frameEvent(frame).type);
}

/* -------------------------------------------------------------------------- */
/* Client-side state view (snapshot + RFC 6902 deltas)                        */
/* -------------------------------------------------------------------------- */

export type JsonPatchOperation = Readonly<{op: string; path: string; from?: string; value?: unknown}>;

export type ClientView = {
  state: Record<string, unknown> | undefined;
  messages: unknown[] | undefined;
  /** Highest applied commit sequence. */
  seq: number;
  /** The last frame cursor (`<commitSeq>:<frameIndex>`) fully applied, if any. */
  cursor: string | undefined;
  /** Every applied frame cursor, in order (for duplicate/no-gap checks). */
  cursors: string[];
  appliedFrames: number;
  /** Frames grouped by the commit sequence part of the cursor. */
  groups: Map<string, Record<string, unknown>[]>;
  /** Events applied in order, for diagnostics. */
  types: string[];
};

export function createView(): ClientView {
  return {
    state: undefined, messages: undefined, seq: 0, cursor: undefined, cursors: [],
    appliedFrames: 0, groups: new Map(), types: [],
  };
}

export type FrameCursor = Readonly<{seq: number; index: number}>;

/** Parse the frozen frame-level cursor `<commitSeq>:<frameIndex>`. */
export function parseFrameCursor(id: string): FrameCursor {
  const match = /^([0-9]+):([0-9]+)$/.exec(id);
  if (match === null) throw new Error(`frame id is not <commitSeq>:<frameIndex>: ${id}`);
  const seq = Number(match[1]);
  const index = Number(match[2]);
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(index)) throw new Error(`frame id is not a safe cursor: ${id}`);
  return {seq, index};
}

/** Lexicographic order of two frame cursors: negative when `left` comes first. */
export function compareFrameCursors(left: string, right: string): number {
  const a = parseFrameCursor(left);
  const b = parseFrameCursor(right);
  return a.seq !== b.seq ? a.seq - b.seq : a.index - b.index;
}

export function frameCursorOf(frame: SseFrame): string {
  if (frame.id === undefined) throw new Error(`SSE frame has no id: ${frame.data}`);
  parseFrameCursor(frame.id);
  return frame.id;
}

/**
 * Apply one SSE frame to the client view exactly once, the way a real consumer must:
 * `STATE_SNAPSHOT` replaces the view, `STATE_DELTA` patches it, `MESSAGES_SNAPSHOT` replaces messages.
 */
export function applyFrame(view: ClientView, frame: SseFrame): Record<string, unknown> {
  const event = frameEvent(frame);
  const type = String(event.type);
  view.appliedFrames += 1;
  view.types.push(type);
  if (frame.id !== undefined) {
    const cursor = parseFrameCursor(frame.id);
    view.seq = Math.max(view.seq, cursor.seq);
    view.cursor = frame.id;
    view.cursors.push(frame.id);
    const key = String(cursor.seq);
    const group = view.groups.get(key);
    if (group === undefined) view.groups.set(key, [event]);
    else group.push(event);
  }
  if (type === 'STATE_SNAPSHOT') {
    const snapshot = event.snapshot;
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error('STATE_SNAPSHOT.snapshot is not an object');
    }
    view.state = structuredClone(snapshot) as Record<string, unknown>;
  } else if (type === 'STATE_DELTA') {
    const delta = event.delta;
    if (!Array.isArray(delta)) throw new Error('STATE_DELTA.delta is not an array');
    view.state = applyJsonPatch(view.state ?? {}, delta) as Record<string, unknown>;
  } else if (type === 'MESSAGES_SNAPSHOT') {
    const messages = event.messages;
    if (!Array.isArray(messages)) throw new Error('MESSAGES_SNAPSHOT.messages is not an array');
    view.messages = structuredClone(messages) as unknown[];
  }
  return event;
}

export function applyFrames(view: ClientView, frames: readonly SseFrame[]): void {
  for (const frame of frames) applyFrame(view, frame);
}

export function deltaOperations(events: readonly Record<string, unknown>[]): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [];
  for (const event of events) {
    if (event.type !== 'STATE_DELTA') continue;
    if (!Array.isArray(event.delta)) throw new Error('STATE_DELTA.delta is not an array');
    for (const raw of event.delta) {
      const operation = raw as {op?: unknown; path?: unknown};
      operations.push({op: String(operation.op), path: String(operation.path)});
    }
  }
  return operations;
}

/* -------------------------------------------------------------------------- */
/* RFC 6902 JSON Patch                                                        */
/* -------------------------------------------------------------------------- */

function pointerTokens(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function arrayIndex(token: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new Error(`invalid array index: ${token}`);
  return Number(token);
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object';
}

function parentOf(root: unknown, tokens: readonly string[]): {parent: unknown; key: string} {
  if (tokens.length === 0) throw new Error('the document root has no parent');
  let current = root;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const key = tokens[index]!;
    if (Array.isArray(current)) current = current[arrayIndex(key)];
    else if (isContainer(current)) current = (current as Record<string, unknown>)[key];
    else throw new Error(`patch path walks a non-container at ${key}`);
    if (current === undefined) throw new Error(`patch path member does not exist: ${key}`);
  }
  return {parent: current, key: tokens.at(-1)!};
}

function getAt(root: unknown, tokens: readonly string[]): unknown {
  let current = root;
  for (const key of tokens) {
    if (Array.isArray(current)) current = current[arrayIndex(key)];
    else if (isContainer(current)) {
      const record = current as Record<string, unknown>;
      if (!Object.hasOwn(record, key)) throw new Error(`patch path member does not exist: ${key}`);
      current = record[key];
    } else {
      throw new Error(`patch path walks a non-container at ${key}`);
    }
  }
  return current;
}

function addAt(root: unknown, tokens: readonly string[], value: unknown): unknown {
  if (tokens.length === 0) return value;
  const {parent, key} = parentOf(root, tokens);
  if (Array.isArray(parent)) {
    if (key === '-') { parent.push(value); return root; }
    const index = arrayIndex(key);
    if (index > parent.length) throw new Error(`array index out of range: ${key}`);
    parent.splice(index, 0, value);
    return root;
  }
  if (!isContainer(parent)) throw new Error('patch parent is not a container');
  (parent as Record<string, unknown>)[key] = value;
  return root;
}

function removeAt(
  root: unknown, tokens: readonly string[], tolerant = false,
): {root: unknown; removed: unknown} {
  if (tokens.length === 0) throw new Error('cannot remove the document root');
  const {parent, key} = parentOf(root, tokens);
  if (Array.isArray(parent)) {
    const index = arrayIndex(key);
    if (index >= parent.length) throw new Error(`array index out of range: ${key}`);
    const removed = parent.splice(index, 1)[0];
    return {root, removed};
  }
  if (!isContainer(parent)) throw new Error('patch parent is not a container');
  const record = parent as Record<string, unknown>;
  if (!Object.hasOwn(record, key)) {
    // Frozen contract: `remove` on a missing id-keyed member is ignored so replay is idempotent.
    if (tolerant) return {root, removed: undefined};
    throw new Error(`patch member does not exist: ${key}`);
  }
  const removed = record[key];
  delete record[key];
  return {root, removed};
}

function replaceAt(root: unknown, tokens: readonly string[], value: unknown): unknown {
  if (tokens.length === 0) return value;
  const {parent, key} = parentOf(root, tokens);
  if (Array.isArray(parent)) {
    const index = arrayIndex(key);
    if (index >= parent.length) throw new Error(`array index out of range: ${key}`);
    parent[index] = value;
    return root;
  }
  if (!isContainer(parent)) throw new Error('patch parent is not a container');
  const record = parent as Record<string, unknown>;
  if (!Object.hasOwn(record, key)) throw new Error(`patch member does not exist: ${key}`);
  record[key] = value;
  return root;
}

/** Apply an RFC 6902 JSON Patch; throws on malformed operations or paths instead of guessing. */
export function applyJsonPatch(document: unknown, patch: readonly unknown[]): unknown {
  let value = structuredClone(document);
  for (const raw of patch) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`invalid patch operation: ${JSON.stringify(raw)}`);
    }
    const operation = raw as {op?: unknown; path?: unknown; from?: unknown; value?: unknown};
    if (typeof operation.op !== 'string' || typeof operation.path !== 'string') {
      throw new Error(`patch operation needs string op/path: ${JSON.stringify(raw)}`);
    }
    const tokens = pointerTokens(operation.path);
    switch (operation.op) {
      case 'add':
        value = addAt(value, tokens, structuredClone(operation.value));
        break;
      case 'remove':
        value = removeAt(value, tokens, true).root;
        break;
      case 'replace':
        value = replaceAt(value, tokens, structuredClone(operation.value));
        break;
      case 'move': {
        if (typeof operation.from !== 'string') throw new Error('move needs from');
        const removed = removeAt(value, pointerTokens(operation.from));
        value = addAt(removed.root, tokens, removed.removed);
        break;
      }
      case 'copy': {
        if (typeof operation.from !== 'string') throw new Error('copy needs from');
        const copied = getAt(value, pointerTokens(operation.from));
        value = addAt(value, tokens, structuredClone(copied));
        break;
      }
      case 'test': {
        const current = getAt(value, tokens);
        if (!isDeepStrictEqual(current, operation.value)) {
          throw new Error(`test failed at ${operation.path}: ${JSON.stringify(current)} != ${JSON.stringify(operation.value)}`);
        }
        break;
      }
      default:
        throw new Error(`unsupported patch operation: ${operation.op}`);
    }
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Authority comparison                                                       */
/* -------------------------------------------------------------------------- */

/** Rows of one state family. The frozen shape is an id-keyed object; arrays are tolerated for fixtures. */
export function familyArray(state: Record<string, unknown> | undefined, family: string): unknown[] {
  const value = state?.[family];
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>);
  return [];
}

/** Stable identity of one row: `id` for entity rows, `key` for memory rows. */
export function rowIdentity(row: unknown): string {
  if (row === null || typeof row !== 'object') return '';
  const record = row as {id?: unknown; key?: unknown};
  return String(record.id ?? record.key ?? '');
}

/** Rows sorted by identity; key order carries no meaning in the frozen state shape. */
export function byId(items: readonly unknown[]): unknown[] {
  return [...items].sort((left, right) => {
    const leftId = rowIdentity(left);
    const rightId = rowIdentity(right);
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

/** True when `value` is an id-keyed object (the frozen family shape) rather than an array. */
export function isKeyedFamily(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function familyEquals(
  state: Record<string, unknown> | undefined, authority: Record<string, unknown>, family: string,
): boolean {
  return isDeepStrictEqual(byId(familyArray(state, family)), byId(familyArray(authority, family)));
}

export function sortedIdSet(state: Record<string, unknown> | undefined, family: string): string[] {
  return familyArray(state, family).map(rowIdentity).sort();
}

/** Wait until `check` is true, polling; throws with the last observed value on timeout. */
export async function waitFor<T>(
  description: string, check: () => T | undefined | false, timeoutMs = 15_000, intervalMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await delay(intervalMs);
  }
}

/* -------------------------------------------------------------------------- */
/* Thread stream helpers                                                      */
/* -------------------------------------------------------------------------- */

export function openThreadStream(
  server: VerifyServer, threadId: string, lastEventId?: string, timeoutMs = 10_000,
): Promise<RawStream> {
  return RawStream.open({
    port: server.port,
    path: `/v1/threads/${encodeURIComponent(threadId)}/stream`,
    token: TOKEN,
    ...(lastEventId === undefined ? {} : {lastEventId}),
  }, timeoutMs);
}

/** Read frames through the sync run's `RUN_FINISHED`. */
export async function readSyncRun(stream: RawStream, timeoutMs = 15_000): Promise<SseFrame[]> {
  return stream.readUntil(frame => frameType(frame) === 'RUN_FINISHED', timeoutMs);
}

export function isSyncRunStarted(frame: SseFrame): boolean {
  const event = frameEvent(frame);
  if (event.type !== 'RUN_STARTED') return false;
  return String(event.runId ?? '').startsWith('sync-')
    || (event.metadata as Record<string, unknown> | undefined)?.['point.sync'] === true;
}

export function isLiveRunStarted(frame: SseFrame): boolean {
  const event = frameEvent(frame);
  return event.type === 'RUN_STARTED' && String(event.runId ?? '').startsWith('live-');
}

export function resyncEvent(frames: readonly SseFrame[]): Record<string, unknown> | undefined {
  for (const frame of frames) {
    const event = frameEvent(frame);
    if (event.type === 'CUSTOM' && event.name === 'point.stream.resync') return event;
  }
  return undefined;
}

/** The authoritative visible-message projection of one thread, as the AG-UI snapshot should carry it. */
export async function expectedMessages(server: VerifyServer, threadId: string): Promise<unknown[]> {
  const history = await server.runtime.conversation.history(threadId) as unknown as {
    items: ReadonlyArray<{id: string; role: string; text: string}>;
  };
  return history.items.map(item => ({id: item.id, role: item.role, content: item.text}));
}

/** One real foreground chat run on the thread; resolves after the run stream closes. */
export async function runChatTurn(server: VerifyServer, threadId: string, text: string, key: string): Promise<void> {
  const response = await fetch(`${server.base}/v1/agent`, {
    method: 'POST',
    headers: {'idempotency-key': key, ...JSON_HEADERS, ...AUTH},
    body: JSON.stringify({
      threadId, runId: `verify-client-${key}`, messages: [{id: `verify-${key}`, role: 'user', content: text}],
    }),
  });
  if (response.status !== 200) throw new Error(`chat run failed: ${response.status} ${await response.text()}`);
  await response.text();
}

/** Wait until storage calls have been quiet for `quietMs` (fixture precondition, not a verdict). */
export async function quiesce(
  counter: StorageCounter, quietMs = 300, maxMs = 10_000,
): Promise<StorageCounts> {
  const deadline = Date.now() + maxMs;
  let observed = counter.snapshot();
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    await delay(20);
    const current = counter.snapshot();
    const changed = (Object.keys(observed) as (keyof StorageCounts)[])
      .some(name => observed[name] !== current[name]);
    if (changed) { observed = current; lastChange = Date.now(); }
    else if (Date.now() - lastChange >= quietMs) return current;
  }
  throw new Error(`storage calls did not quiesce within ${maxMs}ms: ${formatCounts(counter.snapshot())}`);
}

/** Paths touched by the `STATE_DELTA` operations in one commit group. */
export function groupDeltaPaths(events: readonly Record<string, unknown>[]): string[] {
  const paths: string[] = [];
  for (const event of events) {
    if (event.type !== 'STATE_DELTA') continue;
    for (const raw of event.delta as unknown[]) {
      const operation = raw as {path?: unknown};
      paths.push(String(operation.path));
    }
  }
  return paths;
}

export function groupDeltaOperations(events: readonly Record<string, unknown>[]): unknown[] {
  const operations: unknown[] = [];
  for (const event of events) {
    if (event.type !== 'STATE_DELTA') continue;
    for (const raw of event.delta as unknown[]) operations.push(raw);
  }
  return operations;
}
