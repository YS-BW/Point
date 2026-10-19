/**
 * HTTP notification adapter (WP2 real adapters, task 3.1).
 *
 * The adapter is the only place an external notification request leaves the process. It is built from
 * explicit options (never implicit environment endpoints), sends exactly one idempotent POST, follows no
 * redirects, and returns a bounded redacted outcome. Tokens only travel in the Authorization header and
 * never enter URLs, error messages, details, persisted state or logs.
 *
 * Outcome classification is frozen by `docs/design/resource-adapters.md` §2.6:
 * 2xx -> delivered; 400/401/403/404/413/422 -> failed; 408/425/429/5xx/DNS/TLS/timeout/network -> unknown;
 * anything unclassified (including redirects) -> unknown.
 */

import type {
  NotificationDetail, NotificationOutcome, NotificationPort, NotificationRequest, NotificationResult,
} from '../../application/delivery.js';

export type HttpNotificationOptions = Readonly<{
  /** Explicit endpoint. `https:` anywhere, `http:` only for a loopback host (tests/local sidecar). */
  url: string;
  /** Optional bearer token, sent only in the Authorization header. */
  token?: string;
  /** Per-request timeout in milliseconds; defaults to `DEFAULT_HTTP_NOTIFICATION_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Injectable fetch for offline protocol tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}>;

export type HttpNotificationConfigErrorCode =
  | 'HTTP_NOTIFICATION_URL_REQUIRED'
  | 'HTTP_NOTIFICATION_URL_INVALID'
  | 'HTTP_NOTIFICATION_URL_UNSAFE'
  | 'HTTP_NOTIFICATION_TOKEN_INVALID'
  | 'HTTP_NOTIFICATION_TIMEOUT_INVALID';

export class HttpNotificationConfigError extends Error {
  constructor(readonly code: HttpNotificationConfigErrorCode) {
    super(code);
    this.name = 'HttpNotificationConfigError';
  }
}

export const DEFAULT_HTTP_NOTIFICATION_TIMEOUT_MS = 10_000;
export const MAX_HTTP_NOTIFICATION_TIMEOUT_MS = 600_000;

/** Loopback hosts where plain HTTP is acceptable; everything else must be HTTPS. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function parseEndpoint(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.trim() === '') throw new HttpNotificationConfigError('HTTP_NOTIFICATION_URL_REQUIRED');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpNotificationConfigError('HTTP_NOTIFICATION_URL_INVALID');
  }
  if (url.username !== '' || url.password !== '') throw new HttpNotificationConfigError('HTTP_NOTIFICATION_URL_UNSAFE');
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url;
  throw new HttpNotificationConfigError('HTTP_NOTIFICATION_URL_UNSAFE');
}

function parseTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_HTTP_NOTIFICATION_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > MAX_HTTP_NOTIFICATION_TIMEOUT_MS) {
    throw new HttpNotificationConfigError('HTTP_NOTIFICATION_TIMEOUT_INVALID');
  }
  return value;
}

function parseToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > 8192 || /[\r\n]/.test(value)) {
    throw new HttpNotificationConfigError('HTTP_NOTIFICATION_TOKEN_INVALID');
  }
  return value;
}

function detail(classification: string, extra: NotificationDetail = {}): NotificationDetail {
  return {classification, ...extra};
}

/** Frozen status classification. Export is for tests and audits; callers should use the adapter. */
export function classifyHttpStatus(status: number): NotificationResult {
  if (status >= 200 && status <= 299) {
    return {outcome: 'delivered', status, detail: detail('delivered')};
  }
  if ([400, 401, 403, 404, 413, 422].includes(status)) {
    return {outcome: 'failed', code: 'http-client-error', status, detail: detail('client')};
  }
  if (status === 408) return {outcome: 'unknown', code: 'http-request-timeout', status, detail: detail('transient')};
  if (status === 425) return {outcome: 'unknown', code: 'http-too-early', status, detail: detail('transient')};
  if (status === 429) return {outcome: 'unknown', code: 'http-rate-limited', status, detail: detail('transient')};
  if (status >= 500 && status <= 599) {
    return {outcome: 'unknown', code: 'http-server-error', status, detail: detail('server')};
  }
  if (status >= 300 && status <= 399) {
    return {outcome: 'unknown', code: 'http-redirect', status, detail: detail('redirect')};
  }
  return {outcome: 'unknown', code: 'http-unclassified', status, detail: detail('unclassified')};
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as {name?: unknown; code?: unknown};
  return value.name === 'AbortError' || value.code === 'ABORT_ERR';
}

/**
 * Build the HTTP notification port. Configuration is strict and fail-closed: without an explicit
 * safe URL the factory throws and no request can ever be attempted.
 */
export type StructuredNotificationPort = Readonly<{
  send(request: NotificationRequest): Promise<NotificationResult>;
}>;

export function createHttpNotificationAdapter(options: HttpNotificationOptions): StructuredNotificationPort {
  // Defensive: a missing options object is a configuration error, never an implicit default endpoint.
  const source = (options ?? {}) as HttpNotificationOptions;
  const endpoint = parseEndpoint(source.url);
  const timeoutMs = parseTimeout(source.timeoutMs);
  const token = parseToken(source.token);
  const fetchImpl = source.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new HttpNotificationConfigError('HTTP_NOTIFICATION_URL_INVALID');

  return {
    async send(request: NotificationRequest): Promise<NotificationResult> {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
        'idempotency-key': request.deliveryId,
      };
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetchImpl(endpoint.toString(), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            deliveryId: request.deliveryId,
            target: request.target,
            title: request.title,
            text: request.text,
          }),
          // Never follow a redirect: a redirected POST could replay the notification at another origin
          // and would forward the Authorization header across origins.
          redirect: 'manual',
          signal: controller.signal,
        });
        const status = response.status;
        // The response body is untrusted and may contain provider echoes; release it without reading it.
        await response.body?.cancel().catch(() => undefined);
        return classifyHttpStatus(status);
      } catch (error) {
        const outcome: NotificationOutcome = 'unknown';
        return timedOut || isAbortError(error)
          ? {outcome, code: 'http-timeout', detail: detail('timeout')}
          : {outcome, code: 'http-network', detail: detail('network')};
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
