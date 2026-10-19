import { defineDocFamily } from '@earendil-works/pi-durable';
import type { Attempt, Job, JobCommandResult, JobExecution } from '../domain/job.js';

/** Product work; one family member per Job id. */
const jobDocument = (job: Job) => ({...job});

export const Jobs = defineDocFamily({
  kind: 'point.job', version: 2, scope: 'session', family: true,
  initial: (job: Job) => ({...job}),
  // v2 is a versioned shape freeze: the Job fields are already stable, so migration is the identity.
  migrate: value => value as unknown as ReturnType<typeof jobDocument>,
});

/** Execution attempts; keyed by attempt id (deterministic `${jobId}-${revision}`). */
export const Attempts = defineDocFamily({
  kind: 'point.attempt', version: 1, scope: 'session', family: true,
  initial: (attempt: Attempt) => ({...attempt}),
});

/**
 * Execution conservation authorization: keyed by the execution conversation id. The artifact tool reads it to
 * know which Job/Attempt/revision its conversation serves; a mapping is never rewritten, so an old attempt's
 * conversation can never become the new attempt's deployment path.
 */
export const JobExecutions = defineDocFamily({
  kind: 'point.job-execution', version: 1, scope: 'session', family: true,
  initial: (execution: JobExecution) => ({...execution}),
});

/** Immutable command outcome for start/amend/cancel, committed with the state change it caused. */
export type JobCommandReceipt = {
  fingerprint: string;
  result: JobCommandResult | null;
};

export const JobCommandReceipts = defineDocFamily({
  kind: 'point.command.job', version: 1, scope: 'session', family: true,
  initial: (fingerprint: string): JobCommandReceipt => ({fingerprint, result: null}),
});
