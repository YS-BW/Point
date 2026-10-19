/**
 * Explicit `/v1` route table: thin transport adapters over existing application
 * commands. No business rules live here — handlers only bind HTTP input to a command
 * and serialize its result.
 */

import type { IncomingMessage } from 'node:http';
import type { ChatCommands } from '../application/chats.js';
import type { ConversationCommands } from '../application/conversation.js';
import type { DeliveryCommands } from '../application/delivery.js';
import type { JobCommands } from '../application/job.js';
import type { ProfileCommands } from '../application/profile.js';
import type { FollowupCommands } from '../application/schedule.js';
import type { HealthReader } from '../application/ports.js';
import { ApiError } from './errors.js';
import { readJsonObject, type BodyCounter } from './json.js';

export type ApiRuntime = Readonly<{
  instanceId: string;
  chats: ChatCommands;
  conversation: ConversationCommands;
  profile: ProfileCommands;
  jobs: JobCommands;
  followups: FollowupCommands;
  deliveries: DeliveryCommands;
}>;

export type RouteContext = Readonly<{
  request: IncomingMessage;
  url: URL;
  params: Readonly<Record<string, string>>;
  commands: ApiRuntime;
  health: HealthReader;
  requestId: string;
  bodyLimitBytes: number;
  counter: BodyCounter;
}>;

export type Route = Readonly<{
  method: 'GET' | 'POST';
  /** Path segments, e.g. `['v1','chats',':chatId']`. */
  segments: readonly string[];
  handle(context: RouteContext): Promise<unknown>;
}>;

/** Frozen contract: 8..128 characters, matching the documented minimum. */
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Every write maps Idempotency-Key to the command requestId; the body may not override it. */
export function idempotencyKey(request: IncomingMessage): string {
  const key = header(request, 'idempotency-key');
  if (key === undefined) throw new ApiError(400, 'INVALID_COMMAND', 'Idempotency-Key is required');
  if (!IDEMPOTENCY_PATTERN.test(key)) {
    throw new ApiError(400, 'INVALID_COMMAND', 'Idempotency-Key must be 8..128 characters');
  }
  return key;
}

function writeInput(
  body: Record<string, unknown>,
  request: IncomingMessage,
  params: Readonly<Record<string, string>>,
  bindings: readonly string[],
): Record<string, unknown> {
  const requestId = idempotencyKey(request);
  if (Object.hasOwn(body, 'requestId')) throw new ApiError(400, 'INVALID_COMMAND', 'requestId comes from Idempotency-Key');
  const input: Record<string, unknown> = {...body, requestId};
  for (const name of bindings) {
    if (Object.hasOwn(body, name)) throw new ApiError(400, 'INVALID_COMMAND', `${name} is taken from the path`);
    const value = params[name];
    if (value === undefined) throw new ApiError(404, 'NOT_FOUND', 'not found');
    input[name] = value;
  }
  return input;
}

function query(request: URL, name: string): string | undefined {
  const values = request.searchParams.getAll(name);
  if (values.length > 1) throw new ApiError(400, 'INVALID_COMMAND', `duplicate ${name}`);
  return values[0];
}

function boundedQuery(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || Array.from(value).length > max) throw new ApiError(400, 'INVALID_COMMAND', 'invalid query');
  return value;
}

function notFound(code: string): never {
  throw new ApiError(404, code, code);
}

export function v1Routes(): readonly Route[] {
  return [
    // Chats and conversation.
    {
      method: 'POST', segments: ['v1', 'chats'],
      async handle({request, commands, requestId, bodyLimitBytes, counter}) {
        const body = await readJsonObject(request, bodyLimitBytes, counter);
        return commands.chats.create(writeInput(body, request, {}, []));
      },
    },
    {
      method: 'GET', segments: ['v1', 'chats', ':chatId'],
      async handle({params, commands}) {
        const chat = await commands.chats.get(params.chatId!);
        return chat ?? notFound('CHAT_NOT_FOUND');
      },
    },
    {
      method: 'POST', segments: ['v1', 'chats', ':chatId', 'messages'],
      async handle({request, params, commands, requestId, bodyLimitBytes, counter}) {
        const body = await readJsonObject(request, bodyLimitBytes, counter);
        return commands.conversation.send(writeInput(body, request, params, ['chatId']));
      },
    },
    {
      method: 'POST', segments: ['v1', 'chats', ':chatId', 'stop'],
      async handle({request, params, commands, requestId, bodyLimitBytes, counter}) {
        const body = await readJsonObject(request, bodyLimitBytes, counter);
        return commands.conversation.stop(writeInput(body, request, params, ['chatId']));
      },
    },
    {
      method: 'POST', segments: ['v1', 'chats', ':chatId', 'compact'],
      async handle({request, params, commands, requestId, bodyLimitBytes, counter}) {
        const body = await readJsonObject(request, bodyLimitBytes, counter);
        return commands.conversation.compact(writeInput(body, request, params, ['chatId']));
      },
    },
    {
      method: 'GET', segments: ['v1', 'chats', ':chatId', 'history'],
      async handle({url, params, commands}) {
        const rawLimit = query(url, 'limit');
        const limit = rawLimit === undefined ? 50 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new ApiError(400, 'INVALID_COMMAND', 'limit must be 1..100');
        }
        const cursor = boundedQuery(query(url, 'cursor'), 4096);
        return commands.conversation.history(params.chatId!, limit, cursor);
      },
    },
    {
      method: 'GET', segments: ['v1', 'commands', ':commandId'],
      async handle({params, commands}) {
        return commands.conversation.status(params.commandId!);
      },
    },

    // Profile.
    {
      method: 'POST', segments: ['v1', 'profile', 'remember'],
      async handle({request, commands, requestId, bodyLimitBytes, counter}) {
        const body = await readJsonObject(request, bodyLimitBytes, counter);
        return commands.profile.remember(writeInput(body, request, {}, []));
      },
    },
    {
      method: 'POST', segments: ['v1', 'profile', 'forget'],
      async handle({request, commands, requestId, bodyLimitBytes, counter}) {
        const body = await readJsonObject(request, bodyLimitBytes, counter);
        return commands.profile.forget(writeInput(body, request, {}, []));
      },
    },
    {
      method: 'GET', segments: ['v1', 'profile'],
      async handle({commands}) { return commands.profile.list(); },
    },
    {
      method: 'GET', segments: ['v1', 'profile', 'export'],
      async handle({commands}) { return {markdown: await commands.profile.exportMarkdown()}; },
    },

    // Jobs and artifacts.
    {
      method: 'POST', segments: ['v1', 'jobs'],
      async handle({request, commands, requestId, bodyLimitBytes, counter}) {
        const body = await readJsonObject(request, bodyLimitBytes, counter);
        return commands.jobs.start(writeInput(body, request, {}, []));
      },
    },
    {
      method: 'GET', segments: ['v1', 'jobs', ':jobId'],
      async handle({params, commands}) {
        const job = await commands.jobs.get(params.jobId!);
        return job ?? notFound('JOB_NOT_FOUND');
      },
    },
    {
      method: 'POST', segments: ['v1', 'jobs', ':jobId', 'amend'],
      async handle({request, params, commands, requestId, bodyLimitBytes, counter}) {
        const body = await readJsonObject(request, bodyLimitBytes, counter);
        return commands.jobs.amend(writeInput(body, request, params, ['jobId']));
      },
    },
    {
      method: 'POST', segments: ['v1', 'jobs', ':jobId', 'cancel'],
      async handle({request, params, commands, requestId, bodyLimitBytes, counter}) {
        const body = await readJsonObject(request, bodyLimitBytes, counter);
        return commands.jobs.cancel(writeInput(body, request, params, ['jobId']));
      },
    },
    {
      method: 'GET', segments: ['v1', 'jobs', ':jobId', 'attempts'],
      async handle({params, commands}) { return commands.jobs.attempts(params.jobId!); },
    },
    {
      method: 'GET', segments: ['v1', 'artifacts', ':artifactId'],
      async handle({params, commands}) {
        const artifact = await commands.jobs.artifact(params.artifactId!);
        return artifact ?? notFound('ARTIFACT_NOT_FOUND');
      },
    },

    // Follow-ups and deliveries (static segments before `:scheduleId`).
    {
      method: 'POST', segments: ['v1', 'followups'],
      async handle({request, commands, requestId, bodyLimitBytes, counter}) {
        const body = await readJsonObject(request, bodyLimitBytes, counter);
        return commands.followups.schedule(writeInput(body, request, {}, []));
      },
    },
    {
      method: 'GET', segments: ['v1', 'followups', 'decisions'],
      async handle({url, commands}) { return commands.followups.decisions(boundedQuery(query(url, 'jobId'), 128)); },
    },
    {
      method: 'GET', segments: ['v1', 'followups', 'deliveries'],
      async handle({url, commands}) { return commands.followups.deliveries(boundedQuery(query(url, 'jobId'), 128)); },
    },
    {
      method: 'POST', segments: ['v1', 'followups', ':scheduleId', 'cancel'],
      async handle({request, params, commands, requestId, bodyLimitBytes, counter}) {
        const body = await readJsonObject(request, bodyLimitBytes, counter);
        return commands.followups.cancel(writeInput(body, request, params, ['scheduleId']));
      },
    },
    {
      method: 'GET', segments: ['v1', 'followups', ':scheduleId'],
      async handle({params, commands}) {
        const schedule = await commands.followups.get(params.scheduleId!);
        return schedule ?? notFound('SCHEDULE_NOT_FOUND');
      },
    },
    {
      method: 'GET', segments: ['v1', 'followups', ':scheduleId', 'occurrences'],
      async handle({params, commands}) { return commands.followups.occurrences(params.scheduleId!); },
    },
    {
      method: 'GET', segments: ['v1', 'deliveries', ':deliveryId'],
      async handle({params, commands}) {
        const delivery = await commands.deliveries.get(params.deliveryId!);
        return delivery ?? notFound('DELIVERY_NOT_FOUND');
      },
    },
  ];
}
