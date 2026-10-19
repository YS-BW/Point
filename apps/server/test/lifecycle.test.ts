import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, defineDoc, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { startServer } from '../src/bootstrap.js';
import { openRuntime } from '../src/runtime/open.js';
import { readConfig } from '../src/config.js';
import { Meta } from '../src/storage/meta.js';

const disposers = new WeakMap<TestContext, (() => unknown | Promise<unknown>)[]>();
function cleanup(t: TestContext, dispose: () => unknown | Promise<unknown>) {
  let stack = disposers.get(t);
  if (!stack) {
    stack = []; disposers.set(t, stack);
    t.after(async () => {
      const errors: unknown[] = [];
      for (const release of [...(disposers.get(t) ?? [])].reverse()) {
        try { await release(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
    });
  }
  stack.push(dispose);
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'point-foundation-'));
  cleanup(t, () => rm(dir, {recursive: true, force: true}));
  return dir;
}
const config = (dataDir: string) => ({host: '127.0.0.1' as const, port: 0, dataDir});
async function edit(dir: string, fn: (h: Harness) => Promise<void>) {
  const h = await Harness.open(await openNodeSqliteStorage(join(dir, 'state.sqlite')), {models: createModels(), registry: createRegistry()}, BACKGROUND_CONTEXT);
  try { await fn(h); } finally { await h.close(BACKGROUND_CONTEXT); }
}
test('configuration rejects external host, invalid port and blank directory', () => {
  for (const env of [{POINT_HOST: '0.0.0.0'}, {POINT_PORT: '-1'}, {POINT_PORT: '65536'}, {POINT_PORT: '3.2'}, {POINT_DATA_DIR: ' '}]) assert.throws(() => readConfig(env));
  assert.equal(readConfig({}).host, '127.0.0.1');
});
test('runtime preserves identity and excludes a second owner; close is idempotent', async t => {
  const dir = await fixture(t);
  const first = await openRuntime(dir); cleanup(t, () => first.close());
  await assert.rejects(openRuntime(dir), /DATA_DIR_BUSY/);
  await Promise.all([first.close(), first.close()]);
  const second = await openRuntime(dir); cleanup(t, () => second.close());
  assert.equal(second.instanceId, first.instanceId);
});
test('unrecognized populated storage is refused and owner released', async t => {
  const dir = await fixture(t);
  await edit(dir, async h => { await h.root(BACKGROUND_CONTEXT); });
  await assert.rejects(openRuntime(dir), /UNRECOGNIZED_DATA/);
  await assert.rejects(openRuntime(dir), /UNRECOGNIZED_DATA/);
});
test('unsupported metadata is not rewritten on failed startup', async t => {
  const dir = await fixture(t); const runtime = await openRuntime(dir); await runtime.close();
  await edit(dir, async h => { await h.commit(async tx => { (await tx.doc(Meta)).format = 999; }, BACKGROUND_CONTEXT); });
  await assert.rejects(openRuntime(dir), /UNSUPPORTED_DATA_FORMAT/);
  await edit(dir, async h => { assert.equal((await h.snapshot(Meta, BACKGROUND_CONTEXT))?.format, 999); });
});
test('health is truthful and unsupported routes and methods are rejected', async t => {
  const app = await startServer(config(await fixture(t))); cleanup(t, () => app.close());
  const base = `http://127.0.0.1:${app.port}`;
  for (const path of ['/health/live', '/health/ready']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {phase: 'ready', capabilities: ['foundation']});
  }
  assert.equal((await fetch(base + '/v1/agent')).status, 404);
  assert.equal((await fetch(base + '/health/live', {method: 'POST'})).status, 405);
});
test('failed HTTP bind releases storage ownership', async t => {
  const first = await startServer(config(await fixture(t))); cleanup(t, () => first.close());
  const dir = await fixture(t);
  await assert.rejects(startServer({...config(dir), port: first.port}));
  const next = await openRuntime(dir); await next.close();
});
test('SIGKILL releases directory ownership and restart preserves identity', {timeout: 15000}, async t => {
  const dir = await fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {openRuntime} from ${JSON.stringify(new URL('../src/runtime/open.js', import.meta.url).href)}; const r=await openRuntime(process.argv[1]); console.log(r.instanceId); setInterval(()=>{},1000);`, dir], {stdio: ['ignore','pipe','pipe']});
  cleanup(t, () => { child.kill('SIGKILL'); });
  const identity = await new Promise<string>((resolve, reject) => {
    child.stdout.once('data', chunk => resolve(String(chunk).trim()));
    child.once('error', reject); child.once('exit', () => reject(new Error('Child exited before ready')));
  });
  await assert.rejects(openRuntime(dir), /DATA_DIR_BUSY/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const reopened = await openRuntime(dir); cleanup(t, () => reopened.close());
  assert.equal(reopened.instanceId, identity);
});

test('foreign session-only documents are not adopted', async t => {
  const dir = await fixture(t);
  const Foreign = defineDoc({kind: 'foreign', version: 1, scope: 'session', initial: () => ({value: true})});
  await edit(dir, async h => { await h.commit(async tx => { await tx.doc(Foreign); }, BACKGROUND_CONTEXT); });
  await assert.rejects(openRuntime(dir), /UNRECOGNIZED_DATA/);
});
test('interrupted initialization cannot leave a root without metadata', {timeout: 15000}, async t => {
  const dir = await fixture(t);
  const script = `
    import { BACKGROUND_CONTEXT as c } from '@earendil-works/chord/context';
    import { createModels } from '@earendil-works/pi-ai/models';
    import { Harness, createRegistry } from '@earendil-works/pi-durable';
    import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
    import { Meta } from ${JSON.stringify(new URL('../src/storage/meta.js', import.meta.url).href)};
    const h = await Harness.open(await openNodeSqliteStorage(process.argv[1]), {models:createModels(),registry:createRegistry()}, c);
    await h.root(c, {init: async tx => { (await tx.doc(Meta)).instanceId='uncommitted'; process.kill(process.pid,'SIGKILL'); }});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(dir,'state.sqlite')], {stdio: 'ignore'});
  cleanup(t, () => { child.kill('SIGKILL'); });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  const reopened = await openRuntime(dir); cleanup(t, () => reopened.close());
  assert.notEqual(reopened.instanceId, 'uncommitted');
});
test('entrypoint handles SIGTERM and logs no supplied config value', {timeout: 15000}, async t => {
  const dir = await fixture(t);
  const child = spawn(process.execPath, [new URL('../src/main.js', import.meta.url).pathname], {
    env: {...process.env, POINT_HOST: '127.0.0.1', POINT_PORT: '0', POINT_DATA_DIR: dir}, stdio: ['ignore', 'pipe', 'ignore'],
  });
  cleanup(t, () => { child.kill('SIGKILL'); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', data => { assert.equal(JSON.parse(String(data)).event, 'server.ready'); resolve(); });
    child.once('error', reject); child.once('exit', () => reject(new Error('Exited before ready')));
  });
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
  const runtime = await openRuntime(dir); await runtime.close();
  const bad = spawn(process.execPath, [new URL('../src/main.js', import.meta.url).pathname], {
    env: {...process.env, POINT_PORT: 'private-invalid-input'}, stdio: ['ignore', 'pipe', 'ignore'],
  });
  let output = ''; bad.stdout.on('data', chunk => { output += String(chunk); });
  assert.equal((await once(bad, 'exit'))[0], 1);
  assert.equal(output.includes('private-invalid-input'), false);
  assert.equal(JSON.parse(output).event, 'server.start_failed');
});

test('unknown database is rejected before SDK writes to it', async t => {
  const dir = await fixture(t); const path = join(dir, 'state.sqlite');
  const db = new DatabaseSync(path); db.exec("CREATE TABLE personal_data(value TEXT); INSERT INTO personal_data VALUES ('unchanged')"); db.close();
  const before = await readFile(path);
  await assert.rejects(openRuntime(dir), /UNRECOGNIZED_STORAGE/);
  assert.deepEqual(await readFile(path), before);
  await assert.rejects(openRuntime(dir), /UNRECOGNIZED_STORAGE/);
});
test('older and newer SDK schemas require explicit migration before writable open', async t => {
  for (const version of [0, 2]) {
    const dir = await fixture(t); const path = join(dir, 'state.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE durable_schema(singleton INTEGER PRIMARY KEY, version INTEGER)');
    db.prepare('INSERT INTO durable_schema VALUES (1, ?)').run(version); db.close();
    const before = await readFile(path);
    await assert.rejects(openRuntime(dir), /STORAGE_UPGRADE_REQUIRED/);
    assert.deepEqual(await readFile(path), before);
  }
});

test('unexpected runtime termination closes HTTP and reports failure', async t => {
  let terminate!: () => void; let closes = 0;
  const closed = new Promise<void>(resolve => { terminate = resolve; });
  const app = await startServer(config(await fixture(t)), async () => ({
    instanceId: 'fixture', closed, close: async () => { closes++; terminate(); },
  }));
  cleanup(t, () => app.close());
  terminate();
  assert.equal(await app.closed, 'failed');
  assert.equal(closes, 1);
  await assert.rejects(fetch(`http://127.0.0.1:${app.port}/health/ready`));
});
test('runtime already closed during startup cannot report readiness', async t => {
  let closes = 0;
  await assert.rejects(startServer(config(await fixture(t)), async () => ({
    instanceId: 'fixture', closed: Promise.resolve(), close: async () => { closes++; },
  })), /RUNTIME_CLOSED_DURING_STARTUP/);
  assert.equal(closes, 1);
});
test('shutdown failure is observable and concurrent close only disposes once', async t => {
  let closes = 0;
  const app = await startServer(config(await fixture(t)), async () => ({
    instanceId: 'fixture', closed: new Promise<void>(() => {}),
    close: async () => { closes++; throw new Error('private runtime detail'); },
  }));
  await Promise.all([app.close(), app.close()]);
  assert.equal(await app.closed, 'failed'); assert.equal(closes, 1);
});
