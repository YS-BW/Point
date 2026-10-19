# WP5 AG-UI 投影复审计（B1 修复后）

> 2026-10-19。对象：worktree `/Users/lixinlv/Projects/Doing/point-wp5`，分支 `wp/5-agui-projection`，HEAD `e8daa27`（fix，基于 `44c657c`）。
> 评审人：code-auditor。范围：只读复审计 + 独立探针；仅写本文件，未改源码/测试。
> 结论：**B1 已修复**；**仍有 1 个 blocker（point.ui 校验未拒绝 `document.`/`window.`）**，其余复审计项通过。

## 1. 验证

| 项目 | 结果 |
|---|---|
| `npx tsc -p apps/server/tsconfig.json --outDir /tmp/point-wp5b` | BUILD_OK |
| `node --test agui.test.js` | **13/13 pass** |
| 服务端全量隔离构建 | **305/305 pass** |
| `scripts/*.test.mjs` | **11/11 pass** |
| `tsc --noEmit` / `check-boundaries.mjs` | exit 0 / passed |
| worktree | clean；未改源码/测试 |

独立探针（`/tmp/point-audit-probe/wp5-reaudit.mjs` 等，非作者测试）结果见 §2–§5。

## 2. B1 复核：已修复（通过）

- 代码：`api/agui/projection.ts:88-99` 改为单一 `open: OpenEntity[]` 栈；`closeEntities()` 从栈顶 `pop()` 逆创建顺序关闭 tool/message/step；`finish()`/`error()` 均复用（`:100-121`）。自然结束时 `message_end`/`tool_end`/`step_end` 从栈中移除，避免重复关闭。
- 独立探针（fake `AgentRunPort` → 真实 `createHttp`）：
  1. 旧序列 `step_start(turn-1) → message_start(m-1) → tool_start(c-1) → run_end(cancelled)`：
     `TOOL_CALL_END(c-1) → TEXT_MESSAGE_END(m-1) → STEP_FINISHED(turn-1) → RUN_FINISHED` ✅ 严格 LIFO。
  2. 嵌套 tool：`TOOL_CALL_END(p/n) → TOOL_CALL_END(p) → TEXT_MESSAGE_END(m-1) → STEP_FINISHED` ✅。
  3. 多 step：`STEP_FINISHED(turn-2) → STEP_FINISHED(turn-1)` ✅。
  4. 自然结束（step/message/tool 都自然 end，success）：每类 END 恰好 1 次，无重复关闭 ✅。
  5. success 但仍有 open entity（tool/message/step 未自然 end）：`finish()` 按 LIFO 关闭一次后 `RUN_FINISHED` ✅。
- 原有成功/取消/错误/RUN_ERROR 测试仍绿；新增的 nested/multi-step 测试通过。

## 3. point.ui 加固复核：仍有 blocker

- 已修复项（独立探针）：控制字符 `\u0000`、换行/制表；`java\tscript:`/`java script:` 归一化后拒绝；`data:`/`vbscript:`；`onerror=`；`alert(`/`eval(`/`function(`/`fetch(`；JSON `{"__proto__":...}`、`constructor`、`prototype` key 均拒绝；合法 `{title:"plain text"}` 接受。实现见 `ui.ts:20-47`（CONTROL_CHARS/RAW_MARKUP/FORBIDDEN_SCHEME/ATTRIBUTE_INJECTION/CODE_HINT/归一化/严格 PROP_KEY_PATTERN）。
- **未修复**：`document.cookie`、`window.location` 被接受（探针 `ACCEPTED`）。`ui.ts:24` 的 `CODE_HINT` 只匹配 `document(`/`window(`（要求紧跟 `(`），不匹配 DOM 点引用；任务明确要求拒绝 `document.`/`window.`。
- 影响：当前 `point.ui.*` **无发射路径、无渲染器、无 Durable UI 状态**（`pointUiEvent` 仅测试使用），所以还不是现存执行面；但该 validator 是冻结的契约入口，未达到“拒绝 JS/DOM”要求。修复：在归一化后增加 `/\b(?:document|window)\s*\./i`（或更严格 allowlist），补 `document.cookie`/`window.location` 拒绝测试；仍应保持合法占位接受。
- 未被此 gap 影响的部分：无 UI 状态持久化/渲染器（代码无写入路径），已确认。

## 4. cli.ts boundary lane：通过

- `scripts/check-boundaries.mjs:15` 新增 `rootLanes`；`:28-31` 对 `lane === 'cli.ts'` 要求所有 import 以 `node:` 开头，否则报错；其它 lane 规则未变。
- 独立探针（正确 lane 路径）：
  - `cli.ts` + `node:crypto` → `[]`；
  - `cli.ts` + `./runtime/open.js` → `cli.ts may only import node builtins`；
  - `cli.ts` + `@earendil-works/pi-durable` → 同上拒绝；
  - `cli.ts` + `@ag-ui/core` → forbidden dependency + node-only 双重拒绝；
  - `runtime/x.ts` 导入 `../api/agui/events.js` → `runtime cannot import api`（未放宽）；
  - `api/x.ts` 导入 SDK → `SDK belongs in runtime/storage`（未放宽）；
  - `domain/x.ts` 导入 SDK → `domain must be platform independent`（未放宽）；
  - 未注册 lane 仍报错。
- 新增 `scripts/boundaries.test.mjs` CLI lane 测试；11/11 scripts 测试通过。结论：显式 lane 且只允许 node: 内置，未削弱其它 lane。

## 5. 传输级失败 vs SSE 边界：文档与行为一致（通过）

- 文档已同步：`apps/server/README.md` 新增“传输级失败不开 SSE”段；`openspec/.../design.md` 同一句；`spec.md` 新增 Requirement（auth/content/body/idempotency/agent/未知路径方法 → WP4 JSON 信封；只有受理后才 SSE，首帧 RUN_STARTED/RUN_ERROR）。
- 行为探针（真实 `createHttp`）：
  - 缺 Idempotency-Key → 400 `application/json`，无 SSE；
  - 非法 JSON → 400 JSON；
  - 无 auth → 401 JSON；
  - GET → 405 JSON + Allow；
  - agent 未配置 → 503 JSON；
  - 传输通过但 `messages: []` → **200 text/event-stream，首帧 RUN_ERROR(code INVALID_COMMAND)**。
- 与 spec/README/design 一致。

## 6. 其它非阻塞/未验证

- **end 事件幂等性**：`message_end`/`tool_end`/`step_end` 在实体不在栈中时仍会写对应 END/FINISHED（旧行为保留）；自然结束后 finish 不会重复关闭（探针已证），但重复 end 事件可能产生重复 END。SDK 正常不会重复；建议后续做“仅当存在才关闭”或测试重复 end。
- **run 隔离**：并发同一 chat 的独立探针（上一轮）通过；follow-up run/多客户端隔离仍未测，README 已列未验证。
- **背压/断线/EPIPE**：writeFrame 有 drain/close 处理，但无慢消费者/半开/EPIPE 测试；`response` 未装 `error` 监听。
- **真实 provider/SSE 代理**：真实逐 token/网络断线/反代缓冲仍未验证（README 已列）。
- **point.ui 未来启用**：修复 §3 的 `document.`/`window.` 后，才建议在后续片发 CUSTOM UI；当前无持久化/渲染器。

## 7. 结论

- **B1（LIFO）已真修复**：单一栈、严格逆序，旧探针/嵌套/多 step/自然结束/成功残留全部通过；无新增回归（agui 13/13、全量 305/305、scripts 11/11、boundaries/tsc 绿）。
- **仍有 1 blocker**：`point.ui` 校验未拒绝 `document.`/`window.`（`ui.ts:24` CODE_HINT 只匹配函数调用；探针 `document.cookie`/`window.location` 被接受）。当前无发射/渲染路径，但未达到任务要求的加固口径；修复该正则 + 测试后，WP5 审计可改判**通过**。
- cli.ts boundary lane、传输级失败文档/行为均已通过；其余非阻塞项见 §6。
