/**
 * WP4 `/v1` closing gaps found by independent verification:
 *
 * 1. Concurrent writes that share one Idempotency-Key and payload must apply exactly one
 *    Durable effect while both clients receive byte-identical bodies (real openRuntime +
 *    real SQLite, real HTTP on an ephemeral loopback port).
 * 2. Every write endpoint must reject a missing Idempotency-Key with 400 before any command
 *    runs, replay the same key+payload byte-identically without re-executing the command,
 *    and reject a conflicting payload with 409.
 *
 * The transport matrix uses a deterministic command double (the same shape the contract
 * test uses) because jobs/conversation require a configured model provider; the real
 * Durable exactly-once behaviour is proven by the concurrency test above.
 */

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { createHttp, type ApiRuntime } from '../src/api/http.js';
import { CommandError } from '../src/domain/chat.js';
import { startServer } from '../src/bootstrap.js';

const TOKEN = 'write-guards-token-0123456789';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { 'content-type': 'application/json' };

type Executions = Map<string, number>;

/**
 * Deterministic command double. It records how many times a command *executed* a Durable
 * effect (not how many requests reached it), so replay/conflict can be distinguished from
 * a fresh execution.
 */
function commandRuntime() {
  const executions: Executions = new Map();
  const receipts = new Map<string, { fingerprint: string; result: unknown }>();
  const executed = (name: string): number => executions.get(name) ?? 0;
  function idempotent(name: string, input: unknown, produce: () => unknown): unknown {
    const requestId = (input as { requestId?: unknown } | undefined)?.requestId;
    if (typeof requestId !== 'string') throw new CommandError('INVALID_COMMAND');
    const fingerprint = JSON.stringify(input);
    const existing = receipts.get(requestId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new CommandError('IDEMPOTENCY_CONFLICT');
      return existing.result;
    }
    const result = produce();
    receipts.set(requestId, { fingerprint, result });
    executions.set(name, executed(name) + 1);
    return result;
  }
  const api = {
    instanceId: 'write-guard-instance',
    chats: {
      async create(input: unknown) {
        return idempotent('chats.create', input, () => ({ id: 'chat-1', name: (input as { name: string }).name, createdAt: 1 }));
      },
      async get(id: string) { return id === 'chat-1' ? { id: 'chat-1', name: 'n', createdAt: 1 } : undefined; },
    },
    conversation: {
      async send(input: unknown) { return idempotent('conversation.send', input, () => ({ commandId: '100' })); },
      async stop(input: unknown) { return idempotent('conversation.stop', input, () => ({ commandId: '101' })); },
      async compact(input: unknown) { return idempotent('conversation.compact', input, () => ({ commandId: '102' })); },
      async status() { return { status: 'answered' }; },
      async wait() { return { status: 'answered' }; },
      async compactStatus() { return { status: 'completed' }; },
      async compactWait() { return { status: 'completed' }; },
      async history() { return { items: [] }; },
    },
    profile: {
      async remember(input: unknown) {
        return idempotent('profile.remember', input, () => ({ key: 'tone', value: '简洁', kind: 'preference', sourceChatId: 'chat-1' }));
      },
      async forget(input: unknown) { return idempotent('profile.forget', input, () => ({ key: (input as { key: string }).key, removed: true })); },
      async list() { return []; },
      async exportMarkdown() { return '# USER\n'; },
    },
    jobs: {
      async start(input: unknown) { return idempotent('jobs.start', input, () => ({ jobId: 'job-1', revision: 1, attemptId: 'job-1-1' })); },
      async amend(input: unknown) { return idempotent('jobs.amend', input, () => ({ jobId: 'job-1', revision: 2, attemptId: 'job-1-2' })); },
      async cancel(input: unknown) { return idempotent('jobs.cancel', input, () => ({ jobId: 'job-1', status: 'cancelled' })); },
      async get(jobId: string) { return jobId === 'job-1' ? { id: 'job-1' } : undefined; },
      async attempts() { return []; },
      async artifact() { return undefined; },
    },
    followups: {
      async schedule(input: unknown) { return idempotent('followups.schedule', input, () => ({ scheduleId: 's-1', occurrenceIds: ['o-1'] })); },
      async cancel(input: unknown) { return idempotent('followups.cancel', input, () => ({ scheduleId: 's-1', status: 'cancelled' })); },
      async get(scheduleId: string) { return scheduleId === 's-1' ? { id: 's-1' } : undefined; },
      async occurrences() { return []; },
      async decisions() { return []; },
      async deliveries() { return []; },
    },
    deliveries: {
      async get(deliveryId: string) { return deliveryId === 'd-1' ? { id: 'd-1' } : undefined; },
      async list() { return []; },
    },
  };
  return { api: api as unknown as ApiRuntime, executed };
}

type Fixture = Readonly<{ url: string; executed(name: string): number; close(): Promise<void> }>;

async function serve(t: TestContext): Promise<Fixture> {
  const double = commandRuntime();
  const server = createHttp({
    health: { status: () => ({ phase: 'ready', capabilities: ['foundation'] }) },
    commands: double.api,
    apiToken: TOKEN,
    log: () => {},
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    executed: name => double.executed(name),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

async function send(
  fixture: Fixture, path: string,
  { key, body = {}, auth = true }: { key?: string; body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; text: string; json: unknown }> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (auth) Object.assign(headers, AUTH);
  if (key !== undefined) headers['idempotency-key'] = key;
  const response = await fetch(fixture.url + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, text, json };
}

const codeOf = (json: unknown): string | undefined =>
  (json as { error?: { code?: string } } | undefined)?.error?.code;

type WriteCase = Readonly<{
  name: string;
  command: string;
  path: string;
  body: unknown;
  /** A body or path that reuses the key with a genuinely different command content. */
  conflict: Readonly<{ path?: string; body: unknown }>;
}>;

const WRITE_CASES: readonly WriteCase[] = [
  { name: 'chats.create', command: 'chats.create', path: '/v1/chats', body: { name: 'n' }, conflict: { body: { name: 'm' } } },
  { name: 'conversation.send', command: 'conversation.send', path: '/v1/chats/chat-1/messages', body: { text: 'hi' }, conflict: { body: { text: 'other' } } },
  { name: 'conversation.stop', command: 'conversation.stop', path: '/v1/chats/chat-1/stop', body: {}, conflict: { path: '/v1/chats/chat-2/stop', body: {} } },
  { name: 'conversation.compact', command: 'conversation.compact', path: '/v1/chats/chat-1/compact', body: { instructions: 'tight' }, conflict: { body: { instructions: 'loose' } } },
  { name: 'profile.remember', command: 'profile.remember', path: '/v1/profile/remember', body: { key: 'tone', value: '简洁', kind: 'preference', sourceChatId: 'chat-1' }, conflict: { body: { key: 'tone', value: 'other', kind: 'preference', sourceChatId: 'chat-1' } } },
  { name: 'profile.forget', command: 'profile.forget', path: '/v1/profile/forget', body: { key: 'tone' }, conflict: { body: { key: 'style' } } },
  { name: 'jobs.start', command: 'jobs.start', path: '/v1/jobs', body: { title: 't', prompt: 'p', sourceChatId: 'chat-1' }, conflict: { body: { title: 't2', prompt: 'p', sourceChatId: 'chat-1' } } },
  { name: 'jobs.amend', command: 'jobs.amend', path: '/v1/jobs/job-1/amend', body: { expectedRevision: 1, prompt: 'p2' }, conflict: { body: { expectedRevision: 1, prompt: 'p3' } } },
  { name: 'jobs.cancel', command: 'jobs.cancel', path: '/v1/jobs/job-1/cancel', body: { expectedRevision: 2 }, conflict: { body: { expectedRevision: 3 } } },
  { name: 'followups.schedule', command: 'followups.schedule', path: '/v1/followups', body: { jobId: 'job-1', expectedRevision: 1, dueAt: 1000 }, conflict: { body: { jobId: 'job-1', expectedRevision: 1, dueAt: 2000 } } },
  { name: 'followups.cancel', command: 'followups.cancel', path: '/v1/followups/s-1/cancel', body: {}, conflict: { path: '/v1/followups/s-2/cancel', body: {} } },
];

/* -------------------------------------------------------------------------- */
/* 1. Concurrent identical writes: one Durable effect, byte-identical replies  */
/* -------------------------------------------------------------------------- */

test('concurrent writes with one Idempotency-Key apply exactly one Durable effect', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-api-concurrent-'));
  const app = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, apiToken: TOKEN });
  try {
    const base = `http://127.0.0.1:${app.port}`;
    const headers = { ...AUTH, ...JSON_HEADERS, 'idempotency-key': 'race-key-1' };
    const body = JSON.stringify({ name: 'Race chat' });
    // Fire several identical writes in parallel: the contract must converge on one effect.
    const responses = await Promise.all(Array.from({ length: 5 }, () =>
      fetch(base + '/v1/chats', { method: 'POST', headers, body })));
    const texts = await Promise.all(responses.map(response => response.text()));
    for (const response of responses) assert.equal(response.status, 200, 'every concurrent replay is accepted');
    assert.equal(new Set(texts).size, 1, 'all concurrent responses are byte-identical');
    const chat = JSON.parse(texts[0]!) as { id: string; name: string };
    assert.equal(chat.name, 'Race chat');

    // Read back through the API before close: still exactly one chat.
    const read = await fetch(`${base}/v1/chats/${chat.id}`, { headers: AUTH });
    assert.equal(read.status, 200);

    // The same race on a second write endpoint (profile) converges on one entry too.
    const profileHeaders = { ...AUTH, ...JSON_HEADERS, 'idempotency-key': 'race-key-2' };
    const profileBody = JSON.stringify({ key: 'tone', value: '简洁', kind: 'preference', sourceChatId: chat.id });
    const profileResponses = await Promise.all(Array.from({ length: 3 }, () =>
      fetch(base + '/v1/profile/remember', { method: 'POST', headers: profileHeaders, body: profileBody })));
    const profileTexts = await Promise.all(profileResponses.map(response => response.text()));
    for (const response of profileResponses) assert.equal(response.status, 200);
    assert.equal(new Set(profileTexts).size, 1, 'concurrent profile replays are byte-identical');
    const profile = await fetch(base + '/v1/profile', { headers: AUTH });
    assert.equal(profile.status, 200);
    const entries = await profile.json() as readonly unknown[];
    assert.equal(entries.length, 1, 'exactly one profile entry after the race');
  } finally {
    await app.close();
  }

  const db = new DatabaseSync(join(dir, 'state.sqlite'));
  try {
    const chats = db.prepare(`select count(*) c from documents where kind = '"point.chat"'`).get() as { c: number };
    const receipts = db.prepare(`select count(*) c from documents where kind = '"point.command.chat-create"' and key_value = '"race-key-1"'`).get() as { c: number };
    assert.equal(chats.c, 1, 'exactly one chat document in Durable');
    assert.equal(receipts.c, 1, 'exactly one idempotency receipt for the race key');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* 2. Write guards for every write endpoint                                   */
/* -------------------------------------------------------------------------- */

test('every write endpoint requires a key, replays byte-identically and conflicts on 409', { timeout: 60000 }, async t => {
  const fixture = await serve(t);
  try {
    for (const writeCase of WRITE_CASES) {
      const label = writeCase.name;
      const key = `key-${writeCase.name.replace(/\./g, '-')}`;

      // Missing key: 400 before any command executes.
      const missing = await send(fixture, writeCase.path, { body: writeCase.body });
      assert.equal(missing.status, 400, `${label}: missing key status`);
      assert.equal(codeOf(missing.json), 'INVALID_COMMAND', `${label}: missing key code`);
      assert.equal(fixture.executed(writeCase.command), 0, `${label}: missing key must not execute the command`);

      // Replay: byte-identical response, the command executed once.
      const first = await send(fixture, writeCase.path, { key, body: writeCase.body });
      assert.equal(first.status, 200, `${label}: first write status (${first.text})`);
      assert.equal(fixture.executed(writeCase.command), 1, `${label}: first write executed once`);
      const replay = await send(fixture, writeCase.path, { key, body: writeCase.body });
      assert.equal(replay.status, 200, `${label}: replay status`);
      assert.equal(replay.text, first.text, `${label}: replay must be byte-identical`);
      assert.equal(fixture.executed(writeCase.command), 1, `${label}: replay must not execute again`);

      // Conflicting content under the same key: 409, still no second execution.
      const conflict = await send(fixture, writeCase.conflict.path ?? writeCase.path, { key, body: writeCase.conflict.body });
      assert.equal(conflict.status, 409, `${label}: conflict status (${conflict.text})`);
      assert.equal(codeOf(conflict.json), 'IDEMPOTENCY_CONFLICT', `${label}: conflict code`);
      assert.equal(fixture.executed(writeCase.command), 1, `${label}: conflict must not execute again`);
    }
  } finally {
    await fixture.close();
  }
});
