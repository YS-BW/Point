import puppeteer from 'puppeteer-core';
import { boundedString, fail } from './util.mjs';

export function webUrl(value) {
  const url = new URL(boundedString(value, 'url', 4000));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('Browser URLs must use http or https without embedded credentials');
  return url.toString();
}

/** Steel owns Chromium; this adapter only attaches CDP clients, never closes Chromium on disconnect. */
export class SteelBackend {
  constructor({ apiUrl, apiKey, viewerUrl }) {
    const configured = new URL(webUrl(apiUrl));
    if (configured.search || configured.hash) fail('Steel API URL must not contain query parameters or credentials; use STEEL_API_KEY separately');
    this.apiUrl = webUrl(apiUrl).replace(/\/$/, '').replace(/\/v1$/, '') + '/v1';
    this.apiKey = apiKey;
    this.viewerUrl = viewerUrl?.replace(/\/$/, '');
    this.connections = new Map();
  }

  async request(path, method = 'GET', body, signal) {
    const response = await fetch(this.apiUrl + path, {
      method, headers: { 'content-type': 'application/json', ...(this.apiKey ? { 'steel-api-key': this.apiKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([AbortSignal.timeout(method === 'POST' ? 60000 : 15000), ...(signal ? [signal] : [])]),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Steel ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  }

  async sessions(signal) { return (await this.request('/sessions', 'GET', undefined, signal))?.sessions ?? []; }
  async session(id, signal) { return this.request(`/sessions/${id}`, 'GET', undefined, signal); }
  async create(id, context, signal) {
    const session = await this.request('/sessions', 'POST', {
      sessionId: id, dimensions: { width: 1280, height: 800 },
      timeout: 1800000, ...(context ? { sessionContext: context } : {}),
    }, signal);
    if (session?.id !== id) throw new Error('Steel did not honor the reserved session ID; creation requires inspection');
    return session;
  }

  async live(id, signal) {
    const session = await this.session(id, signal);
    if (session?.id !== id || session.status !== 'live') throw new Error('Steel session expired or was replaced; open the browser again to restore its last checkpoint');
    return session;
  }

  async context(record, signal) {
    // The local API context endpoint can return cached state from older sessions.
    // Read only our isolated CDP browser context, never Steel's shared default profile.
    await this.live(record.sessionId, signal);
    const { context, page } = await this.page(record, signal);
    const localStorage = {};
    const client = await page.createCDPSession();
    try {
      for (const origin of record.origins ?? []) {
        try { localStorage[origin] = Object.fromEntries((await client.send('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: origin, isLocalStorage: true } })).entries); }
        catch { /* An origin may no longer have a storage area. */ }
      }
    } finally { await client.detach(); }
    const current = await page.evaluate(() => ({ origin: location.origin, values: Object.fromEntries(Object.entries(window.localStorage)) }));
    if (current.origin !== 'null') localStorage[current.origin] = current.values;
    const cookies = await context.cookies();
    await this.live(record.sessionId, signal);
    return { cookies, localStorage };
  }

  async release(id, signal) {
    const session = await this.session(id, signal);
    if (session?.status === 'live' && session.id === id) await this.request(`/sessions/${id}/release`, 'POST', undefined, signal);
    await this.disconnect(id);
  }

  viewer(session, pageId) {
    if (session.debugUrl && pageId) {
      const url = new URL(session.debugUrl);
      url.searchParams.set('pageId', pageId); url.searchParams.set('interactive', 'false'); url.searchParams.set('showControls', 'false');
      return url.toString();
    }
    return this.viewerUrl ? `${this.viewerUrl}/sessions/${session.id}` : session.sessionViewerUrl ?? session.debugUrl ?? null;
  }

  async pageId(page) {
    const client = await page.createCDPSession();
    try { return (await client.send('Target.getTargetInfo')).targetInfo.targetId; }
    finally { await client.detach(); }
  }

  async page(record, signal, savedContext, allowCreate = false) {
    const session = await this.live(record.sessionId, signal);
    let connection = this.connections.get(record.sessionId);
    if (!connection?.browser.connected) {
      await this.disconnect(record.sessionId);
      const endpoint = session.websocketUrl ?? `wss://connect.steel.dev?apiKey=${encodeURIComponent(this.apiKey ?? '')}&sessionId=${record.sessionId}`;
      const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null, protocolTimeout: 10000 })
        .catch(() => { throw new Error('Could not attach to the Steel browser over CDP'); });
      let context = browser.browserContexts().find(item => item.id === record.contextId && item.id !== undefined);
      let created = false;
      if (!context) {
        if (!allowCreate) { await browser.disconnect(); throw new Error('Task browser context is unavailable; call browser_open to restore its checkpoint'); }
        context = await browser.createBrowserContext(); created = true;
        if (savedContext?.cookies?.length) await context.setCookie(...savedContext.cookies);
      }
      const pages = await context.pages();
      let page;
      for (const candidate of pages) if (await this.pageId(candidate) === record.pageId) page = candidate;
      if (!page) {
        if (record.pageId && !allowCreate) { await browser.disconnect(); throw new Error('Task browser tab was closed; call browser_open to continue'); }
        page = pages[0] ?? await context.newPage();
      }
      if (created && savedContext?.localStorage) await page.evaluateOnNewDocument(storage => {
        for (const [key, value] of Object.entries(storage[location.origin] ?? {})) if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      }, savedContext.localStorage);
      connection = { browser, context, page, created };
      this.connections.set(record.sessionId, connection);
    }
    if (connection.page.isClosed()) {
      if (!allowCreate) throw new Error('Task browser tab was closed; call browser_open to continue');
      connection.page = await connection.context.newPage();
    }
    return connection;
  }

  async prepare(record, savedContext, signal) {
    const connection = await this.page(record, signal, savedContext, true);
    const created = connection.created; connection.created = false;
    return { contextId: connection.context.id, pageId: await this.pageId(connection.page), created };
  }

  async url(record, signal) { return (await this.page(record, signal)).page.url(); }
  cachedUrl(record) {
    const page = this.connections.get(record.sessionId)?.page;
    return page && !page.isClosed() ? page.url() : record.lastUrl;
  }

  async navigate(record, url, signal) {
    const { page } = await this.page(record, signal);
    await page.goto(webUrl(url), { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  async observe(record, snapshotId, signal) {
    const { page } = await this.page(record, signal);
    const result = await page.evaluate(token => {
      const roots = [];
      function visit(root) {
        roots.push(root);
        for (const element of root.querySelectorAll('*')) if (element.shadowRoot) visit(element.shadowRoot);
      }
      visit(document);
      for (const root of roots) for (const element of root.querySelectorAll('[data-point-ref]')) element.removeAttribute('data-point-ref');
      const elements = [];
      for (const root of roots) for (const element of root.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')) {
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height || element.type === 'hidden' || elements.length >= 100) continue;
        const ref = `e${elements.length + 1}`;
        element.setAttribute('data-point-ref', `${token}:${ref}`);
        elements.push({ ref, tag: element.tagName.toLowerCase(), role: element.getAttribute('role'),
          name: (element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.innerText || element.getAttribute('placeholder') || element.getAttribute('name') || '').trim().slice(0, 180),
          type: element.type ?? null, disabled: Boolean(element.disabled),
          value: element.type === 'password' ? '[redacted]' : String(element.value ?? '').slice(0, 200),
          href: element.tagName === 'A' ? element.href : undefined,
        });
      }
      return { url: location.href, title: document.title, text: document.body?.innerText.slice(0, 12000) ?? '', elements };
    }, snapshotId);
    return { ...result, pageId: await this.pageId(page), snapshotId };
  }

  async act(record, args, signal) {
    const { context, page } = await this.page(record, signal);
    await page.bringToFront();
    const pagesBefore = await context.pages();
    let element;
    if (args.ref) {
      const handle = await page.evaluateHandle(({ token, ref }) => {
        function find(root) {
          for (const candidate of root.querySelectorAll('[data-point-ref]')) if (candidate.getAttribute('data-point-ref') === `${token}:${ref}`) return candidate;
          for (const candidate of root.querySelectorAll('*')) if (candidate.shadowRoot) { const found = find(candidate.shadowRoot); if (found) return found; }
          return null;
        }
        return find(document);
      }, { token: args.snapshotId, ref: args.ref });
      element = handle.asElement();
      if (!element) { await handle.dispose(); throw new Error('Element is no longer present; observe the page again'); }
    }
    try {
      if (args.action === 'click') await element.click();
      else if (args.action === 'fill') { await element.focus(); await element.evaluate(node => { node.value = ''; node.dispatchEvent(new Event('input', { bubbles: true })); }); await element.type(args.value); }
      else if (args.action === 'select') await element.select(args.value);
      else if (args.action === 'press') await (element ?? page.keyboard).press(args.key);
      else if (args.action === 'scroll') await page.evaluate(direction => window.scrollBy(0, direction === 'up' ? -600 : 600), args.direction);
      if (args.action === 'click' || args.action === 'press') await page.waitForNetworkIdle({ idleTime: 200, timeout: 1200 }).catch(() => {});
      const pagesAfter = await context.pages();
      const popup = pagesAfter.find(candidate => !pagesBefore.includes(candidate));
      if (popup) this.connections.get(record.sessionId).page = popup;
    } finally { await element?.dispose(); }
  }

  async screenshot(record, signal) {
    const { page } = await this.page(record, signal);
    // A background tab can have no compositor surface. Activate the owned page
    // and bound this read; Puppeteer's default CDP timeout is several minutes.
    const client = await page.createCDPSession();
    const abort = () => { void client.detach().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      await client.send('Page.bringToFront', {}, { timeout: 3000 });
      const { data } = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, { timeout: 5000 });
      return Buffer.from(data, 'base64');
    } finally { signal?.removeEventListener('abort', abort); await client.detach().catch(() => {}); }
  }
  async humanInput(record, input) {
    const connection = await this.page(record);
    const { page } = connection;
    // Keep one Input agent for the entire key/text sequence.
    if (connection.inputPage !== page) {
      await connection.inputClient?.detach().catch(() => {});
      connection.inputClient = await page.createCDPSession(); connection.inputPage = page;
    }
    const client = connection.inputClient;
    if (input.type !== 'mouse' || input.event !== 'mouseMoved') await client.send('Page.bringToFront');
    if (input.type === 'text') {
      if (typeof input.text !== 'string' || input.text.length > 8000) fail('Invalid input text');
      await client.send('Input.insertText', { text: input.text });
    } else if (input.type === 'mouse') {
      if (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(input.event)) fail('Invalid pointer event');
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      if (![input.x, input.y].every(Number.isFinite) || input.x < 0 || input.y < 0 || input.x > viewport.width || input.y > viewport.height) fail('Pointer is outside the page');
      const wheel = input.event === 'mouseWheel';
      if (wheel && ![input.deltaX, input.deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 10000)) fail('Invalid scroll');
      await client.send('Input.dispatchMouseEvent', {
        type: input.event, x: input.x, y: input.y,
        button: ['left', 'middle', 'right'].includes(input.button) ? input.button : 'none',
        buttons: Number.isInteger(input.buttons) ? input.buttons & 7 : 0,
        clickCount: 1, modifiers: Number.isInteger(input.modifiers) ? input.modifiers & 15 : 0,
        ...(wheel ? { deltaX: input.deltaX, deltaY: input.deltaY } : {}),
      });
    } else if (input.type === 'key') {
      if (!['keyDown', 'keyUp'].includes(input.event)) fail('Invalid key event');
      if (typeof input.key !== 'string' || !input.key.length || input.key.length > 80) fail('Invalid key');
      const key = input.key, code = boundedString(input.code, 'code', 80);
      const modifiers = Number.isInteger(input.modifiers) ? input.modifiers & 15 : 0;
      const text = input.event === 'keyDown' && key.length === 1 && !(modifiers & 7) ? key : undefined;
      await client.send('Input.dispatchKeyEvent', { type: input.event, key, code, text,
        windowsVirtualKeyCode: Number.isInteger(input.keyCode) ? input.keyCode & 255 : 0, modifiers, autoRepeat: Boolean(input.repeat) });
    } else fail('Unsupported input event');
  }
  async disconnect(id) {
    const connection = this.connections.get(id);
    this.connections.delete(id);
    await connection?.browser.disconnect();
  }
  async disconnectAll() { await Promise.all([...this.connections.keys()].map(id => this.disconnect(id))); }
}
