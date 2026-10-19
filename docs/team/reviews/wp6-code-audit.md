# WP6 代码审计（读模型 + 增量事件 + 线程流 + 断线重连）

> 2026-10-19。评审人：code-reviewer（REVIEWER）。任务：task-6。
> 范围：只读 `apps/server/src/**` 与契约文档，**不修改实现**；唯一写作用域 `docs/team/reviews/`。
> 本文件为**增量报告**：Lead 分片提交，每片到达后追加一节；未审到的部分明确标注「未交付」。

**当前状态**：`代码审计完成`。基线 `34813ec`；WP6.1–6.4 与独立复查四缺口均**已复核通过**，累计 **9 个 blocker 全部关闭**（§3.6、§5）。**不含** tester 独立动态验证与真实长连接/压测，故 **G3 仍不应宣布通过**。
已完成：§2 契约冻结核查、§3.1 WP6.1、§3.2 WP6.2、§3.3 WP6.3（四轮）、§3.4b WP6.4、§3.6 四缺口复核、§5 终审口径。
**环境备注**：审计期间 `npm run check` 曾因 tester 的 `verify/**` 报错，Lead 修复后复跑 **exit 0 + boundaries passed**。我独立复跑过的定向套件：`thread-stream` 6/6、`stream-recovery` 12/12、`thread-stream+commit-stream+read-model` 15/15。**全量 352/352 是 Lead/tester 的口径，我未复跑全量。**

---

## 0. 审计对象与基线

| 项 | 值 |
|---|---|
| 基线提交 | `34813ec`（`main`，工作树 clean，`npm run check` 与 `node scripts/check-boundaries.mjs` 均通过） |
| WP6 契约冻结 | `openspec/changes/agent-read-model/{proposal,design,tasks,specs/read-model/spec.md}`（工作区文件，未提交） |
| 已审实现 | WP6.1：`application/read-model.ts`、`runtime/read-model.ts`、`api/routes.ts`(+`GET /v1/state`)、`api/http.ts`(`/inspect` counts)、`api/errors.ts`、`runtime/open.ts`；无 `bootstrap.ts` 改动 |
| 未交付 | WP6.2 增量订阅、WP6.3 线程流/运行流/断线重连 |
| 判定基准 | [AGENTS.md](../../../AGENTS.md) 硬规则十条、[agent-core.md](../../design/agent-core.md) 十条不变量与 DoD、[review-checklist.md](../review-checklist.md) 十条、[roadmap.md](../../design/roadmap.md) WP6 行与 §3 lane、[api-v1.md](../../design/api-v1.md)、[protocol-agui.md](../../design/protocol-agui.md) |

**审计方法（可复现）**：

- 静态：逐文件阅读 + `grep` 验证分层与二次事实（不只看声明）；与 `scripts/check-boundaries.mjs` 的 lane 规则交叉核对。
- 契约：把 design.md 的每条 SDK「已核实事实」拿 `node_modules/@earendil-works/pi-durable@1.3.0/dist/**` 与 `@ag-ui/*@1.0.3` 逐条对账，而不是信任文档自述。
- 动态：**不跑全量测试**（tester 职责）。本审计只跑 `npm run check`、`node scripts/check-boundaries.mjs`，以及为复核单个断言而跑的**定向**套件（会明确标注，且不替代 tester 的独立验证）。
- 数字口径：本文件不写新的性能/验证数字；权威数字只在 `docs/design/verification-status.md`。

---

## 1. 结论摘要

| 编号 | 检查项 | 结论 |
|---|---|---|
| B1 | 读模型是否降级为第二事实库 | WP6.1–6.4 均**未见行缓存或第二事实**；判定通过 |
| B2 | 分层（domain/application/api/SDK lane） | WP6.1–6.4 **通过**（`check-boundaries` passed） |
| B3 | 帧有界性（SSE 缓冲/快照上限/慢消费者/并发准入） | 各层上限已实现，运行流并发上限经**共享 budget** 闭合（§3.6-4）；SSE 层未动态验证 |
| B4 | 重连语义（不伪造连续） | 三种 reason 可区分、静默丢帧已改、补发改用**单调 serial**、resync 补发窗口、裁剪时显式失败 —— **已闭合**（§3.6-1/3） |
| B5 | 既有契约（/v1 幂等、错误信封、访问日志、/health） | `OBSERVATION_*` 映射已修；`STATUS_BY_CODE` 扩大需在闸门记录说明（非阻塞） |
| B6 | 跨 lane 越界 | WP6.1–6.4 **通过**（roadmap 已同步更新作用域） |
| C1 | 契约冻结正确性（design.md 事实断言） | 事实断言全部为真；1 blocker 已修复并复审通过（§2.3） |
| C2 | WP6.2 增量订阅 | 首轮 3 blocker → 全部确认已修（§3.2.6） |
| C3 | WP6.3 线程流 | 累计 5 个 blocker（预检 2 + 第二轮 3 + 放大 1 + A″ 1）→ **全部关闭**（§3.3.4、§3.6） |
| C4 | WP6.4 运行流 | 首轮 6 条待办 → 并发上限/静默结束/轮询已闭合；剩 `point.run` 文档（§3.6） |
| C5 | 独立复查四缺口 | **全部闭合**（§3.6），`stream-recovery` 12/12 实跑 |

**当前总体判定（代码审计层面）：blocker 已清零，可通过代码审计；但不等于 WP6 完成。** 累计发现并关闭 9 个 blocker（契约 1 + WP6.2 3 + WP6.3 4 + A″ 1）。剩余：2 条文档项 + 全部动态验证（tester 的 100 job/10 chat、真实 SSE/长连接/压测）未完成，故 **G3 仍不应宣布通过**。

---

## 2. 契约冻结核查（task-1）

### 2.1 SDK 事实断言：逐条对账结论（通过）

design.md §2 的事实断言经独立核对**全部为真**，不是推断：

| 断言 | 核对位置 | 结论 |
|---|---|---|
| `subscribeCommits` 存在，签名 `(listener: (publication, context) => void) => () => void` | `pi-durable/dist/session/session.d.ts:102` | 真 |
| listener 在 commit 完成后**同步**调用；抛错被 `contained()` 捕获并 `report()`，不让 commit 失败、不跳过其他 listener | `dist/session/session.js` `#publish()`（`internalListeners`→`fail()`，`#commitListeners`→`report()`） | 真 |
| `CommitPublication = {seq, changes}`；`changes` = `StorageWrite`(conversation/entry/task/submission) + `DocumentCommitChange`(document/document.copy) | `dist/types.d.ts:702-703`、`:697-700`、`:678-695` | 真 |
| 无 commit 历史枚举 API；`Storage` 只有 `document(id, at)` / `scanDocuments(query, at)`，`at: Seq \| "current"` | `dist/types.d.ts:861-916`（逐方法核过，无「列出某 seq 区间 commit」能力） | 真 |
| `Seq` 为 branded number，单调递增、跨重启保持 | `dist/types.d.ts:23-26`（"Strictly increasing ... gaps are permitted"）+ `storage/sqlite/storage.js` `next_seq` 持久于 `durableMetadata` | 真 |
| 不存在公开「当前 seq」getter | 全量检索 `dist/**/*.d.ts`：只有 `Storage.commit(): Promise<Seq>` 返回 seq | 真（**这正是 §2.3 blocker 的根源**） |
| Chord `Op` 元组形状 `r/s/d/a/t/p/m`，`p`/`m` 为数组重排 | `@earendil-works/chord/dist/delta/index.d.ts` | 真；design §3「不机械翻译 Chord ops」的理由成立 |
| 官方 `EventSchema` 允许 `metadata` 开放字段，未知顶层字段 passthrough | 用官方 schema 实测 `{type:'STATE_SNAPSHOT', snapshot, truncated}` → parse 成功且保留字段 | 真（`truncated` 不会被静默剥掉） |
| AG-UI 1.0.3 具备 `STATE_SNAPSHOT/STATE_DELTA/MESSAGES_SNAPSHOT/ACTIVITY_SNAPSHOT/ACTIVITY_DELTA/CUSTOM` | `@ag-ui/core` `EventType` 枚举 | 真 |
| `CUSTOM` 必填 `name`+`value`；`ACTIVITY_SNAPSHOT` 必填 `messageId/activityType/content`；`STATE_DELTA` 必填 `delta` | `@ag-ui/core/schemas` 逐 schema 读 `.shape` | 真（实现时若漏 `messageId`，`EventSchema.parse` 会在出口失败——这是好事，别放宽） |

### 2.2 契约设计本身的评估（总体认可）

以下几点是**正确的硬决策**，后续实现必须照做，评审会按此检查：

1. **state 用「以 id 为键的对象」而非数组**（`design.md:53-57`）。数组 + 位置型 patch 在删除/插入时位移、不幂等；对象键型 patch 的 `add`=replace、`remove`=ignore 才允许重连重叠补发。这是 §2.3 修复方案成立的前提。
2. **帧级游标 `<commitSeq>:<frameIndex>`**（`design.md:101-111`）。同一 commit 多帧共享 id 会让「只收到第 1 帧就断线」的客户端永久丢剩余帧，且 JSON Patch 不幂等、不能整段重发兜底。此修正是对的。
3. **同步 run 用 `runId` 前缀 `sync-` + `metadata.point.sync`**（`design.md:155-161`）。官方 schema 无 `sync` 字段，不能凭空加——识别方式落在 schema 允许的字段上，正确。
4. **`MESSAGES_SNAPSHOT` 工具历史显式 defer**（`design.md:146-153`）。半成品快照比明确标注 `{"point.toolsIncluded": false}` 更糟，这个取舍正确。
5. **CUSTOM 白名单三个**（`design.md:163-173`）：超出即 defer，避免「规范里有的都发」式扩范围。

### 2.3 BLOCKER：`/v1/state` 的 `seq` 取了「上界」，会造成客户端永久丢变更

**位置**：`openspec/changes/agent-read-model/design.md:59`
> `seq` 是该响应构建**完成时**本进程已观察到的最高 commit 序列。

**为什么阻塞**：这是一个单进程单写者也会稳定复现的静默分歧路径。

1. 读模型按 family 依次 scan（例如 `point.jobs` 扫完，observedSeq=100）；
2. 扫描完成、尚未读 `point.chats` 时，同一 Session 落一个**改 job** 的 commit seq=101（`subscribeCommits` 同步回调把它记入 observedSeq）；
3. 该 job 变更**不在**快照里，但构建完成时 observedSeq=101，响应 `seq:101`；
4. 客户端以 `Last-Event-ID: 101` 订阅 → 服务端「补发 101 之后」→ **seq=101 的变更永远不会到达客户端**。

结果：客户端视图与服务端权威快照永久不一致，且**不会**触发任何 resync 提示。直接违反 WP6 出口判据「离线重连后状态与消息一致」与 tester 的「应用 patch 后 == 权威快照」判据。

线程流同步 run 有同一缺陷：sync run 的帧游标若取上界，扫描期间落地的 commit 会被「游标已越过」而永久跳过。

**建议修复（与 design §1 自身的幂等论证一致，改动量为文档两句话 + 实现取值为下界）**：

- `seq` 语义改为**构建开始前**观察到的最高 commit seq（**下界**）：断言「快照至少包含到此 seq；其后帧允许与快照重叠」；
- 订阅/补发从 `seq+1` 开始，允许与快照重叠——因为 state 已是 id 键对象，`add` 命中已存在键=替换、`remove` 命中不存在=忽略（`design.md:53-57` 已冻结该客户端容忍规则），重复应用幂等；
- 线程流同步 run 的起始游标同样用该下界；
- design.md §1/§4 明确写一句「快照 seq 取扫描开始前的观察值，不是完成时的值」，防止实现者再选上界。

**备注**：这不是「实现很难补」，而是**语义定错**——上界写法无法通过任何实现补丁变正确，只能改契约。故按 blocker 报，不按建议报。

### 2.4 非阻塞：契约文档内部漂移

- `tasks.md:8`（1.4）与 `tasks.md:29`（4.3）仍写 `id: <commitSeq>`；`design.md:109` 与 `protocol-agui.md:63` 已冻结为 `<commitSeq>:<frameIndex>`。实现若照 tasks.md 做会退回「同 commit 多帧共享 id → 重连丢剩余帧」的旧错误。建议提交前统一（属于文档一致性，product-reviewer 也会覆盖；此处按审计口径记一条）。
- `design.md:67` 引用的行号 `dist/session/session.js:362-366`、`:555-580` 与当前 1.3.0 包内实际位置有偏移（`subscribeCommits` 位于约 361-366、`#publish` 位于约 556-580）。行号漂移不影响结论，引用时建议改为「函数名 + 语义」而非裸行号。

---

## 3. 实现审计

> 分片到达后逐片追加，每条给「文件:行号」证据。**未审到的分片一律标「未交付」，不得当作通过。**

### 3.1 WP6.1 读模型 —— 首轮审计（实现已落地，未提交）

**涉及文件**：`apps/server/src/application/read-model.ts`（新增 171 行）、`apps/server/src/runtime/read-model.ts`（新增 204 行）、`apps/server/src/api/routes.ts`（+`GET /v1/state`）、`apps/server/src/api/http.ts`（`/inspect` 加计数）、`apps/server/src/api/errors.ts`（+错误码）、`apps/server/src/bootstrap.ts`、`apps/server/src/runtime/open.ts`。

**结论：核心不变量通过；1 条实质问题 + 若干非阻塞项，无 blocker。**

#### 3.1.1 逐条（对 checklist 十条与本任务六重点）

| # | 检查项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 读模型是派生视图，不是第二事实库 | **通过** | `runtime/read-model.ts:63-79`：内存里只有 `observedSeq` 数字与 `attached` 布尔，**没有**行缓存、没有旁路队列、没有持久化；每次 `state()` 都从索引文档重扫（`:87-152`）。全仓 `grep "messages\s*=\s*\["` 仍为空 |
| 2 | 不读实体文档、不调 `storage.task`/`scanTasks` | **通过** | `state()` 只 `deps.scan('point.chats'/'point.jobs'/'point.resources'/'point.memory'/'point.event')`（`:88,100,111,125,139`）；`counts()` 只扫文档 kind（`:182-187`）。全模块无 `task(`/`scanTasks` 调用（`grep` 核过） |
| 3 | 分层：application 无 SDK/AG-UI；SDK 仅 runtime | **通过** | `application/read-model.ts` **零 import**（`grep "^import"` 为空）；`runtime/read-model.ts` 只 import `@earendil-works/chord/context`、`@earendil-works/pi-durable`（runtime lane 允许）。独立跑 `node scripts/check-boundaries.mjs` → passed |
| 4 | `/v1/state` 复用 WP4 鉴权/错误信封/访问日志 | **通过** | 路由走统一 `resolve()`→鉴权→handler（`api/http.ts:144-179`）；副作用无；GET 不要求 `Idempotency-Key`（`routes.ts:103-110`）；访问日志仍是统一 `http.access`（`http.ts:199-211`），path 不含查询串 |
| 5 | `/inspect` 只加字段、既有形状不变 | **通过** | `http.ts:136-143`：`{version,instanceId,phase,capabilities}` 原样保留，`counts`/`countsTruncated` 仅在有 readModel 时追加；无 readModel 时完全省略 |
| 6 | `/health/{live,ready}` 形状不变 | **通过** | `http.ts:108-118` 未改；返回仍是 `FoundationStatus` |
| 7 | 既有错误码不回归 | **通过** | `errors.ts` 只**新增**条目（`RUN_NOT_FOUND`/`TOO_MANY_STREAMS` 与若干 `*_NOT_FOUND` 显式化）；原本 `*_NOT_FOUND` 已由 suffix 规则映射 404（`errors.ts:87-91`），显式化是等价行为，非变化 |
| 8 | `seq` 取下界（§2.3 blocker） | **通过** | `runtime/read-model.ts:81-85`：先 `attach()` 再 `const seq = observedSeq`，**在扫描之前**取值；模块头 `:10-14` 写明不能取上界及原因。修复正确 |
| 9 | 无 `seq` 时诚实 | **通过** | `observedSeq` 初始 0（`:64`），无提交时返回 0；消费方按 `seq+1` 订阅即可 |
| 10 | 各 family 有界 + `truncated` 标记 | **通过** | `STATE_LIMITS`（`application/read-model.ts:70-76`）1000/1000/1000/200/200；`bound()` 保留最新并置标志（`runtime/read-model.ts:154-174`）；`truncated` 字段按 family 置位 |
| 11 | memory 不暴露正文 | **通过** | `StateMemory` 无 `value`（`application/read-model.ts:46-52`）；`runtime/read-model.ts:129-135` 明确不拷贝 `value` |
| 12 | 端口注入/组合根 | **通过（附见 §3.1.3-1）** | `open.ts:211` 注入 `readModelRuntime({getHarness: current, scan})`；`bootstrap.ts` 的 `apiRuntime()` 现在要求 `readModel` 存在 |
| 13 | 只读模式可用 | **通过** | `readOnlyGuard` 是 `Proxy`，非 `commit`/`resume` 方法 `Reflect.get` 后 `bind(target)`（`runtime/format.ts:83-96`），`subscribeCommits` 会被转发；`scan` 用的是原始 `storage`，只读本就允许 |
| 14 | 跨 lane 越界 | **需记录** | 改动前缀：`api/**`、`application/**`、`runtime/**`、`bootstrap.ts`。roadmap WP6 行只写 `api/**`、`storage/**`；`application/**` 属 lane C。design/proposal 已声明要扩 `runtime/**`，但 **roadmap 本身尚未更新**，且 `application/**` 未见显式裁决 → 见 §3.1.3-2 |
| 15 | 测试 | **未验证** | 本片新增的 `apps/server/test/**` 契约测试属 Lead/tester 后续分片，本报告写作时未见 read-model 测试 |

#### 3.1.2 实质问题（非阻塞，但建议本片处理）

**S1（中）：`truncated` 变化无法通过 `STATE_DELTA` 表达，且 `remove` 语义有歧义。**

- `application/read-model.ts:131-156` 的 `diffState` 只遍历 `STATE_FAMILIES`（5 个 family，`:66`），**从不比较 `truncated`**。因此：
  - 快照时某 family 未截断（例如 events 150 条），随后涨过 200 → 客户端收到 add/remove 帧，但 `truncated` 标记**永远停在 false**；
  - 快照时已截断、之后回落到界内（例如 jobs 从 1000+ 降到 999）→ 标记**永远停在 true**，客户端会持续走分页 REST。
- 更需注意的是 `bound()` 的淘汰会产生 `remove` 帧（`:154-158` + `diffState:146-147`）：客户端**无法区分「实体被删除」与「被上限挤出视图」**。本产品当前没有删除类端点，所以 `remove` 实际只来自截断/轮换——这个语义必须写进契约，否则客户端会把 `remove` 当删除渲染。
- 建议（低成本）：`diffState` 对 `truncated` 做一次整体比较，变化时发一条 `{op:'replace', path:'/truncated', value:...}`（仅在变化时，0 或 1 条 op，不破坏 O(变更)）；并在 spec 明确 `remove` 只表示「移出视图」，不表示实体删除。

**S2（低-中）：`/v1/state` 的工作量与 `point.event` 增长线性相关，响应有界但扫描无界。**

- `runtime/read-model.ts:139-152` 为拿最新 200 条事件会扫**全部** `point.event` 文档；`bound()` 再对全量排序（`:59`）。已核实 `DocumentQuery` **没有** order 字段（`pi-durable/dist/types.d.ts:618-622`），无法「倒序只取 200」，所以这是 SDK 能力约束下的必然做法，不是实现偷懒。
- 但 roadmap 风险表把「事件成本」的缓解挂在 WP3 + WP6；本片只把**响应**收敛到 200，**扫描成本**仍随历史事件数增长。建议至少在 design/README 明确写成已知成本并列入未验证项（WP9 压测时看），不要让它悄悄变成「已解决」。
- 同类：`counts()`（`:179-189`）对 16 个 kind 各做一次全量扫描，`COUNT_CAP` 只置 `truncated` 标志、**不减少工作量**。`/inspect` 是门控诊断，可接受，但应写明是 O(文档总数)。

#### 3.1.3 非阻塞建议（逐条可转 issue/deferred，不静默忽略）

1. **`bootstrap.ts:19-25` 把 `readModel` 设成整个 `/v1` 命令面的启用条件**：`agent` 是可选端口（缺失只让 `/v1/agent` 503），`readModel` 却让 `apiRuntime()` 整体返回 `undefined`——一个只缺 readModel 的 runtime 会**静默丢掉全部 `/v1` 路由**（包括 `/v1/agent`）。而 `routes.ts:104-108` 与 `http.ts:137-140` 已经正确处理「readModel 缺失」的情况，说明这个 combine 级门控是多余的。建议删掉 `&& candidate.readModel !== undefined`，让缺失时只有 `/v1/state` 503。
2. **roadmap 的 WP6 写作用域需要落地更新**：`docs/design/roadmap.md` WP6 行仍写 `apps/server/src/api/**`、`storage/**`；本片实际动了 `runtime/**`、`application/**`、`bootstrap.ts`。`application/**` 属 lane C（roadmap §3），按 AGENTS.md「需要动别人 lane 的文件时，停下来升级为串行」需要显式裁决/记录。`tasks.md 6.4` 已列该文档更新，但**合并前**必须完成，否则 reviewer 无法判定「无跨 lane 越界」。
3. **快照键建议用 `document.key` 而不是 `value.id`**：`state()` 用 `value.id`/`value.key` 建键（`:91,103,114,130,143` + `keyBy:169-173`），而增量路由按 `DocumentCommitChange.record.key` 定位；当前 WP3 写入保证两者相等（`runtime/state-index.ts:22,31,44`；`memoryDocument` 的 `key`），所以不是现存缺陷。但两者一旦分叉，delta 会 patch 到快照里不存在的键。建议快照以 `document.key` 为权威键（`value.id` 仅作字段），代价为零。
4. **`attach()` 从不 detach，且是懒挂载**：`runtime/read-model.ts:72-79` 没有保存 `subscribeCommits` 的返回值做 `unsubscribe`；harness 关闭后 listener 随 Session 一起被回收，实际无泄漏级影响，但建议保存并随 runtime 关闭注销。另外懒挂载意味着**首次 `state()` 之前的提交不被观察**，序列会从 0 开始——这仍是安全的下界，但设计文档写的是「进程启动后尚无提交时为 0」，建议改成「首次读取前不观察」以避免实现者误解。
5. **`counts()` 的 kind 清单不完整**：`COUNTED_KINDS`（`:36-40`）未包含 `point.meta`、`point.memory-count`、`point.profile`、`point.job-execution`、`point.model-call`、`point.resource-command`、`point.resource-operation-request`、`point.schedule-head`。若 `/inspect` 要当完整诊断，需明确是「产品实体计数」还是「全部 kind 计数」并写进 README。
6. **`/v1/state` 无字节上限**：只按条数收敛。理论最大（1000+1000+1000+200+200 行）在极端字段长度下仍可能过大；建议记录为未验证项（本报告 §4 已列）。

#### 3.1.4 WP6.1 第二轮复核（Lead 修复后，逐条独立验证）

我按「不看作者自述、逐条回读代码」复核，结果：

| 首轮问题 | 声称的处理 | 独立复核结果 |
|---|---|---|
| §3.1.3-1 `bootstrap.ts` 把 `readModel` 当整个 `/v1` 启用条件 | 删掉该条件 | **确认已修**：`bootstrap.ts:14-25` 的 `apiRuntime()` 不再引用 `readModel`，与 `agent` 同等对待（缺失时只有 `/v1/state` 503，由 `routes.ts` 单独判空） |
| S1 `diffState` 不比较 `truncated` | 已加 truncated diff | **确认已修**：`application/read-model.ts:163-171`，标记变化时发 1 条 `add`/`remove` `/truncated`；`remove` 仅当 `before` 非空时触发，不会发无意义 remove |
| S1 `remove` 语义歧义 | 写进代码 + spec | **确认已修**：`spec.md:82-85` 新增 Scenario「Remove means leaving the view」，明确 `remove` = 移出有界视图 ≠ 实体删除 |
| §3.1.3-3 快照键用 `document.key` | 已改 | **确认已修**：`runtime/read-model.ts:106,118,129,145,158` 全部为 `document.key`，`value.id` 回退已删，与增量路由的 `record.key` 对齐 |
| §3.1.3-5 `counts()` kind 清单、`COUNT_CAP` | 改只数实体族 + 删 `COUNT_CAP` | **确认已修**：`COUNTED_FAMILIES` 13 个实体族映射（`runtime/read-model.ts:40-54`），`point.chats`/`point.jobs`/`point.resources` 派生索引族不再重复计数；`COUNT_CAP` 全仓 grep 无残留 |
| §3.1.3-2 roadmap 写作用域 | 已更新 | **确认已修**：`roadmap.md` WP6 行改为 `api/**`、`application/**`（中性端口类型）、`runtime/**`、`storage/**`；lane A 行补 `runtime/**` 的读模型/提交订阅。**跨 lane 越界一项改判：通过**（`application/read-model.ts` 确为零 import 的纯类型/纯函数） |
| §3.1.3-4 `attach()` 不 detach | 保留 + 注释说明理由 | **接受**：`runtime/read-model.ts:75-88` 注释写明 listener 只记一个数字、Session 关闭时自行清空；显式 detach 需 close hook，收益不抵复杂度。判定为合理取舍，非缺陷 |

`npm run check`（含 `check-boundaries.mjs`）独立复跑：**exit 0，Architecture boundaries passed**，与 Lead 自述一致。

我只跑了一个**定向**套件复核关键断言（**不是**独立动态验证，动态验证归 tester task-5）：`node --test apps/server/dist/test/read-model.test.js` → **5/5 通过**；并确认计数的拦截面是真的——`SqliteStorage.task` 是原型方法（`dist/storage/sqlite/storage.js:287`），`prototype.task` 包装确实能拦到真实调用，所以「`storage.task` = 0」不是空断言。

**第二轮新增的非阻塞意见**：

- **B2-1（文档与实现不符，建议改一行）**：`application/read-model.ts:93` 的 `DurableCounts.truncated` 注释仍写「True when any family scan hit its cap, so a count is a lower bound」，但 `counts()` 现在**恒返回 `false`**（`runtime/read-model.ts:196-199`，注释明确「Counts are exact, not lower bounds」，因为 `sessionScanner` 会翻完全部分页）。注释是错的，会误导后续实现者以为存在 cap。建议改为「Reserved for a future capped count; the current implementation always reports exact counts (`false`)」。
- **B2-2（测试守卫比判据意图窄）**：`read-model.test.ts:65-91` 只包装 `SqliteStorage.prototype.task`，未包装 `scanTasks`。roadmap 判据字面是「`storage.task` 调用=0」，测试与字面一致；但判据**意图**是「读模型不得退化成扫 task 表」，若实现改用 `scanTasks` 测试仍会绿。当前实现确实不调 `scanTasks`（静态核对为真），故非现存缺陷；建议一并计数 `scanTasks`，让守卫覆盖意图。
- **B2-3（命名）**：`countsTruncated` 恒为 `false`。保留字段以免未来加 cap 时破坏形状是合理取舍；但 api-v1/README 应写明「当前恒 false、计数为精确值」，否则消费者会以为它有含义。

#### 3.1.5 未验证（本片）

- **不调 `storage.task` 目前是静态核对 + 一个定向套件的计数断言**；**独立**动态验证（真实 100 job/10 chat 夹具）由 tester（task-5）负责，本报告不代其结论。
- `/v1/state` 在 1000/1000/1000/200/200 满界下的响应体积与超界 `truncated` 行为**未动态验证**（只在代码层确认逻辑存在）。
- `/inspect` 的 13 个计数键在真实写入下的精确性只由 `counts.chats === 1` 一条断言覆盖，其余 12 个键的数值正确性未验证。

---

### 3.2 WP6.2 增量订阅 —— 首轮审计（`runtime/commit-stream.ts` 已落地，未提交）

**结论：3 个 blocker + 4 条非阻塞。其中 2 个 blocker 会让客户端视图与服务端权威视图静默分歧，1 个是明确未实现的 spec MUST。**

先说**通过**的部分（实测/核对过，不是采信注释）：

| 检查项 | 结论 | 证据 |
|---|---|---|
| listener 不阻塞、不调 Session API | **通过** | `commit-stream.ts:237-241`：回调只 `enqueue(publication)`（往 Promise 链上追加），所有 await 都在链的后续 drain 里 |
| O(变更)、不重读文档 | **通过** | 直接用 `DocumentCommitChange.value`（`pi-durable` 已给出「exact adopted immutable revision」，`types.d.ts:678-695`），patch 只含变化路径（`:188-192`） |
| 帧顺序 = commit 顺序 | **通过** | `:120-125` 单条 Promise 链串行 drain，注释说明「并发投影会乱序」 |
| >100 op 退化 snapshot | **通过** | `:199-201`，且 snapshot 与 delta 二选一 |
| CUSTOM 白名单 | **通过** | 只发 `point.job.started` / `point.job.finished`（`:220-230`），另有 `point.stream.resync` 属 WP6.3 |
| ACTIVITY 字段齐全 | **通过** | `messageId` / `activityType: 'point.job'` / `content`（`:209-212`），满足官方 `ActivitySnapshotEventSchema` 必填项 |
| 慢消费者不拖垮别人 | **通过（附测试缺口）** | 每 sink 上限 `MAX_QUEUED_FRAMES = 1024`（`:26,130-141`），只结束该 sink 并置 `overflowed`，iterator 抛 `OBSERVATION_RESYNC_REQUIRED`（`:255`） |
| `runId` 可解析 | **通过** | `jobs.start` 与 running 转移都在**同一 commit** 写入 Job+Attempt（`runtime/jobs.ts:400-409`、`:162-164`），commit 后再读即可见；`resolveRunIdentity:294-297` 读已提交态成立 |

#### 3.2.1 BLOCKER-1：投影异常被静默吞掉 → 静默丢帧 + 订阅者可能挂住

**位置**：`apps/server/src/runtime/commit-stream.ts:121-125`

```ts
const enqueue = (publication: CommitPublication): void => {
  chain = chain
    .then(() => project(publication))
    .catch(() => undefined);   // <-- 吞掉一切
};
```

`project()` 会 await 两处可能抛错的东西：`deps.readModel.state()`（bulk / degraded 路径，`:201,203`）与 `resolveRunIdentity()` 的 `harness.snapshot()`（`:294,297`）。一旦抛错：

- 该 commit 的**所有帧对全部订阅者静默丢弃**，没有任何 `state_snapshot`/错误帧/重同步信号；`CommitFrame` 里也没有 error 类型可用；
- 订阅者等的是 `sink.wake`（`:257`），错误路径不唤醒，**直到下一个 commit 才可能恢复**，期间流表现为卡住；
- `catch` 同时吞掉编程错误，使问题在生产里不可见。

这直接违反 spec:231「MUST NOT fake continuity」与 design §7「溢出走显式重同步，不静默丢帧」，也违反本模块自己的注释承诺。**建议**：把 `catch` 改为「标记所有 sink 为 overflowed/ended（或发一条显式 resync/error 帧），让 edge 走重同步」，并把错误原因记入日志（不含敏感信息）。

#### 3.2.2 BLOCKER-2：`events` family 永远不产生 patch → 客户端状态视图从第一个 commit 起就与权威视图分歧

**位置**：`apps/server/src/runtime/commit-stream.ts:162-172`（`point.event` 分支只做 `jobEvents` 收集后 `continue`，从不 push patch op）

- 权威 state 视图**包含** `events`（`application/read-model.ts:85`；spec:23 明确列出并按 200 条上限约束）；
- 但增量路径对 `point.event` 文档**永不发出** `/events/<id>` 的 `add`/`remove`；
- 因此客户端把 `STATE_DELTA` 全部应用后，其 `events` 映射仍停在初始快照，**spec:77-79「applying every delta … equals the server's authoritative state view field by field」无法成立**。这不是角落场景：`chat.created`、`memory.saved`、`job.*`、`attempt.*` 等每次业务提交都会 append 一条 `point.event`。

**并且这里有一个必须一起解决的结构性张力（这是我在这一片最想让你先看的部分）**：
`events` 上限是 **200**，而事件是**每次提交都增长**的高频族。于是两条路都会出问题：

1. **当前实现（不打 events patch）** → events 视图永久停在快照（本 blocker）；
2. **天真地补上 events patch** → `touchesDegraded`（`:197-198`）会因为「本次 commit 触碰了 degraded 的 events 族」而对**几乎每次提交**都降级成 `STATE_SNAPSHOT` → 直接打掉 roadmap 出口判据「单 commit 只发 O(变更) 帧」。

修这个必须做选择，我建议其中之一（都要落到 spec，否则 tester 的 E2/E3 判据含义不明）：

- **(a) 把 `events` 从增量同步的 state 视图里摘出去**（`/v1/state` 仍可返回它作为只读首屏），spec 明确「events 只随 STATE_SNAPSHOT 更新，不是 delta 契约的一部分」；
- **(b) 保留 events 在 delta 里，但不依赖 200 条有界视图**：由投影在事件族里跟踪「本次 commit 新增的 event id」，驱逐由客户端按上限自行裁剪（需要 spec 写明客户端裁剪规则）；
- **(c) 给 events 一个足够大的上限并接受它在 fixture 下也常被截断**——但 100 job 夹具会产生 500+ 事件，200 的上限在**合规夹具里就已经截断**，所以 (c) 实际上等于 (2) 的退化，除非同时把 events 移出 degraded 判定。

注意：**100 job/10 chat 的出口判据夹具本身就会让 `truncated.events = true`**，所以这不是「等数据变大才会遇到」的问题，请连夹具一起考虑。

**补充证据（审计写作时）：spec / 实现 / tester 断言是三方不一致的**

| 来源 | 对 `events` 的口径 |
|---|---|
| `spec.md:23`、`:77-79` | 权威 state 视图**包含** `events`（上限 200）；delta 应用后必须**逐字段**等于权威视图 |
| 实现 `commit-stream.ts:162-172` | `point.event` 只用于派生 CUSTOM，**不产生任何 patch op** |
| tester 的动态验证 `apps/server/test/verify/commit-delta.test.ts`（"Patch application equals authority" 段） | 只比较 `['chats','jobs','resources','memory']`，**跳过 `events`** |
| tester 的 `state-read-model.test.ts:86` | 又断言 `truncated.events === true`（说明 events 在视图契约里是被认真对待的） |

也就是说：这条 MUST 目前在**没有任何一方**成立——spec 有要求、实现没做、动态验证绕开了它。这不是实现单方面的 bug，而是契约口径需要 Lead 拍板后三方一起改。

#### 3.2.3 BLOCKER-3：spec「Truncation marker is diffed」在实现里不存在

**位置**：`spec.md:85-87`（MUST：family 越界/回落时 delta 必须带 `truncated` 更新） vs `commit-stream.ts` 全文（**没有任何** `/truncated` op；唯一截断处理是订阅时传入的 `degraded` 集合 `:102,197-203`，`design.md:114` 也把该机制限定为「**快照时**某个 family 超过上限」）

- 首轮审计我提过 S1，Lead 当时把 `/truncated` diff 加进了 `diffState`；
- 但本片把 patch 生成改成了「直接从 `change.value` 构造」（`:188-192`），**`diffState` 已从 `application/read-model.ts` 删除**（全文件 `grep diffState` 为空），于是那条修复**随之消失**；
- 结果是：一个 family 在流进行中**越过上限**时，服务端有界视图已经淘汰了最旧一行，投影只发 `add /family/<new>`，客户端既保留被淘汰的行、也不知道自己已截断 → 静默分歧；`degraded` 只覆盖「订阅时已截断」，覆盖不到「中途越界」。对 `events` 而言这个越界在合规夹具里**必然发生**（上限 200，夹具 500+ 事件）。

**建议**：要么在投影里检测「本次 patch 触碰的族是否达到/超过上限」并降级为 `bounded_view` snapshot + 发 `/truncated`；要么明确改 spec（把该 Scenario 改成「订阅时截断才降级；中途越界由下一次重同步解决」并说明客户端如何得知）。**spec 与实现必须一致，否则 tester 按 spec 写用例必然失败，或这条 MUST 被静默放弃。**

#### 3.2.4 非阻塞项

1. **待处理链本身无界**：每个 sink 的队列有 1024 上限，但共享的 `chain`（`:120-125`）会为每个到达的 publication 保留闭包（含整个 `changes` 数组），投影慢（bulk/degraded 会做全量 `state()` 扫描）时提交速率可让它无界增长。建议对 pending 深度也设上限，超出即降级重同步。
2. **`jobEvents.status` 是错的且没人用**：`:168` 把 `num(change.value.revision).toString()` 塞进名为 `status` 的字段（即「修订号字符串」）；实际 `point.job.finished` 用的是 `event.type.slice('job.'.length)`（`:229`），`status` 从未被读。属死代码 + 误导，建议删除或改成真正的 job status。
3. **模块头「read-free / zero extra storage reads」不准确**：`:4-7` 声称零额外读，但 `resolveRunIdentity`（`:294,297`）对每个 job 生命周期事件做 2 次实体文档 `harness.snapshot`。这不是越界（runtime lane，且不在 `/v1/state` 路径），但注释与事实不符，建议把「read-free」限定到 patch 路径。
4. **run 身份在 drain 时才解析，可能与帧的 seq 不匹配**：`job.running` 事件的 payload 不含 attemptId/taskId（`runtime/jobs.ts:164` 未传 data，`recordJob` 的 data 为 null），所以 `resolveRunIdentity` 读的是「drain 时刻的最新已提交状态」。若在 commit N 之后、drain 之前发生了 attempt 替换（supersede），`point.job.started` 会带着**新的** runId 被标上**旧的** seq。建议在写入 `job.*` 事件时把 `attemptId`/`taskId` 放进 event data（同 lane，改动很小），让帧完全由 commit 本身派生。
5. **死导出**：`emptyStateView`（`application/read-model.ts:166`）与 `StateRow`（`:153`）现在无人使用（全仓 grep 为空）——`diffState` 删掉后遗留。
6. **测试缺口**：`commit-stream.test.ts` 覆盖了「一个 commit 一条 delta」「顺序」「degraded snapshot」「ACTIVITY+CUSTOM 白名单」，但**没有**覆盖：`MAX_QUEUED_FRAMES` 溢出（B3 的慢消费者判据）、中途越界截断、投影异常路径、`point.job.started` 的 `runId` 字段（只断言了 `attemptId`）、以及 events 族的同步（正好是 BLOCKER-2）。

#### 3.2.5 未验证（本片）

- 本片**动态行为**（真实 SSE、真实并发提交、慢消费者）未由我验证——归 tester。
- `ACTIVITY_DELTA` 未实现（只发 `ACTIVITY_SNAPSHOT`）；design §7/协议文档说 `ACTIVITY_SNAPSHOT/DELTA`，若只发 SNAPSHOT 需在文档里说清（我未看到明确说明）。
- 100 job/10 chat 夹具下「单 commit 只发 O(变更) 帧」我**未**动态测量。

#### 3.2.6 WP6.2 第二轮复核（3 个 blocker 的修复，逐条独立验证）

| 我的 blocker | 修复方式 | 独立复核结果 |
|---|---|---|
| §3.2.1 异常被吞 → 静默丢帧 | `.catch(() => failAll())`：`failAll` 把每个 sink 置 `overflowed/ended` 并唤醒，iterator 抛 `OBSERVATION_RESYNC_REQUIRED` | **确认已修**（`commit-stream.ts:145-170`）。且顺带修了我提的「chain 无界」：`pending` + `MAX_PENDING_PUBLICATIONS = 1024`，超限即 `failAll()` 并丢弃该 publication（`:159-165`） |
| §3.2.2 `events` 永不 patch / 三方口径不一致 | 选定「events 为 snapshot-only，不属于 delta 契约」：`DELTA_FAMILIES` 仅 4 个族（`:35`），并写进 spec | **确认已修（口径层面）**：spec:23 明确「`chats/jobs/resources/memory` 为 delta-managed；`events` 为 snapshot-only 且 MUST NOT 被打 patch」，spec:71-75 独立 requirement 给出理由，spec:87 把「逐字段相等」限定到 delta-managed 族。tester 的比对也已是同样口径 → **三方一致**。这是我在 §3.2.2 里建议的方案 (a)，且理由（否则每次提交都越界→每提交一快照→打掉 O(变更)）与我一致 |
| §3.2.3 `truncated` Scenario 未实现 / 中途越界 | 新增 `counts`/`limits` 影子计数 + `crossed` 判定，越界即发 `reason: 'bounded_view'` 的有界快照并从权威视图重播种计数 | **确认已修**（`:116-124,255-276`）。spec 也把原先那条不可实现的 Scenario 换成了「越界 → 服务端发带 truncation 标记的有界快照，且没有 delta 声称表达它」（spec:95）。设计上接受「只多不少」的保守估计（注释 `:117-121`），我认为是合理取舍 |
| §3.2.4-2 `jobEvents.status` 是 revision 字符串且没人用 | 该字段已删除，改为 `attemptId?` | **确认已修**（`:200,221-227`） |
| §3.2.4-4 drain 时才解析 run 身份 | `runtime/jobs.ts` 的 `recordJob` 把 `attemptId` 写进事件 data；投影从事件 payload 取 `attemptId`，再按其精确 id 读一次 attempt 拿 taskId | **确认已修**（`jobs.ts:70-81`、`commit-stream.ts:221-227,290-292,367-377`）。现在帧身份来自 commit 本身，不再受「drain 时状态已变」影响 |
| §3.2.4-3 模块头「read-free」不实 | 头部改为「state rows 零额外读；唯一读是 job 生命周期事件的一次 attempt 快照」 | **确认已修**（`:4-12`），与代码一致 |

**新增的两点注意（非阻塞）**：
- `counts` 是 `subscribe()` 的**可选**参数（`:106,123`）。thread-stream 目前会传（`runtime/thread-stream.ts:206-207`），但「可选且不做就漏报淘汰」是易踩的默认值，建议改必填或在投影内部自取种子。
- `messages_changed` 是新增帧类型（`application/read-model.ts:115`），由 `entry` 提交驱动（`commit-stream.ts:203-210`）：对 `role` 为 user/assistant 的 entry 发一条带 `threadId` 的通知帧。O(变更) ✓。

### 3.3 WP6.3 线程流 + 运行流 —— 预检（`runtime/thread-stream.ts` 落地中，**2 个 blocker**）

> 该文件在我审计期间被改动过两次，以下结论基于**当前**版本；若 Lead 正在改同一处，以最终版为准并复审。

**已确认做得对的部分**：ring 有界（`RETENTION_FRAMES=4096`/`RETENTION_MS=5min`，`trim():74-81`）、并发上限 64 与 `TOO_MANY_STREAMS`（`:153`）、`CHAT_NOT_FOUND`（`:152`）、每连接缓冲 1024 且只掉该连接（`:179-192`）、cursor 形如 `seq:index`（`cursorFor`）、replay 只放行内容帧且按 threadId 过滤（`:231-235`）、sync run 用 `sync-<seq>` 前缀 + `live-` 长活 run、MESSAGES_SNAPSHOT 有界（`messages():133-148`，10k/8MiB/1000 页，超限抛错不发残缺）。

**BLOCKER-A（高风险，静默分歧）：快照先于订阅，两者之间的 commit 永久丢失。**
`thread-stream.ts:164-167` 的注释声称「快照先行、随后订阅，落在两者之间的 commit 会包含在快照里并幂等重放，绝不丢失」——**该论证不成立**：

- `state()`（`:166`）扫描完成后、`subscribe()`（`:204`）装 listener 之前落地的 commit，**既不在快照里**（对应 family 已扫完），**也不会被这个订阅投影**（`subscribeCommits` 只在此后回调）；
- 客户端从 `view.seq` 之后直接收到更晚 seq 的帧，**没有 resync、没有任何提示**，永久停在缺该变更的视图；
- 该窗口**不小**：它包含 `messages(threadId)`（`:167`）的整段分页（最多 1000 页 / 8 MiB，每页一次异步 history 读）。「历史较长的线程 + 后台 job 在跑」即可稳定命中；
- 低界 seq + 幂等覆盖救不了它：重叠能容忍「多发」，但**补不回「根本没发」的 commit**；ring 也救不了：新建连接不带 `Last-Event-ID` 时不 replay，且若期间无其它连接，这些帧从未生成。

**建议**：改为「先 `subscribe()`（帧入队缓冲）→ 再读 `view`/`history` → 发 preface → 再消费队列」。这样落在中间的 commit 要么已进 `view`（重复应用幂等），要么从缓冲补上。代价是 `truncatedFamilies`/`counts` 需要延迟提供 → 给 `CommitStreamPort` 增加 rebase/快照元数据入口。

**BLOCKER-B（spec MUST 未实现）：`window_exceeded` / `process_restarted` 永远不可达。**
`:158-162` 只在 ring 找不到 cursor 时置 `'unknown_seq'`，全文件无第二处赋值（runtime lane grep `window_exceeded`/`process_restarted` 无命中），但 `ResyncReason`（`application/thread-stream.ts`）与 spec:231/237-243 要求三者各自可达，tester 的 `reconnect.test.ts` 也会按 spec 断言。
**建议**：ring 非空且 cursor 的 seq 早于 `ring[0].seq` → `window_exceeded`；ring 为空（本进程未发过帧）→ `process_restarted`；格式/其它未知 → `unknown_seq`。

**非阻塞**：
1. cursor 复用风险：`trim():78-79` 在某 seq 的帧全部滑出后删除 `frameIndex` 计数，而同一 commit 的帧可跨 `await resolveRunIdentity` 分散发出 → 极端情况下同 seq 后续帧从 `:0` 重新编号，与已滑出的旧 cursor 撞号。建议保留期内不移除该 seq 计数，或改用全局单调帧号。
2. `lastEventId === undefined` 分支（`:158-162`）与后续 `if (lastEventId === undefined) replayFrom = undefined`（早期版本）存在冗余赋值，建议清理（当前版本已简化，若残留请删）。
3. 流式访问日志与 GET 路由类型：`StreamRoute.method` 目前仅 `'POST'`（`api/routes.ts:55`），而 `api/agui/thread-stream.ts` 已在写 GET 路由（当前编译报 `"GET" is not assignable to "POST"`，属进行中）。扩展时必须保持 `POST /v1/agent` 与 405+`Allow` 语义不变，且流式请求仍走 `logStreamOpen` 脱敏日志。

**未验证（WP6.3 预检）**：真实 SSE 解析/断线重连/慢消费者/并发连接、`Last-Event-ID` 三种 reason 的实际行为、live run 边界与 resync 的交互——全部归 tester；我只做静态审计。

#### 3.3.1 WP6.3 第二轮（Lead 修复后逐条独立验证）

Lead 报告「6/6 通过、check 绿」。我独立复跑：`npm run check` → **exit 0 + boundaries passed**；`node --test apps/server/dist/test/thread-stream.test.js` → **6/6 pass**。逐条回读确认的修复：

| 预检问题 | 复核结果 |
|---|---|
| BLOCKER-A 快照先于订阅 | **顺序已改**：`ensureConsumer()`（`:225`）→ `state()`（`:226`）→ `messages()`（`:227`）→ `setBaseline()`（`:235`），符合「先订阅缓冲再读快照」；但**仍未闭合**，见 §3.3.2-A |
| BLOCKER-B 三种 reason | **确认已修**：ring 空 → `process_restarted`（`:212-214`）；cursor seq < ring 首帧 seq → `window_exceeded`；其余 → `unknown_seq`（`:216-218`） |
| 多连接 N 倍重复 | **确认已修**：runtime 作用域单订阅 + 单 fan-out（`ensureConsumer():163-180`，`handleCommitFrame` 负责 `broadcast`/`sendThread`/`sendLocal`）；测试 `two connections each receive one copy` 断言各 1 份 |
| run 帧 threadId | **确认已修**：`ThreadFrameBody` 的 `run_started`/`run_finished` 带 `threadId`（`application/thread-stream.ts:15-16`），runtime 传入（`:275,283,285`），边缘映射（`api/agui/thread-stream.ts:20-31`） |
| 重放 run 连续性 | **接受该解法**：重放只发内容帧、跳过所有 run 边界、且新 live run 在重放前已开（`:292-301`）→ 不会出现悬空帧。spec 的「不伪造连续」意图仍成立（cursor 不在 ring 即 resync） |
| baseline 参数 | **确认已修**：新增 `setBaseline(meta)`，读完快照立即注入；注入前一律保守发快照（不再有「可选但影响正确性」的参数） |
| cursor 撞号 | **确认已修**：`trim()` 不再删除仍在保留窗口内的 seq 计数，只清理远落后于 ring 首帧者且有上限（`:96-104`） |
| GET 流式路由 | **确认已修**：`StreamRoute.method` 扩为 `'GET' \| 'POST'`（`api/routes.ts:55`），`agentRoute()` 与 `threadStreamRoute()` 并存；`sseFrameWithId` 在 `api/agui/events.ts` 加 `id:` 行，官方 encoder 仍负责 `data:` |

#### 3.3.2 WP6.3 第二轮新发现：**3 个 blocker + 1 个放大问题**（测试均未覆盖）

**BLOCKER-A′（延续预检 A，仍未闭合）：新连接在「快照读完 → 连接注册」之间仍会丢 commit。**
`open()` 在 `:225` 订阅、`:226-227` 读 `view`/`history`，但**连接到 `:239-270` 才 `connections.set()`**；而共享消费循环只投递给已在 map 中的连接（`broadcast():126-129`）。因此落在 `state()` 之后、`connections.set()` 之前的 commit：不在 `view` 里（family 已扫完），也不进本连接队列 → 帧虽进了 ring，但只有带合法 cursor 的连接才会 replay（`:292-301` 需 `replayFrom`）。**fresh 连接（无 cursor）与 resync 分支都不 replay**，于是这些 commit 对客户端永久丢失且无提示。窗口仍包含 `messages()` 的整段分页。
与预检的区别：修复让**重连**路径（`replayFrom` 在 `:209` 提前算好）能覆盖该窗口，而 **fresh/resync 恰是最常走的路径**。
**建议**：(1) 在 `:226` 前就注册连接，把「preface 之前」收到的帧暂存、preface 后按序补投；或 (2) `open()` 开头记 `ringMark = ring.length`，preface 后对 fresh/resync 也补投 `ring.slice(ringMark)` 的内容帧，并把「ring 已 trim 掉 mark」视为需再同步。

**BLOCKER-B′（新）：共享 consumer 一旦出错退出，线程流永久静默。**
`ensureConsumer():164` 是 `if (subscription !== undefined) return subscription;`，catch（`:170-177`）只关连接、**不重置 `subscription`**（全文件仅 `:166` 一处赋值）。消费循环是唯一 fan-out 消费者，退出后无人再迭代 `created.events` → 之后每个新连接都能拿到 preface（快照正常），但**永远收不到任何后续帧，也不报错**。
**建议**：catch 中 `subscription = undefined; baselineReady = false;`，让下一次 `ensureConsumer()` 重新订阅并重启循环。

**BLOCKER-C（新）：线程流把 `OBSERVATION_RESYNC_REQUIRED` 降级成 `INTERNAL_ERROR`。**
`runtime/thread-stream.ts:314` 抛该错误 → `api/agui/thread-stream.ts:122-131` 走 `mapError` → `api/errors.ts:79-92` 无此映射（非 `*_NOT_FOUND`、非 `INVALID_*`）→ `500 INTERNAL_ERROR`，线上发 `RUN_ERROR{code:'INTERNAL_ERROR', message:'internal error'}`。这丢失 WP5 已确立、且 design §6 要求复用的 `OBSERVATION_*` 语义（WP5 的 `api/agui/route.ts:94-100` 有专门映射）。**建议复用同一映射**（或抽公共函数）。

**放大问题 D（新）：单个线程的历史溢出会打掉所有连接，叠加 B′ 后变永久。**
`handleCommitFrame():183-188` 对 `messages_changed` 直接 `await messages(threadId)`，超限（10k 条 / 8 MiB / 1000 页，`:154-156`）抛错 → 冒到 `ensureConsumer` 的 catch → **关闭全部连接**（不只该线程），并触发 B′ 的永久静默。**建议**在 `handleCommitFrame` 内按线程 catch，只结束该 thread 的连接（或发 thread 级 resync），共享 consumer 继续运行。

**非阻塞**：
1. malformed `Last-Event-ID`（`:102-103` 正则不匹配）被**静默忽略**并按 fresh 处理，不发 `point.stream.resync` → 客户端无法区分「cursor 不被认」与「本来没有 cursor」。建议映射为 `unknown_seq`。
2. 边缘丢弃 `truncatedFamilies`（`api/agui/thread-stream.ts:32-37` 只发 `snapshot`）；信息未丢（`view.truncated` 在 snapshot 内），但该字段变为白传，建议用上或删。
3. `messages()` 在每次可见 entry 提交都完整翻页（`:185`）→ 长会话下 O(历史)/帧；虽被上限保护，应写入已知成本/未验证项。
4. 边缘 `write()`（`:74-87`）等 drain 时只监听 `drain`/`close`，未监听 `error`（WP5 `writeFrame` 有）→ 背压期间 socket 出错可能拖到 close 才结束。
5. 测试缺口：`an unknown cursor triggers an explicit resync` 只断言 reason ∈ 三者之一（`thread-stream.test.ts:201`），未分别覆盖 `process_restarted`/`window_exceeded`；且没有 OBSERVATION 错误码、consumer 重启、fresh 连接窗口的用例。

**未验证（WP6.3 第二轮）**：以上均为静态审计与定向套件复核；真实 SSE 断线重连、慢消费者、并发连接、`Last-Event-ID` 三种 reason 的端到端行为仍归 tester。

#### 3.3.3 WP6.3 第三轮（Lead 修复后逐条独立验证）

确认已修（回读代码，不采信自述）：**B′** `catch` 中 `subscription = undefined; baselineReady = false;`（`:175-176`）→ consumer 可重启；**D** `handleCommitFrame` 按线程 try/catch，只结束该 thread 的连接、共享 consumer 存活；**C** `OBSERVATION_TIMEOUT`/`OBSERVATION_RESYNC_REQUIRED` 已进 `STATUS_BY_CODE`(503) 与 `MESSAGES`（`api/errors.ts:42-43,84-85`）并在 `api-v1.md:25` 记录，两个流都能保留原 code；**A′** 尝试以 `ringMark` 补发。另实测官方 `EventSchema` 接受 `threadId: ''`，空 threadId 不会打断流。

**BLOCKER-A″（新，A′ 的实现缺陷）：`ringMark`/`replayFrom` 是数组下标，而 ring 会被 `trim()` 从头部 shift → 补发跳过帧。**

- `ringMark = ring.length`（`:246`）→ `replay(connection, ringMark)`（`:320`）→ `ring.slice(from)`（`:328-335`）；
- `trim()`（`:93-105`）在每次 `record()` 时从头部 `shift()`；窗口内只要发生一次 trim，下标整体前移 k → `slice(mark)` 从更晚处开始，**恰好丢掉窗口内最前面的 k 帧**（即该修复要保住的那批）；
- `replayFrom`（`:209` 由 `findIndex` 得出、`:316` 才使用）同一问题，重连路径同样会跳帧；
- **现实触发**：流空闲超过 `RETENTION_MS`(5 min) 后 `ring[0].at` 已过期 → 下一个 commit 的 `record()→trim()` 即 shift；而「空闲 5 分钟后重连」正是 WP6.3 的主用例。
- **修法**：给 ring entry 一个单调递增 `serial`（或全局 `emitted` 计数），标记存 serial，补发改 `ring.filter(e => e.serial > mark)`；`replayFrom` 改为「cursor 命中 entry 的 serial + 1」。**在会 shift 的数组上下标不能当游标。**

**契约面提醒**：`STATUS_BY_CODE` 新增的不止 spec:171 点名的 `TOO_MANY_STREAMS`/`RUN_NOT_FOUND`，还有 `OBSERVATION_*`、`RUN_FAILED`、`CHAT_NOT_FOUND` 等。它们现在影响**所有** REST 路径的错误映射（不再只是流内映射）。方向合理且 `api-v1.md:25` 已记录，但属超出「两个新码」的契约面扩大，建议在闸门记录里写明，避免被当成无意变更。

#### 3.3.4 WP6.3 第四轮（A″ 与 malformed cursor 复核）

- **A″ 确认已修（修法正确）**：ring entry 增加**单调递增 `serial`**（`:43-44,91,120`），`replayFrom = found.serial + 1`（`:231`）、`ringMark = serial`（`:249`），`replay()` 改为按 `entry.serial < fromSerial continue`（`:328-337`）。这消除了 `trim()` 头部 shift 导致的下标漂移——用 serial 而非下标做游标，正是我建议的做法。**该 blocker 关闭。**
- **malformed `Last-Event-ID` 确认已修**：非 `<n>:<n>` 格式现在显式 `resync = 'unknown_seq'`（`:224-227`），不再静默当 fresh 处理。**该非阻塞项关闭。**
- 定向套件独立复跑：`thread-stream` + `commit-stream` + `read-model` **15/15 pass**，`npm run check` exit 0 + boundaries passed。

### 3.4b WP6.4 运行流（`GET /v1/runs/:runId/stream`）—— 首轮

**做得对的**：`RUN_NOT_FOUND` 在开 SSE 之前抛（非数字 id 与 task 不存在都覆盖，`runtime/run-stream.ts:34-38`）；只观察不取消（`close()` 仅 `clearInterval`，`:104-106`）；每连接缓冲上限 256 + 溢出抛 `OBSERVATION_RESYNC_REQUIRED`（`:44-52`）；`failed` 映射为 `RUN_ERROR{code:'RUN_FAILED'}` 而非谎报 success（edge `:31-38`）；`runId` = Durable task id（`getTask`）；开流即发当前进度（无离线补发，符合「SDK 无 commit 历史枚举」的事实）。

**要处理**：

1. **缺并发上限（实质）**：spec:245-247 是通用 MUST（"Each stream MUST enforce … per-process concurrent-stream cap (64)"，超出 `TOO_MANY_STREAMS`）。线程流有（`:203`），**运行流没有**；每个打开的运行流 = 一个 250 ms 定时器 + 每 tick 一次 `getTask`（Session 线上），无上限可被无限叠加。建议共享同一个计数（两种流合计 64），或改 spec 明确豁免——不要两套各自实现。
2. **任务消失时「静默正常结束」（诚实性）**：`observe()` 中 `task === undefined` 只 `ended = true`（`:58-62`），客户端看到干净关闭——既无 `RUN_FINISHED` 也无 `RUN_ERROR`，无法区分「观察对象不存在」与「正常结束」。建议发显式边界（`RUN_ERROR` + `OBSERVATION_*`/`RUN_NOT_FOUND`）或在文档写明语义。
3. `activityType: 'point.run'` 未进 `protocol-agui.md`/`api-v1.md` 的映射表（此前只冻结了 `point.job`）→ 客户端不知道有第二种 activityType。
4. `OBSERVATION_TIMEOUT` 实际不可达（只有溢出路径）。spec 写「times out **or** overflows」故不违约，但 design §6 列了空闲超时 → 文档需对齐（实现或改文档）。
5. 两个边缘的 `write()`（thread `:74-87`、run `:52-63`）等 drain 时只监听 `drain`/`close`、未监听 `error`（WP5 的 `writeFrame` 有）→ 背压期间 socket 出错可能拖到 close。
6. **无运行流测试**：`apps/server/test/**` 无 `/v1/runs/` 用例，而 spec:257-271 有 4 条 Scenario（不取消、观察中断、未知 run、观察中断不声称失败）。建议指给 tester。

**未验证（WP6.4）**：真实观察中断、断线不取消、并发运行流的实际行为归 tester；我只做静态审计。

### 3.5 跨 lane 与既有契约（部分已验证）

- [ ] 改动前缀仅限本 WP 声明范围。**注意**：roadmap WP6 行当前只写 `api/**`、`storage/**`，而 design/proposal 要求新增 `runtime/**`、`application/**`——`application/**` 属 lane C。这需要 roadmap 口径更新 + Lead 显式裁决（AGENTS.md「需要动别人 lane 的文件时，停下来升级为串行」）。
- [ ] `domain` 不得出现 steel/cdp/puppeteer/rtc；`api`/`application` 不得 import `@earendil-works/*`；`@ag-ui/*` 只在 `api/**`。
- [ ] `/v1` 幂等键、错误信封、`/health/{live,ready}` 形状不变。

---

### 3.6 独立复查四缺口的复核（Lead 报「全部关闭」）

独立复跑：`npm run check` exit 0 + boundaries passed；`node --test apps/server/dist/test/stream-recovery.test.js` **12/12 pass**。以下逐条回读代码、核对测试断言是否非空。

| 缺口 | 复核结论 | 证据 |
|---|---|---|
| 1. resync 漏更新 | **闭合** | resync 分支发完同步 run 后 `replay(connection, ringMark)`（`runtime/thread-stream.ts:330-335`）；`deliver` 增加回退保护：`state_delta`/`activity_snapshot` 且 `frame.seq <= stateSeq` 丢弃、`state_snapshot` 且 `view.seq < stateSeq` 丢弃并推进 `stateSeq`（`:282-290`）。测试 `unknown cursor resync preserves a job completed while history was loading` 真的在 history 加载期间 emit delta 并断言尾部为 `['custom','state_delta']`；`a completed snapshot is not rolled back…` 断言 seq-9 帧被丢、seq-11 帧通过 —— 非空断言 |
| 2. 监听器泄漏 | **闭合** | `commit-stream.ts:141` 的 `detach()` 在 `cancel()`（`:382`）、最后一个 sink 结束（`:362`）、停止路径（`:152`）均被调用；测试 `cancel and projection failure release the SDK listener` 用真实 `Set` 做 mock，5 轮 subscribe/cancel 每轮断言 `listeners.size` 1→0，失败路径断言 0 |
| 3. 快照/增量一致性 | **闭合** | `read-model.ts:92` `state(retries = 3)`；`:188-191` 若 `observedSeq !== seq`（扫描期间有提交）**整轮重扫**，`retries` 耗尽抛 `OBSERVATION_RESYNC_REQUIRED`；测试 `state retries the whole scan…` 断言 10 次 scan（丢弃一轮 + 一致一轮）、`continuous writes…` 断言 20 次 scan（4 轮，每轮 5 个 family）后显式失败 —— 与「20 次 = 4 轮」口径一致。补发窗口被裁剪时显式失败：`thread-stream.ts:269-273`（`ring[0].serial > requiredSerial` 或 consumer 被替换 → 抛错），测试 `a slow snapshot whose catch-up window was trimmed fails explicitly` 用 `RETENTION_FRAMES + 1` 帧触发 |
| 4. 并发上限绕过 | **闭合** | 新增 `runtime/stream-budget.ts`（11 行，`acquire()` 超限抛 `TOO_MANY_STREAMS`，release 幂等）；`open.ts:217` 建一个实例、`:228-229` **同一 budget 传给线程流与运行流**；两侧都在**任何 await 之前**预占（thread `:224`、run `:25`），建立失败释放（thread `:383` catch、run `:88` catch→cleanup）、关闭释放（thread `finish()` `:346-349`、run `stop()`）。测试 `connection slots include pending opens and are released after setup failure`、`thread and run observations share admission…` |

**顺带确认（原 WP6.4 待办）**
- 运行流已改为消费**原生 `subscribeCommits` publication**（`run-stream.ts:75-81`），初始 `getTask` 前先挂监听并保留 `latest`（`:73-87`）→ 无轮询（测试断言 `reads === 1`）、初始读窗口不丢变更（测试 `run changes during initial lookup are preserved`）。
- 空闲超时发 `OBSERVATION_TIMEOUT`（`:68`），不再「静默正常结束」（测试 `idle run observation ends with observation timeout…`）。
- 我上一轮提的「两个边缘 `write()` 未监听 `error`」**撤回**：`response.on('error')` 在 headers 阶段已 `destroy()`，drain 等待会因 `close` 事件被 reject，实际不构成挂起风险。

**仍开放的非阻塞项（不影响四缺口闭合）**
1. `activityType: 'point.run'` 仍未进 `protocol-agui.md` / `api-v1.md` 的映射表（全仓 grep 只在 `run-stream.ts:54` 出现）→ 客户端不知道第二种 activityType。
2. **新行为未文档化**：`state()` 的整轮重试要求扫描期间无提交，因此**持续写入时 `/v1/state` 可能返回 503 `OBSERVATION_RESYNC_REQUIRED`**（而非稍旧快照）。这是比「低界 + 重叠」更严格的语义，建议在 api-v1 的已知边界或 verification-status 未验证项里写一句，避免运维误判为故障。
3. 以上均为静态审计 + 定向套件；**tester 的 100 job/10 chat 独立动态验证仍未完成**，故 G3 仍不应宣布通过（与 Lead 口径一致）。

---

## 4. 未验证项（不得外推）

- **本报告只做到「代码审计 + 定向套件」**：WP6.1–6.4 的静态审计与四条缺口复核已完成（§3.6），但**不做** tester 的独立动态验证（100 job/10 chat `storage.task` 计数、跨进程 SSE 断线重连、并发/慢消费者压测），故 G3 不由本报告宣布通过。
- **「客户端应用 patch == 权威快照」只做了静态审阅**：未动态应用 patch 比对；该断言由 tester（task-5）独立验证。**注意**：tester 当前实现只比 `['chats','jobs','resources','memory']`，跳过 `events`（§3.2.2 已记录）——这与 spec 现在的「events snapshot-only」口径一致，但覆盖面仍窄于「整套视图逐字段」。
- **「不调 `storage.task`」的验证强度**：静态核对（读代码 + grep）+ 定向套件的计数断言（`read-model.test.ts`，我复核过断言非空）；真实 100 job/10 chat 夹具下的**独立**计数验证归 tester。
- **未跑全量测试**：全量 `npm test` 数字是 Lead/tester 口径，我未复跑；我只跑 `npm run check` 与定向套件。
- **未验证真实 provider / 真实长连接**：代理缓冲、半开连接、EPIPE、慢消费者、64 并发上限在高负载下的实际表现不在静态审计范围；`stream-recovery` 用 mock harness/可控 fixture，不是真实 socket 压测。
- **`/v1/state` 持续写入下的 503 失败率**：整轮重试（4 轮）耗尽即失败的行为已有测试，但**高频写负载下的实际失败率与客户端重试行为未测**（Lead 已记入 verification-status）。
- **SDK 事实断言只覆盖本文件列出的条目**：`subscribeCommits` 在**并发 commit** 下的回调顺序、跨 `Harness.close()` 重开的 listener 生命周期、`Seq` 在 SQLite 事务回滚边界上的行为，未逐条探测。
- **`/v1/state` 的 JSON 体积**：设计给了条数上限但未给字节上限，实际响应体积与内存占用未验证。
- **`/inspect` 计数的数值精确性**：13 个键中只有 `chats` 被断言过数值，其余 12 个未验证。
- **`ACTIVITY_DELTA` 未实现**：只发 `ACTIVITY_SNAPSHOT`；两条 activityType（`point.job`/`point.run`）已进 `protocol-agui.md:43-44`，但「只发 SNAPSHOT 不发 DELTA」这一取舍本身未见文档单独说明。
- **100 job/10 chat 下「单 commit 只发 O(变更) 帧」**：未由我动态测量（归 tester）。
- **工具历史快照**：本片显式 defer（`design.md:146-153`），不在审计范围内，也不得被当作已交付。

---

## 5. 结论

- 契约冻结（task-1）的 SDK 事实基础**经独立核对成立**，主要设计取舍（对象键 state、帧级游标、sync 识别、CUSTOM 白名单、工具历史 defer）判定**合理**。
- **1 个契约级 blocker**（§2.3：`/v1/state` 的 `seq` 取上界导致永久丢变更）→ 已修复：design/spec 改为下界，实现 `runtime/read-model.ts:81-85` 确实在扫描**前**取值。**复审通过。**
- **WP6.1（读模型）：第二轮复核结论 = 通过，无 blocker。**（§3.1.4）
- **WP6.2（增量订阅）：首轮 3 blocker → 第二轮复核全部确认已修**（§3.2.6）：
  1. 异常被吞 → 改为 `failAll()` 让订阅者走显式重同步，并顺带加了 pending 上限；
  2. `events` 改为 **snapshot-only**（spec:23/71-75/87），三方口径统一；理由与我的建议 (a) 一致（否则每次提交都越界→每提交一快照→打掉 O(变更)）；
  3. 中途越界 → 影子计数 `crossed` + `bounded_view` 有界快照，并在 spec 换掉了那条不可实现的 Scenario；
  4. 另确认：`jobEvents.status` 已删、`attemptId` 写入事件 data 后身份解析不再受 drain 时状态影响、模块头注释已与代码一致。
     剩 1 条非阻塞：`counts` 是「可选但影响正确性」的参数，建议必填。
- **WP6.3（线程流）：累计 5 个 blocker，全部关闭**（§3.3.2–§3.3.4、§3.6）：
  - A′ 快照先于订阅导致 fresh/resync 丢 commit → 已改为 subscribe → snapshot → `ringMark` 补发；
  - B′ 共享 consumer 出错后永久静默 → catch 中重置 `subscription`/`baselineReady` 并 `ring.length = 0`；
  - C `OBSERVATION_*` 被降级为 `INTERNAL_ERROR` → 错误码进 `STATUS_BY_CODE`(503)，code 保留；
  - D 单线程 `messages()` 溢出打掉所有连接 → 按线程隔离；
  - A″ 补发用会 shift 的数组下标 → 改为**单调 serial** 游标，`trim()` 不再影响补发位置。
- **WP6.4（运行流）：首轮 6 条 → 闭合 5 条**：共享并发准入（`stream-budget`）、无轮询（原生 publication，测试断言 `reads === 1`）、初始读窗口不丢变更、空闲超时 → `OBSERVATION_TIMEOUT`（不再静默结束）、`write()` error 风险**撤回**；仅剩 `point.run` 文档一项（Lead 已补，§3.6）。
- **独立复查四缺口：全部闭合**（§3.6），`stream-recovery` **12/12** 实跑通过。
- **文档项复核（Lead 本轮补充）**：`protocol-agui.md:43-44` 已同时记录 `point.job` 与 `point.run` 两种 activityType；`api-v1.md:29` 与 `verification-status.md:284` 已写明「持续写入时 `/v1/state` 可能 503 且不返回混合时间点旧快照」及其未测边界。**两条非阻塞项关闭。**

**终审口径（可用于 Done/闸门记录）**：

- **代码审计层面：blocker 已清零，可通过代码审计。** 累计发现并关闭 **9 个 blocker**（契约 seq 上界 1、WP6.2 3、WP6.3 4、A″ 1），四条独立复查缺口全部闭合。
- **「通过」的边界**：仅限**静态审计 + 定向套件实跑**（`stream-recovery` 12/12、`thread-stream+commit-stream+read-model` 15/15、`read-model` 5/5）与 `npm run check` exit 0；**不含** tester 的 100 job/10 chat 独立动态验证、真实 SSE 长连接/反向代理/慢消费者/并发压测、真实 provider 增量时序、进程重启端到端。
- **因此 G3 不应由本报告宣布通过**：WP6 的验收判据包含动态结论，须由 tester 的独立验证补齐后由 Lead 过闸。
