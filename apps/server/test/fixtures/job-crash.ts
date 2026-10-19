/**
 * Child process for the WP1b.3 crash windows. It starts one job and then blocks
 * forever so the parent can SIGKILL it at a deterministic point.
 *
 * mode = 'model-pending' (default): the first model request signals the parent and
 * never resolves. Killing then happens after the attempt task exists and after the
 * guarded model call has recorded its intent, but before any model result is
 * committed. On reopen the summary of that window must be: same attempt, no replay
 * of the provider call, no faked success, original history intact.
 *
 * The parent owns the data directory and all assertions; this fixture only reports
 * the identity of the job/attempt so the parent can reopen and inspect the same one.
 */
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { openRuntime, type ModelBinding } from '../../src/runtime/open.js';

const dir = process.argv[2];
const mode = process.argv[3] ?? 'model-pending';
if (!dir) throw new Error('missing data dir');
if (mode !== 'model-pending') throw new Error(`unknown crash mode ${mode}`);

const faux = fauxProvider({tokensPerSecond: 100000});
faux.setResponses([async () => {
  // The guard has already committed the model-call intent by the time the provider is
  // invoked. Hanging here leaves the attempt in flight without a committed result.
  process.send?.({event: 'model-requested'});
  await new Promise<void>(() => {});
  throw new Error('unreachable');
}]);
const models = createModels();
models.setProvider(faux.provider);
const binding: ModelBinding = {models, model: {provider: 'faux', modelId: 'faux-1'}};

const runtime = await openRuntime(dir, binding);
const chat = await runtime.chats.create({requestId: 'crash-source-chat', name: '崩溃来源'});
const started = await runtime.jobs.start({
  requestId: 'crash-job-1',
  title: '崩溃任务',
  prompt: '请产出一个文件',
  requirements: ['至少一个 artifact'],
  sourceChatId: chat.id,
});
process.send?.({event: 'started', jobId: started.jobId, attemptId: started.attemptId, revision: started.revision, mode});
// Keep the process alive until the parent kills it.
setInterval(() => {}, 1000);
