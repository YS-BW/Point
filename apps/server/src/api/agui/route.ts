/**
 * `POST /v1/agent`: the only AG-UI transport binding in WP5. Reuses WP4 auth, access log
 * and error envelope for failures before the stream starts; after `RUN_STARTED`, every
 * failure closes open entities and ends with `RUN_ERROR`.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentRunStream } from '../../application/agent-stream.js';
import { ApiError, mapError, messageFor } from '../errors.js';
import { idempotencyKey } from '../idempotency.js';
import { readJsonObject } from '../json.js';
import type { RouteContext, StreamRoute } from '../routes.js';
import { PROTOCOL_VERSION, sseFrame, type AguiEvent } from './events.js';
import { RunProjection } from './projection.js';

type RunInput = Readonly<{threadId: string; text: string}>;
type ParsedInput = {ok: true; value: RunInput} | {ok: false; code: string; message: string};

function badInput(message: string): ParsedInput {
  return {ok: false, code: 'INVALID_COMMAND', message};
}

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== 'object') return undefined;
    const value = part as {type?: unknown; text?: unknown};
    if (value.type !== 'text' || typeof value.text !== 'string') return undefined;
    parts.push(value.text);
  }
  return parts.join('');
}

/** Accept the AG-UI `RunAgentInput` fields we use; unknown fields are tolerated, known bad values fail closed. */
export function parseRunAgentInput(body: Record<string, unknown>): ParsedInput {
  const threadId = body.threadId;
  if (typeof threadId !== 'string' || threadId.length === 0 || threadId.length > 128) {
    return badInput('threadId must be a non-empty string');
  }
  if (body.runId !== undefined && typeof body.runId !== 'string') return badInput('runId must be a string');
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return badInput('messages must be a non-empty array');
  let text: string | undefined;
  for (const item of messages) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return badInput('invalid message');
    const message = item as {role?: unknown; content?: unknown};
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system' && message.role !== 'tool') {
      return badInput('message role is invalid');
    }
    const value = contentText(message.content);
    if (value === undefined) return badInput('message content is invalid');
    if (message.role === 'user') text = value;
  }
  if (text === undefined) return badInput('a user message is required');
  if (text.length === 0) return badInput('user message must not be empty');
  return {ok: true, value: {threadId, text}};
}

function streamHeaders(response: ServerResponse, requestId: string): void {
  // Keep an error handler through asynchronous final flush, including pre-run errors.
  // It belongs to this response's lifetime; never exposes socket details to logs.
  response.on('error', () => { response.destroy(); });
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.setHeader('X-Request-Id', requestId);
  response.flushHeaders?.();
}

async function writeFrame(response: ServerResponse, event: AguiEvent): Promise<void> {
  if (response.destroyed || response.writableEnded) throw new Error('CLIENT_CLOSED');
  const chunk = sseFrame(event);
  if (response.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => { cleanup(); resolve(); };
    const onClose = (): void => { cleanup(); reject(new Error('CLIENT_CLOSED')); };
    const onError = (): void => { cleanup(); reject(new Error('CLIENT_CLOSED')); };
    const cleanup = (): void => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
  });
}

function errorEvent(error: unknown): Readonly<{message: string; code: string}> {
  if (error instanceof Error && ['OBSERVATION_TIMEOUT', 'OBSERVATION_RESYNC_REQUIRED'].includes(error.message)) {
    return {code: error.message, message: 'Observation interrupted; execution status must be synchronized.'};
  }
  const mapped = mapError(error);
  return {message: mapped.status === 500 ? messageFor('INTERNAL_ERROR') : mapped.message, code: mapped.code};
}

export function agentRoute(): StreamRoute {
  return {
    method: 'POST',
    segments: ['v1', 'agent'],
    stream: true,
    async handle(context: RouteContext, response: ServerResponse): Promise<void> {
      const key = idempotencyKey(context.request);
      const body = await readJsonObject(context.request, context.bodyLimitBytes, context.counter);
      const agent = context.commands.agent;
      if (agent === undefined) throw new ApiError(503, 'RUNTIME_NOT_READY', messageFor('RUNTIME_NOT_READY'));
      const parsed = parseRunAgentInput(body);
      streamHeaders(response, context.requestId);
      context.logStreamOpen();
      if (!parsed.ok) {
        await writeFrame(response, {type: 'RUN_ERROR', message: parsed.message, code: parsed.code});
        response.end();
        return;
      }
      const threadId = parsed.value.threadId;
      const runId = randomUUID();
      const controller = new AbortController();
      const onError = (): void => { controller.abort(); };
      response.on('error', onError);
      const onClose = (): void => {
        if (!response.writableEnded) {
          controller.abort();
        }
      };
      context.request.once('close', onClose);
      response.once('close', onClose);
      let run: AgentRunStream | undefined;
      try {
        run = await agent.start({chatId: threadId, text: parsed.value.text, requestId: key}, controller.signal);
      } catch (error) {
        const failure = errorEvent(error);
        if (!response.destroyed && !response.writableEnded) {
          await writeFrame(response, {type: 'RUN_ERROR', message: failure.message, code: failure.code}).catch(() => undefined);
          response.end();
        }
        context.request.off('close', onClose);
        response.off('close', onClose);
        response.off('error', onError);
        return;
      }
      const projection = new RunProjection(event => writeFrame(response, event), {threadId, runId});
      try {
        await projection.started();
        for await (const event of run.events) {
          if (controller.signal.aborted) break;
          if (event.type === 'run_end') {
            await projection.finish(event.outcome);
            break;
          }
          await projection.handle(event);
        }
      } catch (error) {
        // A closed client is truncation, never an error boundary.
        if (!controller.signal.aborted && !response.destroyed && !response.writableEnded) {
          const failure = errorEvent(error);
          await projection.error(failure.code, failure.message).catch(() => undefined);
        }
      } finally {
        context.request.off('close', onClose);
        response.off('close', onClose);
        await run.cancel().catch(() => undefined);
        if (!response.writableEnded && !response.destroyed) response.end();
        response.off('error', onError);
      }
    },
  };
}

export { PROTOCOL_VERSION };
export type { IncomingMessage };
