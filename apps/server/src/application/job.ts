import type { ArtifactVerification } from '../domain/artifact.js';
import {
  isArtifactIdQuery, isJobId, parseAmendJob, parseCancelJob, parseStartJob,
  type AmendJob, type AmendJobResult, type Attempt, type CancelJob, type CancelJobResult,
  type Job, type StartJob, type StartJobResult,
} from '../domain/job.js';

/**
 * A verified artifact view for the public `artifact()` query. The artifact lane owns the value shape;
 * this module only forwards what `ArtifactCommands.verify` returns.
 */
export type JobArtifactView = ArtifactVerification;

/**
 * The implementation must commit each command's receipt and every state record it causes in one transaction.
 * `start`/`amend` also create the execution conversation, execution mapping and attempt task there.
 */
export interface JobStore {
  start(command: StartJob): Promise<StartJobResult>;
  amend(command: AmendJob): Promise<AmendJobResult>;
  cancel(command: CancelJob): Promise<CancelJobResult>;
  get(jobId: string): Promise<Job | undefined>;
  /** Attempts in creation order (revision ascending). */
  attempts(jobId: string): Promise<Attempt[]>;
  artifact(artifactId: string): Promise<JobArtifactView | undefined>;
}

export interface JobCommands {
  start(input: unknown): Promise<StartJobResult>;
  amend(input: unknown): Promise<AmendJobResult>;
  cancel(input: unknown): Promise<CancelJobResult>;
  get(jobId: string): Promise<Job | undefined>;
  attempts(jobId: string): Promise<Attempt[]>;
  artifact(artifactId: string): Promise<JobArtifactView | undefined>;
}

/**
 * Application boundary: strict parsing happens before any store call, and query ids are opaque here.
 * Invalid query ids return `undefined`/`[]` without IO, matching the chat port.
 */
export function jobCommands(store: JobStore): JobCommands {
  return {
    async start(input) { return store.start(parseStartJob(input)); },
    async amend(input) { return store.amend(parseAmendJob(input)); },
    async cancel(input) { return store.cancel(parseCancelJob(input)); },
    async get(jobId) { return isJobId(jobId) ? store.get(jobId) : undefined; },
    async attempts(jobId) { return isJobId(jobId) ? store.attempts(jobId) : []; },
    async artifact(artifactId) {
      return isArtifactIdQuery(artifactId) ? store.artifact(artifactId) : undefined;
    },
  };
}
