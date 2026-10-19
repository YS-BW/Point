import type { IncomingMessage } from 'node:http';
import { ApiError } from './errors.js';

/** Deterministic JSON: sorted object keys, array order preserved, so replay bytes match. */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return JSON.stringify(value);
    case 'number': return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean': return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`;
      const record = value as Record<string, unknown>;
      const fields = Object.keys(record)
        .filter(key => record[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
      return `{${fields.join(',')}}`;
    }
    default: return 'null';
  }
}

export type BodyCounter = {bytes: number};

function isJsonType(value: string): boolean {
  return /^application\/json(?:\s*;.*)?$/i.test(value.trim());
}

/**
 * Read at most `limit` bytes of a strict JSON object. Content-Length is checked before
 * reading, and streaming aborts the moment the limit is exceeded (no full buffering).
 */
export async function readJsonObject(
  request: IncomingMessage,
  limit: number,
  counter: BodyCounter,
): Promise<Record<string, unknown>> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > limit) {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    counter.bytes += bytes;
    if (counter.bytes > limit) {
      request.pause();
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'request body too large');
    }
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return {};
  const contentType = request.headers['content-type'];
  if (contentType === undefined || !isJsonType(contentType)) {
    throw new ApiError(400, 'INVALID_COMMAND', 'Content-Type must be application/json');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_COMMAND', 'invalid JSON body');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'INVALID_COMMAND', 'JSON body must be an object');
  }
  return parsed as Record<string, unknown>;
}
