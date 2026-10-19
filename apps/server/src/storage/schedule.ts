import { defineDocFamily } from '@earendil-works/pi-durable';
import type {
  Decision, FollowupCommandResult, Occurrence, Schedule,
} from '../domain/schedule.js';

/**
 * One current schedule per `(jobId, revision)`: key `${jobId}:${revision}`. The head is replaced only
 * after that schedule is cancelled, so multiple schedules can never bypass the two-reminder cap.
 */
export type ScheduleHead = {scheduleId: string};

export const ScheduleHeads = defineDocFamily({
  kind: 'point.schedule-head', version: 1, scope: 'session', family: true,
  initial: (head: ScheduleHead): ScheduleHead => ({scheduleId: head.scheduleId}),
});

/** One single-shot follow-up plan for one Job revision. */
export const Schedules = defineDocFamily({
  kind: 'point.schedule', version: 1, scope: 'session', family: true,
  initial: (schedule: Schedule) => ({...schedule, occurrenceIds: [...schedule.occurrenceIds]}),
});

/** The absolute reminder windows of a schedule; keyed by deterministic occurrence id. */
export const Occurrences = defineDocFamily({
  kind: 'point.occurrence', version: 1, scope: 'session', family: true,
  initial: (occurrence: Occurrence) => ({...occurrence}),
});

/** Immutable audit record of one policy decision (one per merged wake batch). */
export const Decisions = defineDocFamily({
  kind: 'point.decision', version: 1, scope: 'session', family: true,
  initial: (decision: Decision) => ({...decision, occurrenceIds: [...decision.occurrenceIds]}),
});

/** Immutable command outcome for schedule/cancel, committed with the state it caused. */
export type FollowupCommandReceipt = {
  fingerprint: string;
  result: FollowupCommandResult | null;
};

export const FollowupCommandReceipts = defineDocFamily({
  kind: 'point.command.followup', version: 1, scope: 'session', family: true,
  initial: (fingerprint: string): FollowupCommandReceipt => ({fingerprint, result: null}),
});
