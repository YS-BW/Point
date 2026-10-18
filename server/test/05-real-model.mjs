/**
 * 验证 5：《真实模型 + 真实工具调用》
 *
 * 这是模块 1 里 faux provider 补不上的那一半：真实推理决定要不要调工具、调什么参数，
 * 真实流式、真实用量与成本。
 *
 * 与 01 的区别：01 证明"链路通"，05 证明"模型真的能驱动工具"。
 *
 * 需要凭据：server/.pi/agent/auth.json 里有 deepseek 的 key。
 * 没有凭据时自动跳过（不失败），这样 npm test 在无凭据环境下仍然全绿。
 *
 * 复跑：node test/05-real-model.mjs
 * 换模型：POINT_REAL_MODEL=deepseek/deepseek-v4-pro node test/05-real-model.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { collectDeltas, evidence, finish, histogram, ok, section, skip } from "./_harness.mjs";
import { createModelRuntime, openServerSession } from "../src/session-service.mjs";
import { WORKSPACE, sessionDirFor } from "../src/paths.mjs";

const MODEL_REF = process.env.POINT_REAL_MODEL ?? "deepseek/deepseek-flash";
const SESSION_DIR_T05 = sessionDirFor("t05");
const OUT_DIR = join(WORKSPACE, "out");
const TARGET_FILE = join(OUT_DIR, "real-model.txt");
const MARKER = "real-model-ok";

section(`验证 5：真实模型 + 真实工具调用（${MODEL_REF}）`);

// 这个脚本会真的调用付费 API（一轮约 $0.001 ~ $0.006），
// 所以除了"没有凭据自动跳过"之外，再给一个显式开关。
if (process.env.POINT_SKIP_REAL === "1") {
  skip("POINT_SKIP_REAL=1，跳过真实模型验证");
}

// 凭据检查：没有就跳过，不判失败
const runtime = await createModelRuntime();
const authStatus = runtime.getProviderAuthStatus(MODEL_REF.split("/")[0]);
if (!authStatus.configured) {
  skip(`没有 ${MODEL_REF.split("/")[0]} 的凭据（server/.pi/agent/auth.json），跳过真实模型验证`);
} else {
  evidence("凭据来源", authStatus.source);
}

rmSync(SESSION_DIR_T05, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
rmSync(TARGET_FILE, { force: true });

const service = await openServerSession({
  resume: "new",
  modelRef: MODEL_REF,
  sessionDir: SESSION_DIR_T05,
});
evidence("sessionFile", service.sessionFile);

const events = [];
service.subscribe((event) => events.push(event));
const deltaTimeline = [];
service.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    deltaTimeline.push(Date.now());
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

const startedAt = Date.now();
await service.prompt(
  `请在 out/ 目录下创建文件 real-model.txt，内容正好是 ${MARKER}（不要有多余的空行），` +
    `然后用 cat 把内容读出来给我看。只做这一件事，做完简短说明即可。`,
);
const elapsedMs = Date.now() - startedAt;
process.stdout.write("\n");

// ---- 断言 ----
const deltas = collectDeltas(events);
ok("真实模型产生了流式文本", deltas.length > 0, `${deltas.length} 个 delta`);

const toolEvents = events.filter((event) => event.type === "tool_execution_start");
ok("真实模型自主决定调用工具", toolEvents.length > 0, `工具: ${toolEvents.map((event) => event.toolName).join(",") || "(无)"}`);

ok("工具真实产生了文件", existsSync(TARGET_FILE), TARGET_FILE);
const fileContent = existsSync(TARGET_FILE) ? readFileSync(TARGET_FILE, "utf8").trim() : "";
ok("文件内容正确", fileContent === MARKER, JSON.stringify(fileContent));

const assistantTexts = service.messages
  .filter((message) => message.role === "assistant")
  .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
  .filter((part) => part.type === "text")
  .map((part) => part.text);
ok("助手给出了最终说明", assistantTexts.some((text) => text.trim().length > 0), `${assistantTexts.length} 段文本`);

ok("会话落盘", Boolean(service.sessionFile) && existsSync(service.sessionFile));

// ---- 用量与成本 ----
function sumUsage(messages) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const message of messages) {
    const usage = message.usage;
    if (!usage) continue;
    total.input += usage.input ?? 0;
    total.output += usage.output ?? 0;
    total.cacheRead += usage.cacheRead ?? 0;
    total.cacheWrite += usage.cacheWrite ?? 0;
    total.cost += usage.cost?.total ?? 0;
  }
  return total;
}
const usage = sumUsage(service.messages);

section("实测证据");
evidence("整轮耗时", `${elapsedMs}ms`);
evidence("模型", MODEL_REF);
evidence("事件类型直方图", histogram(events));
evidence("工具调用次数", toolEvents.length);
evidence("token 用量", { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
evidence("成本（USD，按 pi-ai 目录价）", usage.cost);
evidence("会话消息角色", service.messages.map((message) => message.role));
if (deltaTimeline.length > 1) {
  evidence("首个 delta 时刻", `+${deltaTimeline[0] - startedAt}ms`);
  evidence("末个 delta 时刻", `+${deltaTimeline.at(-1) - startedAt}ms`);
}

service.dispose();
finish("验证 5");
