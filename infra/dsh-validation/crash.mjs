import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, 'runtime', 'crash-' + Date.now());
mkdirSync(root, { recursive: true });
const key = process.env.DEEPSEEK_API_KEY ?? JSON.parse(readFileSync(resolve(import.meta.dirname, '../../server/.pi/agent/auth.json'), 'utf8')).deepseek.key;
const options = {
  profile: 'sdk', dshHome: resolve(root, 'home'), cwd: root, processCwd: root,
  model: 'deepseek-flash', reasoningEffort: 'off', maxTokens: 2048,
  initializeTimeoutMs: 30000, requestTimeoutMs: 60000,
  env: { ...process.env, DEEPSEEK_API_KEY: key },
};
const results = [];
function record(test, data) {
  const row = { test, at: new Date().toISOString(), ...data };
  results.push(row); console.log(JSON.stringify(row));
  writeFileSync(resolve(root, 'results.json'), JSON.stringify(results, null, 2));
}
let h = new DeepSeekHarness(options);
const sessionId = 'point-crash-' + Date.now();
console.log('Evidence directory: ' + root);
try {
  await h.start();
  await h.client.prompt(sessionId, [{ type: 'text', text: `Controlled crash test. Execute exactly this one foreground shell command in ${root}: echo started > crash.started; sleep 15; echo done > crash.done . The final dot is sentence punctuation, not part of the command. Do not delegate or background. Then reply DONE.` }]);
  const start = Date.now();
  while (!existsSync(resolve(root, 'crash.started'))) {
    if (Date.now() - start > 45000) throw new Error('command did not start');
    await delay(100);
  }
  const children = execFileSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(m => m && Number(m[2]) === process.pid && m[3].includes('/dsh/'));
  assert.equal(children.length, 1, 'identify only our DSH subprocess');
  const pid = Number(children[0][1]);
  process.kill(pid, 'SIGKILL');
  await delay(300);
  await h.close();
  record('sigkill-runtime', { pid, commandStarted: true, doneImmediately: existsSync(resolve(root, 'crash.done')) });
  h = new DeepSeekHarness(options);
  const resumed = await h.resumeSession(sessionId);
  record('resume-after-sigkill', { pass: true });
  await delay(17000);
  record('external-command-after-sigkill', { doneFileExists: existsSync(resolve(root, 'crash.done')) });
  const response = await resumed.run('Do not use tools or retry anything. Briefly report the last requested command and whether your recorded history confirms successful completion.');
  record('history-after-sigkill', { response: response.finalResponse });
} catch (e) {
  record('failure', { error: e.name, message: e.message });
  process.exitCode = 1;
} finally {
  await h.close();
}
