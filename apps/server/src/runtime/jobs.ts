import { createHash, randomUUID } from 'node:crypto';
import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  AssistantEntry, configure, defineTask,
  type ConversationId, type Extension, type Harness, type ModelRef, type NextTaskState,
  type SettledSubmissionRecord, type TaskId, type TaskRuntime, type ToolRegistration, type Tx,
} from '@earendil-works/pi-durable';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import type { JobArtifactView, JobCommands, JobStore } from '../application/job.js';
import { jobCommands } from '../application/job.js';
import { Chats } from '../storage/chats.js';
import { Attempts, JobCommandReceipts, JobExecutions, Jobs } from '../storage/job.js';
import {
  assertExpectedRevision, attemptDisposition, attemptIdFor, canAmendJob, canCancelJob,
  canTransitionAttempt, canTransitionJob, isAttemptIdFor, JobError, sealedArtifactMatches,
  type AmendJobResult, type Attempt, type CancelJobResult, type Job, type StartJobResult,
} from '../domain/job.js';

/**
 * Artifact query port consumed by the attempt task and by `jobs.artifact()`. The artifact lane owns the
 * implementation; `verify()` re-reads the sealed file and recomputes its hash.
 */
export type JobArtifactPort = Readonly<{
  verify(artifactId: string): Promise<JobArtifactView | undefined>;
}>;

export type JobRuntimeOptions = Readonly<{
  getHarness: () => Harness;
  /** A start/amend cannot run without a model; read-only access still works on an unconfigured host. */
  model: ModelRef | undefined;
  /** Extensions configured on every execution conversation (model guard, context, job tools). */
  executionExtensions: readonly Extension[];
  /** Tools enabled on every execution conversation (`save_artifact`). */
  executionTools: readonly ToolRegistration[];
  artifacts: JobArtifactPort;
}>;

type AttemptInput = Readonly<{jobId: string; attemptId: string}>;
type AttemptCheckpoint = {phase: 'prepare'} | {phase: 'run'};
type AttemptResult = Readonly<{jobId: string; attemptId: string; status: 'ready' | 'failed' | 'cancelled' | 'superseded'}>;
type AttemptRuntime = TaskRuntime<AttemptInput, AttemptCheckpoint, AttemptResult, object>;

const TERMINAL_REASON = {
  cancelled: 'cancelled',
  superseded: 'superseded',
} as const;

function completed(result: AttemptResult): NextTaskState<AttemptCheckpoint, AttemptResult> {
  return {status: 'terminal', outcome: {status: 'completed', result}};
}
function aborted(reason: string): NextTaskState<AttemptCheckpoint, AttemptResult> {
  return {status: 'terminal', outcome: {status: 'aborted', reason}};
}
function failed(message: string): NextTaskState<AttemptCheckpoint, AttemptResult> {
  return {status: 'terminal', outcome: {status: 'failed', error: {message}}};
}

function fingerprint(command: object): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function copyJob(job: Readonly<Job>): Job {
  return {...job, requirements: [...job.requirements]};
}
function copyAttempt(attempt: Readonly<Attempt>): Attempt {
  return {...attempt};
}

/** Concatenated assistant text, matching the history projection's definition of visible answer text. */
function assistantText(entry: Readonly<{model?: readonly Message[]}> | undefined): string {
  const message = entry?.model?.[0];
  if (!message || message.role !== 'assistant') return '';
  const assistant: AssistantMessage = message;
  return typeof assistant.content === 'string' ? assistant.content
    : assistant.content.filter(part => part.type === 'text').map(part => part.text).join('');
}

/**
 * Durable Job/Attempt store, attempt task and command transaction boundaries (jobs-and-artifacts.md §2-§3).
 *
 * Every command writes its immutable receipt and every state record it causes in one commit. The attempt
 * task owns execution: it resumes the same task/attempt after a restart, reuses the stable submission
 * request id, and writes Job.ready only behind a revision fence over a verified sealed artifact.
 */
export function jobRuntime(options: JobRuntimeOptions) {
  const {getHarness, model, artifacts} = options;

  const AttemptTask = defineTask<AttemptInput, AttemptCheckpoint, AttemptResult>({
    name: 'point.job.attempt', version: 1, initial: () => ({phase: 'prepare'}),
    phases: {
      /**
       * Fence against the committed Job/Attempt before any model work: cancelled/superseded attempts settle
       * without touching the Job. A current queued attempt becomes running and advances to the run phase.
       */
      async prepare(task, runtime, ctx) {
        const job = await runtime.snapshot(Jobs, task.input.jobId, ctx);
        const attempt = await runtime.snapshot(Attempts, task.input.attemptId, ctx);
        await runtime.commit(async tx => {
          const now = runtime.now();
          if (!attempt) return failed('ATTEMPT_NOT_FOUND');
          const draft = await tx.doc(Attempts, task.input.attemptId, copyAttempt(attempt));
          if (!job) {
            draft.status = 'failed';
            draft.error = 'JOB_NOT_FOUND';
            draft.endedAt = now;
            return failed('JOB_NOT_FOUND');
          }
          const draftJob = await tx.doc(Jobs, task.input.jobId, copyJob(job));
          const disposition = attemptDisposition(draftJob, draft);
          if (disposition === 'cancelled') {
            if (canTransitionAttempt(draft.status, 'cancelled')) {
              draft.status = 'cancelled';
              draft.endedAt = now;
              draft.error = TERMINAL_REASON.cancelled;
            }
            return aborted(TERMINAL_REASON.cancelled);
          }
          if (disposition === 'superseded') {
            if (canTransitionAttempt(draft.status, 'superseded')) {
              draft.status = 'superseded';
              draft.endedAt = now;
              draft.error = TERMINAL_REASON.superseded;
            }
            return aborted(TERMINAL_REASON.superseded);
          }
          if (draft.status !== 'queued' && draft.status !== 'running') return aborted('stale-attempt');
          if (draftJob.status === 'queued' && canTransitionJob('queued', 'running')) draftJob.status = 'running';
          draftJob.updatedAt = now;
          if (draft.status === 'queued') draft.status = 'running';
          return {status: 'running', checkpoint: {phase: 'run'}};
        }, ctx);
      },

      /**
       * Submit the `[POINT_JOB]` prompt once (stable request id) and wait for the execution conversation's
       * answer. The final decision is made in a transaction that re-reads the Job/Attempt (revision fence) and
       * only admits a sealed, hash-verified artifact owned by exactly this attempt/revision.
       */
      async run(task, runtime, ctx) {
        const {jobId, attemptId} = task.input;
        const job = await runtime.snapshot(Jobs, jobId, ctx);
        const attempt = await runtime.snapshot(Attempts, attemptId, ctx);
        if (!job || !attempt) {
          await runtime.commit(() => failed(job ? 'ATTEMPT_NOT_FOUND' : 'JOB_NOT_FOUND'), ctx);
          return;
        }
        const disposition = attemptDisposition(job, attempt);
        if (disposition !== 'current') {
          await stopAttempt(runtime, ctx, job, attempt, disposition);
          return;
        }
        const conversation = await runtime.conversation(Number(attempt.conversationId) as ConversationId, ctx);
        if (!conversation) {
          await failAttempt(runtime, ctx, jobId, attemptId, 'CONVERSATION_NOT_FOUND', job, attempt);
          return;
        }
        const prompt = `[POINT_JOB]${JSON.stringify({
          jobId: job.id, attemptId, title: job.title, prompt: job.prompt,
          requirements: [...job.requirements], revision: job.revision, artifactRequired: true,
        })}`;
        let settled: SettledSubmissionRecord | undefined;
        try {
          const submission = await conversation.submit({
            type: 'input', content: prompt, requestId: `point-job:${attemptId}`,
          }, ctx);
          settled = await submission.wait(ctx);
        } catch (error) {
          // A cancelled invocation must not be turned into a Job failure: the abort handler records cancellation.
          if (runtime.signal.aborted) return;
          await failAttempt(runtime, ctx, jobId, attemptId, 'SUBMISSION_FAILED', job, attempt);
          return;
        }
        if (!settled || settled.status !== 'done' || settled.answer === undefined) {
          // A cancelled invocation must not be turned into a Job failure: the abort handler records cancellation.
          if (runtime.signal.aborted) return;
          await failAttempt(runtime, ctx, jobId, attemptId, 'SUBMISSION_UNANSWERED', job, attempt);
          return;
        }
        const answer = await runtime.entry(AssistantEntry, settled.answer, ctx);
        const result = assistantText(answer);
        // File verification is IO and must stay outside the commit. The fence inside the commit then proves the
        // artifact still belongs to the current attempt/revision before it can make the Job ready.
        const latest = await runtime.snapshot(Attempts, attemptId, ctx);
        if (!latest) {
          await runtime.commit(() => failed('ATTEMPT_NOT_FOUND'), ctx);
          return;
        }
        const artifactId = latest.artifactId;
        const view = artifactId ? await artifacts.verify(artifactId) : undefined;
        // The abort handler owns cancellation; committing from an invocation that is already signalled would fault.
        if (runtime.signal.aborted) return;
        await runtime.commit(async tx => {
          const now = runtime.now();
          const currentAttempt = await tx.doc(Attempts, attemptId, copyAttempt(latest));
          const currentJob = await tx.doc(Jobs, jobId, copyJob(job));
          const state = attemptDisposition(currentJob, currentAttempt);
          if (state === 'cancelled') {
            if (canTransitionAttempt(currentAttempt.status, 'cancelled')) {
              currentAttempt.status = 'cancelled';
              currentAttempt.endedAt = now;
              currentAttempt.error = TERMINAL_REASON.cancelled;
            }
            return aborted(TERMINAL_REASON.cancelled);
          }
          if (state === 'superseded') {
            if (canTransitionAttempt(currentAttempt.status, 'superseded')) {
              currentAttempt.status = 'superseded';
              currentAttempt.endedAt = now;
              currentAttempt.error = TERMINAL_REASON.superseded;
            }
            return aborted(TERMINAL_REASON.superseded);
          }
          // Only a sealed artifact of exactly this Job/Attempt/revision whose file hash still matches counts.
          const artifactOk = artifactId !== null && currentAttempt.artifactId === artifactId
            && view !== undefined && sealedArtifactMatches(view.artifact, currentJob, currentAttempt, view.verified);
          if (!artifactOk) {
            if (canTransitionAttempt(currentAttempt.status, 'failed')) {
              currentAttempt.status = 'failed';
              currentAttempt.error = 'ARTIFACT_REQUIRED';
              currentAttempt.endedAt = now;
            }
            currentJob.status = 'failed';
            currentJob.error = 'ARTIFACT_REQUIRED';
            currentJob.updatedAt = now;
            return completed({jobId, attemptId, status: 'failed'});
          }
          if (!canTransitionAttempt(currentAttempt.status, 'completed')) return aborted('stale-attempt');
          currentAttempt.status = 'completed';
          currentAttempt.result = result;
          currentAttempt.artifactId = artifactId as string;
          currentAttempt.endedAt = now;
          currentAttempt.error = null;
          currentJob.status = 'ready';
          currentJob.result = result;
          currentJob.artifactId = artifactId as string;
          currentJob.error = null;
          currentJob.updatedAt = now;
          return completed({jobId, attemptId, status: 'ready'});
        }, ctx);
      },
    },
    /** Cancellation records the attempt, never a fake Job completion; it does not undo external effects. */
    async abort(task, runtime, ctx) {
      const attempt = await runtime.snapshot(Attempts, task.input.attemptId, ctx);
      if (!attempt) return;
      await runtime.commit(async tx => {
        const draft = await tx.doc(Attempts, task.input.attemptId, copyAttempt(attempt));
        if (canTransitionAttempt(draft.status, 'cancelled')) {
          draft.status = 'cancelled';
          draft.endedAt = runtime.now();
          draft.error = TERMINAL_REASON.cancelled;
        }
        return aborted(TERMINAL_REASON.cancelled);
      }, ctx);
    },
  });

  async function stopAttempt(
    runtime: AttemptRuntime, ctx: Context,
    job: Readonly<Job>, attempt: Readonly<Attempt>, disposition: 'cancelled' | 'superseded',
  ) {
    await runtime.commit(async tx => {
      const now = runtime.now();
      const draftJob = await tx.doc(Jobs, job.id, copyJob(job));
      const draft = await tx.doc(Attempts, attempt.id, copyAttempt(attempt));
      const state = attemptDisposition(draftJob, draft);
      if (state !== 'cancelled' && state !== 'superseded') return aborted('stale-attempt');
      if (canTransitionAttempt(draft.status, state)) {
        draft.status = state;
        draft.endedAt = now;
        draft.error = TERMINAL_REASON[state];
      }
      return aborted(TERMINAL_REASON[state]);
    }, ctx);
  }

  async function failAttempt(
    runtime: AttemptRuntime, ctx: Context,
    jobId: string, attemptId: string, code: string,
    job: Readonly<Job>, attempt: Readonly<Attempt>,
  ) {
    await runtime.commit(async tx => {
      const now = runtime.now();
      const currentAttempt = await tx.doc(Attempts, attemptId, copyAttempt(attempt));
      const currentJob = await tx.doc(Jobs, jobId, copyJob(job));
      const state = attemptDisposition(currentJob, currentAttempt);
      if (state === 'cancelled') {
        if (canTransitionAttempt(currentAttempt.status, 'cancelled')) {
          currentAttempt.status = 'cancelled';
          currentAttempt.endedAt = now;
          currentAttempt.error = TERMINAL_REASON.cancelled;
        }
        return aborted(TERMINAL_REASON.cancelled);
      }
      if (state === 'superseded') {
        if (canTransitionAttempt(currentAttempt.status, 'superseded')) {
          currentAttempt.status = 'superseded';
          currentAttempt.endedAt = now;
          currentAttempt.error = TERMINAL_REASON.superseded;
        }
        return aborted(TERMINAL_REASON.superseded);
      }
      if (canTransitionAttempt(currentAttempt.status, 'failed')) {
        currentAttempt.status = 'failed';
        currentAttempt.error = code;
        currentAttempt.endedAt = now;
      }
      if (currentJob.status !== 'cancelled') {
        currentJob.status = 'failed';
        currentJob.error = code;
        currentJob.updatedAt = now;
      }
      return completed({jobId, attemptId, status: 'failed'});
    }, ctx);
  }

  /** Create the execution conversation, its mapping and the attempt task in the caller's transaction. */
  async function createExecution(
    tx: Tx, jobId: string, attemptId: string, revision: number,
  ): Promise<{conversationId: string; taskId: string}> {
    if (!model) throw new Error('MODEL_NOT_CONFIGURED');
    const conversation = await tx.createConversation({ownership: {kind: 'ownerless'}});
    await configure(tx, conversation.id, {
      model, extensions: [...options.executionExtensions], tools: [...options.executionTools],
    });
    const taskId = await tx.createTask(AttemptTask, {jobId, attemptId}, {
      conversationId: conversation.id, ownership: {kind: 'conversation'}, background: true,
    });
    const conversationId = String(conversation.id);
    await tx.doc(JobExecutions, conversationId, {jobId, attemptId, revision});
    return {conversationId, taskId: String(taskId)};
  }

  const store: JobStore = {
    async start(command) {
      const h = getHarness();
      if (!model) throw new Error('MODEL_NOT_CONFIGURED');
      if (!(await h.snapshot(Chats, command.sourceChatId, context))) throw new JobError('CHAT_NOT_FOUND');
      const commandFingerprint = fingerprint(command);
      const computed = await h.commit(async tx => {
        // Command-prefixed keys: one requestId may name a start, an amend and a cancel without colliding.
        const receipt = await tx.doc(JobCommandReceipts,
          `start:${command.sourceChatId}:${command.requestId}`, commandFingerprint);
        if (receipt.fingerprint !== commandFingerprint) throw new JobError('IDEMPOTENCY_CONFLICT');
        // Copy before returning: a document draft is a Chord overlay that is settled after the commit.
        if (receipt.result) return {...receipt.result} as StartJobResult;
        const now = Date.now();
        const jobId = randomUUID();
        const revision = 1;
        const attemptId = attemptIdFor(jobId, revision);
        const execution = await createExecution(tx, jobId, attemptId, revision);
        const job: Job = {
          id: jobId, title: command.title, prompt: command.prompt, requirements: [...command.requirements],
          revision, status: 'queued', sourceChatId: command.sourceChatId,
          executionChatId: execution.conversationId, currentAttemptId: attemptId,
          result: null, artifactId: null, error: null, createdAt: now, updatedAt: now,
        };
        const attempt: Attempt = {
          id: attemptId, jobId, revision, status: 'queued', taskId: execution.taskId,
          conversationId: execution.conversationId, artifactId: null, result: null, error: null,
          startedAt: now, endedAt: null,
        };
        await tx.doc(Jobs, jobId, copyJob(job));
        await tx.doc(Attempts, attemptId, copyAttempt(attempt));
        const result: StartJobResult = {jobId, revision, attemptId};
        receipt.result = result;
        return {...result};
      }, context);
      h.resume();
      return computed;
    },

    async amend(command) {
      const h = getHarness();
      if (!model) throw new Error('MODEL_NOT_CONFIGURED');
      const current = await h.snapshot(Jobs, command.jobId, context);
      if (!current) throw new JobError('JOB_NOT_FOUND');
      const previous = current.currentAttemptId
        ? await h.snapshot(Attempts, current.currentAttemptId, context) : undefined;
      const commandFingerprint = fingerprint(command);
      let oldTaskId: number | undefined;
      const computed = await h.commit(async tx => {
        const receipt = await tx.doc(JobCommandReceipts,
          `amend:${command.jobId}:${command.requestId}`, commandFingerprint);
        if (receipt.fingerprint !== commandFingerprint) throw new JobError('IDEMPOTENCY_CONFLICT');
        if (receipt.result) return {...receipt.result} as AmendJobResult;
        const job = await tx.doc(Jobs, command.jobId, copyJob(current));
        assertExpectedRevision(job, command.expectedRevision);
        if (!canAmendJob(job)) throw new JobError('JOB_TERMINAL');
        const now = Date.now();
        const revision = job.revision + 1;
        const attemptId = attemptIdFor(job.id, revision);
        if (job.currentAttemptId && previous) {
          const stale = await tx.doc(Attempts, job.currentAttemptId, copyAttempt(previous));
          if (canTransitionAttempt(stale.status, 'superseded')) {
            stale.status = 'superseded';
            stale.endedAt = now;
            stale.error = TERMINAL_REASON.superseded;
          }
          if (stale.taskId) oldTaskId = Number(stale.taskId);
        }
        if (command.prompt !== undefined) job.prompt = command.prompt;
        if (command.requirements !== undefined) job.requirements = [...command.requirements];
        job.revision = revision;
        job.status = 'queued';
        job.currentAttemptId = attemptId;
        job.result = null;
        job.artifactId = null;
        job.error = null;
        job.updatedAt = now;
        const execution = await createExecution(tx, job.id, attemptId, revision);
        job.executionChatId = execution.conversationId;
        const attempt: Attempt = {
          id: attemptId, jobId: job.id, revision, status: 'queued', taskId: execution.taskId,
          conversationId: execution.conversationId, artifactId: null, result: null, error: null,
          startedAt: now, endedAt: null,
        };
        await tx.doc(Attempts, attemptId, copyAttempt(attempt));
        const result: AmendJobResult = {jobId: job.id, revision, attemptId};
        receipt.result = result;
        return {...result};
      }, context);
      h.resume();
      if (oldTaskId !== undefined) await h.abortTask(oldTaskId as TaskId, context).catch(() => {});
      return computed;
    },

    async cancel(command) {
      const h = getHarness();
      const current = await h.snapshot(Jobs, command.jobId, context);
      if (!current) throw new JobError('JOB_NOT_FOUND');
      const previous = current.currentAttemptId
        ? await h.snapshot(Attempts, current.currentAttemptId, context) : undefined;
      const commandFingerprint = fingerprint(command);
      let taskId: number | undefined;
      const computed = await h.commit(async tx => {
        const receipt = await tx.doc(JobCommandReceipts,
          `cancel:${command.jobId}:${command.requestId}`, commandFingerprint);
        if (receipt.fingerprint !== commandFingerprint) throw new JobError('IDEMPOTENCY_CONFLICT');
        if (receipt.result) return {...receipt.result} as CancelJobResult;
        const job = await tx.doc(Jobs, command.jobId, copyJob(current));
        assertExpectedRevision(job, command.expectedRevision);
        const now = Date.now();
        if (!canCancelJob(job)) {
          // Cancelling an already cancelled Job is an idempotent no-op, not a new state change.
          const result: CancelJobResult = {jobId: job.id, status: 'cancelled'};
          receipt.result = result;
          return {...result};
        }
        job.status = 'cancelled';
        job.error = TERMINAL_REASON.cancelled;
        job.updatedAt = now;
        if (job.currentAttemptId && previous) {
          const attempt = await tx.doc(Attempts, job.currentAttemptId, copyAttempt(previous));
          if (canTransitionAttempt(attempt.status, 'cancelled')) {
            attempt.status = 'cancelled';
            attempt.endedAt = now;
            attempt.error = TERMINAL_REASON.cancelled;
          }
          if (attempt.taskId) taskId = Number(attempt.taskId);
        }
        const result: CancelJobResult = {jobId: job.id, status: 'cancelled'};
        receipt.result = result;
        return {...result};
      }, context);
      h.resume();
      if (taskId !== undefined) await h.abortTask(taskId as TaskId, context).catch(() => {});
      return computed;
    },

    async get(jobId) {
      const job = await getHarness().snapshot(Jobs, jobId, context);
      return job ? copyJob(job) : undefined;
    },

    async attempts(jobId) {
      const h = getHarness();
      const job = await h.snapshot(Jobs, jobId, context);
      if (!job) return [];
      const attempts: Attempt[] = [];
      for (let revision = 1; revision <= job.revision; revision += 1) {
        const id = attemptIdFor(jobId, revision);
        const attempt = await h.snapshot(Attempts, id, context);
        if (!attempt) continue;
        // Defensive: a member whose key does not name this Job's revision for this attempt is not returned.
        if (!isAttemptIdFor(attempt.id, jobId, attempt.revision) || attempt.revision !== revision) continue;
        attempts.push(copyAttempt(attempt));
      }
      return attempts;
    },

    async artifact(artifactId) {
      const view = await artifacts.verify(artifactId);
      if (!view) return undefined;
      return {...view, artifact: {...view.artifact}};
    },
  };

  const commands: JobCommands = jobCommands(store);
  return {commands, extension: {name: 'point.jobs', tasks: [AttemptTask]} satisfies Extension};
}
