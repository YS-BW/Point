/**
 * Self-check for the verification harness itself (tester lane).
 *
 * The WP6 verdicts stand on this raw-socket SSE parser and the RFC 6902 applier. If either is wrong,
 * a broken implementation could look green (or a correct one red). This file exercises them against a
 * controlled local HTTP server, including split chunks, split UTF-8 sequences, CRLF frames, keepalive
 * comments and every JSON Patch operation, before any server code under test is involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  RawStream, applyJsonPatch, compareFrameCursors, frameEvent, frameType, parseFrameCursor,
} from './support.js';

/* -------------------------------------------------------------------------- */
/* Raw-socket SSE parsing                                                     */
/* -------------------------------------------------------------------------- */

async function sseServer(
  t: {after(fn: () => Promise<void>): void},
  handler: (request: {headers: Record<string, string | string[] | undefined>}, response: import('node:http').ServerResponse) => void,
): Promise<number> {
  const server = createServer((request, response) => handler({headers: request.headers}, response));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return (server.address() as AddressInfo).port;
}

test('raw SSE parser decodes chunked frames, split UTF-8, CRLF and keepalive comments', async t => {
  let seen: Record<string, string | string[] | undefined> = {};
  const port = await sseServer(t, ({headers}, response) => {
    seen = headers;
    response.writeHead(200, {'content-type': 'text/event-stream'});
    const first = 'id: 12:0\ndata: {"type":"STATE_SNAPSHOT","snapshot":{"名称":"中文"}}\n\n';
    const bytes = Buffer.from(first, 'utf8');
    // Split exactly inside the first Chinese character (3 bytes) and again inside the second one.
    const nameByte = bytes.indexOf(Buffer.from('中', 'utf8'));
    response.write(bytes.subarray(0, nameByte + 1));
    response.write(bytes.subarray(nameByte + 1, nameByte + 5));
    response.write(bytes.subarray(nameByte + 5));
    // CRLF frame and a keepalive comment frame.
    response.write('id: 12:1\r\ndata: {"type":"STATE_DELTA","delta":[]}\r\n\r\n');
    response.write(': keepalive\n\n');
    response.write('id: 13:0\ndata: {"type":"CUSTOM","name":"point.job.started","value":{"runId":"7"}}\n\n');
    response.end();
  });

  const stream = await RawStream.open({port, path: '/stream', token: 'secret-token', lastEventId: '11:9'});
  const first = await stream.next(2_000);
  assert.ok(first !== undefined);
  assert.equal(first.id, '12:0');
  assert.equal(frameType(first), 'STATE_SNAPSHOT');
  assert.deepEqual((frameEvent(first).snapshot as {名称: string}).名称, '中文',
    'split multi-byte UTF-8 must be reassembled');
  const second = await stream.next(2_000);
  assert.equal(second?.id, '12:1');
  assert.equal(frameType(second!), 'STATE_DELTA');
  const third = await stream.next(2_000);
  assert.equal(third?.id, '13:0', 'keepalive comments must not surface as frames');
  assert.equal(frameType(third!), 'CUSTOM');
  assert.equal(await stream.next(500), undefined, 'a comment-only stream must not fabricate frames');

  assert.deepEqual(seen['last-event-id'], '11:9', 'the raw client sends Last-Event-ID verbatim');
  assert.deepEqual(seen.authorization, 'Bearer secret-token');
  assert.equal(stream.status, 200);
  await stream.close();
});

test('raw SSE parser exposes REST envelopes as headers/status without inventing frames', async t => {
  const port = await sseServer(t, (_request, response) => {
    const body = JSON.stringify({error: {code: 'UNAUTHORIZED', message: 'unauthorized', requestId: 'r-1'}});
    response.writeHead(401, {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)});
    response.end(body);
  });
  const stream = await RawStream.open({port, path: '/v1/threads/1/stream'});
  assert.equal(stream.status, 401);
  assert.equal(stream.responseHeaders['content-type'], 'application/json');
  assert.equal(await stream.next(300), undefined, 'a JSON body is not an SSE frame');
  await stream.close();
});

/* -------------------------------------------------------------------------- */
/* RFC 6902 JSON Patch                                                        */
/* -------------------------------------------------------------------------- */

test('JSON Patch applier implements add/remove/replace/move/copy/test and pointer escaping', () => {
  const document = {
    chats: [{id: '1', name: 'a'}, {id: '2', name: 'b'}],
    jobs: {'3': {id: '3', revision: 1}},
    'a/b': {'c~d': 1},
  };

  assert.deepEqual(applyJsonPatch(document, [{op: 'replace', path: '/jobs/3/revision', value: 2}]), {
    ...document, jobs: {'3': {id: '3', revision: 2}},
  });
  assert.deepEqual(applyJsonPatch(document, [{op: 'add', path: '/chats/1/name', value: 'B'}]), {
    ...document, chats: [{id: '1', name: 'a'}, {id: '2', name: 'B'}],
  });
  assert.deepEqual(applyJsonPatch(document, [{op: 'add', path: '/chats/-', value: {id: '3', name: 'c'}}]),
    {...document, chats: [...document.chats, {id: '3', name: 'c'}]});
  assert.deepEqual(applyJsonPatch(document, [{op: 'remove', path: '/chats/0'}]), {
    ...document, chats: [{id: '2', name: 'b'}],
  });
  assert.deepEqual(applyJsonPatch(document, [{op: 'copy', from: '/jobs/3', path: '/jobs/4'}]), {
    ...document, jobs: {'3': {id: '3', revision: 1}, '4': {id: '3', revision: 1}},
  });
  assert.deepEqual(applyJsonPatch(document, [{op: 'move', from: '/jobs/3', path: '/jobs/5'}]), {
    ...document, jobs: {'5': {id: '3', revision: 1}},
  });
  assert.deepEqual(applyJsonPatch(document, [{op: 'test', path: '/jobs/3/revision', value: 1}]), document);
  assert.deepEqual(applyJsonPatch(document, [{op: 'add', path: '/a~1b/c~0d', value: 2}]), {
    ...document, 'a/b': {'c~d': 2},
  });
  assert.deepEqual(applyJsonPatch({value: 1}, [{op: 'replace', path: '', value: {value: 2}}]), {value: 2},
    'a root replace is legal RFC 6902');

  // Frozen tolerance: `remove` of a missing id-keyed member is ignored so replay is idempotent.
  assert.deepEqual(applyJsonPatch(document, [{op: 'remove', path: '/jobs/9'}]), document);

  // Malformed or unsatisfiable patches must still fail loudly, never be ignored.
  assert.throws(() => applyJsonPatch(document, [{op: 'replace', path: '/jobs/9/revision', value: 1}]));
  assert.throws(() => applyJsonPatch(document, [{op: 'test', path: '/jobs/3/revision', value: 9}]));
  assert.throws(() => applyJsonPatch(document, [{op: 'add', path: 'jobs/3', value: 1}]));
  assert.throws(() => applyJsonPatch(document, [{op: 'move', from: '/jobs/9', path: '/jobs/8'}]));
  assert.throws(() => applyJsonPatch(document, [{op: 'frobnicate', path: '/jobs/3'}] as never));
  assert.throws(() => applyJsonPatch(document, [{path: '/jobs/3'}] as never));
});

test('state deltas are replay-safe: add-existing replaces and remove-missing is ignored', () => {
  const snapshot = {jobs: {'1': {id: '1', revision: 1}}};
  const delta = [
    {op: 'replace', path: '/jobs/1', value: {id: '1', revision: 2}},
    {op: 'add', path: '/jobs/2', value: {id: '2', revision: 1}},
    {op: 'remove', path: '/jobs/9'},
  ];
  const once = applyJsonPatch(snapshot, delta);
  const twice = applyJsonPatch(once, delta);
  assert.deepEqual(once, {jobs: {'1': {id: '1', revision: 2}, '2': {id: '2', revision: 1}}});
  assert.deepEqual(twice, once, 're-applying the same delta must not change the view');
});

test('JSON Patch does not mutate the input document', () => {
  const document = {chats: [{id: '1'}]};
  const before = structuredClone(document);
  applyJsonPatch(document, [
    {op: 'replace', path: '/chats/0/id', value: '2'},
    {op: 'add', path: '/chats/-', value: {id: '3'}},
  ]);
  assert.deepEqual(document, before);
});

/* -------------------------------------------------------------------------- */
/* Frame cursor helpers                                                       */
/* -------------------------------------------------------------------------- */

test('frame cursors parse, order and reject malformed ids', () => {
  assert.deepEqual(parseFrameCursor('42:0'), {seq: 42, index: 0});
  assert.deepEqual(parseFrameCursor('42:19'), {seq: 42, index: 19});
  assert.ok(compareFrameCursors('42:1', '42:2') < 0);
  assert.ok(compareFrameCursors('42:9', '43:0') < 0);
  assert.ok(compareFrameCursors('43:0', '43:0') === 0);
  assert.ok(compareFrameCursors('43:1', '42:99') > 0);
  for (const bad of ['42', '42:', ':1', 'x:1', '1:x', '1:2:3', '-1:0', '1.5:0']) {
    assert.throws(() => parseFrameCursor(bad), bad);
  }
});
