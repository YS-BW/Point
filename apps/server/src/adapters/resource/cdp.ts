import { createHash } from 'node:crypto';
import type { EffectDefinition, ResourceEffectPort, RegisteredEffect, EffectInvocation } from '../../application/resource.js';
import type { JsonObject, JsonValue, ResourceOperation } from '../../domain/resource.js';
import { assertSecureOperation } from '../../domain/resource.js';

export interface CdpTransport {
  readonly readyState?: number;
  send(data: string): void;
  close?(): void;
  addEventListener?(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
  onopen?: ((event: any) => void) | null;
  onmessage?: ((event: any) => void) | null;
  onerror?: ((event: any) => void) | null;
  onclose?: ((event: any) => void) | null;
}
export type CdpTransportFactory = (endpoint: string) => CdpTransport;
export type CdpArtifactSink = (input: Readonly<{data: string; format: string; operation: ResourceOperation}>) => Promise<Readonly<{ref: string}>> | Readonly<{ref: string}>;
export type CdpAdapterOptions = Readonly<{endpoint: string; transportFactory?: CdpTransportFactory; artifactSink?: CdpArtifactSink; maxPayloadBytes?: number; maxResultBytes?: number; maxEvidenceBytes?: number; commandTimeoutMs?: number}>;
const DEFAULT_PAYLOAD = 16 * 1024; const DEFAULT_RESULT = 256 * 1024; const DEFAULT_EVIDENCE = 16 * 1024; const DEFAULT_TIMEOUT = 15_000; const MAX_SCREENSHOT = 192 * 1024;
type Pending = {resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>};
function bytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function object(value: unknown): value is JsonObject { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function endpointAllowed(endpoint: string): boolean { let url: URL; try { url = new URL(endpoint); } catch { return false; } if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return false; const host = url.hostname.toLowerCase(); return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'; }
function payload(def: EffectDefinition, value: unknown): asserts value is JsonObject { if (!object(value) || bytes(value) > def.maxPayloadBytes) throw new Error('PAYLOAD_REJECTED'); def.validatePayload(value); }
function result(def: EffectDefinition, value: unknown): JsonValue { if (value === undefined) return null; if (bytes(value) > def.maxResultBytes) throw new Error('RESULT_REJECTED'); def.validateResult(value as JsonValue); return value as JsonValue; }

class CdpClient {
  private readonly pending = new Map<number, Pending>(); private nextId = 1; private dead = false; private readonly transport: CdpTransport;
  constructor(private readonly endpoint: string, factory: CdpTransportFactory, private readonly timeout: number) {
    this.transport = factory(endpoint);
    const on = (type: string, handler: (event: any) => void) => { if (this.transport.addEventListener) this.transport.addEventListener(type, handler); else (this.transport as any)['on' + type] = handler; };
    on('message', event => this.message(event?.data ?? event)); on('error', () => this.disconnect()); on('close', () => this.disconnect());
  }
  private disconnect(): void { if (this.dead) return; this.dead = true; for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error('CDP_DISCONNECTED')); this.pending.delete(id); } }
  private message(data: unknown): void { try { if (typeof data !== 'string') return; const message = JSON.parse(data) as {id?: number; result?: unknown; error?: {message?: string}}; if (typeof message.id !== 'number') return; const pending = this.pending.get(message.id); if (!pending) return; this.pending.delete(message.id); clearTimeout(pending.timer); if (message.error) pending.reject(new Error('CDP_PROTOCOL_ERROR')); else pending.resolve(message.result); } catch { this.disconnect(); } }
  async command(method: string, params: JsonObject = {}, signal?: AbortSignal, deadline = Date.now() + this.timeout): Promise<any> {
    if (this.dead) throw new Error('CDP_DISCONNECTED'); const id = this.nextId++; const remaining = Math.max(1, Math.min(this.timeout, deadline - Date.now()));
    return await new Promise((resolve, reject) => { const abort = () => { this.pending.delete(id); clearTimeout(timer); reject(new Error('ABORTED')); }; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('DEADLINE_EXCEEDED')); this.disconnect(); }, remaining); this.pending.set(id, {resolve, reject, timer}); if (signal?.aborted) { abort(); return; } signal?.addEventListener('abort', abort, {once: true}); try { this.transport.send(JSON.stringify({id, method, params})); } catch { this.pending.delete(id); clearTimeout(timer); reject(new Error('CDP_DISCONNECTED')); this.disconnect(); } });
  }
  close(): void { try { this.transport.close?.(); } catch { /* best effort */ } this.disconnect(); }
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function redacted(value: JsonValue, depth = 0): JsonValue {
  if (depth > 8) return '[REDACTED]';
  if (Array.isArray(value)) return value.slice(0, 128).map(item => redacted(item, depth + 1));
  if (!object(value)) {
    if (typeof value === 'string' && (value.length > 4096 || /^Bearer\\s+|^eyJ[A-Za-z0-9_-]+\\./.test(value))) return '[REDACTED]';
    return value;
  }
  const output: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (/secret|token|password|passwd|cookie|authorization|api[-_]?key|private[-_]?key|credential/i.test(key)) output[key] = '[REDACTED]';
    else output[key] = redacted(item, depth + 1);
  }
  return output;
}
function evidenceFor(kind: string, evidence: JsonObject, p: JsonObject, limit: number): void {
  if (!object(evidence) || bytes(evidence) > limit || Object.hasOwn(evidence, 'data') || Object.hasOwn(evidence, 'screenshot')) throw new Error('INVALID_EVIDENCE');
  if (kind === 'cdp.navigate' && evidence.url !== p.url) throw new Error('INVALID_EVIDENCE');
  if (kind === 'cdp.evaluate' && evidence.expressionHash !== sha256(String(p.expression))) throw new Error('INVALID_EVIDENCE');
  if (kind === 'cdp.screenshot' && (evidence.format !== (p.format ?? 'png') || (p.quality !== undefined && evidence.quality !== p.quality))) throw new Error('INVALID_EVIDENCE');
}
function definition(kind: string, options: CdpAdapterOptions, validatePayload: (p: JsonObject) => void, validateResult: (r: JsonValue, evidence?: JsonObject, p?: JsonObject) => void): EffectDefinition {
  const limit = options.maxEvidenceBytes ?? DEFAULT_EVIDENCE;
  return {kind, maxPayloadBytes: options.maxPayloadBytes ?? DEFAULT_PAYLOAD, maxResultBytes: options.maxResultBytes ?? DEFAULT_RESULT, maxEvidenceBytes: limit, validatePayload, validateResult, validateEvidence: (evidence: JsonObject, p?: JsonObject) => { if (p === undefined) return; evidenceFor(kind, evidence, p, limit); }};
}
const navigateDefinition = (o: CdpAdapterOptions) => definition('cdp.navigate', o, p => { if (typeof p.url !== 'string' || p.url.length === 0 || p.url.length > 8192) throw new Error('PAYLOAD_REJECTED'); }, (r, _evidence, p) => { if (!object(r) || (r.url !== undefined && r.url !== p?.url)) throw new Error('RESULT_REJECTED'); });
const evaluateDefinition = (o: CdpAdapterOptions) => definition('cdp.evaluate', o, p => { if (typeof p.expression !== 'string' || p.expression.length === 0 || p.expression.length > 32768) throw new Error('PAYLOAD_REJECTED'); }, (r, evidence) => { if (!object(r) || typeof r.observationHash !== 'string' || typeof r.valueType !== 'string' || typeof r.valueBytes !== 'number' || Object.hasOwn(r, 'value')) throw new Error('RESULT_REJECTED'); if (evidence && evidence.observationHash !== r.observationHash) throw new Error('RESULT_REJECTED'); if (bytes(r) > (o.maxResultBytes ?? DEFAULT_RESULT)) throw new Error('RESULT_REJECTED'); });
const screenshotDefinition = (o: CdpAdapterOptions) => definition('cdp.screenshot', o, p => { if (p.format !== undefined && p.format !== 'png' && p.format !== 'jpeg' && p.format !== 'webp') throw new Error('PAYLOAD_REJECTED'); }, (r, evidence, p) => { if (!object(r) || typeof r.artifactRef !== 'string' || typeof r.sha256 !== 'string' || typeof r.bytes !== 'number' || typeof r.format !== 'string') throw new Error('RESULT_REJECTED'); if (r.format !== (p?.format ?? 'png')) throw new Error('RESULT_REJECTED'); if (evidence && (evidence.artifactRef !== r.artifactRef || evidence.sha256 !== r.sha256 || evidence.bytes !== r.bytes || evidence.format !== r.format)) throw new Error('RESULT_REJECTED'); });
function adapter(options: CdpAdapterOptions, kind: string, def: EffectDefinition): RegisteredEffect { const factory = options.transportFactory ?? ((endpoint: string) => new (globalThis as any).WebSocket(endpoint) as CdpTransport); const effect: ResourceEffectPort = {async invoke(operation: ResourceOperation, invocation?: EffectInvocation): Promise<JsonValue> { assertSecureOperation(operation); if (operation.effect.kind !== kind) throw new Error('EFFECT_NOT_REGISTERED'); payload(def, operation.effect.payload); const signal = invocation?.signal; const deadline = invocation?.deadline ?? operation.deadline; if (signal?.aborted || deadline <= Date.now()) throw new Error('DEADLINE_EXCEEDED'); if (kind === 'cdp.screenshot' && !options.artifactSink) throw new Error('ARTIFACT_SINK_REQUIRED'); const client = new CdpClient(options.endpoint, factory, options.commandTimeoutMs ?? DEFAULT_TIMEOUT); try { await client.command('Target.attachToTarget', {targetId: operation.resourceId, flatten: true}, signal, deadline); await client.command('Page.enable', {}, signal, deadline); let response: any; if (kind === 'cdp.navigate') response = await client.command('Page.navigate', {url: operation.effect.payload.url as string}, signal, deadline); else if (kind === 'cdp.evaluate') response = await client.command('Runtime.evaluate', {expression: operation.effect.payload.expression as string, awaitPromise: operation.effect.payload.awaitPromise === true, returnByValue: true}, signal, deadline); else response = await client.command('Page.captureScreenshot', {format: operation.effect.payload.format ?? 'png', ...(typeof operation.effect.payload.quality === 'number' ? {quality: operation.effect.payload.quality} : {})}, signal, deadline); if (kind === 'cdp.screenshot') { const format = String(operation.effect.payload.format ?? 'png'); const data = response?.data; if (!options.artifactSink || typeof data !== 'string' || data.length > MAX_SCREENSHOT) throw new Error('ARTIFACT_SINK_REQUIRED'); const artifact = await options.artifactSink({data, format, operation}); if (!artifact || typeof artifact.ref !== 'string' || artifact.ref.length === 0) throw new Error('RESULT_REJECTED'); return result(def, {artifactRef: artifact.ref, sha256: sha256(data), bytes: Math.floor(data.length * 3 / 4), format}); } if (kind === 'cdp.evaluate') { const safe = redacted(response as JsonValue); return result(def, {observationHash: sha256(JSON.stringify(safe)), valueType: Array.isArray(safe) ? 'array' : safe === null ? 'null' : typeof safe, valueBytes: bytes(safe)}); } return result(def, response); } finally { client.close(); }}}; return {definition: def, effect}; }
export function createCdpEffects(options: CdpAdapterOptions): readonly RegisteredEffect[] { if (!endpointAllowed(options.endpoint)) throw new Error('INVALID_ENDPOINT'); return [adapter(options, 'cdp.navigate', navigateDefinition(options)), adapter(options, 'cdp.evaluate', evaluateDefinition(options)), adapter(options, 'cdp.screenshot', screenshotDefinition(options))]; }
export function createCdpAdapter(options: CdpAdapterOptions): readonly RegisteredEffect[] { return createCdpEffects(options); }
export const cdpEffects = createCdpEffects;
