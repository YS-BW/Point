import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { RuntimeHandle } from '../application/ports.js';
import { preflightStorage } from '../storage/preflight.js';
import { acquireOwner } from '../storage/owner.js';
import { assertCompatible, Meta } from '../storage/meta.js';

export async function openRuntime(dataDir: string): Promise<RuntimeHandle> {
  await mkdir(dataDir, {recursive: true, mode: 0o700});
  const release = acquireOwner(join(dataDir, 'owner.sqlite'));
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let harness: Harness | undefined;
  try {
    const path = join(dataDir, 'state.sqlite');
    await preflightStorage(path);
    storage = await openNodeSqliteStorage(path);
    const populated = (await storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).items.length > 0
      || (await storage.scanDocuments({scope: {kind: 'session'}, at: 'current'}, 1, undefined, BACKGROUND_CONTEXT)).items.length > 0
      || (await storage.scanTasks({}, 1, undefined, BACKGROUND_CONTEXT)).items.length > 0;
    harness = await Harness.open(storage, {models: createModels(), registry: createRegistry()}, BACKGROUND_CONTEXT);
    let meta = await harness.snapshot(Meta, BACKGROUND_CONTEXT);
    if (!meta) {
      if (populated) throw new Error('UNRECOGNIZED_DATA');
      // Reserved root + metadata are created in one atomic commit. Reopen never rewrites them.
      await harness.root(BACKGROUND_CONTEXT, {init: async tx => {
        const draft = await tx.doc(Meta);
        draft.instanceId = randomUUID();
      }});
      meta = await harness.snapshot(Meta, BACKGROUND_CONTEXT);
    }
    if (!meta) throw new Error('MISSING_METADATA');
    assertCompatible(meta);
    // No tools, models or product tasks are installed in WP1a; never resume old work here.
    const activeHarness = harness;
    let closing: Promise<void> | undefined;
    return {instanceId: meta.instanceId, closed: activeHarness.closed.then(() => undefined), close() {
      return closing ??= activeHarness.close(BACKGROUND_CONTEXT).finally(release);
    }};
  } catch (error) {
    try {
      if (harness) await harness.close(BACKGROUND_CONTEXT);
      else await storage?.close(BACKGROUND_CONTEXT);
    } finally { release(); }
    throw error;
  }
}
