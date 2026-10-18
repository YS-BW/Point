import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession } from '../../../server/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js';
import { ModelRuntime } from '../../../server/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js';
import { DefaultResourceLoader } from '../../../server/node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js';
import { SessionManager } from '../../../server/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js';
import { SettingsManager } from '../../../server/node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js';

// Exercise the actual Pi SDK, stopping at onPayload before any provider fetch.
// Its profile, settings, resources, and sessions are isolated from the user's Pi.
const output = fileURLToPath(new URL(`../runtime/native-pi-audit-${new Date().toISOString().replaceAll(':', '-')}/`, import.meta.url));
await mkdir(output, { recursive: true });
const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  credentials: {
    read: async provider => provider === 'deepseek' ? { type: 'api_key', key: 'offline-capture-only' } : undefined,
    list: async () => [{ providerId: 'deepseek', type: 'api_key' }],
    modify: async () => { throw new Error('Read-only audit credentials'); },
    delete: async () => { throw new Error('Read-only audit credentials'); },
  },
});
const model = runtime.getModel('deepseek', 'deepseek-flash');
assert(model);
const underlying = runtime.streamSimple.bind(runtime);
let capture;
let fetchAttempts = 0;
runtime.streamSimple = (selected, context, options) => underlying(selected, context, {
  ...options, apiKey: 'offline-capture-only',
  onPayload: async (value, actualModel) => {
    const changed = await options?.onPayload?.(value, actualModel);
    capture = structuredClone(changed ?? value);
    throw new Error('OFFLINE_NATIVE_PI_CAPTURE');
  },
  fetch: async () => { fetchAttempts++; throw new Error('Native capture must not fetch'); },
});
const results = [];
for (const choice of ['default', 'off']) {
  const cwd = join(output, choice);
  const agentDir = join(cwd, 'profile');
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model,
    resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd),
    ...(choice === 'off' ? { thinkingLevel: 'off' } : {}),
  });
  try {
    capture = undefined;
    await session.prompt('打开微信');
    assert(capture, `No SDK payload captured: ${choice}`);
    assert.equal(fetchAttempts, 0);
    const result = { choice, thinkingLevel: session.state.thinkingLevel,
      thinking: capture.thinking, tools: capture.tools.map(tool => tool.function.name),
      messageRoles: capture.messages.map(message => message.role),
    };
    results.push(result);
    await writeFile(join(output, `${choice}.wire.json`), JSON.stringify(capture, null, 2));
    console.log(JSON.stringify(result));
  } finally { session.dispose(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify({ output, fetchAttempts, results }, null, 2));
await writeFile(fileURLToPath(new URL('../runtime/latest-native-pi-audit.json', import.meta.url)), JSON.stringify({ output, fetchAttempts, results }, null, 2));
console.log(JSON.stringify({ passed: true, output }));
