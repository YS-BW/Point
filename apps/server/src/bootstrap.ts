import type { AddressInfo } from 'node:net';
import type { Phase } from './domain/lifecycle.js';
import type { RuntimeHandle } from './application/ports.js';
import type { Config } from './config.js';
import { readConfig } from './config.js';
import { createHttp } from './api/http.js';
import { openRuntime } from './runtime/open.js';

export type ServerEnd = 'stopped' | 'failed';
/** Composition dependency, also permits lifecycle fault testing without SDK internals. */
export type RuntimeFactory = (dataDir: string) => Promise<RuntimeHandle>;

export async function startServer(config: Config, runtimeFactory: RuntimeFactory = openRuntime) {
  readConfig({POINT_HOST: config.host, POINT_PORT: String(config.port), POINT_DATA_DIR: config.dataDir});
  let phase: Phase = 'starting';
  const runtime = await runtimeFactory(config.dataDir);
  let runtimeEnded = false;
  void runtime.closed.then(() => { runtimeEnded = true; });
  const server = createHttp({status: () => ({phase, capabilities: ['foundation']})});
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
    });
    if (runtimeEnded) throw new Error('RUNTIME_CLOSED_DURING_STARTUP');
  } catch (error) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.close();
    throw error;
  }
  phase = 'ready';
  let finish!: (end: ServerEnd) => void;
  const closed = new Promise<ServerEnd>(resolve => { finish = resolve; });
  let closing: Promise<void> | undefined;
  const shutdown = (requested: ServerEnd) => closing ??= (async () => {
    phase = requested === 'failed' ? 'failed' : 'stopping';
    let outcome = requested;
    try {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    } catch { outcome = 'failed'; }
    try { await runtime.close(); } catch { outcome = 'failed'; }
    phase = outcome;
    finish(outcome);
  })();
  server.on('error', () => { void shutdown('failed'); });
  void runtime.closed.then(() => { if (!closing) void shutdown('failed'); });
  return {port: (server.address() as AddressInfo).port, instanceId: runtime.instanceId,
    closed, close: () => shutdown('stopped')};
}
