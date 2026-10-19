/**
 * Child process for the WP2 secure durable-resource crash windows.
 *
 * mode = 'attempting': acquire a resource, persist a secure operation bound to the
 *   registered `test.effect` capability, dispatch it with a short deadline, and have
 *   the effect report over IPC and then hang. The parent SIGKILLs the child after the
 *   effect was invoked, i.e. with a live attempt token durable as `attempting`.
 *   Recovery must be explicit (after the durable deadline) and must never replay the
 *   effect; the parent later reconciles the unknown state with evidence.
 *
 * mode = 'intent': create the intent (with a long deadline) and hang before dispatch.
 *   Recovery must not auto-run it; an explicit `runOperation` dispatches exactly once.
 */
import { openRuntime } from '../../src/runtime/open.js';
import { ResourceError } from '../../src/domain/resource.js';
import {
  createEffectRegistry, type EffectDefinition, type ResourceEffectPort,
} from '../../src/application/resource.js';

const dir = process.argv[2];
const mode = process.argv[3] ?? 'attempting';
if (!dir) throw new Error('missing data dir');
if (mode !== 'attempting' && mode !== 'intent') throw new Error(`unknown crash mode ${mode}`);

const definition: EffectDefinition = {
  kind: 'test.effect',
  maxPayloadBytes: 1024,
  maxResultBytes: 1024,
  maxEvidenceBytes: 512,
  validatePayload(payload) {
    if (typeof payload.value !== 'string') throw new ResourceError('INVALID_COMMAND');
  },
  validateResult() { /* the crash test never settles a successful result */ },
  validateEvidence() { /* the child produces no evidence */ },
};
const effect: ResourceEffectPort = {
  async invoke(operation) {
    process.send?.({event: 'effect-invoked', operationId: operation.id});
    await new Promise<void>(() => {});
    return {ok: true};
  },
};
const registry = createEffectRegistry([{definition, effect}]);
const deadline = mode === 'attempting' ? Date.now() + 800 : Date.now() + 60_000;

const runtime = await openRuntime(dir, undefined, {resources: {effects: registry}});
const resource = await runtime.resources.acquire({
  resourceId: 'browser:primary', requestId: 'crash-acquire', owner: 'owner-a', ttlMs: 600_000,
});
const operation = await runtime.resources.beginOperation({
  operationId: 'crash-operation',
  requestId: 'crash-request',
  resourceId: resource.id,
  controlEpoch: resource.controlEpoch,
  effect: {kind: 'test.effect', payload: {value: mode}},
  deadline,
});
process.send?.({
  event: 'started',
  resourceId: resource.id,
  operationId: operation.id,
  controlEpoch: resource.controlEpoch,
  deadline,
  payloadHash: operation.effect?.payloadHash ?? '',
  mode,
});

if (mode === 'attempting') {
  void runtime.resources.runOperation(operation.id, registry).catch(error => {
    process.send?.({event: 'error', message: String(error)});
  });
}

// Keep the process alive until the parent SIGKILLs it.
setInterval(() => {}, 1000);
