import { spawnSync } from 'node:child_process';
import { mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../runtime/', import.meta.url), { recursive: true });
const installed = await access(new URL('../runtime/webrtc-venv/bin/python', import.meta.url)).then(() => true, () => false);
const commands = [...(installed ? [] : [['venv', '--python', 'python3', 'runtime/webrtc-venv']]), ['pip', 'sync', '--python', 'runtime/webrtc-venv/bin/python', 'webrtc/requirements.txt']];
for (const args of commands) {
  const result = spawnSync('uv', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Install uv and Python >=3.10, then rerun npm run setup:webrtc');
}
console.log('WebRTC runtime ready. Start the service with --webrtc.');
