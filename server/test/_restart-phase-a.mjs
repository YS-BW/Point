/**
 * 验证 2 阶段 A：在一个独立进程里建会话并留一句话，然后退出。
 * 阶段 B（父进程）要证明重启后能继续同一会话。
 * 必须是独立进程 —— 同进程内 dispose 再 open 证明不了"重启"。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fauxAssistantMessage, startFauxProvider } from "../src/faux.mjs";
import { openServerSession } from "../src/session-service.mjs";
import { FAUX_MODEL_REF, RUNTIME_DIR, sessionDirFor } from "../src/paths.mjs";

const SESSION_DIR_T02 = sessionDirFor("t02");
const MARKER = "重启标记-7f3a91";

// 阶段 A 自己做干净起点，保证"继续最近一次"是确定的
rmSync(SESSION_DIR_T02, { recursive: true, force: true });
mkdirSync(RUNTIME_DIR, { recursive: true });
rmSync(join(RUNTIME_DIR, "t02-phase-a.json"), { force: true });

const faux = startFauxProvider();
faux.setResponses([fauxAssistantMessage(`收到，我记住了：${MARKER}`)]);

const service = await openServerSession({
  resume: "new",
  modelRef: FAUX_MODEL_REF,
  sessionDir: SESSION_DIR_T02,
});

const handle = await service.prompt(`请记住这个标记，之后我会考你：${MARKER}`);
void handle;

writeFileSync(
  join(RUNTIME_DIR, "t02-phase-a.json"),
  JSON.stringify(
    {
      sessionId: service.sessionId,
      sessionFile: service.sessionFile,
      marker: MARKER,
      messageCount: service.messages.length,
      sessionFileExists: existsSync(service.sessionFile ?? ""),
    },
    null,
    2,
  ),
);

console.log(`[阶段A] sessionId=${service.sessionId} 消息数=${service.messages.length} 进程即将退出`);
service.dispose();
