/**
 * Stable HTTP status <-> code mapping for the `/v1` contract. Domain errors keep their
 * code in the envelope; unexpected exceptions are collapsed to INTERNAL_ERROR so no
 * stack, path or credential can leak.
 */

export type ErrorEnvelope = Readonly<{error: Readonly<{code: string; message: string; requestId: string}>}>;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

/** Frozen status map. Codes not listed fall back to suffix rules; everything else is 500. */
export const STATUS_BY_CODE: Readonly<Record<string, number>> = Object.freeze({
  INVALID_COMMAND: 400,
  INVALID_TRANSITION: 400,
  INVALID_EVIDENCE: 400,
  PAYLOAD_REJECTED: 400,
  RESULT_REJECTED: 400,
  EFFECT_NOT_REGISTERED: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  IDEMPOTENCY_CONFLICT: 409,
  RESOURCE_CONFLICT: 409,
  RESOURCE_BUSY: 409,
  STALE_CONTROL: 409,
  LEASE_EXPIRED: 409,
  STALE_ATTEMPT: 409,
  IN_PROGRESS: 409,
  RECOVERY_REQUIRED: 409,
  RECOVERY_NOT_ALLOWED: 409,
  ARTIFACT_CONFLICT: 409,
  REVISION_MISMATCH: 409,
  JOB_TERMINAL: 409,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_STREAMS: 503,
  RUN_NOT_FOUND: 404,
  OBSERVATION_TIMEOUT: 503,
  OBSERVATION_RESYNC_REQUIRED: 503,
  CHAT_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  ARTIFACT_NOT_FOUND: 404,
  SCHEDULE_NOT_FOUND: 404,
  DELIVERY_NOT_FOUND: 404,
  COMMAND_NOT_FOUND: 404,
  OPERATION_NOT_FOUND: 404,
  API_NOT_CONFIGURED: 503,
  NOTIFICATION_NOT_CONFIGURED: 503,
  RUNTIME_NOT_READY: 503,
  MODEL_NOT_CONFIGURED: 503,
  DATA_DIR_BUSY: 503,
  INTERNAL_ERROR: 500,
});

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  INVALID_COMMAND: 'invalid command',
  INVALID_TRANSITION: 'invalid state transition',
  INVALID_EVIDENCE: 'invalid evidence',
  PAYLOAD_REJECTED: 'payload rejected',
  RESULT_REJECTED: 'result rejected',
  EFFECT_NOT_REGISTERED: 'effect kind is not registered',
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not found',
  METHOD_NOT_ALLOWED: 'method not allowed',
  IDEMPOTENCY_CONFLICT: 'idempotency key reused with different content',
  RESOURCE_CONFLICT: 'resource conflict',
  RESOURCE_BUSY: 'resource busy',
  STALE_CONTROL: 'stale control',
  LEASE_EXPIRED: 'lease expired',
  STALE_ATTEMPT: 'stale attempt',
  IN_PROGRESS: 'operation in progress',
  RECOVERY_REQUIRED: 'explicit recovery required',
  PAYLOAD_TOO_LARGE: 'request body too large',
  API_NOT_CONFIGURED: 'api is not configured',
  NOTIFICATION_NOT_CONFIGURED: 'notification is not configured',
  RUNTIME_NOT_READY: 'runtime is not ready',
  MODEL_NOT_CONFIGURED: 'model is not configured',
  TOO_MANY_STREAMS: 'too many concurrent streams',
  RUN_NOT_FOUND: 'run not found',
  OBSERVATION_TIMEOUT: 'observation timed out',
  OBSERVATION_RESYNC_REQUIRED: 'observation requires resynchronization',
  INTERNAL_ERROR: 'internal error',
});

export function messageFor(code: string): string {
  return MESSAGES[code] ?? code;
}

/** Reduce any thrown value to a stable (status, code, message) triple. */
export function mapError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const candidate = error as {code?: unknown; message?: unknown} | undefined;
  const rawCode = typeof candidate?.code === 'string'
    ? candidate.code
    : typeof candidate?.message === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(candidate.message)
      ? candidate.message
      : undefined;
  if (rawCode !== undefined) {
    const status = STATUS_BY_CODE[rawCode]
      ?? (rawCode.endsWith('_NOT_FOUND') ? 404 : rawCode.startsWith('INVALID_') ? 400 : undefined);
    if (status !== undefined) return new ApiError(status, rawCode, messageFor(rawCode));
  }
  return new ApiError(500, 'INTERNAL_ERROR', MESSAGES.INTERNAL_ERROR!);
}
