import type { Delivery } from '../domain/delivery.js';
import {
  isFollowupJobId, isScheduleId, parseCancelFollowup, parseScheduleFollowup,
  type CancelFollowup, type CancelFollowupResult, type Decision, type Occurrence,
  type Schedule, type ScheduleFollowup, type ScheduleFollowupResult,
} from '../domain/schedule.js';

/**
 * The implementation must commit each command's receipt and every record it causes in one transaction;
 * `schedule` also creates the follow-up task. Cancelling never changes the Job.
 */
export interface ScheduleStore {
  schedule(command: ScheduleFollowup): Promise<ScheduleFollowupResult>;
  cancel(command: CancelFollowup): Promise<CancelFollowupResult>;
  get(scheduleId: string): Promise<Schedule | undefined>;
  occurrences(scheduleId: string): Promise<Occurrence[]>;
  decisions(jobId?: string): Promise<Decision[]>;
  deliveries(jobId?: string): Promise<Delivery[]>;
  /** Optional test convenience: wait for the live follow-up task of a schedule to settle. */
  wait?(scheduleId: string): Promise<Schedule | undefined>;
}

export interface FollowupCommands {
  schedule(input: unknown): Promise<ScheduleFollowupResult>;
  cancel(input: unknown): Promise<CancelFollowupResult>;
  get(scheduleId: string): Promise<Schedule | undefined>;
  occurrences(scheduleId: string): Promise<Occurrence[]>;
  decisions(jobId?: string): Promise<Decision[]>;
  deliveries(jobId?: string): Promise<Delivery[]>;
  wait?(scheduleId: string): Promise<Schedule | undefined>;
}

/** Application boundary: strict parsing before any store call; invalid query ids do no IO. */
export function followupCommands(store: ScheduleStore): FollowupCommands {
  return {
    async schedule(input) { return store.schedule(parseScheduleFollowup(input)); },
    async cancel(input) { return store.cancel(parseCancelFollowup(input)); },
    async get(scheduleId) { return isScheduleId(scheduleId) ? store.get(scheduleId) : undefined; },
    async occurrences(scheduleId) { return isScheduleId(scheduleId) ? store.occurrences(scheduleId) : []; },
    async decisions(jobId) {
      if (jobId !== undefined && !isFollowupJobId(jobId)) return [];
      return store.decisions(jobId);
    },
    async deliveries(jobId) {
      if (jobId !== undefined && !isFollowupJobId(jobId)) return [];
      return store.deliveries(jobId);
    },
    ...(store.wait === undefined ? {} : {
      async wait(scheduleId: string) {
        return isScheduleId(scheduleId) ? store.wait!(scheduleId) : undefined;
      },
    }),
  };
}
