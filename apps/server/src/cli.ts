/**
 * Reference AG-UI consumer for WP5. It proves the `POST /v1/agent` contract is
 * consumable from a plain Node process; it is not a replacement for the prototype CLI.
 *
 * Usage:
 *   POINT_API_TOKEN=... node apps/server/dist/src/cli.js --message "你好"
 *   node apps/server/dist/src/cli.js --url http://127.0.0.1:4310 --token ... --chat 12 --message "继续"
 */

import { randomUUID } from 'node:crypto';

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
      const usage = event.usage as {totalTokens?: unknown} | undefined;
      process.stdout.write(`[done] outcome=${String(event.outcome)} totalTokens=${String(usage?.totalTokens ?? 0)}\n`);
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

async function consume(response: Response): Promise<number> {
  if (response.status !== 200) {
    const text = await response.text();
    process.stderr.write(`[error] HTTP ${response.status}: ${text}\n`);
    return 1;
  }
  if (response.body === null) throw new Error('EMPTY_STREAM');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let failed = false;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, {stream: true});
    let separator = buffer.indexOf('\n\n');
    while (separator >= 0) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload.length === 0) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
        if (event.type === 'RUN_ERROR') failed = true;
        printSummary(event);
      }
      separator = buffer.indexOf('\n\n');
    }
  }
  return failed ? 1 : 0;
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
  const stream = await call(`${args.url}/v1/agent`, args.token, {
    threadId: chatId, runId,
    messages: [{id: randomUUID(), role: 'user', content: args.message}],
  }, `cli-run-${randomUUID()}`, controller.signal);
  try {
    return await consume(stream);
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
