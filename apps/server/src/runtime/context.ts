import { defineExtension, section, type Extension } from '@earendil-works/pi-durable';
import { renderProfilePrompt } from '../domain/profile.js';
import { Chats } from '../storage/chats.js';
import { Profile } from '../storage/profile.js';
import { memoryEntry, type MemoryDocument } from '../storage/state.js';
import type { SessionDocumentScanner } from './schedules.js';

/**
 * Section keys. The SDK requires `^[a-z][a-z0-9_-]*$`, so the contract's `point.identity` family is
 * spelled with underscores; the values are exported for tests instead of guessed.
 */
export const SECTION_KEYS = {identity: 'point_identity', chat: 'point_chat', profile: 'point_profile'} as const;

/** Stable persona and boundaries; small on purpose and never claim unverified success. */
export const IDENTITY_TEXT = '你是 Point 的对话助手。保持稳定、克制的人格与边界；使用简洁中文回答；不得声称未证实或未验证的成功。用户当前的要求优先于参考信息。';

/**
 * Prompt sections rendered before every request: identity, the current chat, and the explicitly saved
 * profile. Reads only committed documents (`pi.chat`, `point.chat`, `point.profile`); an empty profile
 * omits its section instead of rendering an empty tag.
 */
export function contextExtension(scan?: SessionDocumentScanner): Extension {
  return defineExtension({
    name: 'point.context',
    sections: [
      section(SECTION_KEYS.identity, () => IDENTITY_TEXT, {tag: false}),
      section(SECTION_KEYS.chat, async (input, context) => {
        const chatId = String(input.conversationId);
        const chat = await input.read.snapshot(Chats, chatId, context);
        return chat ? `当前会话：${chat.name}；chatId=${chatId}。` : '当前是内部执行会话。';
      }),
      section(SECTION_KEYS.profile, async (input, context) => {
        // v2 memory family is canonical; the legacy single map is a read-only fallback for v1 databases.
        if (scan !== undefined) {
          const entries = [];
          for (const document of await scan('point.memory')) {
            const value = document.value as Partial<MemoryDocument>;
            if (typeof value.key !== 'string' || value.key !== document.key || typeof value.value !== 'string'
              || (value.kind !== 'fact' && value.kind !== 'preference' && value.kind !== 'decision')
              || typeof value.sourceChatId !== 'string' || typeof value.updatedAt !== 'number') continue;
            entries.push(memoryEntry(value as MemoryDocument));
          }
          if (entries.length > 0) return renderProfilePrompt(entries);
        }
        const profile = await input.read.snapshot(Profile, context);
        if (!profile) return undefined;
        return renderProfilePrompt(Object.values(profile.entries).map(entry => ({...entry})));
      }),
    ],
  });
}
