import assert from 'node:assert/strict';
import { readFile, writeFile, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT, RUN_DIR, launch, stop, get, post, until, faultReached, jobDone } from './helpers.mjs';
import { browserFixture } from './browser-fixture.mjs';

const steel = (process.env.POINT_STEEL_TEST_URL ?? 'http://127.0.0.1:3000/v1').replace(/\/$/, '');
assert((await fetch(`${steel}/health`)).ok, 'Start the local Steel Docker API before running test:steel');
const fixture = await browserFixture();
const cleanups = [], sessions = new Set(), evidence = [];
const t = { after: fn => cleanups.push(fn) };
const extra = ['--steel-url', steel, '--steel-viewer-url', 'http://127.0.0.1:5173'];
const launchBrowser = options => launch(t, { ...options, extra: [...extra, ...(options?.extra ?? [])] });
const opened = result => { sessions.add(result.browser.sessionId); return result; };
const element = (snapshot, name) => { const found = snapshot.elements.find(item => item.name === name); assert(found, `Missing ${name}: ${JSON.stringify(snapshot.elements)}`); return found.ref; };
const act = (daemon, snapshot, action, args, requestId = randomUUID()) => post(daemon, '/browser/act', {
  browserId: snapshot.browser.id, snapshotId: snapshot.snapshotId, action, ...args, requestId,
});
async function scenario(name, run) {
  const started = Date.now();
  try { const details = await run(); evidence.push({ name, status: 'passed', ms: Date.now() - started, ...details }); }
  catch (error) { evidence.push({ name, status: 'failed', ms: Date.now() - started, error: error.message }); throw error; }
  console.log(JSON.stringify(evidence.at(-1)));
}

try {
  await scenario('Real forms, stale references, single-instance isolation, handoff, same-session restart and login restoration', async () => {
    let daemon = await launchBrowser();
    let page = opened(await post(daemon, '/browser/open', { url: fixture.url, profile: 'fixture-login' }));
    const originalSession = page.browser.sessionId;
    assert.equal(page.title, 'Point Steel acceptance');
    assert(!JSON.stringify(page).includes('do-not-return-this-password'));
    const cookieCheckpoint = join(daemon.directory, 'browser-contexts', createHash('sha256').update('fixture-login').digest('hex') + '.json');
    assert.equal((await stat(cookieCheckpoint)).mode & 0o777, 0o600);
    const saved = JSON.parse(await readFile(cookieCheckpoint, 'utf8'));
    assert(saved.cookies.every(cookie => cookie.domain === 'host.docker.internal'));
    assert.deepEqual(Object.keys(saved.localStorage), [new URL(fixture.url).origin]);
    assert.equal(new URL(page.browser.viewerUrl).searchParams.get('interactive'), 'false');
    assert((await fetch(page.browser.viewerUrl)).ok);
    const storage = page.text.match(/Storage: (stored-[\d.]+)/)?.[1]; assert(storage);
    const old = page;
    page = await act(daemon, page, 'fill', { ref: element(page, 'Note'), value: 'first-save' });
    await assert.rejects(act(daemon, old, 'click', { ref: element(old, 'Save note') }), /stale/);
    const requestId = randomUUID();
    const clickInput = page;
    page = await act(daemon, page, 'click', { ref: element(page, 'Save note') }, requestId);
    assert.match(page.text, /Saved: first-save/);
    assert.equal(fixture.saves.filter(value => value === 'first-save').length, 1);
    assert((await act(daemon, clickInput, 'click', { ref: element(clickInput, 'Save note') }, requestId)).reused);
    assert.equal(fixture.saves.filter(value => value === 'first-save').length, 1);
    const shot = await post(daemon, '/browser/screenshot', { browserId: page.browser.id });
    assert.equal((await readFile(shot.path)).subarray(1, 4).toString(), 'PNG');
    const handoff = await post(daemon, '/browser/handoff', { browserId: page.browser.id });
    assert.equal(new URL(handoff.browser.viewerUrl).searchParams.get('interactive'), 'true');
    await assert.rejects(act(daemon, page, 'click', { ref: element(page, 'Save note') }), /user has control/);
    page = await post(daemon, '/browser/resume', { browserId: page.browser.id });
    assert.equal(new URL(page.browser.viewerUrl).searchParams.get('interactive'), 'false');
    const side = await post(daemon, '/chats', { name: 'separate browser owner' });
    await assert.rejects(post(daemon, '/browser/open', { url: fixture.url, chatId: side.id }), /capacity/);
    assert.equal((await (await fetch(`${steel}/sessions/${originalSession}`)).json()).status, 'live');
    const stale = page;
    await stop(daemon, 'SIGKILL');
    daemon = await launchBrowser({ directory: daemon.directory });
    await assert.rejects(act(daemon, stale, 'click', { ref: element(stale, 'Save note') }), /stale/);
    page = await post(daemon, '/browser/observe', { browserId: stale.browser.id });
    assert.equal(page.browser.sessionId, originalSession);
    assert.match(page.text, /Saved: first-save/);
    assert.equal(fixture.saves.filter(value => value === 'first-save').length, 1);
    // Force only our browser to expire, then restore from the private login checkpoint.
    await fetch(`${steel}/sessions/${originalSession}/release`, { method: 'POST' });
    page = opened(await post(daemon, '/browser/open', { url: fixture.url, profile: 'fixture-login' }));
    assert.notEqual(page.browser.sessionId, originalSession);
    assert.equal(page.browser.recoveryCount, 1);
    assert.match(page.text, new RegExp(storage.replaceAll('.', '\\.')));
    assert(fixture.visits.at(-1).cookie.includes(fixture.cookie));
    assert(!JSON.stringify(await get(daemon)).includes(fixture.cookie));
    await post(daemon, '/browser/close', { browserId: page.browser.id });
    await post(daemon, '/browser/forget-profile', { profile: 'fixture-login' });
    assert(!(await get(daemon, '/browser')).profiles.length);
    await stop(daemon);
    return { originalSession, screenshot: shot.path, restoredSession: page.browser.sessionId };
  });

  await scenario('SIGKILL after session creation adopts the reserved session instead of creating a duplicate', async () => {
    let daemon = await launchBrowser({ fault: 'browser-after-create' });
    const pending = post(daemon, '/browser/open', { url: fixture.url, requestId: 'reserved-open' }).catch(error => ({ error: error.message }));
    await faultReached(daemon, 'browser-after-create');
    const before = (await get(daemon, '/browser')).sessions[0]; sessions.add(before.sessionId);
    await stop(daemon, 'SIGKILL'); await pending;
    daemon = await launchBrowser({ directory: daemon.directory });
    const page = opened(await post(daemon, '/browser/open', { url: fixture.url, requestId: 'reserved-open' }));
    assert.equal(page.browser.sessionId, before.sessionId);
    assert.equal(page.browser.recoveryCount, 0);
    await post(daemon, '/browser/close', { browserId: page.browser.id }); await stop(daemon);
    return { sessionId: before.sessionId };
  });

  await scenario('SIGKILL after a real form submission requires observation and reconciliation without a second submission', async () => {
    let daemon = await launchBrowser({ fault: 'browser-after-click' });
    let page = opened(await post(daemon, '/browser/open', { url: fixture.url }));
    const marker = `crash-save-${randomUUID()}`;
    page = await act(daemon, page, 'fill', { ref: element(page, 'Note'), value: marker });
    const pending = act(daemon, page, 'click', { ref: element(page, 'Save note') }, 'crash-submit').catch(error => ({ error: error.message }));
    await faultReached(daemon, 'browser-after-click');
    assert.equal(fixture.saves.filter(value => value === marker).length, 1);
    await stop(daemon, 'SIGKILL'); await pending;
    daemon = await launchBrowser({ directory: daemon.directory });
    page = await post(daemon, '/browser/observe', { browserId: page.browser.id });
    assert.equal(page.browser.uncertainAction.kind, 'click');
    assert.match(page.text, new RegExp(marker));
    await assert.rejects(act(daemon, page, 'click', { ref: element(page, 'Save note') }), /unknown outcome/);
    await post(daemon, '/browser/reconcile', { browserId: page.browser.id, snapshotId: page.snapshotId, outcome: 'applied', evidence: `Page shows Saved: ${marker}` });
    assert.equal(fixture.saves.filter(value => value === marker).length, 1);
    await post(daemon, '/browser/close', { browserId: page.browser.id }); await stop(daemon);
    return { externalEffects: 1, sessionId: page.browser.sessionId };
  });

  await scenario('Idle leases release the browser and cancelling its owning job releases only that browser', async () => {
    let daemon = await launchBrowser({ extra: ['--browser-idle-ms', '2500'] });
    const idle = opened(await post(daemon, '/browser/open', { url: fixture.url }));
    await stop(daemon, 'SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 3000));
    daemon = await launchBrowser({ directory: daemon.directory, extra: ['--browser-idle-ms', '2500'] });
    await until(() => get(daemon, '/browser'), state => state.sessions.find(item => item.id === idle.browser.id)?.status === 'closed', 12000);
    await stop(daemon);
    daemon = await launchBrowser();
    const job = await post(daemon, '/jobs', { prompt: 'Long enough to cancel browser work', delayMs: 10000 });
    const page = opened(await post(daemon, '/browser/open', { url: fixture.url, jobId: job.id }));
    assert.equal(page.browser.owner.kind, 'job');
    await post(daemon, `/jobs/${job.id}/cancel`, {});
    await until(() => get(daemon, '/browser'), state => state.sessions.find(item => item.id === page.browser.id)?.status === 'closed', 12000);
    await stop(daemon);
    return { cancelledJob: job.id };
  });

  const auth = process.env.POINT_AUTH_FILE ?? fileURLToPath(new URL('../../../server/.pi/agent/auth.json', import.meta.url));
  if (await access(auth).then(() => true, () => false)) await scenario('Real DeepSeek follows a natural browser task through the Durable tool loop', async () => {
    const daemon = await launchBrowser({ model: 'deepseek/deepseek-flash', auth });
    const marker = `natural-${randomUUID()}`;
    const reply = await post(daemon, '/chat', { text: `请打开这个网页 ${fixture.url} ，把 Note 填成 ${marker}，点击 Save note，核对页面保存确认信息，最后关闭浏览器并告诉我结果。这是一项简短操作，直接在当前对话完成。` });
    const state = await get(daemon);
    for (const browser of state.browser.sessions) sessions.add(browser.sessionId);
    for (const job of state.jobs) { await jobDone(daemon, job.id, 90000); await until(() => get(daemon, `/jobs/${job.id}`), item => item.notification?.status === 'done', 90000); }
    assert.equal(fixture.saves.filter(value => value === marker).length, 1);
    await until(() => get(daemon, '/browser'), current => current.sessions.length > 0 && current.sessions.every(item => item.status === 'closed'), 15000);
    const histories = [await get(daemon, '/history'), ...await Promise.all(state.jobs.map(job => get(daemon, `/history?conversation=${job.conversationId}`)))];
    const calls = histories.flat(2).flatMap(entry => entry.model ?? []).flatMap(message => message.content ?? []).filter(part => part.type === 'toolCall').map(part => part.name);
    assert(calls.includes('browser_open') && calls.includes('browser_act'));
    await stop(daemon);
    return { model: state.model, thinkingLevel: state.thinkingLevel, tools: calls, externalEffects: 1, reply: reply.text };
  });
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup();
  // Never release sessions not created by this acceptance run.
  for (const id of sessions) {
    const session = await fetch(`${steel}/sessions/${id}`).then(response => response.json()).catch(() => null);
    if (session?.id === id && session.status === 'live') await fetch(`${steel}/sessions/${id}/release`, { method: 'POST' });
  }
  await fixture.close();
  const report = { steel, fixture: fixture.url, runDirectory: RUN_DIR, tests: evidence };
  await writeFile(join(ROOT, 'runtime/steel-results.json'), JSON.stringify(report, null, 2));
  await writeFile(join(RUN_DIR, 'steel-results.json'), JSON.stringify(report, null, 2));
  console.log(`Steel evidence: ${join(RUN_DIR, 'steel-results.json')}`);
}
