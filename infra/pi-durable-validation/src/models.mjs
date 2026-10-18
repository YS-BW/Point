import { readFile } from 'node:fs/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { textOf } from './util.mjs';

const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

/** Scripted provider: all scheduling, tools, storage and child conversations still run for real. */
export function routeFaux(request) {
  const messages = request.messages;
  if (messages[0]?.role === 'system' && textOf(messages[0].content).includes('summarization')) {
    return fauxAssistantMessage('## 已确认的早期上下文\n' + messages.filter(message => message.role === 'user' || message.role === 'assistant').slice(0, 14).map(message => textOf(message.content).slice(0, 400)).join('\n'));
  }
  const userIndex = messages.findLastIndex(message => message.role === 'user');
  const prompt = textOf(messages[userIndex]?.content);
  const last = messages.findLast(message => message.role !== 'system');
  if (prompt.startsWith('[POINT_REPORT]')) {
    const report = JSON.parse(prompt.slice('[POINT_REPORT]'.length));
    return fauxAssistantMessage(`已完成“${report.title}”。报告：${report.artifact}\n${report.result}`);
  }
  if (prompt.startsWith('[POINT_SHARED]')) {
    const shared = JSON.parse(prompt.slice('[POINT_SHARED]'.length));
    return fauxAssistantMessage(`已收到“${shared.chat}”的结论：\n${shared.summary}`);
  }
  if (prompt.startsWith('[POINT_SHARE]')) return fauxAssistantMessage('主题结论：\n' + messages.slice(0, userIndex).filter(message => ['user', 'assistant'].includes(message.role)).map(message => textOf(message.content)).join('\n').slice(-5000));
  if (prompt.startsWith('[POINT_JOB]')) {
    const job = JSON.parse(prompt.slice('[POINT_JOB]'.length));
    const completed = messages.slice(userIndex + 1).filter(message => message.role === 'toolResult');
    if (completed.length < 2) return call('work_step', {
      jobId: job.id, revision: job.revision, step: completed.length + 1, delayMs: job.delayMs,
    });
    return fauxAssistantMessage(`# ${job.title}\n\n任务：${job.prompt}\n\n补充要求：${job.requirements.join('；') || '无'}\n\n偏好：${JSON.stringify(job.preferences)}\n\n已完成两个真实工具步骤。`);
  }
  if (last?.role === 'toolResult') return fauxAssistantMessage(textOf(last.content));
  if (prompt.startsWith('/background ')) return call('start_job', { prompt: prompt.slice(12), title: '后台任务', delayMs: 300 });
  if (prompt.startsWith('/remember ')) {
    const [key, ...values] = prompt.slice(10).split('=');
    return call('set_preference', { key: key.trim(), value: values.join('=').trim() });
  }
  if (prompt.startsWith('/side ')) return call('create_chat', { name: prompt.slice(6), mode: 'fresh' });
  if (prompt.startsWith('/fork ')) return call('create_chat', { name: prompt.slice(6), mode: 'fork' });
  if (prompt === '/share') return call('share_to_main', {});
  if (prompt.startsWith('/recall ')) {
    const key = prompt.slice(8);
    // pi-ai carries positional system-section patches separately from `content`.
    let memory = '';
    for (const message of messages) if (message.role === 'system' && Object.hasOwn(message.sections ?? {}, 'point_memory')) memory = message.sections.point_memory ?? '';
    const records = memory.split('\n').filter(line => line.startsWith('{')).map(line => { try { return JSON.parse(line); } catch { return null; } });
    return fauxAssistantMessage(records.find(item => item?.key === key)?.value ?? '没有保存这项记忆');
  }
  if (prompt === '/preferences') return call('get_preferences', {});
  if (prompt.startsWith('/file ')) return call('write', { path: 'from-agent.txt', content: prompt.slice(6) });
  if (prompt.startsWith('[POINT_RESULT]')) return fauxAssistantMessage(`后台结果已就绪：${prompt.slice(14)}`);
  if (prompt.startsWith('[POINT_FOLLOWUP]')) return fauxAssistantMessage(`跟进提醒：${prompt.slice(16)}`);
  if (prompt === '/slow') return call('pause', { ms: 2000 });
  return fauxAssistantMessage(`Point：${prompt}`);
}

export async function makeModels({ model = 'faux/faux-1', authFile } = {}) {
  const separator = model.indexOf('/');
  if (separator < 1) throw new Error('Model must be provider/modelId');
  const reference = { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
  let credentialsData = {};
  if (authFile) credentialsData = JSON.parse(await readFile(authFile, 'utf8'));
  const credentials = {
    read: async id => credentialsData[id],
    list: async () => Object.entries(credentialsData).map(([providerId, value]) => ({ providerId, type: value.type })),
    modify: async () => { throw new Error('Prototype credential store is read-only; use API keys'); },
    delete: async () => { throw new Error('Prototype credential store is read-only'); },
  };
  const models = createModels({ credentials });
  if (reference.provider === 'faux') {
    const faux = fauxProvider({ api: 'point-faux', tokensPerSecond: 15000 });
    // A reusable factory per request, not an in-memory scenario cursor that resets incorrectly on restart.
    faux.setResponses(Array.from({ length: 10000 }, () => routeFaux));
    models.setProvider(faux.provider);
  } else if (reference.provider === 'deepseek') models.setProvider(deepseekProvider());
  else if (reference.provider === 'openai') models.setProvider(openaiProvider());
  else throw new Error(`Unsupported prototype provider: ${reference.provider}`);
  if (!models.getModel(reference.provider, reference.modelId)) throw new Error(`Unknown model: ${model}`);
  return { models, reference };
}
