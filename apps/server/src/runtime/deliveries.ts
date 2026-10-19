/**
 * Delivery runtime for WP1b.4.
 *
 * Two durable tasks, both created by the planning judgement commit:
 * - `point.job.report`: puts a finished Job back into its source chat by appending a
 *   display entry (`point.report`) in the same commit that closes the Delivery. It
 *   never calls a model and never invents a report.
 * - `point.job.notify`: records `attempting`, then calls the injected
 *   `NotificationPort` exactly once. The outcome is `done`/`failed`/`unknown`;
 *   nothing is retried or replayed automatically, and Job/chat are never changed.
 *
 * The factory returns the task definitions because NotifyTask needs the injected
 * port; the composition root installs `extension` and passes the tasks to
 * `tx.createTask`.
 */

import { randomUUID } from 'node:crypto';
import type { Draft } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import {
  defineTask,
  type ConversationId, type Extension, type Harness, type NextTaskState, type Task, type TaskRuntime,
} from '@earendil-works/pi-durable';
import {
  deliveryCommands, notificationAuditError, notificationResult,
  type DeliveryCommands, type DeliveryStore, type NotificationPort, type NotificationResult,
  type SessionDocumentScanner,
} from '../application/delivery.js';
import {
  DeliveryError, completeDelivery, deliveryAttemptState, failDelivery, markDeliveryUnknown,
  parseDelivery, recoverExpiredDeliveryAttempt, recoverInterruptedDeliveryAttempt, reportText,
  settleDeliveryAttempt, startDelivery, startDeliveryAttempt,
  type Delivery, type DeliveryReportInput, type DeliverySettlement, type DeliveryStatus,
} from '../domain/delivery.js';
import { Artifacts } from '../storage/artifact.js';
import { appendEvent } from './events.js';
import { Deliveries, ReportEntries } from '../storage/delivery.js';
import { Jobs } from '../storage/job.js';

export type ReportTaskInput = Readonly<{deliveryId: string}>;
export type ReportCheckpoint = Readonly<{phase: 'deliver'}>;
export type ReportTaskResult = Readonly<{
  deliveryId: string;
  status: 'done' | 'failed' | 'unknown' | 'skipped';
}>;

export type NotifyTaskInput = Readonly<{deliveryId: string}>;
export type NotifyCheckpoint = Readonly<{phase: 'send'}>;
export type NotifyTaskResult = Readonly<{
  deliveryId: string;
  /** `in-progress`: another live worker owns the attempt; this invocation wrote nothing. */
  status: 'done' | 'failed' | 'unknown' | 'skipped' | 'in-progress';
}>;

export type DeliveryRuntimeOptions = Readonly<{
  getHarness: () => Harness;
  notification?: NotificationPort;
  /** Session document scan from the composition root; absent means `list()` is empty. */
  scan?: SessionDocumentScanner;
  /** Absolute attempt deadline window for notification sends; defaults to 60s. */
  deadlineMs?: number;
}>;

export type DeliveryRuntime = Readonly<{
  commands: DeliveryCommands;
  extension: Extension;
  ReportTask: Task<ReportTaskInput, ReportCheckpoint, ReportTaskResult, object>;
  NotifyTask: Task<NotifyTaskInput, NotifyCheckpoint, NotifyTaskResult, object>;
}>;

const NOTIFICATION_TARGET = 'test';
export const DEFAULT_NOTIFICATION_DEADLINE_MS = 60_000;

type MutableDelivery = {-readonly [K in keyof Delivery]: Delivery[K]};

function applyDelivery(draft: Draft<Delivery>, value: Delivery): void {
  const target = draft as MutableDelivery;
  target.status = value.status;
  target.attempts = value.attempts;
  target.result = value.result;
  target.error = value.error;
  target.attemptToken = value.attemptToken;
  target.workerId = value.workerId;
  target.attemptStartedAt = value.attemptStartedAt;
  target.deadline = value.deadline;
  target.updatedAt = value.updatedAt;
}

/** Translate a Durable version/migration rejection into a stable delivery error. */
function incompatibleDelivery(error: unknown): never {
  if (error instanceof DeliveryError) throw error;
  if (error instanceof Error && /version|migration/i.test(error.message)) {
    throw new DeliveryError('DELIVERY_INCOMPATIBLE');
  }
  throw error;
}

function reportTerminal(deliveryId: string, status: ReportTaskResult['status']): NextTaskState<ReportCheckpoint, ReportTaskResult> {
  return {status: 'terminal', outcome: {status: 'completed', result: {deliveryId, status}}};
}

function notifyTerminal(deliveryId: string, status: NotifyTaskResult['status']): NextTaskState<NotifyCheckpoint, NotifyTaskResult> {
  return {status: 'terminal', outcome: {status: 'completed', result: {deliveryId, status}}};
}

function terminalStatus(status: DeliveryStatus): 'done' | 'failed' | 'unknown' | 'skipped' {
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'unknown') return 'unknown';
  return 'skipped';
}

/** Report/notification tasks never phone home: the report is derived from documents only. */
function reportMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{type: 'text', text}],
    api: 'point.report',
    provider: 'point',
    model: 'point.report',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: 'stop',
    timestamp,
  };
}

function sourceConversationId(sourceChatId: string): ConversationId | undefined {
  if (!/^[1-9][0-9]*$/.test(sourceChatId) || !Number.isSafeInteger(Number(sourceChatId))) return undefined;
  return Number(sourceChatId) as ConversationId;
}

function notificationText(runtime: unknown, job: Readonly<{title: string; result: string | null; artifactId: string | null}>,
  artifact: {path: string; state: string} | undefined): string {
  return reportText(artifact !== undefined && artifact.state === 'sealed'
    ? {title: job.title, result: job.result, artifactId: job.artifactId, artifactPath: artifact.path}
    : {title: job.title, result: job.result, artifactId: job.artifactId});
}

function durableDeliveryStore(getHarness: () => Harness, scan: SessionDocumentScanner | undefined): DeliveryStore {
  return {
    async load(deliveryId) {
      let document;
      try {
        document = await getHarness().snapshot(Deliveries, deliveryId, BACKGROUND_CONTEXT);
      } catch (error) {
        incompatibleDelivery(error);
      }
      return document === undefined ? undefined : parseDelivery(document);
    },

    async list(jobId) {
      if (scan === undefined) return [];
      const deliveries: Delivery[] = [];
      for (const document of await scan('point.delivery')) {
        const delivery = parseDelivery(document.value);
        // The family key is the identity; a mismatch means foreign or corrupt data.
        if (delivery === undefined || delivery.id !== document.key) continue;
        if (jobId !== undefined && delivery.jobId !== jobId) continue;
        deliveries.push(delivery);
      }
      return deliveries;
    },
  };
}

export function deliveryRuntime(options: DeliveryRuntimeOptions): DeliveryRuntime {
  const notification = options.notification;
  const deadlineMs = options.deadlineMs ?? DEFAULT_NOTIFICATION_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new DeliveryError('INVALID_COMMAND');
  const commands = deliveryCommands(durableDeliveryStore(options.getHarness, options.scan));

  async function failChatDelivery(
    runtime: TaskRuntime<ReportTaskInput, ReportCheckpoint, ReportTaskResult, object>,
    delivery: Delivery,
    error: 'job-not-current' | 'job-not-ready' | 'source-chat-missing',
  ): Promise<void> {
    await runtime.commit(async tx => {
      const draft = await tx.doc(Deliveries, delivery.id, delivery);
      if (draft.status === 'intent') {
        const failed = failDelivery(delivery, error, runtime.now());
        applyDelivery(draft, failed);
        await appendEvent(tx, {
          type: 'delivery.failed', aggregate: 'delivery', aggregateId: delivery.id,
          revision: delivery.revision, at: failed.updatedAt, data: {channel: 'chat', error},
        });
      }
      return reportTerminal(delivery.id, 'failed');
    }, BACKGROUND_CONTEXT);
  }

  async function deliverChatReport(
    runtime: TaskRuntime<ReportTaskInput, ReportCheckpoint, ReportTaskResult, object>,
    delivery: Delivery,
  ): Promise<void> {
    const job = await runtime.snapshot(Jobs, delivery.jobId, BACKGROUND_CONTEXT);
    if (job === undefined || job.status === 'cancelled' || job.revision !== delivery.revision) {
      await failChatDelivery(runtime, delivery, 'job-not-current');
      return;
    }
    // Only a finished Job may be reported; running/queued/failed Jobs never claim success.
    if (job.status !== 'ready') {
      await failChatDelivery(runtime, delivery, 'job-not-ready');
      return;
    }
    const conversationId = sourceConversationId(job.sourceChatId);
    const conversation = conversationId === undefined ? undefined : await runtime.conversation(conversationId, BACKGROUND_CONTEXT);
    if (conversationId === undefined || conversation === undefined) {
      await failChatDelivery(runtime, delivery, 'source-chat-missing');
      return;
    }
    const artifact = job.artifactId === null ? undefined : await runtime.snapshot(Artifacts, job.artifactId, BACKGROUND_CONTEXT);
    const text = reportText(artifact !== undefined && artifact.state === 'sealed'
      ? {title: job.title, result: job.result, artifactId: job.artifactId, artifactPath: artifact.path}
      : {title: job.title, result: job.result, artifactId: job.artifactId});
    const timestamp = runtime.now();
    await runtime.commit(async tx => {
      const draft = await tx.doc(Deliveries, delivery.id, delivery);
      if (draft.status !== 'intent') return reportTerminal(delivery.id, terminalStatus(draft.status));
      const done = completeDelivery(startDelivery(delivery, timestamp), 'delivered', timestamp);
      applyDelivery(draft, done);
      await appendEvent(tx, {
        type: 'delivery.done', aggregate: 'delivery', aggregateId: delivery.id,
        revision: delivery.revision, at: timestamp, data: {channel: 'chat', jobId: job.id},
      });
      await tx.appendEntry(ReportEntries, conversationId, {
        data: {jobId: job.id, deliveryId: delivery.id, occurrenceIds: [...delivery.occurrenceIds]},
        model: [reportMessage(text, timestamp)],
      });
      return reportTerminal(delivery.id, 'done');
    }, BACKGROUND_CONTEXT);
  }

  async function failNotifyDelivery(
    runtime: TaskRuntime<NotifyTaskInput, NotifyCheckpoint, NotifyTaskResult, object>,
    delivery: Delivery,
    error: 'job-not-current' | 'job-not-ready' | 'NOTIFICATION_NOT_CONFIGURED',
  ): Promise<void> {
    await runtime.commit(async tx => {
      const draft = await tx.doc(Deliveries, delivery.id, delivery);
      if (draft.status === 'intent') {
        const failed = failDelivery(delivery, error, runtime.now());
        applyDelivery(draft, failed);
        await appendEvent(tx, {
          type: 'delivery.failed', aggregate: 'delivery', aggregateId: delivery.id,
          revision: delivery.revision, at: failed.updatedAt, data: {channel: 'notification', error},
        });
      }
      return notifyTerminal(delivery.id, 'failed');
    }, BACKGROUND_CONTEXT);
  }

  async function deliverNotification(
    runtime: TaskRuntime<NotifyTaskInput, NotifyCheckpoint, NotifyTaskResult, object>,
    delivery: Delivery,
  ): Promise<void> {
    const workerId = String(runtime.taskId);
    if (notification === undefined) {
      await failNotifyDelivery(runtime, delivery, 'NOTIFICATION_NOT_CONFIGURED');
      return;
    }
    const job = await runtime.snapshot(Jobs, delivery.jobId, BACKGROUND_CONTEXT);
    if (job === undefined || job.status === 'cancelled' || job.revision !== delivery.revision) {
      await failNotifyDelivery(runtime, delivery, 'job-not-current');
      return;
    }
    // Same ready gate as the report path: only a finished Job may notify.
    if (job.status !== 'ready') {
      await failNotifyDelivery(runtime, delivery, 'job-not-ready');
      return;
    }
    const artifact = job.artifactId === null ? undefined : await runtime.snapshot(Artifacts, job.artifactId, BACKGROUND_CONTEXT);
    const text = notificationText(runtime, job, artifact);

    const phase: {value: 'active' | 'in-progress' | 'terminal'} = {value: 'terminal'};
    let attemptToken = '';
    let deadline = 0;
    // Admission (P0-3): a live in-flight attempt belongs to another worker and is left untouched;
    // the same Durable task resuming proves its previous invocation dead; only an expired attempt is
    // recovered explicitly. All of it happens in one CAS commit before any external call.
    await runtime.commit(async tx => {
      const now = runtime.now();
      const draft = await tx.doc(Deliveries, delivery.id, delivery);
      if (draft.status === 'attempting') {
        if (draft.workerId === workerId) {
          const recovered = recoverInterruptedDeliveryAttempt(draft, {now, reason: 'interrupted'});
          applyDelivery(draft, recovered);
          await appendEvent(tx, {
            type: 'delivery.unknown', aggregate: 'delivery', aggregateId: delivery.id,
            revision: delivery.revision, at: now, data: {channel: 'notification', error: 'interrupted'},
          });
          phase.value = 'terminal';
          return notifyTerminal(delivery.id, 'unknown');
        }
        // An attempting record without a proven worker/token/deadline cannot be attributed to a live
        // worker; it is treated as an interrupted legacy attempt, never replayed.
        if (draft.attemptToken === null || draft.workerId === null || draft.deadline === null) {
          const recovered = recoverInterruptedDeliveryAttempt(draft, {now, reason: 'interrupted'});
          applyDelivery(draft, recovered);
          await appendEvent(tx, {
            type: 'delivery.unknown', aggregate: 'delivery', aggregateId: delivery.id,
            revision: delivery.revision, at: now, data: {channel: 'notification', error: 'interrupted'},
          });
          phase.value = 'terminal';
          return notifyTerminal(delivery.id, 'unknown');
        }
        if (deliveryAttemptState(draft, now) === 'expired') {
          const recovered = recoverExpiredDeliveryAttempt(draft, {now, reason: 'attempt-deadline-expired'});
          applyDelivery(draft, recovered);
          await appendEvent(tx, {
            type: 'delivery.unknown', aggregate: 'delivery', aggregateId: delivery.id,
            revision: delivery.revision, at: now, data: {channel: 'notification', error: 'attempt-deadline-expired'},
          });
          phase.value = 'terminal';
          return notifyTerminal(delivery.id, 'unknown');
        }
        phase.value = 'in-progress';
        return notifyTerminal(delivery.id, 'in-progress');
      }
      if (draft.status !== 'intent') {
        phase.value = 'terminal';
        return notifyTerminal(delivery.id, terminalStatus(draft.status));
      }
      attemptToken = randomUUID();
      deadline = now + deadlineMs;
      applyDelivery(draft, startDeliveryAttempt(draft, {
        token: attemptToken, workerId, startedAt: now, deadline,
      }));
      phase.value = 'active';
      return undefined;
    }, BACKGROUND_CONTEXT);
    if (phase.value !== 'active') return;

    let result: NotificationResult;
    try {
      result = notificationResult(await notification.send({
        deliveryId: delivery.id,
        target: NOTIFICATION_TARGET,
        title: job.title,
        text,
      }));
    } catch {
      // A thrown call cannot confirm delivery: conservative `unknown`, never a retry. Kept as the
      // legacy plain outcome so existing audit strings stay stable.
      result = {outcome: 'unknown'};
    }
    const settlement: DeliverySettlement = result.outcome === 'delivered'
      ? {status: 'done', result: 'delivered'}
      : result.outcome === 'failed'
        ? {status: 'failed', error: notificationAuditError(result, 'notification-failed')}
        : {status: 'unknown', error: notificationAuditError(result, 'notification-unknown')};

    await runtime.commit(async tx => {
      const now = runtime.now();
      const draft = await tx.doc(Deliveries, delivery.id, delivery);
      // Token CAS: another winner (recovery or concurrent worker) must never be overwritten.
      if (draft.status !== 'attempting' || draft.attemptToken !== attemptToken) {
        return notifyTerminal(delivery.id, terminalStatus(draft.status));
      }
      const deadlineAt = draft.deadline ?? deadline;
      if (now >= deadlineAt) {
        // A late outcome after the deadline is never turned into success.
        const recovered = recoverExpiredDeliveryAttempt(draft, {now, reason: 'attempt-deadline-expired'});
        applyDelivery(draft, recovered);
        await appendEvent(tx, {
          type: 'delivery.unknown', aggregate: 'delivery', aggregateId: delivery.id,
          revision: delivery.revision, at: now, data: {channel: 'notification', error: 'attempt-deadline-expired'},
        });
        return notifyTerminal(delivery.id, 'unknown');
      }
      const settled = settleDeliveryAttempt(draft, settlement, {token: attemptToken, now});
      applyDelivery(draft, settled);
      await appendEvent(tx, {
        type: settled.status === 'done' ? 'delivery.done'
          : settled.status === 'failed' ? 'delivery.failed' : 'delivery.unknown',
        aggregate: 'delivery', aggregateId: delivery.id, revision: delivery.revision, at: now,
        data: {channel: 'notification', error: settled.status === 'done' ? null : settled.error},
      });
      return notifyTerminal(delivery.id, terminalStatus(settled.status));
    }, BACKGROUND_CONTEXT);
  }

  const ReportTask = defineTask<ReportTaskInput, ReportCheckpoint, ReportTaskResult, object>({
    name: 'point.job.report', version: 1,
    initial: () => ({phase: 'deliver'}),
    phases: {
      async deliver(task, runtime) {
        const deliveryId = task.input.deliveryId;
        const delivery = await runtime.snapshot(Deliveries, deliveryId, BACKGROUND_CONTEXT);
        // Missing delivery or one already terminal/moved on: idempotent terminal, no chat write.
        if (delivery === undefined || delivery.channel !== 'chat') {
          await runtime.commit(() => reportTerminal(deliveryId, 'skipped'), BACKGROUND_CONTEXT);
          return;
        }
        if (delivery.status !== 'intent') {
          await runtime.commit(() => reportTerminal(deliveryId, terminalStatus(delivery.status)), BACKGROUND_CONTEXT);
          return;
        }
        await deliverChatReport(runtime, delivery);
      },
    },
    async abort(_task, runtime) {
      await runtime.commit(() => ({status: 'terminal', outcome: {status: 'aborted'}}), BACKGROUND_CONTEXT);
    },
  });

  const NotifyTask = defineTask<NotifyTaskInput, NotifyCheckpoint, NotifyTaskResult, object>({
    name: 'point.job.notify', version: 1,
    initial: () => ({phase: 'send'}),
    phases: {
      async send(task, runtime) {
        const deliveryId = task.input.deliveryId;
        const delivery = await runtime.snapshot(Deliveries, deliveryId, BACKGROUND_CONTEXT);
        if (delivery === undefined || delivery.channel !== 'notification') {
          await runtime.commit(() => notifyTerminal(deliveryId, 'skipped'), BACKGROUND_CONTEXT);
          return;
        }
        // A delivery that is already done/failed/unknown is terminal and is never resent.
        if (delivery.status !== 'intent' && delivery.status !== 'attempting') {
          await runtime.commit(() => notifyTerminal(deliveryId, terminalStatus(delivery.status)), BACKGROUND_CONTEXT);
          return;
        }
        await deliverNotification(runtime, delivery);
      },
    },
    async abort(_task, runtime) {
      await runtime.commit(() => ({status: 'terminal', outcome: {status: 'aborted'}}), BACKGROUND_CONTEXT);
    },
  });

  return {
    commands,
    extension: {name: 'point.deliveries', tasks: [ReportTask, NotifyTask]} satisfies Extension,
    ReportTask,
    NotifyTask,
  };
}
