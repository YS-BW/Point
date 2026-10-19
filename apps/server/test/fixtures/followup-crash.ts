/**
 * Child process for the WP1b.4 follow-up crash window.
 *
 * It creates a ready Job, schedules a follow-up a little in the future, reports the
 * schedule identity over IPC and then blocks until the parent SIGKILLs it. The parent
 * reopens the same data directory and must observe the follow-up waking at the
 * original absolute time (never "now + interval") and delivering exactly once.
 *
 * mode:
 * - 'before-due' (default): dueAt = now + 800ms; the kill happens before the wake.
 * - 'missed': dueAt is already in the past; the kill happens right after scheduling
 *   (the wake may race the kill, so the parent treats either process as the one that
 *   may have delivered and asserts exactly-once overall).
 */
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { openRuntime, type ModelBinding } from '../../src/runtime/open.js';
import { memoryNotificationAdapter } from '../../src/adapters/notification/memory.js';

const dir = process.argv[2];
const mode = process.argv[3] ?? 'before-due';
if (!dir) throw new Error('missing data dir');
if (mode !== 'before-due' && mode !== 'missed') throw new Error(`unknown crash mode ${mode}`);

const faux = fauxProvider({tokensPerSecond: 100000});
faux.setResponses([
  fauxAssistantMessage([fauxToolCall('save_artifact', {name: 'report.md', content: 'crash window report'})], {stopReason: 'toolUse'}),
  fauxAssistantMessage('崩溃窗口报告'),
]);
const models = createModels();
models.setProvider(faux.provider);
const binding: ModelBinding = {models, model: {provider: 'faux', modelId: 'faux-1'}};
const notification = memoryNotificationAdapter('delivered');
const runtime = await openRuntime(dir, binding, {notification: notification.port});
const source = await runtime.chats.create({requestId: 'crash-source', name: '崩溃来源'});
const started = await runtime.jobs.start({
  requestId: 'crash-job', title: '崩溃计划任务', prompt: '产出一个报告', sourceChatId: source.id,
});
// Wait until the job is ready (the report needs a sealed artifact).
const deadline = Date.now() + 15000;
for (;;) {
  const job = await runtime.jobs.get(started.jobId);
  if (job?.status === 'ready') break;
  if (Date.now() > deadline) throw new Error(`job stayed ${job?.status}`);
  await new Promise(resolve => setTimeout(resolve, 5));
}
const dueAt = mode === 'before-due' ? Date.now() + 800 : Date.now() - 1000;
const scheduled = await runtime.followups.schedule({
  requestId: 'crash-schedule', jobId: started.jobId, expectedRevision: 1, dueAt,
});
process.send?.({
  event: 'scheduled', jobId: started.jobId, scheduleId: scheduled.scheduleId,
  chatId: source.id, dueAt, mode,
});
setInterval(() => {}, 1000);
