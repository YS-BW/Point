import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { browserFixture } from './browser-fixture.mjs';
import { ROOT, RUN_DIR, launch, stop, get, post, until } from './helpers.mjs';

const cleanups = [];
const fixture = await browserFixture();
let daemon, sessionId;
const evidence = { tests: [], runDirectory: RUN_DIR };
try {
  daemon = await launch({ after: fn => cleanups.push(fn) }, { extra: ['--steel-url', 'http://127.0.0.1:3000/v1', '--webrtc'] });
  const opened = await post(daemon, '/browser/open', { url: fixture.url });
  sessionId = opened.browser.sessionId;
  assert(opened.browser.viewerUrl.startsWith(daemon.url + '/browser/view'));
  assert.equal((await get(daemon, '/browser')).transport, 'webrtc');
  assert((await fetch(opened.browser.viewerUrl)).ok);
  const session = await (await fetch(`http://127.0.0.1:3000/v1/sessions/${sessionId}`)).json();
  const browser = await puppeteer.connect({ browserWSEndpoint: session.websocketUrl, defaultViewport: null });
  let points;
  try {
    for (const page of await browser.pages()) {
      const cdp = await page.createCDPSession();
      const id = (await cdp.send('Target.getTargetInfo')).targetInfo.targetId; await cdp.detach();
      if (id === new URL(opened.browser.viewerUrl).searchParams.get('pageId')) points = await page.evaluate(() => {
        const center = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
        return { note: center('[name=note]'), save: center('#save'), marker: center('#video-marker'), next: center('a[href="/next"]') };
      });
    }
  } finally { await browser.disconnect(); }
  assert(points);
  const probe = await new Promise((resolve, reject) => {
    const child = spawn(join(ROOT, 'runtime/webrtc-venv/bin/python'), [join(ROOT, 'webrtc/probe.py'), daemon.url, opened.browser.id, JSON.stringify(points)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errors = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    const timer = setTimeout(() => child.kill(), 45000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(JSON.parse(out)); else reject(new Error(`WebRTC probe failed (${code}): ${errors}`)); });
  });
  assert.equal(fixture.saves.filter(value => value === 'WebRTC 数据通道 OK').length, 1);
  const released = await until(() => get(daemon, '/browser/rtc/status'), value => value.peers === 0 && value.sources === 0);
  evidence.tests.push({ name: 'Real VP8/SRTP decoding, read-only denial, DataChannel pointer/text/space-key input, handoff/resume and peer cleanup', ...probe, released });
  // Kill the parent while the media worker exists. Its stdin EOF must stop the worker.
  const workerPid = released.pid;
  await stop(daemon, 'SIGKILL');
  await until(async () => { try { process.kill(workerPid, 0); return false; } catch { return true; } }, Boolean);
  daemon = await launch({ after: fn => cleanups.push(fn) }, { directory: daemon.directory, extra: ['--steel-url', 'http://127.0.0.1:3000/v1', '--webrtc'] });
  const restored = await post(daemon, '/browser/observe', { browserId: opened.browser.id });
  assert.equal(restored.browser.sessionId, sessionId);
  assert.match(restored.text, /Browser next page/);
  assert(restored.url.endsWith('/next'));
  await post(daemon, '/browser/close', { browserId: opened.browser.id });
  evidence.tests.push({ name: 'Parent SIGKILL releases the media worker; Durable retains the same Steel session and navigated page', status: 'passed', sessionId });
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await Promise.all(cleanups.map(fn => fn()));
  if (sessionId) {
    const current = await (await fetch(`http://127.0.0.1:3000/v1/sessions/${sessionId}`)).json();
    if (current.id === sessionId && current.status === 'live') await fetch(`http://127.0.0.1:3000/v1/sessions/${sessionId}/release`, { method: 'POST' });
  }
  await fixture.close();
  await writeFile(join(ROOT, 'runtime/webrtc-results.json'), JSON.stringify(evidence, null, 2));
  await writeFile(join(RUN_DIR, 'webrtc-results.json'), JSON.stringify(evidence, null, 2));
}
