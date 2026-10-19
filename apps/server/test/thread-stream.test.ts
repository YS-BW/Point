/**
 * WP6.3 thread-stream contract: documented binding, frame-level cursors, honest reconnect, single
 * fan-out across connections. Driven through the real HTTP server and a hand-written SSE reader so the
 * transport contract (not just the runtime port) is what is being asserted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../src/bootstrap.js';
import { openRuntime } from '../src/runtime/open.js';

const TOKEN = 'thread-stream-token-0123456789';
const AUTH = `Bearer ${TOKEN}`;

type Frame = {id?: string; event: Record<string, unknown>};

/** Minimal SSE reader over a raw HTTP response; never buffers more than the frames asked for. */
function openStream(port: number, path: string, lastEventId?: string) {
  const frames: Frame[] = [];
  let buffer = '';
  let carry: {data?: string; id?: string} = {};
  const waiters: Array<() => void> = [];
  const req = httpRequest({
    host: '127.0.0.1', port, path, method: 'GET',
    headers: {authorization: AUTH, ...(lastEventId === undefined ? {} : {'last-event-id': lastEventId})},
  });
  const response = new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
  void response.then(res => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.startsWith('id: ')) carry.id = line.slice(4);
        else if (line.startsWith('data: ')) carry.data = line.slice(6);
        else if (line === '') {
          if (carry.data !== undefined) {
            frames.push({...(carry.id === undefined ? {} : {id: carry.id}), event: JSON.parse(carry.data) as Record<string, unknown>});
          }
          carry = {};
          for (const wake of waiters.splice(0)) wake();
        }
        index = buffer.indexOf('\n');
      }
    });
    res.on('end', () => { for (const wake of waiters.splice(0)) wake(); });
  });
  return {
    frames,
    response,
    async waitFor(predicate: (frames: Frame[]) => boolean, timeoutMs = 10_000): Promise<Frame[]> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(frames)) {
        if (Date.now() > deadline) throw new Error(`frame timeout; saw ${frames.length}`);
        await Promise.race([
          new Promise<void>(resolve => waiters.push(resolve)),
          delay(50),
        ]);
      }
      return frames;
    },
    close(): void { req.destroy(); },
  };
}

async function withServer(body: (base: {port: number; dir: string}) => Promise<void>,
  seed?: (runtime: Awaited<ReturnType<typeof openRuntime>>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'point-thread-'));
  if (seed !== undefined) {
    const runtime = await openRuntime(dir);
    try { await seed(runtime); } finally { await runtime.close(); }
  }
  const app = await startServer({host: '127.0.0.1', port: 0, dataDir: dir, apiToken: TOKEN});
  try {
    await body({port: app.port, dir});
  } finally {
    await app.close();
    await rm(dir, {recursive: true, force: true});
  }
}

test('thread stream opens with a sync run and then a live run', {timeout: 60000}, async () => {
  let chatId = '';
  await withServer(async ({port}) => {
    const stream = openStream(port, `/v1/threads/${chatId}/stream`);
    try {
      const frames = await stream.waitFor(list => list.some(f => f.event.type === 'RUN_STARTED'
        && (f.event.runId as string).startsWith('live-')));
      const types = frames.map(frame => frame.event.type as string);
      // Sync run first: RUN_STARTED(sync) -> STATE_SNAPSHOT -> MESSAGES_SNAPSHOT -> RUN_FINISHED
      assert.equal(types[0], 'RUN_STARTED');
      assert.equal(frames[0]!.event.threadId, chatId, 'run frames carry the real thread id');
      assert.ok((frames[0]!.event.runId as string).startsWith('sync-'));
      assert.equal(frames[0]!.event.metadata instanceof Object, true);
      assert.deepEqual((frames[0]!.event.metadata as Record<string, unknown>)['point.sync'], true);
      const snapshotIndex = types.indexOf('STATE_SNAPSHOT');
      const messagesIndex = types.indexOf('MESSAGES_SNAPSHOT');
      const finishIndex = types.indexOf('RUN_FINISHED');
      const liveIndex = types.findIndex((type, index) => type === 'RUN_STARTED' && index > 0);
      assert.ok(snapshotIndex > 0 && messagesIndex > snapshotIndex && finishIndex > messagesIndex);
      assert.equal(liveIndex, finishIndex + 1, 'a live run starts immediately after the sync run');
      // Every frame is inside a run: nothing precedes the first RUN_STARTED.
      assert.equal(frames[0]!.event.type, 'RUN_STARTED');
    } finally {
      stream.close();
    }
  }, async runtime => {
    const chat = await runtime.chats.create({requestId: 'thread-chat-1', name: '线程流'});
    chatId = chat.id;
  });
});

test('frame ids are frame-level cursors, distinct within one commit', {timeout: 60000}, async () => {
  let chatId = '';
  await withServer(async ({port}) => {
    const stream = openStream(port, `/v1/threads/${chatId}/stream`);
    try {
      const frames = await stream.waitFor(list => list.filter(f => f.id !== undefined).length >= 5);
      const ids = frames.map(frame => frame.id).filter((id): id is string => id !== undefined);
      assert.equal(new Set(ids).size, ids.length, 'cursors are unique per frame');
      for (const id of ids) assert.match(id, /^[0-9]+:[0-9]+$/);
      // The preface emits several frames for one sequence; they must not share a cursor.
      const seqs = ids.map(id => id.split(':')[0]);
      assert.equal(new Set(seqs).size, 1, 'the snapshot uses one commit sequence');
      assert.ok(new Set(ids).size > 1, 'multiple frames of one commit have distinct cursors');
    } finally {
      stream.close();
    }
  }, async runtime => {
    const chat = await runtime.chats.create({requestId: 'thread-chat-2', name: '游标'});
    chatId = chat.id;
  });
});

test('reconnect replays only the frames after the cursor', {timeout: 60000}, async () => {
  let chatId = '';
  await withServer(async ({port}) => {
    const first = openStream(port, `/v1/threads/${chatId}/stream`);
    const frames = await first.waitFor(list => list.some(f => f.event.type === 'RUN_STARTED'
      && (f.event.runId as string).startsWith('live-')));
    const cursor = frames[frames.length - 1]!.id!;
    first.close();

    // Produce one more commit while "offline".
    await createChat(port, 'thread-chat-offline', '离线期间');

    const second = openStream(port, `/v1/threads/${chatId}/stream`, cursor);
    try {
      const replayed = await second.waitFor(list => list.some(f => f.id !== undefined
        && cursorOf(f.id!) > cursorOf(cursor)));
      const after = replayed.filter(f => f.id !== undefined && cursorOf(f.id) > cursorOf(cursor));
      assert.ok(after.length > 0, 'frames after the cursor are replayed');
      assert.equal(replayed.some(f => f.event.name === 'point.stream.resync'), false,
        'an in-window cursor does not resync');
      // The fresh connection's own live run precedes the replayed content frames.
      assert.equal(replayed[0]!.event.type, 'RUN_STARTED', 'no replay frame arrives outside a run');
    } finally {
      second.close();
    }
  }, async runtime => {
    const chat = await runtime.chats.create({requestId: 'thread-chat-3', name: '重连'});
    chatId = chat.id;
  });
});

function cursorOf(id: string): number[] {
  return id.split(':').map(Number);
}

/** Create a chat through the API: the running server owns the data directory (single writer). */
async function createChat(port: number, requestId: string, name: string): Promise<{id: string}> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chats`, {
    method: 'POST',
    headers: {authorization: AUTH, 'content-type': 'application/json', 'idempotency-key': requestId},
    body: JSON.stringify({name}),
  });
  assert.equal(response.status, 200);
  return await response.json() as {id: string};
}

test('an unknown cursor triggers an explicit resync, not a fake continuation', {timeout: 60000}, async () => {
  let chatId = '';
  await withServer(async ({port}) => {
    const stream = openStream(port, `/v1/threads/${chatId}/stream`, '999999:0');
    try {
      const frames = await stream.waitFor(list => list.some(f => f.event.name === 'point.stream.resync'));
      const resync = frames.find(f => f.event.name === 'point.stream.resync');
      assert.ok(resync !== undefined);
      const value = resync!.event.value as {reason: string};
      assert.ok(['window_exceeded', 'unknown_seq', 'process_restarted'].includes(value.reason));
      // A resync still carries a fresh authoritative snapshot.
      assert.ok(frames.some(f => f.event.type === 'STATE_SNAPSHOT'));
    } finally {
      stream.close();
    }
  }, async runtime => {
    const chat = await runtime.chats.create({requestId: 'thread-chat-4', name: '重同步'});
    chatId = chat.id;
  });
});

test('two connections each receive one copy of a commit frame', {timeout: 60000}, async () => {
  let chatId = '';
  await withServer(async ({port}) => {
    const first = openStream(port, `/v1/threads/${chatId}/stream`);
    const second = openStream(port, `/v1/threads/${chatId}/stream`);
    try {
      await first.waitFor(list => list.some(f => f.event.type === 'RUN_STARTED' && (f.event.runId as string).startsWith('live-')));
      await second.waitFor(list => list.some(f => f.event.type === 'RUN_STARTED' && (f.event.runId as string).startsWith('live-')));
      const before = {first: first.frames.length, second: second.frames.length};
      await createChat(port, 'thread-chat-fanout', '扇出');
      const deltaCount = (frames: Frame[]): number => frames
        .slice(before.first)
        .filter(f => f.event.type === 'STATE_DELTA'
          && JSON.stringify(f.event.delta).includes('扇出')).length;
      await first.waitFor(() => deltaCount(first.frames) > 0);
      await second.waitFor(() => deltaCount(second.frames) > 0);
      assert.equal(deltaCount(first.frames), 1, 'each connection gets exactly one copy');
      assert.equal(deltaCount(second.frames), 1, 'each connection gets exactly one copy');
    } finally {
      first.close();
      second.close();
    }
  }, async runtime => {
    const chat = await runtime.chats.create({requestId: 'thread-chat-5', name: '扇出夹具'});
    chatId = chat.id;
  });
});

test('unknown thread fails on the REST envelope without opening a stream', {timeout: 30000}, async () => {
  await withServer(async ({port}) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/threads/not-a-chat/stream`, {
      headers: {authorization: AUTH},
    });
    assert.equal(response.status, 404);
    const body = await response.json() as {error: {code: string}};
    assert.equal(body.error.code, 'CHAT_NOT_FOUND');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  });
});
