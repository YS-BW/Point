import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const runId = new Date().toISOString().replaceAll(':', '-');
const root = resolve(import.meta.dirname, 'runtime', runId);
mkdirSync(root, { recursive: true });
const key = process.env.DEEPSEEK_API_KEY ?? JSON.parse(readFileSync(resolve(import.meta.dirname, '../../server/.pi/agent/auth.json'), 'utf8')).deepseek.key;
const notes = [];
const events = [];
const report = (test, data) => {
  const row = { test, at: new Date().toISOString(), ...data };
  notes.push(row);
  writeFileSync(resolve(root, 'results.json'), JSON.stringify(notes, null, 2));
  console.log(JSON.stringify(row));
};
const observe = notification => {
  const row = { at: Date.now(), ...notification };
  events.push(row);
  appendFileSync(resolve(root, 'events.jsonl'), JSON.stringify(row) + '\n');
};
const options = {
  profile: 'sdk', dshHome: resolve(root, 'home'), cwd: root, processCwd: root,
  model: 'deepseek-flash', reasoningEffort: 'off', maxTokens: 3072,
  initializeTimeoutMs: 30000, requestTimeoutMs: 120000,
  env: { ...process.env, DEEPSEEK_API_KEY: key },
};
const create = () => new DeepSeekHarness(options);
const until = async (predicate, label, timeout = 60000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out: ' + label);
    await delay(100);
  }
};
const prompt = (h, sessionId, input) => h.client.prompt(sessionId, [{ type: 'text', text: input }]);
const token = 'POINT_' + randomUUID().replaceAll('-', '');
const sessionId = 'point-main-' + randomUUID();
let h = create();
let subscription;
let reader;
function startReader() {
  subscription = h.client.subscribe();
  reader = (async () => { try { for await (const n of subscription) observe(n); } catch (e) { report('subscription-ended', { error: e.name }); } })();
}

console.log('Evidence directory: ' + root);
try {
  const initial = await h.run(`Remember this synthetic test token in this conversation: ${token}. Reply only SAVED. Do not use tools.`, { sessionId });
  assert.match(initial.finalResponse, /SAVED/);
  report('headless-real-model', { pass: true, sessionId, response: initial.finalResponse });
  await h.close();
  h = create();
  const restored = await h.resumeSession(sessionId);
  const recall = await restored.run('What synthetic test token did I give you? Reply only with the token. Do not use tools.');
  assert.ok(recall.finalResponse.includes(token));
  report('restart-history', { pass: true, response: recall.finalResponse });

  startReader();
  await prompt(h, sessionId, `This is a controlled SDK concurrency test. Delegate exactly one subagent, without waiting for it. Its task: use a shell command to write child.started in the current working directory, then sleep 30 seconds, then write child.done; finally reply CHILD_DONE. Do not spawn grandchildren. You, the parent, should immediately reply DELEGATED and remain available for further messages; do not poll or wait for the child. All files must stay in ${root}.`);
  await until(() => existsSync(resolve(root, 'child.started')), 'child real tool started');
  await until(() => events.some(n => n.method === 'session.event' && n.params.sessionId !== sessionId && n.params.event.type === 'job/registered' && JSON.stringify(n.params.event.data).includes('sleep 30')), 'child long shell job registered');
  const pingSentAt = Date.now();
  await prompt(h, sessionId, 'While the child continues, answer this unrelated message immediately with exactly MAIN_PONG. Do not wait for the child and do not use tools.');
  await until(() => events.some(n => n.at >= pingSentAt && n.method === 'session.event' && n.params.sessionId === sessionId && n.params.event.type === 'assistant/message' && JSON.stringify(n.params.event.data).includes('MAIN_PONG')), 'main response during child');
  const beforeChildDone = !existsSync(resolve(root, 'child.done'));
  report('main-responsive-during-subagent', { pass: beforeChildDone, latencyMs: Date.now() - pingSentAt, subagentsStarted: events.filter(n => n.method === 'subagent.started').length });
  assert.ok(beforeChildDone, 'main reply must precede child completion');
  await h.client.request('session/wait', { sessionId });
  report('subagent-completion', { pass: existsSync(resolve(root, 'child.done')), finishedNotifications: events.filter(n => n.method === 'subagent.finished').length });
  assert.ok(existsSync(resolve(root, 'child.done')), 'child must execute its actual shell task');

  const slowId = 'point-cancel-' + randomUUID();
  await prompt(h, slowId, `Controlled cancellation test: execute one foreground shell command that writes cancel.started, sleeps 30 seconds, then writes cancel.done. Use this exact directory ${root}. Do not run it in the background. Afterward reply CANCEL_WORK_DONE.`);
  await until(() => existsSync(resolve(root, 'cancel.started')), 'cancellation target active');
  for (const method of ['session/cancel', 'session/close']) {
    try {
      const result = await h.client.request(method, { sessionId: slowId }, 5000);
      report(method, { supported: true, result });
    } catch (e) {
      report(method, { supported: false, error: e.name, code: e.code, message: e.message });
    }
  }
  const live = await h.run('Reply only STILL_ALIVE. Do not use tools.', { sessionId });
  report('other-session-after-cancel-request', { pass: live.finalResponse.includes('STILL_ALIVE'), targetStillIncomplete: !existsSync(resolve(root, 'cancel.done')) });
  await h.close();
  await reader;
  report('runtime-closed-during-tool', { incomplete: !existsSync(resolve(root, 'cancel.done')) });
  h = create();
  const resumed = await h.resumeSession(slowId);
  // Restoration itself must not replay the command.
  await delay(2000);
  report('interrupted-session-restored', { pass: true, automaticallyFinished: existsSync(resolve(root, 'cancel.done')) });
  const after = await resumed.run('Do not use any tools or continue the prior shell command. Briefly report what was requested and whether its completion is confirmed by your history.');
  report('interrupted-session-followup', { response: after.finalResponse });
  await h.close();
  // Observe past the original sleep deadline to detect an orphaned command.
  await delay(31000);
  report('external-command-after-close', { doneFileExists: existsSync(resolve(root, 'cancel.done')) });
} catch (e) {
  report('failure', { error: e.name, message: e.message });
  process.exitCode = 1;
} finally {
  await h.close();
  if (reader) await reader;
  writeFileSync(resolve(import.meta.dirname, 'runtime/latest.json'), JSON.stringify({ root, runId }, null, 2));
}
