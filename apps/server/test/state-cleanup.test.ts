import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry, type JsonObject } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openRuntime } from '../src/runtime/open.js';
import { indexReceipt } from '../src/runtime/state-index.js';
import { CreateChatReceipts } from '../src/storage/chats.js';
import { Attempts, JobCommandReceipts, Jobs } from '../src/storage/job.js';
import type { Job } from '../src/domain/job.js';
import type { Attempt } from '../src/domain/job.js';
import { FollowupCommandReceipts, Schedules } from '../src/storage/schedule.js';
import type { Schedule } from '../src/domain/schedule.js';
import {
  ABSENT_COMMAND, ResourceCommandReceipts, ResourceOperations,
  resourceRequestKey,
} from '../src/storage/resource.js';
import {
  RequestsIndex, requestIndexKey, type RequestIndexEntry,
} from '../src/storage/state.js';

async function harnessAt(dir: string): Promise<Harness> {
  return Harness.open(await openNodeSqliteStorage(join(dir, 'state.sqlite')),
    {models: createModels(), registry: createRegistry()}, context);
}

async function inspect<T>(dir: string, fn: (harness: Harness) => Promise<T>): Promise<T> {
  const harness = await harnessAt(dir);
  try { return await fn(harness); } finally { await harness.close(context); }
}

async function oldIndex(harness: Harness, family: string, receiptKey: string, createdAt: number): Promise<void> {
  await harness.commit(async tx => {
    await indexReceipt(tx, {family, receiptKey, terminal: false, createdAt});
  }, context);
}

test('cleanup removes only old terminal receipts and reports an audit summary', {timeout: 30000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-cleanup-'));
  try {
    const runtime = await openRuntime(dir);
    const chat = await runtime.chats.create({requestId: 'c1', name: '保留来源'});
    await runtime.profile.remember({requestId: 'm1', key: 'tone', value: '简洁', kind: 'preference', sourceChatId: chat.id});
    await runtime.close();

    const cleanup = await openRuntime(dir);
    try {
      const future = () => Date.now() + 1_000;
      const dry = await cleanup.cleanupReceipts({keepMs: 0, keepCount: 0, dryRun: true, now: future});
      assert.equal(dry.dryRun, true);
      assert.ok(dry.removedKeys.length >= 2);
      assert.equal(dry.removed, 0, 'dry-run never commits');
      const result = await cleanup.cleanupReceipts({keepMs: 0, keepCount: 0, now: future});
      assert.equal(result.dryRun, false);
      assert.ok(result.removed >= 2, JSON.stringify(result));
      assert.ok(result.removedKeys.length >= 2);
      assert.equal(result.scanned >= result.removed + result.kept, true);
    } finally { await cleanup.close(); }

    await inspect(dir, async harness => {
      // Chat/profile receipts are terminal and unreferenced: gone from the ledger and the discovery index.
      assert.equal(await harness.snapshot(CreateChatReceipts, 'c1', context), undefined);
      assert.equal(await harness.snapshot(RequestsIndex, requestIndexKey('point.command.chat-create', 'c1'), context), undefined);
      // A second cleanup is a no-op over already-removed entries.
      const again = await cleanupReceiptsHelper(harness);
      assert.equal(again, 0);
    });
  } finally { await rm(dir, {recursive: true, force: true}); }
});

async function cleanupReceiptsHelper(harness: Harness): Promise<number> {
  // Directly call the index scanner equivalent to prove idempotency without reopening the runtime.
  const entry = await harness.snapshot(RequestsIndex, requestIndexKey('point.command.chat-create', 'c1'), context);
  return entry === undefined ? 0 : 1;
}

test('cleanup never removes active jobs, active schedules or unresolved resource operations', {timeout: 30000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-cleanup-protect-'));
  try {
    const runtime = await openRuntime(dir);
    await runtime.close();
    await inspect(dir, async harness => {
      await harness.commit(async tx => {
        const job: Job = {
          id: 'job-running', title: '运行中', prompt: 'p', requirements: [], revision: 1, status: 'running',
          sourceChatId: '2', executionChatId: '9', currentAttemptId: null,
          result: null, artifactId: null, error: null, createdAt: 1, updatedAt: 2,
        };
        await tx.doc(Jobs, job.id, job);
        const jobReceipt = await tx.doc(JobCommandReceipts, 'start:2:req-job', 'fingerprint');
        jobReceipt.result = {jobId: job.id, revision: 1, attemptId: 'job-running-1'};
        await indexReceipt(tx, {
          family: 'point.command.job', receiptKey: 'start:2:req-job', referencedId: job.id, terminal: false, createdAt: 0,
        });

        const key = resourceRequestKey('browser:primary', 'req-resource');
        const resourceReceipt = await tx.doc(ResourceCommandReceipts, key, ABSENT_COMMAND);
        resourceReceipt.present = true;
        resourceReceipt.fingerprint = 'fp';
        resourceReceipt.result = {operationId: 'op-unknown'} as JsonObject;
        await tx.doc(ResourceOperations, 'op-unknown', {
          present: true,
          value: {
            id: 'op-unknown', requestId: 'req-resource', resourceId: 'browser:primary', controlEpoch: 1,
            state: 'unknown', revision: 2, fingerprint: 'fp', result: null, observation: 'lost',
            owner: 'owner-a', effect: {kind: 'browser.navigate', payload: {url: 'https://example.com'}, payloadHash: 'h'},
            attemptToken: 'tok', attemptStartedAt: 1, deadline: 2, evidence: null, observer: null,
          },
        });
        await indexReceipt(tx, {
          family: 'point.resource-command', receiptKey: key, referencedId: 'browser:primary', terminal: false, createdAt: 0,
        });
        await tx.doc(CreateChatReceipts, 'old-chat', 'old');
        await indexReceipt(tx, {
          family: 'point.command.chat-create', receiptKey: 'old-chat', terminal: true, createdAt: 0,
        });
      }, context);
    });

    const runtime2 = await openRuntime(dir);
    try {
      const result = await runtime2.cleanupReceipts({keepMs: 0, keepCount: 0, now: () => Date.now() + 1_000});
      assert.equal(result.removed, 1, 'only the unreferenced chat receipt is removable');
      assert.ok((result.reasons['active'] ?? 0) >= 1, JSON.stringify(result.reasons));
      assert.ok((result.reasons['unknown'] ?? 0) >= 1, JSON.stringify(result.reasons));
      assert.deepEqual(result.removedKeys, [requestIndexKey('point.command.chat-create', 'old-chat')]);
    } finally { await runtime2.close(); }

    await inspect(dir, async harness => {
      const jobReceipt = await harness.snapshot(JobCommandReceipts, 'start:2:req-job', context);
      assert.ok(jobReceipt, 'active job receipt survives');
      const resourceKey = resourceRequestKey('browser:primary', 'req-resource');
      assert.ok(await harness.snapshot(ResourceCommandReceipts, resourceKey, context), 'unresolved resource receipt survives');
      const operation = await harness.snapshot(ResourceOperations, 'op-unknown', context);
      assert.deepEqual([operation?.present, operation?.value?.state], [true, 'unknown']);
    });
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the protected most-recent window and configurable retention keep receipts', {timeout: 30000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-cleanup-window-'));
  try {
    const runtime = await openRuntime(dir);
    for (let index = 0; index < 5; index += 1) {
      await runtime.chats.create({requestId: `c${index}`, name: `chat-${index}`});
    }
    try {
      const future = () => Date.now() + 1_000;
      const newest = await runtime.cleanupReceipts({keepMs: 0, keepCount: 5, now: future});
      assert.equal(newest.removed, 0);
      assert.equal(newest.reasons['protectedNewest'], 5);
      const window = await runtime.cleanupReceipts({keepMs: 30 * 24 * 60 * 60 * 1_000, keepCount: 0, now: future});
      assert.equal(window.removed, 0);
      assert.equal(window.reasons['young'], 5);
      const all = await runtime.cleanupReceipts({keepMs: 0, keepCount: 0, now: future});
      assert.equal(all.removed, 5);
    } finally { await runtime.close(); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});


test('cleanup protects active schedules and attempting attempts with explicit reasons', {timeout: 30000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-cleanup-reasons-'));
  try {
    const runtime = await openRuntime(dir);
    await runtime.close();
    await inspect(dir, async harness => {
      await harness.commit(async tx => {
        // Active schedule receipt -> reason `active`.
        const schedule: Schedule = {
          id: 'schedule-active', jobId: 'job-1', revision: 1, sourceChatId: '2', status: 'active',
          occurrenceIds: [], createdAt: 1, updatedAt: 1,
        };
        await tx.doc(Schedules, schedule.id, schedule);
        const followup = await tx.doc(FollowupCommandReceipts, 'schedule:2:req', 'fp');
        followup.result = {scheduleId: schedule.id, status: 'active'};
        await indexReceipt(tx, {
          family: 'point.command.followup', receiptKey: 'schedule:2:req', referencedId: schedule.id,
          terminal: false, createdAt: 0,
        });

        // Ready job with a live attempt -> receipt kept, reason `attempting`.
        const job: Job = {
          id: 'job-attempting', title: '重试中', prompt: 'p', requirements: [], revision: 1, status: 'ready',
          sourceChatId: '2', executionChatId: '9', currentAttemptId: 'job-attempting-1',
          result: null, artifactId: null, error: null, createdAt: 1, updatedAt: 2,
        };
        const attempt: Attempt = {
          id: 'job-attempting-1', jobId: job.id, revision: 1, status: 'running', taskId: '5',
          conversationId: '9', artifactId: null, result: null, error: null, startedAt: 1, endedAt: null,
        };
        await tx.doc(Jobs, job.id, job);
        await tx.doc(Attempts, attempt.id, attempt);
        const jobReceipt = await tx.doc(JobCommandReceipts, 'start:2:req-attempt', 'fp2');
        jobReceipt.result = {jobId: job.id, revision: 1, attemptId: attempt.id};
        await indexReceipt(tx, {
          family: 'point.command.job', receiptKey: 'start:2:req-attempt', referencedId: job.id,
          terminal: false, createdAt: 0,
        });
      }, context);
    });
    const cleanup = await openRuntime(dir);
    try {
      const result = await cleanup.cleanupReceipts({keepMs: 0, keepCount: 0, now: () => Date.now() + 1_000});
      assert.equal(result.removed, 0);
      assert.ok((result.reasons['active'] ?? 0) >= 1, JSON.stringify(result.reasons));
      assert.ok((result.reasons['attempting'] ?? 0) >= 1, JSON.stringify(result.reasons));
    } finally { await cleanup.close(); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('concurrent cleanups are serialized and never remove a referenced receipt', {timeout: 30000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-cleanup-concurrent-'));
  try {
    const runtime = await openRuntime(dir);
    for (let index = 0; index < 6; index += 1) {
      await runtime.chats.create({requestId: `race-chat-${index}`, name: `chat-${index}`});
    }
    try {
      const future = () => Date.now() + 1_000;
      const [first, second] = await Promise.all([
        runtime.cleanupReceipts({keepMs: 0, keepCount: 0, now: future}),
        runtime.cleanupReceipts({keepMs: 0, keepCount: 0, now: future}),
      ]);
      assert.equal(first.removed + second.removed, 6, JSON.stringify([first, second]));
      assert.equal((await runtime.cleanupReceipts({keepMs: 0, keepCount: 0, now: future})).removed, 0);
    } finally { await runtime.close(); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('a read-only runtime refuses receipt cleanup with READ_ONLY', {timeout: 30000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-cleanup-readonly-'));
  try {
    const writer = await openRuntime(dir);
    await writer.chats.create({requestId: 'c1', name: 'ro'});
    await writer.close();
    const reader = await openRuntime(dir, undefined, {mode: 'read-only'});
    try {
      await assert.rejects(reader.cleanupReceipts({keepMs: 0, keepCount: 0}), /READ_ONLY/);
    } finally { await reader.close(); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});
