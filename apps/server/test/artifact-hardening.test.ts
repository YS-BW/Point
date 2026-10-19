import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { ArtifactError, initialArtifact, type Artifact } from '../src/domain/artifact.js';
import {
  artifactCommandsForHarness, artifactDirectoryName, artifactFiles, artifactPath, sha256Hex, workspaceDir,
} from '../src/runtime/artifacts.js';

const ARTIFACT_ID = 'job-1-1:call-1';
const CONTENT = '# 报告\n\nhardened artifact\n';

async function workspaceFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'point-artifact-hardening-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return {dir, workspace: workspaceDir(dir)};
}

function artifact(workspace: string, overrides: Partial<Artifact> = {}): Artifact {
  return {
    ...initialArtifact({
      id: ARTIFACT_ID, jobId: 'job-1', attemptId: 'job-1-1', revision: 1, name: 'report.md',
      path: artifactPath(workspace, 'job-1', 'job-1-1', ARTIFACT_ID, 'report.md'),
      sha256: sha256Hex(CONTENT), bytes: Buffer.byteLength(CONTENT, 'utf8'), createdAt: 1,
    }),
    ...overrides,
  };
}

function artifactDir(workspace: string): string {
  return join(workspace, 'jobs', 'job-1', 'job-1-1', artifactDirectoryName(ARTIFACT_ID));
}

function hasArtifactCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ArtifactError, `expected ArtifactError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('hardened artifact write publishes a 0600 regular file and reads it back', {timeout: 10000}, async t => {
  const {workspace} = await workspaceFixture(t);
  const files = artifactFiles(workspace);
  const value = artifact(workspace);
  await files.write(value, CONTENT);
  const target = join(artifactDir(workspace), 'report.md');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.equal(await readFile(target, 'utf8'), CONTENT);
  assert.deepEqual(await files.inspect(value), {
    status: 'read', sha256: sha256Hex(CONTENT), bytes: Buffer.byteLength(CONTENT, 'utf8'),
  });
  assert.deepEqual(await readdir(artifactDir(workspace)), ['report.md'], 'no temporary file survives success');
});

test('a symlinked workspace component is rejected without writing outside the root', {timeout: 15000}, async t => {
  const {dir, workspace} = await workspaceFixture(t);
  const outside = join(dir, 'outside');
  await mkdir(workspace, {recursive: true});
  await mkdir(outside, {recursive: true});
  await symlink(outside, join(workspace, 'jobs'), 'dir');
  const files = artifactFiles(workspace);
  await assert.rejects(files.write(artifact(workspace), CONTENT),
    (error: unknown) => error instanceof ArtifactError, 'a symlinked jobs directory is rejected');
  assert.deepEqual(await readdir(outside), [], 'nothing is written through the symlink');

  // The application flow fails closed as well, leaving a failed record instead of a sealed file.
  const harness = await Harness.open(new MemoryStorage(), {models: createModels(), registry: createRegistry()}, context);
  t.after(() => harness.close(context));
  const commands = artifactCommandsForHarness(harness, dir);
  await assert.rejects(commands.save({
    artifactId: ARTIFACT_ID, jobId: 'job-1', attemptId: 'job-1-1', revision: 1, name: 'report.md',
    path: artifactPath(workspace, 'job-1', 'job-1-1', ARTIFACT_ID, 'report.md'), content: CONTENT,
  }), (error: unknown) => error instanceof ArtifactError);
  assert.deepEqual(await readdir(outside), []);
  const verification = await commands.verify(ARTIFACT_ID);
  assert.equal(verification?.verified, false);
});

test('a symlinked attempt directory is rejected', {timeout: 15000}, async t => {
  const {dir, workspace} = await workspaceFixture(t);
  const outside = join(dir, 'outside-attempt');
  await mkdir(join(workspace, 'jobs'), {recursive: true});
  await mkdir(outside, {recursive: true});
  await symlink(outside, join(workspace, 'jobs', 'job-1'), 'dir');
  const files = artifactFiles(workspace);
  await assert.rejects(files.write(artifact(workspace), CONTENT),
    (error: unknown) => error instanceof ArtifactError);
  assert.deepEqual(await readdir(outside), []);
});

test('a symlinked destination file is rejected and its target is never overwritten', {timeout: 15000}, async t => {
  const {dir, workspace} = await workspaceFixture(t);
  const directory = artifactDir(workspace);
  await mkdir(directory, {recursive: true});
  const victim = join(dir, 'victim.md');
  await writeFile(victim, 'outside-evidence', 'utf8');
  await symlink(victim, join(directory, 'report.md'));
  const files = artifactFiles(workspace);
  await assert.rejects(files.write(artifact(workspace), CONTENT),
    (error: unknown) => error instanceof ArtifactError);
  assert.equal(await readFile(victim, 'utf8'), 'outside-evidence');
  assert.deepEqual(await readdir(directory), ['report.md'], 'no temporary file is left behind');
});

test('a parent swapped between the check and the rename is refused (TOCTOU)', {timeout: 15000}, async t => {
  const {dir, workspace} = await workspaceFixture(t);
  const outside = join(dir, 'outside-toctou');
  await mkdir(outside, {recursive: true});
  const files = artifactFiles(workspace, {
    async beforeRename({root}) {
      // Swap the attempt directory for a symlink to an outside directory after the writer's checks.
      const attempt = join(root, 'jobs', 'job-1');
      await rm(attempt, {recursive: true, force: true});
      await symlink(outside, attempt, 'dir');
    },
  });
  await assert.rejects(files.write(artifact(workspace), CONTENT),
    (error: unknown) => error instanceof ArtifactError, 'the pre-rename recheck rejects a swapped parent');
  assert.deepEqual(await readdir(outside), [], 'the rename never lands outside the canonical root');
});

test('a post-rename tamper is caught by the read-back hash check', {timeout: 15000}, async t => {
  const {workspace} = await workspaceFixture(t);
  const files = artifactFiles(workspace, {
    async afterRename({target}) {
      await writeFile(target, 'tampered-after-rename', 'utf8');
    },
  });
  await assert.rejects(files.write(artifact(workspace), CONTENT),
    hasArtifactCode('ARTIFACT_WRITE_FAILED'), 'a file that no longer matches sha256/bytes is not success');
});

test('inspect refuses symlinked evidence instead of following it', {timeout: 15000}, async t => {
  const {dir, workspace} = await workspaceFixture(t);
  const value = artifact(workspace);
  const files = artifactFiles(workspace);
  await files.write(value, CONTENT);
  const victim = join(dir, 'outside-secret.md');
  await writeFile(victim, 'outside-secret', 'utf8');
  const directory = artifactDir(workspace);
  await rm(join(directory, 'report.md'));
  await symlink(victim, join(directory, 'report.md'));
  const inspection = await files.inspect(value);
  assert.deepEqual(inspection, {status: 'unreadable'});
});

test('a forged stored path is rejected instead of being written', {timeout: 10000}, async t => {
  const {dir, workspace} = await workspaceFixture(t);
  const forged = artifact(workspace, {path: join(dir, 'forged-report.md')});
  const files = artifactFiles(workspace);
  await assert.rejects(files.write(forged, CONTENT), hasArtifactCode('INVALID_COMMAND'));
  assert.deepEqual(await readdir(dir).catch(() => []), []);
  assert.deepEqual(await files.inspect(forged), {status: 'unreadable'});
});

test('a missing workspace is observed as missing, never created by a read', {timeout: 10000}, async t => {
  const {workspace} = await workspaceFixture(t);
  const files = artifactFiles(workspace);
  assert.deepEqual(await files.inspect(artifact(workspace)), {status: 'missing'});
  await assert.rejects(stat(workspace), /ENOENT/);
});
