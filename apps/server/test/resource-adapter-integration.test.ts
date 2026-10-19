import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  createRegistry, Harness, MemoryStorage, type ConversationId, type TaskId,
} from '@earendil-works/pi-durable';
import {
  createEffectRegistry, type EffectRegistry, type RegisteredEffect,
} from '../src/application/resource.js';
import {
  notificationOutcome, type NotificationRequest, type NotificationPort,
} from '../src/application/delivery.js';
import { ResourceError, type Resource, type SecureResourceOperation } from '../src/domain/resource.js';
import { initialDelivery, type Delivery } from '../src/domain/delivery.js';
import type { Job } from '../src/domain/job.js';
import { Deliveries } from '../src/storage/delivery.js';
import { Jobs } from '../src/storage/job.js';
import { deliveryRuntime } from '../src/runtime/deliveries.js';
import { openRuntime, type Runtime } from '../src/runtime/open.js';
import {
  artifactCommandsForHarness, artifactDirectoryName, artifactPath, sha256Hex, workspaceDir,
} from '../src/runtime/artifacts.js';
import { ArtifactError } from '../src/domain/artifact.js';
import {
  FILE_EFFECT_KIND, MAX_FILE_BYTES, createFileResourceAdapter, createFileResourceEffect,
  type FileAdapterHooks, type FileResourceAdapter,
} from '../src/adapters/resource/files.js';
import { createCdpEffects, type CdpTransport } from '../src/adapters/resource/cdp.js';
import {
  createHttpNotificationAdapter, HttpNotificationConfigError,
} from '../src/adapters/notification/http.js';
import {
  createFileOutboxNotificationAdapter, FileOutboxConfigError, outboxRecordPath, readOutboxRecord,
} from '../src/adapters/notification/file-outbox.js';

const RESOURCE_ID = 'file:primary';
const OWNER = 'owner-a';
const OTHER_OWNER = 'owner-b';

function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ResourceError, `expected ResourceError(${code}), got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

async function directory(t: TestContext, prefix = 'point-adapter-integration-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

/** An explicit, existing canonical root; the file adapter fails closed when the root is absent. */
async function fileRoot(dir: string, name = 'root'): Promise<string> {
  const root = join(dir, name);
  await mkdir(root, {recursive: true, mode: 0o700});
  return root;
}

async function secureRuntime(dir: string, effects: readonly RegisteredEffect[]): Promise<Runtime> {
  return openRuntime(dir, undefined, {resources: {effects: createEffectRegistry(effects)}});
}

function registryOf(effects: readonly RegisteredEffect[]): EffectRegistry {
  return createEffectRegistry(effects);
}

async function acquire(runtime: Runtime, overrides: Readonly<Record<string, unknown>> = {}): Promise<Resource> {
  return runtime.resources.acquire({
    resourceId: RESOURCE_ID, requestId: `acquire-${randomUUID()}`, owner: OWNER, ttlMs: 600_000, ...overrides,
  });
}

const filePayload = (path: string, content: string) => ({
  path, content, sha256: sha256Hex(content), bytes: Buffer.byteLength(content, 'utf8'),
});

async function beginFile(
  runtime: Runtime, resource: Resource, payload: Readonly<Record<string, unknown>>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return runtime.resources.beginOperation({
    operationId: `op-${randomUUID()}`, requestId: `req-${randomUUID()}`, resourceId: RESOURCE_ID,
    controlEpoch: resource.controlEpoch,
    effect: {kind: FILE_EFFECT_KIND, payload},
    deadline: Date.now() + 60_000,
    ...overrides,
  });
}

function assertSecure(operation: {effect?: unknown}): asserts operation is SecureResourceOperation {
  assert.ok(operation.effect, 'the secure operation persists its effect binding');
}

/** A fake CDP transport that answers frames and can emit a disconnect. */
class FakeTransport implements CdpTransport {
  sent: string[] = [];
  screenshotData = 'aGVsbG8=';
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as {id: number; method: string};
    queueMicrotask(() => this.emit('message', {
      data: JSON.stringify({
        id: frame.id,
        result: frame.method === 'Page.captureScreenshot' ? {data: this.screenshotData}
          : frame.method === 'Runtime.evaluate' ? {result: {type: 'string', value: 'ok'}} : {frameId: 'f'},
      }),
    }));
  }
  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  close(): void { this.emit('close'); }
}

/** Fire-and-forget HTTP notification endpoint for classification tests. */
async function httpServer(
  t: TestContext, handler: (path: string, request: IncomingMessage, response: ServerResponse) => void,
) {
  const requests: {path: string; headers: IncomingMessage['headers']; body: string}[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({path: request.url ?? '', headers: request.headers, body});
      handler(request.url ?? '', request, response);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  t.after(() => {
    if (server.listening) {
      server.closeAllConnections();
      server.close();
    }
  });
  return {url: `http://127.0.0.1:${port}`, requests};
}

const notificationRequest = (overrides: Partial<NotificationRequest> = {}): NotificationRequest => ({
  deliveryId: 'delivery-1', target: 'test', title: '季度提醒', text: '报告已完成', ...overrides,
});

/* -------------------------------------------------------------------------- */
/* P0-1: payload/effect binding                                               */
/* -------------------------------------------------------------------------- */

test('P0-1 a secure operation cannot substitute its bound effect payload', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const root = await fileRoot(dir);
  const registered = await createFileResourceEffect(root);
  const runtime = await secureRuntime(dir, [registered]);
  try {
    const resource = await acquire(runtime);
    const input = {
      operationId: 'op-1', requestId: 'req-1', resourceId: RESOURCE_ID, controlEpoch: resource.controlEpoch,
      effect: {kind: FILE_EFFECT_KIND, payload: filePayload('a.txt', 'one')}, deadline: Date.now() + 60_000,
    };
    const operation = await runtime.resources.beginOperation(input);
    assertSecure(operation);
    assert.equal(operation.state, 'intent');
    assert.equal(operation.effect.kind, FILE_EFFECT_KIND);
    assert.equal(typeof operation.effect.payloadHash, 'string');
    assert.equal(await readdir(root).catch(() => []).then(entries => entries.length), 0, 'begin never writes the file');

    // Same key with a different payload is an idempotency conflict, never a silent substitution.
    await assert.rejects(runtime.resources.beginOperation({
      ...input,
      effect: {kind: FILE_EFFECT_KIND, payload: filePayload('b.txt', 'two')},
    }), hasCode('IDEMPOTENCY_CONFLICT'));
    // A payload that contradicts its own hash/bytes is rejected before any Durable intent.
    await assert.rejects(runtime.resources.beginOperation({
      ...input, operationId: 'op-2', requestId: 'req-2',
      effect: {kind: FILE_EFFECT_KIND, payload: {...filePayload('c.txt', 'three'), sha256: 'f'.repeat(64)}},
    }), hasCode('PAYLOAD_REJECTED'));

    const done = await runtime.resources.runOperation(operation.id);
    assert.equal(done.state, 'done');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'one');
    assert.deepEqual(await readdir(root), ['a.txt']);
  } finally {
    await runtime.close();
  }
});

/* -------------------------------------------------------------------------- */
/* P0-2: stale lease/epoch cancels before any adapter action                  */
/* -------------------------------------------------------------------------- */

test('P0-2 takeover before dispatch cancels file and CDP effects with zero side effects', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const root = await fileRoot(dir);
  const fileEffect = await createFileResourceEffect(root);
  const transport = new FakeTransport();
  const cdpEffects = createCdpEffects({endpoint: 'ws://127.0.0.1:9222/devtools', transportFactory: () => transport});
  const effects = [fileEffect, ...cdpEffects];
  const runtime = await secureRuntime(dir, effects);
  try {
    const resource = await acquire(runtime);
    const fileOperation = await beginFile(runtime, resource, filePayload('stale.txt', 'stale'));
    const cdpOperation = await runtime.resources.beginOperation({
      operationId: 'op-cdp', requestId: 'req-cdp', resourceId: RESOURCE_ID,
      controlEpoch: resource.controlEpoch,
      effect: {kind: 'cdp.navigate', payload: {url: 'https://example.test'}}, deadline: Date.now() + 60_000,
    });
    const taken = await runtime.resources.takeover({
      resourceId: RESOURCE_ID, requestId: 'take', owner: OTHER_OWNER, ttlMs: 600_000,
    });
    assert.equal(taken.controlEpoch, resource.controlEpoch + 1);

    await assert.rejects(runtime.resources.runOperation(fileOperation.id),
      hasCode('STALE_CONTROL'));
    await assert.rejects(runtime.resources.runOperation(cdpOperation.id),
      hasCode('STALE_CONTROL'));
    assert.deepEqual(await readdir(root).catch(() => []), [], 'the file effect never ran');
    assert.equal(transport.sent.length, 0, 'no CDP frame was sent after the epoch changed');
    // The cancelled operations are terminal failed; a retry re-reads state and dispatches nothing.
    assert.equal((await runtime.resources.runOperation(fileOperation.id)).state, 'failed');
    assert.equal(transport.sent.length, 0);
  } finally {
    await runtime.close();
  }
});

/* -------------------------------------------------------------------------- */
/* P0-3: live attempt is never mis-reconciled by a concurrent caller          */
/* -------------------------------------------------------------------------- */

test('P0-3 a live concurrent attempt returns IN_PROGRESS and writes once', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const root = await fileRoot(dir);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const hooks: FileAdapterHooks = {
    async beforeRename() { entered(); await gate; },
  };
  const registered = await createFileResourceEffect(root, {hooks});
  const runtime = await secureRuntime(dir, [registered]);
  try {
    const resource = await acquire(runtime);
    const operation = await beginFile(runtime, resource, filePayload('once.txt', 'only once'));
    const first = runtime.resources.runOperation(operation.id);
    await enteredPromise;
    await assert.rejects(runtime.resources.runOperation(operation.id),
      hasCode('IN_PROGRESS'), 'a live attempt is never converted to unknown by a second caller');
    release();
    const done = await first;
    assert.equal(done.state, 'done');
    assert.deepEqual(await readdir(root), ['once.txt']);
    assert.equal(await readFile(join(root, 'once.txt'), 'utf8'), 'only once');
  } finally {
    await runtime.close();
  }
});

/* -------------------------------------------------------------------------- */
/* P0-4: unknown reconciliation is observer/epoch/payloadHash/evidence bound  */
/* -------------------------------------------------------------------------- */

test('P0-4 forged file evidence cannot settle an unknown operation', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const root = await fileRoot(dir);
  let thrown = false;
  const hooks: FileAdapterHooks = {
    async afterRename() {
      if (!thrown) {
        thrown = true;
        throw new Error('simulated crash after rename');
      }
    },
  };
  const registered = await createFileResourceEffect(root, {hooks});
  const runtime = await secureRuntime(dir, [registered]);
  try {
    const resource = await acquire(runtime);
    const adapter: FileResourceAdapter = await createFileResourceAdapter(root, runtime.resources, {hooks});
    const operation = await beginFile(runtime, resource, filePayload('report.txt', 'content'));
    const unknown = await runtime.resources.runOperation(operation.id);
    assert.equal(unknown.state, 'unknown', 'a post-rename crash is unknown, never success');
    assertSecure(unknown);
    assert.equal(await readFile(join(root, 'report.txt'), 'utf8'), 'content');

    const evidence = {
      kind: 'file', path: 'report.txt', exists: true, regular: true,
      sha256: sha256Hex('content'), bytes: Buffer.byteLength('content', 'utf8'),
    };
    const observe = (overrides: Readonly<Record<string, unknown>>) => runtime.resources.observeOperation({
      operationId: operation.id, status: 'done', evidence,
      observer: OWNER, payloadHash: unknown.effect.payloadHash, controlEpoch: resource.controlEpoch,
      ...overrides,
    });
    await assert.rejects(observe({payloadHash: 'b'.repeat(64)}), hasCode('INVALID_EVIDENCE'));
    await assert.rejects(observe({observer: OTHER_OWNER}), hasCode('STALE_CONTROL'));
    await assert.rejects(observe({controlEpoch: resource.controlEpoch + 1}), hasCode('STALE_CONTROL'));
    await assert.rejects(observe({evidence: {}}), hasCode('INVALID_EVIDENCE'));
    await assert.rejects(observe({evidence: {...evidence, extra: true}}), hasCode('INVALID_EVIDENCE'));

    // The rejected forgeries never changed the durable state, and the real observation path still works.
    assert.equal((await runtime.resources.runOperation(operation.id)).state, 'unknown');
    const reconciled = await adapter.reconcile({operationId: operation.id, owner: OWNER});
    assert.equal(reconciled.state, 'done');
    assert.equal((await runtime.resources.runOperation(operation.id)).state, 'done');
  } finally {
    await runtime.close();
  }
});

/* -------------------------------------------------------------------------- */
/* P0-5: symlink traversal / replacement never escapes the canonical root     */
/* -------------------------------------------------------------------------- */

test('P0-5 symlinked parents and targets are rejected without writing outside the root', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const root = await fileRoot(dir);
  const outside = join(dir, 'outside');
  const outsideFile = join(outside, 'escaped.txt');
  const registered = await createFileResourceEffect(root);
  const runtime = await secureRuntime(dir, [registered]);
  try {
    const destination = join(outside, 'sentinel.txt');
    await mkdir(outside, {recursive: true});
    await writeFile(destination, 'outside-sentinel');
    await symlink(outside, join(root, 'linked'), 'dir');
    await symlink(destination, join(root, 'target.txt'));
    const resource = await acquire(runtime);

    // A parent component that is a symlink is rejected before any file is created outside the root.
    const throughLink = await beginFile(runtime, resource, filePayload('linked/escaped.txt', 'escape'));
    const failedLink = await runtime.resources.runOperation(throughLink.id);
    assert.equal(failedLink.state, 'failed');
    assert.match(String(failedLink.result), /FILE_SYMLINK_REJECTED|FILE_PATH_REJECTED|FILE_IO/);
    assert.equal(await readFile(outsideFile, 'utf8').catch(() => 'missing'), 'missing');
    assert.equal(await readFile(destination, 'utf8'), 'outside-sentinel', 'the symlink target is untouched');

    // A target symlink is rejected and never replaced/overwritten.
    const overTarget = await beginFile(runtime, resource, filePayload('target.txt', 'overwrite'));
    const failedTarget = await runtime.resources.runOperation(overTarget.id);
    assert.equal(failedTarget.state, 'failed');
    assert.equal(await readFile(destination, 'utf8'), 'outside-sentinel');
  } finally {
    await runtime.close();
  }
});

/* -------------------------------------------------------------------------- */
/* P0-6: HTTP classification/redirect/secret isolation and the notify task    */
/* -------------------------------------------------------------------------- */

test('P0-6 HTTP outcomes are classified, redirects are not followed and secrets stay in headers', {timeout: 30000}, async t => {
  const server = await httpServer(t, (path, _request, response) => {
    if (path === '/delivered') { response.writeHead(202); response.end(); return; }
    if (path === '/failed') { response.writeHead(403); response.end(); return; }
    if (path === '/unknown') { response.writeHead(503); response.end(); return; }
    if (path === '/redirect') {
      response.writeHead(302, {location: 'https://evil.example.test/hook'});
      response.end();
      return;
    }
    if (path === '/echo') {
      response.writeHead(200); response.end('SECRET-ECHO-BODY'); return;
    }
    response.writeHead(404); response.end();
  });
  const token = 'super-secret-token';
  const portFor = (path: string, timeoutMs = 5_000) => createHttpNotificationAdapter({
    url: `${server.url}${path}`, token, timeoutMs,
  });
  const request = notificationRequest();

  const delivered = await portFor('/delivered').send(request);
  assert.deepEqual([notificationOutcome(delivered), (delivered as {status?: number}).status], ['delivered', 202]);
  const failed = await portFor('/failed').send(request);
  assert.deepEqual([notificationOutcome(failed), (failed as {code?: string}).code], ['failed', 'http-client-error']);
  const unknown = await portFor('/unknown').send(request);
  assert.deepEqual([notificationOutcome(unknown), (unknown as {code?: string}).code], ['unknown', 'http-server-error']);
  const redirect = await portFor('/redirect').send(request);
  assert.deepEqual([notificationOutcome(redirect), (redirect as {code?: string}).code], ['unknown', 'http-redirect']);
  // 404 is a deterministic client failure; unclassified statuses never become delivered.
  const notFound = await portFor('/missing').send(request);
  assert.deepEqual([notificationOutcome(notFound), (notFound as {code?: string}).code], ['failed', 'http-client-error']);

  // One POST per send; the token only travelled in the Authorization header.
  const sent = server.requests.filter(entry => entry.path !== '');
  assert.equal(sent.length, 5, 'redirects are not followed (still exactly one request each)');
  for (const entry of sent) {
    assert.equal(entry.headers.authorization, `Bearer ${token}`);
    assert.equal(entry.headers['idempotency-key'], request.deliveryId);
    assert.equal(entry.path.includes(token), false, 'the token never enters the URL');
  }
  const redirectRequest = server.requests.filter(entry => entry.path === '/redirect');
  assert.equal(redirectRequest.length, 1, 'the 302 target is never requested');
  const deliveredDetail = (delivered as {detail?: Record<string, unknown>}).detail;
  assert.deepEqual(deliveredDetail, {classification: 'delivered'}, 'detail is bounded and redacted');
  const redirected = JSON.stringify(redirect);
  assert.equal(redirected.includes('evil.example.test'), false, 'redirect targets are not echoed');
  // The response body is never read into the outcome.
  const echo = await portFor('/echo').send(request);
  assert.equal(JSON.stringify(echo).includes('SECRET-ECHO-BODY'), false);
  assert.equal(server.requests[0]?.body.includes(token), false, 'the token never enters the payload');
});

test('P0-6 the notify task normalizes HTTP results without persisting secrets', {timeout: 30000}, async t => {
  const server = await httpServer(t, (_path, _request, response) => {
    response.writeHead(500); response.end('provider-secret-body');
  });
  const token = 'delivery-secret-token';
  const port = createHttpNotificationAdapter({url: `${server.url}/hook`, token});
  const fixture = await deliveryFixture(t, port);
  await fixture.run('notify-1');
  const stored = await fixture.harness.snapshot(Deliveries, 'notify-1', context);
  // Structured HTTP audit is persisted redacted (outcome:code:status:classification), never the raw tri-state alone.
  assert.equal(stored?.status, 'unknown');
  const audit = String(stored?.error);
  for (const fragment of ['notification-unknown', 'http-server-error', '500', 'server']) {
    assert.ok(audit.includes(fragment), `Delivery.error must keep the redacted audit (${fragment}): ${audit}`);
  }
  const persisted = JSON.stringify(stored);
  assert.equal(persisted.includes(token), false, 'no token in Durable state');
  assert.equal(persisted.includes('provider-secret-body'), false, 'no provider body in Durable state');
  const job = await fixture.harness.snapshot(Jobs, 'job-1', context);
  assert.equal(job?.status, 'ready', 'a failed notification never changes the Job');
});

test('P0-6 file outbox is atomic, idempotent and detects conflicts/corruption', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const outbox = join(dir, 'outbox');
  const port = createFileOutboxNotificationAdapter({dir: outbox});
  const request = notificationRequest({deliveryId: 'delivery-outbox'});
  const first = await port.send(request);
  // B4 ruling: a local outbox record is `unknown` (local acceptance), never remote `delivered`.
  assert.deepEqual([notificationOutcome(first), (first as {code?: string}).code], ['unknown', 'outbox-written']);
  const recordPath = outboxRecordPath(outbox, request.deliveryId);
  const record = await readOutboxRecord(outbox, request.deliveryId);
  assert.equal(record?.deliveryId, request.deliveryId);
  assert.equal(record?.text, request.text);
  assert.equal((await readdir(outbox)).length, 1, 'one atomic record per delivery');
  // Replay and a fresh adapter over the same directory see the same single record.
  assert.equal(notificationOutcome(await port.send(request)), 'unknown');
  const reopened = createFileOutboxNotificationAdapter({dir: outbox});
  assert.equal(notificationOutcome(await reopened.send(request)), 'unknown');
  assert.equal((await readdir(outbox)).length, 1);
  // Same delivery id, different payload: deterministic conflict, original record kept.
  const conflict = await reopened.send({...request, text: 'different payload'});
  assert.deepEqual([notificationOutcome(conflict), (conflict as {code?: string}).code], ['failed', 'outbox-conflict']);
  assert.equal((await readOutboxRecord(outbox, request.deliveryId))?.text, request.text);
  // Corrupt record: failed deterministically, never thrown and never overwritten.
  await writeFile(recordPath, '{not json');
  const corrupt = await reopened.send(request);
  assert.deepEqual([notificationOutcome(corrupt), (corrupt as {code?: string}).code], ['failed', 'outbox-corrupt']);
  assert.deepEqual(await readdir(outbox), [`${request.deliveryId}.json`]);
});

/* -------------------------------------------------------------------------- */
/* P0-7: bounded payloads and results                                         */
/* -------------------------------------------------------------------------- */

test('P0-7 oversized CDP results become unknown and oversized file payloads are rejected', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const root = await fileRoot(dir);
  const transport = new FakeTransport();
  transport.screenshotData = 'a'.repeat(300_000); // default CDP result bound is 256 KiB
  const fileEffect = await createFileResourceEffect(root);
  const cdpEffects = createCdpEffects({endpoint: 'ws://127.0.0.1:9222/devtools', transportFactory: () => transport});
  const effects = [fileEffect, ...cdpEffects];
  const runtime = await secureRuntime(dir, effects);
  try {
    const resource = await acquire(runtime);
    const screenshot = await runtime.resources.beginOperation({
      operationId: 'op-screen', requestId: 'req-screen', resourceId: RESOURCE_ID,
      controlEpoch: resource.controlEpoch,
      effect: {kind: 'cdp.screenshot', payload: {format: 'png'}}, deadline: Date.now() + 60_000,
    });
    const bounded = await runtime.resources.runOperation(screenshot.id);
    assert.equal(bounded.state, 'unknown', 'an over-bounded result is never persisted as done');
    const frames = transport.sent.length;
    assert.equal((await runtime.resources.runOperation(screenshot.id)).state, 'unknown');
    assert.equal(transport.sent.length, frames, 'unknown is not replayed');
    // A file payload over the hard content bound is rejected before any intent or file.
    await assert.rejects(runtime.resources.beginOperation({
      operationId: 'op-big', requestId: 'req-big', resourceId: RESOURCE_ID, controlEpoch: resource.controlEpoch,
      effect: {kind: FILE_EFFECT_KIND, payload: filePayload('big.txt', 'x'.repeat(MAX_FILE_BYTES + 1))},
      deadline: Date.now() + 60_000,
    }), hasCode('PAYLOAD_REJECTED'));
    assert.deepEqual(await readdir(root).catch(() => []), []);
  } finally {
    await runtime.close();
  }
});

/* -------------------------------------------------------------------------- */
/* P0-8: explicit configuration and unknown no-replay across reopen           */
/* -------------------------------------------------------------------------- */

test('P0-8 every adapter fails closed without explicit configuration', {timeout: 30000}, async t => {
  await assert.rejects(createFileResourceEffect(''), /FILE_ROOT_REQUIRED/);
  assert.throws(() => createHttpNotificationAdapter({} as never), (error: unknown) =>
    error instanceof HttpNotificationConfigError && error.code === 'HTTP_NOTIFICATION_URL_REQUIRED');
  assert.throws(() => createFileOutboxNotificationAdapter({} as never), (error: unknown) =>
    error instanceof FileOutboxConfigError && error.code === 'OUTBOX_DIR_REQUIRED');
  assert.throws(() => createCdpEffects({endpoint: 'ws://10.0.0.1:9222'}), /INVALID_ENDPOINT/);
  // A runtime without an effects registry cannot create file intents at all.
  const dir = await directory(t);
  const runtime = await openRuntime(dir);
  try {
    const resource = await acquire(runtime);
    await assert.rejects(beginFile(runtime, resource, filePayload('x.txt', 'x')), hasCode('EFFECT_NOT_REGISTERED'));
  } finally {
    await runtime.close();
  }
});

test('P0-8 a file unknown survives reopen without replay and reconciles by observation', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const root = await fileRoot(dir);
  let writes = 0;
  const hooks: FileAdapterHooks = {
    async afterRename() { writes += 1; throw new Error('simulated crash after rename'); },
  };
  const registered = await createFileResourceEffect(root, {hooks});
  let runtime = await secureRuntime(dir, [registered]);
  let operationId: string;
  try {
    const resource = await acquire(runtime);
    const operation = await beginFile(runtime, resource, filePayload('durable.txt', 'durable'));
    operationId = operation.id;
    assert.equal((await runtime.resources.runOperation(operation.id)).state, 'unknown');
    assert.equal(writes, 1);
  } finally {
    await runtime.close();
  }

  runtime = await secureRuntime(dir, [registered]);
  try {
    const recovered = await runtime.resources.runOperation(operationId);
    assert.equal(recovered.state, 'unknown', 'unknown survives reopen');
    assert.equal(writes, 1, 'reopen never replays the effect');
    assert.deepEqual(await readdir(root), ['durable.txt']);
    assert.equal(await readFile(join(root, 'durable.txt'), 'utf8'), 'durable');
    const adapter = await createFileResourceAdapter(root, runtime.resources, {hooks});
    const reconciled = await adapter.reconcile({operationId, owner: OWNER});
    assert.equal(reconciled.state, 'done');
    assert.equal(writes, 1, 'observation settles the unknown without a second write');
  } finally {
    await runtime.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Delivery runtime fixture for notification adapters                         */
/* -------------------------------------------------------------------------- */

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1', title: '季度报告', prompt: '写报告', requirements: [], revision: 1, status: 'ready',
    sourceChatId: '2', executionChatId: '9', currentAttemptId: 'job-1-1',
    result: '报告结果文本', artifactId: 'artifact-1', error: null, createdAt: 1, updatedAt: 1, ...overrides,
  };
}

function notificationDelivery(overrides: Partial<Delivery> = {}): Delivery {
  const base = initialDelivery({
    id: 'notify-1', jobId: 'job-1', scheduleId: 'schedule-1', occurrenceIds: ['schedule-1-o0'],
    revision: 1, channel: 'notification', createdAt: 1,
  });
  return {...base, ...overrides};
}

async function deliveryFixture(
  t: TestContext, notification: NotificationPort, options: {startOnly?: boolean} = {},
) {
  let harness!: Harness;
  const runtime = deliveryRuntime({getHarness: () => harness, notification});
  const registry = createRegistry();
  registry.install(runtime.extension);
  harness = await Harness.open(new MemoryStorage(), {models: createModels(), registry}, context);
  t.after(() => harness.close(context));
  const conversation = await harness.createConversation({ownership: {kind: 'ownerless'}}, context);
  const sourceChatId = Number(conversation.id);
  const seedJob = {...job(), sourceChatId: String(sourceChatId)};
  const seedDelivery = notificationDelivery();
  await harness.commit(async tx => {
    await tx.doc(Jobs, seedJob.id, seedJob);
    await tx.doc(Deliveries, seedDelivery.id, seedDelivery);
  }, context);
  const start = async (deliveryId: string) => {
    const taskId = await harness.commit(tx => tx.createTask(runtime.NotifyTask, {deliveryId}, {
      conversationId: sourceChatId as ConversationId, ownership: {kind: 'conversation'}, background: true,
    }), context) as TaskId;
    harness.resume();
    return taskId;
  };
  const run = async (deliveryId: string) => {
    const taskId = await start(deliveryId);
    await harness.waitForTask(taskId, context);
  };
  return {harness, runtime, run, start, startOnly: options.startOnly === true};
}

/* -------------------------------------------------------------------------- */
/* RED-LINE failing tests (audit B1/B2/B3/B6): expected secure behavior       */
/* -------------------------------------------------------------------------- */

test('REDLINE-A runOperation rejects a substituted registry for the same effect kind', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const rootA = await fileRoot(dir, 'root-a');
  const rootB = await fileRoot(dir, 'root-b');
  const registered = await createFileResourceEffect(rootA);
  const runtime = await secureRuntime(dir, [registered]);
  try {
    const resource = await acquire(runtime);
    const operation = await beginFile(runtime, resource, filePayload('a.txt', 'one'));
    let substituted = 0;
    // Same kind and identical definition, but a different execution implementation: this must never run.
    const substitutedRegistered: RegisteredEffect = {
      definition: registered.definition,
      effect: {
        async invoke() {
          substituted += 1;
          return {path: 'a.txt', sha256: sha256Hex('fake'), bytes: 4};
        },
      },
    };
    const substitutedRegistry = createEffectRegistry([substitutedRegistered]);
    let outcome: unknown;
    try {
      outcome = await runtime.resources.runOperation(operation.id, substitutedRegistry);
    } catch (error) {
      outcome = error;
    }
    assert.equal(substituted, 0, 'a caller-supplied registry must never replace the registered effect implementation');
    assert.ok(outcome instanceof ResourceError, `expected a stable rejection, got ${String(outcome)}`);
    assert.ok(['INVALID_COMMAND', 'EFFECT_NOT_REGISTERED'].includes(outcome.code), `unexpected code ${outcome.code}`);
    // The configured real effect may still be dispatched through the runtime-owned registry.
    const done = await runtime.resources.runOperation(operation.id);
    assert.equal(done.state, 'done');
    assert.equal(await readFile(join(rootA, 'a.txt'), 'utf8'), 'one');
    assert.deepEqual(await readdir(rootB), []);
  } finally {
    await runtime.close();
  }
});

test('REDLINE-B evidence content must be bound to the operation payload', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const root = await fileRoot(dir);
  let thrown = false;
  const registered = await createFileResourceEffect(root, {
    hooks: {
      async afterRename() {
        if (!thrown) {
          thrown = true;
          throw new Error('simulated crash after rename');
        }
      },
    },
  });
  const runtime = await secureRuntime(dir, [registered]);
  try {
    const resource = await acquire(runtime);
    const operation = await beginFile(runtime, resource, filePayload('bound.txt', 'real content'));
    const unknown = await runtime.resources.runOperation(operation.id);
    assert.equal(unknown.state, 'unknown');
    assertSecure(unknown);
    // Schema-valid but content-forged evidence: sha/bytes describe a different file than the payload.
    const forgedEvidence = {
      kind: 'file', path: 'bound.txt', exists: true, regular: true,
      sha256: sha256Hex('totally different content'), bytes: Buffer.byteLength('totally different content', 'utf8'),
    };
    await assert.rejects(runtime.resources.observeOperation({
      operationId: operation.id, status: 'done', evidence: forgedEvidence,
      observer: OWNER, payloadHash: unknown.effect.payloadHash, controlEpoch: resource.controlEpoch,
    }), hasCode('INVALID_EVIDENCE'), 'evidence that does not match the bound payload must never settle done');
    // The real observation path still settles it.
    const adapter = await createFileResourceAdapter(root, runtime.resources);
    const reconciled = await adapter.reconcile({operationId: operation.id, owner: OWNER});
    assert.equal(reconciled.state, 'done');
  } finally {
    await runtime.close();
  }
});

test('REDLINE-C a live notification send is never mis-reconciled by a concurrent NotifyTask', {timeout: 30000}, async t => {
  let calls = 0;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const port: NotificationPort = {
    async send() {
      calls += 1;
      entered();
      await gate;
      return 'delivered';
    },
  };
  const fixture = await deliveryFixture(t, port, {startOnly: true});
  const first = await fixture.start('notify-1');
  await enteredPromise;
  // A second worker sees a live attempt. It must not convert it to unknown while the send is in flight.
  const second = await fixture.start('notify-1');
  await fixture.harness.waitForTask(second, context);
  release();
  await fixture.harness.waitForTask(first, context);
  const stored = await fixture.harness.snapshot(Deliveries, 'notify-1', context);
  assert.equal(calls, 1, 'the notification is sent once');
  assert.equal(stored?.status, 'done', 'a successful live send ends done, never unknown/interrupted');
});

test('REDLINE-H CDP screenshot/evaluate results never persist raw data or secrets', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const secret = `SECRET_TOKEN_VALUE_${'x'.repeat(64)}`;
  const transport = new FakeTransport();
  transport.screenshotData = `${secret}${'A'.repeat(120_000)}`;
  const cdpEffects = createCdpEffects({endpoint: 'ws://127.0.0.1:9222/devtools', transportFactory: () => transport});
  const runtime = await secureRuntime(dir, cdpEffects);
  try {
    const resource = await acquire(runtime);
    const screenshot = await runtime.resources.beginOperation({
      operationId: 'op-shot', requestId: 'req-shot', resourceId: RESOURCE_ID,
      controlEpoch: resource.controlEpoch, effect: {kind: 'cdp.screenshot', payload: {format: 'png'}},
      deadline: Date.now() + 60_000,
    });
    const shot = await runtime.resources.runOperation(screenshot.id);
    if (shot.state === 'done') {
      const persisted = JSON.stringify(shot.result);
      assert.equal(persisted.includes(secret), false, 'raw screenshot base64 must not be persisted in operation.result');
      assert.equal(persisted.includes('A'.repeat(1_000)), false, 'large raw payloads must travel as an Artifact reference');
    } else {
      assert.equal(shot.state, 'unknown', 'an unrepresentable screenshot result must not become done');
    }
  } finally {
    await runtime.close();
  }
});


test('REDLINE-D a local file-outbox record is unknown, never a remote delivered success', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const outbox = join(dir, 'outbox');
  const port = createFileOutboxNotificationAdapter({dir: outbox});
  const direct = await port.send(notificationRequest({deliveryId: 'outbox-delivery'}));
  assert.equal(notificationOutcome(direct), 'unknown', 'a local outbox record only proves local acceptance');
  assert.equal((direct as {code?: string}).code, 'outbox-written');
  // The local record still exists (durable for a later dispatcher), but it is not remote success.
  assert.equal((await readOutboxRecord(outbox, 'outbox-delivery', 1_048_576))?.deliveryId, 'outbox-delivery');

  const fixture = await deliveryFixture(t, port);
  await fixture.run('notify-1');
  const stored = await fixture.harness.snapshot(Deliveries, 'notify-1', context);
  assert.equal(stored?.status, 'unknown', 'outbox must never become Delivery.done');
  assert.notEqual(stored?.status, 'done');
});

test('REDLINE-E the artifact writer rejects symlinked parents/targets and never escapes the workspace', {timeout: 30000}, async t => {
  const dir = await directory(t);
  const workspace = workspaceDir(dir);
  const outside = join(dir, 'outside');
  await mkdir(join(workspace, 'jobs'), {recursive: true});
  await mkdir(join(outside, 'job-1'), {recursive: true});
  await mkdir(join(outside, 'target'), {recursive: true});
  // A symlinked job directory must not be followed by the artifact writer.
  await symlink(join(outside, 'job-1'), join(workspace, 'jobs', 'job-1'), 'dir');
  const harness = await Harness.open(new MemoryStorage(), {models: createModels(), registry: createRegistry()}, context);
  t.after(() => harness.close(context));
  const commands = artifactCommandsForHarness(harness, dir);
  const artifactId = 'job-1-1:call-1';
  let escaped: unknown;
  try {
    escaped = await commands.save({
      artifactId, jobId: 'job-1', attemptId: 'job-1-1', revision: 1, name: 'escape.md',
      path: artifactPath(workspace, 'job-1', 'job-1-1', artifactId, 'escape.md'), content: 'escape',
    });
  } catch (error) {
    escaped = error;
  }
  assert.ok(escaped instanceof ArtifactError, `expected a stable artifact rejection, got ${String(escaped)}`);
  assert.deepEqual(await readdir(join(outside, 'job-1')).catch(() => []), [],
    'the canonical workspace root must never be bypassed through a symlinked parent');

  // A symlinked target file must be rejected rather than silently replaced.
  const sentinel = join(outside, 'target', 'sentinel.txt');
  await writeFile(sentinel, 'outside-sentinel');
  const realDir = join(workspace, 'jobs', 'job-2', 'job-2-1');
  const targetId = 'job-2-1:call-1';
  const targetDir = join(realDir, artifactDirectoryName(targetId));
  await mkdir(targetDir, {recursive: true});
  await symlink(sentinel, join(targetDir, 'linked.md'));
  let throughTarget: unknown;
  try {
    throughTarget = await commands.save({
      artifactId: targetId, jobId: 'job-2', attemptId: 'job-2-1', revision: 1, name: 'linked.md',
      path: artifactPath(workspace, 'job-2', 'job-2-1', targetId, 'linked.md'), content: 'overwrite',
    });
  } catch (error) {
    throughTarget = error;
  }
  assert.ok(throughTarget instanceof ArtifactError, `expected a stable rejection for a symlinked target, got ${String(throughTarget)}`);
  assert.equal(await readFile(sentinel, 'utf8'), 'outside-sentinel');

  // A real directory tree still writes normally after hardening.
  const normalId = 'job-3-1:call-1';
  const normal = await commands.save({
    artifactId: normalId, jobId: 'job-3', attemptId: 'job-3-1', revision: 1, name: 'ok.md',
    path: artifactPath(workspace, 'job-3', 'job-3-1', normalId, 'ok.md'), content: 'safe content',
  });
  assert.equal(normal.state, 'sealed');
  assert.equal(await readFile(normal.path, 'utf8'), 'safe content');
});

test('REDLINE-G notification failures persist a redacted structured audit on Delivery.error', {timeout: 30000}, async t => {
  const secret = 'audit-secret-token';
  const server = await httpServer(t, (_path, _request, response) => { response.writeHead(503); response.end('provider-body-secret'); });
  const port = createHttpNotificationAdapter({url: `${server.url}/hook`, token: secret});
  const fixture = await deliveryFixture(t, port);
  await fixture.run('notify-1');
  const stored = await fixture.harness.snapshot(Deliveries, 'notify-1', context);
  assert.equal(stored?.status, 'unknown');
  const audit = String(stored?.error);
  for (const fragment of ['http-server-error', '503', 'server']) {
    assert.ok(audit.includes(fragment), `Delivery.error must persist the redacted structured audit (${fragment}): ${audit}`);
  }
  assert.equal(audit.includes(secret), false, 'no token in the durable audit');
  assert.equal(audit.includes('provider-body-secret'), false, 'no provider body in the durable audit');
});
