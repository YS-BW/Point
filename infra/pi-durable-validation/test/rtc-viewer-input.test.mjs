import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('Focusing the remote video preserves click coordinates and the outer page scroll', async () => {
  const events = new Map(), sent = [];
  const rect = { left: 100, top: 123, width: 1280, height: 800 };
  let outerScroll = 0;
  const nodes = new Map();
  for (const id of ['video', 'text', 'send', 'error', 'input-state', 'take', 'resume', 'metrics', 'empty', 'status', 'page', 'reconnect']) {
    nodes.set(id, { value: '', style: {}, classList: { toggle() {} },
      addEventListener(name, callback) { events.set(`${id}:${name}`, callback); },
      focus(options) {
        // Native focus scrolls an oversized video into view. This happened
        // between pointerdown's screen position and its coordinate mapping.
        if (!options?.preventScroll) { outerScroll = 123; rect.top = 0; }
      },
    });
  }
  Object.assign(nodes.get('video'), { videoWidth: 1280, videoHeight: 800,
    getBoundingClientRect: () => rect, setPointerCapture() {} });
  const window = { addEventListener() {} };
  runInNewContext(await readFile(new URL('../src/rtc-viewer.mjs', import.meta.url), 'utf8'), {
    document: { getElementById: id => nodes.get(id) }, window,
    location: { href: 'http://127.0.0.1:4788/browser/view' }, URL, AbortSignal,
    performance, MediaStream: class {},
    setInterval: () => 0, clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({ sessions: [] }) }),
  });
  await new Promise(resolve => setImmediate(resolve));
  Object.assign(window.pointRTC, { humanControl: true, channel: {
    readyState: 'open', bufferedAmount: 0, send: value => sent.push(JSON.parse(value)),
  } });
  const pointer = { clientX: 1062, clientY: 321, button: 0, buttons: 1, pointerId: 1, preventDefault() {} };
  events.get('video:pointerdown')(pointer);
  events.get('video:pointerup')({ ...pointer, buttons: 0 });
  assert.equal(outerScroll, 0);
  assert.deepEqual(sent.map(({ event, x, y }) => ({ event, x, y })), [
    { event: 'mousePressed', x: 962, y: 198 },
    { event: 'mouseReleased', x: 962, y: 198 },
  ]);
  nodes.get('text').value = '中文输入';
  nodes.get('send').onclick();
  assert.equal(sent.at(-1).text, '中文输入');
  assert.equal(nodes.get('text').value, '');
  assert.equal(outerScroll, 0);
});
