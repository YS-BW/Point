const $ = id => document.getElementById(id);
const video = $('video');
const state = window.pointRTC = { pc: null, channel: null, peerId: null, browserId: new URL(location.href).searchParams.get('browserId'), humanControl: false, stats: null, sequence: 0 };
let binding, connecting = false, polling = false, stopped = false, statsTimer, priorStats, retryAt = 0;
const error = message => { $('error').textContent = message ?? ''; };
function inputReady() { $('text').disabled = $('send').disabled = !(state.humanControl && state.channel?.readyState === 'open'); }
async function api(path, body) {
  const response = await fetch(path, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '浏览器连接失败');
  return result;
}
function send(payload) {
  if (!state.humanControl) { error('请先点击“接管”再操作网页。'); return false; }
  if (state.channel?.readyState !== 'open') { error('输入通道尚未连接，请点击“重新连接”。'); return false; }
  if (state.channel.bufferedAmount > 65536) { error('输入队列繁忙，请等画面更新后继续。'); return false; }
  state.channel.send(JSON.stringify({ ...payload, sequence: ++state.sequence }));
  $('input-state').textContent = '正在发送输入…';
  return true;
}
function control(record) {
  state.humanControl = Boolean(record?.humanControl);
  $('take').disabled = !record || state.humanControl;
  $('resume').disabled = !state.humanControl;
  inputReady();
  video.classList.toggle('control', state.humanControl);
}
async function disconnect() {
  clearInterval(statsTimer);
  state.pc?.close(); state.pc = null; state.channel = null;
  state.stats = null; $('metrics').textContent = 'WebRTC'; inputReady();
  $('input-state').textContent = '输入通道未连接';
  const peerId = state.peerId; state.peerId = null;
  if (peerId) await api('/browser/rtc/close', { peerId }).catch(() => {});
  video.srcObject = null; video.style.display = 'none'; $('empty').style.display = 'block';
  binding = null; priorStats = null;
}
async function metrics() {
  if (!state.pc || state.pc.connectionState !== 'connected') return;
  const report = await state.pc.getStats();
  for (const item of report.values()) if (item.type === 'inbound-rtp' && item.kind === 'video') {
    const codec = report.get(item.codecId)?.mimeType ?? '';
    const kbps = priorStats ? Math.round((item.bytesReceived - priorStats.bytesReceived) * 8 / (item.timestamp - priorStats.timestamp)) : 0;
    state.stats = { framesDecoded: item.framesDecoded, bytesReceived: item.bytesReceived, width: item.frameWidth, height: item.frameHeight, codec, kbps };
    $('metrics').textContent = `WebRTC · ${codec.replace('video/', '')} · ${item.frameWidth ?? 0} × ${item.frameHeight ?? 0} · ${kbps} kbps`;
    priorStats = item;
  }
}
async function connect(record) {
  connecting = true; $('status').textContent = '正在连接画面…';
  $('empty').textContent = '浏览器已打开，正在连接实时画面…';
  try {
    await disconnect();
    const pc = state.pc = new RTCPeerConnection({ iceServers: [] });
    pc.addTransceiver('video', { direction: 'recvonly' });
    const channel = state.channel = pc.createDataChannel('point-input', { ordered: true });
    channel.onopen = () => { $('input-state').textContent = '输入通道已连接'; inputReady(); };
    channel.onclose = () => { $('input-state').textContent = '输入通道已断开'; inputReady(); };
    channel.onmessage = event => {
      const message = JSON.parse(event.data);
      state.lastAck = message;
      $('input-state').textContent = message.ok ? '输入已送达' : '输入未执行';
      if (message.error) error(message.error);
    };
    pc.ontrack = event => {
      video.srcObject = new MediaStream([event.track]);
      video.style.display = 'block'; $('empty').style.display = 'none';
      void video.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (state.pc !== pc) return;
      if (pc.connectionState === 'connected') error();
      $('status').textContent = pc.connectionState === 'connected' ? (state.humanControl ? '你正在接管' : 'Agent 操作中 · 可观看') : `连接状态：${pc.connectionState}`;
      if (['failed', 'closed'].includes(pc.connectionState)) binding = null;
    };
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('本地 WebRTC 网络协商超时')), 8000);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } });
    });
    const answer = await api('/browser/rtc/offer', { browserId: record.id, sdp: pc.localDescription.sdp });
    state.peerId = answer.peerId;
    await pc.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
    binding = `${record.id}:${record.sessionId}:${new URL(record.viewerUrl).searchParams.get('pageId') ?? ''}`;
    statsTimer = setInterval(() => void metrics().catch(() => {}), 1000);
  } catch (cause) { await disconnect(); retryAt = Date.now() + 5000; error(cause.message); $('status').textContent = '画面连接失败'; $('empty').textContent = '画面暂未连接，稍后自动重试，也可以点击“重新连接”。'; }
  finally { connecting = false; }
}
async function poll() {
  if (polling || stopped) return;
  polling = true;
  try {
    const status = await api('/browser');
    const active = status.sessions.filter(record => record.status === 'live');
    let record = active.find(item => item.id === state.browserId);
    if (!record && !new URL(location.href).searchParams.has('browserId')) record = active.at(-1);
    control(record);
    if (!record) {
      if (state.pc) await disconnect();
      $('status').textContent = '等待浏览器任务'; $('page').textContent = '等待 Agent 打开网页'; $('empty').textContent = '在 CLI 中让 Agent 打开网页，画面会自动出现在这里。';
      error();
      return;
    }
    state.browserId = record.id;
    $('page').textContent = `${record.owner.name} · ${record.url ?? '正在打开页面'}`;
    if (state.pc?.connectionState === 'connected') $('status').textContent = state.humanControl ? '你正在接管' : 'Agent 操作中 · 可观看';
    const current = `${record.id}:${record.sessionId}:${new URL(record.viewerUrl).searchParams.get('pageId') ?? ''}`;
    if (!connecting && binding !== current && Date.now() >= retryAt) await connect(record);
  } catch (cause) { error(cause.message); }
  finally { polling = false; }
}
$('take').onclick = async () => {
  try { control((await api('/browser/handoff', { browserId: state.browserId })).browser); error(); video.focus({ preventScroll: true }); await poll(); }
  catch (cause) { error(cause.message); }
};
$('resume').onclick = async () => {
  try { control((await api('/browser/resume', { browserId: state.browserId })).browser); error('控制权已交回，请到 CLI 发消息让 Agent 继续。'); await poll(); }
  catch (cause) { error(cause.message); }
};
$('reconnect').onclick = async () => { if (!connecting) { retryAt = 0; error(); await disconnect(); await poll(); } };
$('send').onclick = () => { if (send({ type: 'text', text: $('text').value })) { $('text').value = ''; video.focus({ preventScroll: true }); } };
$('text').addEventListener('keydown', event => { if (event.key === 'Enter') $('send').click(); });
const modifiers = event => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
const point = event => { const rect = video.getBoundingClientRect(); return { x: Math.max(0, Math.min(video.videoWidth, (event.clientX - rect.left) * video.videoWidth / rect.width)), y: Math.max(0, Math.min(video.videoHeight, (event.clientY - rect.top) * video.videoHeight / rect.height)) }; };
let lastMove = 0;
for (const [name, type] of [['pointerdown', 'mousePressed'], ['pointerup', 'mouseReleased'], ['pointermove', 'mouseMoved']]) video.addEventListener(name, event => {
  if (!state.humanControl || !video.videoWidth) return;
  if (name === 'pointermove') { const now = performance.now(); if (now - lastMove < 60) return; lastMove = now; }
  event.preventDefault(); video.focus({ preventScroll: true });
  if (name === 'pointerdown') video.setPointerCapture(event.pointerId);
  send({ type: 'mouse', event: type, ...point(event), button: ['left', 'middle', 'right'][event.button] ?? 'none', buttons: event.buttons, modifiers: modifiers(event) });
});
video.addEventListener('wheel', event => { if (!state.humanControl) return; event.preventDefault(); send({ type: 'mouse', event: 'mouseWheel', ...point(event), deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiers(event) }); }, { passive: false });
video.addEventListener('contextmenu', event => event.preventDefault());
for (const name of ['keydown', 'keyup']) video.addEventListener(name, event => {
  if (!state.humanControl) return;
  event.preventDefault(); send({ type: 'key', event: name === 'keydown' ? 'keyDown' : 'keyUp', key: event.key, code: event.code, keyCode: event.keyCode, modifiers: modifiers(event), repeat: event.repeat });
});
video.addEventListener('paste', event => { if (state.humanControl) { event.preventDefault(); send({ type: 'text', text: event.clipboardData.getData('text').slice(0, 8000) }); } });
window.addEventListener('pagehide', () => { stopped = true; state.pc?.close(); if (state.peerId) navigator.sendBeacon('/browser/rtc/close', new Blob([JSON.stringify({ peerId: state.peerId })], { type: 'application/json' })); });
void poll(); setInterval(() => void poll(), 1500);
