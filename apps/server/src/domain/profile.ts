/**
 * Explicit profile: the only memory the product keeps, and only when the user asks for it.
 *
 * `point.profile` is the single authority. USER.md is a pure export of this value, never a second writable
 * source (agent-core.md #7). Nothing here touches the file system, listens for changes, or extracts facts
 * from conversations.
 */

export type ProfileKind = 'fact' | 'preference' | 'decision';

/** One saved entry. `sourceChatId` and `updatedAt` keep it traceable; forgetting removes it, not history. */
export type ProfileEntry = Readonly<{
  key: string;
  value: string;
  kind: ProfileKind;
  sourceChatId: string;
  updatedAt: number;
}>;

export type RememberProfile = Readonly<{
  requestId: string;
  key: string;
  value: string;
  kind: ProfileKind;
  sourceChatId: string;
}>;

export type ForgetProfile = Readonly<{requestId: string; key: string}>;

export type ProfileErrorCode = 'INVALID_COMMAND' | 'IDEMPOTENCY_CONFLICT' | 'PROFILE_LIMIT_REACHED';

/** Domain failure of a profile command. Transport-independent, like `CommandError`. */
export class ProfileError extends Error {
  constructor(readonly code: ProfileErrorCode) {
    super(code);
    this.name = 'ProfileError';
  }
}

/** Maximum number of saved entries; updating an existing key is always allowed. */
export const MAX_PROFILE_ENTRIES = 64;
/** Longest accepted entry value, in Unicode code points. */
export const MAX_PROFILE_VALUE_CHARS = 4000;
/** Total budget of the rendered profile prompt section, in UTF-16 code units (prompt text is ASCII-safe here). */
export const MAX_PROFILE_PROMPT_CHARS = 8000;
/** Longest value rendered per entry in the prompt, including the `…` marker when truncated. */
export const MAX_PROFILE_PROMPT_VALUE_CHARS = 500;

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SOURCE_CHAT_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const KINDS: readonly ProfileKind[] = ['fact', 'preference', 'decision'];

function strictObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ProfileError('INVALID_COMMAND');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new ProfileError('INVALID_COMMAND');
  }
  return value;
}

function parseKey(value: unknown): string {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) throw new ProfileError('INVALID_COMMAND');
  return value;
}

function parseRequestId(value: unknown): string {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value)) throw new ProfileError('INVALID_COMMAND');
  return value;
}

/** Trim, then require a non-empty, bounded value. No coercion from other types. */
function parseValue(value: unknown): string {
  if (typeof value !== 'string') throw new ProfileError('INVALID_COMMAND');
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > MAX_PROFILE_VALUE_CHARS) throw new ProfileError('INVALID_COMMAND');
  return trimmed;
}

function parseKind(value: unknown): ProfileKind {
  if (typeof value !== 'string' || !KINDS.includes(value as ProfileKind)) throw new ProfileError('INVALID_COMMAND');
  return value as ProfileKind;
}

function parseSourceChatId(value: unknown): string {
  if (typeof value !== 'string' || !SOURCE_CHAT_PATTERN.test(value)) throw new ProfileError('INVALID_COMMAND');
  return value;
}

export function isProfileKind(value: unknown): value is ProfileKind {
  return typeof value === 'string' && KINDS.includes(value as ProfileKind);
}

/** `remember({requestId, key, value, kind, sourceChatId})`: explicit save, no inference from the conversation. */
export function parseRememberProfile(input: unknown): RememberProfile {
  const value = strictObject(input, ['requestId', 'key', 'value', 'kind', 'sourceChatId']);
  return {
    requestId: parseRequestId(value.requestId),
    key: parseKey(value.key),
    value: parseValue(value.value),
    kind: parseKind(value.kind),
    sourceChatId: parseSourceChatId(value.sourceChatId),
  };
}

/** `forget({requestId, key})`: removes the saved entry without touching conversation history. */
export function parseForgetProfile(input: unknown): ForgetProfile {
  const value = strictObject(input, ['requestId', 'key']);
  return {requestId: parseRequestId(value.requestId), key: parseKey(value.key)};
}

/** Prompt rendering truncates a single value to at most `MAX_PROFILE_PROMPT_VALUE_CHARS`, `…` included. */
export function truncateProfileValue(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= MAX_PROFILE_PROMPT_VALUE_CHARS) return value;
  return `${chars.slice(0, MAX_PROFILE_PROMPT_VALUE_CHARS - 1).join('')}…`;
}

function byKey(a: ProfileEntry, b: ProfileEntry): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function promptLine(entry: ProfileEntry): string {
  return `- [${entry.kind}] ${entry.key}: ${truncateProfileValue(entry.value)}`;
}

/**
 * Render the profile prompt section: entries sorted by key, each value capped, and the whole section kept
 * inside `MAX_PROFILE_PROMPT_CHARS` (the truncation marker included). `undefined` when there is nothing to
 * show, so the section is omitted entirely. The text is reference data, not instructions.
 */
export function renderProfilePrompt(entries: readonly ProfileEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  const sorted = [...entries].sort(byKey);
  const lines: string[] = [];
  let total = 0;
  for (const entry of sorted) {
    const line = promptLine(entry);
    const size = total + (lines.length === 0 ? 0 : 1) + line.length;
    if (size > MAX_PROFILE_PROMPT_CHARS) break;
    lines.push(line);
    total = size;
  }
  let omitted = sorted.length - lines.length;
  if (omitted === 0) return lines.join('\n');
  let marker = `[profile truncated: ${omitted} entries omitted]`;
  total = lines.join('\n').length;
  // Make room for the marker, dropping the earliest overflowed... i.e. the newest retained line, so the
  // earliest entries (the ones already accumulated) stay. The marker itself must fit the budget.
  while (lines.length > 0 && total + 1 + marker.length > MAX_PROFILE_PROMPT_CHARS) {
    lines.pop();
    omitted += 1;
    marker = `[profile truncated: ${omitted} entries omitted]`;
    total = lines.join('\n').length;
  }
  return [...lines, marker].join('\n');
}

/**
 * Pure Markdown export for USER.md. The caller writes the file, if ever: the service never does, and the
 * Durable document remains authoritative.
 */
export function exportUserMarkdown(entries: readonly ProfileEntry[]): string {
  const header = '# USER.md\n\n<!-- exported from point.profile; Durable documents are authoritative -->\n';
  if (entries.length === 0) return header;
  const lines = [...entries].sort(byKey)
    .map(entry => `- [${entry.kind}] ${entry.key}: ${entry.value} (source: chat ${entry.sourceChatId})`);
  return `${header}\n${lines.join('\n')}\n`;
}
