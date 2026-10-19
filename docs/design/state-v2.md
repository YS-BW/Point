# 状态 v2 与迁移（WP3）

> 2026-10-19。本文件冻结产品状态格式 v2、版本闸门、单 commit 迁移/备份/回滚与请求账本清扫。实现见 `apps/server/src/storage/state.ts`、`runtime/format.ts`、`runtime/migrate.ts`、`runtime/maintenance.ts`。证据与数字以 [验证状态](verification-status.md) 为准（Lead 统一维护）。

## 1. 格式与闸门

`point.meta` 是**唯一**产品格式权威：`{format: 2, engine: 'pi-durable@1.3.0', instanceId, migratedAt}`。

| 数据库状态 | 读写打开 | 只读打开 | 迁移 |
|---|---|---|---|
| 无产品 meta 且空库 | 直接初始化为 format 2 | 拒绝（`MISSING_METADATA`） | 初始化为 format 2 |
| legacy `point.server.meta`, format 1 | 拒绝（`MIGRATION_REQUIRED`） | 允许（产品写被 guard） | 允许 |
| `point.meta`, format 2 | 正常 | 正常 | `already-migrated` |
| format > 2 / 未知 / engine 不匹配 | 拒绝（`UNSUPPORTED_DATA_FORMAT`），零写入 | 同样拒绝 | 拒绝（`MIGRATION_INCOMPATIBLE`） |
| 两种 meta 同时存在 | 拒绝（`UNRECOGNIZED_DATA`，半迁移态） | 拒绝 | 拒绝 |
| 有 SDK 记录但无产品 meta | 拒绝（`UNRECOGNIZED_DATA`） | 拒绝 | 拒绝 |

- 版本检测在 SDK storage preflight 之后、任何产品写之前，通过 `harness.snapshot()` 读取，不使用裸 SQL。
- 只读模式：仍取 `owner.sqlite` 单写者锁，不 `resume`，产品 store 的 `commit`/`resume` 统一抛 `READ_ONLY`。**这是产品层保证**：SDK 没有公开的 read-only storage，SQLite/WAL 仍可能产生文件级写入，不构成 OS 级只读。
- 只读模式下迁移命令一律拒绝；恢复 pre-v2 快照后先只读核对，再显式迁移。

## 2. v2 文档族

实体族保持为唯一事实；v2 新增/调整的分片：

| family | kind | 版本 | key / 形状 |
|---|---|---|---|
| meta | `point.meta` | 1 | singleton，见上；迁移同 commit retire `point.server.meta` |
| chat entity | `point.chat` | 2 | chatId；形状不变（identity migrate，仅版本冻结） |
| chats index | `point.chats` | 1 | chatId → `{id,name,revision,createdAt,updatedAt}` |
| job entity | `point.job` | 2 | jobId；形状不变（identity migrate） |
| jobs index | `point.jobs` | 1 | jobId → `{id,revision,status,updatedAt}` |
| memory | `point.memory` | 1 | profile key → `{key,value,kind,sourceChatId,revision,updatedAt}`；替代单文档 `point.profile`（迁移复制后 retire，收据保留） |
| resource index | `point.resources` | 1 | resourceId → `{id,owner,state,controlEpoch,revision,leaseExpiresAt,updatedAt}`；roadmap 的 `browser` 分片以 capability-generic 的 `point.resources` 落法实现 |
| requests index | `point.requests` | 1 | `${family}:${receiptKey}` → `{key,family,receiptKey,referencedId,terminal,createdAt}` |
| event | `point.event` | 1 | eventId → `{id,type,aggregate,aggregateId,revision,at,data?}` |

- Attempt/Delivery/Schedule/Occurrence/Decision/Artifact/Resource/ResourceOperation 等实体族保持现有 kind/version（Delivery/ResourceOperation 已是 v2）；v1→v2 迁移不改其形状，未绑定 effect 的旧 v1 operation 文档按 WP2 契约拒绝（迁移报告 `MIGRATION_INCOMPATIBLE`）。
- 索引、memory、event 都是**派生事实**：迁移可从实体重建；事件被删除后状态仍正确，`rebuildEvents()` 可从当前状态重建时间线。
- 术语：实体 + 索引 + 事件在**同一个 commit** 写入（不是"双写"到第二事实库）。

## 3. 事件

- 类型集合：chat.created；memory.saved/forgotten；job.started/amended/running/ready/failed/cancelled；attempt.started/completed/failed/cancelled/superseded；schedule.created/cancelled；followup.decided；delivery.intent/done/failed/unknown；artifact.sealed；resource.updated；resource.operation.settled；state.migrated。
- `data` 有界（≤16 键、字符串 ≤512、仅 JSON 标量），不含凭据/大对象/响应体。
- 迁移只写**一条** `state.migrated`（含计数摘要），不为每个实体写事件。
- 事件不是事实来源：删除时间线后产品查询/状态不变；`rebuildEvents()` 可重建。

## 4. 迁移（显式命令）

`migrateRuntime(dataDir, options?)`：

1. 取 `owner.sqlite` 单写者锁；SDK `preflightStorage`（失败拒绝迁移）。
2. 读取产品格式；format 2 → `already-migrated`（不备份、不重写）；format 3/未知 → `MIGRATION_INCOMPATIBLE`。
3. 通过底层 `Storage.scanDocuments` + `document()` 枚举全部当前文档（commit 回调内只能用 `tx`，所以先读后写）。
4. **在线备份**：`<dataDir>/backups/pre-migration-<ts>.sqlite`，使用 Node `node:sqlite` 的 SQLite online-backup API（不复制 WAL）；备份后 `PRAGMA integrity_check` 验证并归一化 journal；失败 → `MIGRATION_BACKUP_FAILED`，格式不变、零重写。
5. **单 commit**：`point.meta`(format 2) + retire legacy meta；`point.chat`/`point.job` v2 base 重写；`point.chats`/`point.jobs`/`point.resources` 索引回填；`point.profile` 拆分到 `point.memory` 后 retire；`point.requests` 索引回填；一条 `state.migrated` 事件。任何失败整事务回滚，仍为 format 1。
6. 幂等：已是 format 2 → `already-migrated`，不再备份/重写。SIGKILL：提交前 → format 1 可重跑；提交后 → format 2，重跑 `already-migrated`。

### 回滚

1. 停写（关闭进程/保持 owner 锁语义）；2. 用 `pre-migration-*.sqlite` 覆盖 `state.sqlite`（并移除 -wal/-shm）；3. 只读打开核对；4. 需要时再次显式迁移。恢复后**不重放任何 unknown**：unknown/attempting 记录原样保留，等待观察核销。

## 5. 请求账本清扫

`runtime.cleanupReceipts({keepMs?, keepCount?, dryRun?})`，默认 `keepMs = 30 天`、`keepCount = 10000`，单次最多 1000 条；返回 `{scanned, removed, kept, dryRun, reasons, removedKeys}` 审计摘要。

- 只通过 `point.requests` 发现收据，再按家族读取真实收据文档。
- 永久保护：`attempting` / 未核销 `unknown` 的资源 operation；active job（queued/running 或 attempting attempt）；active schedule；无法解析引用/读取收据（fail-closed）；unknown 家族。
- 最近 `keepCount` 条永远保留；未过 `keepMs` 的保留；`dryRun` 只报告不提交。
- 清扫只 retire 收据文档与索引项，不改产品状态。

## 6. 已知限制 / 未验证

- SDK 无公开 read-only storage：只读模式是产品层 commit guard，SQLite/WAL 仍可能写文件。
- 备份目录/磁盘保留策略由运维配置；不自动清理旧备份。
- 迁移要求单写者、停写窗口；不做多进程/在线热迁移。
- 真实大库时长、SQLite 备份耗时、事件时间线规模未压测（WP9）。
- 真实 provider/HTTP/AG-UI 读模型（WP4/WP5/WP6）不在本片。
