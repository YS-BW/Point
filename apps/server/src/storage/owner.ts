import { DatabaseSync } from 'node:sqlite';

/** Technical OS-released lock; never a store of product facts. */
export function acquireOwner(path: string): () => void {
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
  catch { db.close(); throw new Error('DATA_DIR_BUSY'); }
  let closed = false;
  return () => { if (!closed) { db.close(); closed = true; } };
}
