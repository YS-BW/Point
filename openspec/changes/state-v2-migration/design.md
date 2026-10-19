# Design

## Context

现状：`point.server.meta` 为 `format: 1`；`point.chat`、`point.job`、`point.attempt`、`point.schedule`、`point.delivery`、`point.resource` 等 family 各自 `version: 1`；`storage/preflight.ts` 只校验 SDK 自身 schema；`storage/owner.ts` 保证单写者。没有迁移入口、没有备份步骤、没有收据清扫。按 roadmap §9，实施前必须先核查锁定版 `@earendil-works/pi-durable@1.3.0` 的文档/事务/快照公开能力，确认哪些迁移动作可以在单 commit 内完成。

## Goals / Non-Goals

**Goals:**

- 冻结 v2 形状（family 划分、key 规则、版本字段）并让读写两侧都以版本闸门为准。
- 迁移可中断、可重入、可回滚：备份成功才动数据；单 commit 切换；重复执行幂等。
- 让"旧库升级后语义等值"可验证，而不是靠人工核对。
- 给收据账本一个受约束的清扫路径，避免无限增长。

**Non-Goals:**

- 改变任何业务规则、错误码或状态转移（domain 冻结）。
- HTTP/AG-UI/SSE（WP4/WP5）、读模型增量投影（WP6）。
- 跨进程/在线热迁移、多写者、分布式迁移。
- 删除或重写 SDK 自己的会话 schema（SDK 版本闸门仍由 `preflightStorage` 负责）。

## Decisions

1. **版本闸门前置。** `Meta.format` 是唯一权威：`1` 只允许"显式迁移"或只读打开；`2` 正常读写；未知/更高版本一律拒绝且不写入。迁移命令本身也要先过 SDK preflight，避免在 SDK 不兼容的库上做产品迁移。
2. **备份先于写入，且用在线快照。** 迁移第一步生成 `<dataDir>/backups/pre-migration-<ts>.sqlite`（SDK/SQLite 在线快照，不 `cp` WAL 文件）；备份失败即中止，不产生任何格式变更。备份路径与大小记入迁移结果。
3. **单 commit 切换。** 所有文档重写 + meta format 写入在同一次 commit 内完成；任何 CAS/校验失败全部不生效，库仍是 format 1。迁移不得依赖"先删后建"的两段式。
4. **幂等靠格式本身判断。** 已是 format 2 时迁移命令直接返回 `already-migrated`（不重复备份、不重写）；中断在提交前 → 重跑；提交后中断 → 重跑见 format 2。
5. **分片规则。** 索引 family 只存 id/revision/updatedAt 等最小字段，实体 family 一实体一文档；跨实体不变量（例如 Job revision fence、Delivery 三态）仍由 application 层在同一次 commit 里校验，存储不新增业务规则。
6. **事件时间线与状态同 commit。** `point.event` 只记录产品可见事实（类型、聚合 id、revision、时间），由 runtime 在写状态时一并提交；查询/投影失败不得影响状态提交。它不是第二事实来源，可通过状态重建。
7. **收据清扫是显式命令。** 按 `keepMs`/`keepCount` 清扫 `point.command.*` 与 `point.resource-command`；正在 `attempting` 的 operation 及其收据、以及 `unknown` 待核销的记录永不清理；清扫只按 Durable commit 删除，且有上限与审计输出。
8. **旧库只读可用。** 未迁移的 v1 库在只读模式下仍可打开用于导出/核对；写模式一律要求先迁移，避免半升级状态。

## Risks / Trade-offs

- [Risk] 迁移期间进程被杀 → 备份仍在、format 未变；由幂等重跑收敛。测试必须覆盖"提交前后强杀"。
- [Risk] 分片重构触碰全部 store，回归面大 → 以现有 261 项测试为语义等值基线，domain 与拒绝语义零改动；新增 v1 夹具库做前后对比。
- [Risk] 事件时间线可能退化成第二事实 → 明确它只可重建、不可作为唯一权威；测试断言删除事件不影响状态正确性。
- [Risk] 清扫误删仍被引用的收据 → 只允许按保留窗口删除终态且不再被引用的收据；`unknown`/`attempting` 永久保留直到核销。
- [Risk] SDK 升级窗口（无兼容承诺）→ 迁移前跑 SDK preflight，并在文档记录 SDK 版本；SDK 升级仍走独立流程。
- [Risk] 备份占用磁盘 → 文档写明保留策略，且迁移可配置备份目录。

## Migration Plan

1. 核查 SDK 公开能力，确认单 commit 与在线快照 API；写出结论后再动代码。
2. 落地 format 2 的 family 定义与版本闸门；此步对 v1 库仍是"拒绝写模式"。
3. 落地迁移命令（备份 → 单 commit → 写 format 2）与幂等/中断测试。
4. 落地 v1 夹具库语义等值测试与 pre-v2 快照启动测试，再切换到 v2 为默认写入格式。
5. 落地事件时间线与收据清扫（独立提交，便于回滚）。
6. 回滚：恢复 `pre-migration-*.sqlite` 备份并回退提交；回滚后不重放任何 `unknown`。

## Open Questions

- 收据清扫的默认保留窗口（建议按 30 天/10k 条双阈值，落地时以配置为准）。
- 事件时间线是否需要分区/分页 family（若单 family 上限不足，改为按时间窗分片）。

## SDK capability verification (task 1.1)

Verified against locked `@earendil-works/pi-durable@1.3.0` (public package paths only) and Node `v22.22.3`, with isolated `/tmp` probes (no repository writes):

1. **One-commit migration is feasible.** `Session.commit` accepts an arbitrary list of document creations, changes and retirements. The SQLite backend wraps all writes of one commit in a single `db.transaction` (`SqliteStorage.commit`). A probe migrating the metadata kind, two entity documents, two index documents and two events observed exactly **one** published commit (`subscribeCommits`). Family version upgrades use `defineDoc(Family){version: N, migrate(value, fromVersion)}`; a loaded document whose stored version is lower is rewritten as a new-version base in that same commit (`#planDocument`), so no remove-then-create two-phase step is needed. `tx.retireDoc(oldKind)` plus `tx.doc(newKind)` in one commit is supported; the retired snapshot becomes `undefined` and the current scan contains only the new kind. No commit batch-size limit was found.
2. **Enumeration must happen outside the commit.** `Session`/`Harness` expose no document scan API; migration enumerates via the underlying `Storage.scanDocuments` + `Storage.document(id, 'current')` (the composition root already owns this handle). A commit callback may only use `tx`, so values are read first and rewritten inside the single commit. This is safe only under the existing `owner.sqlite` single-writer lock: migration acquires it, does not resume the scheduler, and refuses concurrent writers (`DATA_DIR_BUSY`).
3. **Online backup is feasible without copying WAL.** Node's built-in `node:sqlite` exports the SQLite online-backup API (`backup(sourceDb, path)`, Node >= 22.13; runtime is `v22.22.3`). A probe while Storage held a WAL-mode connection produced a consistent `backups/pre-migration-<ts>.sqlite` and `PRAGMA integrity_check` returned `ok`. The target is self-contained (no WAL copy); optional `PRAGMA journal_mode=DELETE` normalizes away any `-wal`/`-shm` sidecars created by verification reads. Backup happens before any migration write; a backup failure aborts with the format unchanged.
4. **Version detection uses the SDK, not raw SQL.** Stored document `kind`/`key` columns are JSON-encoded strings; the gate reads `point.meta` / legacy `point.server.meta` through `harness.snapshot()` before any product write and before the scheduler is resumed. Raw SQL is not used.
5. **SIGKILL semantics.** The migration commit is atomic and writes the format change together with every document rewrite. A kill before commit leaves format 1 (re-runnable; an extra timestamped backup is harmless), a kill after commit leaves format 2 and a re-run returns `already-migrated` without another backup or rewrite.
6. **Read-only limitation.** The SDK has no read-only storage backend. Read-only mode therefore opens Durable storage normally (WAL bookkeeping may touch files) but gives the product stores a guarded Harness whose `commit`/`resume` refuse writes and never resumes the scheduler; this is a product-layer guarantee, documented as such.

## v2 shape freeze (task 1.2)

The v2 product format is additive: existing per-entity family kinds stay authoritative (`point.chat`/`point.job` are bumped to version 2 with an identity migration; other entity families keep their current versions), and v2 adds the sharded read-side families frozen by the WP3 roadmap. Entity domain types are unchanged (domain freeze).

| Family | Kind | Scope | Key / seed | Purpose |
|---|---|---|---|---|
| meta | `point.meta` (v1) | session singleton | `{format: 2, engine, instanceId, migratedAt}` | Only product-format authority. Replaces and retires `point.server.meta` in the migration commit. |
| chats index | `point.chats` (v1) | session family | chatId | `{id, name, revision, createdAt, updatedAt}` |
| chat entity | `point.chat` (v2) | session family | chatId | Version bumped to v2 with an identity `migrate`; the stored shape/domain `Chat` type are unchanged, so no semantic drift. |
| memory | `point.memory` (v1) | session family | profile key | `{key, value, kind, sourceChatId, revision, updatedAt}`; replaces the single `point.profile` map (retired after data copy; receipts remain). |
| job entity | `point.job` (v2) | session family | jobId | Version bumped to v2 with an identity `migrate`; the stored shape/domain `Job` type are unchanged, so no semantic drift. |
| jobs index | `point.jobs` (v1) | session family | jobId | `{id, revision, status, updatedAt}` |
| resource index | `point.resources` (v1) | session family | resourceId | `{id, owner, state, controlEpoch, revision, leaseExpiresAt, updatedAt}` over existing resources. The roadmap shard name `browser` is intentionally realized as `point.resources`: the WP2 resource model is capability-generic and the roadmap forbids a browser-only resource abstraction. |
| requests index | `point.requests` (v1) | session family | `${family}:${receiptKey}` | `{key, family, receiptKey, referencedId, terminal, createdAt}` for bounded cleanup. |
| event | `point.event` (v1) | session family | eventId | `{id, type, aggregate, aggregateId, revision, at, data?}`; appended in the state commit, rebuildable. |

Rejection semantics: `point.meta.format === 2` opens read-write; legacy `point.server.meta.format === 1` requires explicit migration in read-write mode (`MIGRATION_REQUIRED`) and is allowed only under read-only mode; `format > 2`, unknown metadata, mismatched engine, both metadata kinds present, or legacy metadata with a non-1 format are refused (`UNSUPPORTED_DATA_FORMAT`/`UNRECOGNIZED_DATA`) without writing. A populated database with no product metadata is `UNRECOGNIZED_DATA`; a fresh one is created directly as format 2.

Same-commit consistency decisions (audit remediation): the profile 64-entry cap and forget existence are decided inside the write transaction using the derived `point.memory-count` counter (a pre-commit scan only seeds a missing counter; a stampede of unique-key inserts cannot exceed the cap). `cleanupReceipts` re-validates every reference inside the deleting commit and serializes cleanup runs in-process. `migrateRuntime` validates `point.meta` with the same engine/instance/format rules as the writable open, so a mismatched engine is `MIGRATION_INCOMPATIBLE`, never `already-migrated`.

Indexes, memory and events are derived facts: they are rebuilt by migration from entity documents, and events are explicitly non-authoritative (state stays correct if the timeline is dropped/rebuilt). Migration backfills every index entry, appends exactly one bounded `state.migrated` event (with a count summary; per-entity events would bloat large databases), and copies profile entries into `point.memory` before retiring `point.profile`, all in the same commit that creates `point.meta`.
