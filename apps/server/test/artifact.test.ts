import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import {
  createRegistry, Harness, MemoryStorage, type ToolExecutionApi,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import {
  ArtifactError, MAX_ARTIFACT_BYTES, failArtifact, initialArtifact, isArtifactId, isArtifactName, isSha256,
  sealArtifact, utf8Bytes, type Artifact,
} from '../src/domain/artifact.js';
import type { Attempt, Job } from '../src/domain/job.js';
import { artifactCommands, type ArtifactCommands } from '../src/application/artifact.js';
import { Attempts, JobExecutions, Jobs } from '../src/storage/job.js';
import {
  artifactCommandsForHarness, artifactDirectoryName, artifactPath, artifactStore, sha256Hex, workspaceDir,
} from '../src/runtime/artifacts.js';
import { saveArtifactTool } from '../src/runtime/tools.js';

const JOB_ID = 'job-1';
const ATTEMPT_ID = 'job-1-1';
const ARTIFACT_ID = `${ATTEMPT_ID}:call-1`;
const NAME = 'report.md';
const CONTENT = '# Report\n\nhello artifact\n';

function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ArtifactError, `expected ArtifactError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  const workspace = '/tmp/workspace';
  const id = overrides.id ?? ARTIFACT_ID;
  const name = overrides.name ?? NAME;
  return initialArtifact({
    id, jobId: JOB_ID, attemptId: ATTEMPT_ID, revision: 1, name,
    path: artifactPath(workspace, JOB_ID, ATTEMPT_ID, id, name), sha256: sha256Hex(CONTENT),
    bytes: utf8Bytes(CONTENT), createdAt: 1, ...overrides,
  });
}

async function harnessFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'point-artifact-'));
  const h = await Harness.open(new MemoryStorage(), {models: createModels(), registry: createRegistry()}, context);
  t.after(async () => {
    await h.close(context);
    await rm(dir, {recursive: true, force: true});
  });
  return {dir, harness: h, commands: artifactCommandsForHarness(h, dir)};
}

async function saveInput(commands: ArtifactCommands, workspace: string, overrides: Readonly<Record<string, unknown>> = {}) {
  const artifactId = (overrides.artifactId as string | undefined) ?? ARTIFACT_ID;
  const name = (overrides.name as string | undefined) ?? NAME;
  return commands.save({
    artifactId, jobId: JOB_ID, attemptId: ATTEMPT_ID, revision: 1, name,
    path: artifactPath(workspace, JOB_ID, ATTEMPT_ID, artifactId, name), content: CONTENT, ...overrides,
  });
}

/* -------------------------------------------------------------------------- */
/* Domain                                                                      */
/* -------------------------------------------------------------------------- */

test('artifact names, ids, hashes and UTF-8 byte counts are strict', () => {
  for (const name of ['a', 'report.md', 'file-1_2.txt', 'R'.repeat(64)]) assert.equal(isArtifactName(name), true, name);
  for (const name of ['', '.', '..', '../escape.md', 'a/b', 'a\\b', 'a b', 'x'.repeat(65), 7, null]) {
    assert.equal(isArtifactName(name), false, String(name));
  }
  assert.equal(isArtifactId(`${ATTEMPT_ID}:call-1`), true);
  assert.equal(isArtifactId(''), false);
  assert.equal(isArtifactId('x'.repeat(257)), false);
  assert.equal(isSha256(sha256Hex(CONTENT)), true);
  assert.equal(isSha256('A'.repeat(64)), false);
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('😀'), 4, 'bytes are UTF-8, not UTF-16 code units');
});

test('artifact state transitions: writing -> sealed/failed, terminal states are idempotent', () => {
  const writing = artifact();
  assert.equal(writing.state, 'writing');
  assert.equal(writing.sealedAt, undefined);
  const sealed = sealArtifact(writing, 42);
  assert.equal(sealed.state, 'sealed');
  assert.equal(sealed.sealedAt, 42);
  assert.equal(sealArtifact(sealed, 99), sealed, 'sealing twice returns the same record');
  const failed = failArtifact(writing);
  assert.equal(failed.state, 'failed');
  assert.equal(failArtifact(failed), failed);
  assert.equal(failArtifact(sealed), sealed, 'a sealed artifact is never downgraded');
  assert.throws(() => initialArtifact({
    id: '', jobId: JOB_ID, attemptId: ATTEMPT_ID, revision: 1, name: NAME,
    path: artifactPath('/tmp/workspace', JOB_ID, ATTEMPT_ID, ARTIFACT_ID, NAME), sha256: sha256Hex(CONTENT),
    bytes: 1, createdAt: 1,
  }), hasCode('INVALID_COMMAND'));
  assert.throws(() => initialArtifact({
    id: ARTIFACT_ID, jobId: JOB_ID, attemptId: ATTEMPT_ID, revision: 1, name: '../escape',
    path: artifactPath('/tmp/workspace', JOB_ID, ATTEMPT_ID, ARTIFACT_ID, NAME), sha256: sha256Hex(CONTENT),
    bytes: 1, createdAt: 1,
  }), hasCode('INVALID_COMMAND'), 'path traversal is rejected at the value object');
  assert.throws(() => initialArtifact({
    id: ARTIFACT_ID, jobId: JOB_ID, attemptId: ATTEMPT_ID, revision: 1, name: NAME,
    path: artifactPath('/tmp/workspace', JOB_ID, ATTEMPT_ID, ARTIFACT_ID, NAME), sha256: 'not-a-hash',
    bytes: 1, createdAt: 1,
  }), hasCode('INVALID_COMMAND'));
});

test('artifact paths stay inside the job/attempt workspace and reject traversal names', () => {
  const workspace = join('/tmp', 'ws');
  const directory = artifactDirectoryName(ARTIFACT_ID);
  assert.match(directory, /^[A-Za-z0-9._-]{1,200}-[0-9a-f]{12}$/);
  assert.ok(directory.startsWith('job-1-1_call-1-'), 'unsafe characters in the artifact id are sanitized');
  assert.equal(directory, artifactDirectoryName(ARTIFACT_ID), 'the directory name is deterministic');
  assert.notEqual(artifactDirectoryName(`${ATTEMPT_ID}:call-1`), artifactDirectoryName(`${ATTEMPT_ID}:call-2`),
    'different call ids never share a directory');
  const path = artifactPath(workspace, JOB_ID, ATTEMPT_ID, ARTIFACT_ID, NAME);
  assert.equal(path, join(workspace, 'jobs', JOB_ID, ATTEMPT_ID, directory, NAME));
  assert.equal(workspaceDir('/data'), join('/data', 'workspace'));
  for (const bad of ['../evil.md', 'a/b', '..', '', 'x'.repeat(65)]) {
    assert.throws(() => artifactPath(workspace, JOB_ID, ATTEMPT_ID, ARTIFACT_ID, bad), hasCode('INVALID_COMMAND'), String(bad));
  }
  assert.throws(() => artifactPath(workspace, '../job', ATTEMPT_ID, ARTIFACT_ID, NAME), hasCode('INVALID_COMMAND'));
  assert.throws(() => artifactPath(workspace, JOB_ID, '..', ARTIFACT_ID, NAME), hasCode('INVALID_COMMAND'));
  for (const bad of ['', 'has space', 'x'.repeat(257)]) {
    assert.throws(() => artifactPath(workspace, JOB_ID, ATTEMPT_ID, bad, NAME), hasCode('INVALID_COMMAND'), String(bad));
  }
});

/* -------------------------------------------------------------------------- */
/* Runtime: atomic write, hash and verify                                      */
/* -------------------------------------------------------------------------- */

test('save writes once, seals, and verify recomputes the hash from the file', async t => {
  const f = await harnessFixture(t);
  const workspace = workspaceDir(f.dir);
  const saved = await saveInput(f.commands, workspace);
  assert.equal(saved.id, ARTIFACT_ID);
  assert.equal(saved.state, 'sealed');
  assert.equal(saved.sha256, sha256Hex(CONTENT));
  assert.equal(saved.bytes, utf8Bytes(CONTENT));
  assert.ok(saved.sealedAt);
  assert.equal(saved.path, artifactPath(workspace, JOB_ID, ATTEMPT_ID, ARTIFACT_ID, NAME));

  assert.equal(await readFile(saved.path, 'utf8'), CONTENT, 'the file contains exactly the artifact content');
  const info = await stat(saved.path);
  assert.equal(info.mode & 0o777, 0o600, 'artifact files are owner-only');
  const attemptDir = join(workspace, 'jobs', JOB_ID, ATTEMPT_ID);
  assert.deepEqual(await readdir(attemptDir), [artifactDirectoryName(ARTIFACT_ID)],
    'one artifact directory per artifact id; the tmp file is renamed away');
  assert.deepEqual(await readdir(join(attemptDir, artifactDirectoryName(ARTIFACT_ID))), [NAME]);

  const verified = await f.commands.verify(ARTIFACT_ID);
  assert.deepEqual(verified, {artifact: saved, verified: true});
  assert.equal((await f.commands.get(ARTIFACT_ID))?.state, 'sealed');
  assert.equal((await f.commands.get('missing-artifact')), undefined);
  assert.equal(await f.commands.verify('missing-artifact'), undefined);
});

test('a repeated save with the same id and hash is idempotent, a different hash conflicts', async t => {
  const f = await harnessFixture(t);
  const workspace = workspaceDir(f.dir);
  const first = await saveInput(f.commands, workspace);
  assert.deepEqual(await saveInput(f.commands, workspace), first, 'same id + same content replays the sealed artifact');
  await assert.rejects(saveInput(f.commands, workspace, {content: 'different content'}),
    hasCode('ARTIFACT_CONFLICT'));
  assert.equal(await readFile(first.path, 'utf8'), CONTENT, 'a conflict never overwrites the sealed file');
});

test('oversized content, invalid names and write failures never produce success', async t => {
  const f = await harnessFixture(t);
  const workspace = workspaceDir(f.dir);
  await assert.rejects(saveInput(f.commands, workspace, {content: 'x'.repeat(MAX_ARTIFACT_BYTES + 1)}),
    hasCode('ARTIFACT_TOO_LARGE'));
  assert.equal(await f.commands.get(ARTIFACT_ID), undefined, 'oversized content writes no document');
  await assert.rejects(saveInput(f.commands, workspace, {name: '../escape.md'}), hasCode('INVALID_COMMAND'));
  assert.equal(await readFile(join(f.dir, 'escape.md'), 'utf8').catch(() => 'missing'), 'missing',
    'a traversal attempt writes nothing outside the workspace');

  // A file write failure must leave the record failed, never sealed, and surface a stable code.
  const failingFiles = {
    async write(): Promise<void> { throw new Error('disk full'); },
    async inspect(): Promise<{status: 'unreadable'}> { return {status: 'unreadable'}; },
  };
  const store = new Map<string, Artifact>();
  const failing = artifactCommands(
    {
      async load(id) { return store.get(id); },
      async save(value) { store.set(value.id, value); return value; },
    },
    failingFiles,
    {sha256: sha256Hex, now: () => 1},
  );
  await assert.rejects(saveInput(failing, workspace), hasCode('ARTIFACT_WRITE_FAILED'));
  assert.equal(store.get(ARTIFACT_ID)?.state, 'failed', 'a failed write is persisted as failed, not sealed');
});

test('verify reports missing/tampered files without deleting evidence and only sealed can verify', async t => {
  const f = await harnessFixture(t);
  const workspace = workspaceDir(f.dir);
  const saved = await saveInput(f.commands, workspace);

  await writeFile(saved.path, 'tampered content');
  const tampered = await f.commands.verify(ARTIFACT_ID);
  assert.equal(tampered?.verified, false);
  assert.ok(tampered?.reason === 'HASH_MISMATCH' || tampered?.reason === 'SIZE_MISMATCH',
    `unexpected reason ${tampered?.reason}`);
  assert.equal(tampered?.artifact.state, 'sealed', 'the sealed record is evidence and stays');

  await rm(saved.path);
  const missing = await f.commands.verify(ARTIFACT_ID);
  assert.deepEqual([missing?.verified, missing?.reason], [false, 'FILE_MISSING']);

  // `writing` is never success, even when a file happens to exist on disk.
  const writing = artifact({id: 'job-1-1:call-2', name: 'draft.md',
    path: artifactPath(workspace, JOB_ID, ATTEMPT_ID, 'job-1-1:call-2', 'draft.md')});
  const runtimeStore = artifactStore(f.harness, f.dir);
  await runtimeStore.save(writing);
  await mkdir(dirname(writing.path), {recursive: true});
  await writeFile(writing.path, CONTENT);
  const pending = await f.commands.verify(writing.id);
  assert.deepEqual([pending?.verified, pending?.reason], [false, 'NOT_SEALED']);
});

/* -------------------------------------------------------------------------- */
/* save_artifact tool: authorization, atomic seal and idempotency              */
/* -------------------------------------------------------------------------- */

type ToolResult = {
  isError?: boolean;
  output?: ReadonlyArray<{type: string; text?: string}>;
  details?: {artifactId?: string; path?: string; sha256?: string; bytes?: number; code?: string};
};

const toolDetails = (result: ToolResult) => JSON.parse(result.output?.[0]?.text ?? '{}') as {
  artifactId?: string; path?: string; sha256?: string; bytes?: number;
};

async function seedJob(harness: Harness) {
  const conversationId = '9';
  const job: Job = {
    id: 'job-tool', title: '工具任务', prompt: '产出文件', requirements: [], revision: 1, status: 'running',
    sourceChatId: '2', executionChatId: conversationId, currentAttemptId: 'job-tool-1',
    result: null, artifactId: null, error: null, createdAt: 1, updatedAt: 1,
  };
  const attempt: Attempt = {
    id: 'job-tool-1', jobId: job.id, revision: 1, status: 'running', taskId: null, conversationId,
    artifactId: null, result: null, error: null, startedAt: 1, endedAt: null,
  };
  await harness.commit(async tx => {
    await tx.doc(Jobs, job.id, job);
    await tx.doc(Attempts, attempt.id, attempt);
    await tx.doc(JobExecutions, conversationId, {jobId: job.id, attemptId: attempt.id, revision: 1});
  }, context);
  return {job, attempt, conversationId};
}

function toolApi(harness: Harness, conversationId: string, callId: string): ToolExecutionApi {
  return {
    conversationId: Number(conversationId), callId,
    snapshot: harness.snapshot.bind(harness), commit: harness.commit.bind(harness),
  } as unknown as ToolExecutionApi;
}

test('save_artifact is authorized to execution conversations, seals atomically and is idempotent', async t => {
  const f = await harnessFixture(t);
  const workspace = workspaceDir(f.dir);
  const {job, attempt} = await seedJob(f.harness);
  const tool = saveArtifactTool(workspace);
  const api = toolApi(f.harness, attempt.conversationId, 'call-1');
  const content = 'tool content';

  const result = await tool.execute({name: 'out.md', content}, api, context) as ToolResult;
  assert.equal(result.isError, undefined);
  const details = toolDetails(result);
  assert.equal(details.artifactId, `${attempt.id}:call-1`);
  const artifactId = `${attempt.id}:call-1`;
  assert.equal(details.path, artifactPath(workspace, job.id, attempt.id, artifactId, 'out.md'));
  assert.equal(details.sha256, sha256Hex(content));
  assert.equal(details.bytes, utf8Bytes(content));
  assert.equal(await readFile(details.path!, 'utf8'), content);
  assert.equal((await f.commands.verify(details.artifactId!))?.verified, true);
  // The sealed commit also writes Attempt.artifactId, which the attempt task later trusts.
  assert.equal((await f.harness.snapshot(Attempts, attempt.id, context))?.artifactId, details.artifactId);

  // Same call id and content: idempotent; different content: conflict without touching the sealed file.
  const replay = await tool.execute({name: 'out.md', content}, api, context) as ToolResult;
  assert.equal(toolDetails(replay).artifactId, details.artifactId);
  const conflict = await tool.execute({name: 'out.md', content: 'other'}, api, context) as ToolResult;
  assert.deepEqual([conflict.isError, conflict.details?.code], [true, 'ARTIFACT_CONFLICT']);
  assert.equal(await readFile(details.path!, 'utf8'), content);

  const traversal = await tool.execute({name: '../escape.md', content: 'x'},
    toolApi(f.harness, attempt.conversationId, 'call-2'), context) as ToolResult;
  assert.deepEqual([traversal.isError, traversal.details?.code], [true, 'INVALID_COMMAND']);
  assert.equal(await readFile(join(f.dir, 'escape.md'), 'utf8').catch(() => 'missing'), 'missing');
  const oversized = await tool.execute({name: 'big.md', content: 'x'.repeat(MAX_ARTIFACT_BYTES + 1)},
    toolApi(f.harness, attempt.conversationId, 'call-3'), context) as ToolResult;
  assert.deepEqual([oversized.isError, oversized.details?.code], [true, 'ARTIFACT_TOO_LARGE']);

  // A conversation without a job-execution mapping is not an execution conversation.
  const foreign = await tool.execute({name: 'x.md', content: 'x'}, toolApi(f.harness, '999', 'call-4'), context) as ToolResult;
  assert.deepEqual([foreign.isError, foreign.details?.code], [true, 'NOT_EXECUTION_CONVERSATION']);

  // A job that is no longer running rejects before any filesystem write.
  await f.harness.commit(async tx => {
    const draft = await tx.doc(Jobs, job.id, job);
    draft.status = 'cancelled';
  }, context);
  const notRunning = await tool.execute({name: 'late.md', content: 'late'},
    toolApi(f.harness, attempt.conversationId, 'call-5'), context) as ToolResult;
  assert.deepEqual([notRunning.isError, notRunning.details?.code], [true, 'JOB_NOT_RUNNING']);

  const attemptDir = join(workspace, 'jobs', job.id, attempt.id);
  assert.deepEqual(await readdir(attemptDir), [artifactDirectoryName(artifactId!)],
    'only the sealed artifact directory exists; rejects leave no files behind');
  assert.deepEqual(await readdir(join(attemptDir, artifactDirectoryName(artifactId!))), ['out.md']);
});

/* -------------------------------------------------------------------------- */
/* Crash window: file written, sealed commit not yet reached                    */
/* -------------------------------------------------------------------------- */

test('SIGKILL between the artifact file write and the sealed commit keeps writing/NOT_SEALED evidence', {timeout: 30000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'point-artifact-crash-'));
  const child = fork(new URL('./fixtures/artifact-crash.js', import.meta.url), [dir], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const exited = once(child, 'exit');
  try {
    const written = await new Promise<{artifactId: string; path: string}>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`artifact crash fixture timed out: ${stderr}`)), 20000);
      child.on('message', (message: unknown) => {
        const event = message as {event?: string; artifactId?: string; path?: string; message?: string};
        if (event.event === 'error') {
          clearTimeout(timer);
          reject(new Error(String(event.message)));
        }
        if (event.event === 'file-written' && event.artifactId && event.path) {
          clearTimeout(timer);
          resolve({artifactId: event.artifactId, path: event.path});
        }
      });
      child.once('exit', () => reject(new Error(`artifact fixture exited before writing: ${stderr}`)));
    });
    child.kill('SIGKILL');
    await exited;

    const storage = await openNodeSqliteStorage(join(dir, 'state.sqlite'));
    const harness = await Harness.open(storage, {models: createModels(), registry: createRegistry()}, context);
    try {
      const commands = artifactCommandsForHarness(harness, dir);
      const stored = await commands.get(written.artifactId);
      assert.equal(stored?.state, 'writing', 'the durable intent never claims sealed after the crash');
      assert.equal(stored?.sealedAt, undefined);
      const verified = await commands.verify(written.artifactId);
      assert.deepEqual([verified?.verified, verified?.reason], [false, 'NOT_SEALED'],
        'a writing artifact is never success, even though its file exists');
      const content = 'crash-window-content';
      assert.equal(written.path,
        artifactPath(workspaceDir(dir), 'job-artifact-crash', 'job-artifact-crash-1', written.artifactId, 'crash.md'));
      assert.equal(await readFile(written.path, 'utf8'), content, 'the file written before the crash is preserved');
      assert.equal((await stat(written.path)).mode & 0o777, 0o600);
      assert.equal(stored?.sha256, sha256Hex(content));
      assert.equal(stored?.bytes, utf8Bytes(content));
    } finally {
      await harness.close(context);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    await rm(dir, {recursive: true, force: true});
  }
});
