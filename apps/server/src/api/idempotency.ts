import type { IncomingMessage } from 'node:http';
import { ApiError } from './errors.js';

/** Frozen contract: 8..128 characters, matching the documented minimum. */
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Every write maps Idempotency-Key to the command requestId; the body may not override it. */
export function idempotencyKey(request: IncomingMessage): string {
  const value = request.headers['idempotency-key'];
  const key = typeof value === 'string' ? value : undefined;
  if (key === undefined) throw new ApiError(400, 'INVALID_COMMAND', 'Idempotency-Key is required');
  if (!IDEMPOTENCY_PATTERN.test(key)) {
    throw new ApiError(400, 'INVALID_COMMAND', 'Idempotency-Key must be 8..128 characters');
  }
  return key;
}
