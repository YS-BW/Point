import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  createRegistry, Harness, MemoryStorage, type ConversationId, type TaskId,
} from '@earendil-works/pi-durable';
import {
  classifyHttpStatus, createHttpNotificationAdapter, HttpNotificationConfigError,
} from '../src/adapters/notification/http.js';
import {
  notificationOutcome, notificationResult, type NotificationRequest,
} from '../src/application/delivery.js';
import { initialDelivery, type Delivery } from '../src/domain/delivery.js';
import type { Job } from '../src/domain/job.js';
import { Deliveries } from '../src/storage/delivery.js';
import { Jobs } from '../src/storage/job.js';
import { deliveryRuntime } from '../src/runtime/deliveries.js';

type RequestLog = Readonly<{
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}>;

async function startServer(
  t: TestContext, handler: (request: RequestLog, response: ServerResponse) => void | Promise<void>,
) {
  const requests: RequestLog[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      const log: RequestLog = {method: request.method ?? '', url: request.url ?? '', headers: request.headers, body};
      requests.push(log);
      Promise.resolve(handler(log, response)).catch(() => response.destroy());
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
  return {url: `http://127.0.0.1:${port}`, requests, server};
}

function request(overrides: Partial<NotificationRequest> = {}): NotificationRequest {
  return {deliveryId: 'delivery-1', target: 'test', title: '季度提醒', text: '报告已完成', ...overrides};
}

function hasCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpNotificationConfigError, `expected config error, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('http notification configuration is explicit, safe and fail-closed', () => {
  assert.throws(() => createHttpNotificationAdapter({url: ''}), hasCode('HTTP_NOTIFICATION_URL_REQUIRED'));
  assert.throws(() => createHttpNotificationAdapter(undefined as unknown as {url: string}), hasCode('HTTP_NOTIFICATION_URL_REQUIRED'));
  assert.throws(() => createHttpNotificationAdapter({url: 'not a url'}), hasCode('HTTP_NOTIFICATION_URL_INVALID'));
  assert.throws(() => createHttpNotificationAdapter({url: 'http://example.com/hook'}), hasCode('HTTP_NOTIFICATION_URL_UNSAFE'));
  assert.throws(() => createHttpNotificationAdapter({url: 'https://user:pass@example.com/hook'}), hasCode('HTTP_NOTIFICATION_URL_UNSAFE'));
  assert.throws(() => createHttpNotificationAdapter({url: 'ftp://127.0.0.1/hook'}), hasCode('HTTP_NOTIFICATION_URL_UNSAFE'));
  assert.throws(() => createHttpNotificationAdapter({url: 'https://example.com/hook', token: 'a\nb'}), hasCode('HTTP_NOTIFICATION_TOKEN_INVALID'));
  assert.throws(() => createHttpNotificationAdapter({url: 'https://example.com/hook', timeoutMs: 0}), hasCode('HTTP_NOTIFICATION_TIMEOUT_INVALID'));
  assert.throws(() => createHttpNotificationAdapter({url: 'https://example.com/hook', timeoutMs: 600_001}), hasCode('HTTP_NOTIFICATION_TIMEOUT_INVALID'));
  // HTTPS needs no loopback exception; the injected fetch keeps this offline.
  const calls: string[] = [];
  const port = createHttpNotificationAdapter({
    url: 'https://notify.example.com/hook',
    fetch: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(null, {status: 202});
    }) as typeof fetch,
  });
  assert.equal(typeof port.send, 'function');
  assert.deepEqual(calls, []);
});

test('http status classification is frozen and total', () => {
  for (const status of [200, 201, 204, 299]) {
    assert.deepEqual([classifyHttpStatus(status).outcome], ['delivered'], String(status));
  }
  for (const status of [400, 401, 403, 404, 413, 422]) {
    const result = classifyHttpStatus(status);
    assert.deepEqual([result.outcome, result.code], ['failed', 'http-client-error'], String(status));
  }
  assert.deepEqual([classifyHttpStatus(408).outcome, classifyHttpStatus(408).code], ['unknown', 'http-request-timeout']);
  assert.deepEqual([classifyHttpStatus(425).code], ['http-too-early']);
  assert.deepEqual([classifyHttpStatus(429).code], ['http-rate-limited']);
  for (const status of [500, 503, 599]) {
    assert.deepEqual([classifyHttpStatus(status).outcome, classifyHttpStatus(status).code], ['unknown', 'http-server-error']);
  }
  assert.deepEqual([classifyHttpStatus(301).outcome, classifyHttpStatus(301).code], ['unknown', 'http-redirect']);
  assert.deepEqual([classifyHttpStatus(418).outcome, classifyHttpStatus(418).code], ['unknown', 'http-unclassified']);
  assert.deepEqual([classifyHttpStatus(102).outcome, classifyHttpStatus(102).code], ['unknown', 'http-unclassified']);
});

test('http notification sends one idempotent redacted POST for every frozen status class', {timeout: 20000}, async t => {
  const cases: ReadonlyArray<[number, string, string | undefined]> = [
    [200, 'delivered', undefined],
    [204, 'delivered', undefined],
    [400, 'failed', 'http-client-error'],
    [401, 'failed', 'http-client-error'],
    [403, 'failed', 'http-client-error'],
    [404, 'failed', 'http-client-error'],
    [413, 'failed', 'http-client-error'],
    [422, 'failed', 'http-client-error'],
    [408, 'unknown', 'http-request-timeout'],
    [425, 'unknown', 'http-too-early'],
    [429, 'unknown', 'http-rate-limited'],
    [500, 'unknown', 'http-server-error'],
    [503, 'unknown', 'http-server-error'],
  ];
  let index = 0;
  const server = await startServer(t, (_request, response) => {
    const [status] = cases[index++]!;
    response.writeHead(status, {'content-type': 'text/plain'});
    response.end('provider-secret-body');
    return undefined;
  });
  const token = 'super-secret-token';
  const port = createHttpNotificationAdapter({url: server.url, token, timeoutMs: 5000});
  for (const [status, expectedOutcome, expectedCode] of cases) {
    const deliveryId = `delivery-${status}`;
    const result = await port.send(request({deliveryId}));
    assert.equal(result.outcome, expectedOutcome, `status ${status}`);
    assert.equal(result.code, expectedCode, `status ${status}`);
    assert.equal(result.status, status);
    const log = server.requests.at(-1)!;
    assert.equal(log.method, 'POST');
    assert.equal(log.url, '/');
    assert.equal(log.headers['idempotency-key'], deliveryId);
    assert.equal(log.headers.authorization, `Bearer ${token}`);
    assert.equal(log.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(log.body), {deliveryId, target: 'test', title: '季度提醒', text: '报告已完成'});
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(token), 'token never appears in the result');
    assert.ok(!serialized.includes('provider-secret-body'), 'response body is never persisted');
    assert.ok(!serialized.includes(server.url), 'endpoint is not echoed into detail');
  }
  assert.equal(server.requests.length, cases.length);
});

test('http notification never follows a redirect or forwards authorization', {timeout: 15000}, async t => {
  const target = await startServer(t, (_request, response) => { response.writeHead(200).end(); });
  const redirector = await startServer(t, (_request, response) => {
    response.writeHead(302, {location: `${target.url}/steal`});
    response.end();
  });
  const port = createHttpNotificationAdapter({url: redirector.url, token: 'secret-token', timeoutMs: 5000});
  const result = await port.send(request({deliveryId: 'redirect-1'}));
  assert.deepEqual([result.outcome, result.code, result.status], ['unknown', 'http-redirect', 302]);
  assert.equal(redirector.requests.length, 1);
  assert.equal(target.requests.length, 0, 'a redirect target is never contacted');
});

test('http notification maps timeout and network failures to unknown without retrying', {timeout: 20000}, async t => {
  const slow = await startServer(t, (_request, response) => {
    setTimeout(() => {
      try {
        if (!response.destroyed && !response.writableEnded) response.writeHead(200).end();
      } catch {
        // The client aborted; the test only cares that no retry happened.
      }
    }, 300);
  });
  const timeoutPort = createHttpNotificationAdapter({url: slow.url, timeoutMs: 40});
  const timedOut = await timeoutPort.send(request({deliveryId: 'timeout-1'}));
  assert.deepEqual([timedOut.outcome, timedOut.code], ['unknown', 'http-timeout']);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(slow.requests.length, 1, 'a timeout is never retried');

  const closed = await startServer(t, (_request, response) => { response.writeHead(200).end(); });
  closed.server.close();
  await once(closed.server, 'close');
  const networkPort = createHttpNotificationAdapter({url: closed.url, timeoutMs: 2000});
  const network = await networkPort.send(request({deliveryId: 'network-1'}));
  assert.deepEqual([network.outcome, network.code], ['unknown', 'http-network']);
});

test('http notification aborts the injected fetch with an AbortSignal on timeout', async () => {
  let observedSignal: AbortSignal | undefined;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    observedSignal = init?.signal ?? undefined;
    assert.ok(observedSignal instanceof AbortSignal);
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.method, 'POST');
    return new Promise<Response>((_resolve, reject) => {
      observedSignal!.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), {name: 'AbortError'}));
      }, {once: true});
    });
  }) as typeof fetch;
  const port = createHttpNotificationAdapter({url: 'https://notify.example.com/hook', timeoutMs: 30, fetch: fetchImpl});
  const result = await port.send(request({deliveryId: 'abort-1'}));
  assert.deepEqual([result.outcome, result.code], ['unknown', 'http-timeout']);
  assert.equal(observedSignal?.aborted, true);
});

test('notification helpers normalize string and structured outcomes without changing the tri-state', () => {
  assert.deepEqual(notificationResult('delivered'), {outcome: 'delivered'});
  assert.deepEqual(notificationResult({outcome: 'failed', code: 'http-client-error', status: 422}), {
    outcome: 'failed', code: 'http-client-error', status: 422,
  });
  assert.equal(notificationOutcome('unknown'), 'unknown');
  assert.equal(notificationOutcome({outcome: 'delivered', detail: {classification: 'delivered'}}), 'delivered');
});

function job(sourceChatId: string): Job {
  return {
    id: 'job-http', title: '季度报告', prompt: '写报告', requirements: [], revision: 1, status: 'ready',
    sourceChatId, executionChatId: '9', currentAttemptId: 'job-http-1',
    result: '报告结果', artifactId: null, error: null, createdAt: 1, updatedAt: 1,
  };
}

function notificationDelivery(): Delivery {
  return initialDelivery({
    id: 'notify-http', jobId: 'job-http', scheduleId: 'schedule-http', occurrenceIds: ['schedule-http-o0'],
    revision: 1, channel: 'notification', createdAt: 1,
  });
}

async function runNotify(t: TestContext, port: ReturnType<typeof createHttpNotificationAdapter>) {
  let harness!: Harness;
  const runtime = deliveryRuntime({getHarness: () => harness, notification: port});
  const registry = createRegistry();
  registry.install(runtime.extension);
  harness = await Harness.open(new MemoryStorage(), {models: createModels(), registry}, context);
  t.after(() => harness.close(context));
  const conversation = await harness.createConversation({ownership: {kind: 'ownerless'}}, context);
  const seedJob = job(String(conversation.id));
  const delivery = notificationDelivery();
  await harness.commit(async tx => {
    await tx.doc(Jobs, seedJob.id, seedJob);
    await tx.doc(Deliveries, delivery.id, delivery);
  }, context);
  const taskId = await harness.commit(tx => tx.createTask(runtime.NotifyTask, {deliveryId: delivery.id}, {
    conversationId: conversation.id as ConversationId, ownership: {kind: 'conversation'}, background: true,
  }), context) as TaskId;
  harness.resume();
  await harness.waitForTask(taskId, context);
  return await harness.snapshot(Deliveries, delivery.id, context);
}

test('the delivery runtime persists structured HTTP outcomes as the existing tri-state', {timeout: 20000}, async t => {
  const server = await startServer(t, (request, response) => {
    const status = request.url === '/failed' ? 401 : request.url === '/unknown' ? 503 : 200;
    response.writeHead(status, {'content-type': 'text/plain'});
    response.end('secret-body');
  });
  const done = await runNotify(t, createHttpNotificationAdapter({url: `${server.url}/ok`, timeoutMs: 2000}));
  assert.deepEqual([done?.status, done?.attempts, done?.result], ['done', 1, 'delivered']);
  const failed = await runNotify(t, createHttpNotificationAdapter({url: `${server.url}/failed`, timeoutMs: 2000}));
  assert.deepEqual([failed?.status, failed?.error], ['failed', 'notification-failed:http-client-error:401:client']);
  const unknown = await runNotify(t, createHttpNotificationAdapter({url: `${server.url}/unknown`, timeoutMs: 2000}));
  assert.deepEqual([unknown?.status, unknown?.error], ['unknown', 'notification-unknown:http-server-error:503:server']);
});
