/**
 * 验证 4：《UI 契约：扩展在无终端服务端里到底看到什么》
 *
 * 这是插件兼容性风险的核心一项。要证明的事：
 *   A. 默认无终端时，扩展的 hasUI 是 false，但 ctx.ui.select/confirm 仍然是"函数"，
 *      调用后会静默返回 undefined / false —— 不抛错、不挂起、没有日志。
 *   B. 注入 Point 自己的 UI 上下文后，扩展能真的拿到答复，并且扩展能看到
 *      ui_prompt_start / ui_prompt_end 事件（这是把对话框接到 Web 的挂点）。
 *   C. 撤销 UI 上下文后回到无 UI 行为（注意 bindExtensions 对 undefined 是"不赋值"）。
 *   D. 记录一个顺序事实：uiContext 无法在 createAgentSession 时注入，
 *      所以 session_start 阶段扩展看到的 hasUI 一定是 false。
 *
 * 复跑：node test/04-ui-contract.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

import { evidence, finish, ok, section } from "./_harness.mjs";
import { fauxAssistantMessage, fauxToolCall, startFauxProvider } from "../src/faux.mjs";
import { openServerSession } from "../src/session-service.mjs";
import { FAUX_MODEL_REF, RUNTIME_DIR, PROBE_LOG, sessionDirFor } from "../src/paths.mjs";
import { createStubUI } from "../src/stub-ui.mjs";

const SESSION_DIR_T04 = sessionDirFor("t04");

/** 每一阶段前清空探针日志，按阶段读观测结果 */
function readProbe() {
  if (!existsSync(PROBE_LOG)) return [];
  return readFileSync(PROBE_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const findProbeUI = (entries) => [...entries].reverse().find((entry) => entry.event === "probe_ui");

function scriptProbe(faux) {
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("probe_ui", {})]),
    fauxAssistantMessage("探针已完成"),
  ]);
}

section("验证 4：扩展的 UI 契约（无终端默认行为 / 注入对话框 / 撤销）");

rmSync(SESSION_DIR_T04, { recursive: true, force: true });
mkdirSync(RUNTIME_DIR, { recursive: true });
process.env.POINT_PROBE_LOG = PROBE_LOG;
// 必须在建会话之前清空：否则会读到上一次运行留下的 session_start，
// 得出"扩展被加载两次 / hasUI 值不对"这类假结论。
rmSync(PROBE_LOG, { force: true });

const faux = startFauxProvider();
const service = await openServerSession({
  resume: "new",
  modelRef: FAUX_MODEL_REF,
  sessionDir: SESSION_DIR_T04,
});

const loadedExtensions = service.extensionsResult?.extensions ?? [];
evidence("已加载扩展", loadedExtensions.map((extension) => extension.path));
ok("探针扩展被自动发现并加载", loadedExtensions.some((extension) => String(extension.path).includes("probe")));
const extensionErrors = service.extensionsResult?.errors ?? [];
ok("扩展加载无错误", extensionErrors.length === 0, JSON.stringify(extensionErrors));

// 扩展在 open 时看到的 hasUI。
// 注意 openServerSession 会调用 bindExtensions，而 session_start 正是在那里发出的：
// 不调用 bindExtensions 的 SDK 集成里，扩展的 session_start 处理器根本不会执行。
const openLog = readProbe();
const sessionStart = openLog.find((entry) => entry.event === "session_start");
ok("open 时扩展被激活并发出 session_start", sessionStart !== undefined, `日志: ${openLog.map((entry) => entry.event).join(",") || "(空)"}`);
ok("未注入 UI 上下文时 session_start 里 hasUI === false", sessionStart?.hasUI === false, `hasUI=${sessionStart?.hasUI}`);
evidence("session_start 阶段 mode", sessionStart?.mode);
const loadEntries = openLog.filter((entry) => entry.event === "extension_loaded");
evidence("扩展加载记录", loadEntries);
ok("扩展工厂只被调用一次（模块级副作用不会重复执行）", loadEntries.at(-1)?.factoryRuns === 1, `factoryRuns=${loadEntries.at(-1)?.factoryRuns}`);

// ---------- 阶段 A：默认无终端 ----------
section("阶段 A：默认无终端（不注入 UI 上下文）");
rmSync(PROBE_LOG, { force: true });
scriptProbe(faux);
await service.prompt("请调用 probe_ui 报告 UI 情况");

const probeA = findProbeUI(readProbe());
ok("阶段 A 探针执行成功", probeA !== undefined);
if (probeA) {
  ok("A: 无终端时 hasUI === false", probeA.hasUI === false, `hasUI=${probeA.hasUI}`);
  ok(
    "A: 但 ctx.ui.select 仍然是函数（静默失效的陷阱）",
    probeA.typeofSelect === "function",
    `typeof select=${probeA.typeofSelect}`,
  );
  ok("A: confirm 静默返回 false，不抛异常", probeA.confirmResult === false && probeA.error === undefined, `confirm=${JSON.stringify(probeA.confirmResult)} error=${probeA.error}`);
  ok("A: select 静默返回 undefined，不抛异常", probeA.selectResult === undefined && probeA.error === undefined, `select=${JSON.stringify(probeA.selectResult)}`);
}
const phaseALog = readProbe();
ok("A: 无 UI 上下文时不会发出 ui_prompt 事件", !phaseALog.some((entry) => entry.event === "ui_prompt_start"), `日志条目: ${phaseALog.map((entry) => entry.event).join(",")}`);

// ---------- 阶段 B：注入 Point 的对话框代理 ----------
section("阶段 B：注入 UI 上下文（模拟 Point 把对话框接到 Web）");
rmSync(PROBE_LOG, { force: true });
const stubCalls = [];
const stubUI = createStubUI({
  confirmAnswer: true,
  selectAnswer: "选项B",
  onCall: (call) => stubCalls.push(call),
});
await service.bindUI(stubUI, "print");
scriptProbe(faux);
await service.prompt("请再调用一次 probe_ui，这次应该能拿到答复");

const probeB = findProbeUI(readProbe());
ok("阶段 B 探针执行成功", probeB !== undefined);
if (probeB) {
  ok("B: 注入后 hasUI === true", probeB.hasUI === true, `hasUI=${probeB.hasUI}`);
  ok("B: confirm 拿到了桩的答复 true", probeB.confirmResult === true, `confirm=${JSON.stringify(probeB.confirmResult)}`);
  ok("B: select 拿到了桩的答复", probeB.selectResult === "选项B", `select=${JSON.stringify(probeB.selectResult)}`);
}
const phaseBLog = readProbe();
const promptStarts = phaseBLog.filter((entry) => entry.event === "ui_prompt_start");
const promptEnds = phaseBLog.filter((entry) => entry.event === "ui_prompt_end");
ok("B: 扩展能看到 ui_prompt_start 事件", promptStarts.length > 0, `${promptStarts.length} 次`);
ok("B: 扩展能看到 ui_prompt_end 事件", promptEnds.length > 0, `${promptEnds.length} 次`);
ok("B: 两类对话框都被观察到", new Set(promptStarts.map((entry) => entry.kind)).size >= 2, `kind=${[...new Set(promptStarts.map((entry) => entry.kind))].join(",")}`);
evidence("桩收到的调用", stubCalls.map((call) => call.name));

// ---------- 阶段 C：撤销 UI 上下文 ----------
section("阶段 C：撤销 UI 上下文");
rmSync(PROBE_LOG, { force: true });
await service.unbindUI();
scriptProbe(faux);
await service.prompt("第三次调用 probe_ui，验证撤销是否生效");

const probeC = findProbeUI(readProbe());
ok("阶段 C 探针执行成功", probeC !== undefined);
if (probeC) {
  ok("C: 撤销后 hasUI 回到 false", probeC.hasUI === false, `hasUI=${probeC.hasUI}`);
  ok("C: 撤销后 select 又静默返回 undefined", probeC.selectResult === undefined, `select=${JSON.stringify(probeC.selectResult)}`);
}

// ---------- 阶段 D：第一次激活就带上 UI 上下文 ----------
section("阶段 D：推荐的接入形态 —— 第一次 bindExtensions 就带上 UI 上下文");
rmSync(PROBE_LOG, { force: true });
const sessionD = await openServerSession({
  resume: "new",
  modelRef: FAUX_MODEL_REF,
  sessionDir: sessionDirFor("t04d"),
  uiContext: createStubUI({ confirmAnswer: true, selectAnswer: "选项B" }),
});
const startD = readProbe().find((entry) => entry.event === "session_start");
ok(
  "D: session_start 阶段 hasUI === true",
  startD?.hasUI === true,
  `hasUI=${startD?.hasUI} —— 分两次调用做不到，session_start 只会由首次 bindExtensions 发出`,
);
sessionD.dispose();

section("结论要点");
console.log("  · 无终端下扩展不会卡死，而是静默拿到 confirm=false / select=undefined —— 失败不报错，最难排查。");
console.log("  · ctx.ui 的方法在无 UI 时依然存在，所以插件里 `typeof ctx.ui.select === 'function'` 这种自检判断不出无终端。");
console.log("  · hasUI 是全局开关（uiContext !== noOpUIContext）：注入一个对话框代理会让所有扩展同时进入有 UI 分支。");
console.log("  · uiContext 不能在 createAgentSession 时注入，只能建好后 bindExtensions；而 session_start 正是由 bindExtensions 发出的，");
console.log("    所以推荐形态是「第一次激活就带上对话框代理」，这样 session_start 里 hasUI 就是 true（阶段 D 已验证）。");
console.log("  · 撤销必须传 null；传 undefined 是空操作（与类型声明的直觉相反）。");

service.dispose();
finish("验证 4");
