// Standalone test host: no production fault flags or prototype test hooks.
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { chatCommands } from '../../src/application/chats.js';
import { durableChatStore } from '../../src/runtime/chats.js';
import { acquireOwner } from '../../src/storage/owner.js';

const [dir, boundary] = process.argv.slice(2);
if (!dir || !['before', 'after'].includes(boundary ?? '')) throw new Error('Invalid fixture args');
// The OS releases this lock when the parent kills this process.
acquireOwner(join(dir, 'owner.sqlite'));
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'state.sqlite')),
  {models: createModels(), registry: createRegistry()}, context);
async function stopAtBoundary(result: unknown): Promise<never> {
  process.send?.(result);
  setInterval(() => {}, 1000);
  return new Promise(() => {});
}
const store = durableChatStore({snapshot: harness.snapshot.bind(harness), commit: async (change, c) => {
  const result = await harness.commit(async tx => {
    const value = await change(tx);
    if (boundary === 'before') await stopAtBoundary(value);
    return value;
  }, c);
  return stopAtBoundary(result);
}});
await chatCommands(store).create({requestId: 'create:one', name: '项目计划'});
