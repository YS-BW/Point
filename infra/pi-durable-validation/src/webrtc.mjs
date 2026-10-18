import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { boundedString, fail } from './util.mjs';

/** The Python worker owns only media peers, never Steel/browser lifetime. */
export class WebRTCBridge {
  constructor({ python, source, input }) {
    this.python = python ?? fileURLToPath(new URL('../runtime/webrtc-venv/bin/python', import.meta.url));
    this.source = source; this.input = input; this.bindings = new Map();
  }
  async start() {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      this.token = randomBytes(32).toString('hex');
      const child = this.child = spawn(this.python, [fileURLToPath(new URL('../webrtc/bridge.py', import.meta.url))], {
        stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, POINT_RTC_TOKEN: this.token },
      });
      let ready = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error('WebRTC media worker startup timed out')); }, 10000);
      const lines = createInterface({ input: child.stdout });
      child.stderr.on('data', () => {}); // Never echo SDP, page data or input into the agent log.
      child.stdin.on('error', () => {});
      child.on('error', () => { clearTimeout(timer); this.starting = null; this.child = null; reject(new Error('WebRTC runtime unavailable; run npm run setup:webrtc')); });
      child.on('exit', () => {
        clearTimeout(timer); this.starting = null; this.child = null; this.bindings.clear();
        if (!ready) reject(new Error('WebRTC runtime failed; run npm run setup:webrtc'));
      });
      lines.on('line', line => {
        let message; try { message = JSON.parse(line); } catch { return; }
        if (message.event === 'ready') { clearTimeout(timer); this.url = message.url; ready = true; resolve(); }
        else if (message.event === 'peer_closed') this.bindings.delete(message.peerId);
        else if (message.event === 'input') void (async () => {
          const binding = this.bindings.get(message.peerId);
          let result;
          try { if (!binding) fail('Viewer expired', 409); await this.input(binding, message.payload); result = { ok: true }; }
          catch (error) { result = { error: error.message }; }
          if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ requestId: message.requestId, result }) + '\n');
        })();
      });
    });
    return this.starting;
  }
  async request(path, method, body) {
    const response = await fetch(this.url + path, { method, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
    if (!response.ok) fail(`WebRTC media connection failed (HTTP ${response.status})`, 502);
    return response.json();
  }
  async offer(args) {
    boundedString(args.sdp, 'SDP', 128000);
    const source = await this.source(args.browserId);
    await this.start();
    const peerId = randomUUID();
    this.bindings.set(peerId, { browserId: args.browserId, pageId: source.pageId });
    try { return await this.request('/offer', 'POST', { source, sdp: args.sdp, peerId }); }
    catch (error) { this.bindings.delete(peerId); throw error; }
  }
  async remove(peerId) {
    if (this.bindings.has(peerId) && this.child) await this.request(`/peers/${peerId}`, 'DELETE');
    this.bindings.delete(peerId);
    return { closed: true };
  }
  async status() { return this.child ? this.request('/status', 'GET') : { peers: 0, sources: 0, pid: null }; }
  async closeBrowser(browserId) {
    await Promise.all([...this.bindings].filter(([, binding]) => binding.browserId === browserId).map(([peerId]) => this.remove(peerId)));
  }
  async close() {
    const child = this.child;
    if (!child) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin.end();
    });
  }
}
