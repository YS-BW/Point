export type Chat = Readonly<{id: string; name: string; createdAt: number}>;
export type CreateChat = Readonly<{requestId: string; name: string}>;

export class CommandError extends Error {
  constructor(readonly code: 'INVALID_COMMAND' | 'IDEMPOTENCY_CONFLICT') {
    super(code);
    this.name = 'CommandError';
  }
}

/** No coercion: malformed client input must not silently become another command. */
export function parseCreateChat(input: unknown): CreateChat {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CommandError('INVALID_COMMAND');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'requestId' && key !== 'name')
    || !Object.hasOwn(value, 'requestId') || !Object.hasOwn(value, 'name')
    || typeof value.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.requestId)
    || typeof value.name !== 'string' || /\p{Cc}/u.test(value.name)) throw new CommandError('INVALID_COMMAND');
  const name = value.name.trim();
  if (!name || Array.from(name).length > 120) throw new CommandError('INVALID_COMMAND');
  return {requestId: value.requestId, name};
}
