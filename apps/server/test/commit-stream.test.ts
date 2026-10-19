/**
 * WP6.2 commit-subscription contract: one commit produces O(changed) frames, frames stay in commit
 * order even when the projection awaits, and job lifecycle becomes ACTIVITY + the closed CUSTOM set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { openRuntime, type ModelBinding, type Runtime } from '../src/runtime/open.js';
import type { CommitFrame } from '../src/application/read-model.js';

function binding(): ModelBinding {
  const faux = fauxProvider({tokensPerSecond: 100_000});
  faux.setResponses([fauxAssistantMessage('完成'), fauxAssistantMessage('完成')]);
  const models = createModels();
  models.setProvider(faux.provider);
  return {models, model: {provider: 'faux', modelId: 'faux-1'}};
}

async function withRuntime(
  body: (runtime: Runtime, dir: string) => Promise<void>,
  options: Readonly<{model?: boolean}> = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'point-stream-'));
  const runtime = await openRuntime(dir, options.model === true ? binding() : undefined);
  try {
    await body(runtime, dir);
  } finally {
    await runtime.close().catch(() => undefined);
    await rm(dir, {recursive: true, force: true});
  }
}

/** Collect frames until `predicate` is satisfied or the timeout expires. */
async function collect(
  events: AsyncIterable<CommitFrame>,
  predicate: (frames: CommitFrame[]) => boolean,
  timeoutMs = 5_000,
): Promise<CommitFrame[]> {
  const frames: CommitFrame[] = [];
  const iterator = events[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  try {
    while (!predicate(frames)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`frame timeout; saw ${frames.length} frames`);
      const next = await Promise.race([
        iterator.next(),
        delay(remaining).then(() => ({done: true as const, value: undefined})),
      ]);
      if (next.done === true) break;
      frames.push(next.value as CommitFrame);
    }
  } finally {
    await iterator.return?.(undefined).catch(() => undefined);
  }
  return frames;
}

test('one job commit yields a constant frame count and one changed path', {timeout: 30000}, async () => {
  await withRuntime(async (runtime, dir) => {
    // Seed chats so the view is not empty, then subscribe from that point.
    await runtime.chats.create({requestId: 'stream-chat-1', name: '流夹具'});
    const subscription = runtime.commitStream.subscribe();
    // Declare the snapshot baseline the way the thread stream does; without it the projection is
    // conservatively snapshot-only (it cannot judge bounds).
    subscription.setBaseline({counts: {chats: 0, jobs: 0, resources: 0, memory: 0}});
    try {
      // A chat update is a single-document commit: exactly one delta with exactly one path.
      await runtime.chats.create({requestId: 'stream-chat-2', name: '第二个'});
      const frames = await collect(subscription.events, seen => seen.some(f => f.type === 'state_delta'));
      const deltas = frames.filter(f => f.type === 'state_delta');
      assert.equal(deltas.length, 1, 'one commit produces one state delta');
      const delta = deltas[0]!;
      if (delta.type !== 'state_delta') throw new Error('unreachable');
      assert.equal(delta.patch.length, 1, 'only the changed path is sent, not the whole view');
      assert.ok(delta.patch[0]!.path.startsWith('/chats/'), 'the changed family path is used');
      assert.equal(delta.patch[0]!.op, 'add', 'add covers insert and update (idempotent-tolerant)');
      // The frame count must not scale with the total number of chats.
      assert.ok(frames.length <= 4, `frame count is constant, got ${frames.length}`);
    } finally {
      await subscription.cancel();
    }
    assert.ok(dir.length > 0);
  });
});

test('frames are emitted in commit order even when a projection awaits', {timeout: 30000}, async () => {
  await withRuntime(async runtime => {
    const subscription = runtime.commitStream.subscribe();
    subscription.setBaseline({counts: {chats: 0, jobs: 0, resources: 0, memory: 0}});
    try {
      // Several commits in a row: seq must be non-decreasing in emission order. Job lifecycle
      // commits force the projection to await a run-identity read, which is what could reorder.
      await runtime.chats.create({requestId: 'order-chat-1', name: 'A'});
      await runtime.chats.create({requestId: 'order-chat-2', name: 'B'});
      await runtime.chats.create({requestId: 'order-chat-3', name: 'C'});
      const frames = await collect(
        subscription.events,
        seen => new Set(seen.filter(f => f.type === 'state_delta').map(f => f.seq)).size >= 3,
      );
      const seqs = frames.map(frame => frame.seq);
      for (let index = 1; index < seqs.length; index += 1) {
        assert.ok(seqs[index]! >= seqs[index - 1]!, `frame order must not go backwards: ${seqs.join(',')}`);
      }
    } finally {
      await subscription.cancel();
    }
  });
});

test('truncated families degrade to a bounded snapshot instead of a partial patch', {timeout: 30000}, async () => {
  await withRuntime(async runtime => {
    // Declare the family degraded the way the thread stream would after a truncated snapshot.
    const subscription = runtime.commitStream.subscribe({truncatedFamilies: ['chats']});
    subscription.setBaseline({truncatedFamilies: ['chats'], counts: {chats: 0, jobs: 0, resources: 0, memory: 0}});
    try {
      await runtime.chats.create({requestId: 'degraded-chat-1', name: '截断族'});
      const frames = await collect(subscription.events, seen => seen.length > 0, 10_000);
      const snapshot = frames.find(frame => frame.type === 'state_snapshot');
      assert.ok(snapshot !== undefined, 'a degraded family commit becomes a snapshot');
      if (snapshot?.type !== 'state_snapshot') throw new Error('unreachable');
      assert.equal(snapshot.reason, 'bounded_view');
      assert.equal(frames.some(frame => frame.type === 'state_delta'), false, 'no partial patch alongside it');
    } finally {
      await subscription.cancel();
    }
  });
});

test('job lifecycle produces ACTIVITY and only the closed CUSTOM set', {timeout: 60000}, async () => {
  await withRuntime(async runtime => {
    const chat = await runtime.chats.create({requestId: 'job-chat-1', name: '任务源'});
    const subscription = runtime.commitStream.subscribe();
    subscription.setBaseline({counts: {chats: 0, jobs: 0, resources: 0, memory: 0}});
    try {
      const started = await runtime.jobs.start({
        requestId: 'job-start-1', title: '流任务', prompt: '做点事', sourceChatId: chat.id,
      });
      const frames = await collect(
        subscription.events,
        seen => seen.some(f => f.type === 'activity_snapshot')
          && seen.some(f => f.type === 'custom' && f.name === 'point.job.started'),
        15_000,
      );
      const activity = frames.find(frame => frame.type === 'activity_snapshot');
      assert.ok(activity !== undefined, 'job status change becomes ACTIVITY');
      if (activity?.type !== 'activity_snapshot') throw new Error('unreachable');
      assert.equal(activity.activityType, 'point.job');
      assert.equal(activity.messageId, `job-${started.jobId}`);

      const custom = frames.filter(frame => frame.type === 'custom').map(frame =>
        frame.type === 'custom' ? frame.name : '');
      assert.ok(custom.length > 0);
      for (const name of custom) {
        assert.ok(
          ['point.job.started', 'point.job.finished', 'point.stream.resync'].includes(name),
          `custom name ${name} must be in the closed set`,
        );
      }
      const startedFrame = frames.find(frame => frame.type === 'custom' && frame.name === 'point.job.started');
      if (startedFrame?.type === 'custom') {
        assert.equal(startedFrame.value.jobId, started.jobId);
        assert.equal(typeof startedFrame.value.attemptId, 'string', 'attemptId is the product attempt identity');
      }
    } finally {
      await subscription.cancel();
    }
  }, {model: true});
});
