import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

/** Read-only admission before the SDK can initialize or migrate an existing database.
 * These identifiers/version are deliberately coupled to the pinned Durable 1.3.0.
 * Changing them requires the separate backup/migration work package.
 */
export async function preflightStorage(path: string): Promise<void> {
  try { await stat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    // A crash before initial schema commit may leave a valid empty SQLite file.
    if (tables.length === 0) return;
    if (!tables.some(row => row.name === 'durable_schema')) throw new Error('UNRECOGNIZED_STORAGE');
    const schema = db.prepare('SELECT version FROM durable_schema WHERE singleton = 1').get();
    if (schema?.version !== 1) throw new Error('STORAGE_UPGRADE_REQUIRED');
  } finally { db.close(); }
}
