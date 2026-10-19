# WP3 状态 v2 / 迁移 / 清扫独立代码审计

> 2026-10-19。对象：worktree `/Users/lixinlv/Projects/Doing/point-wp3`，分支 `wp/3-state-v2`，实现 `801cad4`（基于 `a261216`，**尚未合并 main**）。
> 评审人：code-auditor。范围：只读代码/测试审计；仅写本文件，未改源码/测试。作者自测报告 `npm test` 280/280（本次隔离复跑 270 server + 10 scripts = 280）。
> 结论：**需修改（1 个 blocker）**；其余为高风险/文档/测试补强项。

## 1. 验证

| 项目 | 结果 |
|---|---|
| `npx tsc -p apps/server/tsconfig.json --outDir /tmp/point-wp3` | BUILD_OK |
| `node --test state-gate/state-migration/state-cleanup/state-events` | **19/19 pass** |
| 服务端全量隔离构建 | **270/270 pass** |
| `scripts/*.test.mjs` | 10/10 pass |
| `tsc --noEmit` / `check-boundaries.mjs` | exit 0 / passed |
| worktree | clean；`git diff --stat a261216..HEAD` 无 domain/application/api/bootstrap/config 改动 |

## 2. Blocker

### B1（语义回归）Profile 条目上限在并发下失效

- 代码：`runtime/profile.ts:50` 在 commit **之前**用 `memoryDocuments().length` 取 `currentCount`；`:59` 在 commit 内用该陈旧值判断 `MAX_PROFILE_ENTRIES`（64）。旧实现是在 `tx.doc(Profile)` 内基于事务内 map 判断，天然串行。
- 可复现探针（隔离 build，`/tmp/point-audit-probe/wp3-probe.mjs` P1）：
  1. 顺序 remember 63 条（`before=63`）；
  2. 并发发出两个不同 key 的 remember（`Promise.allSettled`）；
  3. 结果：**两个都 fulfilled，`after=65`**（`{"before":63,"after":65,"settled":["ok","ok"]}`），超过 `MAX_PROFILE_ENTRIES`。
- 影响：domain 规则未改、错误码未改，但**拒绝语义在并发下被绕过**；`forget` 同样用 commit 前 `snapshot(Memory)`（`:87`）决定是否 retire，存在与并发 remember 的陈旧读/丢失更新窗口（同一根因：v2 分片后计数/存在性判断移出事务）。
- 修复方向（供实现参考）：在 commit 内做事务一致的数量/存在性校验（如维护一个 `point.memory` 计数 singleton 随同一 commit 更新，或使用 SDK 事务内可用的 family 扫描/计数原语）；`forget` 的 removed 判定也应在 tx 内读取。补并发 remember/forget 回归（≥2 并发、边界 64）。
- 备注：本项不要求改 domain 文件；需保持错误码 `PROFILE_LIMIT_REACHED` 与拒绝语义。

## 3. 审计重点逐条

### 3.1 版本闸门（通过；附分类小问题）

- `runtime/format.ts`：`MetaV2.format` 唯一权威；format 2 正常；legacy format 1 读写模式 `MIGRATION_REQUIRED`、只读允许；format≠2/engine 不匹配/无 meta 但 populated/两种 meta 并存分别拒绝 `UNSUPPORTED_DATA_FORMAT`/`UNRECOGNIZED_DATA`（`detectStateFormat`）。fresh 库直接 `harness.root` 写 format 2（`open.ts:139-147`）。
- 测试：`state-gate.test.ts` 8 项覆盖 fresh、v1 拒写、v1 只读、format 3/0、engine 不匹配、双 meta、legacy format 2、format 2 只读；均断言不重写 metadata。
- 未发现可在未知/更高格式下写入的路径：gate 在任何产品写之前，`migrateRuntime` 也在 commit 前判格式。
- 小问题：`migrateRuntime` 对已存在 `point.meta` 只检查 `format !== 2`（`migrate.ts:197-199`），**不校验 engine/instanceId**；篡改 engine 后迁移返回 `already-migrated`（探针 P3），而 `openRuntime` 正确 `UNSUPPORTED_DATA_FORMAT`。属分类/契约不一致（无写入、fail-closed），见 §4.1。

### 3.2 备份先于任何重写，失败即中止（通过）

- `migrate.ts` 顺序：owner lock → preflight → detect（只读）→ 枚举（只读）→ `backupDatabase`（`:118-170`，Node `node:sqlite` online backup，`PRAGMA integrity_check`，归一化 journal）→ 单 commit 重写。备份失败抛 `MIGRATION_BACKUP_FAILED`，format 仍 1；测试 `state-migration.test.ts:239-252` 断言失败后 MetaV2/index 均不存在且 format=1。
- 备份路径/字节数返回结果；备份目录 0700；同名冲突加后缀；重试失败会留下额外 timestamp 备份（契约允许，_re-run 幂等不重复备份_由 format 2 分支保证）。
- 非阻塞：备份文件本身未显式 `0600`（依赖父目录权限）；建议后续显式设置。

### 3.3 迁移单 commit（通过，有硬证据）

- `migrate.ts:228` 仅一次 `harness.commit`：meta v2 + retire legacy meta、chat/job v2 base、attempts/deliveries/schedules/occurrences/decisions/artifacts/resources/operations/receipts touch、chats/jobs/resources 索引、profile→memory+retire、requests 索引、一条 `state.migrated` 事件；任何异常整事务回滚。
- 测试 `state-migration.test.ts:158-223` 用 SQL `document_revisions` join `documents` 断言迁移写入的 kind 共享**同一个 `seq`**（`rows.length===1`），并验证重跑 `already-migrated`、无第二次备份；`beforeCommit` 抛错测试回滚（`:224-238`）。
- 未发现两段式“先删后建”；未知/未来格式迁移拒绝（`:315`）。

### 3.4 幂等与 SIGKILL（通过）

- format 2 → `already-migrated`，不备份不重写（测试 `:219-223`）；提交前失败可重跑（`:224-238`）；SIGKILL 前后测试 `:287-314`（子进程 kill 夹具）断言重启只观察 format 1 或 format 2，重跑安全。
- fresh 空库 `initialized` 路径无需备份（无 v1 数据可备，符合契约）；`populated` 无 meta → `MIGRATION_INCOMPATIBLE`。

### 3.5 语义保持 / domain 零改动（大部分通过，但 B1 违反“拒绝语义”）

- 无 domain/application/api/bootstrap/config diff（命令核对）；错误码/状态机/输入校验未改。
- 测试覆盖迁移后 chat/history/job/attempt/delivery/schedule/resource/operation 语义、unknown/attempting 原样保留且不重放（`state-migration.test.ts:158-223`）。
- **但 B1**：profile 上限拒绝在并发下失效，属于“拒绝语义”回归（实现层，非 domain 文件）。修复前不应合并。

### 3.6 `point.event` 不是第二事实（通过；重建覆盖有限）

- 所有 runtime 写路径在**同一 `tx`** 内 `appendEvent`（chats/profile/jobs/deliveries/schedules/resources/artifacts 的 diff 均在 commit 回调内）；`Events` 未出现在查询/决策路径（仅 events.ts/maintenance/migrate 引用）。
- `state-events.test.ts`：事件与状态同 commit、删除全部事件后产品状态仍正确、`rebuildEvents()` 可重建；事件 data 有界（≤16 键/≤512 字符串）。
- 非阻塞：`rebuildEventTimeline`（`maintenance.ts:191-238`）只重建 chat/job/memory/resource/artifact/schedule 的实现，未覆盖 §3 列出的 attempt/delivery/resource.operation/followup.decided 等事件；状态仍正确，但“时间线可完整重建”的契约表述需收窄或后续补齐。

### 3.7 清扫安全（静态保护通过；存在 TOCTOU 残窗）

- `maintenance.ts`：只从 `point.requests` 发现，按 `keepMs`/`keepCount`/单次 1000 上限选择；`protectedReason` 对 active job、attempting attempt、active schedule、unresolved resource operation、missing/unknown family 一律保留；dryRun 不提交；删除只 retire 收据+索引。
- 测试 `state-cleanup.test.ts` 3 项覆盖旧终态删除/审计摘要、active job/unresolved resource 保护、最近窗口；**补充探针**：seed `attempting` resource operation + 收据 → cleanup `removed=0`（保留），但 reason 记为 `unknown`（见 §4.4）。
- 非阻塞 TOCTOU：所有保护判定在 commit **之前**读取（`protectedReason`/`unresolvedResourceIds`），commit 回调（`:282-289`）只是按已选列表 retire，**没有在事务内重新校验**。若 cleanup 扫描后、提交前有并发写入（例如 job 被 amend 回到 active、或两个 cleanup+重放产生新收据），陈旧判定可能删掉“当前仍被引用”的收据。单写者/显式命令降低概率，但契约“永不清除仍被引用/attempting/unknown”不是严格原子保证；建议 commit 内对每个 key 再读一次收据与引用状态（或文档化“cleanup 需停写窗口”）。
- 测试缺口（非阻塞）：没有 active schedule、`attempting` resource（reason 分类）、并发 cleanup/状态变化的用例。

### 3.8 只读模式产品层 guard（大部分通过）

- `format.ts` `readOnlyGuard` 代理拦截 `commit`/`resume`；`open.ts` 只在 read-write 且 binding 时 `resume`；所有 runtime store 用 `current()`（guarded）。
- 测试只覆盖 `chats.create` 拒绝；补充探针（P2）：`chatCreate`/`profileRemember`/`rebuildEvents`/`resources.acquire` 均 `READ_ONLY`；`cleanupReceipts` 在**零删除**时返回成功而非 `READ_ONLY`（无写入），有删除时 commit 才抛 `READ_ONLY`。
- 文档已声明这是**产品层**保证（SDK 无公开 read-only storage，WAL 仍可能写文件）；Proxy 只拦 commit/resume，未拦 `root` 等其它写 API——当前 runtime 在 open 后不使用这些路径，属可接受限制，但建议在 doc §1/§6 明确“guard 只覆盖 commit/resume”。
- 非阻塞：cleanup 应在入口直接 `READ_ONLY`（含空删除），避免只读命令“看起来成功”。

### 3.9 越界与文档一致性

- `git diff --stat a261216..HEAD` **无 api/**、bootstrap.ts、config.ts、domain/**、application/** 改动；WP3 只动 runtime/storage/tests/docs/openspec，符合 lane。
- **文档不一致（非阻塞，必须修）**：`docs/design/state-v2.md:29,31` 写 `point.chat`/`point.job` **version 2**（identity migrate），实现也是 v2；但 `openspec/changes/state-v2-migration/design.md:76,78` 的 v2 shape 表仍写 “unchanged v1 / no shape change”。两处必须统一为 v2 identity migrate。
- OpenSpec `tasks.md`：5.1/5.2 未勾选；README 更新在 scope 外（作者已注明）；原型快速回归未跑（worktree 无 `infra/.../node_modules`）；verification-status/evidence 未更新（WP3 未合并，gate 前需补）。

## 4. 非阻塞项（按优先级）

1. **迁移 engine 不匹配分类**（`migrate.ts:197-199`）：已存在 `point.meta` 只判 `format!==2`；engine 不匹配应 `MIGRATION_INCOMPATIBLE`（doc §1 表），实现返回 `already-migrated`（探针 P3）。安全的 fail-closed（open 拒绝），但分类错误；建议补 engine/instanceId 校验。
2. **Cleanup TOCTOU**（§3.7）：保护判定在 commit 外；建议 commit 内重校验或文档化停写要求；补并发测试。
3. **Cleanup reason 误导**：`attempting` resource 被保留但 reason 记为 `unknown`（`protectedReason` resource 分支只返回 `'unknown'`；探针 reasons 中 `attempting:0, unknown:1`）；审计摘要应区分 attempting/unknown。
4. **迁移计数重复/语义**：`migrate.ts` 先 index 收据（`counts.receipts +=`），随后 `touchFamily` 又对同类收据累加 receipts；`ModelCalls` 也记入 `counts.receipts`。`state.migrated` data 的 receipts 数会偏大（测试只断言 chats/jobs/attempts/memory）。建议拆分计数（receipts/modelCalls）或去重。
5. **事件重建覆盖**：`rebuildEventTimeline` 只重建部分 aggregate；若契约要求完整时间线，需补 attempt/delivery/resource-operation/followup 事件或收窄文档。
6. **只读 cleanup 零删除返回成功**（§3.8）：入口直接 `READ_ONLY` 更严格。
7. **备份文件权限**：建议显式 `0600`（父目录 0700 已提供主要保护）。
8. **文档/任务/证据同步**：§3.9 的 chat/job v2 不一致、OpenSpec 5.1/5.2、README、prototype regression、verification-status/evidence。
9. **测试缺口**：active schedule cleanup、cleanup attempting reason、迁移 engine mismatch、read-only 其它写路径（profile/resources/jobs）、大库/并发 cleanup。

## 5. 未验证 / 已知限制（与 doc §6 一致）

- 真实大库迁移耗时、SQLite online backup 时长/磁盘占用、事件时间线规模未压测（WP9）。
- 多进程/在线热迁移不支持；迁移要求单写者/停写窗口。
- 只读模式是产品层 guard，SQLite/WAL 文件级写仍可能发生；非 OS 级只读。
- 回滚流程（恢复 backup + 移除 -wal/-shm）由测试覆盖基本路径，真实运维演练未做。
- 原型 `POINT_CRASH_ROUNDS=1 npm test` 未在 worktree 跑（无依赖）；WP3 未合并 main。
- 未验证真实 provider/HTTP/AG-UI 读模型（WP4/5/6 范围）。

## 6. 结论

**需修改（B1 blocker）。** WP3 的格式闸门、备份先于重写、单 commit（有 revision seq 证据）、幂等/SIGKILL、事件同 commit 与清扫静态保护均达到契约；但 v2 分片把 profile 上限/存在性判断移出事务，导致**并发 remember 可超过 MAX_PROFILE_ENTRIES（探针 65>64）**，属拒绝语义回归。修复 B1（事务内一致计数/存在性 + 并发回归）并处理 §4 的文档/分类项后，可批准合并。WP4 已单独审计且通过（无 blocker）。
