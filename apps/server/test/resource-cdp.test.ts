import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCdpEffects, type CdpTransport} from '../src/adapters/resource/cdp.js';
import type {SecureResourceOperation} from '../src/domain/resource.js';

class FakeTransport implements CdpTransport {
  sent: string[] = [];
  private listeners = new Map<string, ((event: any) => void)[]>();
  addEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as {id: number; method: string};
    queueMicrotask(() => this.emit('message', {data: JSON.stringify({id: frame.id, result: frame.method === 'Page.captureScreenshot' ? {data: 'aGVsbG8='} : frame.method === 'Runtime.evaluate' ? {result: {value: {username: 'alice', password: 'super-secret', nested: {token: 'abc'}, ordinary: 'SECRET_TOKEN_VALUE'}}} : {frameId: 'f'}})}));
  }
  emit(type: string, event: any = {}): void { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  close(): void { this.emit('close'); }
}
function operation(kind: string, payload: Record<string, any>): SecureResourceOperation {
  return {id: 'op-1', requestId: 'req-1', resourceId: 'target-1', controlEpoch: 1, state: 'attempting', revision: 1, fingerprint: 'fp', owner: 'owner-1', effect: {kind, payload, payloadHash: 'hash'}, attemptToken: 'token-1', attemptStartedAt: Date.now(), deadline: Date.now() + 5000};
}

test('CDP emits attach, enable, and navigate frames', async () => {
  const transport = new FakeTransport();
  const effects = createCdpEffects({endpoint: 'ws://127.0.0.1:9222/devtools', transportFactory: () => transport});
  const navigate = effects.find(effect => effect.definition.kind === 'cdp.navigate')!;
  const output = await navigate.effect.invoke(operation('cdp.navigate', {url: 'https://example.test'}), {signal: new AbortController().signal, deadline: Date.now() + 5000});
  assert.deepEqual(transport.sent.map(frame => JSON.parse(frame).method), ['Target.attachToTarget', 'Page.enable', 'Page.navigate']);
  assert.deepEqual(output, {frameId: 'f'});
});

test('CDP evaluate and screenshot are registered and bounded', async () => {
  const transport = new FakeTransport();
  const effects = createCdpEffects({endpoint: 'ws://localhost:9222/devtools', artifactSink: () => ({ref: 'artifact:1'}), transportFactory: () => transport});
  const evaluate = effects.find(effect => effect.definition.kind === 'cdp.evaluate')!;
  const screenshot = effects.find(effect => effect.definition.kind === 'cdp.screenshot')!;
  const evaluated = await evaluate.effect.invoke(operation('cdp.evaluate', {expression: '1+1'}), {signal: new AbortController().signal, deadline: Date.now() + 5000});
  assert.equal(typeof (evaluated as any).observationHash, 'string');
  assert.equal((evaluated as any).valueType, 'object');
  assert.equal(typeof (evaluated as any).valueBytes, 'number');
  assert.equal(JSON.stringify(evaluated).includes('super-secret'), false);
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(evaluated))).includes('SECRET_TOKEN_VALUE'), false);
  assert.throws(() => evaluate.definition.validateResult(evaluated as any, {expressionHash: 'bad', observationHash: 'bad'}, operation('cdp.evaluate', {expression: '1+1'}).effect!.payload), /RESULT_REJECTED/);
  const screenshotResult = await screenshot.effect.invoke(operation('cdp.screenshot', {format: 'png'}), {signal: new AbortController().signal, deadline: Date.now() + 5000});
  assert.equal((screenshotResult as any).artifactRef, 'artifact:1');
  assert.throws(() => screenshot.definition.validateResult(screenshotResult as any, {artifactRef: 'forged', sha256: (screenshotResult as any).sha256, bytes: (screenshotResult as any).bytes, format: 'png'}, operation('cdp.screenshot', {format: 'png'}).effect!.payload), /RESULT_REJECTED/);
  const noSink = createCdpEffects({endpoint: 'ws://localhost:9222/devtools', transportFactory: () => new FakeTransport()})[2]!;
  await assert.rejects(noSink.effect.invoke(operation('cdp.screenshot', {format: 'png'}), {signal: new AbortController().signal, deadline: Date.now() + 5000}), /ARTIFACT_SINK_REQUIRED/);
});

test('invalid endpoint is fail-closed and disconnect rejects without replay', async () => {
  assert.throws(() => createCdpEffects({endpoint: 'ws://10.0.0.1:9222'}), /INVALID_ENDPOINT/);
  const transport = new FakeTransport();
  transport.send = function (data: string): void { this.sent.push(data); this.emit('close'); };
  const effect = createCdpEffects({endpoint: 'ws://127.0.0.1:9222', transportFactory: () => transport})[0]!;
  await assert.rejects(effect.effect.invoke(operation('cdp.navigate', {url: 'https://example.test'}), {signal: new AbortController().signal, deadline: Date.now() + 5000}), /CDP_DISCONNECTED/);
  assert.equal(transport.sent.length, 1);
});
