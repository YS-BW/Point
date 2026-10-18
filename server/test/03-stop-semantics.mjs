/**
 * 验证 3：《停止当前回答》
 *
 * 要证明的事：服务端能中途停下正在跑的 turn，而且停下之后会话还能继续用。
 * 同时如实记录一个边界：abort 停止的是 agent 循环，不等于已经启动的子进程被回收。
 *
 * 复跑：node test/03-stop-semantics.mjs
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { evidence, finish, histogram, ok, section } from "./_harness.mjs";
import { fauxAssistantMessage, fauxToolCall, startFauxProvider } from "../src/faux.mjs";
import { openServerSession } from "../src/session-service.mjs";
import { FAUX_MODEL_REF, WORKSPACE, sessionDirFor } from "../src/paths.mjs";

const SESSION_DIR_T03 = sessionDirFor("t03");
const OUT_DIR = join(WORKSPACE, "out");
const SIDE_EFFECT_FILE = join(OUT_DIR, "t03-side-effect.txt");

section("验证 3：停止当前回答，并且停下后会话仍可用");

rmSync(SESSION_DIR_T03, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
rmSync(SIDE_EFFECT_FILE, { force: true });

const faux = startFauxProvider();
// 这个工具会睡 6 秒再写文件：给我们一个足够长的窗口在中途 abort
faux.setResponses([
  fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 6 && printf 'side-effect\\n' > out/t03-side-effect.txt" })]),
  fauxAssistantMessage("这轮不应该完整跑完"),
]);

const service = await openServerSession({
  resume: "new",
  modelRef: FAUX_MODEL_REF,
  sessionDir: SESSION_DIR_T03,
});

const events = [];
let abortCalledAt;
let abortError;

service.subscribe((event) => {
  events.push({ type: event.type });
  if (event.type === "tool_execution_start" && abortCalledAt === undefined) {
    abortCalledAt = Date.now();
    service.abort().catch((error) => {
      abortError = String(error);
    });
  }
});

const startedAt = Date.now();
let promptError;
try {
  await service.prompt("跑一个会睡一会再写文件的命令");
} catch (error) {
  promptError = error instanceof Error ? error.message : String(error);
}
const elapsedMs = Date.now() - startedAt;

ok("abort 在工具执行中被触发", abortCalledAt !== undefined, abortCalledAt === undefined ? "没触发" : `+${abortCalledAt - startedAt}ms`);
ok("abort 自身没有报错", abortError === undefined, abortError);
ok("prompt 在 5 秒内结束（没有被 6 秒的 sleep 拖住）", elapsedMs < 5000, `${elapsedMs}ms`);
ok("中途停止不抛异常给调用方", promptError === undefined, promptError);

const sideEffectImmediately = existsSync(SIDE_EFFECT_FILE);

// 停下之后会话必须还能继续用：这是"停止当前回答"与"停止会话"的区别
faux.setResponses([fauxAssistantMessage("我已经停下来了，这是停止之后的新答复。")]);
let continueError;
try {
  await service.prompt("停止之后还能继续吗？");
} catch (error) {
  continueError = error instanceof Error ? error.message : String(error);
}
const lastAssistant = [...service.messages].reverse().find((message) => message.role === "assistant");
const lastText = Array.isArray(lastAssistant?.content)
  ? lastAssistant.content.filter((part) => part.type === "text").map((part) => part.text).join("")
  : "";

ok("停止后会话仍可继续对话", continueError === undefined && lastText.includes("停下来了"), continueError ?? lastText);

// 如实记录副作用边界，不作为通过条件
await new Promise((resolve) => setTimeout(resolve, 7000));
const sideEffectLater = existsSync(SIDE_EFFECT_FILE);

section("实测证据");
evidence("整轮耗时（被 abort 截断）", `${elapsedMs}ms`);
evidence("事件直方图", histogram(events.map((event) => ({ type: event.type }))));
evidence("abort 当时副作用文件是否存在", sideEffectImmediately);
evidence("等待 7 秒后副作用文件是否存在", sideEffectLater);
evidence("会话消息角色", service.messages.map((message) => message.role));

section("结论要点");
console.log(
  sideEffectLater
    ? "  · abort 停止了 agent 循环并让调用方及时返回，但已经启动的 bash 子进程仍然跑完并落了副作用。\n" +
        "    也就是说：'停止当前回答'不等于'撤销已发生的外部动作'，任务级取消需要 Point 自己界定副作用边界。"
    : "  · abort 也阻止了子进程的副作用落盘。仍需在真实工具上复核，因为不同工具的取消语义不一致。",
);

service.dispose();
finish("验证 3");
