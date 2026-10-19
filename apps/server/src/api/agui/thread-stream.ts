/**
 * `GET /v1/threads/:threadId/stream`: the thread-stream binding's AG-UI edge (WP6).
 *
 * The runtime produces provider-neutral frames; this module is the only place that knows AG-UI wire
 * shapes for the thread stream. Frame ids carry the frame-level cursor so `Last-Event-ID` resumes at
 * the exact frame, not at a commit boundary (a commit may span several frames, and JSON Patch is not
 * idempotent enough to resend them).
 */

import type { ServerResponse } from 'node:http';
import type { CursoredFrame, ThreadStreamPort } from '../../application/thread-stream.js';
import { ApiError, mapError, messageFor } from '../errors.js';
import type { RouteContext, StreamRoute } from '../routes.js';
import { PROTOCOL_VERSION, sseFrame, sseFrameWithId, type AguiEvent } from './events.js';

/** Map one neutral thread frame to the AG-UI events it produces (usually exactly one). */
export function threadFrameEvents(frame: CursoredFrame): AguiEvent[] {
  const body = frame.body;
  switch (body.type) {
    case 'run_started':
      return [{
        type: 'RUN_STARTED',
        threadId: body.threadId,
        runId: body.runId,
        protocolVersion: PROTOCOL_VERSION,
        metadata: body.sync ? {'point.sync': true} : {},
      }];
    case 'run_finished':
      return [{
        type: 'RUN_FINISHED', threadId: body.threadId, runId: body.runId, outcome: {type: 'success'},
      }];
    case 'state_snapshot':
      return [{
        type: 'STATE_SNAPSHOT',
        snapshot: body.view,
        ...(body.reason === undefined ? {} : {metadata: {'point.reason': body.reason}}),
      }];
    case 'state_delta':
      return [{type: 'STATE_DELTA', delta: [...body.patch] as never}];
    case 'activity_snapshot':
      return [{
        type: 'ACTIVITY_SNAPSHOT',
        messageId: body.messageId,
        activityType: body.activityType,
        content: body.content,
        replace: true,
      }];
    case 'custom':
      return [{type: 'CUSTOM', name: body.name, value: body.value}];
    case 'messages_snapshot':
      // Already bounded by the runtime (10k messages / 8 MiB / 1k pages); the snapshot is text-only,
      // and the metadata says so explicitly instead of letting clients assume it includes tools.
      return [{
        type: 'MESSAGES_SNAPSHOT',
        messages: body.messages.map(row => ({id: row.id, role: row.role, content: row.content})),
        metadata: {'point.toolsIncluded': false},
      }];
    default:
      return [];
  }
}

function streamHeaders(response: ServerResponse, requestId: string): void {
  response.on('error', () => { response.destroy(); });
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.setHeader('X-Request-Id', requestId);
  response.flushHeaders?.();
}

async function write(response: ServerResponse, chunk: string): Promise<void> {
  if (response.destroyed || response.writableEnded) throw new Error('CLIENT_CLOSED');
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
    };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onClose = (): void => { cleanup(); reject(new Error('CLIENT_CLOSED')); };
    response.once('drain', onDrain);
    response.once('close', onClose);
  });
}

/** Last-Event-ID is the frame cursor; anything else is ignored (a fresh sync run is the safe default). */
const CURSOR = /^[0-9]+:[0-9]+$/;

export function threadStreamRoute(): StreamRoute {
  return {
    method: 'GET',
    segments: ['v1', 'threads', ':threadId', 'stream'],
    stream: true,
    async handle(context: RouteContext, response: ServerResponse): Promise<void> {
      const stream = context.commands.threadStream;
      if (stream === undefined) throw new ApiError(503, 'RUNTIME_NOT_READY', messageFor('RUNTIME_NOT_READY'));
      const threadId = context.params.threadId!;
      const rawLastEventId = context.request.headers['last-event-id'];
      // A cursor we do not understand is not the same as no cursor: report it as a resync so the client
      // can tell "server rejected my position" from "this is a fresh connection".
      const malformedCursor = typeof rawLastEventId === 'string' && !CURSOR.test(rawLastEventId);
      const lastEventId = typeof rawLastEventId === 'string' && CURSOR.test(rawLastEventId)
        ? rawLastEventId : undefined;

      // Transport-level failures stay on the REST envelope; only an accepted subscription opens SSE.
      const handle = await stream.open(threadId, lastEventId ?? (malformedCursor ? 'malformed:0' : undefined))
        .catch((error: unknown) => {
        throw mapError(error);
      });

      streamHeaders(response, context.requestId);
      context.logStreamOpen();
      const onClose = (): void => { void handle.close(); };
      context.request.once('close', onClose);
      response.once('close', onClose);
      try {
        for await (const frame of handle.frames) {
          if (response.destroyed || response.writableEnded) break;
          for (const event of threadFrameEvents(frame)) {
            await write(response, sseFrameWithId(frame.cursor, event));
          }
        }
      } catch (error) {
        // Observation failure: report it as a stream error, never as a completed run.
        const mapped = mapError(error);
        if (!response.destroyed && !response.writableEnded) {
          await write(response, sseFrame({
            type: 'RUN_ERROR',
            message: mapped.status === 500 ? messageFor('INTERNAL_ERROR') : mapped.message,
            code: mapped.code,
          })).catch(() => undefined);
        }
      } finally {
        context.request.off('close', onClose);
        response.off('close', onClose);
        await handle.close().catch(() => undefined);
        if (!response.writableEnded && !response.destroyed) response.end();
      }
    },
  };
}

export type { ThreadStreamPort };
