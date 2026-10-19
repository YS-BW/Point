/**
 * WP6.3 independent dynamic verification: disconnect / `Last-Event-ID` reconnect consistency.
 *
 * Everything here uses a hand-written raw-socket SSE client (no `fetch` streaming helper), so a
 * passing verdict cannot come from a shared transport. Frozen contract
 * (`openspec/changes/agent-read-model/specs/read-model/spec.md`):
 * - every frame id is a frame-level cursor `<commitSeq>:<frameIndex>`;
 * - a cursor inside the retention ring replays exactly the frames after it (no new snapshot);
 * - a cursor outside the window / unknown / from before a restart triggers a fresh sync run plus
 *   `CUSTOM point.stream.resync` with `window_exceeded` | `unknown_seq` | `process_restarted`,
 *   and no delta claiming continuity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFrame, applyFrames, compareFrameCursors, createChat, createView, expectedMessages,
  familyArray, familyEquals, frameCursorOf, frameEvent, frameType, isSyncRunStarted,
  openThreadStream, parseFrameCursor, readState, readSyncRun, rememberMemory, resyncEvent,
  runChatTurn, seed, sortedIdSet, startVerifyServer, writeJson, type ClientView, type SseFrame,
  type VerifyServer, type RawStream,
} from './support.js';

type Synced = Readonly<{stream: RawStream; view: ClientView; frames: SseFrame[]}>;

/** Open a thread stream and consume its sync run (plus the live-run boundary) into a fresh view. */
async function openSynced(server: VerifyServer, threadId: string): Promise<Synced> {
  const stream = await openThreadStream(server, threadId);
  const syncFrames = await readSyncRun(stream);
  assert.ok(syncFrames.some(isSyncRunStarted), 'first connect must open with a sync run');
  const view = createView();
  applyFrames(view, syncFrames);
  const boundary = await stream.readUntilSilence(300, 3_000);
  applyFrames(view, boundary);
  assert.ok(view.cursor !== undefined, 'the sync run must carry frame cursors');
  return {stream, view, frames: [...syncFrames, ...boundary]};
}

async function assertViewEqualsAuthority(server: VerifyServer, view: ClientView, threadId: string): Promise<void> {
  const authority = await readState(server);
  for (const family of ['chats', 'jobs', 'resources', 'memory']) {
    assert.ok(familyEquals(view.state, authority, family),
      `converged client view differs from the authoritative view (${family})`);
  }
  assert.deepEqual(view.messages, await expectedMessages(server, threadId),
    'converged client messages differ from the authoritative visible history');
}

/* -------------------------------------------------------------------------- */
/* Inside the retention window                                                */
/* -------------------------------------------------------------------------- */

test('in-window reconnect replays only later frames and converges state and messages',
  {timeout: 90_000}, async t => {
    const server = await startVerifyServer(t, {modelResponses: 24});
    const fixture = await seed(server, {chats: 3, jobs: 4});
    const threadId = fixture.chatIds[0]!;
    await runChatTurn(server, threadId, 'first question', 'verify-turn-1');

    const {stream, view} = await openSynced(server, threadId);
    await assertViewEqualsAuthority(server, view, threadId);
    // Resume from a content-frame cursor (the last frame a real client fully applied).
    await createChat(server, 'cursor chat', 'verify-cursor-chat');
    applyFrames(view, await stream.readUntilSilence(400, 5_000));
    const requestedCursor = view.cursor!;
    assert.equal(view.types.at(-1), 'STATE_DELTA', `expected a content frame cursor, got ${view.types.join(',')}`);
    await stream.close();

    // Offline changes: state families and visible history both move. (Job lifecycle index updates are
    // covered as a separate blocker; creation writes the index and is enough for reconnect consistency.)
    const offlineChat = await createChat(server, 'offline chat', 'verify-offline-chat');
    const offlineJob = await writeJson(server, '/v1/jobs', 'verify-offline-job',
      {title: 'offline job', prompt: 'do it', sourceChatId: threadId});
    assert.equal(offlineJob.status, 200, JSON.stringify(offlineJob.body));
    const offlineJobId = String((offlineJob.body as {jobId: unknown}).jobId);
    await rememberMemory(server, 'offline-key', 'offline-value', threadId);
    await runChatTurn(server, threadId, 'offline question', 'verify-turn-2');

    const resumed = await openThreadStream(server, threadId, requestedCursor);
    const replayed = await resumed.readUntilSilence(600, 20_000);
    await resumed.close();

    assert.ok(replayed.length > 0, 'in-window reconnect must replay the frames missed while offline');
    for (const frame of replayed) {
      const cursor = frameCursorOf(frame);
      assert.ok(compareFrameCursors(cursor, requestedCursor) > 0,
        `in-window replay must only contain frames after ${requestedCursor}, got ${cursor}`);
    }
    const seen = new Set<string>();
    for (const frame of replayed) {
      const cursor = frameCursorOf(frame);
      assert.ok(!seen.has(cursor), `frame ${cursor} was delivered twice`);
      seen.add(cursor);
    }
    // The frozen binding says an in-window reconnect replays only later frames and sends no new snapshot.
    // The implementation currently opens a fresh sync run on every connection (see the dedicated
    // contract test below); this test still checks the outcome a client depends on.
    assert.equal(resyncEvent(replayed), undefined, 'an in-window reconnect must not request a resync');

    applyFrames(view, replayed);
    await assertViewEqualsAuthority(server, view, threadId);
    assert.ok(sortedIdSet(view.state, 'chats').includes(offlineChat), 'offline chat is present after replay');
    assert.ok(sortedIdSet(view.state, 'jobs').includes(offlineJobId), 'offline job is present after replay');
    assert.equal((view.state?.memory as Record<string, unknown> | undefined)?.['offline-key'] !== undefined,
      true, 'offline memory is present after replay');
  });

test('frozen binding: an in-window reconnect sends no new sync snapshot',
  {timeout: 60_000}, async t => {
    const server = await startVerifyServer(t, {modelResponses: 8});
    const fixture = await seed(server, {chats: 2, jobs: 2});
    const threadId = fixture.chatIds[0]!;

    const {stream, view} = await openSynced(server, threadId);
    await createChat(server, 'binding cursor chat', 'verify-binding-cursor');
    applyFrames(view, await stream.readUntilSilence(400, 5_000));
    const requestedCursor = view.cursor!;
    await stream.close();
    await createChat(server, 'binding offline chat', 'verify-binding-offline');

    const resumed = await openThreadStream(server, threadId, requestedCursor);
    const frames = await resumed.readUntilSilence(600, 15_000);
    await resumed.close();
    assert.ok(!frames.some(isSyncRunStarted),
      'frozen binding: an in-window reconnect must not open a new sync run');
    assert.ok(!frames.some(frame => frameType(frame) === 'STATE_SNAPSHOT'),
      'frozen binding: an in-window reconnect must not resend STATE_SNAPSHOT');
    assert.ok(!frames.some(frame => frameType(frame) === 'MESSAGES_SNAPSHOT'),
      'frozen binding: an in-window reconnect must not resend MESSAGES_SNAPSHOT');
  });

test('frame-granular resume: a client cut in the middle of a commit receives the remaining frames',
  {timeout: 90_000}, async t => {
    const server = await startVerifyServer(t, {modelResponses: 24});
    const fixture = await seed(server, {chats: 2, jobs: 2});
    const threadId = fixture.chatIds[0]!;

    const stream = await openThreadStream(server, threadId);
    const syncFrames = await readSyncRun(stream);
    const liveView = createView();
    applyFrames(liveView, syncFrames);

    // Creating a job writes the `point.jobs` index document plus an activity frame in one commit:
    // that is the multi-frame commit the frame-level cursor has to protect.
    const created = await writeJson(server, '/v1/jobs', 'verify-midframe-job',
      {title: 'midframe job', prompt: 'do it', sourceChatId: threadId});
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const createdJobId = String((created.body as {jobId: unknown}).jobId);
    const liveFrames: SseFrame[] = [];
    for (const frame of await stream.readUntilSilence(800, 20_000)) {
      liveFrames.push(frame);
      applyFrame(liveView, frame);
    }
    await stream.close();
    assert.ok(sortedIdSet(liveView.state, 'jobs').includes(createdJobId) || liveFrames.length > 0,
      'the creation commit must be observed on the live stream');

    const bySeq = new Map<string, SseFrame[]>();
    for (const frame of liveFrames) {
      const key = String(parseFrameCursor(frameCursorOf(frame)).seq);
      const group = bySeq.get(key);
      if (group === undefined) bySeq.set(key, [frame]);
      else group.push(frame);
    }
    const multi = [...bySeq.values()].find(group => group.length >= 2);
    assert.ok(multi !== undefined,
      `expected at least one commit to project multiple frames; per-commit frames: ` +
      `${[...bySeq.values()].map(group => group.length).join(',')}`);
    const group = multi!;
    const firstCursor = frameCursorOf(group[0]!);
    const secondCursor = frameCursorOf(group[1]!);
    const cutIndex = liveFrames.indexOf(group[0]!);
    assert.ok(cutIndex >= 0);

    // The client applied everything up to and including the first frame of that commit, then dropped.
    const cutView = createView();
    applyFrames(cutView, [...syncFrames, ...liveFrames.slice(0, cutIndex + 1)]);
    assert.equal(cutView.cursor, firstCursor);
    const appliedCursors = new Set(cutView.cursors);

    const resumed = await openThreadStream(server, threadId, firstCursor);
    const replayed = await resumed.readUntilSilence(600, 20_000);
    await resumed.close();

    assert.equal(resyncEvent(replayed), undefined, 'an in-window resume must not request a resync');
    for (const frame of replayed) {
      const cursor = frameCursorOf(frame);
      assert.ok(compareFrameCursors(cursor, firstCursor) > 0,
        `resume must continue after ${firstCursor}, got ${cursor}`);
      assert.ok(!appliedCursors.has(cursor), `already-applied frame ${cursor} was re-delivered`);
    }
    assert.ok(replayed.some(frame => frameCursorOf(frame) === secondCursor),
      `the remaining frame ${secondCursor} of commit ${parseFrameCursor(firstCursor).seq} was skipped`);
    for (const frame of group.slice(1)) {
      const cursor = frameCursorOf(frame);
      assert.ok(replayed.some(candidate => frameCursorOf(candidate) === cursor),
        `missing frame ${cursor} from the partially applied commit`);
    }

    applyFrames(cutView, replayed);
    await assertViewEqualsAuthority(server, cutView, threadId);
    assert.ok(sortedIdSet(cutView.state, 'jobs').includes(createdJobId),
      'the partially applied commit converges to the authoritative view');
  });

/* -------------------------------------------------------------------------- */
/* Outside the retention window                                               */
/* -------------------------------------------------------------------------- */

test('unknown cursor: resyncs explicitly with reason unknown_seq and no faked continuity',
  {timeout: 60_000}, async t => {
    const server = await startVerifyServer(t, {modelResponses: 8});
    const fixture = await seed(server, {chats: 2, jobs: 2});
    const threadId = fixture.chatIds[0]!;

    const {stream, view} = await openSynced(server, threadId);
    const stateSeq = Number((await readState(server)).seq);
    await stream.close();

    const requestedId = `${stateSeq + 1_000}:0`;
    const resumed = await openThreadStream(server, threadId, requestedId);
    const frames = await resumed.readUntilSilence(600, 15_000);
    await resumed.close();

    assert.ok(frames.some(isSyncRunStarted), 'an unknown cursor must trigger a fresh sync run');
    const resync = resyncEvent(frames);
    assert.ok(resync !== undefined, 'an unknown cursor must emit CUSTOM point.stream.resync');
    const value = resync.value as {reason?: unknown; requestedId?: unknown; currentSeq?: unknown};
    assert.equal(value.reason, 'unknown_seq', JSON.stringify(value));
    assert.equal(value.requestedId, requestedId, JSON.stringify(value));
    assert.equal(typeof value.currentSeq, 'number', JSON.stringify(value));
    assert.equal(frames.filter(frame => frameType(frame) === 'STATE_DELTA').length, 0,
      'a resync must not emit deltas claiming continuity');
    assert.ok(frames.some(frame => frameType(frame) === 'STATE_SNAPSHOT'), 'resync carries a full state snapshot');
    assert.ok(frames.some(frame => frameType(frame) === 'MESSAGES_SNAPSHOT'), 'resync carries a messages snapshot');

    applyFrames(view, frames);
    await assertViewEqualsAuthority(server, view, threadId);
  });

test('process restart: resyncs explicitly with reason process_restarted',
  {timeout: 90_000}, async t => {
    const server = await startVerifyServer(t, {modelResponses: 8});
    const fixture = await seed(server, {chats: 2, jobs: 2});
    const threadId = fixture.chatIds[0]!;

    const {stream, view} = await openSynced(server, threadId);
    const requestedCursor = view.cursor!;
    await stream.close();
    await server.close();

    // Same data directory, new process-lifetime state: the retention ring is necessarily empty.
    const restarted = await startVerifyServer(t, {dir: server.dir, modelResponses: 8});
    const resumed = await openThreadStream(restarted, threadId, requestedCursor);
    const frames = await resumed.readUntilSilence(600, 15_000);
    await resumed.close();

    assert.ok(frames.some(isSyncRunStarted), 'a restart must trigger a fresh sync run');
    const resync = resyncEvent(frames);
    assert.ok(resync !== undefined, 'a restart must emit CUSTOM point.stream.resync');
    const value = resync.value as {reason?: unknown; requestedId?: unknown; currentSeq?: unknown};
    assert.equal(value.reason, 'process_restarted', JSON.stringify(value));
    assert.equal(value.requestedId, requestedCursor, JSON.stringify(value));
    assert.equal(typeof value.currentSeq, 'number', JSON.stringify(value));
    assert.equal(frames.filter(frame => frameType(frame) === 'STATE_DELTA').length, 0,
      'a resync must not emit deltas claiming continuity');

    applyFrames(view, frames);
    await assertViewEqualsAuthority(restarted, view, threadId);
  });

test('cursor older than the retention ring: resyncs with window_exceeded and a bounded snapshot',
  {timeout: 180_000}, async t => {
    // A small injected retention window keeps the overflow path cheap to exercise; the production
    // bound stays 4096 frames / 5 minutes. Every assertion below is unchanged.
    const server = await startVerifyServer(t, {modelResponses: 4, retentionFrames: 32});
    const threadId = await createChat(server, 'overflow thread', 'verify-overflow-chat');

    const {stream, view} = await openSynced(server, threadId);
    const requestedCursor = view.cursor!;
    await stream.close();

    // Push well over the injected window, and just past the chat bound so the resync snapshot also
    // proves it is bounded and reports truncation.
    const commits = 1_100;
    for (let index = 0; index < commits; index += 1) {
      await createChat(server, `overflow ${index}`, `verify-overflow-${index}`);
    }

    const resumed = await openThreadStream(server, threadId, requestedCursor);
    const frames = await resumed.readUntilSilence(800, 30_000);
    await resumed.close();

    assert.ok(frames.some(isSyncRunStarted), 'an out-of-window cursor must trigger a fresh sync run');
    const resync = resyncEvent(frames);
    assert.ok(resync !== undefined, 'an out-of-window cursor must emit CUSTOM point.stream.resync');
    const value = resync.value as {reason?: unknown; requestedId?: unknown; currentSeq?: unknown};
    assert.equal(value.reason, 'window_exceeded', JSON.stringify(value));
    assert.equal(value.requestedId, requestedCursor, JSON.stringify(value));
    assert.equal(typeof value.currentSeq, 'number', JSON.stringify(value));
    assert.equal(frames.filter(frame => frameType(frame) === 'STATE_DELTA').length, 0,
      'a resync must not emit deltas claiming continuity');

    // The resync marker follows the fresh sync run.
    const syncStart = frames.findIndex(isSyncRunStarted);
    const syncFinish = frames.findIndex((frame, index) => index > syncStart && frameType(frame) === 'RUN_FINISHED');
    const resyncAt = frames.findIndex(frame => {
      const event = frameEvent(frame);
      return event.type === 'CUSTOM' && event.name === 'point.stream.resync';
    });
    assert.ok(syncStart >= 0 && syncFinish > syncStart, 'the resync opens with a complete sync run');
    assert.ok(resyncAt > syncFinish, 'the resync marker follows the fresh sync run');

    const snapshotEvents = frames.map(frameEvent).filter(event => event.type === 'STATE_SNAPSHOT');
    assert.equal(snapshotEvents.length, 1, 'exactly one authoritative snapshot during resync');
    const snapshot = snapshotEvents[0]!.snapshot as Record<string, unknown>;
    // The frozen state shape keys every family by entity id, so count rows through the shared helper
    // rather than assuming an array.
    assert.ok(familyArray(snapshot, 'chats').length <= 1_000, 'the resync snapshot is bounded');
    assert.equal((snapshot.truncated as Record<string, unknown> | undefined)?.chats, true,
      'the bounded resync snapshot reports truncation');

    applyFrames(view, frames);
    await assertViewEqualsAuthority(server, view, threadId);
  });
