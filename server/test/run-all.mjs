/**
 * 一次跑完所有验证并输出汇总矩阵。
 * 用法：node test/run-all.mjs（或 npm test）
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const scripts = readdirSync(HERE)
  .filter((name) => /^\d\d-.*\.mjs$/.test(name))
  .sort();

const rows = [];
for (const script of scripts) {
  console.log(`\n\n########## ${script} ##########`);
  const result = spawnSync(process.execPath, [join(HERE, script)], {
    stdio: "inherit",
    env: process.env,
  });
  rows.push({ script, code: result.status ?? 1 });
}

console.log(`\n\n${"=".repeat(64)}\n验证汇总\n${"=".repeat(64)}`);
for (const row of rows) {
  console.log(`  ${row.code === 0 ? "PASS" : "FAIL"}  ${row.script}`);
}
const failed = rows.filter((row) => row.code !== 0).length;
console.log(`\n  ${rows.length - failed}/${rows.length} 个验证脚本通过`);
process.exitCode = failed === 0 ? 0 : 1;
