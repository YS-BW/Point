import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, 'runtime/smoke');
mkdirSync(root, { recursive: true });
const key = process.env.DEEPSEEK_API_KEY ?? JSON.parse(readFileSync(resolve(import.meta.dirname, '../../server/.pi/agent/auth.json'), 'utf8')).deepseek.key;
const harness = new DeepSeekHarness({
  profile: 'sdk', dshHome: resolve(root, 'home'), cwd: root, processCwd: root,
  model: 'deepseek-flash', reasoningEffort: 'off', maxTokens: 2048,
  initializeTimeoutMs: 30000, requestTimeoutMs: 90000,
  env: { ...process.env, DEEPSEEK_API_KEY: key },
});
try {
  await harness.start();
  console.log('INITIALIZE_OK');
  const result = await harness.run('Reply with exactly POINT_DSH_OK. Do not use tools.');
  console.log(JSON.stringify({ sessionId: result.sessionId, response: result.finalResponse, events: result.events.length }));
} finally {
  await harness.close();
}
