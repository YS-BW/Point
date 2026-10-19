/**
 * WP6.2 independent dynamic verification: one commit -> a constant number of frames and a patch
 * proportional to the changed entities, never a full state resend. Applying every delta to a client
 * view must reproduce the authoritative `GET /v1/state` view field by field.
 *
 * Frozen contract (`openspec/changes/agent-read-model/specs/read-model/spec.md`):
 * - "One commit, one entity": frame count does not grow with the total job count, the delta carries
 *   one changed path, and no full `STATE_SNAPSHOT` is sent.
 * - Every frame id is a frame-level cursor `<commitSeq>:<frameIndex>`; frames of one commit must not
 *   share an id.
 * - Incremental frames live inside a long-lived `live-` run; every frame is official-schema valid.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventSchema } from '@ag-ui/core/schemas';
import {
  amendJob, applyFrame, applyFrames, compareFrameCursors, createView, familyArray, familyEquals,
  frameCursorOf, frameEvent, frameType, groupDeltaOperations, isSyncRunStarted, openThreadStream,
  parseFrameCursor, readState, readSyncRun, seed, startVerifyServer, type ClientView, type SseFrame,
  type VerifyServer,
} from './support.js';

type AmendEvidence = Readonly<{
  firstOps: readonly unknown[];
  firstFrames: number;
  deltaBytes: number;
  snapshotBytes: number;
  postFrames: number;
  groupCount: number;
}>;

function jobInView(view: ClientView, jobId: string): {revision?: number; status?: string} | undefined {
  return familyArray(view.state, 'jobs')
    .find(item => (item as {id?: unknown}).id === jobId) as {revision?: number; status?: string} | undefined;
}

/**
 * Open the thread stream, verify the sync snapshot against `/v1/state`, amend exactly one job and
 * capture the incremental frames it produces. Asserts the O(change) contract and returns the sizes
 * used by the scaling comparison.
 */
async function captureSingleJobAmend(
  server: VerifyServer, jobCount: number, key: string,
): Promise<AmendEvidence> {
  const fixture = await seed(server, {chats: 2, jobs: jobCount});
  const jobId = fixture.jobIds[0]!;
  const threadId = fixture.chatIds[0]!;

  const stream = await openThreadStream(server, threadId);
  const syncFrames = await readSyncRun(stream);
  assert.ok(syncFrames.some(isSyncRunStarted), 'first connect must open with a sync run');
  const view = createView();
  applyFrames(view, syncFrames);
  const initialFrames = await stream.readUntilSilence(300, 3_000);
  applyFrames(view, initialFrames);
  const baselineCursor = view.cursor;
  assert.ok(baselineCursor !== undefined, 'the sync run must carry frame cursors');

  const authorityBefore = await readState(server);
  for (const family of ['chats', 'jobs', 'resources', 'memory']) {
    assert.ok(familyEquals(view.state, authorityBefore, family),
      `the sync snapshot must equal the authoritative view (${family})`);
  }
  const snapshotBytes = Buffer.byteLength(JSON.stringify(authorityBefore), 'utf8');

  const amended = await amendJob(server, jobId, 1, key);
  assert.equal(amended.revision, 2, 'the amend creates revision 2');

  const postFrames: SseFrame[] = [];
  const started = Date.now();
  for (;;) {
    const frame = await stream.next(1_000);
    if (frame === undefined) {
      const current = jobInView(view, jobId);
      if (current?.revision === 2 && current.status === 'failed') break;
      if (Date.now() - started > 25_000) {
        throw new Error(`the amended job did not settle: ${JSON.stringify(current)}; types=${view.types.join(',')}`);
      }
      continue;
    }
    postFrames.push(frame);
    applyFrame(view, frame);
    const current = jobInView(view, jobId);
    if (current?.revision === 2 && current.status === 'failed') {
      for (const trailing of await stream.readUntilSilence(400, 4_000)) {
        postFrames.push(trailing);
        applyFrame(view, trailing);
      }
      break;
    }
  }
  await stream.close();

  // Every frame must be a schema-valid official AG-UI event and a valid frame cursor.
  for (const frame of [...syncFrames, ...initialFrames, ...postFrames]) {
    const parsed = EventSchema.safeParse(frameEvent(frame));
    assert.ok(parsed.success, `official AG-UI schema rejects a thread-stream frame: ${frame.data}`);
    frameCursorOf(frame);
  }
  let previous = baselineCursor;
  for (const frame of postFrames) {
    const cursor = frameCursorOf(frame);
    assert.ok(compareFrameCursors(cursor, previous) > 0, `frame cursors must advance: ${previous} -> ${cursor}`);
    previous = cursor;
  }
  // Cursors are frame-level: two frames of the same commit must not share an id.
  const seen = new Set<string>();
  for (const frame of [...syncFrames, ...initialFrames, ...postFrames]) {
    const cursor = frameCursorOf(frame);
    assert.ok(!seen.has(cursor), `duplicate frame id ${cursor}`);
    seen.add(cursor);
  }

  assert.ok(!postFrames.some(frame => frameType(frame) === 'STATE_SNAPSHOT'),
    'an incremental projection must not resend a full STATE_SNAPSHOT');

  // Group the incremental frames by their commit sequence.
  const groups = new Map<string, SseFrame[]>();
  for (const frame of postFrames) {
    const key = String(parseFrameCursor(frameCursorOf(frame)).seq);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [frame]);
    else group.push(frame);
  }

  const ordered = [...groups.entries()].sort((left, right) => Number(left[0]) - Number(right[0]));
  let evidenceGroup: {frames: SseFrame[]; ops: unknown[]} | undefined;
  for (const [, frames] of ordered) {
    const ops = groupDeltaOperations(frames.map(frameEvent));
    if (ops.length === 0) continue;
    if (!JSON.stringify(ops).includes(jobId)) continue;
    evidenceGroup = {frames, ops};
    break;
  }
  assert.ok(evidenceGroup !== undefined,
    `no incremental delta mentions the amended job; frames: ${postFrames.length}, ` +
    `types=${postFrames.map(frameType).join(',')}`);
  const {frames: evidenceFrames, ops} = evidenceGroup!;

  // "One commit, one entity": one changed path for one changed entity, in a constant frame count.
  assert.equal(ops.filter(raw => (raw as {op?: unknown}).op !== undefined).length, ops.length,
    'every delta element must be a JSON Patch operation');
  assert.equal(ops.length, 1, `a one-job commit must carry exactly one changed path, got ${JSON.stringify(ops)}`);
  const deltas = evidenceFrames.filter(frame => frameType(frame) === 'STATE_DELTA');
  assert.equal(deltas.length, 1, 'a one-job commit must project one STATE_DELTA');
  assert.ok(evidenceFrames.length <= 4,
    `a one-job commit must project a constant number of frames, got ${evidenceFrames.length}`);
  assert.ok(!evidenceFrames.some(frame => frameType(frame) === 'STATE_SNAPSHOT'));
  for (const raw of ops) {
    const path = String((raw as {path?: unknown}).path);
    assert.notEqual(path, '', 'no root replacement may be used as a delta');
    for (const family of ['/chats', '/jobs', '/resources', '/memory', '/events']) {
      assert.notEqual(path, family, `no whole-family replacement may be used as a delta: ${path}`);
    }
  }
  for (const other of fixture.jobIds.slice(1)) {
    assert.ok(!JSON.stringify(ops).includes(other),
      'a one-job commit patch must not carry any other job');
  }

  // Patch application equals authority, family by family.
  const authorityAfter = await readState(server);
  for (const family of ['chats', 'jobs', 'resources', 'memory']) {
    assert.ok(familyEquals(view.state, authorityAfter, family),
      `applying every delta must reproduce the authoritative view (${family})`);
  }
  assert.equal(jobInView(view, jobId)?.revision, 2);

  const deltaBytes = postFrames.reduce((total, frame) => total + Buffer.byteLength(frame.data, 'utf8'), 0);
  assert.ok(deltaBytes < snapshotBytes / 2,
    `incremental frames for one commit must be far smaller than the full state view ` +
    `(${deltaBytes} vs ${snapshotBytes} bytes)`);

  return {
    firstOps: ops, firstFrames: evidenceFrames.length, deltaBytes, snapshotBytes,
    postFrames: postFrames.length, groupCount: groups.size,
  };
}

test('one commit changing exactly one job emits a constant frame count and one changed path',
  {timeout: 90_000}, async t => {
    const server = await startVerifyServer(t, {modelResponses: 160});
    const evidence = await captureSingleJobAmend(server, 100, 'verify-amend-100');
    assert.equal(evidence.firstOps.length, 1);
    assert.ok(evidence.firstFrames <= 2, `expected 1..2 frames for a one-job commit, got ${evidence.firstFrames}`);
    assert.ok(evidence.deltaBytes < evidence.snapshotBytes / 4,
      `one-job delta must not resemble a full resend (${evidence.deltaBytes} vs ${evidence.snapshotBytes})`);
  });

test('the frame count and patch size of a one-job commit do not grow with the total job count',
  {timeout: 120_000}, async t => {
    const smallServer = await startVerifyServer(t, {modelResponses: 16});
    const small = await captureSingleJobAmend(smallServer, 2, 'verify-amend-small');
    const largeServer = await startVerifyServer(t, {modelResponses: 160});
    const large = await captureSingleJobAmend(largeServer, 100, 'verify-amend-large');

    assert.equal(large.firstOps.length, small.firstOps.length, 'changed paths must be identical for one changed job');
    assert.equal(large.firstFrames, small.firstFrames, 'commit frame count must not depend on the total job count');
    assert.ok(large.postFrames <= small.postFrames + 8,
      `incremental frame count must not scale with the fixture (${small.postFrames} -> ${large.postFrames})`);
    assert.ok(large.deltaBytes <= small.deltaBytes * 3 + 2_048,
      `delta size must not scale with the fixture (${small.deltaBytes} -> ${large.deltaBytes} bytes)`);
  });
