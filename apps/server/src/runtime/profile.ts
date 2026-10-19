import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Harness } from '@earendil-works/pi-durable';
import type { ProfileStore } from '../application/profile.js';
import { MAX_PROFILE_ENTRIES, ProfileError, type ProfileEntry, type ProfileKind } from '../domain/profile.js';
import { Profile, ProfileReceipts } from '../storage/profile.js';

type HarnessAccess = Pick<Harness, 'commit' | 'snapshot'>;

function fingerprint(command: object): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function sameKey(a: ProfileEntry, b: ProfileEntry): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Durable profile store. Remember/forget receipt and entry change share one commit; the message table and
 * the document ledger stay the only facts (agent-core.md #1/#4). Nothing writes USER.md.
 */
export function durableProfileStore(access: () => HarnessAccess): ProfileStore {
  return {
    remember(command) {
      const commandFingerprint = fingerprint(command);
      return access().commit(async tx => {
        const receipt = await tx.doc(ProfileReceipts, command.requestId, commandFingerprint);
        if (receipt.fingerprint !== commandFingerprint) throw new ProfileError('IDEMPOTENCY_CONFLICT');
        if (receipt.entry) return {...receipt.entry};
        const profile = await tx.doc(Profile);
        if (!Object.hasOwn(profile.entries, command.key)
          && Object.keys(profile.entries).length >= MAX_PROFILE_ENTRIES) throw new ProfileError('PROFILE_LIMIT_REACHED');
        const entry: ProfileEntry = {
          key: command.key,
          value: command.value,
          kind: command.kind as ProfileKind,
          sourceChatId: command.sourceChatId,
          updatedAt: Date.now(),
        };
        profile.entries[command.key] = entry;
        receipt.entry = entry;
        return {...entry};
      }, context);
    },
    forget(command) {
      const commandFingerprint = fingerprint(command);
      return access().commit(async tx => {
        const receipt = await tx.doc(ProfileReceipts, command.requestId, commandFingerprint);
        if (receipt.fingerprint !== commandFingerprint) throw new ProfileError('IDEMPOTENCY_CONFLICT');
        if (receipt.removed !== null) return {key: command.key, removed: receipt.removed};
        const profile = await tx.doc(Profile);
        const removed = Object.hasOwn(profile.entries, command.key);
        if (removed) delete profile.entries[command.key];
        receipt.removed = removed;
        return {key: command.key, removed};
      }, context);
    },
    async list() {
      const profile = await access().snapshot(Profile, context);
      if (!profile) return [];
      return Object.values(profile.entries).map(entry => ({...entry})).sort(sameKey);
    },
  };
}
