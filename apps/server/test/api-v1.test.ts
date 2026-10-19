/**
 * WP4 `/v1` contract: routing, error envelope, auth fail-closed, body bounds,
 * Idempotency-Key -> requestId mapping, byte-identical replay, log redaction and the
 * transport thinness over existing application commands.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttp, type ApiRuntime } from '../src/api/http.js';
import { CommandError } from '../src/domain/chat.js';
import { ResourceError } from '../src/domain/resource.js';
import { startServer } from '../src/bootstrap.js';
import { readConfig } from '../src/config.js';

const TOKEN = 'test-token-0123456789';
const AUTH = {authorization: `Bearer ${TOKEN}`};
const JSON_HEADERS = {'content-type': 'application/json'};

type Call = {name: string; input: unknown};

function idempotent(calls: Call[], receipts: Map<string, {fingerprint: string; result: unknown}>,
  name: string, input: unknown, produce: () => unknown): unknown {
  calls.push({name, input});
  const requestId = (input as {requestId?: unknown}).requestId;
  if (typeof requestId !== 'string') throw new CommandError('INVALID_COMMAND');
  const fingerprint = JSON.stringify(input);
  const existing = receipts.get(requestId);
  if (existing !== undefined) {
    if (existing.fingerprint !== fingerprint) throw new CommandError('IDEMPOTENCY_CONFLICT');
    return existing.result;
  }
  const result = produce();
  receipts.set(requestId, {fingerprint, result});
  return result;
}

function runtime(overrides: Readonly<Record<string, unknown>> = {}) {
  const calls: Call[] = [];
  const receipts = new Map<string, {fingerprint: string; result: unknown}>();
  const errorFor = (name: string): never | undefined => {
    const value = overrides[name];
    if (value instanceof Error) throw value;
    return undefined;
  };
  const api = {
    instanceId: 'instance-1',
    chats: {
      async create(input: unknown) {
        errorFor('chats.create');
        return idempotent(calls, receipts, 'chats.create', input, () => ({id: '1', name: (input as {name: string}).name, createdAt: 1}));
      },
      async get(id: string) { calls.push({name: 'chats.get', input: id}); return id === '1' ? {id: '1', name: '项目计划', createdAt: 1} : undefined; },
    },
    conversation: {
      async send(input: unknown) { errorFor('conversation.send'); return idempotent(calls, receipts, 'conversation.send', input, () => ({commandId: '100'})); },
      async stop(input: unknown) { errorFor('conversation.stop'); return idempotent(calls, receipts, 'conversation.stop', input, () => ({commandId: '101'})); },
      async compact(input: unknown) { return idempotent(calls, receipts, 'conversation.compact', input, () => ({commandId: '102'})); },
      async status(commandId: string) {
        calls.push({name: 'conversation.status', input: commandId});
        if (commandId === 'missing') throw new Error('COMMAND_NOT_FOUND');
        return {status: 'answered'};
      },
      async wait() { throw new Error('NOT_IMPLEMENTED'); },
      async compactStatus() { return {status: 'completed'}; },
      async compactWait() { return {status: 'completed'}; },
      async history(chatId: string, limit?: number, cursor?: string) {
        calls.push({name: 'conversation.history', input: {chatId, limit, cursor}});
        return {items: [], ...(cursor === undefined ? {} : {next: cursor})};
      },
    },
    profile: {
      async remember(input: unknown) { return idempotent(calls, receipts, 'profile.remember', input, () => ({key: 'tone', value: '简洁', kind: 'preference', sourceChatId: '1'})); },
      async forget(input: unknown) { return idempotent(calls, receipts, 'profile.forget', input, () => ({key: 'tone', removed: true})); },
      async list() { calls.push({name: 'profile.list', input: undefined}); return []; },
      async exportMarkdown() { calls.push({name: 'profile.export', input: undefined}); return '# USER\n'; },
    },
    jobs: {
      async start(input: unknown) { errorFor('jobs.start'); return idempotent(calls, receipts, 'jobs.start', input, () => ({jobId: 'job-1', revision: 1, attemptId: 'job-1-1'})); },
      async amend(input: unknown) { return idempotent(calls, receipts, 'jobs.amend', input, () => ({jobId: 'job-1', revision: 2, attemptId: 'job-1-2'})); },
      async cancel(input: unknown) { errorFor('jobs.cancel'); return idempotent(calls, receipts, 'jobs.cancel', input, () => ({jobId: 'job-1', status: 'cancelled'})); },
      async get(jobId: string) { errorFor('jobs.get'); calls.push({name: 'jobs.get', input: jobId}); return jobId === 'job-1' ? {id: 'job-1'} : undefined; },
      async attempts(jobId: string) { calls.push({name: 'jobs.attempts', input: jobId}); return []; },
      async artifact(artifactId: string) { calls.push({name: 'jobs.artifact', input: artifactId}); return artifactId === 'att:call' ? {artifact: {id: 'att:call'}, verified: true} : undefined; },
    },
    followups: {
      async schedule(input: unknown) { return idempotent(calls, receipts, 'followups.schedule', input, () => ({scheduleId: 's-1', occurrenceIds: ['o-1']})); },
      async cancel(input: unknown) { return idempotent(calls, receipts, 'followups.cancel', input, () => ({scheduleId: 's-1', status: 'cancelled'})); },
      async get(scheduleId: string) { calls.push({name: 'followups.get', input: scheduleId}); return scheduleId === 's-1' ? {id: 's-1'} : undefined; },
      async occurrences(scheduleId: string) { calls.push({name: 'followups.occurrences', input: scheduleId}); return []; },
      async decisions(jobId?: string) { calls.push({name: 'followups.decisions', input: jobId}); return []; },
      async deliveries(jobId?: string) { calls.push({name: 'followups.deliveries', input: jobId}); return []; },
    },
    deliveries: {
      async get(deliveryId: string) { calls.push({name: 'deliveries.get', input: deliveryId}); return deliveryId === 'd-1' ? {id: 'd-1'} : undefined; },
      async list() { return []; },
    },
  };
  return {api: api as unknown as ApiRuntime, calls};
}

type Fixture = Readonly<{url: string; log: string[]; calls: Call[]; close(): Promise<void>}>;

async function serve(t: TestContext, overrides: Readonly<Record<string, unknown>> = {},
  options: Readonly<{apiToken?: string; inspect?: boolean; runtime?: boolean}> = {}): Promise<Fixture> {
  const fake = runtime(overrides);
  const log: string[] = [];
  const server = createHttp({
    health: {status: () => ({phase: 'ready', capabilities: ['foundation']})},
    ...(options.runtime === false ? {} : {commands: fake.api}),
    ...(options.apiToken === undefined ? {} : {apiToken: options.apiToken}),
    inspect: options.inspect === true,
    log: line => log.push(line),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const {port} = server.address() as AddressInfo;
  return {url: `http://127.0.0.1:${port}`, log, calls: fake.calls, close: () => new Promise(resolve => server.close(() => resolve()))};
}

async function call(f: Fixture, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(f.url + path, init);
}

async function json(response: Response): Promise<{error?: {code: string; message: string; requestId: string}}> {
  return await response.json() as {error?: {code: string; message: string; requestId: string}};
}

/* -------------------------------------------------------------------------- */
/* Routing, envelope and methods                                              */
/* -------------------------------------------------------------------------- */

test('unknown paths are 404 and unsupported methods are 405 with Allow, before auth', async t => {
  const f = await serve(t);
  const unknown = await call(f, '/v1/nope');
  assert.equal(unknown.status, 404);
  assert.equal((await json(unknown)).error?.code, 'NOT_FOUND');
  const wrongMethod = await call(f, '/v1/chats', {method: 'DELETE'});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  assert.equal((await json(wrongMethod)).error?.code, 'METHOD_NOT_ALLOWED');
  // Health stays open and keeps the foundation shape.
  const live = await call(f, '/health/live');
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), {phase: 'ready', capabilities: ['foundation']});
  assert.equal((await call(f, '/health/live', {method: 'POST'})).status, 405);
});

test('every error carries the stable envelope with the request id header', async t => {
  const f = await serve(t, {}, {apiToken: TOKEN});
  const response = await call(f, '/v1/nope', {headers: {...AUTH, 'x-request-id': 'req-1'}});
  const body = await json(response);
  assert.equal(body.error?.code, 'NOT_FOUND');
  assert.equal(body.error?.requestId, 'req-1');
  assert.equal(response.headers.get('x-request-id'), 'req-1');
  assert.equal(typeof body.error?.message, 'string');
});

/* -------------------------------------------------------------------------- */
/* Auth fail-closed                                                           */
/* -------------------------------------------------------------------------- */

test('without a configured token known /v1 routes are 503 while health stays open', async t => {
  const f = await serve(t);
  const response = await call(f, '/v1/chats', {method: 'POST', headers: {'idempotency-key': 'key-0001'}});
  assert.equal(response.status, 503);
  assert.equal((await json(response)).error?.code, 'API_NOT_CONFIGURED');
  const rejected = await call(f, '/v1/chats/1', {headers: AUTH});
  assert.equal(rejected.status, 503);
  assert.equal((await call(f, '/health/ready')).status, 200);
});

test('a configured token accepts the exact bearer and rejects missing or wrong ones', async t => {
  const f = await serve(t, {}, {apiToken: TOKEN});
  const ok = await call(f, '/v1/chats/1', {headers: AUTH});
  assert.equal(ok.status, 200);
  for (const headers of [{}, {authorization: `Bearer ${TOKEN}x`}, {authorization: `bearer ${TOKEN}`}, {authorization: TOKEN}]) {
    const rejected = await call(f, '/v1/chats/1', {headers});
    assert.equal(rejected.status, 401, JSON.stringify(headers));
    assert.equal((await json(rejected)).error?.code, 'UNAUTHORIZED');
  }
  assert.equal(f.calls.filter(entry => entry.name === 'chats.get').length, 1, 'rejected auth runs no command');
});

/* -------------------------------------------------------------------------- */
/* Body limits and strict JSON                                                */
/* -------------------------------------------------------------------------- */

test('Content-Type, strict JSON and 1 MiB limit are enforced without executing commands', async t => {
  const f = await serve(t, {}, {apiToken: TOKEN});
  const write = (headers: Record<string, string>, body?: string) => call(f, '/v1/chats', {
    method: 'POST', headers: {'idempotency-key': 'key-0002', ...AUTH, ...headers}, ...(body === undefined ? {} : {body}),
  });
  assert.equal((await write({}, JSON.stringify({name: 'x'}))).status, 400, 'missing content-type');
  assert.equal((await write({'content-type': 'text/plain'}, JSON.stringify({name: 'x'}))).status, 400);
  assert.equal((await write(JSON_HEADERS, '{bad json')).status, 400);
  assert.equal((await write(JSON_HEADERS, '[1,2]')).status, 400);
  const oversized = `{"name":"${'x'.repeat(1024 * 1024 + 10)}"}`;
  const tooLarge = await write(JSON_HEADERS, oversized);
  assert.equal(tooLarge.status, 413);
  assert.equal((await json(tooLarge)).error?.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(f.calls.filter(entry => entry.name === 'chats.create').length, 0, 'no write happened');
});

/* -------------------------------------------------------------------------- */
/* Idempotency-Key contract                                                   */
/* -------------------------------------------------------------------------- */

test('writes require Idempotency-Key and map it to requestId', async t => {
  const f = await serve(t, {}, {apiToken: TOKEN});
  const missing = await call(f, '/v1/chats', {method: 'POST', headers: {...JSON_HEADERS, ...AUTH}, body: '{"name":"x"}'});
  assert.equal(missing.status, 400);
  assert.equal((await json(missing)).error?.code, 'INVALID_COMMAND');
  const override = await call(f, '/v1/chats', {
    method: 'POST', headers: {'idempotency-key': 'key-0003', ...JSON_HEADERS, ...AUTH}, body: '{"name":"x","requestId":"mine"}',
  });
  assert.equal(override.status, 400);
  const ok = await call(f, '/v1/chats', {
    method: 'POST', headers: {'idempotency-key': 'key-0004', ...JSON_HEADERS, ...AUTH}, body: '{"name":"x"}',
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(f.calls.find(entry => entry.name === 'chats.create')?.input, {name: 'x', requestId: 'key-0004'});
});

test('same key and payload replay byte-identically; a different payload conflicts', async t => {
  const f = await serve(t, {}, {apiToken: TOKEN});
  const request = () => call(f, '/v1/chats', {
    method: 'POST', headers: {'idempotency-key': 'key-0005', ...JSON_HEADERS, ...AUTH}, body: '{"name":"replay"}',
  });
  const first = await request();
  const firstText = await first.text();
  const second = await request();
  assert.equal(await second.text(), firstText, 'replay must be byte-identical');
  assert.equal(first.status, 200);
  const conflict = await call(f, '/v1/chats', {
    method: 'POST', headers: {'idempotency-key': 'key-0005', ...JSON_HEADERS, ...AUTH}, body: '{"name":"other"}',
  });
  assert.equal(conflict.status, 409);
  assert.equal((await json(conflict)).error?.code, 'IDEMPOTENCY_CONFLICT');
});

/* -------------------------------------------------------------------------- */
/* Status/code mapping                                                        */
/* -------------------------------------------------------------------------- */

test('domain and runtime failures map to the frozen status codes without leaking details', async t => {
  const cases: ReadonlyArray<readonly [string, Error, number, string]> = [
    ['conversation.stop', new CommandError('INVALID_COMMAND'), 400, 'INVALID_COMMAND'],
    ['jobs.get', new Error('JOB_NOT_FOUND'), 404, 'JOB_NOT_FOUND'],
    ['jobs.cancel', new ResourceError('LEASE_EXPIRED'), 409, 'LEASE_EXPIRED'],
    ['jobs.start', new Error('MODEL_NOT_CONFIGURED'), 503, 'MODEL_NOT_CONFIGURED'],
    ['conversation.send', new Error('provider stack /Users/secret token=abc'), 500, 'INTERNAL_ERROR'],
  ];
  for (const [name, error, status, code] of cases) {
    const f = await serve(t, {[name]: error}, {apiToken: TOKEN});
    const response = name === 'jobs.get' || name === 'jobs.start'
      ? await call(f, name === 'jobs.get' ? '/v1/jobs/job-1' : '/v1/jobs', name === 'jobs.start'
        ? {method: 'POST', headers: {'idempotency-key': 'key-0006', ...JSON_HEADERS, ...AUTH}, body: '{"title":"t","prompt":"p","sourceChatId":"1"}'}
        : {headers: AUTH})
      : await call(f, name === 'conversation.send' ? '/v1/chats/1/messages' : name === 'conversation.stop' ? '/v1/chats/1/stop' : '/v1/jobs/job-1/cancel',
        {method: 'POST', headers: {'idempotency-key': `key-${code}`, ...JSON_HEADERS, ...AUTH}, body: '{}'});
    assert.equal(response.status, status, `${name}: ${code}`);
    const body = await json(response);
    assert.equal(body.error?.code, code);
    if (status === 500) {
      const text = JSON.stringify(body);
      assert.ok(!text.includes('secret') && !text.includes('/Users/') && !text.includes('stack'), text);
      assert.equal(body.error?.message, 'internal error');
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Access log redaction                                                       */
/* -------------------------------------------------------------------------- */

test('access logs contain only metadata and never credentials or bodies', async t => {
  const f = await serve(t, {}, {apiToken: TOKEN});
  const bodyMarker = 'BODY_SECRET_MARKER';
  await call(f, '/v1/chats', {
    method: 'POST', headers: {'idempotency-key': 'key-0007', ...JSON_HEADERS, ...AUTH},
    body: JSON.stringify({name: bodyMarker}),
  });
  await call(f, '/health/live');
  assert.equal(f.log.length, 2);
  const allowed = new Set(['at', 'event', 'requestId', 'method', 'path', 'status', 'durationMs', 'bytesIn']);
  for (const line of f.log) {
    const record = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual([...Object.keys(record)].sort(), [...allowed].sort());
    assert.equal(record.event, 'http.access');
    assert.ok(!line.includes(TOKEN), 'token never logged');
    assert.ok(!line.includes(bodyMarker), 'body never logged');
    assert.equal(typeof record.status, 'number');
    assert.equal(typeof record.durationMs, 'number');
  }
});

/* -------------------------------------------------------------------------- */
/* Thin adapters over every route                                              */
/* -------------------------------------------------------------------------- */

test('the full route table forwards to the matching application command', async t => {
  const f = await serve(t, {}, {apiToken: TOKEN});
  const write = (path: string, key: string, body: unknown, headers: Record<string, string> = {}) => call(f, path, {
    method: 'POST', headers: {'idempotency-key': key, ...JSON_HEADERS, ...AUTH, ...headers}, body: JSON.stringify(body),
  });
  const read = (path: string) => call(f, path, {headers: AUTH});

  assert.equal((await write('/v1/chats', 'k-chat', {name: 'n'})).status, 200);
  assert.equal((await read('/v1/chats/1')).status, 200);
  assert.equal((await read('/v1/chats/2')).status, 404);
  assert.equal((await write('/v1/chats/1/messages', 'k-send', {text: 'hi'})).status, 200);
  assert.equal((await write('/v1/chats/1/stop', 'k-stop', {})).status, 200);
  assert.equal((await write('/v1/chats/1/compact', 'k-compact', {instructions: 'tight'})).status, 200);
  assert.equal((await read('/v1/commands/100')).status, 200);
  assert.equal((await read('/v1/commands/missing')).status, 404);
  assert.equal((await read('/v1/chats/1/history?limit=10&cursor=c%201')).status, 200);
  assert.equal((await read('/v1/chats/1/history?limit=101')).status, 400);
  assert.equal((await write('/v1/profile/remember', 'k-rem', {key: 'tone', value: '简洁', kind: 'preference', sourceChatId: '1'})).status, 200);
  assert.equal((await write('/v1/profile/forget', 'k-forget', {key: 'tone'})).status, 200);
  assert.equal((await read('/v1/profile')).status, 200);
  assert.equal(((await (await read('/v1/profile/export')).json()) as {markdown: string}).markdown, '# USER\n');
  assert.equal((await write('/v1/jobs', 'k-job', {title: 't', prompt: 'p', sourceChatId: '1'})).status, 200);
  assert.equal((await write('/v1/jobs/job-1/amend', 'k-amend', {expectedRevision: 1, prompt: 'p2'})).status, 200);
  assert.equal((await write('/v1/jobs/job-1/cancel', 'k-cancel', {expectedRevision: 2})).status, 200);
  assert.equal((await read('/v1/jobs/job-1')).status, 200);
  assert.equal((await read('/v1/jobs/job-2')).status, 404);
  assert.equal((await read('/v1/jobs/job-1/attempts')).status, 200);
  assert.equal((await read('/v1/artifacts/att%3Acall')).status, 200);
  assert.equal((await read('/v1/artifacts/other')).status, 404);
  assert.equal((await write('/v1/followups', 'k-sched', {jobId: 'job-1', expectedRevision: 1, dueAt: 1000})).status, 200);
  assert.equal((await write('/v1/followups/s-1/cancel', 'k-scancel', {})).status, 200);
  assert.equal((await read('/v1/followups/s-1')).status, 200);
  assert.equal((await read('/v1/followups/s-2')).status, 404);
  assert.equal((await read('/v1/followups/s-1/occurrences')).status, 200);
  assert.equal((await read('/v1/followups/decisions?jobId=job-1')).status, 200);
  assert.equal((await read('/v1/followups/deliveries?jobId=job-1')).status, 200);
  assert.equal((await read('/v1/deliveries/d-1')).status, 200);
  assert.equal((await read('/v1/deliveries/d-2')).status, 404);

  // Path ids are authoritative; a body copy is rejected instead of silently ignored.
  assert.equal((await write('/v1/jobs/job-1/cancel', 'k-bind', {expectedRevision: 1, jobId: 'job-1'})).status, 400);
  assert.deepEqual(f.calls.find(entry => entry.name === 'conversation.history')?.input,
    {chatId: '1', limit: 10, cursor: 'c 1'});
  assert.deepEqual(f.calls.find(entry => entry.name === 'conversation.send')?.input,
    {text: 'hi', requestId: 'k-send', chatId: '1'});
  assert.deepEqual(f.calls.find(entry => entry.name === 'followups.decisions')?.input, 'job-1');
  assert.equal(f.calls.find(entry => entry.name === 'jobs.artifact')?.input, 'att:call');
});

/* -------------------------------------------------------------------------- */
/* Gated inspect                                                              */
/* -------------------------------------------------------------------------- */

test('/inspect is 404 by default and double-gated when enabled', async t => {
  const disabled = await serve(t, {}, {apiToken: TOKEN, inspect: false});
  assert.equal((await call(disabled, '/inspect', {headers: AUTH})).status, 404);

  const enabled = await serve(t, {}, {apiToken: TOKEN, inspect: true});
  assert.equal((await call(enabled, '/inspect')).status, 401);
  const ok = await call(enabled, '/inspect', {headers: AUTH});
  assert.equal(ok.status, 200);
  const body = await ok.json() as {version: number; instanceId: string; phase: string};
  assert.deepEqual(body, {version: 1, instanceId: 'instance-1', phase: 'ready', capabilities: ['foundation']});
  assert.equal((await call(enabled, '/inspect', {method: 'POST', headers: AUTH})).status, 405);

  const unconfigured = await serve(t, {}, {inspect: true});
  assert.equal((await call(unconfigured, '/inspect')).status, 503);
});

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

test('configuration validates the API token and inspect switch', () => {
  assert.equal(readConfig({}).apiToken, undefined);
  assert.equal(readConfig({POINT_API_TOKEN: TOKEN}).apiToken, TOKEN);
  assert.equal(readConfig({POINT_API_INSPECT: '1'}).apiInspect, true);
  assert.equal(readConfig({POINT_API_INSPECT: '0'}).apiInspect, false);
  for (const env of [{POINT_API_TOKEN: ''}, {POINT_API_TOKEN: ' x '}, {POINT_API_TOKEN: 'x'.repeat(513)}, {POINT_API_INSPECT: 'yes'}]) {
    assert.throws(() => readConfig(env), /INVALID_API_/);
  }
});

/* -------------------------------------------------------------------------- */
/* Real runtime: replay bytes through Durable receipts                        */
/* -------------------------------------------------------------------------- */

test('real runtime replay through the HTTP layer is byte-identical', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'point-api-real-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const app = await startServer({host: '127.0.0.1', port: 0, dataDir: dir, apiToken: TOKEN});
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  const body = JSON.stringify({name: '项目计划'});
  const request = () => fetch(`${base}/v1/chats`, {
    method: 'POST', headers: {'idempotency-key': 'real-key-1', ...JSON_HEADERS, ...AUTH}, body,
  });
  const first = await request();
  const firstText = await first.text();
  assert.equal(first.status, 200);
  const second = await request();
  assert.equal(await second.text(), firstText, 'durable receipt replay is byte-identical');
  const created = JSON.parse(firstText) as {id: string; name: string};
  assert.equal(created.name, '项目计划');
  const read = await fetch(`${base}/v1/chats/${created.id}`, {headers: AUTH});
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), created);
  // Unconfigured runtime still exposes health but refuses /v1.
  const unconfigured = await mkdtemp(join(tmpdir(), 'point-api-unconfigured-'));
  t.after(() => rm(unconfigured, {recursive: true, force: true}));
  const plain = await startServer({host: '127.0.0.1', port: 0, dataDir: unconfigured});
  t.after(() => plain.close());
  const refused = await fetch(`http://127.0.0.1:${plain.port}/v1/chats`, {method: 'POST', headers: {'idempotency-key': 'real-key-2'}});
  assert.equal(refused.status, 503);
  assert.equal(((await refused.json()) as {error: {code: string}}).error.code, 'API_NOT_CONFIGURED');
  assert.equal((await fetch(`http://127.0.0.1:${plain.port}/health/live`)).status, 200);
});
