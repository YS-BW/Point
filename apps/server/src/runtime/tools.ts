/**
 * Authorized `save_artifact` tool (WP1b.3).
 *
 * The tool is only usable from an execution conversation: it resolves
 * `point.job-execution` by the current conversation id, then fences on the Job and
 * Attempt revision/status before touching the workspace. The save is idempotent by
 * `<attemptId>:<callId>` + sha256; a different payload for the same call conflicts.
 *
 * The sealed commit additionally revalidates Job/Attempt inside the transaction and
 * sets `Attempt.artifactId` in that same commit, so the attempt task can later read
 * one field and verify the artifact without an artifact-side index.
 */

import type { Context } from '@earendil-works/chord';
import {
  defineExtension, defineTool,
  type Extension, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration, type Tx,
} from '@earendil-works/pi-durable';
import type { TSchema } from '@earendil-works/pi-ai';
import {
  artifactCommands, type ArtifactCommands, type ArtifactStore,
} from '../application/artifact.js';
import {
  ArtifactError, MAX_ARTIFACT_BYTES, isArtifactId, isArtifactName, utf8Bytes,
  type Artifact, type ArtifactErrorCode,
} from '../domain/artifact.js';
import type { Attempt, Job } from '../domain/job.js';
import { Artifacts, artifactFromDocument } from '../storage/artifact.js';
import { Attempts, JobExecutions, Jobs } from '../storage/job.js';
import { artifactFiles, artifactPath, sha256Hex, writeArtifactDocument } from './artifacts.js';

const TOOL_NAME = 'save_artifact';
const EXTENSION_NAME = 'point.job.tools';

/** Artifact scope resolved from the execution mapping and fenced before any write. */
type ArtifactScope = Readonly<{job: Job; attempt: Attempt; revision: number}>;

type SaveArtifactDetails = Readonly<{
  artifactId?: string;
  path?: string;
  sha256?: string;
  bytes?: number;
  code?: ArtifactErrorCode;
}>;

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'content'],
  properties: {
    name: {
      type: 'string',
      description: '产物文件名，只能包含字母、数字、点、下划线和连字符，1-64 个字符；不得包含路径分隔符或 ..',
    },
    content: {
      type: 'string',
      description: 'UTF-8 文本内容，最大 256 KiB',
    },
  },
} as const;

type SaveArtifactArguments = Readonly<{name: string; content: string}>;

function text(value: string) {
  return [{type: 'text' as const, text: value}];
}

function invalid(message?: string): ToolExecutionResult<SaveArtifactDetails> {
  return {isError: true, output: text(message === undefined ? 'INVALID_COMMAND' : `INVALID_COMMAND: ${message}`), details: {code: 'INVALID_COMMAND'}};
}

function failed(code: ArtifactErrorCode): ToolExecutionResult<SaveArtifactDetails> {
  return {isError: true, output: text(code), details: {code}};
}

/** Strict argument parsing; the model must not smuggle extra fields or non-strings. */
function parseArguments(input: unknown): SaveArtifactArguments {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ArtifactError('INVALID_COMMAND');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'name' && key !== 'content')
    || typeof value.name !== 'string'
    || typeof value.content !== 'string') {
    throw new ArtifactError('INVALID_COMMAND');
  }
  if (!isArtifactName(value.name)) throw new ArtifactError('INVALID_COMMAND');
  if (utf8Bytes(value.content) > MAX_ARTIFACT_BYTES) throw new ArtifactError('ARTIFACT_TOO_LARGE');
  return {name: value.name, content: value.content};
}

/**
 * Tool-scoped artifact store. `writing` only records the intent; `sealed` also
 * re-fences Job/Attempt in the same transaction and writes `Attempt.artifactId`.
 */
function toolArtifactStore(api: ToolExecutionApi, context: Context, scope: ArtifactScope): ArtifactStore {
  return {
    async load(artifactId) {
      const document = await api.snapshot(Artifacts, artifactId, context);
      return document === undefined ? undefined : artifactFromDocument(document);
    },

    async save(artifact) {
      if (artifact.state !== 'sealed') {
        return api.commit((tx: Tx) => writeArtifactDocument(tx, artifact), context);
      }
      return api.commit(async tx => {
        const job = await tx.doc(Jobs, scope.job.id, scope.job);
        if (job.revision !== scope.revision || job.currentAttemptId !== scope.attempt.id) {
          throw new ArtifactError('STALE_ATTEMPT');
        }
        if (job.status !== 'running') throw new ArtifactError('JOB_NOT_RUNNING');
        const attempt = await tx.doc(Attempts, scope.attempt.id, scope.attempt);
        if (attempt.revision !== scope.revision || attempt.status !== 'running' || attempt.jobId !== scope.job.id) {
          throw new ArtifactError('STALE_ATTEMPT');
        }
        const committed = await writeArtifactDocument(tx, artifact);
        attempt.artifactId = artifact.id;
        return committed;
      }, context);
    },
  };
}

/**
 * Create the `save_artifact` tool bound to one workspace (`<dataDir>/workspace`).
 * A factory because the workspace is host configuration, not tool state.
 */
export function saveArtifactTool(workspace: string): ToolRegistration {
  return defineTool({
    name: TOOL_NAME,
    description: '把本次执行的产物保存为文件并封存。name 只允许字母、数字、点、下划线与连字符（1-64 字符）；content 为 UTF-8 文本，最大 256 KiB。'
      + '成功返回 artifactId、path、sha256、bytes；重复保存同内容幂等，不同内容返回冲突。',
    parameters: PARAMETERS as unknown as TSchema,
    replay: 'safe',
    async execute(input, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult<SaveArtifactDetails>> {
      try {
        const args = parseArguments(input);
        const conversationId = String(api.conversationId);
        const mapping = await api.snapshot(JobExecutions, conversationId, context);
        if (mapping === undefined) throw new ArtifactError('NOT_EXECUTION_CONVERSATION');
        const job = await api.snapshot(Jobs, mapping.jobId, context);
        if (job === undefined) throw new ArtifactError('JOB_NOT_FOUND');
        const attempt = await api.snapshot(Attempts, mapping.attemptId, context);
        if (attempt === undefined) throw new ArtifactError('ATTEMPT_NOT_FOUND');
        if (job.revision !== mapping.revision
          || attempt.revision !== mapping.revision
          || attempt.jobId !== job.id
          || job.currentAttemptId !== attempt.id
          || attempt.conversationId !== conversationId) {
          throw new ArtifactError('STALE_ATTEMPT');
        }
        if (job.status !== 'running') throw new ArtifactError('JOB_NOT_RUNNING');
        if (attempt.status !== 'running') throw new ArtifactError('STALE_ATTEMPT');

        const artifactId = `${attempt.id}:${api.callId}`;
        if (!isArtifactId(artifactId)) throw new ArtifactError('INVALID_COMMAND');
        const path = artifactPath(workspace, job.id, attempt.id, artifactId, args.name);
        const commands: ArtifactCommands = artifactCommands(
          toolArtifactStore(api, context, {job, attempt, revision: mapping.revision}),
          artifactFiles(workspace),
          {sha256: sha256Hex, now: () => Date.now()},
        );
        const artifact: Artifact = await commands.save({
          artifactId,
          jobId: job.id,
          attemptId: attempt.id,
          revision: mapping.revision,
          name: args.name,
          path,
          content: args.content,
        });
        const details = {artifactId: artifact.id, path: artifact.path, sha256: artifact.sha256, bytes: artifact.bytes};
        return {output: text(JSON.stringify(details)), details};
      } catch (error) {
        if (error instanceof ArtifactError) return failed(error.code);
        if (error instanceof TypeError) return invalid();
        throw error;
      }
    },
  });
}

/** `point.job.tools`: the only extension an execution conversation needs for artifacts. */
export function jobToolsExtension(workspace: string): Extension {
  return defineExtension({name: EXTENSION_NAME, tools: [saveArtifactTool(workspace)]});
}
