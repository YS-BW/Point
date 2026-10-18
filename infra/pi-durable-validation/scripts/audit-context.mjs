import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getCurrentSystemMessage, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript';
import { buildSystemPromptState } from '../../../server/node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js';
import { createCodingToolDefinitions } from '../../../server/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.js';
import { makeModels } from '../src/models.mjs';

// Read-only inspection of the live service. --real asks the same model for its next
// decision, but never executes returned tools and never submits to the live chat.
const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:4788' },
  real: { type: 'boolean', default: false },
  repeat: { type: 'string', default: '2' },
  only: { type: 'string' },
  reasoning: { type: 'string' },
} });
assert(['127.0.0.1', 'localhost'].includes(new URL(values.url).hostname));
const repeat = Number(values.repeat);
assert(Number.isInteger(repeat) && repeat > 0 && repeat <= 5);
const directory = fileURLToPath(new URL('../runtime/', import.meta.url));
const output = join(directory, `context-audit-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(output, { recursive: true });
const get = async path => {
  const response = await fetch(`${values.url}${path}`);
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
};
const [view, state] = await Promise.all([get('/chats/main/context'), get('/state')]);
const requestedReasoning = values.reasoning ?? state.thinkingLevel ?? 'off';
assert(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(requestedReasoning));
const reasoning = requestedReasoning === 'off' ? {} : { reasoning: requestedReasoning };
const modelName = `${state.model.provider}/${state.model.modelId}`;
const { models, reference } = await makeModels({ model: modelName,
  ...(values.real ? { authFile: process.env.POINT_AUTH_FILE ?? fileURLToPath(new URL('../../../server/.pi/agent/auth.json', import.meta.url)) } : {}),
});
const model = models.getModel(reference.provider, reference.modelId);
const current = getCurrentSystemMessage(view.messages);
const tools = getCurrentTools(view.messages);
const codingNames = ['read', 'bash', 'edit', 'write'];
const codingTools = tools.filter(tool => codingNames.includes(tool.name));
assert.equal(codingTools.length, 4);
const definitions = createCodingToolDefinitions(state.workspace);
const nativeSystem = selected => ({ role: 'system', timestamp: 0,
  ...buildSystemPromptState({ cwd: state.workspace, selectedTools: selected.map(tool => tool.name),
    toolSnippets: Object.fromEntries(definitions.map(tool => [tool.name, tool.promptSnippet])),
    toolGuidelines: Object.fromEntries(definitions.map(tool => [tool.name, tool.promptGuidelines ?? []])),
  }), toolsAdded: selected,
});
const pointSystem = selected => ({ ...structuredClone(current), toolsAdded: selected });
const openIndex = view.messages.findIndex(message => message.role === 'user' && message.content === '打开微信');
assert(openIndex >= 0, 'This diagnostic expects the recorded 打开微信 request');
const initial = view.messages.slice(0, openIndex + 1);
const probeIndex = view.messages.findIndex((message, index) => index > openIndex && message.role === 'toolResult' && message.toolName === 'bash');
assert(probeIndex > openIndex);
const afterProbe = view.messages.slice(0, probeIndex + 1);
const user = { role: 'user', content: '打开微信', timestamp: 0 };
const environment = `执行环境：当前 macOS 本机（platform=${process.platform}，arch=${process.arch}）。bash 工具在本机执行命令；当前工作目录为 ${state.workspace}。`;
const envSystem = pointSystem(tools);
envSystem.sections = { ...envSystem.sections, environment };
const conditions = [
  { name: 'recorded-initial', messages: initial },
  { name: 'point-clean-19', messages: [pointSystem(tools), user] },
  { name: 'point-clean-4', messages: [pointSystem(codingTools), user] },
  { name: 'pi-clean-19', messages: [nativeSystem(tools), user] },
  { name: 'pi-clean-4', messages: [nativeSystem(codingTools), user] },
  { name: 'point-environment-19', messages: [envSystem, user] },
  { name: 'recorded-after-probe', messages: afterProbe },
  { name: 'pi-after-probe-19', messages: [nativeSystem(tools), ...afterProbe.filter(message => message.role !== 'system')] },
];
const selectedNames = values.only?.split(',');
if (selectedNames) for (const name of selectedNames) assert(conditions.some(variant => variant.name === name), `Unknown condition: ${name}`);
const variants = selectedNames ? conditions.filter(variant => selectedNames.includes(variant.name)) : conditions;

function checkWire(payload, messages) {
  const names = payload.tools.map(tool => tool.function.name);
  assert.deepEqual(names, getCurrentTools(messages).map(tool => tool.name));
  const calls = new Map();
  let observations = 0;
  for (const message of payload.messages) {
    for (const call of message.tool_calls ?? []) calls.set(call.id, call);
    if (message.role === 'tool') {
      assert(calls.has(message.tool_call_id), `Orphan tool result: ${message.tool_call_id}`);
      calls.delete(message.tool_call_id);
      observations++;
    }
  }
  assert.equal(calls.size, 0, 'Request snapshot must have no unfinished tool calls');
  const system = payload.messages.filter(message => message.role === 'system' || message.role === 'developer');
  assert(system.length > 0);
  return { messageCount: payload.messages.length, systemMessages: system.length,
    toolNames: names, observations, systemText: system.map(message => message.content).join('\n\n'),
    thinking: payload.thinking ?? null, reasoningEffort: payload.reasoning_effort ?? null,
    toolChoice: payload.tool_choice ?? null };
}

const report = { model: modelName, output, real: values.real, repeat, reasoning: requestedReasoning,
  note: 'The real probes generate the next assistant decision only. No proposed tool is executed. Pi comparison uses the installed 1.3.0 prompt builder and the SAME Durable tool schemas; it is not a full Pi CLI run.',
  live: { conversationId: state.rootId, messageCount: view.messages.length,
    sections: Object.keys(current.sections ?? {}), toolNames: tools.map(tool => tool.name) },
  variants: [], results: [],
};
await writeFile(join(output, 'live-context.json'), JSON.stringify(view, null, 2));
await writeFile(join(output, 'inputs.json'), JSON.stringify(variants, null, 2));
for (const variant of variants) {
  let payload;
  let fetchAttempts = 0;
  const captured = await models.completeSimple(model, { messages: variant.messages }, {
    apiKey: 'offline-capture-only', maxTokens: 2048, ...reasoning,
    onPayload: value => { payload = structuredClone(value); throw new Error('OFFLINE_PAYLOAD_CAPTURE'); },
    fetch: async () => { fetchAttempts++; throw new Error('Capture must stop before fetch'); },
  });
  assert(payload, `No payload captured for ${variant.name}: ${captured.errorMessage}`);
  assert.equal(fetchAttempts, 0);
  const inspection = checkWire(payload, variant.messages);
  if (variant.name.startsWith('point') || variant.name.startsWith('recorded')) {
    assert(inspection.systemText.includes('持续陪伴用户工作的个人助手'));
    assert(!inspection.systemText.includes('no automatic model summarization is promised'), 'Old section should have been replaced');
  }
  await writeFile(join(output, `${variant.name}.wire.json`), JSON.stringify(payload, null, 2));
  report.variants.push({ name: variant.name, ...inspection });
}
console.log(JSON.stringify({ structuralChecks: 'passed', variants: variants.length, output }));
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));

if (values.real) {
  // Rotate condition order between rounds. Requests are independent and do not
  // alter any history, memory, app, or file outside this diagnostic directory.
  for (let round = 0; round < repeat; round++) {
    const ordered = round % 2 === 0 ? variants : [...variants].reverse();
    for (let offset = 0; offset < ordered.length; offset += 2) {
      const settled = await Promise.allSettled(ordered.slice(offset, offset + 2).map(async variant => {
        const started = Date.now();
        const response = await models.completeSimple(model, { messages: variant.messages }, {
          maxTokens: 2048, ...reasoning, timeoutMs: 45000, maxRetries: 0, signal: AbortSignal.timeout(55000),
        });
        const result = { variant: variant.name, round: round + 1, ms: Date.now() - started,
          stopReason: response.stopReason,
          tools: response.content.filter(part => part.type === 'toolCall').map(part => ({ name: part.name, arguments: part.arguments })),
          text: response.content.filter(part => part.type === 'text').map(part => part.text).join('\n'),
          ...(response.errorMessage ? { error: response.errorMessage } : {}), usage: response.usage,
        };
        report.results.push(result);
        console.log(JSON.stringify(result));
      }));
      for (const result of settled) if (result.status === 'rejected') {
        report.results.push({ error: result.reason.message });
        console.error(result.reason.message);
      }
      await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2));
    }
  }
}
await writeFile(join(directory, 'latest-context-audit.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ done: true, output, decisions: report.results.length }));
