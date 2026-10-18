import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openService } from './service.mjs';
import { argumentsFor, boundedString, json, readBody } from './util.mjs';

const { values } = argumentsFor({
  port: { type: 'string', default: '4788' }, data: { type: 'string' },
  model: { type: 'string', default: 'faux/faux-1' }, auth: { type: 'string' }, thinking: { type: 'string', default: 'medium' },
  sink: { type: 'string' }, 'unsafe-delivery': { type: 'boolean' }, fault: { type: 'string' }, 'fail-step': { type: 'boolean' }, 'verify-steps': { type: 'boolean' },
  'steel-url': { type: 'string', default: process.env.STEEL_BROWSER_API_URL },
  'steel-viewer-url': { type: 'string', default: process.env.STEEL_VIEWER_URL },
  'browser-idle-ms': { type: 'string' },
  webrtc: { type: 'boolean', default: false }, 'webrtc-python': { type: 'string' },
});
const dataDir = resolve(values.data ?? fileURLToPath(new URL('../runtime/default', import.meta.url)));
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
const service = await openService({
  dataDir, model: values.model, authFile: values.auth ?? process.env.POINT_AUTH_FILE, sinkUrl: values.sink, thinkingLevel: values.thinking,
  deliverySafe: !values['unsafe-delivery'], fault: values.fault, failStep: values['fail-step'],
  verifySteps: values['verify-steps'],
  steelUrl: values['steel-url'], steelViewerUrl: values['steel-viewer-url'],
  browserIdleMs: values['browser-idle-ms'] === undefined ? undefined : Number(values['browser-idle-ms']),
  webrtc: values.webrtc, webrtcPython: values['webrtc-python'],
});
let stopping = false;
const streams = new Set();
const server = createServer(async (request, response) => {
  try {
    if (stopping) return json(response, 503, { error: 'Service stopping' });
    // Local-only prototype: reject browser cross-origin mutation and DNS-rebinding Host headers.
    const host = request.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return json(response, 403, { error: 'Local Host required' });
    if (request.headers.origin && request.headers.origin !== `http://${host}`) return json(response, 403, { error: 'Cross-origin request rejected' });
    const url = new URL(request.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = request.method;
    if (method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true, pid: process.pid, dataDir });
    if (method === 'GET' && url.pathname === '/state') return json(response, 200, await service.snapshot(url.searchParams.get('chatId') ?? undefined));
    if (method === 'GET' && url.pathname === '/chats') return json(response, 200, (await service.snapshot()).chats);
    if (method === 'GET' && url.pathname === '/memory') return json(response, 200, (await service.snapshot()).memories);
    if (method === 'GET' && url.pathname === '/browser') return json(response, 200, await service.browser.status());
    if (method === 'GET' && url.pathname === '/browser/rtc/status') return json(response, 200, await service.browser.rtc?.status() ?? { enabled: false });
    if (method === 'GET' && ['/browser/view', '/browser/rtc-viewer.mjs'].includes(url.pathname)) {
      if (!service.browser.rtc) return json(response, 503, { error: 'Start the service with --webrtc' });
      const script = url.pathname.endsWith('.mjs');
      response.writeHead(200, { 'content-type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'" });
      return response.end(await readFile(new URL(script ? './rtc-viewer.mjs' : './rtc-viewer.html', import.meta.url)));
    }
    if (method === 'GET' && parts[0] === 'chats' && parts.length === 3) {
      if (parts[2] === 'messages') {
        let cursor;
        try { cursor = url.searchParams.has('cursor') ? JSON.parse(url.searchParams.get('cursor')) : undefined; }
        catch { return json(response, 400, { error: 'Invalid cursor' }); }
        return json(response, 200, await service.readChat(parts[1], Number(url.searchParams.get('limit') ?? 30), cursor));
      }
      if (parts[2] === 'context') return json(response, 200, await service.chatContext(parts[1]));
    }
    if (method === 'GET' && url.pathname === '/history') return json(response, 200, await service.history(url.searchParams.get('conversation') ?? undefined));
    if (method === 'GET' && url.pathname === '/inspect') return json(response, 200, await service.harness.inspect(BACKGROUND_CONTEXT));
    if (method === 'GET' && url.pathname === '/events') {
      const chatId = url.searchParams.get('chatId') ?? undefined;
      if (chatId) await service.readChat(chatId, 1);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      streams.add(response);
      let pending = false, pumping = false, ended = false;
      const pump = async () => {
        pending = true;
        if (pumping || ended) return;
        pumping = true;
        try {
          while (pending && !ended) {
            pending = false;
            const state = await service.snapshot(chatId);
            if (ended) break;
            response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
            if (response.writableLength > 1024 * 1024) response.destroy();
          }
        } catch { response.end(); }
        finally { pumping = false; }
      };
      const unsubscribe = service.harness.subscribeCommits(() => { void pump(); });
      const heartbeat = setInterval(() => { if (!ended) response.write(': heartbeat\n\n'); }, 15000);
      response.on('close', () => { ended = true; clearInterval(heartbeat); unsubscribe(); streams.delete(response); });
      void pump();
      return;
    }
    if (method === 'GET' && url.pathname === '/jobs') return json(response, 200, (await service.snapshot()).jobs);
    if (method === 'GET' && parts[0] === 'jobs' && parts.length === 2) {
      const job = (await service.snapshot()).jobs.find(item => item.id === parts[1]);
      return json(response, job ? 200 : 404, job ?? { error: 'Unknown job' });
    }
    if (method !== 'POST') return json(response, 404, { error: 'Unknown route' });
    const body = await readBody(request);
    if (parts[0] === 'browser' && parts[1] === 'rtc' && parts.length === 3) {
      if (!service.browser.rtc) return json(response, 503, { error: 'WebRTC is disabled' });
      if (parts[2] === 'offer') return json(response, 200, await service.browser.rtc.offer(body));
      if (parts[2] === 'close') return json(response, 200, await service.browser.rtc.remove(body.peerId));
    }
    if (parts[0] === 'browser' && parts.length === 2) {
      if (parts[1] === 'forget-profile') return json(response, 200, await service.browser.forgetProfile(body.profile));
      if (['open', 'observe', 'act', 'reconcile', 'close', 'screenshot', 'handoff', 'resume'].includes(parts[1])) {
        return json(response, 200, await service.browser.forUser(parts[1], body, body.requestId));
      }
    }
    if (url.pathname === '/chat') {
      const action = body.wait === false ? service.admitChat : service.chat;
      return json(response, body.wait === false ? 202 : 200, await action(boundedString(body.text, 'text'), body.requestId, body.chatId, body.whenBusy));
    }
    if (url.pathname === '/chat/stop') { await service.stopChat(body.chatId); return json(response, 200, { stopped: true }); }
    if (url.pathname === '/chats') return json(response, 201, await service.createChat(body, body.requestId));
    if (url.pathname === '/memory') return json(response, 200, await service.remember(body));
    if (url.pathname === '/memory/forget') return json(response, 200, await service.forgetMemory(body.key, undefined, body.requestId));
    if (parts[0] === 'chats' && parts.length === 3) {
      if (parts[2] === 'update') return json(response, 200, await service.updateChat(parts[1], body));
      if (parts[2] === 'share') return json(response, 202, await service.shareChat(parts[1], body.requestId));
      if (parts[2] === 'compact') return json(response, 202, await service.compactChat(parts[1], body.instructions, body.wait === true));
    }
    if (url.pathname === '/jobs') return json(response, 201, await service.createJob(body, body.requestId));
    if (parts[0] === 'jobs' && parts.length === 3) {
      if (parts[2] === 'revise') return json(response, 200, await service.reviseJob(parts[1], body.requirement, body.requestId));
      if (parts[2] === 'cancel') return json(response, 200, await service.cancelJob(parts[1]));
      if (parts[2] === 'followup') return json(response, 200, await service.rescheduleJob(parts[1], body.afterMs, body.requestId));
    }
    return json(response, 404, { error: 'Unknown route' });
  } catch (error) {
    if (!response.headersSent) json(response, error.statusCode ?? 500, { error: String(error.message ?? error) });
    else response.end();
  }
});

try {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  });
} catch (error) { await service.close(); throw error; }
const ready = { event: 'ready', url: `http://127.0.0.1:${server.address().port}`, pid: process.pid, dataDir, model: values.model };
await service.browser.setViewerOrigin(ready.url);
console.log(JSON.stringify(ready));
process.send?.(ready);

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const stream of streams) stream.end();
  try { await service.close(); process.exitCode = exitCode; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  server.closeAllConnections();
  process.disconnect?.();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
service.harness.closed.then(result => {
  if (result.reason === 'failed' && !stopping) {
    console.error(JSON.stringify({ event: 'harness-failed', message: String(result.error?.message ?? result.error) }));
    void shutdown(1);
  }
});
