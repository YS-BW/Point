import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openRuntime } from '../src/runtime/open.js';
import { MAX_PROFILE_ENTRIES, ProfileError } from '../src/domain/profile.js';
import { MEMORY_COUNTER_KEY, MemoryCounter } from '../src/storage/state.js';

function remember(requestId: string, key: string, value = 'v') {
  return {requestId, key, value, kind: 'fact' as const, sourceChatId: '2'};
}

function isLimit(error: unknown): boolean {
  return error instanceof ProfileError && error.code === 'PROFILE_LIMIT_REACHED';
}

async function fileCounts(entries: ReadonlyArray<{status: string}>): Promise<number> {
  return entries.filter(entry => entry.status === 'fulfilled').length;
}

test('the profile cap is decided inside the commit: concurrent inserts cannot exceed 64', {timeout: 30000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-profile-race-'));
  try {
    const runtime = await openRuntime(dir);
    try {
      for (let index = 0; index < MAX_PROFILE_ENTRIES - 1; index += 1) {
        await runtime.profile.remember(remember(`seed-${index}`, `k${index}`));
      }
      assert.equal((await runtime.profile.list()).length, MAX_PROFILE_ENTRIES - 1);

      // Two concurrent different-key inserts at 63 entries: exactly one may reach 64.
      const raced = await Promise.allSettled([
        runtime.profile.remember(remember('race-a', 'race-a')),
        runtime.profile.remember(remember('race-b', 'race-b')),
      ]);
      assert.equal(await fileCounts(raced), 1, JSON.stringify(raced));
      const rejected = raced.find(entry => entry.status === 'rejected');
      assert.ok(rejected?.status === 'rejected' && isLimit(rejected.reason));
      assert.equal((await runtime.profile.list()).length, MAX_PROFILE_ENTRIES);

      // Updating an existing key is still allowed at the cap; a new key is not.
      const atCap = await Promise.allSettled([
        runtime.profile.remember(remember('update-existing', 'k0', 'updated')),
        runtime.profile.remember(remember('new-at-cap', 'overflow')),
      ]);
      assert.equal(atCap[0]?.status, 'fulfilled');
      assert.ok(atCap[1]?.status === 'rejected' && isLimit(atCap[1].reason));
      assert.equal((await runtime.profile.list()).length, MAX_PROFILE_ENTRIES);
      assert.equal((await runtime.profile.list()).find(entry => entry.key === 'k0')?.value, 'updated');
    } finally { await runtime.close(); }

    // The counter survives a clean reopen and still enforces the cap.
    const reopened = await openRuntime(dir);
    try {
      await assert.rejects(reopened.profile.remember(remember('after-reopen', 'late')), isLimit);
      assert.equal((await reopened.profile.list()).length, MAX_PROFILE_ENTRIES);
    } finally { await reopened.close(); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('concurrent forgets and a missing-key forget keep the same-transaction count consistent', {timeout: 30000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-profile-race-forget-'));
  try {
    const runtime = await openRuntime(dir);
    try {
      for (let index = 0; index < MAX_PROFILE_ENTRIES; index += 1) {
        await runtime.profile.remember(remember(`seed-${index}`, `k${index}`));
      }
      const forgotten = await Promise.all([
        runtime.profile.forget({requestId: 'forget-a', key: 'k0'}),
        runtime.profile.forget({requestId: 'forget-b', key: 'k1'}),
      ]);
      assert.deepEqual(forgotten, [{key: 'k0', removed: true}, {key: 'k1', removed: true}]);
      assert.equal((await runtime.profile.list()).length, MAX_PROFILE_ENTRIES - 2);

      // A missing-key forget must not free counter space.
      assert.deepEqual(await runtime.profile.forget({requestId: 'forget-missing', key: 'nope'}),
        {key: 'nope', removed: false});
      const adds = await Promise.allSettled([
        runtime.profile.remember(remember('add-a', 'add-a')),
        runtime.profile.remember(remember('add-b', 'add-b')),
        runtime.profile.remember(remember('add-c', 'add-c')),
      ]);
      assert.equal(await fileCounts(adds), 2, JSON.stringify(adds));
      assert.equal((await runtime.profile.list()).length, MAX_PROFILE_ENTRIES);

      // Two concurrent writes of the same key (different request ids) count the entry once.
      const sameKey = await Promise.all([
        runtime.profile.remember(remember('same-1', 'add-a', 'one')),
        runtime.profile.remember(remember('same-2', 'add-a', 'two')),
      ]);
      assert.deepEqual(sameKey.map(entry => entry.key), ['add-a', 'add-a']);
      assert.equal((await runtime.profile.list()).length, MAX_PROFILE_ENTRIES);
    } finally { await runtime.close(); }

    const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'state.sqlite')),
      {models: createModels(), registry: createRegistry()}, context);
    try {
      const counter = await harness.snapshot(MemoryCounter, MEMORY_COUNTER_KEY, context);
      assert.equal(counter?.count, MAX_PROFILE_ENTRIES, 'the committed counter matches the entry set');
    } finally { await harness.close(context); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});
