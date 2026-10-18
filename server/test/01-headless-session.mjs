/**
 * 验证 1：《Pi SDK 服务端运行》
 *
 * 要证明的事：无终端跑起来、真实工具调用、流式输出、会话落到磁盘。
 * 通过标准（对应模块 1 的前半）：发起一个文件处理任务，收到过程与结果。
 *
 * 这一轮用官方 faux provider 驱动，因此不需要任何模型凭据。
 * 换成真实模型只需把 MODEL_REF 指向真实 provider/model。
 *
 * 复跑：node test/01-headless-session.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { collectDeltas, evidence, finish, histogram, ok, section } from "./_harness.mjs";
import { scriptToolThenAnswer, startFauxProvider } from "../src/faux.mjs";
import { openServerSession } from "../src/session-service.mjs";
import { FAUX_MODEL_REF, WORKSPACE } from "../src/paths.mjs";

const OUT_DIR = join(WORKSPACE, "out");
const EVIDENCE_FILE = join(OUT_DIR, "t01-evidence.txt");
const MARKER = "tool-executed-in-headless-session";

section("验证 1：Pi SDK 服务端运行（无终端 / 工具调用 / 流式 / 会话保存）");

// 干净起点
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// 无终端是这一模块的前提，先确认环境本身没有 TTY
ok("进程无 TTY（stdin/stdout 都不是终端）", !process.stdin.isTTY && !process.stdout.isTTY, `stdin=${Boolean(process.stdin.isTTY)} stdout=${Boolean(process.stdout.isTTY)}`);

const faux = startFauxProvider();
scriptToolThenAnswer(faux, {
  tool: "bash",
  args: { command: `printf '%s\\n' '${MARKER}' > out/t01-evidence.txt && cat out/t01-evidence.txt` },
  answer: "我已经把证据文件写到 out/t01-evidence.txt，内容是工具实际输出的那一行。",
});

const service = await openServerSession({ resume: "new", modelRef: FAUX_MODEL_REF });
evidence("sessionId", service.sessionId);
evidence("sessionFile", service.sessionFile);
evidence("可用扩展数", service.extensionsResult?.extensions?.length ?? "(无 extensionsResult)");
if (service.modelFallbackMessage) evidence("modelFallback", service.modelFallbackMessage);

const events = [];
service.subscribe((event) => events.push({ ...event, __at: Date.now() }));
// 同时打印增量，证明是流式而不是一次性返回
service.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

const startedAt = Date.now();
await service.prompt("请用 bash 工具在 out/ 目录下写一个证据文件，然后把内容读出来。");
const elapsedMs = Date.now() - startedAt;
process.stdout.write("\n");

// ---- 断言 ----
const deltas = collectDeltas(events);
ok("收到文本流式增量", deltas.length > 0, `${deltas.length} 个 delta`);
ok("增量是分片到达而非单次整段", deltas.length >= 2, `${deltas.length} 个 delta，首个在 +${deltas[0] ? deltas[0].at - startedAt : "-"}ms，末个在 +${deltas.length ? deltas.at(-1).at - startedAt : "-"}ms`);

ok("工具真的执行并产生了文件", existsSync(EVIDENCE_FILE), EVIDENCE_FILE);
const fileContent = existsSync(EVIDENCE_FILE) ? readFileSync(EVIDENCE_FILE, "utf8").trim() : "";
ok("文件内容等于工具输出", fileContent === MARKER, JSON.stringify(fileContent));

const toolEvents = events.filter((event) => String(event.type).startsWith("tool_execution"));
ok("事件流里有工具执行事件", toolEvents.length > 0, `${toolEvents.length} 个`);

const assistantTexts = service.messages
  .filter((message) => message.role === "assistant")
  .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
  .filter((part) => part.type === "text")
  .map((part) => part.text);
ok("最终助手答复已落到会话里", assistantTexts.some((text) => text.includes("t01-evidence")), `${assistantTexts.length} 段文本`);

ok("会话已持久化到磁盘", Boolean(service.sessionFile) && existsSync(service.sessionFile));
ok("会话消息数量 > 0", service.messages.length > 0, `${service.messages.length} 条`);

// ---- 证据 ----
section("实测证据");
evidence("整轮耗时", `${elapsedMs}ms`);
evidence("事件类型直方图", histogram(events));
const settleTypes = events.filter((event) => event.type === "agent_end" || event.type === "agent_settled");
evidence("结束事件", settleTypes.map((event) => event.type));
for (const delta of deltas.slice(0, 6)) evidence(`delta +${delta.at - startedAt}ms`, JSON.stringify(delta.text));
if (deltas.length > 6) evidence("...", `其余 ${deltas.length - 6} 个 delta 略`);
evidence("会话里的角色序列", service.messages.map((message) => message.role));

service.dispose();
finish("验证 1");
