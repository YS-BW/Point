/**
 * WP6.1 read-model contract: `GET /v1/state` shape/bounds/auth and the `/inspect` Durable counts.
 *
 * The load-bearing assertion is the roadmap exit criterion: serving `/v1/state` must not touch the
 * Durable task reader. It is checked by counting real calls into the SQLite storage implementation
 * while a real server serves a real database, not by inspecting source code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openRuntime } from '../src/runtime/open.js';
import { startServer } from '../src/bootstrap.js';

const TOKEN = 'read-model-token-0123456789';
const AUTH = {authorization: `Bearer ${TOKEN}`};
const STATE_FAMILIES = ['chats', 'jobs', 'resources', 'memory', 'events'] as const;

type StateBody = Record<string, unknown> & {
  seq: number;
  chats: Record<string, {id: string; name: string}>;
  jobs: Record<string, {id: string; status: string; revision: number}>;
  resources: Record<string, {id: string; state: string}>;
  memory: Record<string, {key: string; kind: string}>;
  events: Record<string, {id: string; type: string}>;
  truncated?: Record<string, true>;
};

/**
 * Seed the data directory *before* the server opens it: the runtime enforces a single writer, so a
 * second `openRuntime` on the same directory while the server runs would (correctly) throw
 * DATA_DIR_BUSY.
 */
async function withServer(
  body: (base: string) => Promise<void>,
  options: Readonly<{inspect?: boolean; seed?: (runtime: Awaited<ReturnType<typeof openRuntime>>) => Promise<void>}> = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'point-state-'));
  if (options.seed !== undefined) {
    const seedRuntime = await openRuntime(dir);
    try {
      await options.seed(seedRuntime);
    } finally {
      await seedRuntime.close();
    }
  }
  const app = await startServer({
    host: '127.0.0.1', port: 0, dataDir: dir, apiToken: TOKEN, apiInspect: options.inspect ?? true,
  });
  try {
    await body(`http://127.0.0.1:${app.port}`);
  } finally {
    await app.close();
    await rm(dir, {recursive: true, force: true});
  }
}

async function get(base: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, {headers: AUTH});
}

test('GET /v1/state returns the frozen shape and is served without any task-reader call', {timeout: 60000}, async () => {
  await withServer(async base => {
    // Guard the intent, not just the literal criterion: `task` is the named judgement, but a
    // regression that started enumerating the task table through `scanTasks` would be just as wrong.
    const originalTask = SqliteStorage.prototype.task;
    const originalScan = SqliteStorage.prototype.scanTasks;
    let taskCalls = 0;
    let taskScans = 0;
    SqliteStorage.prototype.task = function counted(this: SqliteStorage, ...args: Parameters<typeof originalTask>) {
      taskCalls += 1;
      return originalTask.apply(this, args);
    } as typeof originalTask;
    SqliteStorage.prototype.scanTasks = function countedScan(this: SqliteStorage, ...args: Parameters<typeof originalScan>) {
      taskScans += 1;
      return originalScan.apply(this, args);
    } as typeof originalScan;
    try {
      const response = await get(base, '/v1/state');
      assert.equal(response.status, 200);
      const body = await response.json() as StateBody;

      // Root shape: the body IS the state view, no wrapper.
      assert.equal(typeof body.seq, 'number');
      assert.ok(body.seq >= 0);
      for (const family of STATE_FAMILIES) {
        assert.equal(typeof body[family], 'object', `${family} is an object keyed by id`);
        assert.equal(Array.isArray(body[family]), false, `${family} is not an array`);
      }
      assert.equal(Object.keys(body.chats).length, 1, 'the seeded chat is visible');
      assert.equal(body.chats[chatIdOf(body)]?.name, '读模型夹具');
      assert.ok(body.events !== undefined, 'events family is present');
      assert.equal(taskCalls, 0, 'serving /v1/state must not call the Durable task reader');
      assert.equal(taskScans, 0, 'serving /v1/state must not scan the Durable task table either');
    } finally {
      SqliteStorage.prototype.task = originalTask;
      SqliteStorage.prototype.scanTasks = originalScan;
    }
  }, {
    seed: async runtime => { await runtime.chats.create({requestId: 'seed-chat-1', name: '读模型夹具'}); },
  });
});

function chatIdOf(body: StateBody): string {
  const ids = Object.keys(body.chats);
  assert.equal(ids.length, 1);
  return ids[0]!;
}

test('GET /v1/state requires auth and never requires an Idempotency-Key', {timeout: 30000}, async () => {
  await withServer(async base => {
    const unauthorized = await fetch(`${base}/v1/state`);
    assert.equal(unauthorized.status, 401);
    const envelope = await unauthorized.json() as {error: {code: string}};
    assert.equal(envelope.error.code, 'UNAUTHORIZED');

    const authorized = await fetch(`${base}/v1/state`, {headers: AUTH});
    assert.equal(authorized.status, 200, 'a read needs no Idempotency-Key');
  });
});

test('GET /v1/state memory rows never expose the stored value body', {timeout: 60000}, async () => {
  await withServer(async base => {
    const body = await (await get(base, '/v1/state')).json() as StateBody & {
      memory: Record<string, Record<string, unknown>>;
    };
    const row = body.memory.tone;
    assert.ok(row !== undefined, 'the memory key is listed');
    assert.equal(row.kind, 'preference');
    assert.equal('value' in row, false, 'the memory body stays out of the state view');
    // The body is still readable through the existing REST endpoint.
    const profile = await (await get(base, '/v1/profile')).json() as Array<{key: string; value: string}>;
    assert.ok(profile.some(item => item.key === 'tone' && item.value === '简洁直接'));
  }, {
    seed: async runtime => {
      await runtime.profile.remember({
        requestId: 'seed-memory-1', key: 'tone', value: '简洁直接', kind: 'preference', sourceChatId: '1',
      });
    },
  });
});

test('GET /inspect reports the frozen Durable count shape, additively', {timeout: 60000}, async () => {
  await withServer(async base => {
    const response = await get(base, '/inspect');
    assert.equal(response.status, 200);
    const body = await response.json() as {
      version: number; instanceId: string; phase: string; capabilities: string[];
      counts: Record<string, number>; countsTruncated: boolean;
    };
    // Existing WP4 fields are unchanged.
    assert.equal(body.version, 1);
    assert.equal(typeof body.instanceId, 'string');
    assert.ok(['ready', 'starting', 'stopping'].includes(body.phase));
    assert.ok(Array.isArray(body.capabilities));
    // Frozen count keys: entity families only, no duplicate index counting.
    assert.deepEqual(Object.keys(body.counts).sort(), [
      'artifacts', 'attempts', 'chats', 'decisions', 'deliveries', 'events', 'jobs', 'memory',
      'occurrences', 'requests', 'resourceOperations', 'resources', 'schedules',
    ]);
    assert.equal(body.counts.chats, 1);
    assert.equal(body.countsTruncated, false);
  }, {
    seed: async runtime => { await runtime.chats.create({requestId: 'seed-chat-2', name: '计数夹具'}); },
  });
});

test('GET /inspect stays disabled (404 before auth) unless explicitly enabled', {timeout: 30000}, async () => {
  await withServer(async base => {
    const disabled = await fetch(`${base}/inspect`);
    assert.equal(disabled.status, 404, 'disabled is indistinguishable from absent, before auth');
  }, {inspect: false});
});
