## Why

当前 meta 是 `format: 1`，所有产品状态挤在若干单文档 family 里，没有任何迁移框架：升级到新格式既不会备份，也不会原子切换，只能靠 `assertCompatible` 拒绝；会话/产物/请求收据随时间只增不减，`point.command.*` 收据没有清扫路径。roadmap 的 G3 要求"迁移可回滚、旧库语义等值"，因此必须先冻结 v2 状态形状与版本闸门，后续 WP6 的读模型才能建立在稳定 schema 上。

## What Changes

- 冻结并实现状态 v2：`point.server.meta` 升到 `format: 2`；按 `meta/chats/chat/memory/job/jobs/browser/requests` 拆分文档 family（索引 + 单实体），不再用单文档承载无界状态。
- 新增产品可见的 `point.event` 时间线：与状态变更在**同一次 commit** 写入，作为投影来源；不新建第二份事实库。
- 新增显式迁移命令：校验 SDK schema → 在线备份（不拷贝 WAL）→ **单 commit** 重写全部文档 → 写入 format 2；失败或中断保持 format 1 不变；重复执行幂等。
- 版本闸门：读写打开前校验 format；未知/更高版本拒绝写模式，旧版本要求显式迁移，不允许静默读取或就地降级。
- 请求账本治理：`point.command.*` / `point.resource-command` 收据支持按时间/条数清扫，且不得删除仍被引用或被 `unknown` 核销依赖的收据。
- 提供 v1 夹具库：升级后语义等值、二次迁移幂等、pre-v2 快照可启动（只读或显式迁移）三类测试。

## Capabilities

### New Capabilities
- `state-v2`: v2 文档分片、事件时间线、单 commit 迁移、升级前备份、版本闸门与收据清扫。

### Modified Capabilities
- `conversation-commands`: 收据与命令头写入 v2 family，保持既有幂等与拒绝语义。
- `jobs-and-artifacts`、`plan-and-delivery`: Job/Attempt/Delivery/Schedule 状态迁移到 v2 family，语义与 revision fence 不变。

## Impact

修改 `apps/server/src/storage/**` 与 `runtime/**`（含 `open.ts` 组合根与各 store），新增迁移命令与夹具测试，更新 `docs/design/**` 与证据。**不改** domain 规则与拒绝语义、不改 `api/**`（WP4）、不实现 AG-UI/读模型事件流（WP5/WP6）、不引入新依赖或第二执行引擎、不做多进程并发迁移。
