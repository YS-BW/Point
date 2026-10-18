import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { clearLine, cursorTo } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { api, argumentsFor, delay } from './util.mjs';

const { values, positionals } = argumentsFor({
  url: { type: 'string', default: process.env.POINT_DURABLE_URL ?? 'http://127.0.0.1:4788' },
  json: { type: 'boolean' }, title: { type: 'string' }, delay: { type: 'string' },
  followup: { type: 'string' }, 'request-id': { type: 'string' }, conversation: { type: 'string' },
  chat: { type: 'string', default: 'main' }, 'notify-main': { type: 'boolean' }, verbose: { type: 'boolean' },
});
const base = values.url.replace(/\/$/, '');
const request = (path, body) => api(base + path, body === undefined ? 'GET' : 'POST', body, 120000);
const requestId = () => values['request-id'] ?? randomUUID();
const statusNames = { queued: '排队中', running: '执行中', ready: '已生成', delivering: '交付中', done: '已完成', cancelled: '已取消', failed: '失败', unknown: '结果未知' };
let activeId = values.chat, activeName = activeId, reader, watcher, watching;
let latestState;
const seen = new Map(), toolsSeen = new Set();
const historyCursors = new Map();
const prompt = () => { if (stdout.isTTY && reader) { reader.setPrompt(`${activeName} › `); reader.prompt(true); } };

function say(text) {
  if (reader && stdout.isTTY) { clearLine(stdout, 0); cursorTo(stdout, 0); }
  console.log(text);
  prompt();
}

function print(value) { console.log(typeof value?.text === 'string' && !values.json ? value.text : JSON.stringify(value, null, values.json ? 0 : 2)); }

function showMessages(messages, name, historical = false) {
  for (const message of messages) {
    if (!historical && message.role !== 'assistant') continue;
    const who = message.role === 'user' ? '你' : `Point·${name}`;
    say(`${message.kind === 'point.followup' ? '[跟进] ' : ''}[${who}] ${message.text}`);
  }
}

async function resolveChat(query) {
  if (query === 'main' || query === '主会话') return { id: 'main', name: '主会话' };
  const chats = await request('/chats');
  const exact = chats.find(chat => chat.id === query);
  if (exact) return exact;
  const matches = chats.filter(chat => chat.name === query || chat.id.startsWith(query));
  if (matches.length !== 1) throw new Error(matches.length ? '会话名称有重复，请使用 ID。' : '没有找到这个会话，使用 /chats 查看。');
  return matches[0];
}

async function resolveJob(query) {
  const jobs = await request('/jobs');
  const exact = jobs.find(job => job.id === query);
  const matches = exact ? [exact] : jobs.filter(job => job.id.startsWith(query ?? ''));
  if (matches.length !== 1) throw new Error('请提供唯一的任务 ID，可用 /jobs 查看。');
  return matches[0].id;
}

async function watchChat(signal, ready) {
  let newestEvent = null, busy = false;
  while (!signal.aborted) {
    try {
      const response = await fetch(`${base}/events?chatId=${encodeURIComponent(activeId)}`, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        if (signal.aborted) break;
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const line = frame.split('\n').find(item => item.startsWith('data: '));
          if (!line) continue;
          const state = JSON.parse(line.slice(6));
          latestState = state;
          activeName = state.active.chat.name;
          const already = seen.get(activeId);
          if (!already) {
            showMessages(state.active.messages.slice(-6), activeName, true);
            seen.set(activeId, new Set(state.active.messages.map(message => message.id)));
          } else {
            showMessages(state.active.messages.filter(message => !already.has(message.id)), activeName);
            for (const message of state.active.messages) already.add(message.id);
          }
          if (newestEvent === null) newestEvent = state.events.at(-1)?.id ?? 0;
          for (const event of state.events.filter(item => item.id > newestEvent)) {
            const job = state.jobs.find(item => item.id === event.jobId);
            const name = state.chats.find(chat => chat.id === event.chatId)?.name ?? '主会话';
            if (event.type === 'done') say(`[完成] [${name}] ${job.title} (${job.id.slice(0, 8)}) → ${state.workspace}/${job.artifact}`);
            if (event.type === 'followup' && event.chatId !== activeId) say(`[跟进·${name}] ${event.text}`);
            if (event.type === 'reply' && event.chatId !== activeId) say(`[新消息·${name}] ${event.text.slice(0, 240)}\n使用 /use ${event.chatId} 继续。`);
            if (['failed', 'unknown', 'cancelled'].includes(event.type)) say(`[${statusNames[event.type]}] ${job?.title ?? ''} (${event.jobId?.slice(0, 8) ?? ''})`);
            if (event.type === 'notification_failed') say(`[交付消息失败] 报告已保存，可用 /job ${event.jobId} 查看。`);
            if (event.type === 'shared') say(`[已同步主会话] 使用 /main 查看。`);
            if (event.type === 'browser_ready') say(`[浏览器] 已打开，可观看：${event.viewerUrl}\n需要接管时使用 /browser take ${event.browserId}`);
            if (event.type === 'browser_closed') say('[浏览器] 已关闭。');
            newestEvent = event.id;
          }
          const live = state.active.live;
          if (live?.run && !busy) say(`[${activeName}] Point 正在处理，你可以继续输入。`);
          busy = Boolean(live?.run);
          if (values.verbose) for (const tool of live?.tools ?? []) {
            if (!toolsSeen.has(tool.callId)) { toolsSeen.add(tool.callId); say(`[工具·${activeName}] ${tool.name}`); }
          }
          reader?.setPrompt(`${activeName} › `);
          ready();
        }
      }
      if (!signal.aborted) say('连接已断开，正在重新连接…');
    } catch (error) {
      if (signal.aborted) break;
      say(`连接暂不可用：${error.message}；正在重连，历史与后台任务保存在服务端。`);
      ready();
    }
    try { await delay(1000, signal); } catch { break; }
  }
  ready();
}

async function selectChat(query) {
  const chat = await resolveChat(query);
  if (chat.status === 'archived') throw new Error('这个会话已归档，先用 /restore ID 恢复。');
  watcher?.abort();
  await watching;
  activeId = chat.id; activeName = chat.name;
  if (!reader) return chat;
  seen.delete(activeId);
  say(`\n── ${activeName} (${activeId}) ──`);
  watcher = new AbortController();
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  watching = watchChat(watcher.signal, ready);
  await started;
  reader.setPrompt(`${activeName} › `);
  prompt();
  return chat;
}

async function run(command, args, interactive = false) {
  const text = args.join(' ');
  if (['chat', 'steer'].includes(command)) {
    const result = await request('/chat', { text, chatId: activeId, requestId: requestId(), wait: !interactive, whenBusy: command === 'steer' ? 'steer' : 'followUp' });
    if (!interactive) print(result);
    else if (result.status === 'queued') say(command === 'steer' ? '补充要求已送入当前工作。' : '消息已排队，当前回复结束后处理。');
    return;
  }
  if (command === 'start') {
    const job = await request('/jobs', { prompt: text, chatId: activeId, requestId: requestId(),
      ...(values.title ? { title: values.title } : {}), ...(values.delay ? { delayMs: Number(values.delay) } : {}),
      ...(values.followup ? { followupAfterMs: Number(values.followup) } : {}), ...(values['notify-main'] ? { notifyMain: true } : {}) });
    if (values.json) print(job);
    else say(`已交给后台：${job.title}\n任务 ID：${job.id}\n你可以继续聊天；/job ${job.id.slice(0, 8)} 查看进度。`);
    return;
  }
  if (command === 'jobs') {
    const jobs = await request('/jobs');
    if (values.json) return print(jobs);
    return say(jobs.map(job => `${job.id.slice(0, 8)}  ${statusNames[job.status]}  [${latestState?.chats.find(chat => chat.id === job.chatId)?.name ?? job.chatId}] ${job.title}`).join('\n') || '还没有后台任务。');
  }
  if (command === 'job') {
    const job = await request(`/jobs/${await resolveJob(args[0])}`);
    if (values.json) return print(job);
    return say(`${job.title} · ${statusNames[job.status]}\n${job.id}\n${job.result ?? job.error ?? '正在执行。'}${job.artifact ? '\n报告：' + job.artifact : ''}`);
  }
  if (command === 'amend') return print(await request(`/jobs/${await resolveJob(args[0])}/revise`, { requirement: args.slice(1).join(' '), requestId: requestId() }));
  if (command === 'cancel') return print(await request(`/jobs/${await resolveJob(args[0])}/cancel`, {}));
  if (command === 'after') return print(await request(`/jobs/${await resolveJob(args[0])}/followup`, { afterMs: Number(args[1]), requestId: requestId() }));
  if (command === 'stop') { const result = await request('/chat/stop', { chatId: activeId }); return values.json ? print(result) : say('已停止当前会话的执行，后台任务继续。'); }
  if (command === 'state') return print(await request('/state'));
  if (command === 'browser' || command === 'browsers') {
    const [action, ...rest] = args;
    if (!action || action === 'status' || command === 'browsers') {
      const status = await request('/browser');
      if (values.json) return print(status);
      return say(status.enabled ? `Steel：${status.apiUrl}（容量 ${status.capacity}；画面 ${status.transport === 'webrtc' ? 'WebRTC' : 'WebSocket'}）\n` +
        (status.sessions.filter(item => ['starting', 'live', 'closing'].includes(item.status)).map(item => `${item.id}  [${item.owner.name}] ${item.humanControl ? '用户接管' : item.status}\n${item.url ?? ''}\n查看：${item.viewerUrl ?? ''}`).join('\n') || '当前没有打开的浏览器。') : '未配置 Steel。服务启动时增加 --steel-url。');
    }
    if (action === 'forget-profile') return print(await request('/browser/forget-profile', { profile: rest.join(' ') }));
    const aliases = { snapshot: 'observe', take: 'handoff' };
    const method = aliases[action] ?? action;
    if (!['open', 'observe', 'close', 'screenshot', 'handoff', 'resume'].includes(method)) throw new Error('/browser open URL [profile] · snapshot [ID] · screenshot [ID] · take [ID] · resume [ID] · close [ID] · forget-profile NAME');
    return print(await request(`/browser/${method}`, { chatId: activeId, requestId: requestId(),
      ...(method === 'open' ? { url: rest[0], ...(rest[1] ? { profile: rest.slice(1).join(' ') } : {}) } : rest[0] ? { browserId: rest[0] } : {}) }));
  }
  if (command === 'chats') {
    const chats = await request('/chats');
    return values.json ? print(chats) : say(chats.map(chat => `${chat.id === activeId ? '●' : ' '} ${chat.id === 'main' ? 'main' : chat.id.slice(0, 8)}  ${chat.name}${chat.status === 'archived' ? '（已归档）' : ''}`).join('\n'));
  }
  if (command === 'new' || command === 'fork') {
    const chat = await request('/chats', { name: text, sourceChatId: activeId, mode: command === 'fork' ? 'fork' : 'fresh', requestId: requestId() });
    if (values.json) return print(chat);
    if (interactive) await selectChat(chat.id);
    else say(`已创建会话：${chat.name}\n${chat.id}\n继续：npm run cli -- --chat ${chat.id}`);
    return;
  }
  if (command === 'use' || command === 'main') {
    const chat = await selectChat(command === 'main' ? 'main' : text);
    if (!interactive) print(chat);
    return;
  }
  if (command === 'rename') return print(await request(`/chats/${activeId}/update`, { name: text }));
  if (command === 'archive' || command === 'restore') {
    const chat = await resolveChat(text || activeId);
    const result = await request(`/chats/${chat.id}/update`, { status: command === 'archive' ? 'archived' : 'active' });
    if (values.json) return print(result);
    say(`${result.name}已${command === 'archive' ? '归档，已有后台任务继续，后续结果转入主会话' : '恢复'}。`);
    if (interactive && command === 'archive' && chat.id === activeId) await selectChat('main');
    return;
  }
  if (command === 'share') {
    const share = await request(`/chats/${activeId}/share`, { requestId: requestId() });
    return values.json ? print(share) : say('正在整理本主题的结论并同步主会话，你可以继续聊天。');
  }
  if (command === 'memory') {
    const memories = await request('/memory');
    return values.json ? print(memories) : say(memories.map(item => `${item.key} = ${item.value}（${item.kind}，来源：${item.sourceChatId}）`).join('\n') || '尚无保存的记忆。');
  }
  if (command === 'remember') {
    const equals = text.indexOf('=');
    if (equals < 1) throw new Error('用法：/remember 名称=内容');
    const item = await request('/memory', { key: text.slice(0, equals).trim(), value: text.slice(equals + 1).trim(), kind: 'fact', chatId: activeId, requestId: requestId() });
    return values.json ? print(item) : say(`已保存：${item.key} = ${item.value}`);
  }
  if (command === 'forget') {
    const result = await request('/memory/forget', { key: text, requestId: requestId() });
    return values.json ? print(result) : say(`已忘记保存的记忆：${text}。原会话历史仍可查阅。`);
  }
  if (command === 'compact') {
    const result = await request(`/chats/${activeId}/compact`, { ...(text ? { instructions: text } : {}) });
    return values.json ? print(result) : say('正在整理较早的上下文，原始记录会保留。');
  }
  if (command === 'history') {
    if (values.conversation) return print(await request(`/history?conversation=${encodeURIComponent(values.conversation)}`));
    const cursor = args[0] === 'older' ? historyCursors.get(activeId) : undefined;
    if (args[0] === 'older' && cursor === null) return say('已到最早的记录。');
    const result = await request(`/chats/${activeId}/messages?limit=100${cursor ? '&cursor=' + encodeURIComponent(JSON.stringify(cursor)) : ''}`);
    historyCursors.set(activeId, result.next);
    return values.json ? print(result) : showMessages(result.messages, result.chat.name, true);
  }
  if (command === 'events') {
    const response = await fetch(base + `/events?chatId=${encodeURIComponent(activeId)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    for await (const chunk of response.body) stdout.write(chunk);
    return;
  }
  say('直接输入文字聊天。\n会话：/chats · /new 名称 · /fork 名称 · /use 名称或ID · /main · /rename 名称 · /archive · /restore ID\n工作：/start 内容 · /jobs · /job ID · /amend ID 要求 · /cancel ID · /after ID 毫秒\n上下文：/share · /remember 名称=内容 · /memory · /forget 名称 · /compact · /history · /history older\n浏览器：/browser · /browser open URL [profile] · /browser snapshot · /browser take · /browser resume · /browser close\n控制：/steer 补充要求 · /stop · /quit（仅退出客户端）');
}

try {
  const initial = await resolveChat(activeId);
  activeId = initial.id; activeName = initial.name;
  if (positionals.length) await run(positionals[0], positionals.slice(1));
  else {
    const state = await request('/state');
    watcher = new AbortController();
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    watching = watchChat(watcher.signal, ready);
    await started;
    reader = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
    say(`Point Durable CLI → ${base}\n模型：${state.model.provider}/${state.model.modelId}${state.model.provider === 'faux' ? '（脚本测试模型，仅验证流程）' : ''}\n思考：${state.thinkingLevel ?? '未知'}\n浏览器：${state.browser?.enabled ? `Steel 已配置${state.browser.transport === 'webrtc' ? ' · WebRTC 画面' : ''}；/browser 查看` : '未配置'}\n直接输入文字聊天；/help 查看命令。`);
    reader.setPrompt(`${activeName} › `);
    prompt();
    for await (const line of reader) {
      const input = line.trim();
      if (!input) continue;
      if (input === '/quit') break;
      try {
        const [command, ...args] = input.startsWith('/') ? input.slice(1).split(/\s+/) : ['chat', input];
        await run(['background', 'preferences', 'file', 'slow', 'recall'].includes(command) ? 'chat' : command,
          ['background', 'preferences', 'file', 'slow', 'recall'].includes(command) ? [input] : args, true);
      } catch (error) { say(error.message); }
      prompt();
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { watcher?.abort(); await watching; reader?.close(); }
