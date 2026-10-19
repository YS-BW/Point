import { createHash, randomUUID } from 'node:crypto';
import type { Context, Draft } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  defineTask, type ConversationId, type Extension, type Harness, type NextTaskState,
  type TaskId, type TaskRuntime, type Tx,
} from '@earendil-works/pi-durable';
import type { DeliveryCommands } from '../application/delivery.js';
import type { Delivery } from '../domain/delivery.js';
import type { FollowupCommands, ScheduleStore } from '../application/schedule.js';
import { followupCommands } from '../application/schedule.js';
import { initialDelivery } from '../domain/delivery.js';
import type { Job } from '../domain/job.js';
import {
  canTransitionOccurrence, canTransitionSchedule, createOccurrences, evaluateFollowup,
  FOLLOWUP_POLICY, isOccurrenceIdFor, ScheduleError,
  type CancelFollowupResult, type Decision, type Occurrence, type Schedule,
  type ScheduleFollowupResult, type ScheduleStatus,
} from '../domain/schedule.js';
import { Deliveries } from '../storage/delivery.js';
import { Jobs } from '../storage/job.js';
import {
  Decisions, FollowupCommandReceipts, Occurrences, ScheduleHeads, Schedules,
} from '../storage/schedule.js';
import type { deliveryRuntime } from './deliveries.js';
import { appendEvent } from './events.js';
import { indexReceipt } from './state-index.js';

/**
 * Read-only session document scan supplied by the composition root. The Harness/Session API has no
 * document scan, so list queries (`decisions(jobId?)` and the delivery list) need this wired port.
 */
export type SessionDocumentScanner = (kind: string) => Promise<ReadonlyArray<{
  key: string;
  value: Readonly<Record<string, unknown>>;
}>>;

type DeliveryRuntime = ReturnType<typeof deliveryRuntime>;

export type FollowupRuntimeOptions = Readonly<{
  getHarness: () => Harness;
  /** `deliveries(jobId?)` is delegated to the delivery lane's commands. */
  deliveries: DeliveryCommands;
  scan: SessionDocumentScanner;
  /** Task tokens returned by `deliveryRuntime` (NotifyTask needs its injected notification port). */
  deliveryTasks: Pick<DeliveryRuntime, 'ReportTask' | 'NotifyTask'>;
}>;

type FollowupInput = Readonly<{scheduleId: string}>;
type FollowupCheckpoint = {phase: 'run'};
type FollowupResult = Readonly<{scheduleId: string; status: Extract<ScheduleStatus, 'done' | 'cancelled'>}>;
type FollowupTaskRuntime = TaskRuntime<FollowupInput, FollowupCheckpoint, FollowupResult, object>;

function completed(result: FollowupResult): NextTaskState<FollowupCheckpoint, FollowupResult> {
  return {status: 'terminal', outcome: {status: 'completed', result}};
}
function aborted(reason: string): NextTaskState<FollowupCheckpoint, FollowupResult> {
  return {status: 'terminal', outcome: {status: 'aborted', reason}};
}

function fingerprint(command: object): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function copySchedule(schedule: Readonly<Schedule>): Schedule {
  return {...schedule, occurrenceIds: [...schedule.occurrenceIds]};
}
function copyOccurrence(occurrence: Readonly<Occurrence>): Occurrence {
  return {...occurrence};
}
function copyDecision(decision: Readonly<Decision>): Decision {
  return {...decision, occurrenceIds: [...decision.occurrenceIds]};
}
function copyDelivery(delivery: Readonly<Delivery>): Delivery {
  return {...delivery, occurrenceIds: [...delivery.occurrenceIds]};
}
function copyJob(job: Readonly<Job>): Job {
  return {...job, requirements: [...job.requirements]};
}

function compareIds(a: Readonly<{id: string}>, b: Readonly<{id: string}>): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Structural guard for scanned decision documents; unknown shapes are ignored, not trusted. */
function decisionFromValue(value: Readonly<Record<string, unknown>>): Decision | undefined {
  const {id, scheduleId, jobId, revision, occurrenceIds, choice, reason, policy, createdAt} = value;
  if (typeof id !== 'string' || typeof scheduleId !== 'string' || typeof jobId !== 'string'
    || typeof revision !== 'number' || typeof choice !== 'string' || typeof reason !== 'string'
    || policy !== FOLLOWUP_POLICY || typeof createdAt !== 'number'
    || !Array.isArray(occurrenceIds) || occurrenceIds.some(item => typeof item !== 'string')) {
    return undefined;
  }
  if (choice !== 'deliver' && choice !== 'skip') return undefined;
  return {
    id, scheduleId, jobId, revision, choice, reason, policy: FOLLOWUP_POLICY, createdAt,
    occurrenceIds: occurrenceIds as string[],
  };
}

/** Live follow-up task of one schedule, if any. Cancellation aborts it; the task itself still fences. */
async function findLiveFollowupTask(harness: Harness, scheduleId: string): Promise<TaskId | undefined> {
  const inspection = await harness.inspect(context);
  for (const item of inspection.tasks) {
    const record = item.record;
    if (record.kind !== 'point.job.followup') continue;
    const input = record.input as {scheduleId?: unknown};
    if (input.scheduleId === scheduleId) return record.id as TaskId;
  }
  return undefined;
}

/**
 * Single-shot follow-up plans: `point.job.followup` task and the schedule/cancel/get/occurrences/
 * decisions/deliveries commands (plan-and-delivery.md §2-§4).
 *
 * The task waits on absolute times (`runtime.sleep`), re-reads all state after every wake, merges all
 * missed windows into one auditable Decision, and creates delivery intents and tasks in the same commit.
 * Cancellation only stops future deliveries; it never invents success.
 */
export function followupRuntime(options: FollowupRuntimeOptions) {
  const {getHarness, scan, deliveries, deliveryTasks} = options;

  async function readOccurrences(
    runtime: FollowupTaskRuntime, schedule: Readonly<Schedule>, ctx: Context,
  ): Promise<Occurrence[]> {
    const items: Occurrence[] = [];
    for (const id of schedule.occurrenceIds) {
      const occurrence = await runtime.snapshot(Occurrences, id, ctx);
      if (!occurrence) continue;
      if (!isOccurrenceIdFor(occurrence.id, schedule.id, occurrence.index)) continue;
      items.push(copyOccurrence(occurrence));
    }
    return items.sort((a, b) => a.dueAt - b.dueAt || a.index - b.index);
  }

  const FollowupTask = defineTask<FollowupInput, FollowupCheckpoint, FollowupResult>({
    name: 'point.job.followup', version: 1, initial: () => ({phase: 'run'}),
    phases: {
      /**
       * One durable loop: re-read schedule, sleep until the earliest absolute due time, merge every due
       * pending occurrence into one batch, judge against the current Job, and commit the decision,
       * occurrence states, delivery intents and delivery tasks atomically. With no pending occurrence the
       * schedule is marked done and the task settles.
       */
      async run(task, runtime, ctx) {
        for (;;) {
          if (runtime.signal.aborted) return;
          const schedule = await runtime.snapshot(Schedules, task.input.scheduleId, ctx);
          if (!schedule) {
            await runtime.commit(() => completed({scheduleId: task.input.scheduleId, status: 'done'}), ctx);
            return;
          }
          if (schedule.status !== 'active') {
            await runtime.commit(() => aborted(schedule.status === 'cancelled' ? 'cancelled' : 'done'), ctx);
            return;
          }
          const occurrences = await readOccurrences(runtime, schedule, ctx);
          const pending = occurrences.filter(occurrence => occurrence.state === 'pending');
          if (pending.length === 0) {
            await runtime.commit(async tx => {
              const draft = await tx.doc(Schedules, schedule.id, copySchedule(schedule));
              if (draft.status === 'active') {
                draft.status = 'done';
                draft.updatedAt = runtime.now();
              }
              return completed({scheduleId: draft.id, status: 'done'});
            }, ctx);
            return;
          }
          const earliest = pending[0]!;
          if (earliest.dueAt > runtime.now()) {
            try {
              // Absolute wait: recovery never shifts the plan to "now + interval".
              await runtime.sleep(earliest.dueAt, ctx);
            } catch (error) {
              if (runtime.signal.aborted) return;
              throw error;
            }
            continue;
          }

          const now = runtime.now();
          const current = await runtime.snapshot(Schedules, schedule.id, ctx);
          if (!current || current.status !== 'active') {
            await runtime.commit(() => aborted('cancelled'), ctx);
            return;
          }
          const currentOccurrences = await readOccurrences(runtime, current, ctx);
          const batch = currentOccurrences.filter(occurrence => occurrence.state === 'pending' && occurrence.dueAt <= now);
          if (batch.length === 0) continue;
          const occurrenceById = new Map(currentOccurrences.map(occurrence => [occurrence.id, occurrence] as const));
          const job = await runtime.snapshot(Jobs, current.jobId, ctx);

          let settled = false;
          await runtime.commit(async tx => {
            // Fence on the committed schedule and Job: a cancel or amendment that landed after the
            // snapshots still wins, and no delivery intent is created for a stale plan.
            const scheduleDraft = await tx.doc(Schedules, current.id, copySchedule(current));
            if (scheduleDraft.status !== 'active') {
              settled = true;
              return aborted('cancelled');
            }
            const batchIds = new Set(batch.map(occurrence => occurrence.id));
            const drafts: Draft<Occurrence>[] = [];
            let deliveredCount = 0;
            let pendingOutsideBatch = 0;
            for (const id of scheduleDraft.occurrenceIds) {
              const seed = occurrenceById.get(id);
              if (!seed) continue;
              const draft = await tx.doc(Occurrences, id, copyOccurrence(seed));
              if (draft.state === 'delivered') deliveredCount += 1;
              if (batchIds.has(id) && draft.state === 'pending') drafts.push(draft);
              else if (draft.state === 'pending') pendingOutsideBatch += 1;
            }
            if (drafts.length === 0) return {status: 'running', checkpoint: {phase: 'run'}};

            const jobDraft = job ? await tx.doc(Jobs, job.id, copyJob(job)) : undefined;
            const evaluation = evaluateFollowup({
              job: jobDraft ? {status: jobDraft.status, revision: jobDraft.revision} : undefined,
              scheduleRevision: scheduleDraft.revision,
              deliveredCount,
              batchSize: drafts.length,
            });

            // One immutable audit record for the whole merged batch.
            const decision: Decision = {
              id: randomUUID(),
              scheduleId: scheduleDraft.id,
              jobId: scheduleDraft.jobId,
              revision: scheduleDraft.revision,
              occurrenceIds: drafts.map(draft => draft.id),
              choice: evaluation.choice,
              reason: evaluation.reason,
              policy: FOLLOWUP_POLICY,
              createdAt: now,
            };
            await tx.doc(Decisions, decision.id, copyDecision(decision));
            await appendEvent(tx, {
              type: 'followup.decided', aggregate: 'schedule', aggregateId: scheduleDraft.id,
              revision: scheduleDraft.revision, at: now,
              data: {choice: evaluation.choice, reason: evaluation.reason, occurrences: decision.occurrenceIds.length},
            });

            for (const draft of drafts) {
              draft.state = evaluation.choice === 'deliver' ? 'delivered' : 'skipped';
              draft.reason = evaluation.choice === 'deliver' ? null : evaluation.reason;
            }

            if (evaluation.choice === 'deliver') {
              const occurrenceIds = drafts.map(draft => draft.id);
              const chat = initialDelivery({
                id: randomUUID(), jobId: scheduleDraft.jobId, scheduleId: scheduleDraft.id,
                occurrenceIds, revision: scheduleDraft.revision, channel: 'chat', createdAt: now,
              });
              const notification = initialDelivery({
                id: randomUUID(), jobId: scheduleDraft.jobId, scheduleId: scheduleDraft.id,
                occurrenceIds, revision: scheduleDraft.revision, channel: 'notification', createdAt: now,
              });
              await tx.doc(Deliveries, chat.id, copyDelivery(chat));
              await tx.doc(Deliveries, notification.id, copyDelivery(notification));
              for (const delivery of [chat, notification]) {
                await appendEvent(tx, {
                  type: 'delivery.intent', aggregate: 'delivery', aggregateId: delivery.id,
                  revision: delivery.revision, at: now,
                  data: {channel: delivery.channel, jobId: delivery.jobId},
                });
              }
              const taskOptions = {
                conversationId: Number(scheduleDraft.sourceChatId) as ConversationId,
                ownership: {kind: 'conversation' as const},
                background: true,
              };
              await tx.createTask(deliveryTasks.ReportTask, {deliveryId: chat.id}, taskOptions);
              await tx.createTask(deliveryTasks.NotifyTask, {deliveryId: notification.id}, taskOptions);
            }

            if (pendingOutsideBatch === 0) {
              scheduleDraft.status = 'done';
              scheduleDraft.updatedAt = now;
              settled = true;
              return completed({scheduleId: scheduleDraft.id, status: 'done'});
            }
            scheduleDraft.updatedAt = now;
            return {status: 'running', checkpoint: {phase: 'run'}};
          }, ctx);
          if (settled) return;
        }
      },
    },
    /** Cancellation settles the task without creating any delivery; external effects are never undone. */
    async abort(_task, runtime, ctx) {
      await runtime.commit(() => aborted('cancelled'), ctx);
    },
  });

  const store: ScheduleStore = {
    async schedule(command) {
      const h = getHarness();
      const job = await h.snapshot(Jobs, command.jobId, context);
      if (!job) throw new ScheduleError('JOB_NOT_FOUND');
      // Delivery facts live on the Job: an explicit sourceChatId may only restate it, never diverge.
      if (command.sourceChatId !== undefined && command.sourceChatId !== job.sourceChatId) {
        throw new ScheduleError('INVALID_COMMAND');
      }
      const sourceChatId = job.sourceChatId;
      const commandFingerprint = fingerprint(command);
      const computed = await h.commit(async tx => {
        const receipt = await tx.doc(FollowupCommandReceipts,
          `schedule:${command.jobId}:${command.requestId}`, commandFingerprint);
        if (receipt.fingerprint !== commandFingerprint) throw new ScheduleError('IDEMPOTENCY_CONFLICT');
        if (receipt.result) {
          // Copy array fields out of the Chord overlay: with the commit settled they are no longer readable.
          const stored = receipt.result as ScheduleFollowupResult;
          return {scheduleId: stored.scheduleId, occurrenceIds: [...stored.occurrenceIds]};
        }
        const jobDraft = await tx.doc(Jobs, command.jobId, copyJob(job));
        if (jobDraft.status === 'cancelled') throw new ScheduleError('JOB_TERMINAL');
        if (jobDraft.revision !== command.expectedRevision) throw new ScheduleError('REVISION_MISMATCH');
        if (jobDraft.status !== 'ready') throw new ScheduleError('JOB_NOT_READY');
        // One current schedule per (jobId, revision): an active or done one blocks a second schedule;
        // only a cancelled one may be replaced, so the two-reminder cap cannot be bypassed.
        const headKey = `${command.jobId}:${jobDraft.revision}`;
        const head = await tx.doc(ScheduleHeads, headKey, {scheduleId: ''});
        if (head.scheduleId !== '') {
          const placeholder: Schedule = {
            id: head.scheduleId, jobId: command.jobId, revision: jobDraft.revision, sourceChatId,
            status: 'active', occurrenceIds: [], createdAt: 0, updatedAt: 0,
          };
          const existing = await tx.doc(Schedules, head.scheduleId, placeholder);
          if (existing.status !== 'cancelled') throw new ScheduleError('SCHEDULE_EXISTS');
        }
        const now = Date.now();
        const scheduleId = randomUUID();
        const occurrences = createOccurrences(scheduleId, command.jobId, jobDraft.revision,
          command.advanceAt === undefined
            ? {dueAt: command.dueAt}
            : {dueAt: command.dueAt, advanceAt: command.advanceAt});
        const schedule: Schedule = {
          id: scheduleId, jobId: command.jobId, revision: jobDraft.revision, sourceChatId,
          status: 'active', occurrenceIds: occurrences.map(occurrence => occurrence.id),
          createdAt: now, updatedAt: now,
        };
        await tx.doc(Schedules, scheduleId, copySchedule(schedule));
        for (const occurrence of occurrences) {
          await tx.doc(Occurrences, occurrence.id, copyOccurrence(occurrence));
        }
        await tx.createTask(FollowupTask, {scheduleId}, {
          conversationId: Number(sourceChatId) as ConversationId,
          ownership: {kind: 'conversation'},
          background: true,
        });
        head.scheduleId = scheduleId;
        await appendEvent(tx, {
          type: 'schedule.created', aggregate: 'schedule', aggregateId: scheduleId,
          revision: schedule.revision, at: now,
          data: {jobId: schedule.jobId, occurrences: schedule.occurrenceIds.length},
        });
        await indexReceipt(tx, {
          family: 'point.command.followup', receiptKey: `schedule:${command.jobId}:${command.requestId}`,
          referencedId: scheduleId, terminal: false, createdAt: now,
        });
        const result: ScheduleFollowupResult = {scheduleId, occurrenceIds: [...schedule.occurrenceIds]};
        receipt.result = result;
        return {scheduleId: result.scheduleId, occurrenceIds: [...result.occurrenceIds]};
      }, context);
      h.resume();
      return computed;
    },

    async cancel(command) {
      const h = getHarness();
      const current = await h.snapshot(Schedules, command.scheduleId, context);
      if (!current) throw new ScheduleError('SCHEDULE_NOT_FOUND');
      const seeds = new Map<string, Occurrence>();
      for (const id of current.occurrenceIds) {
        const occurrence = await h.snapshot(Occurrences, id, context);
        if (occurrence) seeds.set(id, copyOccurrence(occurrence));
      }
      const commandFingerprint = fingerprint(command);
      const computed = await h.commit(async tx => {
        const receipt = await tx.doc(FollowupCommandReceipts,
          `cancel:${command.scheduleId}:${command.requestId}`, commandFingerprint);
        if (receipt.fingerprint !== commandFingerprint) throw new ScheduleError('IDEMPOTENCY_CONFLICT');
        if (receipt.result) {
          const stored = receipt.result as CancelFollowupResult;
          return {scheduleId: stored.scheduleId, status: stored.status};
        }
        const schedule = await tx.doc(Schedules, command.scheduleId, copySchedule(current));
        const now = Date.now();
        const cancelledNow = canTransitionSchedule(schedule.status, 'cancelled');
        if (cancelledNow) {
          schedule.status = 'cancelled';
          schedule.updatedAt = now;
          for (const id of schedule.occurrenceIds) {
            const seed = seeds.get(id);
            if (!seed) continue;
            const occurrence = await tx.doc(Occurrences, id, copyOccurrence(seed));
            if (canTransitionOccurrence(occurrence.state, 'skipped')) {
              occurrence.state = 'skipped';
              occurrence.reason = 'cancelled';
            }
          }
        }
        if (cancelledNow) {
          await appendEvent(tx, {
            type: 'schedule.cancelled', aggregate: 'schedule', aggregateId: schedule.id,
            revision: schedule.revision, at: now, data: {jobId: schedule.jobId},
          });
        }
        await indexReceipt(tx, {
          family: 'point.command.followup', receiptKey: `cancel:${command.scheduleId}:${command.requestId}`,
          referencedId: schedule.id, terminal: true, createdAt: now,
        });
        const result: CancelFollowupResult = {scheduleId: schedule.id, status: schedule.status};
        receipt.result = result;
        return {scheduleId: result.scheduleId, status: result.status};
      }, context);
      h.resume();
      const taskId = await findLiveFollowupTask(h, command.scheduleId);
      if (taskId !== undefined) await h.abortTask(taskId, context).catch(() => {});
      return computed;
    },

    async get(scheduleId) {
      const schedule = await getHarness().snapshot(Schedules, scheduleId, context);
      return schedule ? copySchedule(schedule) : undefined;
    },

    async occurrences(scheduleId) {
      const h = getHarness();
      const schedule = await h.snapshot(Schedules, scheduleId, context);
      if (!schedule) return [];
      const items: Occurrence[] = [];
      for (const id of schedule.occurrenceIds) {
        const occurrence = await h.snapshot(Occurrences, id, context);
        if (!occurrence) continue;
        if (!isOccurrenceIdFor(occurrence.id, schedule.id, occurrence.index)) continue;
        items.push(copyOccurrence(occurrence));
      }
      return items.sort((a, b) => a.index - b.index || a.dueAt - b.dueAt);
    },

    async decisions(jobId) {
      const documents = await scan('point.decision');
      const items: Decision[] = [];
      for (const document of documents) {
        const decision = decisionFromValue(document.value);
        if (!decision) continue;
        if (jobId !== undefined && decision.jobId !== jobId) continue;
        items.push(decision);
      }
      return items.sort((a, b) => a.createdAt - b.createdAt || compareIds(a, b));
    },

    async deliveries(jobId) {
      return deliveries.list(jobId);
    },

    async wait(scheduleId) {
      const h = getHarness();
      const taskId = await findLiveFollowupTask(h, scheduleId);
      if (taskId !== undefined) await h.waitForTask(taskId, context).catch(() => undefined);
      return store.get(scheduleId);
    },
  };

  const commands: FollowupCommands = followupCommands(store);
  return {commands, extension: {name: 'point.followups', tasks: [FollowupTask]} satisfies Extension};
}
