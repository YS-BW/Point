/**
 * `GET /v1/runs/:runId/stream`: observe one background execution (WP6).
 *
 * Observation only: a disconnect does not cancel the task, interruption never claims failure, and
 * missed events are not replayed (the engine has no commit-history enumeration). The client learns the
 * current progress from the first ACTIVITY snapshot.
 */

import type { ServerResponse } from 'node:http';
import type { RunFrameBody } from '../../application/run-stream.js';
import { ApiError, mapError, messageFor } from '../errors.js';
import type { RouteContext, StreamRoute } from '../routes.js';
import { PROTOCOL_VERSION, sseFrame, type AguiEvent } from './events.js';

function eventsFor(threadId: string, frame: RunFrameBody): AguiEvent[] {
  switch (frame.type) {
    case 'run_started':
      return [{
        type: 'RUN_STARTED', threadId, runId: frame.runId, protocolVersion: PROTOCOL_VERSION,
      }];
    case 'activity_snapshot':
      return [{
        type: 'ACTIVITY_SNAPSHOT', messageId: `run-${frame.runId}`,
        activityType: frame.activityType, content: frame.content, replace: true,
      }];
    case 'run_finished':
      // The outcome is where a client decides success or failure, so it must reflect the task's real
      // terminal status. Reporting `success` for a failed or cancelled execution would be dishonest.
      if (frame.status === 'failed') {
        return [{type: 'RUN_ERROR', message: 'execution failed', code: 'RUN_FAILED'}];
      }
      return [{
        type: 'RUN_FINISHED', threadId, runId: frame.runId,
        outcome: {type: frame.status === 'success' ? 'success' : 'cancelled'},
      }];
    default:
      return [];
  }
}

function headers(response: ServerResponse, requestId: string): void {
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
    const cleanup = (): void => { response.off('drain', onDrain); response.off('close', onClose); };
    const onDrain = (): void => { cleanup(); resolve(); };
    const onClose = (): void => { cleanup(); reject(new Error('CLIENT_CLOSED')); };
    response.once('drain', onDrain);
    response.once('close', onClose);
  });
}

export function runStreamRoute(): StreamRoute {
  return {
    method: 'GET',
    segments: ['v1', 'runs', ':runId', 'stream'],
    stream: true,
    async handle(context: RouteContext, response: ServerResponse): Promise<void> {
      const stream = context.commands.runStream;
      if (stream === undefined) throw new ApiError(503, 'RUNTIME_NOT_READY', messageFor('RUNTIME_NOT_READY'));
      // Transport-level failures (unknown run) stay on the REST envelope; only a resolved run opens SSE.
      const handle = await stream.open(context.params.runId!).catch((error: unknown) => {
        throw mapError(error);
      });
      headers(response, context.requestId);
      context.logStreamOpen();
      const onClose = (): void => { void handle.close(); };
      context.request.once('close', onClose);
      response.once('close', onClose);
      let threadId = '';
      try {
        for await (const frame of handle.frames) {
          if (response.destroyed || response.writableEnded) break;
          if (frame.type === 'run_started') threadId = frame.threadId;
          for (const event of eventsFor(threadId, frame)) await write(response, sseFrame(event));
        }
      } catch (error) {
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
