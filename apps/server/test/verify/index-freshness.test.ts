/**
 * Focused check: the derived state view must track lifecycle updates, not only creation.
 *
 * This is the isolated form of the E2/E3 blocker found by the WP6 independent verification. The v2
 * index families are written in the same commit as the entity change (WP3), so once an attempt
 * finishes, `point.jobs` must agree with `point.job`. If it does not, `/v1/state` and every
 * STATE_DELTA are stale even though the event timeline shows the lifecycle happened.
 *
 * Kept as its own file so the failure names the root cause instead of appearing as a delta-patch
 * mismatch in the stream tests.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readState, seed, startVerifyServer } from './support.js';

test('state view reflects job lifecycle updates, not only job creation',
  {timeout: 60_000}, async t => {
    const server = await startVerifyServer(t, {modelResponses: 16});
    const fixture = await seed(server, {chats: 1, jobs: 2});
    const entities = await Promise.all(fixture.jobIds.map(async jobId => await server.runtime.jobs.get(jobId)));
    const body = await readState(server);
    const stateJobs = body.jobs as Record<string, {status?: string; revision?: number; updatedAt?: number}>;

    // Proof that the lifecycle actually ran: the event timeline records the terminal transitions.
    const events = Object.values(body.events as Record<string, {type?: string; aggregateId?: string}>);
    for (const jobId of fixture.jobIds) {
      const types = new Set(events.filter(event => event.aggregateId === jobId).map(event => event.type));
      assert.ok(types.has('job.failed') || types.has('job.ready'),
        `no terminal job event for ${jobId}; got ${[...types].join(',')}`);
    }

    for (const [index, jobId] of fixture.jobIds.entries()) {
      const entity = entities[index]!;
      const row = stateJobs[jobId];
      assert.ok(row !== undefined, `state.jobs is missing the created job ${jobId}`);
      assert.equal(row.status, entity.status,
        `state index is stale for job ${jobId}: state=${String(row.status)} entity=${entity.status}`);
      assert.equal(row.revision, entity.revision,
        `state index revision is stale for job ${jobId}: state=${String(row.revision)} entity=${entity.revision}`);
      assert.equal(row.updatedAt, entity.updatedAt,
        `state index updatedAt is stale for job ${jobId}: state=${String(row.updatedAt)} entity=${entity.updatedAt}`);
    }
  });
