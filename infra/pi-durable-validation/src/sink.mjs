/** Local fake notification receiver. Never sends email, chat messages, or requests to third-party services. */
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { argumentsFor, boundedString, json, readBody } from './util.mjs';

const { values } = argumentsFor({
  port: { type: 'string', default: '4789' }, data: { type: 'string', default: 'runtime/sink.sqlite' },
  'no-idempotency': { type: 'boolean' },
});
const file = resolve(values.data);
await mkdir(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY, key TEXT NOT NULL); CREATE TABLE IF NOT EXISTS effects (id INTEGER PRIMARY KEY, key TEXT NOT NULL, text TEXT NOT NULL, jobId TEXT NOT NULL)');
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/deliveries') return json(response, 200, {
      requests: db.prepare('SELECT * FROM requests ORDER BY id').all(), effects: db.prepare('SELECT * FROM effects ORDER BY id').all(),
    });
    if (request.method !== 'POST' || request.url !== '/deliver') return json(response, 404, { error: 'Unknown route' });
    const body = await readBody(request);
    boundedString(body.key, 'key', 500);
    boundedString(body.text, 'text', 200000);
    boundedString(body.jobId, 'jobId', 100);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO requests(key) VALUES (?)').run(body.key);
      const found = db.prepare('SELECT id FROM effects WHERE key=?').get(body.key);
      if (values['no-idempotency'] || !found) db.prepare('INSERT INTO effects(key,text,jobId) VALUES (?,?,?)').run(body.key, body.text, body.jobId);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return json(response, 200, { key: body.key, accepted: true });
  } catch (error) { json(response, error.statusCode ?? 500, { error: error.message }); }
});
await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(Number(values.port), '127.0.0.1', resolveListen); });
const ready = { event: 'ready', url: `http://127.0.0.1:${server.address().port}`, pid: process.pid };
console.log(JSON.stringify(ready));
process.send?.(ready);
function stop() { server.close(() => { db.close(); process.disconnect?.(); }); server.closeAllConnections(); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
