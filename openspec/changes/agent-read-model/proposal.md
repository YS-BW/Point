## Why

WP5 已交付 `POST /v1/agent` 的一次运行投影，但客户端仍无法在**不轮询**的情况下维持一份与服务端一致的状态与消息视图：

- 没有任何读模型端点：客户端要拼出 chats/jobs/resources 视图，只能逐条 REST 拉取，成本 O(实体数)。
- 没有增量事件：一次 commit 的变化无法表达为 O(变更) 帧，客户端只能反复取全量快照。
- 没有断线恢复：AG-UI 标准 HTTP+SSE 绑定**明确不支持续传**，手机断网/笔记本合盖后客户端只能重建。
- 没有后台运行流：后台 Job/Attempt 的进度只能靠 `ACTIVITY` 之外的私有通道，或干脆不展示。
- `/inspect` 的 Durable 计数在 WP4 被显式推迟到 WP6（`docs/design/api-v1.md:23`）。

roadmap 的 **G3（状态就绪）= WP3 + WP6**：WP3 已交付状态 v2 与迁移闸门，缺的正是本片的增量事件与重连同步。

## What Changes

- **读模型**：新增只读派生视图 `GET /v1/state`，从 v2 派生索引文档（`point.chats`/`point.jobs`/`point.resources`/`point.memory`）构造，**禁止**调用 `Storage.task`/`scanTasks`；同时在门控 `GET /inspect` 补 Durable 计数。
- **提交订阅投影**：消费 `Session.subscribeCommits` 的 `CommitPublication{seq, changes}`，把一次 commit 投影为 `STATE_DELTA`（RFC 6902 JSON Patch，只含变化路径）+ `ACTIVITY` + `CUSTOM`。
- **线程流**：新增自定义绑定 `GET /v1/threads/:threadId/stream`（SSE）。打开时发一次**同步 run**（`RUN_STARTED(sync)` → `STATE_SNAPSHOT` + `MESSAGES_SNAPSHOT` → `RUN_FINISHED`），随后发增量。每帧带 `id: <commitSeq>`；`Last-Event-ID` 在保留窗口内补发，窗口外**显式重同步**并标注原因，绝不伪造连续。
- **运行流**：新增 `GET /v1/runs/:runId/stream`，只观察一次后台执行（`runId` = Durable task id），断线**不取消、不重放**执行。
- **有界性**：所有缓冲区/快照/补发窗口都有显式上限；溢出走显式重同步，不静默丢帧。
- **文档口径修正**：roadmap 的 WP6 写作用域补 `runtime/**`（SDK 只能从 runtime lane import，WP5 已因同因新增 `runtime/agui.ts`）。

## Capabilities

### New Capabilities
- `read-model`: 只读派生状态视图、Durable 计数、`GET /v1/state` 与 `/inspect` 计数口径。
- `commit-subscription`: `subscribeCommits` → `STATE_DELTA`/`ACTIVITY`/`CUSTOM` 的增量投影与有界性。
- `thread-stream`: 线程流自定义绑定、同步 run、`Last-Event-ID` 重连与显式重同步。
- `run-stream`: 后台运行的只读观察流（不取消、不重放）。

### Modified Capabilities
- `api-v1`: `/inspect` 增加 Durable 计数字段；新增只读路由复用既有鉴权/错误信封/访问日志。

## Impact

修改 `apps/server/src/runtime/**`（读模型与提交订阅端口，SDK 消费仅在此 lane）、`apps/server/src/api/**`（新路由与 SSE 绑定）、`apps/server/src/application/**`（中性端口类型，不含 AG-UI 与 SDK）、`apps/server/test/**`、OpenSpec 与设计文档。

不改 domain 语义、不新增持久 schema、不引入第二执行引擎或第二事实库。读模型与增量缓冲都是**可丢弃的派生物**：删除后重新扫描即可重建，任何产品决定都不得依赖它们。
