import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels, type Models } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness, type Cursor, type ModelRef } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { RuntimeHandle } from '../application/ports.js';
import { preflightStorage } from '../storage/preflight.js';
import { acquireOwner } from '../storage/owner.js';
import { assertCompatible, Meta } from '../storage/meta.js';
import { chatCommands, type ChatCommands } from '../application/chats.js';
import { profileCommands, type ProfileCommands } from '../application/profile.js';
import { durableChatStore } from './chats.js';
import { contextExtension } from './context.js';
import { guardedModels } from './model-guard.js';
import { durableProfileStore } from './profile.js';
import { conversationRuntime } from './conversation.js';
import type { ConversationCommands } from '../application/conversation.js';
import type { JobCommands } from '../application/job.js';
import { artifactCommandsForHarness } from './artifacts.js';
import { jobRuntime } from './jobs.js';
import { jobToolsExtension, saveArtifactTool } from './tools.js';
import type { DeliveryCommands, NotificationPort } from '../application/delivery.js';
import type { FollowupCommands } from '../application/schedule.js';
import { resourceCommands, type ResourceCommands } from '../application/resource.js';
import { deliveryRuntime } from './deliveries.js';
import { followupRuntime, type SessionDocumentScanner } from './schedules.js';
import { durableResourceStore } from './resources.js';

export type ModelBinding = {models: Models; model: ModelRef};
export type OpenRuntimeOptions = {
  /** External notification channel; without it notifications fail closed (`NOTIFICATION_NOT_CONFIGURED`). */
  notification?: NotificationPort;
};
export type Runtime = RuntimeHandle & {
  readonly chats: ChatCommands;
  readonly conversation: ConversationCommands;
  readonly profile: ProfileCommands;
  readonly jobs: JobCommands;
  readonly followups: FollowupCommands;
  readonly deliveries: DeliveryCommands;
  readonly resources: ResourceCommands;
};

type StorageHandle = Awaited<ReturnType<typeof openNodeSqliteStorage>>;

/** Read-only scan of committed session documents; list queries (`decisions`, `deliveries`) use it. */
function sessionScanner(storage: StorageHandle): SessionDocumentScanner {
  return async kind => {
    const items: {key: string; value: Readonly<Record<string, unknown>>}[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = await storage.scanDocuments(
        {scope: {kind: 'session'}, at: 'current', kind}, 100, cursor, BACKGROUND_CONTEXT);
      for (const record of page.items) {
        const document = await storage.document(record.id, 'current', BACKGROUND_CONTEXT);
        if (document === undefined || document.record.key === undefined) continue;
        items.push({key: document.record.key, value: document.value});
      }
      if (page.next === undefined) break;
      cursor = page.next;
    }
    return items;
  };
}

export async function openRuntime(
  dataDir: string, binding?: ModelBinding, options?: OpenRuntimeOptions,
): Promise<Runtime> {
  if (binding && !binding.models.getModel(binding.model.provider, binding.model.modelId)) throw new Error('MODEL_NOT_CONFIGURED');
  await mkdir(dataDir, {recursive: true, mode: 0o700});
  const release = acquireOwner(join(dataDir, 'owner.sqlite'));
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let harness: Harness | undefined;
  try {
    const path = join(dataDir, 'state.sqlite');
    await preflightStorage(path);
    storage = await openNodeSqliteStorage(path);
    const storageHandle = storage;
    const populated = (await storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).items.length > 0
      || (await storage.scanDocuments({scope: {kind: 'session'}, at: 'current'}, 1, undefined, BACKGROUND_CONTEXT)).items.length > 0
      || (await storage.scanTasks({}, 1, undefined, BACKGROUND_CONTEXT)).items.length > 0;
    const current = () => { if (!harness) throw new Error('RUNTIME_NOT_READY'); return harness; };
    const guard = guardedModels(binding?.models ?? createModels(), current);
    const context = contextExtension();
    const conversation = conversationRuntime(current, binding?.model, [guard.extension, context]);
    const registry = createRegistry();
    registry.install(guard.extension);
    registry.install(conversation.extension);
    registry.install(context);
    harness = await Harness.open(storage, {models: guard.models, registry, settings: {
      retry: {enabled: false},
      // Manual compaction ignores `enabled`; the thresholds only size automatic compaction, unverified offline.
      compaction: {enabled: true, reserveTokens: 4096, keepRecentTokens: 8192, backgroundTokens: 0},
      followUpMode: 'one-at-a-time',
    }}, BACKGROUND_CONTEXT);
    // Jobs/artifacts are wired only after the Harness exists: the artifact store and the job tools both need
    // committed document access. Installing the two extensions before any resume keeps attempt tasks resolvable.
    const workspace = join(dataDir, 'workspace');
    // WP2: external resources persist in Durable documents (single commit CAS); the memory store
    // remains test-only. Construction needs the open Harness, so it happens after Harness.open.
    const resources = resourceCommands(durableResourceStore(harness), () => Date.now());
    const artifacts = artifactCommandsForHarness(harness, dataDir);
    const jobTools = jobToolsExtension(workspace);
    const saveArtifact = saveArtifactTool(workspace);
    const jobs = jobRuntime({
      getHarness: current,
      model: binding?.model,
      executionExtensions: [guard.extension, context, jobTools],
      executionTools: [saveArtifact],
      artifacts,
    });
    // WP1b.4: single follow-up plans and delivery. The delivery runtime owns Report/Notify tasks and the
    // notification port; the follow-up runtime creates delivery intents and those tasks in its decision commit.
    const scan = sessionScanner(storageHandle);
    const deliveries = deliveryRuntime({
      getHarness: current,
      scan,
      ...(options?.notification === undefined ? {} : {notification: options.notification}),
    });
    const schedules = followupRuntime({
      getHarness: current,
      scan,
      deliveries: deliveries.commands,
      deliveryTasks: {ReportTask: deliveries.ReportTask, NotifyTask: deliveries.NotifyTask},
    });
    registry.install(jobTools);
    registry.install(jobs.extension);
    registry.install(deliveries.extension);
    registry.install(schedules.extension);
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
    return {instanceId: meta.instanceId, chats: chatCommands(durableChatStore(activeHarness)),
      conversation: conversation.commands, profile: profileCommands(durableProfileStore(current)),
      jobs: jobs.commands,
      followups: schedules.commands,
      deliveries: deliveries.commands,
      resources,
      closed: activeHarness.closed.then(() => undefined), close() {
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
