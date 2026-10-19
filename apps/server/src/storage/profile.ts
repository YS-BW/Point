import { defineDoc, defineDocFamily } from '@earendil-works/pi-durable';
import type { ProfileEntry } from '../domain/profile.js';

/** Entries are keyed by their profile key, so an explicit update never creates a duplicate. */
export type ProfileDocument = { entries: Record<string, ProfileEntry> };

/** The single authority for explicit memory; USER.md is only a pure export of it. */
export const Profile = defineDoc({
  kind: 'point.profile', version: 1, scope: 'session',
  initial: (): ProfileDocument => ({entries: {}}),
});

/** Immutable command outcome for remember/forget, committed with the entry change. */
export type ProfileReceipt = {
  fingerprint: string;
  entry: ProfileEntry | null;
  removed: boolean | null;
};
export const ProfileReceipts = defineDocFamily({
  kind: 'point.command.profile', version: 1, scope: 'session', family: true,
  initial: (fingerprint: string): ProfileReceipt => ({fingerprint, entry: null, removed: null}),
});
