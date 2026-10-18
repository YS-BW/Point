import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { api, delay } from '../src/util.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const RUN_DIR = join(ROOT, 'runtime', `tests-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(RUN_DIR, { recursive: true });
export const get = (daemon, path = '/state') => api(daemon.url + path);
export const post = (daemon, path, body) => api(daemon.url + path, 'POST', body);

export async function until(read, check, timeout = 12000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await read();
    if (check(last)) return last;
    await delay(15);
  }
  throw new Error(`Condition timed out: ${JSON.stringify(last).slice(0,3000)}`);
}

export async function stop(daemon, signal = 'SIGTERM') {
  if (daemon.child.exitCode !== null || daemon.child.signalCode !== null) return;
  const exited = once(daemon.child, 'exit');
  daemon.child.kill(signal);
  const timer = setTimeout(() => daemon.child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

export async function launch(t, { directory, fault, sink, unsafe = false, model, auth, script = 'server.mjs', extra = [] } = {}) {
  directory ??= join(RUN_DIR, crypto.randomUUID());
  await mkdir(directory, { recursive: true });
  const args = ['--port', '0', '--data', script === 'sink.mjs' ? join(directory, 'sink.sqlite') : directory];
  if (fault) args.push('--fault', fault);
  if (sink) args.push('--sink', sink.url);
  if (unsafe) args.push('--unsafe-delivery');
  if (model) args.push('--model', model);
  if (auth) args.push('--auth', auth);
  args.push(...extra);
  const child = fork(join(ROOT, 'src', script), args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const daemon = { child, directory, messages: [], output: '', url: undefined };
  child.stdout.on('data', chunk => { daemon.output += chunk; });
  child.stderr.on('data', chunk => { daemon.output += chunk; });
  child.on('message', message => { daemon.messages.push(message); });
  t.after(() => stop(daemon));
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Server startup timeout: ${daemon.output}`)); }, 8000);
    child.once('error', reject);
    child.on('message', message => {
      if (message.event === 'ready') { clearTimeout(timeout); daemon.url = message.url; resolveReady(); }
    });
    child.once('exit', code => { clearTimeout(timeout); if (!daemon.url) reject(new Error(`Server exited ${code}: ${daemon.output}`)); });
  });
  return daemon;
}

export async function faultReached(daemon, point) {
  return until(async () => daemon.messages, messages => messages.some(message => message.event === 'fault' && message.point === point));
}

export async function jobDone(daemon, id, timeout) {
  return until(() => get(daemon, `/jobs/${id}`), job => {
    if (job.status === 'failed' || job.runtimeState?.outcome?.status === 'faulted' || job.runtimeState?.outcome?.status === 'failed') {
      throw new Error(`Job failed: ${JSON.stringify(job)}`);
    }
    return job.status === 'done';
  }, timeout);
}

export async function cli(daemon, ...args) {
  return new Promise((resolveCli, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'src/cli.mjs'), '--url', daemon.url, '--json', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', error = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`CLI failed ${code}: ${error}`));
      else { try { resolveCli(JSON.parse(out)); } catch { reject(new Error(`CLI invalid JSON: ${out}`)); } }
    });
  });
}
