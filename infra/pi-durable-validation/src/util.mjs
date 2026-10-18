import { parseArgs } from 'node:util';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const textOf = content => typeof content === 'string' ? content :
  (content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

export function argumentsFor(options, args = process.argv.slice(2)) {
  return parseArgs({ options, args, allowPositionals: true });
}

export function delay(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function atomicText(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
}

export async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) throw Object.assign(new Error('Request exceeds 256 KiB'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
    return value;
  }
  catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
}

export function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode });
}

export function boundedString(value, name, max = 16000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`Invalid ${name}`);
  return value.trim();
}

export function boundedNumber(value, fallback, name, max = 86400000) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 0 || number > max) fail(`Invalid ${name}`);
  return number;
}

export async function api(url, method = 'GET', body, timeout = 30000) {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}
