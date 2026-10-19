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
import { MetaV2 } from '../storage/state.js';
import { chatCommands, type ChatCommands } from '../application/chats.js';
import { profileCommands, type ProfileCommands } from '../application/profile.js';
import { durableChatStore } from './chats.js';
import { contextExtension } from './context.js';
import { guardedModels } from './model-guard.js';
import { durableProfileStore } from './profile.js';
import { conversationRuntime } from './conversation.js';
import { agentRuntime } from './agui.js';
import type { AgentRunPort } from '../application/agent-stream.js';
import type { ConversationCommands } from '../application/conversation.js';
import type { JobCommands } from '../application/job.js';
import { artifactCommandsForHarness, sha256Hex } from './artifacts.js';
import { jobRuntime } from './jobs.js';
import { jobToolsExtension, saveArtifactTool } from './tools.js';
import type { DeliveryCommands, NotificationPort } from '../application/delivery.js';
import type { FollowupCommands } from '../application/schedule.js';
import {
  canonicalJson, resourceCommands, type EffectRegistry, type ResourceCommands,
} from '../application/resource.js';
import { deliveryRuntime } from './deliveries.js';
import { followupRuntime, type SessionDocumentScanner } from './schedules.js';
import { durableResourceStore } from './resources.js';
import { StateFormatError, detectStateFormat, readOnlyGuard, type OpenMode } from './format.js';
import {
  cleanupReceipts, rebuildEventTimeline,
  type EventRebuildResult, type ReceiptCleanupOptions, type ReceiptCleanupResult,
} from './maintenance.js';

export type ModelBinding = {models: Models; model: ModelRef};

/** Secure resource-effect composition options (adapters register their capabilities here). */
export type ResourceRuntimeOptions = Readonly<{
  effects?: EffectRegistry;
  hash?: (canonical: string) => string;
  token?: () => string;
  deadlineMs?: number;
}>;

export type OpenRuntimeOptions = {
  /**
   * Product state format mode. `read-write` (default) requires format 2 and refuses a v1 database with
   * `MIGRATION_REQUIRED`; `read-only` accepts format 1 or 2 and guards all product writes.
   */
  mode?: OpenMode;
  /** External notification channel; without it notifications fail closed (`NOTIFICATION_NOT_CONFIGURED`). */
  notification?: NotificationPort;
  /**
   * Secure resource effects. Absent options keep the runtime fail-closed: every
   * beginOperation whose kind is not registered is rejected with EFFECT_NOT_REGISTERED.
   */
  resources?: ResourceRuntimeOptions;
};
export type Runtime = RuntimeHandle & {
  readonly chats: ChatCommands;
  readonly conversation: ConversationCommands;
  readonly profile: ProfileCommands;
  readonly jobs: JobCommands;
  readonly followups: FollowupCommands;
  readonly deliveries: DeliveryCommands;
  readonly resources: ResourceCommands;
  /** WP5: provider-neutral foreground run stream consumed by the AG-UI edge. */
  readonly agent: AgentRunPort;
  /** True when the runtime was opened with `mode: 'read-only'`. */
  readonly readOnly: boolean;
  /** Explicit bounded request-ledger cleanup; never removes active/attempting/unknown references. */
  cleanupReceipts(options?: ReceiptCleanupOptions): Promise<ReceiptCleanupResult>;
  /** Rebuild the derived product event timeline from current entity state (never changes state). */
  rebuildEvents(): Promise<EventRebuildResult>;
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
  const mode = options?.mode ?? 'read-write';
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let harness: Harness | undefined;
  try {
    const path = join(dataDir, 'state.sqlite');
    await preflightStorage(path);
    storage = await openNodeSqliteStorage(path);
    const storageHandle = storage;
    // Read-only document scan used by prompt sections and list queries (no Session scan API exists).
    const scan = sessionScanner(storageHandle);
    const populated = (await storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT)).items.length > 0
      || (await storage.scanDocuments({scope: {kind: 'session'}, at: 'current'}, 1, undefined, BACKGROUND_CONTEXT)).items.length > 0
      || (await storage.scanTasks({}, 1, undefined, BACKGROUND_CONTEXT)).items.length > 0;
    let activeHarness: Harness | undefined;
    const current = () => { if (!activeHarness) throw new Error('RUNTIME_NOT_READY'); return activeHarness; };
    const guard = guardedModels(binding?.models ?? createModels(), current);
    const context = contextExtension(scan);
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
    // WP3 format gate: detect the product state format before any product write. Fresh databases are
    // created directly as format 2; v1 is explicit-migrate or read-only; unknown/newer is refused.
    const detected = await detectStateFormat(harness, populated, mode);
    if (detected.format === 'fresh') {
      // Reserved root + v2 metadata are created in one atomic commit. Reopen never rewrites them.
      await harness.root(BACKGROUND_CONTEXT, {init: async tx => {
        const draft = await tx.doc(MetaV2);
        draft.instanceId = randomUUID();
        draft.migratedAt = 0;
      }});
    }
    const instanceId = detected.format === 'fresh'
      ? (await harness.snapshot(MetaV2, BACKGROUND_CONTEXT))?.instanceId
      : detected.instanceId;
    if (!instanceId) throw new Error('MISSING_METADATA');
    // Read-only mode: product stores receive a guarded Harness whose commit/resume refuse writes.
    const runtimeHarness = mode === 'read-only' ? readOnlyGuard(harness) : harness;
    activeHarness = runtimeHarness;
    // Jobs/artifacts are wired only after the Harness exists: the artifact store and the job tools both need
    // committed document access. Installing the two extensions before any resume keeps attempt tasks resolvable.
    const workspace = join(dataDir, 'workspace');
    // WP2: external resources persist in Durable documents (single commit CAS); the memory store
    // remains test-only. Construction needs the open Harness, so it happens after Harness.open.
    // Secure mode is the production path: registered effect kinds only, bound payload/hash,
    // live owner/lease/epoch + attempt-token fence, deadline/abort, evidence-bound reconcile.
    const resources = resourceCommands(durableResourceStore(current()), () => Date.now(), canonicalJson, {
      secure: true,
      effects: options?.resources?.effects ?? {resolve: () => undefined},
      hash: options?.resources?.hash ?? sha256Hex,
      token: options?.resources?.token ?? randomUUID,
      deadlineMs: options?.resources?.deadlineMs ?? 30_000,
    });
    const artifacts = artifactCommandsForHarness(current(), dataDir);
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
    // Only an explicitly configured, read-write host resumes execution.
    if (binding && mode === 'read-write') harness.resume();
    let closing: Promise<void> | undefined;
    return {instanceId, chats: chatCommands(durableChatStore(current())),
      conversation: conversation.commands, profile: profileCommands(durableProfileStore(current, scan)),
      jobs: jobs.commands,
      followups: schedules.commands,
      deliveries: deliveries.commands,
      resources,
      agent: agentRuntime(conversation.commands, current),
      readOnly: mode === 'read-only',
      cleanupReceipts: options => mode === 'read-only'
        ? Promise.reject(new StateFormatError('READ_ONLY'))
        : cleanupReceipts({getHarness: current, scan}, options),
      rebuildEvents: () => rebuildEventTimeline({getHarness: current, scan}),
      closed: harness.closed.then(() => undefined), close() {
        return closing ??= harness!.close(BACKGROUND_CONTEXT).finally(release);
      }};
  } catch (error) {
    try {
      if (harness) await harness.close(BACKGROUND_CONTEXT);
      else await storage?.close(BACKGROUND_CONTEXT);
    } finally { release(); }
    throw error;
  }
}
