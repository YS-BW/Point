/**
 * Child process for the WP2 durable-resource crash windows.
 *
 * mode = 'attempting': acquire a resource, create an operation and run it with an
 *   effect that reports over IPC and then hangs forever. The parent SIGKILLs the
 *   child after the effect was invoked, i.e. with the operation durable as
 *   `attempting` and the external result unknown.
 *
 * mode = 'intent': acquire a resource and create the operation, then report and hang
 *   before any effect is dispatched. Recovery must not auto-dispatch it; a later
 *   explicit `runOperation` may dispatch it exactly once.
 */
import { openRuntime } from '../../src/runtime/open.js';

const dir = process.argv[2];
const mode = process.argv[3] ?? 'attempting';
if (!dir) throw new Error('missing data dir');
if (mode !== 'attempting' && mode !== 'intent') throw new Error(`unknown crash mode ${mode}`);

const runtime = await openRuntime(dir);
const resource = await runtime.resources.acquire({
  resourceId: 'browser:primary', requestId: 'crash-acquire', owner: 'owner-a', ttlMs: 600_000,
});
const operation = await runtime.resources.beginOperation({
  operationId: 'crash-operation', requestId: 'crash-request',
  resourceId: resource.id, controlEpoch: resource.controlEpoch,
});
process.send?.({
  event: 'started',
  resourceId: resource.id,
  operationId: operation.id,
  controlEpoch: resource.controlEpoch,
  mode,
});

if (mode === 'attempting') {
  void runtime.resources.runOperation(operation.id, {
    async invoke() {
      process.send?.({event: 'effect-invoked', operationId: operation.id});
      await new Promise<void>(() => {});
    },
  }).catch(error => {
    process.send?.({event: 'error', message: String(error)});
  });
}

// Keep the process alive until the parent SIGKILLs it.
setInterval(() => {}, 1000);
