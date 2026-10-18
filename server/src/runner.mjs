/**
 * 服务端入口骨架（不是测试）。
 *
 * 用途：证明"常驻服务 + 事件流出"这个形态本身的形状 —— 所有 SDK 事件被归一化成
 * JSONL 打到 stdout，之后接 SSE / WebSocket 只需在这一层做通道替换，不动会话逻辑。
 *
 * 用法：
 *   node src/runner.mjs --prompt "..."            新建会话并跑一轮
 *   node src/runner.mjs --continue --prompt "..."  继续最近一次会话
 *   node src/runner.mjs --prompt "..." --model faux/faux-1
 *
 * 注：默认模型需要真实凭据；没有凭据时用 faux 模型跑通链路。
 */
import { openServerSession } from "./session-service.mjs";
import { scriptToolThenAnswer, startFauxProvider } from "./faux.mjs";
import { FAUX_MODEL_REF, SESSION_DIR, WORKSPACE } from "./paths.mjs";

function parseArgs(argv) {
  const args = { continue: false, model: undefined, prompt: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--continue") args.continue = true;
    else if (token === "--model") args.model = argv[++index];
    else if (token === "--prompt") args.prompt = argv[++index];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const modelRef = args.model ?? process.env.POINT_MODEL ?? FAUX_MODEL_REF;

// 假模型没有推理能力，脚本化一轮"先调 bash、再给答复"用于演示服务端链路本身。
// 接真实 provider 时这段不生效。
if (modelRef.startsWith("faux/")) {
  scriptToolThenAnswer(startFauxProvider(), {
    tool: "bash",
    args: { command: "mkdir -p out && printf 'runner-ok\\n' > out/runner.txt && cat out/runner.txt" },
    answer: "已用 bash 写下 out/runner.txt。",
  });
}

/** 事件 -> 对外协议。这里只保留服务端需要转发的字段。 */
function toWireEvent(event) {
  const wire = { type: event.type };
  if (event.type === "message_update" && event.assistantMessageEvent) {
    wire.delta = event.assistantMessageEvent.type === "text_delta" ? event.assistantMessageEvent.delta : undefined;
    wire.inner = event.assistantMessageEvent.type;
  }
  if (event.type === "tool_execution_start") wire.tool = event.toolName;
  if (event.type === "tool_execution_end") wire.tool = event.toolName;
  if (event.type === "message_end" && event.message) wire.role = event.message.role;
  return wire;
}

const service = await openServerSession({
  resume: args.continue ? "continue" : "new",
  modelRef,
  cwd: WORKSPACE,
  sessionDir: SESSION_DIR,
});

console.log(JSON.stringify({ type: "session_opened", sessionId: service.sessionId, sessionFile: service.sessionFile, model: modelRef }));

service.subscribe((event) => {
  console.log(JSON.stringify({ at: Date.now(), ...toWireEvent(event) }));
});

if (args.prompt !== undefined) {
  await service.prompt(args.prompt);
}

service.dispose();
