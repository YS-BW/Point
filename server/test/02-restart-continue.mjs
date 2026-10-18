/**
 * 验证 2：《重启后能继续对话》
 *
 * 要证明的事：会话历史在磁盘上，进程完全退出后重新起来能接着原来的会话继续。
 * 通过标准（模块 1 后半）：重启后能继续对话。
 *
 * 复跑：node test/02-restart-continue.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evidence, finish, ok, section } from "./_harness.mjs";
import { fauxAssistantMessage, startFauxProvider } from "../src/faux.mjs";
import { openServerSession } from "../src/session-service.mjs";
import { FAUX_MODEL_REF, RUNTIME_DIR, sessionDirFor } from "../src/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_DIR_T02 = sessionDirFor("t02");
const HANDOFF = join(RUNTIME_DIR, "t02-phase-a.json");

section("验证 2：重启后继续对话（跨进程）");

// ---- 阶段 A：独立子进程建会话后退出 ----
console.log("  --- 阶段 A：独立进程写入会话后退出 ---");
execFileSync(process.execPath, [join(HERE, "_restart-phase-a.mjs")], { stdio: "inherit" });
ok("阶段 A 留下了交接信息", existsSync(HANDOFF), HANDOFF);
const phaseA = JSON.parse(readFileSync(HANDOFF, "utf8"));
evidence("阶段 A sessionId", phaseA.sessionId);
evidence("阶段 A 消息数", phaseA.messageCount);

// ---- 阶段 B：新进程继续 ----
console.log("  --- 阶段 B：新进程继续同一会话 ---");
const faux = startFauxProvider();
faux.setResponses([fauxAssistantMessage("你让我记住的标记是：重启标记-7f3a91")]);

const service = await openServerSession({
  resume: "continue",
  modelRef: FAUX_MODEL_REF,
  sessionDir: SESSION_DIR_T02,
});
evidence("阶段 B sessionId", service.sessionId);

ok("重启后继续的是同一个会话", service.sessionId === phaseA.sessionId, `${service.sessionId} vs ${phaseA.sessionId}`);
ok("会话文件路径一致", service.sessionFile === phaseA.sessionFile);
ok("历史消息被恢复", service.messages.length >= phaseA.messageCount, `${phaseA.messageCount} → ${service.messages.length}`);

const historyText = JSON.stringify(service.messages);
ok("历史里能找到阶段 A 的标记", historyText.includes(phaseA.marker));

const beforeCount = service.messages.length;
await service.prompt("我上一句让你记住的标记是什么？");
ok("重启后可以继续发起新对话", service.messages.length > beforeCount, `${beforeCount} → ${service.messages.length}`);

const lastAssistant = [...service.messages].reverse().find((message) => message.role === "assistant");
const lastText = Array.isArray(lastAssistant?.content)
  ? lastAssistant.content.filter((part) => part.type === "text").map((part) => part.text).join("")
  : "";
ok("新答复是新进程产生的", lastText.includes(phaseA.marker), JSON.stringify(lastText.slice(0, 60)));

section("实测证据");
evidence("继续后的角色序列", service.messages.map((message) => message.role));
evidence("会话文件字节数", existsSync(service.sessionFile) ? readFileSync(service.sessionFile, "utf8").length : 0);

service.dispose();
finish("验证 2");
