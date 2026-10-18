import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserExtension } from '../src/browser.mjs';
import { SteelBackend } from '../src/steel.mjs';

test('A stalled screenshot cannot block manual takeover or a media source connection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'point-browser-isolation-'));
  const now = Date.now();
  const state = { browserOwners: { 1: 'browser' }, browserProfiles: {}, browserRequests: {}, browserSessions: {
    browser: { id: 'browser', sessionId: 'session', pageId: 'page', conversationId: 1, owner: { kind: 'chat', id: 'main', name: '主会话' },
      status: 'live', viewerUrl: 'http://127.0.0.1:4788/browser/view', expiresAt: now + 120000, hardExpiresAt: now + 1800000, humanControl: false },
  } };
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  t.mock.method(SteelBackend.prototype, 'screenshot', async () => { started(); await blocked; return Buffer.from('fixture screenshot'); });
  t.mock.method(SteelBackend.prototype, 'live', async () => ({ id: 'session', status: 'live', websocketUrl: 'ws://127.0.0.1:3000' }));
  t.mock.method(SteelBackend.prototype, 'page', async () => ({ page: {} }));
  t.mock.method(SteelBackend.prototype, 'pageId', async () => 'page');
  const manager = createBrowserExtension({ getState: async () => structuredClone(state),
    commit: async run => run({ doc: async () => state }), rootId: () => 1, dataDir: directory, workspace: directory,
    apiUrl: 'http://127.0.0.1:3000', webrtc: true });
  const screenshot = manager.screenshot(1, 'browser');
  t.after(async () => { release(); await screenshot; await manager.disconnect(); await rm(directory, { recursive: true, force: true }); });
  await waiting;
  let timer;
  try {
    const result = await Promise.race([
      Promise.all([manager.handoff(1, 'browser'), manager.mediaSource('browser')]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Screenshot blocked takeover/media')), 1000); }),
    ]);
    assert.equal(result[0].browser.humanControl, true);
    assert.equal(result[1].pageId, 'page');
    assert(state.browserSessions.browser.expiresAt > now + 120000);
  } finally { clearTimeout(timer); }
});
