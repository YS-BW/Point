import {
  exportUserMarkdown, parseForgetProfile, parseRememberProfile,
  type ForgetProfile, type ProfileEntry, type RememberProfile,
} from '../domain/profile.js';

/** The implementation must commit the receipt and the entry change in one transaction. */
export interface ProfileStore {
  remember(command: RememberProfile): Promise<ProfileEntry>;
  forget(command: ForgetProfile): Promise<{key: string; removed: boolean}>;
  /** Read-only snapshot, sorted by key. */
  list(): Promise<ProfileEntry[]>;
}
export interface ProfileCommands {
  remember(input: unknown): Promise<ProfileEntry>;
  forget(input: unknown): Promise<{key: string; removed: boolean}>;
  list(): Promise<ProfileEntry[]>;
  /** Pure Markdown export; nothing is written and no external file is watched. */
  exportMarkdown(): Promise<string>;
}
export function profileCommands(store: ProfileStore): ProfileCommands {
  return {
    async remember(input) { return store.remember(parseRememberProfile(input)); },
    async forget(input) { return store.forget(parseForgetProfile(input)); },
    async list() { return store.list(); },
    async exportMarkdown() { return exportUserMarkdown(await store.list()); },
  };
}
