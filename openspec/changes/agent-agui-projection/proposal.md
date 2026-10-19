## Why

WP4 已冻结 `/v1` 传输契约（错误信封、幂等键、鉴权、访问日志），但客户端仍只能轮询 REST：没有一次运行的流式投影，没有 `RUN_STARTED/FINISHED` 边界，没有 usage/cancelled 的标准位置。roadmap 的 G2 要求"REST 与 AG-UI 契约测试通过，CLI 已切到新协议"，WP6 的读模型与增量事件也必须建立在 AG-UI 事件形状之上。

## What Changes

- 新增 `POST /v1/agent`：接收 AG-UI `RunAgentInput`，返回 `text/event-stream`（每个 SSE `data` 恰好一个 JSON 事件），把一次前台运行投影为 AG-UI 1.0 事件流。
- 实现 run 生命周期与错误边界：流以 `RUN_STARTED` 或 `RUN_ERROR` 开始，以 `RUN_FINISHED`（`outcome: success|interrupt|cancelled` + `usage`）或 `RUN_ERROR` 结束；被截断的流**不得**伪造 `RUN_FINISHED`。
- 投影可用事件族：`TEXT_MESSAGE_START/CONTENT/END`、`STEP_STARTED/STEP_FINISHED`、`TOOL_CALL_START/ARGS/END`（按 SDK 实际能力裁剪），未知事件/字段按规范容忍，已知字段值错误必须失败。
- 停止语义：先关闭已开实体，再以 `outcome: cancelled` 结束，而不是直接断流。
- **预留** `point.ui.*` CUSTOM 命名空间与组件白名单契约（仅契约占位，不实现渲染、不引入前端运行时、不允许 HTML/JS 进事件或 Durable）。
- 新增最小参考 CLI 消费者（`apps/server/src/cli.ts` + npm script），作为协议的第一个消费者；不替换原型 CLI。
- 新增 AG-UI 契约测试：流首事件、截断流、未知事件容忍、cancelled、错误映射、SSE 帧格式。

## Capabilities

### New Capabilities
- `agui-projection`: AG-UI 1.0 运行流投影、生命周期与错误边界、`point.ui.*` 预留扩展命名空间。

### Modified Capabilities
无（`api-v1` 的 REST 契约不变；AG-UI 端点复用同一鉴权与访问日志）。

## Impact

修改 `apps/server/src/api/**`（新增 agui 投影与 SSE）、新增参考 CLI，更新文档与 OpenSpec。不改 domain/storage/runtime 语义、不新增依赖、不引入第二执行引擎；不实现线程流/`Last-Event-ID`/同步 run/state+messages 快照/运行流（WP6）、interrupt/resume（WP7）、CopilotKit 运行时或任意 UI 代码生成。

## Approved correction (2026-10-19)

The user approved the compatibility correction after review. This section supersedes the earlier no-dependency and wire-shape decisions: pin @ag-ui/core/client/encoder 1.0.3 at the edge; use official schemas/encoder and HttpAgent. Outcome is an object; omit standard usage until per-run attribution is reliable. Use unique provisional stream IDs and canonical Durable entry/message IDs in an authoritative messages snapshot at completion. CLI must reject incomplete streams. Observation timeout/overflow must not claim execution failure or replay work. Full reconnect subscription remains WP6. Scope includes api/agui, application stream port, runtime projection/history, CLI, boundary rules, tests, docs and lockfile, serially. No persistent schema change.
