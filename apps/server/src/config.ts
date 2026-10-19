import { resolve } from 'node:path';

export type Config = Readonly<{ host: '127.0.0.1' | '::1'; port: number; dataDir: string }>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.POINT_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('LOOPBACK_REQUIRED');
  const input = env.POINT_PORT ?? '4310';
  if (!/^\d+$/.test(input)) throw new Error('INVALID_PORT');
  const port = Number(input);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
  if (env.POINT_DATA_DIR !== undefined && !env.POINT_DATA_DIR.trim()) throw new Error('INVALID_DATA_DIR');
  return {host, port, dataDir: resolve(env.POINT_DATA_DIR ?? 'runtime/server')};
}
