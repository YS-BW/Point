# Design

## Context

依据 [AG-UI 评估](../../../docs/design/protocol-agui.md)：采用 AG-UI 1.0 作为**边缘投影协议**，内部事件模型不变（`point.event` 时间线 + Durable 提交序列是事实，AG-UI 只是视图）。WP4 已提供 `/v1`、鉴权、错误信封、访问日志与 requestId；WP3 已提供 `point.event` 时间线与 commit 序列。本片只做**前台一次运行**的流式投影；读模型/增量/线程流属于 WP6。

## Goals / Non-Goals

**Goals:**

- 冻结 `POST /v1/agent` 的输入/输出形状与事件顺序，使 WP6 可以直接在其上补 snapshot/增量。
- 让"停止"和"失败"都有标准化表达（cancelled / RUN_ERROR），不靠断流。
- 保证 UI 相关扩展只走 `CUSTOM`，且只传声明式引用与有界参数。

**Non-Goals:**

- 线程流、同步 run、`Last-Event-ID` 补发、`STATE_SNAPSHOT/DELTA`、`MESSAGES_SNAPSHOT`、`ACTIVITY`、运行流（WP6）。
- interrupt/resume 人工确认（WP7）。
- 引入 CopilotKit 或任何前端运行时；不允许模型产出的 HTML/JS 进入事件或 Durable。
- 多 run 并发塞进同一条流（AG-UI 要求同一流内 run 顺序）。

## Decisions

1. **一个 run 一条流。** `POST /v1/agent` 每次调用打开一个新的前台 run（`threadId` 由输入给出或服务端分配，`runId` 服务端生成），run 结束即关流；后台任务并发不塞入该流（WP6 用 ACTIVITY/CUSTOM + 独立运行流表达）。
2. **首尾强制边界。** 第一帧必须是 `RUN_STARTED` 或 `RUN_ERROR`；正常结束必须 `RUN_FINISHED` 且带 `outcome`；取消走 `outcome: cancelled`（先 `TEXT_MESSAGE_END`/`STEP_FINISHED` 关闭已开实体）；内部异常走 `RUN_ERROR`（固定 message，不泄漏栈/路径/凭据）。**客户端断开或服务端关闭导致的截断流不补 RUN_FINISHED**，让客户端能区分"完成"与"断了"。
3. **容忍未知，拒绝坏值。** 不认识的事件类型/字段按规范忽略或剥离；已知字段类型/取值错误必须返回 `RUN_ERROR` 并结束流（fail-closed）。
4. **SSE 帧格式固定。** `data: <one JSON event>\n\n`，每帧一个事件；不使用 `event:` 语义；允许附带 `id: <seq>` 供 WP6 的重放使用（消费端忽略也不违反规范）。连接使用 `Cache-Control: no-store`、`Content-Type: text/event-stream`。
5. **鉴权与访问日志复用 WP4。** `/v1/agent` 与 `/v1/*` 同一 Bearer、同一 fail-closed 503、同一访问日志白名单（不记录 body/Authorization）；流式请求只记录开始与结束状态，不记录 token 增量。
6. **`point.ui.*` 只占位。** 定义命名空间、允许的 payload 形状（组件名 + 有界 props + 可选 artifact 引用）与白名单要求；**不实现**渲染。禁止在事件或 Durable 中存放 HTML/JS/任意 DOM；组件名必须由客户端预先注册，服务端不解释渲染语义。
7. **参考 CLI 是第一个消费者。** `apps/server/src/cli.ts` 订阅 `POST /v1/agent` 并把事件打印为文本（含工具调用/阶段摘要），用于证明协议可消费；不覆盖原型 CLI，不引入交互式 UI 框架。
8. **不新增依赖。** SSE 用 Node 内置 `http`/`fetch`，事件序列化复用 WP4 的稳定序列化。

## Risks / Trade-offs

- [Risk] AG-UI 规范仍在演进（31 事件且仍在加）→ 锁定 `protocolVersion: "1.0"`，未知事件容忍，契约测试用冻结样例。
- [Risk] SDK 是否能提供文本增量/工具调用级事件不确定 → 第一步先核查 SDK 公开能力；无法提供的族先不投影（例如只发 `TEXT_MESSAGE_CONTENT` 整段），并在 spec 中写明"按实际能力裁剪"，不伪造事件。
- [Risk] 流式与现有 `conversation.status` 轮询语义重复 → 明确流是投影、事实仍在 Durable；取消流不取消运行（取消要用既有 `stop` 命令）。
- [Risk] 生成式 UI 被误解为本片能力 → 文档明确 `point.ui.*` 只是占位契约，CopilotKit 运行时与任意 UI 生成不在本片。
- [Risk] 客户端断开造成半开连接 → 显式监听 `close`，停止投影并按截断处理（不写 FINISHED）。

## 1.1 SDK 能力核查结论（2026-10-19，锁定 `@earendil-works/pi-durable@1.3.0`）

核查对象：pi-durable 公开 `index.d.ts`（`watchEvents` / `AgentEvent` / `Harness` / `UsageDoc` / `TaskGraphView`）与 chord 公开 Context 能力；只使用公开 API，不触碰 storage/Session 内部。

### 可用的公开数据源

- `watchEvents(harness, conversationId, context) -> AgentEventStream`：**原子**返回 attach 时的 `snapshot`，随后按 commit 批次推送 `AgentEvent[]`；溢出时用新的 snapshot 替换未投递批次（消费端按幂等处理）。这是唯一公开的"提交订阅/流式"入口。
- `AgentEvent` 实际事件族：
  - 运行/回合：`run_start{inputs}`、`run_end{inputs}`、`turn_start`、`turn_end`；
  - 消息：`message_start{message}`、`message_update{usage, changes}`（`MessageChange`: `text_start`、`text_delta{delta}`、`thinking_start/delta`、`toolcall_start`、`toolcall_delta{path,delta}`、`block`、`message`）、`message_end{entry}`、`entry_appended`；
  - 工具：`tool_execution_start{args,toolCallId,toolName,taskId?,parentToolCallId?,parentTaskId?}`、`tool_execution_update{output(trim/append|set),details?,diagnostics?}`、`tool_execution_end{entry?|result?}`；
  - 其他：`usage_changed{usage}`、`submission{record}`（含 `requestId`，状态 `queued/placed/done/unanswered`）、`snapshot`、`agent_changed`、`inbox_update`、`auto_retry_*`、`deferred_poll`、`compaction_start/end`、`task_failed`。
- `Harness`：`conversation(id)`、`submission(id)`、`getTask`、`inspect`、`usage(context): UsageState`（Session 级累计）、`taskGraph`/`watchTaskGraph`（live task `status+phase`，durable commit 推进）。
- 运行身份关联：现有 `conversation.send` 命令把用户输入以 `requestId = point-command:<commandId>` 提交（`runtime/conversation.ts`），因此 `submission.requestId` 能把本流与 `send` 返回的 `commandId` 精确对应；`run_start.inputs` 含该 submission id 即可确认"这是本次 run"。

### 真实可投影的 AG-UI 1.0 事件族

| AG-UI 事件 | 数据源（真实） | 结论 |
|---|---|---|
| `RUN_STARTED` | `send` 命令受理成功（拿到 commandId）；后续 `run_start.inputs` 显示本 submission 真正开始 | 可投影；在受理成功后立即发，流内只投影本 submission 的 run |
| `TEXT_MESSAGE_START/CONTENT/END` | `message_start` + `message_update.text_start/text_delta` + `message_end.entry`；仅 assistant 文本块 | **逐 token 增量可投影**（真实 delta，不是整段伪造） |
| `TOOL_CALL_START` | `tool_execution_start`（toolCallId/toolName/args 已确定） | 可投影；`ARGS` 使用**一次完整 canonical JSON** 作为单个 delta（SDK 的 `toolcall_delta` 是 `path+delta` 结构，非原始 JSON 文本；不合成假的 token 分片） |
| `TOOL_CALL_END` / `TOOL_CALL_RESULT` | `tool_execution_end` 的 `entry`（模型调用）或 `result`（嵌套调用）；结果文本从 entry/result 派生并做上限截断 | 可投影；嵌套调用带 `parentToolCallId` |
| `STEP_STARTED/STEP_FINISHED` | `turn_start`/`turn_end` | 可投影；stepName 用真实回合序号（`turn-N`），不映射不存在的业务阶段 |
| `RUN_FINISHED(outcome, usage)` | `run_end` + `submission.record` 结算（`done` vs `unanswered` 的 reason）+ 既有 `conversation.status(commandId)` 分类；usage = attach 时 `snapshot.usage` 到最后 `usage_changed` 的**会话 UsageState 差分**（按 model/tool bucket 汇总成 token 数） | 可投影；outcome=`success/cancelled`，失败走 `RUN_ERROR`；usage 是本次 run 的账本差分（非 provider 单次原始响应，注释写明派生口径） |
| `RUN_ERROR` | 受理/校验失败、`MODEL_NOT_CONFIGURED`、`CHAT_NOT_FOUND`、运行失败、已知字段坏值 | 可投影；固定 message + 既有稳定 code，不含栈/路径/凭据 |

### 明确**不投影**（能力不足或本片范围外，宁可不发也不伪造）

- `REASONING_*`：SDK 有 `thinking_*`，但本片协议目标只覆盖文本/工具/阶段/usage，且 thinking 的可见性策略未定（留给后续片）。
- `TOOL_CALL_ARGS` 的**逐 token 分片**：公开 delta 是结构化 `path+delta`，不是 provider 原始 JSON 文本；只发一次完整 args，避免伪造分片。
- `STATE_*`、`MESSAGES_SNAPSHOT`、`ACTIVITY_*`、`SUBAGENT_*`、`RAW`：WP6（读模型/线程流/后台运行流）范围，本片不发。
- `Last-Event-ID` 重放、interrupt/resume：WP6/WP7；截断流按契约不补 `RUN_FINISHED`。
- 后台任务进度（`taskGraph` 的 `phase`）不塞进前台 run 的 AG-UI 流（AG-UI 一流通多 run 必须顺序；后台进度属 WP6 `ACTIVITY`/运行流）。
- `point.ui.*` CUSTOM：本片只冻结命名空间/校验契约（组件名、有界 props、可选 artifact 引用；拒绝 HTML/JS/DOM），**不生成**任何 UI 事件。

### 架构后果（需 Lead 确认写范围）

`watchEvents`/`Harness` 属于 `@earendil-works/pi-durable`，按 `scripts/check-boundaries.mjs` 只能从 **runtime** lane import（api/application 禁止 SDK）。因此投影不能直接写在 `api/**`：需要 runtime 侧新增一个**中性事件端口**（不复用 AG-UI 类型，保持"内部模型不依赖 AG-UI"），由组合根注入 HTTP：

- 新增 `apps/server/src/runtime/agui.ts`：消费 `watchEvents`，输出中性的 run 事件（message/text/tool/step/end+usage），把 SDK 的 commit 批次语义收敛为"一次 run 的流"；
- `runtime/open.ts`：`Runtime` 增加该端口（如 `agent`），复用既有 `conversation.send`/`chat` 读模型与 `Harness.usage`；
- `bootstrap.ts`：把 `runtime.agent` 注入 `createHttp`（与现有 `commands` 注入同一模式）。

这三处超出 task-53 当前 writeScopes（仅 `api/**`、`cli.ts`、`apps/server/package.json`、`test/**`、`openspec/**`、`README.md`），按团队"跨 lane 先升级"规则**先报告 Lead 请求扩 scope**，获批后再实现。替代方案（把 SDK import 放进 api）违反 `AGENTS.md` 硬规则 #1/#9 与边界检查，不采用。

## 1.2 冻结的 `POST /v1/agent` 契约（2026-10-19）

### 身份与鉴权

- `threadId`：客户端提供的已存在数字 chat id（一个 chat = 一个 thread）；runId 由服务端 `randomUUID` 生成，客户端 `runId` 忽略（AG-UI 客户端可用服务端返回值对账）。
- 复用 WP4：`Authorization: Bearer`、无 token 时 `/v1` fail-closed 503、`Idempotency-Key`（8..128）映射既有 `conversation.send` 的 `requestId`、`Content-Type: application/json`、1 MiB 上限、访问日志白名单（流式请求额外一条 `http.stream_open` 入口记录，退出记录仍是一条 `http.access`）。
- 输入是 AG-UI `RunAgentInput` 子集：`threadId` + `messages`（取最后一条 user 文本）；`runId` 可选 string；`tools`/`context`/`state`/`forwardedProps` 与其它未知字段容忍但忽略，不改变服务端权威状态。已知字段坏值 → SSE `RUN_ERROR`（`INVALID_COMMAND`），不启动 run。

### SSE 与生命周期

- 帧：`data: <一个 JSON 事件>\n\n`，每个块恰好一个事件；无 `event:` 语义、无多事件帧；本片不发 `id:`（WP6 再用于重放）。
- 首帧：`RUN_STARTED` 或 `RUN_ERROR`；正常结束：`RUN_FINISHED`（`outcome: success|cancelled` + `usage`）；流内失败：`RUN_ERROR`（固定 message，不泄漏栈/路径/凭据）。
- `protocolVersion: "1.0"` 随 `RUN_STARTED`/`RUN_FINISHED` 提供。
- 截断（client `close`/服务端关闭）：**不发** `RUN_FINISHED`，不补实体关闭。
- 取消（既有 `POST /v1/chats/:id/stop` 生效）：先关闭已开实体（`TEXT_MESSAGE_END`/`STEP_FINISHED`/`TOOL_CALL_END`），再发 `RUN_FINISHED` `outcome:"cancelled"`；停止命令本身语义不变。
- 投影事件族与来源、以及"不投影清单"见 1.1 与 README（`REASONING_*`、逐 token tool args、STATE/MESSAGES/ACTIVITY/SUBAGENT/RAW、Last-Event-ID、interrupt/resume、后台 taskGraph 进度均不发）。

### usage 派生口径

`usage = {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}`，由 run 起止的**会话 `UsageState` 账本差分**按 model/tool bucket 汇总。**派生、按 bucket 聚合，不保证 provider 精确账单**（不拆单次调用、无 cost、retry/compaction 归属可能与账单不同）；列入未验证项。

### `point.ui.*` CUSTOM（契约占位，无渲染）

- name 固定 `point.ui.component`；value `{component, props?, artifactId?}`。
- 组件名须匹配格式并命中白名单（WP5 仅登记占位 `point.placeholder`，且服务端不主动发事件）。
- 有界：props ≤2048 字节、深度 ≤4、key/数组 ≤32、字符串 ≤512、JSON-safe；禁止 `<>`/`javascript:`/`data:`/任意 HTML/JS/DOM；artifactId 受限标识符。
- 服务端不解释渲染、不落 Durable UI 状态、不生成 UI 代码；无前端运行时依赖。

### 参考 CLI

`apps/server/src/cli.ts` + `npm run cli -w @point/server`：创建/复用 chat、消费 SSE、打印 run/step/tool/文本与 `[done] outcome/usage`；`RUN_ERROR` 非零退出。不替换原型 CLI。

## Migration Plan

纯新增端点：不改变 `/v1` 既有路由与数据；回滚即移除 `/v1/agent` 路由或让参考 CLI 退回轮询（`GET /v1/commands/:id`）。无持久状态迁移。

## Open Questions

- 无未决事件粒度问题：1.1 已核查（见上），文本增量/工具调用/回合边界/usage 均可真实投影；参数流按"单次完整 args"投影，不伪造分片。
- 实现前待确认：runtime 中性事件端口的写范围（`runtime/agui.ts`、`runtime/open.ts`、`bootstrap.ts`），见"架构后果"；未获批前不实现投影。
