# Design

## Context

依据 [AG-UI 评估](../../../docs/design/protocol-agui.md) 与 [实施路线](../../../docs/design/roadmap.md)：AG-UI 1.0 只作为**边缘投影协议**，内部事件模型不变。事实仍是 Durable documents/entries/tasks；`point.event` 时间线与 v2 派生索引是可重建的派生物。

WP3 已交付：`point.chats`/`point.jobs`/`point.resources`/`point.requests` 索引、`point.memory`、`point.event` 时间线，以及单 commit 写入（实体 + 索引 + 事件同一事务）。
WP4 已交付 `/v1` 的鉴权、错误信封、幂等键、访问日志、404/405 先于鉴权。
WP5 已交付 `POST /v1/agent` 单 run 投影、官方 SDK 校验/编码、有界 `MESSAGES_SNAPSHOT`、`OBSERVATION_*` 语义。

本片补 G3 缺的部分：读模型、增量订阅、线程流、运行流。

## Goals / Non-Goals

**Goals:**

- 客户端能在**不轮询**的情况下维持与服务端一致的 state 与 messages 视图。
- 一次 commit 只产生 O(变更) 帧。
- 断线后能在保留窗口内补发；窗口外能诚实重同步（不伪造连续）。
- 后台执行可被只读观察，观察中断不改变执行状态。
- 所有缓冲/快照/窗口都有显式上限，溢出行为是显式重同步而非静默丢帧。

**Non-Goals:**

- interrupt/resume 人工确认（WP7）。
- 多用户/多租户并发、OAuth、限流（不在路线内）。
- 浏览器集成、RTC/viewer（WP10 冻结、WP14）。
- 把 AG-UI 事件当存储格式；任何持久 schema 变更。
- 逐 run 精确 `usage`（WP5 已论证无法归属，本片不改变该结论）。

## Decisions

### 1. 读模型是派生视图，不是第二事实库

`GET /v1/state` 只从 **v2 派生索引文档**构造：`point.chats`、`point.jobs`、`point.resources`、`point.memory`，外加 `point.event` 的**最近 N 条**用于时间线视图。它**不读实体文档**（`point.chat`/`point.job`/`point.resource`），因为索引就是为这个用途冻结的；更不调用 `Storage.task`/`scanTasks`（那是 job 执行记录，不是产品状态）。

**为什么这条是硬判据**：roadmap 把"100 job/10 chat 夹具下 `/state` 的 `storage.task` 调用 = 0"写成出口判据，本质是防止读模型退化成"扫全表"。索引文档按 kind 扫描是 O(实体数) 的**文档读**，不是 task 表扫描；两者成本模型不同，不能混为一谈。

响应形状（冻结）：

```json
{
  "seq": 1234,
  "chats": {"1": {"id":"1","name":"项目计划","revision":0,"createdAt":0,"updatedAt":0}},
  "jobs": {"job-1": {"id":"job-1","revision":2,"status":"running","updatedAt":0}},
  "resources": {"browser:primary": {"id":"browser:primary","owner":"me","state":"leased","controlEpoch":1,"revision":3,"leaseExpiresAt":0,"updatedAt":0}},
  "memory": {"tone": {"key":"tone","kind":"preference","sourceChatId":"1","revision":1,"updatedAt":0}},
  "events": {"<eventId>": {"id":"...","type":"job.running","aggregate":"job","aggregateId":"job-1","revision":2,"at":0,"data":{"status":"running"}}},
  "truncated": {"jobs": true}
}
```

**各 family 用「以 id 为键的对象」而不是数组**，这是刻意的，理由是让增量帧成立：

- 数组 + JSON Patch 的位置型操作（`/jobs/42`）在删除/插入时会**位移**，patch 不再幂等；断线重发会造成重复插入或错位。
- 对象键型 patch（`/jobs/<id>` 的 `add`/`replace`/`remove`）是**幂等容忍**的：`add` 命中已存在键 = 替换，`remove` 命中不存在键 = 忽略（本契约明确要求客户端这样容忍）。重复应用同一个 patch 不会改变结果。
- 排序不在协议里承诺：客户端自行按 `updatedAt`/`createdAt` 排序。服务端不保证对象键序（JSON 对象本身也无序）。

`seq` 是**扫描开始前**本进程已观察到的最高 commit 序列，即快照的**下界**而不是上界：

> **不能取上界。** 若取"构建完成时的最高 seq"，扫描过程中落地的 commit 会让快照缺少它的变更，而 `seq` 却已越过它 → 客户端从 `seq+1` 订阅，那条变更**永久丢失**且不触发重同步（静默分歧）。这是单进程也会发生的竞态。

因此冻结：`seq` = 开始构建 view 之前读到的 observed seq；**快照内容可能比 `seq` 更新**（扫描期间落地的提交会被包含）。客户端从 `seq+1` 开始订阅，允许与快照**重叠**——因为各 family 是以 id 为键的对象，`add` 命中已存在键 = 替换、`remove` 命中不存在键 = 忽略，重复应用幂等（见上文）。线程流同步 run 的帧游标同样使用这个下界。

**准确含义**：本进程 `subscribeCommits` 观察到的提交；进程启动后尚无提交时为 0。它是增量订阅的游标下界，不是 storage 的全局版本号（SDK 没有公开「当前 seq」getter，见 §2）。进程重启后该值从 0 重新开始，客户端据此必然走重同步（诚实行为，见 §4）。

**memory 只暴露索引字段，不暴露 `value`**：state 是给 UI 渲染列表的，不是给客户端拿全量记忆正文的；正文走既有 `GET /v1/profile`。

有界：`chats`/`jobs`/`resources` 各最多 1,000 条，`memory` 最多 200 条（与 profile 上限同阶），`events` 最多 200 条。超限时**不静默截断**：响应带 `"truncated": {"jobs": true}` 之类的标记，客户端知道要走分页 REST。读模型服务 UI，不服务数据导出。

**响应有界 ≠ 成本有界（必须如实记录）**：`DocumentQuery` 没有 `order`（`types.d.ts:618-622`），事件 id 是随机 UUID，因此取"最新 200 条事件"只能**全扫 `point.event` 再排序**，单次 `/v1/state` 的事件成本是 **O(总事件数)**，不是常量。`chats`/`jobs`/`resources`/`memory` 同样是按 kind 全扫后截断。

这是本片接受的已知限制，不掩饰：roadmap 已列的"长跑状态膨胀 / 事件成本"风险依然成立，WP9 压测时需实测。若要常量成本，需要给事件建尾部索引——那是新的持久 schema，本片明确不做（"无 schema 变更"是承诺）。`/v1/state` 不得被宣传为"有界成本"。

`/inspect` 的 `counts` 同样是 O(总文档数) 的全扫，仅供运维诊断，不得放上热路径。

### 2. `subscribeCommits` 是唯一增量源，且它没有持久回放

核查 `@earendil-works/pi-durable@1.3.0` 公开 API（`dist/types.d.ts:702-703`、`dist/session/session.js:362-366`、`:555-580`）：

```ts
subscribeCommits(listener: (publication: CommitPublication, context: Context) => void): () => void
type CommitPublication = { readonly seq: Seq; readonly changes: readonly CommitChange[] }
```

事实（已核实，非推断）：

- 监听器在 commit **完成后同步**调用；抛错被 `contained()` 捕获并 `report()`，**不会**让 commit 失败，也**不会**跳过其他监听器。
- `changes` 的元素是 `StorageWrite` 子集（conversation/entry/task/submission）加 `DocumentCommitChange`（document/document.copy）。
- **没有** commit 历史查询 API：`Storage` 只有 `document(id, at)` 与 `scanDocuments(query, at)`，`at` 是 `Seq | "current"`。也就是说，可以按 seq 读**某个文档在该 seq 的值**，但**没有**"seq 1000 到 1050 之间发生了哪些 commit"的枚举能力。
- `Seq` 是 `number & {brand}`，单调递增，跨重启保持（由 storage 分配）。

**结论（决定了重连设计）**：增量订阅只能从**订阅那一刻**开始。任何"离线期间的帧"都不存在于 SDK 中，必须由本片自己保留一个有界 ring。

### 3. `STATE_DELTA` 用 RFC 6902，**零额外读取，不从 Chord ops 翻译**

AG-UI 规定 `STATE_DELTA` 是 RFC 6902 JSON Patch。实际机制（与实现一致，不要按旧稿理解）：

- `CommitPublication.changes` 里的 `DocumentCommitChange` **已经携带该文档本次提交后的已采纳值**（`value`，retire 为 `null`）。投影直接用这个值映射成 state 行，**不重读存储、不做全视图比对**。
- 因此一次改 1 个 job 的 commit = **1 条 `add` op、0 次额外读取**；改 3 个 = 3 条 `add`。这是"单 commit 只发 O(变更) 帧"成立的结构性原因。
- 用 `add` 而不是 `replace`：RFC 6902 的 `add` 命中已存在对象成员时就是替换，一条 op 同时覆盖插入与更新，也让重连重叠时的重复应用幂等。
- **不从 Chord `Op` 元组机械翻译**：`["s"]`/`["p"]`/`["m"]` 与 RFC 6902 不同构，翻译会产出客户端应用结果与服务端不一致的 patch。我们只使用 commit 携带的**值**，不解释内部 ops。
- **`events` 族不参与 delta**：它是"最近活动"的有界视图，只随 `STATE_SNAPSHOT` 刷新。若每个 commit 都给它发 patch，`truncated.events` 会几乎随即成立并让每次提交都退化成快照，直接打掉 O(变更) 判据。因此 delta 契约只覆盖 `chats`/`jobs`/`resources`/`memory` 四个族。

**退化路径（三条，都是显式二选一，绝不同时发）**：

1. **批量变更**：一次 commit 的 patch 操作数超过阈值（默认 100），说明是迁移/重建，发 `STATE_SNAPSHOT`（reason `bulk_change`）。
2. **订阅时已截断的 family**：快照带 `truncated` 标记，该 family 之后只发有界快照（reason `bounded_view`）。
3. **订阅后越过上限**：投影按提交累计每族 `add` 数（近似计数，只会高估不会低估），越过该族上限就发有界快照并重新对齐计数（reason `bounded_view`）。高估的代价是偶尔多一次快照，绝不会漏掉淘汰。

**帧顺序必须等于 commit 顺序**：投影可能 await（批量快照、run 身份解析），所以 listener 只入队，由一个**串行 drain 链**按序 await，保证 emit 顺序单调整。串行链本身也有深度上限，超出即让订阅者走重同步，不无限堆积。

**投影异常不静默丢帧**：投影抛错时该 commit 的帧无法生成，所有订阅者被标记结束并走重同步（不假装连续、不挂起等待）。这是绑定契约"不伪造连续"的要求。

### 4. `Last-Event-ID` 是**帧级游标** `<seq>:<n>`，不是 commit seq

**这是一处必须在实现前纠正的设计错误。** 最初想把 `id` 直接设成 commit seq，让同一 commit 的多帧（delta + activity + custom）共享同一个 id。但 SSE 的 `Last-Event-ID` 语义是"客户端收到的**最后一个事件**的 id"：

> 客户端只收到 commit S 的第 1 帧就断线 → 重连报 `S` → 服务端从 S 之后补发 → **S 的剩余帧永久丢失**。

而 JSON Patch **不幂等**，不能"从 S 重发全部帧"来兜底（重复应用 `add` 会插入两次）。因此：

- 帧 id 是 **`<commitSeq>:<frameIndex>`**，`frameIndex` 从 0 开始，在同一 commit 内单调递增。
- `Last-Event-ID` 指向"最后一个**完整应用**的帧"，服务端从该帧**之后**补发，粒度是帧而不是 commit。
- 客户端只需把 `Last-Event-ID` 原样回传，不需要理解 commit 语义。

线程流在进程内维护一个有界 ring：最近 `RETENTION_FRAMES = 4096` 帧或 `RETENTION_MS = 5 分钟`，先到者为准。同步 run 的起始游标同样取**扫描开始前**的 observed seq（下界），快照之后的增量允许与快照重叠，靠幂等覆盖收敛。

重连时：

- 该帧 id 仍在 ring 内 → 从该帧**之后**补发，然后接实时流。
- 该帧 id 已滑出 ring / 未知 / 进程重启 → 发**新的同步 run**（`STATE_SNAPSHOT` + `MESSAGES_SNAPSHOT`），再发 `CUSTOM point.stream.resync` 说明原因（`window_exceeded` / `unknown_seq` / `process_restarted`），value 带 `{reason, requestedId, currentSeq}`。**不发** delta，因为无法证明连续。

**补发窗口必须可证明完整**：快照读取期间到达的帧保存在 ring；若这段时间里 ring 被裁剪、导致"标记 serial 之前的最早保留帧"已不在，补发无法证明完整，此时**显式失败重同步**，而不是发出有缺口的帧序列。同样，resync 分支在发出新快照后**必须补发快照读取期间产生的帧**，否则客户端会带着新快照却停在旧状态。

进程重启后 commit seq 仍从 storage 单调递增（`Seq` 由 storage 分配并持久），但 ring 是空的，因此旧帧 id 必然走重同步。这是诚实行为，不是缺陷。

**明确不承诺**："断多久都能续"。README 与 `protocol-agui.md` 都要写清：保留窗口外只能重同步。

### 5. 线程流承载什么、不承载什么

AG-UI 要求同一条流里的 run **顺序**执行。**冻结的边界**（取代 `protocol-agui.md:68` 的旧措辞）：

- **线程流** `GET /v1/threads/:threadId/stream` **只**承载：同步 run（开流时）、`STATE_SNAPSHOT`/`STATE_DELTA`、`ACTIVITY_*`、`CUSTOM`，以及**run 完成时**的一条 `MESSAGES_SNAPSHOT`（此时新消息已进 Durable，是权威终态）。
- 线程流**不**承载逐 token 文本与工具事件。这些走 `POST /v1/agent` 自己的流（WP5 已交付）。理由：两处同时发同一批 token 会让客户端要么重复渲染，要么需要去重逻辑，而这没有产品收益——前台 run 的消费者就是那条 POST 流的消费者。
- **运行流** `GET /v1/runs/:runId/stream` 承载：该执行的**状态与阶段观察**（`RUN_STARTED` → `ACTIVITY_SNAPSHOT` → `RUN_FINISHED`/`RUN_ERROR`）。**不投影工具调用、文本、逐 token 事件**——这与"宁可不发也不伪造"一致；完整执行事件投影属后续能力。终态 `failed` 走 `RUN_ERROR`，`cancelled` 走 `RUN_FINISHED.outcome.cancelled`。
- 线程流在后台任务生命周期上只发 `CUSTOM point.job.started` / `point.job.finished`（value 形状见 §9，唯一版本），客户端按需打开运行流。这样既不违反顺序 run，也不把并发塞进一条流。

**`runId` 的身份（冻结）**：`runId` = **Durable task id 的十进制字符串**。理由：task 是持久身份，跨重启可查；attempt 是产品语义身份但不是执行身份；WP5 的临时 UUID 只是单次流标识，不可重放。

**运行流"可重放"的正确口径（取代 `protocol-agui.md:69` 的措辞）**：SDK 没有 commit 历史枚举（§2），因此**不能**补发离线期间的事件。运行流是**只读观察**：断线重连后按 task id 重新观察，从**当前状态**继续，并立即发一条 `ACTIVITY_SNAPSHOT` 说明当前进度（让客户端知道错过了多少）；**不**补发历史帧，**不**声称连续。`protocol-agui.md:69` 的"可重放"措辞必须改为"可重连观察（不补发离线事件）"。

### 6. 运行流只观察，不取消、不重放

`GET /v1/runs/:runId/stream` 的语义：

- 打开即观察；客户端断开**不**取消 task（取消要走既有 `POST /v1/jobs/:jobId/cancel`）。观察直接消费 Durable task publication（**不做固定间隔轮询**），并在空闲超时后以 `OBSERVATION_TIMEOUT` 显式结束观察。
- 观察不到（task 不存在）→ 404 `RUN_NOT_FOUND`，**不开** SSE。
- 观察中断（空闲超时/缓冲溢出）→ 发 `RUN_ERROR` 带 `OBSERVATION_TIMEOUT`/`OBSERVATION_RESYNC_REQUIRED`，**只停观察**，不声称执行失败、不重放。
- **线程流与运行流共享同一准入预算**（每进程 64），在异步建立之前预占、建立失败或关闭即释放；两种流各自实现一套上限会造成并发绕过。
- 这与 WP5 已确立的 `OBSERVATION_*` 语义一致，不发明新语义。

### 7. `MESSAGES_SNAPSHOT` 的工具历史：本片**显式 defer**

`protocol-agui.md:37` 要求"工具调用在快照中保留顺序"，WP5 把"全量工具历史"留给 WP6。本片**不做**，理由：

- 工具调用的权威记录分散在 Durable entries 的 `model` 消息与 task records 中，把它们投影成 AG-UI 的 `ToolCall` 形状需要重新定义"一个工具调用在快照里的位置"，这是一个独立的产品决定，不是读模型能顺带完成的。
- 现在做半成品（只有文本、工具缺失）比明确 defer 更糟：客户端会以为快照是完整的。

**因此**：`MESSAGES_SNAPSHOT` 继续是**有界可见文本历史**（沿用 WP5 的 10,000 条 / 8 MiB / 1,000 页），并在事件 `metadata` 里带 `{"point.toolsIncluded": false}` 明确告知客户端"这不是完整工具历史"。`protocol-agui.md:37` 与 `verification-status.md` 的未验证项必须同步改为"工具历史快照待后续 WP"，不得继续写成 WP6 范围。

### 8. `RUN_STARTED(sync)` 的识别方式

官方 `RunStartedEvent` schema **没有** `sync` 字段，不能凭空加（会被 `EventSchema.parse` 拒绝或剥离）。冻结识别方式：

- 同步 run 的 `runId` 固定为 **`sync-<commitSeq>`**（前缀 `sync-`）。
- 同时在 `RUN_STARTED.metadata` 里带 `{"point.sync": true}`（`metadata` 是官方 schema 允许的开放字段）。
- 客户端两条都能用；服务端以 `runId` 前缀为权威判据。

### 9. 本片 CUSTOM 清单（其余显式 deferred）

本片**只发**这三个 `point.*` CUSTOM：

| name | value | 时机 |
|---|---|---|
| `point.job.started` | `{jobId, attemptId?, runId?}` | 后台执行开始（`job.running`） |
| `point.job.finished` | `{jobId, status, attemptId?, runId?}` | 后台执行结束（ready/failed/cancelled） |
| `point.stream.resync` | `{reason, requestedId, currentSeq}` | 重连超出保留窗口 |

`attemptId` 来自**该 commit 事件里记录的 attempt 身份**（不是 drain 时读的可变 current 状态），因此帧不会把旧 seq 标上新 attempt；`runId` = 该 attempt 的 Durable task id，解析不到就省略字段，不伪造。

**显式 deferred**（`protocol-agui.md:45` 映射表里有，但本片不发）：通知、记忆变更、浏览器租约、归档、`point.ui.*`。文档必须标明这些是后续 WP，不是 WP6 缺失项。

### 10. `/inspect` 计数形状（冻结）

```json
{"version":1,"instanceId":"...","phase":"ready","capabilities":["foundation"],
 "counts":{"chats":2,"jobs":10,"attempts":12,"resources":1,"resourceOperations":3,
           "memory":5,"events":120,"schedules":1,"occurrences":1,"decisions":1,
           "deliveries":2,"artifacts":3,"requests":40},
 "countsTruncated":false}
```

- **只数实体族**，不数 v2 派生索引族（`point.chats`/`point.jobs`/`point.resources` 是同一批实体的镜像，再数一遍会出现 `chat`/`chats` 并存的歧义）。
- 键名固定为上面 13 个，不随实现变动。
- 计数是**精确值**；`countsTruncated` 恒为 `false`（保留字段是为了将来真加上限时不必改形状）。
- 老字段（`version`/`instanceId`/`phase`/`capabilities`）一律保留，位置不变。

### 11. 有界性一览（全部是硬上限）

| 项 | 上限 | 溢出行为 |
|---|---|---|
| 线程流 ring | 4096 帧 / 5 分钟 | 旧帧滑出；重连走重同步 |
| 单客户端发送缓冲 | 1024 帧 | 断开该客户端并记录；不影响其他客户端 |
| `STATE_SNAPSHOT` | 与 `/v1/state` 同界（1000/1000/1000/200/200） | 带 `truncated` 标记 |
| `MESSAGES_SNAPSHOT` | 10,000 条 / 8 MiB / 1,000 页（沿用 WP5） | 抛 `OBSERVATION_RESYNC_REQUIRED` |
| 单次 patch 操作数 | 100 | 超过则改发 `STATE_SNAPSHOT` |
| 线程流并发连接 | 每进程 64 | 超出返回 503 `TOO_MANY_STREAMS` |

### 12. 分层：SDK 只能在 runtime lane

`scripts/check-boundaries.mjs` 规定 `@earendil-works/*` 只能从 `runtime`/`storage` import；`api`/`application` 不得出现。因此：

- `application/read-model.ts`：**纯类型**（`StateView`、`StateFrame`、`StreamFrame` 等），无 SDK、无 AG-UI。
- `runtime/read-model.ts`：用 Harness/storage 构造 `StateView`、消费 `subscribeCommits`，输出 application 类型。
- `api/agui/state.ts`、`api/agui/thread-stream.ts`、`api/agui/run-stream.ts`：把中性帧映射为 AG-UI 事件并编码。AG-UI 类型只出现在 `api/**`。
- `api/routes.ts`：新增路由，注入端口。

这与 WP5 的 `runtime/agui.ts` + `api/agui/**` 划分完全同构，不引入新的分层概念。

## Migration Plan

- **无持久 schema 变更**：读模型读既有 v2 索引；ring 是纯内存、可丢弃。
- **回滚**：移除新增路由与 runtime 端口即可；既有 REST 与 `POST /v1/agent` 不受影响。
- **不改变既有数据**：`/v1/state` 只读；`/inspect` 只加字段（既有字段保持）。

## Risks / Trade-offs

| 风险 | 说明 | 缓解 |
|---|---|---|
| 无持久 commit 回放 | SDK 不提供 commit 历史枚举；离线期间的事件无法补发 | 有界 ring + 显式重同步；文档明确不承诺"断多久都能续" |
| patch 正确性 | 自建 diff 而非翻译 Chord ops | 判据是"应用后 == 权威快照"（tester 动态验证），不是"翻译正确" |
| 索引与实体漂移 | 索引是派生物，可能落后于实体 | 索引与实体同 commit 写入（WP3 已保证）；`rebuildEvents` 可重建 |
| 慢消费者 | SSE 写入阻塞会拖垮进程 | 每客户端有界缓冲 + 背压 + 断开；并发连接上限 |
| 读模型被当成权威 | 客户端可能用 state 做决策 | 文档明确 state 是渲染视图；产品决定只走命令/REST |
| `runId` 语义歧义 | task id 与 attempt id 混用 | 冻结 `runId` = task id；attempt 仍走 REST `GET /v1/jobs/:jobId/attempts` |

## Open Questions

- 无。`runId` 身份、保留窗口、重同步原因码、`ACTIVITY` 的 `activityType` 均已在本文冻结。
- 显式留给后续：interrupt/resume（WP7）、逐 run usage（无可靠归属前不发）、attempt/delivery/operation 的完整事件时间线重建（`state-v2.md:77` 的悬空承诺，本片**不**声称补全；如需补全应单列 WP）。
