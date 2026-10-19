/**
 * WP6.1 independent dynamic verification (tester lane, `apps/server/test/verify/**`).
 *
 * Roadmap exit criterion under test: with a 100 job / 10 chat fixture, `GET /v1/state` must not
 * invoke the Durable task reader at all. The frozen contract also fixes the response shape, the
 * per-family bounds/truncation markers and reuse of the WP4 transport contract
 * (`openspec/changes/agent-read-model/specs/read-model/spec.md`).
 *
 * Frozen shape notes that matter here:
 * - the body IS the state object; each family is an id-keyed object, not an array;
 * - `seq` is a LOWER bound observed before the scan, so the view may contain newer commits. This
 *   file never asserts "view content equals the state at seq".
 *
 * Everything runs against a real `startServer` + real SQLite database. Storage calls are observed by
 * wrapping `SqliteStorage.prototype` (verified to intercept the runtime's own storage: a product
 * write surfaces as exactly one `commit`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH, countDelta, createChat, formatCounts, getState, installStorageCounter, isKeyedFamily,
  quiesce, readState, rememberMemory, seed, startVerifyServer,
} from './support.js';

const counter = installStorageCounter();

test('100 jobs / 10 chats: GET /v1/state never reads Durable tasks and returns the derived view',
  {timeout: 60_000}, async t => {
    const server = await startVerifyServer(t, {modelResponses: 160});
    const fixture = await seed(server, {chats: 10, jobs: 100});
    await quiesce(counter);

    counter.takeKinds(); // discard fixture/setup scans; measure only this request
    const before = counter.snapshot();
    const startedAt = Date.now();
    const response = await getState(server);
    const elapsedMs = Date.now() - startedAt;
    const after = counter.snapshot();
    const delta = countDelta(before, after);
    const scannedKinds = counter.takeKinds();
    // Observations, not verdicts: /v1/state is documented as O(total index documents), not O(1).
    t.diagnostic(`GET /v1/state with 100 jobs/10 chats: ${elapsedMs}ms; storage ${formatCounts(delta)}; ` +
      `scanned kinds ${[...new Set(scannedKinds)].sort().join(',') || 'none'}`);

    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;

    // Hard exit criterion: the read model is built from derived index documents, never the task table.
    assert.equal(delta.task, 0, `GET /v1/state must not call Storage.task: ${formatCounts(delta)}`);
    assert.equal(delta.scanTasks, 0, `GET /v1/state must not scan Durable tasks: ${formatCounts(delta)}`);
    assert.equal(delta.commit, 0, `GET /v1/state must be a read: ${formatCounts(delta)}`);

    // Derived-index-only: the scan names the families, so an entity-document read would be visible.
    assert.ok(scannedKinds.length > 0, 'the state view reads derived index documents');
    const indexKinds = new Set(['point.chats', 'point.jobs', 'point.resources', 'point.memory', 'point.event']);
    for (const kind of scannedKinds) {
      assert.ok(indexKinds.has(kind), `GET /v1/state must scan index families only, saw ${kind}`);
    }

    // Frozen root shape: the body IS the state object, families are id-keyed objects.
    assert.equal(typeof body.seq, 'number', 'state.seq must be a number');
    for (const family of ['chats', 'jobs', 'resources', 'memory', 'events']) {
      assert.ok(isKeyedFamily(body[family]), `state.${family} must be an id-keyed object`);
    }
    const chats = body.chats as Record<string, Record<string, unknown>>;
    const jobs = body.jobs as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(chats).sort(), [...fixture.chatIds].sort(),
      'every seeded chat appears in the derived view');
    assert.deepEqual(Object.keys(jobs).sort(), [...fixture.jobIds].sort(),
      'every seeded job appears in the derived view');
    for (const [key, job] of Object.entries(jobs)) {
      assert.equal(String(job.id), key, 'job map keys are the job ids');
      assert.equal(typeof job.revision, 'number', JSON.stringify(job));
      assert.equal(typeof job.status, 'string', JSON.stringify(job));
      assert.equal(typeof job.updatedAt, 'number', JSON.stringify(job));
    }
    for (const [key, chat] of Object.entries(chats)) {
      assert.equal(String(chat.id), key, 'chat map keys are the chat ids');
      assert.equal(typeof chat.name, 'string', JSON.stringify(chat));
      assert.equal(typeof chat.revision, 'number', JSON.stringify(chat));
    }
    const events = body.events as Record<string, unknown>;
    assert.ok(Object.keys(events).length <= 200, `state.events must be bounded, got ${Object.keys(events).length}`);
    const truncated = body.truncated as Record<string, unknown> | undefined;
    assert.equal(truncated?.events, true, 'over-limit events must be marked, never silently truncated');
    assert.equal(truncated?.chats, undefined, '10 chats are under the chat bound');
    assert.equal(truncated?.jobs, undefined, '100 jobs are under the job bound');
    assert.deepEqual(Object.keys(body.resources as Record<string, unknown>), [], 'no resources were created');
  });

test('state view caps chats at 1000 and reports truncation instead of silently dropping',
  {timeout: 120_000}, async t => {
    const server = await startVerifyServer(t, {modelResponses: 4});
    const chatIds: string[] = [];
    for (let index = 0; index < 1001; index += 1) {
      chatIds.push(await createChat(server, `bound chat ${index}`, `verify-bound-${index}`));
    }
    const startedAt = Date.now();
    const body = await readState(server);
    t.diagnostic(`GET /v1/state with 1001 chats: ${Date.now() - startedAt}ms`);
    const chats = body.chats as Record<string, Record<string, unknown>>;
    assert.ok(isKeyedFamily(chats), 'chats stays an id-keyed object');
    assert.equal(Object.keys(chats).length, 1000, 'chats are capped at the frozen bound');
    const known = new Set(chatIds);
    for (const [key, chat] of Object.entries(chats)) {
      assert.ok(known.has(key), `unexpected chat ${key}`);
      assert.equal(String(chat.id), key);
    }
    assert.equal((body.truncated as Record<string, unknown> | undefined)?.chats, true,
      'exceeding the chat bound must be reported');
  });

test('/v1/state reuses the WP4 envelope/auth contract and needs no Idempotency-Key',
  {timeout: 30_000}, async t => {
    const server = await startVerifyServer(t, {modelResponses: 4});

    const unauthorized = await fetch(`${server.base}/v1/state`);
    assert.equal(unauthorized.status, 401);
    const envelope = await unauthorized.json() as {error?: {code?: string; requestId?: string}};
    assert.equal(envelope.error?.code, 'UNAUTHORIZED');
    assert.ok((unauthorized.headers.get('x-request-id') ?? '').length > 0, 'request id header is kept');
    assert.equal(envelope.error?.requestId, unauthorized.headers.get('x-request-id'));

    const wrongMethod = await fetch(`${server.base}/v1/state`, {method: 'POST', headers: AUTH});
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');

    const ok = await getState(server); // deliberately no Idempotency-Key: reads do not need one
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type')?.startsWith('application/json'), true);
  });

test('state memory entries never carry the stored value body',
  {timeout: 30_000}, async t => {
    const server = await startVerifyServer(t, {modelResponses: 4});
    const chatId = await createChat(server, 'memory chat', 'verify-memory-chat');
    const marker = 'VERIFY-SECRET-MEMORY-BODY-42';
    await rememberMemory(server, 'tone', marker, chatId);

    const response = await getState(server);
    const text = await response.text();
    assert.ok(!text.includes(marker), 'the memory value body must not be exposed by the state view');
    const body = JSON.parse(text) as Record<string, unknown>;
    const memory = body.memory as Record<string, Record<string, unknown>>;
    const keys = Object.keys(memory);
    assert.equal(keys.length, 1);
    assert.equal(keys[0], 'tone');
    const entry = memory['tone']!;
    assert.equal(entry.key, 'tone');
    assert.equal(entry.kind, 'preference');
    assert.equal(entry.sourceChatId, chatId);
    assert.equal(Object.hasOwn(entry, 'value'), false, 'state memory entries carry index fields only');
    assert.equal(typeof entry.revision, 'number');
    assert.equal(typeof entry.updatedAt, 'number');

    const profile = await fetch(`${server.base}/v1/profile`, {headers: AUTH});
    assert.equal(profile.status, 200);
    const entries = await profile.json() as Array<{key: string; value: string}>;
    assert.equal(entries.find(item => item.key === 'tone')?.value, marker,
      'the value stays available from the existing profile route');
  });

test('gated /inspect keeps its WP4 fields and reports exactly the frozen entity counts',
  {timeout: 30_000}, async t => {
    const enabled = await startVerifyServer(t, {modelResponses: 4, inspect: true});
    await createChat(enabled, 'inspect chat', 'verify-inspect-chat');
    const response = await fetch(`${enabled.base}/inspect`, {headers: AUTH});
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;

    // Existing WP4 fields are preserved verbatim.
    assert.equal(body.version, 1);
    assert.equal(typeof body.instanceId, 'string');
    assert.equal(body.phase, 'ready');
    assert.deepEqual(body.capabilities, ['foundation']);

    const counts = body.counts as Record<string, unknown>;
    assert.ok(counts !== null && typeof counts === 'object' && !Array.isArray(counts), 'counts is an object');
    assert.deepEqual(Object.keys(counts).sort(), [
      'artifacts', 'attempts', 'chats', 'decisions', 'deliveries', 'events', 'jobs',
      'memory', 'occurrences', 'requests', 'resourceOperations', 'resources', 'schedules',
    ], 'counts reports exactly the entity families, with no derived-index duplicates');
    for (const [name, value] of Object.entries(counts)) {
      assert.equal(typeof value, 'number', `counts.${name} must be a number`);
      if (typeof value !== 'number') continue;
      assert.ok(Number.isInteger(value) && value >= 0, `counts.${name} must be a non-negative integer`);
    }
    assert.equal(counts.chats, 1, 'the one created chat is counted');
    assert.equal(counts.jobs, 0);
    assert.equal(body.countsTruncated, false, 'counts are exact');

    const disabled = await startVerifyServer(t, {modelResponses: 4, inspect: false});
    assert.equal((await fetch(`${disabled.base}/inspect`, {headers: AUTH})).status, 404,
      'disabled /inspect stays indistinguishable from an unknown route');
    assert.equal((await fetch(`${disabled.base}/inspect`)).status, 404,
      'disabled /inspect stays 404 before authentication');
  });
