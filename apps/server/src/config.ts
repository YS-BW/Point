import { resolve } from 'node:path';

export type Config = Readonly<{
  host: '127.0.0.1' | '::1';
  port: number;
  dataDir: string;
  /** Bearer token for `/v1`; absent means `/v1` is fail-closed with 503 API_NOT_CONFIGURED. */
  apiToken?: string;
  /** `/inspect` is disabled (404) unless explicitly enabled. */
  apiInspect?: boolean;
}>;

const MAX_TOKEN_LENGTH = 512;

/** Validate the optional API token without ever echoing its value. */
function readToken(env: NodeJS.ProcessEnv): string | undefined {
  const token = env.POINT_API_TOKEN;
  if (token === undefined) return undefined;
  if (typeof token !== 'string'
    || token.length === 0
    || token.length > MAX_TOKEN_LENGTH
    || /\s|\p{Cc}/u.test(token)) {
    throw new Error('INVALID_API_TOKEN');
  }
  return token;
}

function readInspect(env: NodeJS.ProcessEnv): boolean {
  const value = env.POINT_API_INSPECT ?? '0';
  if (value !== '0' && value !== '1') throw new Error('INVALID_API_INSPECT');
  return value === '1';
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.POINT_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('LOOPBACK_REQUIRED');
  const input = env.POINT_PORT ?? '4310';
  if (!/^\d+$/.test(input)) throw new Error('INVALID_PORT');
  const port = Number(input);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
  if (env.POINT_DATA_DIR !== undefined && !env.POINT_DATA_DIR.trim()) throw new Error('INVALID_DATA_DIR');
  const apiToken = readToken(env);
  return {
    host, port, dataDir: resolve(env.POINT_DATA_DIR ?? 'runtime/server'),
    ...(apiToken === undefined ? {} : {apiToken}),
    apiInspect: readInspect(env),
  };
}
