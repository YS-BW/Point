/**
 * HTTP transport for the `/v1` contract. The layer only routes, authenticates,
 * bounds/parses bodies, maps errors and logs metadata; all business behavior stays in
 * the application commands. No response cache exists: replay equality comes from the
 * Durable command receipts behind the Idempotency-Key -> requestId mapping.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { HealthReader } from '../application/ports.js';
import { ApiError, mapError, messageFor, type ErrorEnvelope } from './errors.js';
import { stableStringify, type BodyCounter } from './json.js';
import { v1Routes, type ApiRuntime, type Route } from './routes.js';

export type { ApiRuntime } from './routes.js';

export type HttpOptions = Readonly<{
  health: HealthReader;
  /** Application command ports; absent means `/v1` reports RUNTIME_NOT_READY. */
  commands?: ApiRuntime;
  /** Bearer token; absent means `/v1` is fail-closed with 503 API_NOT_CONFIGURED. */
  apiToken?: string;
  /** `/inspect` is disabled (404) unless this is explicitly true. */
  inspect?: boolean;
  /** One line of JSON metadata per request; never headers or bodies. */
  log?: (line: string) => void;
  bodyLimitBytes?: number;
}>;

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HEALTH_PATHS = new Set(['/health/live', '/health/ready']);

function requestIdOf(request: IncomingMessage): string {
  const candidate = request.headers['x-request-id'];
  return typeof candidate === 'string' && REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

function envelope(error: ApiError, requestId: string): ErrorEnvelope {
  return {error: {code: error.code, message: error.message, requestId}};
}

function bearerMatches(actual: string | undefined, token: string): boolean {
  if (actual === undefined) return false;
  const expected = `Bearer ${token}`;
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function decodePath(pathname: string): string[] {
  const raw = pathname.split('/').slice(1);
  try {
    return raw.map(segment => decodeURIComponent(segment));
  } catch {
    throw new ApiError(400, 'INVALID_COMMAND', 'invalid path encoding');
  }
}

function matches(route: Route, segments: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (route.segments.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < route.segments.length; index += 1) {
    const pattern = route.segments[index]!;
    const value = segments[index]!;
    if (pattern.startsWith(':')) {
      if (value.length === 0) return undefined;
      params[pattern.slice(1)] = value;
    } else if (pattern !== value) {
      return undefined;
    }
  }
  return params;
}

type Resolved = {route: Route; params: Readonly<Record<string, string>>}
  | {allow: readonly string[]};

function resolve(routes: readonly Route[], method: string, segments: readonly string[]): Resolved {
  const allowed = new Set<string>();
  for (const route of routes) {
    const params = matches(route, segments);
    if (params === undefined) continue;
    if (route.method === method) return {route, params};
    allowed.add(route.method);
  }
  if (allowed.size > 0) return {allow: [...allowed].sort()};
  throw new ApiError(404, 'NOT_FOUND', messageFor('NOT_FOUND'));
}

export function createHttp(options: HttpOptions): Server {
  const routes = v1Routes();
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  const log = options.log ?? ((line: string) => { process.stdout.write(line + '\n'); });

  async function respond(response: ServerResponse, status: number, body: unknown): Promise<void> {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(stableStringify(body));
  }

  async function handle(request: IncomingMessage, response: ServerResponse, requestId: string, counter: BodyCounter): Promise<number> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (HEALTH_PATHS.has(pathname)) {
      if (method !== 'GET') {
        response.setHeader('Allow', 'GET');
        await respond(response, 405, envelope(new ApiError(405, 'METHOD_NOT_ALLOWED'), requestId));
        return 405;
      }
      const status = options.health.status();
      const ok = pathname === '/health/live' ? status.phase !== 'stopped' && status.phase !== 'failed' : status.phase === 'ready';
      await respond(response, ok ? 200 : 503, status);
      return ok ? 200 : 503;
    }

    if (pathname === '/inspect') {
      // Disabled is indistinguishable from absent: 404, before auth.
      if (options.inspect !== true) {
        await respond(response, 404, envelope(new ApiError(404, 'NOT_FOUND', messageFor('NOT_FOUND')), requestId));
        return 404;
      }
      if (method !== 'GET') {
        response.setHeader('Allow', 'GET');
        await respond(response, 405, envelope(new ApiError(405, 'METHOD_NOT_ALLOWED'), requestId));
        return 405;
      }
      if (options.apiToken === undefined) throw new ApiError(503, 'API_NOT_CONFIGURED', messageFor('API_NOT_CONFIGURED'));
      if (!bearerMatches(request.headers.authorization, options.apiToken)) {
        throw new ApiError(401, 'UNAUTHORIZED', messageFor('UNAUTHORIZED'));
      }
      if (options.commands === undefined) throw new ApiError(503, 'RUNTIME_NOT_READY', messageFor('RUNTIME_NOT_READY'));
      const status = options.health.status();
      await respond(response, 200, {
        version: 1, instanceId: options.commands.instanceId, phase: status.phase, capabilities: status.capabilities,
      });
      return 200;
    }

    // Route resolution precedes auth so unknown paths stay 404 on unconfigured servers.
    const segments = decodePath(pathname);
    const resolved = resolve(routes, method, segments);
    if ('allow' in resolved) {
      response.setHeader('Allow', resolved.allow.join(', '));
      await respond(response, 405, envelope(new ApiError(405, 'METHOD_NOT_ALLOWED'), requestId));
      return 405;
    }

    if (options.apiToken === undefined) throw new ApiError(503, 'API_NOT_CONFIGURED', messageFor('API_NOT_CONFIGURED'));
    if (!bearerMatches(request.headers.authorization, options.apiToken)) {
      throw new ApiError(401, 'UNAUTHORIZED', messageFor('UNAUTHORIZED'));
    }
    if (options.commands === undefined) throw new ApiError(503, 'RUNTIME_NOT_READY', messageFor('RUNTIME_NOT_READY'));
    const context = {
      request, url, params: resolved.params, commands: options.commands,
      health: options.health, requestId, bodyLimitBytes, counter,
      logStreamOpen: () => {
        log(JSON.stringify({
          at: new Date().toISOString(),
          event: 'http.stream_open',
          requestId,
          method,
          path: pathname,
          status: 200,
          durationMs: 0,
          bytesIn: counter.bytes,
        }));
      },
    };
    if ('stream' in resolved.route) {
      await resolved.route.handle(context, response);
      return response.statusCode;
    }
    const result = await resolved.route.handle(context);
    await respond(response, 200, result);
    return 200;
  }

  return createServer((request, response) => {
    const requestId = requestIdOf(request);
    const started = process.hrtime.bigint();
    const counter: BodyCounter = {bytes: 0};
    response.setHeader('X-Request-Id', requestId);
    void handle(request, response, requestId, counter).catch(async error => {
      const mapped = mapError(error);
      if (mapped.status === 413) {
        // Drain without buffering. Closing a socket while an upload is in flight can
        // reset it before the client receives our 413 (also used by /v1/agent).
        request.resume();
      }
      try {
        await respond(response, mapped.status, envelope(mapped, requestId));
      } catch {
        response.destroy();
      }
    }).finally(() => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      log(JSON.stringify({
        at: new Date().toISOString(),
        event: 'http.access',
        requestId,
        method: request.method ?? 'GET',
        path: (request.url ?? '/').split('?')[0],
        status: response.statusCode,
        durationMs: Math.round(durationMs * 1000) / 1000,
        bytesIn: counter.bytes,
      }));
    });
  });
}
