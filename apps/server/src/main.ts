import { readConfig } from './config.js';
import { startServer } from './bootstrap.js';

// Never serialize raw errors, config or headers.
const log = (event: string) => process.stdout.write(JSON.stringify({at: new Date().toISOString(), event}) + '\n');
try {
  const app = await startServer(readConfig());
  const stop = () => { void app.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  log('server.ready');
  const outcome = await app.closed;
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  log(outcome === 'failed' ? 'server.failed' : 'server.stopped');
  if (outcome === 'failed') process.exitCode = 1;
} catch { log('server.start_failed'); process.exitCode = 1; }
