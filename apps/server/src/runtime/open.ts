import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type Models } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness, type ModelRef } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { RuntimeHandle } from '../application/ports.js';
import { preflightStorage } from '../storage/preflight.js';
import { acquireOwner } from '../storage/owner.js';
import { assertCompatible, Meta } from '../storage/meta.js';
import { chatCommands, type ChatCommands } from '../application/chats.js';
import { durableChatStore } from './chats.js';
import { guardedModels } from './model-guard.js';
import { conversationRuntime } from './conversation.js';
import type { ConversationCommands } from '../application/conversation.js';

export type ModelBinding = {models: Models; model: ModelRef};
export async function openRuntime(dataDir: string, binding?: ModelBinding): Promise<RuntimeHandle & {readonly chats: ChatCommands; readonly conversation: ConversationCommands}> {
  if (binding && !binding.models.getModel(binding.model.provider, binding.model.modelId)) throw new Error('MODEL_NOT_CONFIGURED');
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
    const current = () => { if (!harness) throw new Error('RUNTIME_NOT_READY'); return harness; };
    const guard = guardedModels(binding?.models ?? createModels(), current);
    const conversation = conversationRuntime(current, binding?.model, guard.extension);
    const registry = createRegistry();
    registry.install(guard.extension);
    registry.install(conversation.extension);
    harness = await Harness.open(storage, {models: guard.models, registry,
      settings: {retry: {enabled: false}, compaction: {enabled: false}, followUpMode: 'one-at-a-time'}}, BACKGROUND_CONTEXT);
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
    // Only an explicitly configured host resumes execution. Read-only foundation remains usable.
    if (binding) harness.resume();
    const activeHarness = harness;
    let closing: Promise<void> | undefined;
    return {instanceId: meta.instanceId, chats: chatCommands(durableChatStore(activeHarness)), conversation: conversation.commands, closed: activeHarness.closed.then(() => undefined), close() {
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
