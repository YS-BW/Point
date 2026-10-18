#!/usr/bin/env node
/**
 * Point 数据目录在线备份。
 *
 * 为什么不能直接 cp：state.sqlite 处于 WAL 模式，直接复制会漏掉尚未 checkpoint
 * 的 WAL 内容。这里用 SQLite 自己的 `VACUUM INTO` 生成一致性快照，再复制工作区
 * 文件与浏览器登录检查点。
 *
 * 用法：
 *   node scripts/backup.mjs [--data runtime/default] [--out backups] [--keep 7]
 *
 * 产物：<out>/<UTC 时间戳>/{state.sqlite, workspace/, browser-contexts/, manifest.json}
 * 退出码：0 成功且校验通过；1 失败；2 参数错误。
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`--${name} 需要一个值`);
  return value;
}
function fail(message) {
  console.error(`backup: ${message}`);
  process.exit(2);
}

const dataDir = resolve(option('data', 'runtime/default'));
const outDir = resolve(option('out', 'backups'));
const keep = Number(option('keep', '0'));
const dbPath = join(dataDir, 'state.sqlite');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
const target = join(outDir, stamp);

const exists = async path => stat(path).then(() => true, () => false);
if (!(await exists(dbPath))) fail(`找不到 ${dbPath}；用 --data 指定数据目录`);
if (Number.isFinite(keep) === false || keep < 0) fail('--keep 必须是非负整数');

await mkdir(target, { recursive: true });

// 1. SQLite 一致性快照。路径中的单引号需转义，VACUUM INTO 不接受绑定参数。
const snapshot = join(target, 'state.sqlite');
const db = new DatabaseSync(dbPath);
try {
  const escaped = snapshot.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
} finally {
  db.close();
}

// 2. 工作区与浏览器登录检查点（普通文件，非事务范围）。
const copyDir = async name => {
  const source = join(dataDir, name);
  if (!(await exists(source))) return false;
  await cp(source, join(target, name), { recursive: true, force: true });
  return true;
};
const copiedWorkspace = await copyDir('workspace');
const copiedProfiles = await copyDir('browser-contexts');

// 3. 校验：重新打开快照，做 integrity_check，并确认关键表存在。
const verify = new DatabaseSync(snapshot);
let integrity;
let tableNames = [];
try {
  integrity = verify.prepare('PRAGMA integrity_check').get()?.integrity_check ?? 'unknown';
  tableNames = verify.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
} finally {
  verify.close();
}
const required = ['conversations', 'entries'];
const missing = required.filter(name => !tableNames.includes(name));
if (integrity !== 'ok' || missing.length) {
  console.error(JSON.stringify({ ok: false, integrity, missing }, null, 2));
  process.exit(1);
}

// 4. manifest：文件清单 + SHA-256，便于恢复时核对。
const files = [];
async function walk(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const relative = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) await walk(full, relative);
    else if (entry.isFile()) {
      const bytes = await readFile(full);
      files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
await walk(target);
files.sort((a, b) => a.path.localeCompare(b.path));
const manifest = {
  createdAt: new Date().toISOString(),
  sourceDataDir: dataDir,
  node: process.version,
  integrity,
  tables: tableNames.sort(),
  copiedWorkspace,
  copiedProfiles,
  note: 'owner.sqlite 是进程锁文件（无业务数据），不备份。恢复时需先停止服务。',
  files,
};
await writeFile(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// 5. 可选保留策略：只删除本脚本命名格式的历史快照目录。
if (keep > 0) {
  const pattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
  const entries = (await readdir(outDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && pattern.test(entry.name))
    .map(entry => entry.name)
    .sort();
  for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
    await rm(join(outDir, name), { recursive: true, force: true });
  }
}

const bytes = files.reduce((total, file) => total + file.bytes, 0);
console.log(JSON.stringify({
  ok: true, backup: target, integrity,
  files: files.length, bytes, copiedWorkspace, copiedProfiles,
  note: `${basename(target)} 已通过 integrity_check`,
}, null, 2));
