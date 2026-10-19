/**
 * WP5 AG-UI projection contract:
 * - first frame RUN_STARTED (or RUN_ERROR), normal close RUN_FINISHED(outcome object)
 * - truncation (client close / server close) never fakes RUN_FINISHED
 * - cancellation closes open entities before outcome cancelled
 * - unknown events tolerated, invalid known fields/input fail closed
 * - exactly one JSON event per SSE data line; auth/access-log reuse WP4
 * - point.ui.* is a bounded declarative contract with no HTML/JS/DOM
 */

import { HttpAgent } from '@ag-ui/client';
import { EventSchema } from '@ag-ui/core/schemas';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import type { AddressInfo } from 'node:net';
import { createHttp, type ApiRuntime } from '../src/api/http.js';
import { isAguiEvent, sseFrame, PROTOCOL_VERSION } from '../src/api/agui/events.js';
import { pointUiEvent, validatePointUiPayload } from '../src/api/agui/ui.js';
import { openRuntime, type ModelBinding } from '../src/runtime/open.js';
import { startServer } from '../src/bootstrap.js';
import type { AgentRunEvent, AgentRunPort } from '../src/application/agent-stream.js';

const TOKEN = 'agui-token-0123456789';
const AUTH = {authorization: `Bearer ${TOKEN}`};
const JSON_HEADERS = {'content-type': 'application/json'};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const stub = async (): Promise<never> => { throw new Error('NOT_IMPLEMENTED'); };
function stubRuntime(agent?: AgentRunPort): ApiRuntime {
  return {
    instanceId: 'instance-1',
    ...(agent === undefined ? {} : {agent}),
    chats: {create: stub, get: stub},
    conversation: {
      send: stub, stop: stub, compact: stub, wait: stub, status: stub,
      compactStatus: stub, compactWait: stub, history: stub,
    },
    profile: {remember: stub, forget: stub, list: stub, exportMarkdown: stub},
    jobs: {start: stub, amend: stub, cancel: stub, get: stub, attempts: stub, artifact: stub},
    followups: {schedule: stub, cancel: stub, get: stub, occurrences: stub, decisions: stub, deliveries: stub},
    deliveries: {get: stub, list: stub},
  } as unknown as ApiRuntime;
}

type Fixture = Readonly<{url: string; logs: string[]; started: unknown[]; close(): Promise<void>}>;

async function serve(t: TestContext, agent?: AgentRunPort): Promise<Fixture> {
  const logs: string[] = [];
  const started: unknown[] = [];
  const port: AgentRunPort | undefined = agent === undefined ? undefined : {
    async start(request, signal) {
      started.push(request);
      return agent.start(request, signal);
    },
  };
  const server = createHttp({
    health: {status: () => ({phase: 'ready', capabilities: ['foundation']})},
    commands: stubRuntime(port),
    apiToken: TOKEN,
    log: line => logs.push(line),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const {port: bound} = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${bound}`, logs, started,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

async function* readFrames(response: Response): AsyncGenerator<Record<string, unknown>> {
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const body = response.body;
  assert.ok(body !== null, 'stream body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    let separator = buffer.indexOf('\n\n');
    while (separator >= 0) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const dataLines = block.split('\n').filter(line => line.startsWith('data:'));
      assert.equal(dataLines.length, 1, `exactly one data line per frame: ${block}`);
      const event = JSON.parse(dataLines[0]!.slice(5).trim()) as Record<string, unknown>;
      assert.equal(typeof event.type, 'string');
      yield event;
      separator = buffer.indexOf('\n\n');
    }
  }
}

function postAgent(f: Fixture, body: unknown, key = 'agui-key-0001', headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${f.url}/v1/agent`, {
    method: 'POST',
    headers: {'idempotency-key': key, ...JSON_HEADERS, ...AUTH, ...headers},
    body: JSON.stringify(body),
  });
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {threadId: '9', runId: 'client-run', messages: [{id: 'm1', role: 'user', content: '你好'}], ...overrides};
}

const usage = {inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 0, totalTokens: 16};

function fakePort(events: readonly AgentRunEvent[], after?: (signal: AbortSignal) => Promise<void>): AgentRunPort {
  return {
    async start(_request, signal) {
      return {
        events: (async function* () {
          for (const event of events) {
            if (signal.aborted) return;
            yield event;
            if (after !== undefined) await after(signal);
          }
        })(),
        cancel: async () => undefined,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* SSE shape, ordering, success                                               */
/* -------------------------------------------------------------------------- */

test('success stream: official terminal shape, no unattributed usage', async t => {
  const f = await serve(t, fakePort([
    {type: 'step_start', name: 'turn-1'},
    {type: 'message_start', messageId: 'm-1'},
    {type: 'text_delta', messageId: 'm-1', delta: '你好'},
    {type: 'text_delta', messageId: 'm-1', delta: '，世界'},
    {type: 'message_end', messageId: 'm-1'},
    {type: 'step_end', name: 'turn-1'},
    {type: 'run_end', outcome: 'success', usage},
  ]));
  const response = await postAgent(f, input());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
  const events: Record<string, unknown>[] = [];
  for await (const event of readFrames(response)) events.push(event);
  assert.deepEqual(events.map(event => event.type), [
    'RUN_STARTED', 'STEP_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'STEP_FINISHED', 'RUN_FINISHED',
  ]);
  assert.equal(events[0]!.threadId, '9');
  assert.equal(events[0]!.protocolVersion, PROTOCOL_VERSION);
  assert.equal(events[0]!.runId, events.at(-1)!.runId, 'same run identity in start and finish');
  assert.notEqual(events[0]!.runId, 'client-run', 'server owns runId; client one is ignored');
  const last = events.at(-1)!;
  assert.deepEqual(last.outcome, {type: 'success'});
  assert.equal(last.usage, undefined, 'unattributed usage must be omitted');
  assert.equal(f.started.length, 1, 'exactly one run admitted');
});

test('tool call projects name, one truthful args frame, end and bounded result', async t => {
  const f = await serve(t, fakePort([
    {type: 'tool_start', toolCallId: 'call-1', toolName: 'save_artifact', argsJson: '{"name":"a.txt"}'},
    {type: 'tool_end', toolCallId: 'call-1', isError: false},
    {type: 'tool_result', toolCallId: 'call-1', content: 'saved', isError: false},
    {type: 'run_end', outcome: 'success', usage},
  ]));
  const events: Record<string, unknown>[] = [];
  for await (const event of readFrames(await postAgent(f, input()))) events.push(event);
  assert.deepEqual(events.map(event => event.type), [
    'RUN_STARTED', 'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT', 'RUN_FINISHED',
  ]);
  assert.equal(events[1]!.toolCallName, 'save_artifact');
  assert.equal(events[2]!.delta, '{"name":"a.txt"}');
  assert.equal(events[4]!.role, 'tool');
});

/* -------------------------------------------------------------------------- */
/* Truncation never fakes completion                                          */
/* -------------------------------------------------------------------------- */

test('client disconnect truncates: entities are not closed and no RUN_FINISHED is emitted', async t => {
  const controller = new AbortController();
  const f = await serve(t, {
    async start(_request, signal) {
      return {
        events: (async function* () {
          yield {type: 'message_start', messageId: 'm-1'} as AgentRunEvent;
          yield {type: 'text_delta', messageId: 'm-1', delta: '半句'} as AgentRunEvent;
          // Keep the run open until the client disconnects.
          await new Promise<void>(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), {once: true});
          });
        })(),
        cancel: async () => undefined,
      };
    },
  });
  const response = await fetch(`${f.url}/v1/agent`, {
    method: 'POST', headers: {'idempotency-key': 'agui-key-trunc', ...JSON_HEADERS, ...AUTH},
    body: JSON.stringify(input()), signal: controller.signal,
  });
  const received: string[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    const text = decoder.decode(value, {stream: true});
    received.push(text);
    if (text.includes('TEXT_MESSAGE_CONTENT')) { controller.abort(); break; }
  }
  assert.ok(received.join('').includes('TEXT_MESSAGE_CONTENT'));
  assert.ok(!received.join('').includes('RUN_FINISHED'), 'truncated stream must not fake RUN_FINISHED');
  assert.ok(!received.join('').includes('TEXT_MESSAGE_END'), 'truncation does not close entities');
});

test('server-side failure after RUN_STARTED ends with RUN_ERROR, not RUN_FINISHED', async t => {
  const failing: AgentRunPort = {
    async start() {
      return {
        events: (async function* () {
          yield {type: 'message_start', messageId: 'm-1'} as AgentRunEvent;
          throw new Error('boom at /Users/secret token=abc');
        })(),
        cancel: async () => undefined,
      };
    },
  };
  const events: Record<string, unknown>[] = [];
  for await (const event of readFrames(await postAgent(await serve(t, failing), input()))) events.push(event);
  assert.equal(events[0]!.type, 'RUN_STARTED');
  assert.equal(events.at(-1)!.type, 'RUN_ERROR');
  assert.ok(!events.some(event => event.type === 'RUN_FINISHED'));
  assert.equal(events.at(-1)!.message, 'internal error');
  const text = JSON.stringify(events);
  assert.ok(!text.includes('/Users/') && !text.includes('secret') && !text.includes('boom'));
  assert.ok(events.some(event => event.type === 'TEXT_MESSAGE_END'), 'open message is closed before RUN_ERROR');
});

/* -------------------------------------------------------------------------- */
/* Cancellation                                                               */
/* -------------------------------------------------------------------------- */

test('cancellation closes open entities in strict global LIFO order, then finishes cancelled', async t => {
  const f = await serve(t, fakePort([
    {type: 'step_start', name: 'turn-1'},
    {type: 'message_start', messageId: 'm-1'},
    {type: 'text_delta', messageId: 'm-1', delta: '被打断'},
    {type: 'tool_start', toolCallId: 'call-1', toolName: 'save_artifact', argsJson: '{}'},
    // Abort arrives mid-entity: the runtime reports the run as cancelled without natural ends.
    {type: 'run_end', outcome: 'cancelled', usage},
  ]));
  const events: Record<string, unknown>[] = [];
  for await (const event of readFrames(await postAgent(f, input()))) events.push(event);
  // Creation order step -> message -> tool: strict LIFO closes tool, then message, then step.
  assert.deepEqual(events.map(event => event.type), [
    'RUN_STARTED', 'STEP_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT',
    'TOOL_CALL_START', 'TOOL_CALL_ARGS',
    'TOOL_CALL_END', 'TEXT_MESSAGE_END', 'STEP_FINISHED', 'RUN_FINISHED',
  ]);
  assert.deepEqual(events.at(-1)!.outcome, {type: 'cancelled'});
  assert.equal(events[6]!.toolCallId, 'call-1');
  assert.equal(events[7]!.messageId, 'm-1');
  assert.equal(events[8]!.stepName, 'turn-1');
  assert.ok(!events.some(event => event.type === 'RUN_ERROR'));
});

test('cancellation closes nested tool calls in reverse creation order', async t => {
  const f = await serve(t, fakePort([
    {type: 'step_start', name: 'turn-1'},
    {type: 'message_start', messageId: 'm-1'},
    {type: 'tool_start', toolCallId: 'parent-1', toolName: 'browser', argsJson: '{}'},
    {type: 'tool_start', toolCallId: 'parent-1/nested-1', toolName: 'click', argsJson: '{}'},
    {type: 'run_end', outcome: 'cancelled', usage},
  ]));
  const events: Record<string, unknown>[] = [];
  for await (const event of readFrames(await postAgent(f, input()))) events.push(event);
  const closing = events.filter(event => event.type === 'TOOL_CALL_END');
  assert.deepEqual(closing.map(event => event.toolCallId), ['parent-1/nested-1', 'parent-1']);
  assert.deepEqual(events.slice(-3).map(event => event.type),
    ['TEXT_MESSAGE_END', 'STEP_FINISHED', 'RUN_FINISHED']);
});

test('multiple open steps close in strict last-in-first-out order', async t => {
  const f = await serve(t, fakePort([
    {type: 'step_start', name: 'turn-1'},
    {type: 'step_start', name: 'turn-2'},
    {type: 'run_end', outcome: 'cancelled', usage},
  ]));
  const events: Record<string, unknown>[] = [];
  for await (const event of readFrames(await postAgent(f, input()))) events.push(event);
  assert.deepEqual(events.filter(event => event.type === 'STEP_FINISHED').map(event => event.stepName),
    ['turn-2', 'turn-1']);
});

/* -------------------------------------------------------------------------- */
/* Fail-closed input / transport                                              */
/* -------------------------------------------------------------------------- */

test('invalid known RunAgentInput values fail closed with RUN_ERROR as the first frame', async t => {
  const f = await serve(t, fakePort([{type: 'run_end', outcome: 'success', usage}]));
  const cases: readonly Record<string, unknown>[] = [
    {threadId: 9, messages: []},
    {threadId: '9', messages: []},
    {threadId: '9', messages: [{role: 'user', content: 42}]},
    {threadId: '9', messages: [{role: 'assistant', content: ''}]},
    {threadId: '9', runId: 7, messages: [{role: 'user', content: 'hi'}]},
  ];
  for (const body of cases) {
    const response = await postAgent(f, body, `agui-key-${Math.random().toString(16).slice(2)}`);
    const events: Record<string, unknown>[] = [];
    for await (const event of readFrames(response)) events.push(event);
    assert.deepEqual(events.map(event => event.type), ['RUN_ERROR'], JSON.stringify(body));
    assert.equal(events[0]!.code, 'INVALID_COMMAND');
  }
  assert.equal(f.started.length, 0, 'no run starts for invalid input');
});

test('/v1/agent reuses WP4 auth, idempotency and method contract', async t => {
  const f = await serve(t, fakePort([{type: 'run_end', outcome: 'success', usage}]));
  for await (const _ of readFrames(await postAgent(f, input()))) { /* consume the successful run */ }
  const noKey = await fetch(`${f.url}/v1/agent`, {method: 'POST', headers: {...JSON_HEADERS, ...AUTH}, body: JSON.stringify(input())});
  assert.equal(noKey.status, 400);
  assert.equal(((await noKey.json()) as {error: {code: string}}).error.code, 'INVALID_COMMAND');
  const noAuth = await fetch(`${f.url}/v1/agent`, {method: 'POST', headers: {'idempotency-key': 'agui-key-nauth', ...JSON_HEADERS}, body: JSON.stringify(input())});
  assert.equal(noAuth.status, 401);
  const wrongMethod = await fetch(`${f.url}/v1/agent`, {headers: AUTH});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  const logs = f.logs.map(line => JSON.parse(line) as Record<string, unknown>);
  assert.ok(logs.every(record => record.path !== '/v1/agent' || record.event === 'http.stream_open' || record.event === 'http.access'));
  const streamLogs = logs.filter(record => record.event === 'http.stream_open');
  assert.equal(streamLogs.length, 1, 'streaming request logs an entry record');
  assert.ok(!f.logs.join('\n').includes(TOKEN), 'token never logged');
});

/* -------------------------------------------------------------------------- */
/* Point UI contract (no renderer, no executable content)                     */
/* -------------------------------------------------------------------------- */

test('point.ui CUSTOM contract is declarative and bounded', () => {
  const event = pointUiEvent({component: 'point.placeholder', props: {title: 'hi', rows: [1, 2]}, artifactId: 'att:1'});
  assert.equal(event.type, 'CUSTOM');
  assert.equal(event.name, 'point.ui.component');
  assert.deepEqual(event.value.props, {title: 'hi', rows: [1, 2]});
  assert.equal(sseFrame(event).startsWith('data: {"type":"CUSTOM"'), true);
  for (const bad of [
    {component: 'point.unknown'},
    {component: 'point.placeholder', props: {html: '<script>alert(1)</script>'}},
    {component: 'point.placeholder', props: {url: 'javascript:alert(1)'}},
    {component: 'point.placeholder', props: {data: 'x'.repeat(4096)}},
    {component: 'point.placeholder', artifactId: '/etc/passwd'},
    // Inline event handlers and bare JS calls.
    {component: 'point.placeholder', props: {label: 'onerror=alert(1)'}},
    {component: 'point.placeholder', props: {label: 'alert(1)'}},
    // Scheme hiding via newline/space and control characters is refused.
    {component: 'point.placeholder', props: {label: 'java\nscript:alert(1)'}},
    {component: 'point.placeholder', props: {label: 'java script:alert(1)'}},
    {component: 'point.placeholder', props: {label: 'vbscript:msgbox(1)'}},
    // DOM property access is refused even without a call.
    {component: 'point.placeholder', props: {label: 'document.cookie'}},
    {component: 'point.placeholder', props: {label: 'window.location.href'}},
    {component: 'point.placeholder', props: {label: 'document . cookie'}},
    {component: 'point.placeholder', props: {label: 'line\u0000break'}},
    {component: 'point.placeholder', props: {title: 'line\nbreak'}},
    // Prototype-pollution and non-whitelisted keys.
    {component: 'point.placeholder', props: {constructor: {x: 1}}},
    {component: 'point.placeholder', props: JSON.parse('{"__proto__":{"x":1}}')},
    {component: 'point.placeholder', props: {Title: 'x'}},
  ]) {
    assert.throws(() => validatePointUiPayload(bad), /INVALID_COMMAND|ui /);
  }
  assert.deepEqual(validatePointUiPayload({component: 'point.placeholder', props: {title: 'plain text'}}).props,
    {title: 'plain text'});
  // Unknown AG-UI events/fields are tolerated by consumers.
  assert.equal(isAguiEvent({type: 'FUTURE_EVENT', extra: true}), false, 'unknown input is not a known outbound event');
  assert.equal(isAguiEvent({type: 42}), false);
});

/* -------------------------------------------------------------------------- */
/* Real runtime integration                                                   */
/* -------------------------------------------------------------------------- */

function provider(responses: FauxResponseStep[], tokensPerSecond = 100000) {
  const faux = fauxProvider({tokensPerSecond});
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  return {faux, binding: {models, model: {provider: 'faux', modelId: 'faux-1'}} satisfies ModelBinding};
}

async function realServer(t: TestContext, responses: FauxResponseStep[], tokensPerSecond = 100000) {
  const dir = await mkdtemp(join(tmpdir(), 'point-agui-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const p = provider(responses, tokensPerSecond);
  const runtime = await openRuntime(dir, p.binding);
  const app = await startServer({host: '127.0.0.1', port: 0, dataDir: dir, apiToken: TOKEN}, async () => runtime);
  t.after(() => app.close());
  return {base: `http://127.0.0.1:${app.port}`, faux: p.faux, runtime};
}

async function createChat(base: string): Promise<string> {
  const response = await fetch(`${base}/v1/chats`, {
    method: 'POST', headers: {'idempotency-key': 'agui-chat-0001', ...JSON_HEADERS, ...AUTH},
    body: JSON.stringify({name: 'AG-UI'}),
  });
  assert.equal(response.status, 200);
  return String(((await response.json()) as {id: unknown}).id);
}

test('real runtime: text deltas and canonical snapshot project truthfully', {timeout: 20000}, async t => {
  const {base, faux, runtime} = await realServer(t, [fauxAssistantMessage('你好，世界。')]);
  const chatId = await createChat(base);
  const response = await fetch(`${base}/v1/agent`, {
    method: 'POST', headers: {'idempotency-key': 'agui-run-0001', ...JSON_HEADERS, ...AUTH},
    body: JSON.stringify({threadId: chatId, runId: 'ignored-client-run', messages: [{id: 'u1', role: 'user', content: 'hi'}]}),
  });
  const events: Record<string, unknown>[] = [];
  for await (const event of readFrames(response)) events.push(event);
  assert.equal(events[0]!.type, 'RUN_STARTED');
  assert.notEqual(events[0]!.runId, 'ignored-client-run');
  const text = events.filter(event => event.type === 'TEXT_MESSAGE_CONTENT').map(event => String(event.delta)).join('');
  assert.equal(text, '你好，世界。');
  const finished = events.at(-1)!;
  assert.equal(finished.type, 'RUN_FINISHED');
  assert.deepEqual(finished.outcome, {type: 'success'});
  assert.equal(finished.usage, undefined);
  for (const event of events) assert.ok(EventSchema.safeParse(event).success, JSON.stringify(event));
  assert.equal(faux.state.callCount, 1);
  const history = await runtime.conversation.history(chatId);
  assert.deepEqual(history.items.map(item => [item.role, item.text]), [['user', 'hi'], ['assistant', '你好，世界。']]);
});

test('real runtime: the existing stop command cancels the run and closes entities', {timeout: 30000}, async t => {
  const {base} = await realServer(t, [fauxAssistantMessage('这是一段会被中途停止的较长回答。'.repeat(12))], 30);
  const chatId = await createChat(base);
  const response = await fetch(`${base}/v1/agent`, {
    method: 'POST', headers: {'idempotency-key': 'agui-run-cancel', ...JSON_HEADERS, ...AUTH},
    body: JSON.stringify({threadId: chatId, messages: [{id: 'u1', role: 'user', content: '写长一点'}]}),
  });
  const events: Record<string, unknown>[] = [];
  let stopSent = false;
  for await (const event of readFrames(response)) {
    events.push(event);
    if (!stopSent && event.type === 'TEXT_MESSAGE_CONTENT') {
      stopSent = true;
      const stopped = await fetch(`${base}/v1/chats/${chatId}/stop`, {
        method: 'POST', headers: {'idempotency-key': 'agui-stop-0001', ...JSON_HEADERS, ...AUTH}, body: '{}',
      });
      assert.equal(stopped.status, 200);
    }
  }
  const last = events.at(-1)!;
  assert.equal(last.type, 'RUN_FINISHED', JSON.stringify(events));
  assert.deepEqual(last.outcome, {type: 'cancelled'});
  assert.ok(events.some(event => event.type === 'TEXT_MESSAGE_CONTENT'), 'some text was streamed before stop');
  assert.ok(events.every(event => event.type !== 'RUN_ERROR'));
});

test('official client: consecutive dialogue reconciles drafts; retry does not execute again', {timeout: 20000}, async t => {
  const {base, runtime, faux} = await realServer(t, [fauxAssistantMessage('第一份方案'), fauxAssistantMessage('修改后的方案')]);
  const chatId = await createChat(base);
  const agent = new HttpAgent({url: `${base}/v1/agent`, threadId: chatId, headers: {...AUTH}});
  const draftIds: string[] = [];
  const snapshots: string[][] = [];
  const subscriber = {
    onTextMessageStartEvent: ({event}: {event: {messageId: string}}) => { draftIds.push(event.messageId); },
    onMessagesSnapshotEvent: ({event}: {event: {messages: import('@ag-ui/core').Message[]}}) => {
      snapshots.push(event.messages.map(m => m.id));
      return {messages: event.messages, stopPropagation: true};
    },
  };
  agent.headers['idempotency-key'] = 'official-turn-0001';
  agent.addMessages([{id: 'local-user-1', role: 'user', content: '起草方案'}]);
  await agent.runAgent({}, subscriber);
  agent.headers['idempotency-key'] = 'official-turn-0002';
  agent.addMessages([{id: 'local-user-2', role: 'user', content: '修改方案'}]);
  await agent.runAgent({}, subscriber);
  assert.equal(new Set(draftIds).size, 2);
  const history = await runtime.conversation.history(chatId);
  assert.deepEqual(agent.messages.map(m => [m.id, m.role, m.content]), history.items.map(m => [m.id, m.role, m.text]));
  assert.equal(agent.messages.length, 4);
  const before = structuredClone(agent.messages);
  // Same idempotency key and last user message: observe the completed command, do not submit twice.
  await agent.runAgent({}, subscriber);
  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(agent.messages, before);
  assert.deepEqual(snapshots[2], snapshots[1]);
});

test('real runtime: closing observation does not stop execution; same-key retry recovers result', {timeout: 20000}, async t => {
  const {base, faux, runtime} = await realServer(t, [fauxAssistantMessage('继续完成这个任务。'.repeat(5))], 100);
  const chatId = await createChat(base);
  const body = {threadId: chatId, messages: [{id: 'u1', role: 'user', content: '继续做'}]};
  const controller = new AbortController();
  const response = await fetch(`${base}/v1/agent`, {
    method: 'POST', signal: controller.signal, headers: {...AUTH, ...JSON_HEADERS, 'idempotency-key': 'disconnect-retry-1'},
    body: JSON.stringify(body),
  });
  for await (const event of readFrames(response)) {
    if (event.type === 'TEXT_MESSAGE_CONTENT') { controller.abort(); break; }
  }
  const receipt = await runtime.conversation.send({chatId, text: '继续做', requestId: 'disconnect-retry-1'});
  assert.equal((await runtime.conversation.wait(receipt.commandId)).status, 'answered');
  const retried = await fetch(`${base}/v1/agent`, {
    method: 'POST', headers: {...AUTH, ...JSON_HEADERS, 'idempotency-key': 'disconnect-retry-1'}, body: JSON.stringify(body),
  });
  const events = [];
  for await (const event of readFrames(retried)) events.push(event);
  assert.deepEqual(events.at(-1)?.outcome, {type: 'success'});
  assert.ok(events.some(e => e.type === 'MESSAGES_SNAPSHOT'));
  assert.equal(faux.state.callCount, 1);
});

async function wireServer(t: TestContext, frames: string): Promise<string> {
  const server = createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end(frames);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function officialAgent(url: string): HttpAgent {
  const agent = new HttpAgent({url, threadId: '9', headers: {...AUTH}});
  agent.addMessages([{id: 'u-wire', role: 'user', content: 'hello'}]);
  return agent;
}

const startedFrame = 'data: {"type":"RUN_STARTED","threadId":"9","runId":"wire","protocolVersion":"1.0"}\n\n';

test('official client tolerates unknown events and still completes', async t => {
  const url = await wireServer(t, startedFrame + 'data: {"type":"FUTURE_EVENT","extra":true}\n\n' +
    'data: {"type":"RUN_FINISHED","threadId":"9","runId":"wire","outcome":{"type":"success"}}\n\n');
  let finished = 0;
  await officialAgent(url).runAgent({}, {onRunFinishedEvent: () => { finished += 1; }});
  assert.equal(finished, 1);
});

test('official client rejects invalid known events', async t => {
  const url = await wireServer(t, startedFrame +
    'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":3,"delta":"bad"}\n\n');
  await assert.rejects(officialAgent(url).runAgent({}, {}));
});

test('official client never claims completion for truncated or malformed streams', async t => {
  const tails: readonly (readonly [string, string])[] = [
    ['empty EOF', ''],
    ['partial reply', 'data: {"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant"}\n\n' +
      'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"half"}\n\n'],
    ['malformed JSON', 'data: {broken}\n\n'],
  ];
  for (const [name, tail] of tails) {
    const url = await wireServer(t, startedFrame + tail);
    let finished = 0;
    try {
      await officialAgent(url).runAgent({}, {onRunFinishedEvent: () => { finished += 1; }});
    } catch {
      // Rejecting is acceptable; claiming RUN_FINISHED is not.
    }
    assert.equal(finished, 0, name);
  }
});

test('OBSERVATION_TIMEOUT and OBSERVATION_RESYNC_REQUIRED map to a fixed RUN_ERROR and only stop observation', async t => {
  for (const code of ['OBSERVATION_TIMEOUT', 'OBSERVATION_RESYNC_REQUIRED'] as const) {
    let cancelled = 0;
    const f = await serve(t, {
      async start() {
        return {
          events: (async function* () {
            yield {type: 'message_start', messageId: 'm-1'} as AgentRunEvent;
            throw new Error(code);
          })(),
          cancel: async () => { cancelled += 1; },
        };
      },
    });
    const events: Record<string, unknown>[] = [];
    for await (const event of readFrames(await postAgent(f, input()))) events.push(event);
    const last = events.at(-1)!;
    assert.equal(last.type, 'RUN_ERROR', code);
    assert.equal(last.code, code);
    assert.equal(last.message, 'Observation interrupted; execution status must be synchronized.');
    assert.ok(!events.some(event => event.type === 'MESSAGES_SNAPSHOT'), 'no incomplete snapshot on resync');
    assert.ok(!events.some(event => event.type === 'RUN_FINISHED'), 'observation end is not a finished run');
    assert.equal(cancelled, 1, 'only observation is cancelled');
  }
});

test('real runtime: over-limit messages snapshot fails observation without emitting an incomplete snapshot', {timeout: 20000}, async t => {
  const {base, runtime, faux} = await realServer(t, [fauxAssistantMessage('快照超限。')]);
  const chatId = await createChat(base);
  const original = runtime.conversation.history;
  const huge = Array.from({length: 10_001}, (_, index) => ({
    id: `snap-${index}`, role: 'assistant' as const, text: 'x', interrupted: false,
  }));
  (runtime.conversation as {history: typeof original}).history = async () => ({items: huge});
  const body = JSON.stringify({threadId: chatId, messages: [{id: 'u1', role: 'user', content: 'limit'}]});
  try {
    const response = await fetch(`${base}/v1/agent`, {
      method: 'POST', headers: {'idempotency-key': 'snapshot-limit-1', ...JSON_HEADERS, ...AUTH}, body,
    });
    const events: Record<string, unknown>[] = [];
    for await (const event of readFrames(response)) events.push(event);
    assert.equal(events.at(-1)?.type, 'RUN_ERROR');
    assert.equal(events.at(-1)?.code, 'OBSERVATION_RESYNC_REQUIRED');
    assert.ok(!events.some(event => event.type === 'MESSAGES_SNAPSHOT'), 'incomplete page must not be sent as the snapshot');
    assert.ok(!events.some(event => event.type === 'RUN_FINISHED'));
  } finally {
    (runtime.conversation as {history: typeof original}).history = original;
  }
  assert.equal(faux.state.callCount, 1, 'observation failure did not execute the model again');
  // Execution continued: the same Durable command is answered and can be observed again.
  const retry = await fetch(`${base}/v1/agent`, {
    method: 'POST', headers: {'idempotency-key': 'snapshot-limit-1', ...JSON_HEADERS, ...AUTH}, body,
  });
  const retried: Record<string, unknown>[] = [];
  for await (const event of readFrames(retry)) retried.push(event);
  assert.deepEqual(retried.at(-1)?.outcome, {type: 'success'});
  assert.ok(retried.some(event => event.type === 'MESSAGES_SNAPSHOT'));
  assert.equal(faux.state.callCount, 1);
});

test('outbound schema rejects legacy terminal shapes', () => {
  assert.throws(() => sseFrame({type: 'RUN_FINISHED', threadId: '9', runId: 'r', outcome: 'success'} as never));
  assert.throws(() => sseFrame({type: 'RUN_FINISHED', threadId: '9', runId: 'r', usage} as never));
});


test('projection suppresses duplicate entity ends before official validation', async t => {
  const f = await serve(t, fakePort([
    {type: 'message_start', messageId: 'm'}, {type: 'text_delta', messageId: 'm', delta: 'hello'},
    {type: 'message_end', messageId: 'm'}, {type: 'message_end', messageId: 'm'},
    {type: 'run_end', outcome: 'success', usage},
  ]));
  const agent = new HttpAgent({url: `${f.url}/v1/agent`, threadId: '9',
    headers: {...AUTH, 'idempotency-key': 'duplicate-end-01'}, initialMessages: [{id: 'u', role: 'user', content: 'hi'}]});
  let ends = 0;
  await agent.runAgent({}, {onTextMessageEndEvent: () => { ends++; }});
  assert.equal(ends, 1);
});

test('active stream survives total elapsed time beyond two minutes', {timeout: 20000}, async t => {
  t.mock.timers.enable({apis: ['Date']});
  const {base} = await realServer(t, [fauxAssistantMessage('one two three four five six seven eight nine ten '.repeat(10))], 100);
  const chatId = await createChat(base);
  const response = await fetch(`${base}/v1/agent`, {
    method: 'POST', headers: {...AUTH, ...JSON_HEADERS, 'idempotency-key': 'long-observation-1'},
    body: JSON.stringify({threadId: chatId, messages: [{id: 'u', role: 'user', content: 'long answer'}]}),
  });
  let deltas = 0;
  const events = [];
  for await (const event of readFrames(response)) {
    events.push(event);
    if (event.type === 'TEXT_MESSAGE_CONTENT') { deltas++; t.mock.timers.tick(45000); }
  }
  assert.ok(deltas >= 3, `need multiple progressing updates, got ${deltas}`);
  assert.deepEqual(events.at(-1)?.outcome, {type: 'success'});
});
