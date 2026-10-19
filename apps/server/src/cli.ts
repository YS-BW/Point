/**
 * Reference AG-UI consumer for WP5. It proves the `POST /v1/agent` contract is
 * consumable from a plain Node process; it is not a replacement for the prototype CLI.
 *
 * Usage:
 *   POINT_API_TOKEN=... node apps/server/dist/src/cli.js --message "你好"
 *   node apps/server/dist/src/cli.js --url http://127.0.0.1:4310 --token ... --chat 12 --message "继续"
 */

import { randomUUID } from 'node:crypto';
import { HttpAgent } from '@ag-ui/client';

type Args = {url: string; token: string; message: string; chat?: string};

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=', 2);
    const value = inline ?? argv[index + 1];
    if (inline === undefined) index += 1;
    if (name === undefined || value === undefined) continue;
    values.set(name, value);
  }
  const url = values.get('url') ?? process.env.POINT_API_URL ?? 'http://127.0.0.1:4310';
  const token = values.get('token') ?? process.env.POINT_API_TOKEN ?? '';
  const message = values.get('message') ?? values.get('text');
  if (token.length === 0) throw new Error('POINT_API_TOKEN or --token is required');
  if (message === undefined || message.length === 0) throw new Error('--message is required');
  const chat = values.get('chat');
  return {url: url.replace(/\/$/, ''), token, message, ...(chat === undefined ? {} : {chat})};
}

async function call(path: string, token: string, body: unknown, key: string, signal: AbortSignal): Promise<Response> {
  return fetch(path, {
    method: 'POST', signal,
    headers: {'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': key},
    body: JSON.stringify(body),
  });
}

function printSummary(event: Record<string, unknown>): void {
  switch (event.type) {
    case 'RUN_STARTED':
      process.stdout.write(`[run] started ${String(event.runId)}\n`);
      break;
    case 'TEXT_MESSAGE_START':
      break;
    case 'TEXT_MESSAGE_CONTENT':
      process.stdout.write(String(event.delta ?? ''));
      break;
    case 'TEXT_MESSAGE_END':
      process.stdout.write('\n');
      break;
    case 'STEP_STARTED':
      process.stdout.write(`[step] ${String(event.stepName)} started\n`);
      break;
    case 'STEP_FINISHED':
      process.stdout.write(`[step] ${String(event.stepName)} finished\n`);
      break;
    case 'TOOL_CALL_START':
      process.stdout.write(`[tool] ${String(event.toolCallName)} (${String(event.toolCallId)})\n`);
      break;
    case 'TOOL_CALL_ARGS':
      process.stdout.write(`[tool args] ${String(event.delta)}\n`);
      break;
    case 'TOOL_CALL_RESULT':
      process.stdout.write(`[tool result] ${String(event.content)}\n`);
      break;
    case 'RUN_FINISHED': {
      const outcome = event.outcome as {type?: string} | undefined;
      process.stdout.write(`[done] outcome=${outcome?.type ?? 'success'}\n`);
      break;
    }
    case 'RUN_ERROR':
      process.stderr.write(`[error] ${String(event.code ?? 'RUN_ERROR')}: ${String(event.message)}\n`);
      break;
    default:
      // Unknown events are tolerated by design.
      break;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let chatId = args.chat;
  if (chatId === undefined) {
    const created = await call(`${args.url}/v1/chats`, args.token, {name: 'AG-UI CLI'},
      `cli-chat-${randomUUID()}`, controller.signal);
    if (!created.ok) {
      process.stderr.write(`[error] chat create failed: HTTP ${created.status}\n`);
      return 1;
    }
    chatId = String((await created.json() as {id: unknown}).id);
  }
  const runId = `cli-${randomUUID()}`;
  const agent = new HttpAgent({
    url: `${args.url}/v1/agent`, threadId: chatId,
    headers: {authorization: `Bearer ${args.token}`, 'idempotency-key': `cli-run-${randomUUID()}`},
    initialMessages: [{id: randomUUID(), role: 'user', content: args.message}],
  });
  let terminal = false;
  let failed = false;
  try {
    await agent.runAgent({runId, abortController: controller}, {
      onEvent: ({event}) => { printSummary(event as unknown as Record<string, unknown>); },
      onRunFinishedEvent: () => { terminal = true; },
      onRunErrorEvent: () => { terminal = true; failed = true; },
      // Point owns the complete history. SDK default merge preserves client-only drafts.
      onMessagesSnapshotEvent: ({event}) => ({messages: event.messages, stopPropagation: true}),
    });
    if (!terminal) throw new Error('STREAM_INCOMPLETE');
    return failed ? 1 : 0;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  // Never print stacks or credentials; the reference client keeps failures short.
  process.stderr.write(`[error] ${error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'CLI_FAILED'}\n`);
  process.exitCode = 1;
}
