# AG-UI 作为客户端协议：可行性评估

> 2026-10-19。评估对象：AG-UI 1.0（Agent–User Interaction Protocol）。
> 结论：**可行，建议采用，但只用在"边缘投影层"**——内部事件模型不变，AG-UI 是客户端看到的协议。
> 依据：规范 [transports](https://docs.ag-ui.com/spec/1.0/basic/transports)、[HTTP+SSE](https://docs.ag-ui.com/spec/1.0/basic/transports/http-sse)、[lifecycle](https://docs.ag-ui.com/spec/1.0/events/lifecycle)、[state](https://docs.ag-ui.com/spec/1.0/events/state)、[activity](https://docs.ag-ui.com/spec/1.0/events/activity)、[subagents](https://docs.ag-ui.com/spec/1.0/events/subagents)、[interrupt-resume](https://docs.ag-ui.com/spec/1.0/basic/patterns/interrupt-resume)、[processing](https://docs.ag-ui.com/spec/1.0/basic/processing)。

## 当前实现校正（WP5，用户已确认）

官方类型/校验与编码复用 `@ag-ui/core`（含 `/schemas`）和 `@ag-ui/encoder`；客户端复用 `@ag-ui/client`，精确版本见 package/lock。只保留 Point 到协议的转换、鉴权/幂等和服务端权威视图策略；不引入第二执行引擎或 CopilotKit Agent 运行时。

`outcome` 是对象 `{type: "success" | "cancelled"}`；标准 `usage` 是按 provider/model 分组的数组，当前无法可靠归属，省略。此前汇总对象的验证不能当作官方兼容证据。`protocolVersion` 由 RUN_STARTED 声明。验收数字及纠偏结果以 [验证状态](verification-status.md) 为准。

WP5 已加入结束时可见文本 `MESSAGES_SNAPSHOT`：官方 SDK 默认合并保留客户端消息，Point 消费者通过 `onMessagesSnapshotEvent` 返回 `{messages: event.messages, stopPropagation: true}` 应用服务端权威视图，移除临时草稿。全量工具历史、断线订阅与增量游标仍属于 WP6。观察流 ID 不等于 Durable command 身份；重试复用请求幂等键，不再次执行。

## 一、规范要点（核实过的事实）

| 项 | AG-UI 1.0 的规定 | 对 Point 的含义 |
|---|---|---|
| 传输 | 标准绑定：`POST RunAgentInput` → `text/event-stream`，每个 SSE `data` 恰好一个 JSON 事件；LF 结尾；忽略 `event:`/`id:`/`retry:` | 我们自己的 SSE 帧可以保留 `id:` 做重放（消费端会忽略，不冲突） |
| 断线 | **HTTP+SSE 绑定明确无恢复**：不用 `Last-Event-ID`，断流只能换新 `runId` 重开 | 长时间后台工作 + 手机断网，必须有自定义传输（规范允许） |
| 事件族 | 8 族 31 种：run/step、text、tool call、reasoning、state（`STATE_SNAPSHOT`/`STATE_DELTA`/`MESSAGES_SNAPSHOT`）、activity、subagent、passthrough（`RAW`/`CUSTOM`） | 覆盖对话流、工具、进度、共享状态、后台子任务、扩展事件 |
| 状态 | `STATE_SNAPSHOT` 整体替换；`STATE_DELTA` 为 RFC 6902 JSON Patch；`MESSAGES_SNAPSHOT` 按 id 幂等对账；Point 须显式配置权威替换策略 | 正好对应"快照 + 增量"，可替代现在的"每次推全量 snapshot" |
| 运行边界 | 流必须以 `RUN_STARTED` 或 `RUN_ERROR` 开始；`RUN_FINISHED` 可带 `outcome`（success / interrupt / cancelled）与 `usage` | 停止、等待确认、成本统计都有标准位置 |
| 一流传多 run | 允许，但必须**顺序**：前一个 run 关闭才能开下一个；回放历史用 snapshot 事件 | 并发后台任务**不能**塞进同一条流 |
| 人工确认 | interrupt：run 以 interrupt outcome 结束并列出待答项；下一次输入用 `resume` 列表回答 | 对应 Point 的"草稿发送确认""接管请求" |
| 子 Agent | `SUBAGENT_STARTED/FINISHED/ERROR` + `subagentRunId`，必须在 run 内关闭 | 只适合"同一次 run 内派生"；后台任务跨越 run 边界，不适合 |
| 兼容规则 | 不认识的事件/字段**不报错**（丢弃/剥离）；已知字段值错误**必须失败** | 版本演进友好，但我们的投影必须严格校验 |
| 定制传输 | 允许 WebSocket/总线等，但必须保留事件模型与绑定契约，并自行文档化帧、输入与终止 | 断线重放与后台订阅走这条路 |
| 鉴权 | 协议不定义，属于绑定/应用 | Point 自己加单用户令牌 |

## 二、映射：Point 概念 → AG-UI

| Point | AG-UI | 说明 |
|---|---|---|
| 聊天（main / 侧聊） | `threadId` | 一个聊天 = 一个 thread；归档/恢复不改 id |
| 一次用户输入引发的执行 | `runId` | 前台 run；`POST /v1/agent` 打开 |
| 可见消息历史 | `MESSAGES_SNAPSHOT` | 由 Durable 可见消息投影；工具调用在快照中保留顺序 |
| 产品状态（chats 索引、jobs、memories、plans、browser 资源） | `STATE_SNAPSHOT` / `STATE_DELTA` | 首次整体快照，之后 JSON Patch |
| 模型输出 | `TEXT_MESSAGE_START/CONTENT/END` | CLI 现在是整段回复，之后可逐字 |
| thinking | `REASONING_*` | DeepSeek Flash 现在 high，客户端可选择不渲染 |
| 工具执行 | `TOOL_CALL_START/ARGS/END` + 结果 | `tool_call` 与 Point 的 `work_step`、浏览器 7 个工具一一对应 |
| 任务阶段（prepare/run/artifact/deliver/report） | `STEP_STARTED/STEP_FINISHED` | step 名即阶段名，UI 显示进度 |
| 后台任务进度 | `ACTIVITY_SNAPSHOT/DELTA`（`activityType: "point.job"`） | 不进对话正文，UI 渲染为任务卡片 |
| 后台执行产生的消息 | 前台 run 之外，用 per-run 流或 thread 流上的新 run | 见 §3 |
| 通知、记忆变更、浏览器租约、归档 | `CUSTOM`（`name: "point.*"`） | 规范明确 `CUSTOM` 是唯一合法的私有扩展通道 |
| 待确认的发送/接管 | interrupt + `resume` | 与"已确认的草稿发送边界"天然对齐 |
| 停止 | `RUN_FINISHED` + `outcome: cancelled`（先关闭所有已开实体） | 不能在 teardown 时直接断流，否则只能报 `RUN_ERROR` |
| 模型成本 | `RUN_FINISHED.usage`（provider/model 维度） | 目标形态；**WP5 暂不发送**——会话账本差分无法归属单次 run，逐 run 精确 usage 属后续能力 |
| 错误 | `RUN_ERROR`（`message` + 可选 `code`） | 与 Point 的 `{code,message,retryable}` 做映射 |

**不入 AG-UI 的部分**：thread 列表、历史分页、产物下载、鉴权、健康检查、管理面——继续用 REST。AG-UI 只管"一次运行/一个线程的流"。

## 三、三个必须自己解决的结构差异

### 1. 没有流恢复 → 自定义传输 + 幂等重建

标准 HTTP+SSE 不允许续传，但规范允许自定义传输，只要保留事件模型与绑定契约。Point 需要客户端离线数小时后回来仍能看到期间发生的事。

方案：`GET /v1/threads/:id/stream`（自定义绑定，SSE）
- 打开时先发一个"同步 run"：`RUN_STARTED(sync)` → `MESSAGES_SNAPSHOT` + `STATE_SNAPSHOT` → `RUN_FINISHED`。这是合法的一连串 run，snapshot 幂等，客户端无论断了多久都能重建。
- 之后按 commit seq 发增量（`STATE_DELTA`、文本/工具事件、`CUSTOM`）。
- SSE 帧带 `id: <seq>`；客户端可用 `Last-Event-ID` 请求补发；超出现有 ring 就直接重开同步 run。
- 文档化帧格式、输入（订阅命令）、终止与错误——这是绑定契约要求我们写清的。

### 2. 后台任务与 run 边界冲突 → 线程流 + 运行流两条

AG-UI 要求同一流里的 run 顺序执行，而 Point 的聊天 run 与后台执行可以并发。方案：
- **线程流**只承载：同步 run、状态增量、聊天 run、后台任务的 `ACTIVITY`/`CUSTOM` 生命周期。
- **运行流** `GET /v1/runs/:runId/stream`（自定义绑定，可重放）：一次后台执行的完整事件（工具调用、文本、阶段）。线程流先发 `CUSTOM point.job.started {runId}`，客户端按需打开运行流。
- 这样既不违反"顺序 run"，又不需要把并发塞进一个流。

### 3. 服务器是权威，客户端不应写状态

AG-UI 的 `state` 是双向同步的。Point 的状态权威在 Durable documents，客户端只读。做法：
- 目标（WP6）：输入里的 `state` 忽略；run 一开始就发 `STATE_SNAPSHOT`（规范允许整体替换），客户端缓存的旧状态被覆盖。
- 输入里的 `messages` 视为"客户端视图"，服务端以 Durable 历史为准，发现分叉就 `MESSAGES_SNAPSHOT` 纠正。
- 文档里明确这是单用户权威模型，不是多端协同编辑。

## 四、内部模型不变

```
Durable entries/tasks/documents ──► 内部规范事件（commit seq + timeline）──► AG-UI 投影 ──► CLI / Web / 第三方客户端
                                        │
                                        └──► REST（thread 列表、历史分页、产物、鉴权）
```

- **内部事件模型**仍是 Point 自己的（A2 的事件时间线、A4 的增量投影）。不把 AG-UI 事件当存储格式，也不让 domain 依赖 AG-UI 类型。
- **投影层**新增 `api/agui/`：`project-state.mjs`、`project-messages.mjs`、`runs.mjs`、`stream.mjs`、`custom.mjs`。
- 好处：换协议只改投影层；客户端（CLI/Web）共用一套契约；未来 CopilotKit 等现成 UI 可直接接。

## 五、工作量与风险

**工作量（一个工作包，不是新阶段）**：投影 + 两个自定义绑定 + 契约测试。主要成本不在 SSE，而在三件事：消息/工具调用的投影正确性、state 的 JSON Patch 生成、并发 run 的边界设计。归入 [roadmap](roadmap.md) 的 WP4（API 契约）与 WP6（读模型）。

**风险**：

| 风险 | 说明 | 缓解 |
|---|---|---|
| 规范仍在演进 | 1.0 已有 31 种事件，仍有新增（subagent/activity 较新） | 锁定 `protocolVersion: "1.0"`；官方 SDK schema 与客户端做契约测试；未知事件按规范容忍 |
| 客户端生态绑定 | 用 CopilotKit 客户端会带来它的运行时假设 | 复用官方协议 SDK；保持 Durable 为唯一执行引擎；CLI 使用 HttpAgent 验证 |
| state 体积 | 全量 `STATE_SNAPSHOT` 随任务增长 | 首次快照 + 后续 `STATE_DELTA`；state 只放索引，不放正文 |
| 消息投影 | Durable 的 system/memory section、工具结果形态与 AG-UI messages 不完全同构 | 只投影可见消息；工具调用走事件族，快照里保留占位顺序 |
| 无官方续传 | 客户端必须自己处理 `Last-Event-ID` 与同步 run | 参考客户端实现 + 契约测试覆盖"离线后重连" |
| 鉴权 | 协议不管 | 单用户令牌 + 同源；AG-UI 端点与 REST 共用鉴权 |

## 六、落地顺序（在现有 WP 内）

1. **WP4 先做 REST `/v1` 与内部事件序号**（AG-UI 需要稳定的 seq/run 身份）。
2. **WP4 加 AG-UI 投影骨架**：`POST /v1/agent` + `RUN_STARTED/FINISHED/ERROR` + 文本事件；CLI 先切过去，作为协议的第一个消费者。
3. **WP6 补 state/messages 投影与线程流**：`STATE_SNAPSHOT/DELTA`、`MESSAGES_SNAPSHOT`、`ACTIVITY`、`CUSTOM`、`Last-Event-ID`、同步 run。
4. **WP6 补运行流**：`GET /v1/runs/:id/stream`。
5. **WP7 补 interrupt/resume**：草稿发送确认、浏览器接管请求用 interrupt 表达。
6. **WP4/WP6 的出口判据加一条**：AG-UI 契约测试（含未知事件容忍、截断流、重连同步、JSON Patch 应用、并发 run 隔离）。

## 七、结论

- **用 AG-UI，但只作为客户端协议**；内部保持 Point 自有事件模型。
- **标准绑定能用，但不够**：断线重放与后台并发必须用规范允许的自定义传输补齐，并且写清绑定契约。
- **不要现在改形态**：等到 WP4 有 `/v1` 与稳定序号后再投影，否则会返工。
- 采用它是净收益：CLI/Web/未来第三方客户端共用一套事件语义，交互（interrupt）、成本（usage）、进度（activity）都有标准位置。

**引用**：AG-UI 1.0 规范 <https://docs.ag-ui.com/spec/1.0/basic/transports>；事件族 <https://docs.ag-ui.com/spec/1.0/events>；本评估中的"无流恢复""顺序 run""CUSTOM 用途限制"均引自对应页面，后续以其更新为准。
