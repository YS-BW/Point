import { rm } from 'node:fs/promises';

// Only generated output, anchored to this script rather than the caller's cwd.
await rm(new URL('../apps/server/dist/', import.meta.url), {recursive: true, force: true});
