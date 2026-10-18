import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
let count = 0;
for (const folder of ['src', 'test', 'scripts']) {
  for (const file of await readdir(join(root, folder))) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', join(root, folder, file)], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(1); }
    count++;
  }
}
console.log(`Syntax checks passed: ${count} modules`);
