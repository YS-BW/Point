/**
 * Child process for the WP1b.3 artifact crash window.
 *
 * The save flow commits `writing` first, then writes the file, then commits `sealed`.
 * This fixture stops between the real file write and the sealed commit: it reports
 * the written file over IPC and hangs. The parent SIGKILLs it, reopens the same
 * data directory, and must observe `writing` / `NOT_SEALED` with the file preserved:
 * a half-written intent is never success.
 */
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { artifactCommands, type ArtifactFilePort } from '../../src/application/artifact.js';
import { artifactFiles, artifactPath, artifactStore, sha256Hex, workspaceDir } from '../../src/runtime/artifacts.js';

const dir = process.argv[2];
if (!dir) throw new Error('missing data dir');

const storage = await openNodeSqliteStorage(join(dir, 'state.sqlite'));
const harness = await Harness.open(storage, {models: createModels(), registry: createRegistry()}, context);
const workspace = workspaceDir(dir);
const real = artifactFiles(workspace);

/** Real write first, then announce and hang before the caller can commit `sealed`. */
const crashingFiles: ArtifactFilePort = {
  async write(artifact, content) {
    await real.write(artifact, content);
    process.send?.({event: 'file-written', artifactId: artifact.id, path: artifact.path});
    await new Promise<void>(() => {});
  },
  inspect: artifact => real.inspect(artifact),
};

const jobId = 'job-artifact-crash';
const attemptId = 'job-artifact-crash-1';
const artifactId = `${attemptId}:call-1`;
const name = 'crash.md';
const commands = artifactCommands(artifactStore(harness, dir), crashingFiles, {sha256: sha256Hex, now: () => Date.now()});

void commands.save({
  artifactId, jobId, attemptId, revision: 1, name,
  path: artifactPath(workspace, jobId, attemptId, artifactId, name),
  content: 'crash-window-content',
}).catch(error => {
  process.send?.({event: 'error', message: String(error)});
});

// Keep the process alive: the save is parked inside the injected file port.
setInterval(() => {}, 1000);
