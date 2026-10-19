# WP5 AG-UI 投影独立代码审计

> 2026-10-19。对象：worktree `/Users/lixinlv/Projects/Doing/point-wp5`，分支 `wp/5-agui-projection`，commit `44c657c`（基线 main `3f0ae3d`）。
> 评审人：code-auditor。范围：只读代码/测试审计；仅写本文件，未改源码/测试。
> 结论：**需修改（1 个 blocker）**；其余为契约澄清/测试补强/非阻塞发现。

## 1. 验证

| 项目 | 结果 |
|---|---|
| `npx tsc -p apps/server/tsconfig.json --outDir /tmp/point-wp5` | BUILD_OK |
| `node --test agui.test.js` | **11/11 pass** |
| 服务端全量隔离构建 | **303/303 pass** |
| `scripts/*.test.mjs` | 10/10 pass |
| `tsc --noEmit` / `check-boundaries.mjs` | exit 0 / passed |
| worktree | 审计期间 clean；未改源码/测试 |

独立探针：
- **并发同一 chat 两个 `/v1/agent` run**（真实 runtime + faux provider）：A 只收到“回答A”、B 只收到“回答B”，各自 `RUN_STARTED` runId 不同、无串流（通过；更广的多客户端/follow-up 见 §5）。
- **取消时实体关闭顺序**：`step_start → message_start → tool_start → run_end(cancelled)` 的实际帧序为 `TOOL_CALL_END`、`STEP_FINISHED`、`TEXT_MESSAGE_END`，不是 LIFO（blocker B1）。
- **check-boundaries 放行范围**：`cli.ts` lane 仅该文件名被放行；`runtime` 导入 `api` 仍报错、未注册的 `service.ts` 仍报错（见 §4.5）。
- **point.ui 校验绕过**：`onerror=alert(1)`、`java\nscript:alert(1)`、`alert(1)` 被接受（无事件发射路径，见 §4.1）。

## 2. Blocker

### B1（流契约/LIFO）取消或错误关闭实体时不是 LIFO

- 代码：`api/agui/projection.ts:86-99` `closeEntities()` 按**类型分组**关闭：先所有 tool（Set 反序）、再所有 step（数组反序）、最后 message。它**不是全局后开先关**。
- 探针（隔离 build）：fake `AgentRunPort` 依次发 `step_start(turn-1)`、`message_start(m-1)`、`tool_start(c-1)`，再 `run_end(cancelled)`；SSE 帧序：
  `RUN_STARTED, STEP_STARTED, TEXT_MESSAGE_START, TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END, STEP_FINISHED, TEXT_MESSAGE_END, RUN_FINISHED`
  → 关闭顺序为 tool → step → message；创建顺序是 step → message → tool，严格 LIFO 应为 tool → message → step。
- 影响：取消/`RUN_ERROR` 时先 `STEP_FINISHED` 再 `TEXT_MESSAGE_END`，而 message 属于该 step；违反任务/契约的“实体关闭顺序（LIFO）”，客户端按嵌套语义消费时可能出现 step 已结束但消息仍在关闭的非法序列。`finish()`/`error()` 都复用该函数（`:100-102`、`:118-120`）。
- 测试未捕获：`agui.test.ts:254-272` 只断言 `TOOL_CALL_END`/`TEXT_MESSAGE_END`/`STEP_FINISHED` 都在 `RUN_FINISHED` 之前，**没有断言它们之间的顺序**。
- 修复：用一个真正的 open-entity 栈（记录各实体的创建顺序），`closeEntities` 逆序弹出并写对应 END/FINISHED；补断言：创建 step→message→tool 时关闭顺序必须是 `TOOL_CALL_END` < `TEXT_MESSAGE_END` < `STEP_FINISHED`（并可补多 step/tool 嵌套）。修复后 `finish`/`error`/取消三条路径复用同一逻辑。

## 3. 审计重点逐条（除 B1 外）

### 3.1 分层

- AG-UI wire 类型/序列化只在 `api/agui/**`（events/projection/route/ui）。`application/agent-stream.ts` 是纯中性类型，**零 import**；`runtime/agui.ts` 只 import `@earendil-works/pi-durable` 公开 API（`watchEvents`/`UsageDoc`/`Harness`/`SubmissionId`）、`application/conversation` 类型和 `application/resource.canonicalJson`；未出现 AG-UI 类型。
- `grep` 确认 `@ag-ui`/AG-UI 类型只在 `api/agui/**`；`application/domain` 无 SDK import（隔离 build 与 boundary check 绿）。
- `api/routes.ts` 只在类型层面 import `AgentRunPort`；`api/http.ts` 仅把 stream 分支交给 route，不感知 AG-UI 事件。
- `point.ui.*` 在 `api/agui/ui.ts`，runtime/application 不引用；无渲染器、无 UI 状态持久化。

### 3.2 check-boundaries 的一行改动

- 改动仅 `scripts/check-boundaries.mjs:19`：未注册 lane 例外列表加入 `'cli.ts'`；`lane` 是 `apps/server/src` 相对路径首段，所以**只有 `apps/server/src/cli.ts`** 命中；其它 lane（domain/application/api/runtime/adapters/storage）与未注册文件行为不变。
- 探针：`runtime/x.ts` 导入 `api/agui/events.js` → `runtime cannot import api`；`service.ts` → `unregistered`；`cli.ts` 导入 `@ag-ui/core` → `forbidden dependency`；`cli.ts` 导入 `@earendil-works/pi-durable` → 放行（因 lane 未注册时 `if (!allowed[lane]) return;` 跳过相对/SDK 检查）。
- 结论：**没有放宽其它 lane**；但该豁免让 `cli.ts` 完全跳过 lane import 检查（当前 cli 只用 node 内置 + fetch，无 SDK/AG-UI import）。建议后续把 CLI 显式建模（如 `allowed.cli = ['application']` 或 node-only），而不是把整文件标为未注册。

### 3.3 流契约（首尾/截断/取消/背压/泄漏）

- 首帧：route 在 `streamHeaders` 后先 `projection.started()`；空/坏输入直接 `RUN_ERROR` 作为首帧（`route.ts:104-112`；测试 `agui.test.ts:278-295` 断言唯一事件 RUN_ERROR）。正常流首帧 RUN_STARTED（`:139-168`）。
- 正常结束：`run_end` → `projection.finish` 先关闭实体再 `RUN_FINISHED`（`projection.ts:100-116`；测试首尾 + usage）。
- 取消：runtime `run_end(cancelled)` → closeEntities → `RUN_FINISHED(outcome=cancelled)`；真实 runtime stop 测试 `:393-418` 通过；但关闭顺序见 B1。
- **截断不伪造完成**：route 在 request/response `close` 时 abort；writeFrame 对 destroyed/writableEnded 抛 `CLIENT_CLOSED`；catch 在 aborted 时**不发 RUN_ERROR/RUN_FINISHED**；测试 `:190-226` 断言无 RUN_FINISHED、无实体 END。服务端关闭路径也通过 finally 结束而不补 FINISHED。
- 背压：`writeFrame` 在 `response.write` 返回 false 时等待 `drain`，同时监听 `close` 拒绝（`route.ts:73-88`）；无显式慢消费者测试。
- 未处理 rejection/泄漏：route 吞掉 `writeFrame`/`projection.error`/`run.cancel` 的失败；`watchEvents` 流在 finally `stop()`；`settle` 超时 timer `unref`。没有显式 `response.on('error')` 处理器，半开/EPIPE 场景仍建议补测试（见 §4.4）。
- SSE 帧：每块恰好一个 `data:` JSON；测试 parser 逐块断言一条 `data` 行（`agui.test.ts:76-100`）。

### 3.4 run 隔离

- runtime 先 `watchEvents(conversationId)` 再 `conversation.send`；submission requestId 在 `runtime/conversation.ts:59` 固定为 `point-command:${task.id}`，`runtime/agui.ts:115` 用 `point-command:${command.commandId}` 做 marker；`submission` 记录/`run_start.inputs` 同时匹配 marker/submissionId 才 `activeRun=true`；`run_end` 同 submissionId 才结束。
- 独立探针（真实 runtime + faux，两个并发 POST 同一 chat）各自只收到自己的文本/runId，未串流（见 §1）。
- 风险/未覆盖：`message_start/message_update/message_end` 本身不带 run id，隔离依赖“同一 conversation 内 run 顺序执行 + activeRun 标志”；并发 follow-up run（同一 conversation 在前台 run 进行中被插入）没有测试；README 也明确列出“多客户端并发 run 隔离未验证”（`apps/server/README.md:273`）。属测试/文档风险，不是已复现缺陷。

### 3.5 usage 口径

- README `:251-253` 明确“派生自会话 `UsageState` 账本差分、按 model/tool bucket 聚合、不保证 provider 精确账单、不含 cost/retry/compaction 归属可能与账单不同”；design/spec 同样。`AgentUsage` 注释也指向 README。**未把差分说成 provider 账单**，通过。
- 实现：baseline = attach 时 `stream.snapshot.usage`，结束后 `harness.snapshot(UsageDoc)` 差分，负数钳 0；真实 runtime 测试断言 `totalTokens>0`。属近似口径，文档诚实。

### 3.6 point.ui.* 校验

- 组件白名单 `point.placeholder`、props ≤2048B、深度 ≤4、key/数组 ≤32、字符串 ≤512、禁止 `<>`/`javascript:`/`data:`、artifactId 受限标识符；**不持久化、不渲染、本片不发 UI 事件**（`pointUiEvent` 仅在测试中使用）。
- 但 `FORBIDDEN` 只覆盖字面 `<>`/`javascript:`/`data:`；探针显示 `onerror=alert(1)`、`java\nscript:alert(1)`、`alert(1)` 被接受。由于当前无发射路径/无渲染器，不构成现存执行面；见 §4.1（非阻塞，未来发事件前必须收紧）。

### 3.7 秘密

- `RUN_ERROR`：`errorEvent` 用 `mapError`；500 固定 `internal error`，非 500 用稳定 code/message，不拼接原异常。测试用 `boom at /Users/secret token=abc` 断言 RUN_ERROR message=`internal error` 且帧 JSON 不含路径/secret/boom（`agui.test.ts:227-252`）。
- 访问日志复用 WP4 白名单；流式请求多一条 `http.stream_open`，字段仍仅 requestId/method/path/status/duration/bytesIn；测试断言 token 不出现（`:297-317`）。
- CLI：`RUN_ERROR` 打印 code/message（服务端已脱敏）；catch 不打印 stack，只对全大写 code 原样输出（`cli.ts:150-153`）。

### 3.8 无第二事实/无新依赖

- runtime 仅 `watchEvents`/`snapshot`/`conversation.send`（已有事实），未把 run/stream 状态写入 Durable；`point.event` 时间线不被 AG-UI 修改；`point.ui` 无持久化。
- `apps/server/package.json` 仅新增 `scripts.cli`；未新增依赖（lock 无 diff）；无第二执行引擎。

### 3.9 lifecycle 404→405

- `POST /v1/agent` 加入路由表后，`GET /v1/agent` 由 404 变 405+`Allow: POST` 是路由表的正确结果；测试同时保留 `/v1/unknown`→404（`lifecycle.test.ts:73-79`），未削弱未知路径契约。

## 4. 非阻塞项

1. **`point.ui` 校验仍可被 JS 字符串绕过**（`ui.ts:17,34`）：`onerror=alert(1)`/`alert(1)`/`java\nscript:` 被接受。当前无 `point.ui` 发射路径/渲染器，故非现存执行面；一旦未来发 CUSTOM UI，必须改为 allowlist/结构化 schema 或更强拒绝（`on\w+=`、`srcdoc`、`expression(` 等），并补测试。
2. **传输级失败不是 SSE**：`route.ts:99-102` 在 `streamHeaders` 前读 Idempotency-Key/body，并检查 agent；这些失败返回 WP4 JSON 信封（400/413/503），只有通过 transport 的输入错误才走 SSE `RUN_ERROR`。spec 字面“POST /v1/agent MUST return text/event-stream，首帧 RUN_STARTED/RUN_ERROR”应对“已受理请求”限定；README/测试已按 JSON 预检设计。建议在 spec/README 明确边界，避免契约歧义。
3. **run 隔离覆盖有限**（§3.4）：并发同 chat 探针通过；follow-up run、不同 chat 的并发、真实 provider 下的多客户端隔离未测，README 已列未验证。建议补 follow-up/多客户端回归。
4. **背压/断线/泄漏无显式测试**：writeFrame 有 drain/close 处理，route 有 close/abort/finally，但没有慢消费者、半开连接、EPIPE（`response.on('error')` 未安装）测试；建议补。
5. **check-boundaries 豁免**（§3.2）：只放行 `cli.ts` lane，未放宽其它 lane；但该 lane 的 import 检查被整体跳过（SDK import 放行，仅 AG-UI/second engine 仍禁）。当前 cli 只用 node 内置，建议后续显式建模 CLI lane。
6. **LIFO 相关测试缺失**：取消测试只断言顺序在 RUN_FINISHED 之前（B1 修复时补严格顺序断言）。
7. **`RUN_ERROR` 前 `RUN_STARTED` 的语义**：route 在 `agent.start` 失败时先 `streamHeaders` 再写 RUN_ERROR（首帧 RUN_ERROR，无 RUN_STARTED），符合“首帧 RUN_STARTED 或 RUN_ERROR”；测试覆盖。无需改。
8. **`runId` 客户端值忽略**：符合 design，测试断言；`threadId` 非数字会以 `CHAT_NOT_FOUND` 的 RUN_ERROR 返回（经 agent.start 校验），不是 parse 阶段 INVALID_COMMAND；spec 只要求首帧 RUN_ERROR，可接受，建议测试补非数字 threadId。
9. **CLI 打印 tool result 原文**：参考客户端行为，非服务端日志；tool result 由 runtime 截断 8KiB，仍可能含业务敏感内容；CLI 属开发工具，非阻塞。

## 5. 未验证 / 边界（需在 WP5 gate 文档保留）

- 真实 provider 的逐 token 流/tool args 分片（SDK 不提供原始 JSON 分片，投影只发一次完整 canonical JSON）；真实网络断线/重连、SSE 反向代理/缓冲、背压仅在本地 Node 验证。
- 多客户端并发 run 隔离、follow-up run 插入、`Last-Event-ID`/快照恢复、interrupt/resume（WP6/WP7）。
- usage 与 provider 账单对账未验证（文档已明确近似）。
- `point.ui` 仅占位契约，无渲染器；当前无事件发射，未来片启用前需收紧校验（§4.1）。
- 参考 CLI 只证明协议可消费，不替代原型 CLI。

## 6. 结论

**需修改（B1 blocker）。** 分层、SSE 首尾/截断/取消边界、run 隔离基本机制、usage 诚实性、秘密脱敏、无第二事实/新依赖、check-boundaries 放行范围（仅 cli.ts）与 lifecycle 404→405 均符合预期；但取消/错误路径的实体关闭顺序不是 LIFO（探针可复现），且现有测试未断言该顺序。修复 B1（统一 open-entity 栈 + 严格顺序测试）后，本审计可改判通过；§4 非阻塞项建议在 gate 文档/后续补测中处理。
