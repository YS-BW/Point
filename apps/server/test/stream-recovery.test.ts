import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import type { CommitPublication, Harness, Seq } from '@earendil-works/pi-durable';
import type { ConversationCommands } from '../src/application/conversation.js';
import type { CommitFrame, ReadModelPort, StateView } from '../src/application/read-model.js';
import { threadStreamRuntime, RETENTION_FRAMES } from '../src/runtime/thread-stream.js';
import { commitStreamRuntime } from '../src/runtime/commit-stream.js';
import { readModelRuntime } from '../src/runtime/read-model.js';
import { runStreamRuntime } from '../src/runtime/run-stream.js';
import { streamBudget } from '../src/runtime/stream-budget.js';

const empty = (seq = 0): StateView => ({seq, chats: {}, jobs: {}, memory: {}, events: {}, resources: {}});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return {promise, resolve};
}
function threadFixture(options: {
  state?: () => Promise<StateView>;
  history?: () => Promise<void>;
  budget?: ReturnType<typeof streamBudget>;
} = {}) {
  const queue: CommitFrame[] = [];
  let wake: (() => void) | undefined;
  let cancelled = false;
  const stream = threadStreamRuntime({
    readModel: {state: options.state ?? (async () => empty()), counts: async () => ({counts: {}, truncated: false})},
    commitStream: {subscribe: () => ({
      events: {async *[Symbol.asyncIterator]() {
        while (!cancelled) {
          while (queue.length) yield queue.shift()!;
          if (!cancelled) await new Promise<void>(r => { wake = r; });
        }
      }},
      setBaseline() {},
      async cancel() { cancelled = true; wake?.(); },
    })},
    conversation: {history: async () => { await options.history?.(); return {items: []}; }} as unknown as ConversationCommands,
    ...(options.budget === undefined ? {} : {budget: options.budget}),
  });
  return {stream, emit(frame: CommitFrame) { queue.push(frame); wake?.(); wake = undefined; }};
}
const delta = (seq: number): CommitFrame => ({type: 'state_delta', seq,
  patch: [{op: 'add', path: '/jobs/job1', value: {id: 'job1', status: 'ready', revision: seq, updatedAt: seq}}]});

test('unknown cursor resync preserves a job completed while history was loading', async () => {
  const fixture = threadFixture({history: async () => { fixture.emit(delta(1)); await tick(); }});
  const handle = await fixture.stream.open('1', 'bad-cursor');
  const iterator = handle.frames[Symbol.asyncIterator]();
  const types = [];
  for (let i = 0; i < 7; i++) types.push((await iterator.next()).value!.body.type);
  assert.deepEqual(types.slice(-2), ['custom', 'state_delta']);
  await handle.close(); await iterator.return?.();
});

test('a completed snapshot is not rolled back by queued older state or activity frames', async () => {
  const fixture = threadFixture({state: async () => empty(10), history: async () => {
    fixture.emit(delta(9));
    fixture.emit({type: 'activity_snapshot', seq: 9, messageId: 'job-1', activityType: 'point.job', content: {status: 'running'}});
    fixture.emit(delta(11)); await tick();
  }});
  const handle = await fixture.stream.open('1');
  const iterator = handle.frames[Symbol.asyncIterator]();
  for (let i = 0; i < 5; i++) await iterator.next();
  const frame = (await iterator.next()).value!;
  assert.equal(frame.seq, 11);
  assert.equal(frame.body.type, 'state_delta');
  await handle.close(); await iterator.return?.();
});

test('a slow snapshot whose catch-up window was trimmed fails explicitly', async () => {
  const fixture = threadFixture({history: async () => {
    for (let seq = 1; seq <= RETENTION_FRAMES + 1; seq++) { fixture.emit(delta(seq)); await tick(); }
  }});
  await assert.rejects(fixture.stream.open('1'), /OBSERVATION_RESYNC_REQUIRED/);
});

test('connection slots include pending opens and are released after setup failure', async () => {
  const gate = deferred<void>();
  let fail = true;
  const fixture = threadFixture({budget: streamBudget(2), state: async () => {
    await gate.promise;
    if (fail) throw new Error('snapshot unavailable');
    return empty();
  }});
  const first = fixture.stream.open('1');
  const second = fixture.stream.open('1');
  await assert.rejects(fixture.stream.open('1'), /TOO_MANY_STREAMS/);
  gate.resolve();
  await Promise.all([assert.rejects(first, /snapshot unavailable/), assert.rejects(second, /snapshot unavailable/)]);
  fail = false;
  const recovered = await fixture.stream.open('1');
  await recovered.close();
});

function engine() {
  const listeners = new Set<(publication: CommitPublication) => void>();
  let task: unknown;
  let reads = 0;
  const harness = {
    subscribeCommits(listener: (publication: CommitPublication) => void) {
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    async getTask() { reads++; return task; },
  } as unknown as Harness;
  return {harness, listeners, get reads() { return reads; }, setTask(value: unknown) { task = value; },
    publish(seq: number, changes: unknown[] = []) {
      for (const listener of [...listeners]) listener({seq: seq as Seq, changes} as CommitPublication);
    }};
}
const model: ReadModelPort = {state: async () => empty(), counts: async () => ({counts: {}, truncated: false})};

test('cancel and projection failure release the SDK listener; retries do not accumulate observers', async () => {
  const mock = engine();
  const commits = commitStreamRuntime({getHarness: () => mock.harness, readModel: model});
  for (let i = 0; i < 5; i++) {
    const sub = commits.subscribe();
    assert.equal(mock.listeners.size, 1);
    await sub.cancel(); await sub.cancel();
    assert.equal(mock.listeners.size, 0);
  }
  const broken = commitStreamRuntime({getHarness: () => mock.harness,
    readModel: {...model, state: async () => { throw new Error('storage unavailable'); }}}).subscribe();
  const next = broken.events[Symbol.asyncIterator]().next();
  mock.publish(1, [{type: 'document', record: {kind: 'point.jobs', key: 'j'}, value: {status: 'running'}}]);
  await assert.rejects(next, /OBSERVATION_RESYNC_REQUIRED/);
  assert.equal(mock.listeners.size, 0);
});

test('state retries the whole scan when a concurrent commit crosses family reads', async () => {
  const mock = engine();
  let inject = false;
  const versions: unknown[] = [];
  const reader = readModelRuntime({getHarness: () => mock.harness, scan: async (kind) => {
    versions.push(kind);
    if (inject) { inject = false; mock.publish(12); }
    return [];
  }});
  await reader.state(); // Attach before the mutation.
  versions.length = 0;
  mock.publish(11); inject = true;
  assert.equal((await reader.state()).seq, 12);
  assert.equal(versions.length, 10, 'discarded scan plus consistent retry');
});

test('restart baseline retries if a commit lands during the first scan', async () => {
  const mock = engine();
  let inject = true;
  const reader = readModelRuntime({getHarness: () => mock.harness, scan: async () => {
    if (inject) { inject = false; mock.publish(12); }
    return [];
  }});
  assert.equal((await reader.state()).seq, 12);
});

const task = (status: string, outcome?: string) => ({id: 1, conversationId: 1,
  state: {status, ...(outcome === undefined ? {} : {outcome: {status: outcome}})}});

test('run observation uses native publications, reports outcome, releases resources and never polls', async () => {
  const mock = engine(); mock.setTask(task('running'));
  const runs = runStreamRuntime({getHarness: () => mock.harness});
  const handle = await runs.open('1');
  const iterator = handle.frames[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value!.type, 'run_started');
  assert.equal((await iterator.next()).value!.type, 'activity_snapshot');
  mock.publish(1, [{type: 'task', value: task('terminal', 'failed')}]);
  assert.equal((await iterator.next()).value!.type, 'activity_snapshot');
  assert.deepEqual((await iterator.next()).value, {type: 'run_finished', runId: '1', status: 'failed'});
  assert.equal((await iterator.next()).done, true);
  assert.equal(mock.reads, 1);
  assert.equal(mock.listeners.size, 0);
});

test('thread and run observations share admission; closing observation does not control the task', async () => {
  const budget = streamBudget(1);
  const fixture = threadFixture({budget});
  const thread = await fixture.stream.open('1');
  const mock = engine(); mock.setTask(task('running'));
  const runs = runStreamRuntime({getHarness: () => mock.harness, budget});
  await assert.rejects(runs.open('1'), /TOO_MANY_STREAMS/);
  await thread.close();
  const run = await runs.open('1');
  assert.equal(mock.listeners.size, 1);
  await run.close();
  assert.equal(mock.listeners.size, 0);
  assert.equal(mock.reads, 1); // No cancel/abort API exists on this test harness.
  const next = await fixture.stream.open('1'); await next.close();
});

test('idle run observation ends with observation timeout rather than a fabricated execution failure', async () => {
  const mock = engine(); mock.setTask(task('running'));
  const handle = await runStreamRuntime({getHarness: () => mock.harness, idleTimeoutMs: 10}).open('1');
  const iterator = handle.frames[Symbol.asyncIterator]();
  await iterator.next(); await iterator.next();
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(iterator.next(), /OBSERVATION_TIMEOUT/); }
  finally { clearTimeout(keepAlive); await handle.close(); }
  assert.equal(mock.listeners.size, 0);
});

test('continuous writes fail the snapshot explicitly after bounded retries', async () => {
  const mock = engine();
  let scans = 0;
  const reader = readModelRuntime({getHarness: () => mock.harness, scan: async () => {
    mock.publish(++scans); return [];
  }});
  await assert.rejects(reader.state(), /OBSERVATION_RESYNC_REQUIRED/);
  assert.equal(scans, 20, 'four complete bounded attempts, not an unbounded retry loop');
});

test('run changes during initial lookup are preserved without extra reads', async () => {
  const mock = engine();
  const initial = deferred<Awaited<ReturnType<Harness['getTask']>>>();
  mock.harness.getTask = (() => initial.promise) as typeof mock.harness.getTask;
  const opening = runStreamRuntime({getHarness: () => mock.harness}).open('1');
  mock.publish(2, [{type: 'task', value: task('terminal', 'completed')}]);
  initial.resolve(task('running') as unknown as Awaited<ReturnType<Harness['getTask']>>);
  const handle = await opening;
  const frames = [];
  for await (const frame of handle.frames) frames.push(frame);
  assert.deepEqual(frames.at(-1), {type: 'run_finished', runId: '1', status: 'success'});
  assert.equal(mock.listeners.size, 0);
});
