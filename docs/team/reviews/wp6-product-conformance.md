# WP6 产品口径审核（product conformance，定稿）

> 审核人：product-reviewer（共享任务 task-7）。
> 基线：`main@34813ec` + 未提交的 WP6 工作树（2026-10-19 21:05 定稿）。
> 方法：每条文档承诺 → 找实现证据（`file:line`）/ 测试证据 → 三栏结论：【符合】/【不符合】/【文档需修正】。
> 纪律：本报告**不新增任何验证数字**。数字与时点只写 `docs/design/verification-status.md`；本报告只引用既有条目与证据路径。

---

## 0. 定稿状态

- 实现：WP6.1–6.4 全部进工作树（未提交）——`application/{read-model,thread-stream,run-stream}.ts`、`runtime/{read-model,commit-stream,thread-stream,run-stream,stream-budget}.ts`、`api/agui/{thread-stream,run-stream}.ts`、`api/routes.ts`/`api/http.ts`/`api/errors.ts`/`runtime/open.ts`/`runtime/jobs.ts`，测试 `read-model`/`commit-stream`/`thread-stream`/`stream-recovery`。
- 契约：`openspec/changes/agent-read-model/`（proposal/design/tasks/spec）+ `docs/design/{protocol-agui,api-v1,roadmap,verification-status,status}.md` 已同步大部分口径。
- 独立审计：`docs/team/reviews/wp6-code-audit.md` 已定稿——累计 9 个 blocker 全部关闭；审计明确「代码审计层面可通过，但 G3 不应由审计宣布通过」。
- **未完成**：tester 的独立动态验证（`verification-status` 自述未完成）；OpenSpec 归档/任务勾选；`apps/server/README.md`；`docs/team/status.md` 部分数字。详见 §5。
- **产品口径终审结论见 §8：带条件符合；WP6 出口判据/G3 尚未达成。**

---

## 1. WP6 出口判据（roadmap §2 WP6 行、§3 G3、protocol-agui §六第 6 条）

| ID | 文档承诺 | 期望证据 | 状态 | 结论 |
|---|---|---|---|---|
| E1 | 100 job / 10 chat 夹具下 `/state` 的 `storage.task` 调用 = 0（roadmap:45） | tester 独立夹具（真实 `startServer`+SQLite，包 `SqliteStorage.prototype.task`/`scanTasks`）与报告；Lead 单测的计数断言只作旁证 | **待 tester** | 未达成（尚无独立证据） |
| E2 | 单 commit 只发 O(变更) 帧，不得全量重发（roadmap:45；spec:57-67 已精确为"帧数常量 + patch 操作数 ∝ 变更数"） | tester 动态测帧数/patch、`bounded_view`/`bulk_change` 退化；Lead `commit-stream.test.ts` 只作旁证 | **待 tester** | 未达成 |
| E3 | 离线重连后状态/消息一致（roadmap:45；server-architecture:112） | tester 自写 SSE 解析器 + 原始 socket：断开→`Last-Event-ID`→视图一致、不丢不重；窗口外显式重同步 | **待 tester** | 未达成 |
| E4 | G3 = WP3 + WP6；迁移可回滚，增量事件与重连同步通过（roadmap:85） | WP3 回滚证据已有（`evidence/wp3-wp4-gate-2026-10-19T06-49-53Z.json` 的 `restored backup`）；WP6 侧需 E1–E3 | **未达成（WP6 部分）** | G3 不可宣布通过 |
| E5 | AG-UI 契约测试：未知事件容忍、截断流、重连同步、JSON Patch 应用、并发 run 隔离（protocol:113） | WP5 已覆盖未知/截断；`thread-stream.test.ts` 覆盖 sync run/帧 id/重连/resync/双连接；JSON Patch 应用与并发隔离的独立动态验证归 tester | **部分（待 tester）** | 部分达成 |
| E6 | perf 敏感路径（snapshot/SSE）有夹具规模下的耗时断言（agent-core:79） | 大事件量/大库 fixture 的耗时断言；当前只有规模/边界断言，无耗时断言 | **未达成** | 文档承诺未兑现（可转 WP9 或本片补） |
| E7 | 状态只放索引、不放正文；响应有界（protocol:101；spec:21-31） | `/v1/state` 只读索引族、memory 无 value、bounds+`truncated`；`read-model.test.ts` + `verify/state-read-model.test.ts` | **符合** | 实现与契约一致 |

**判定**：roadmap 三条硬判据（E1–E3）与 G3 **均未达成**，不是"接近"——缺的是 tester 的独立动态证据。Lead 的契约测试与 code-reviewer 的静态审计不能替代。

---

## 2. protocol-agui §六第 3、4 条逐项（`protocol-agui.md:110-113`）

> 状态基于当前实现与 code-reviewer 定稿审计；动态行为仍以 tester 为准。

| ID | 承诺 | 实现/文档现状 | 状态 |
|---|---|---|---|
| P1 | `STATE_SNAPSHOT` | 各 family 以 id 为键的对象（spec:21-31）；`/v1/state`、sync run、bulk/bounded 退化均发该事件 | 【符合】 |
| P2 | `STATE_DELTA` | 标准 RFC 6902；`add` 命中已存在键=替换；只含变化路径；`events` 不参与 delta（spec:23/69-75）；投影直接使用 commit 携带值（design §3 已改为实际机制） | 【符合】（动态等价待 tester） |
| P3 | `MESSAGES_SNAPSHOT` | 同步 run 与 visible entry commit 时发有界文本快照，`metadata.point.toolsIncluded=false`；工具历史显式 defer（spec:107-115/167-175；protocol:37 已改） | 【符合】（WP6 范围内） |
| P4 | `ACTIVITY` | 线程流 job 进度发 `ACTIVITY_SNAPSHOT{activityType:"point.job"}`（replace:true）；运行流发 `ACTIVITY_SNAPSHOT{activityType:"point.run"}`（protocol:43-44 已记两种）。**未实现 `ACTIVITY_DELTA`**；spec:127 用"SNAPSHOT/DELTA"斜杠写法、tasks 3.3 仍写两者，未文档化"只发 SNAPSHOT"的取舍 | 【部分符合 / 文档需修正】D27 |
| P5 | `CUSTOM` | 封闭集：`point.job.started`/`point.job.finished`/`point.stream.resync`；payload 按 design 冻结 `{jobId,attemptId?,runId?}` / `{jobId,status,attemptId?,runId?}`；其余 deferred（spec:117-127；protocol:46） | 【符合】 |
| P6 | `Last-Event-ID` | 帧级游标 `<commitSeq>:<frameIndex>`；有界 ring（4096 帧/5 分钟）；窗口内按单调 serial 补发（A″ 已改 serial，code audit 确认）；窗口外三原因 `window_exceeded`/`unknown_seq`/`process_restarted`；不伪造连续 | 【符合】（tester 重连场景待） |
| P7 | 同步 run + live run | 开流 sync run（`RUN_STARTED`→`STATE_SNAPSHOT`+`MESSAGES_SNAPSHOT`→`RUN_FINISHED`），随后 `live-` 长生命周期 run，所有增量帧在 live run 内，无 run 外帧；resync 先关 live run（spec:89-99/137-147） | 【符合】 |
| P8 | 线程流绑定契约 | 路由 `GET /v1/threads/:threadId/stream`；protocol §3.1 已写帧格式/游标/重同步；**`apps/server/README.md` 未写路由与输入/终止/错误**（api-v1:3 承诺） | 【部分符合 / 文档需修正】D24 |
| P9 | 运行流 | `GET /v1/runs/:runId/stream`，`runId`=Durable task id；只观察、不取消、不补发；原生 `subscribeCommits` 观察（无轮询）；空闲超时 `OBSERVATION_TIMEOUT`；failed→`RUN_ERROR`、aborted→cancelled、completed→success（protocol:71 已收窄为状态/阶段） | 【符合】 |
| P10 | 服务器权威 | `/v1/state` 只读派生；线程流 sync run 以服务端快照替换；输入 state 不写回 | 【符合】 |
| P11 | 不越界到 WP7 | 未实现 interrupt/resume；WP6 未声称支持 | 【符合】 |
| P12 | 帧级游标 | `<commitSeq>:<frameIndex>`，多帧不共享 id；`Last-Event-ID` 指向最后完整应用帧（spec:137-147） | 【符合】 |
| P13 | 线程流与前台 run 边界 | 线程流不发逐 token/工具事件；只承载 sync run/state/activity/custom/完成 messages 快照（spec:105-115） | 【符合】 |
| P14 | CUSTOM 封闭集 | 仅三个名字；通知/记忆/浏览器/归档/`point.ui.*` 显式 deferred（spec:117-127；protocol:46） | 【符合】 |
| P15 | 新错误码与路由文档 | `TOO_MANY_STREAMS`/`RUN_NOT_FOUND`/`OBSERVATION_*`/`CHAT_NOT_FOUND` 已注册（errors.ts），api-v1:25 已记；**`RUN_FAILED` 被 api-v1 列出但未注册**；README 未记 | 【部分符合 / 文档需修正】D23/D24 |
| P16 | 长生命周期 live run | 已冻结并实现；重同步先关 live run；无 run 外帧（spec:137-147） | 【符合】 |
| P17 | 同步 run 识别 | `runId = sync-<commitSeq>` + `RUN_STARTED.metadata.point.sync=true`；无非法字段（spec:89-99） | 【符合】 |
| P18 | live run 连接生命周期 | 一个 live run 只属一个连接；连接结束即结束、不向不存在的流发 `RUN_FINISHED`；补发帧若缺匹配 run 边界则 resync（spec:149-165） | 【符合】（tester 断开场景待） |
| P19 | `/v1/state` 持续写入语义 | 扫描期间有并发提交则整轮重扫，最多 4 轮，仍不一致返回 503 `OBSERVATION_RESYNC_REQUIRED` 而非混合时间点旧快照；api-v1:29 与 verification-status 已写 | 【符合】（非原 spec 措辞，文档已对齐） |
| P20 | `point.run` activityType | protocol:44 已记录 `{runId,status,phase?}`；只出现在运行流 | 【符合】 |

**基线缺口提醒**：P3 的"完整工具历史"仍是 deferred，不是 WP6 缺失项；任何"已交付全量工具历史"的表述都属超范围。

---

## 3. api-v1.md 的承诺

| ID | 承诺 | 现状 | 状态 |
|---|---|---|---|
| A1 | Durable 计数放进 `/inspect`（api-v1:23 原"留 WP6"） | spec:47-63 冻结 13 个实体族 key、只数实体族、`countsTruncated:false`；实现 `runtime/read-model.ts` + `read-model.test.ts`；api-v1:23 已改口径。**README 未记字段** | 【符合】（README 待补，D24） |
| A2 | 路由细节与状态码表在 `apps/server/README.md`（api-v1:3） | README 仍写"Durable 计数留待 WP6/尚未实现"，路由表缺三个新端点 | 【不符合 / 文档需修正】D24 |
| A3 | 新 HTTP 面复用 WP4：错误信封、鉴权 fail-closed、访问日志、404/405 先于鉴权；GET 不需幂等键 | `read-model.test.ts`（401/无幂等键 200）、`thread-stream.test.ts`（未知 thread REST 404）、`run-stream` 404 先于 SSE；errors 映射已注册（除 RUN_FAILED） | 【符合】 |
| A4 | 传输级失败不开 SSE；已受理才开流 | 两个流路由均先 `open()` 再 `headers()`；open 抛错走 REST 信封 | 【符合】 |
| A5 | api-v1.md 的 WP6 口径更新 | §3 已重写并列出新端点/新码；§1 仍为 WP4 历史描述（"后续 WP6 提供…"），可加时点注记 | 【符合】（§1 可择机加注） |

---

## 4. AGENTS.md：当前阶段与十条硬规则

| 项 | 结论 | 证据 |
|---|---|---|
| 不引入第二执行引擎 | 【符合】 | 无新执行引擎；SDK 只在 `runtime/**`（code audit B2/boundaries） |
| 不存第二份事实 | 【符合】 | 读模型/流缓冲均为派生、可丢弃；code audit B1 |
| 副作用三态 / `unknown` 不自动重放 | 【符合】 | WP6 只读；运行流观察不取消、不重放 |
| 写操作幂等键 | 【符合】 | WP6 无新增写端点 |
| domain 不 import 具体实现；SDK 只在 runtime lane | 【符合】 | `npm run check`/boundaries 通过（code audit B2） |
| 单写者 | 【符合】 | 未引入第二写者 |
| 凭据不入日志 | 【符合】 | 流式访问日志复用 WP4 白名单；无新增泄漏点 |
| 证据只增不覆盖 + manifest | 【符合】 | 新证据 `wp6-read-model-2026-10-19T12-15-22Z.json` + manifest 追加；旧证据保留 |
| AG-UI 只在边缘 | 【符合】 | `application/**` 无 AG-UI/SDK；`api/agui/**` 才是 wire 类型 |
| 提交前 check+test | 【符合】 | verification-status WP6 段与 evidence 记录 |
| **"当前阶段"段落准确性** | **【文档需修正】** | `AGENTS.md:17` 仍写"下一片是 WP6"，交付/闸门后必须改（D5） |
| 十条不变量整体 | 【符合】 | 与 agent-core.md 对照未见退化 |

---

## 5. 文档漂移清单（定稿：仍未修项）

> 已关闭（不再列）：D1 状态表主体、D3 roadmap WP6 范围补 runtime、D7 CLI 口径、D11 protocol 工具历史表述、D13 "WP6 已实现"超前声明、D14 sync runId 宽窄、D15/D18 live run 边界、D16 RFC 容忍语义、D17 messages 边界、D19 CUSTOM payload 三版本、D20 patch 机制与死代码、D21 越界检测、D22 events snapshot-only、D26 证据路径。

| ID | 未修项 | 证据 | 严重度 |
|---|---|---|---|
| D2 | OpenSpec：`agent-read-model` 之外 11 个 change 全部 Complete 但 `archive/` 与 `specs/` 只有 `.gitkeep`；`openspec list --specs` 无主 specs | `openspec list`；`openspec/changes/archive/` | 中（流程） |
| D4 | roadmap 阶段叙述仍写 WP6 待做 | `roadmap.md:8`「下一片为 WP6」；`:29`「WP6 增量与重连待完成」 | 低（闸门时改） |
| D5 | AGENTS「当前阶段」仍写"下一片是 WP6" | `AGENTS.md:17` | 低（闸门时改） |
| D6 | api-v1 §1 仍以"后续 WP6 提供…"叙述（历史口径） | `api-v1.md:7` | 低（可加时点注记） |
| D8 | 328 旧值仍标"最终同树验收"，未标"已被取代" | `verification-status.md:229`；`:241` 的取代声明 | 中（易误引） |
| D9 | design README 当前实现段未含 WP6；`point-long-term-foundation` 说明仍以"未归档"为前提 | `docs/design/README.md:65`、`:78` | 低 |
| D10 | `state-v2.md:77` 仍写"后续读模型/事件 WP 补全"（无编号）；WP6 已明确不做 | `state-v2.md:77`；verification-status WP6 段已声明不做 | 中 |
| D23 | api-v1 列出 `RUN_FAILED`，但 `api/errors.ts` 未注册（仅作为 SSE `RUN_ERROR.code`） | `api-v1.md:25` vs `errors.ts` | 低 |
| D24 | `apps/server/README.md` 仍是 WP5 口径：`/inspect` 说"计数留待 WP6/尚未实现"、路由表缺 `/v1/state`、线程流、运行流、新错误码 | `apps/server/README.md:185,190` 与路由表 | **中（闸门阻塞项）** |
| D25 | `agent-read-model` tasks 仅 5/24 勾选；3.1/3.2 的措辞还是旧机制（"re-read only those keys"/"diffing the projected view"） | `openspec list`（5/24）；`tasks.md:20-23` | 中（流程） |
| D27 | `ACTIVITY_DELTA` 未实现但未文档化取舍：spec:127 "SNAPSHOT/DELTA"、tasks 3.3 写两者；实现只发 `ACTIVITY_SNAPSHOT`（`replace:true`） | `spec.md:127`；`tasks.md:22`；`commit-stream.ts`/`run-stream.ts` | 低 |
| D28 | protocol 的"落地中"标记与 WP5 遗留句未在交付后收口：`:60/:112/:113` 仍"落地中"；`verification-status.md:221`（Last-Event-ID/快照/ACTIVITY/运行流属 WP6 不在本片）、`:259`（工具历史属 WP6）需勘误 | 见左 | 低（闸门时改） |
| D29 | `docs/team/status.md` 部分陈旧：WP6 行仍写 340/340（verification-status 已更新为最新证据）；"代码审查 WP6.1/6.2/6.3"漏 6.4 | `docs/team/status.md:9-15` | 中 |
| D30 | verification-status WP6 表写「OpenSpec strict：`agent-read-model` valid 且 **complete**」，但 `openspec list` 显示 5/24 tasks，并未 complete | verification-status WP6 表；`openspec list` | **中（不实陈述）** |

---

## 6. verification-status.md 的最终状态

- 已有 WP6 段（`verification-status.md:260-`），证据路径/时点已修正为实际入库文件 `wp6-read-model-2026-10-19T12-15-22Z.json`；含证据项、边界、未验证项——结构合格。
- 该段自述 **tester 独立动态验证未完成**，因此 E1–E3 仍是未验证；本报告同意，不把 Lead 契约测试当独立证据。
- 仍需在闸门时处理：D8（328 旧值标注）、D28（WP5 遗留句勘误）、D30（"complete" 不实陈述）。
- 本报告不代写任何数字；以上均为口径判断。

---

## 7. 早期风险清单（定稿）

| ID | 状态 | 说明 |
|---|---|---|
| R1/R22/R24/R25/R26/R28/R29/R30 | **已关闭** | runId=task id、CUSTOM payload、threadId、重复帧、messages_changed、resync 三原因、运行流 outcome、证据路径 |
| R15/R16/R17/R27 | **待 tester** | live run 断开/重连、容忍型 patch 应用器、`/v1/state.seq` 下界一致性、跨连接重放边界 |
| R18 | **已接受限制** | `/v1/state` 与 `/inspect` 成本 O(总文档数)，不得宣传为"有界成本"；已进 design/verification-status 未验证项 |
| R20/R21/R23 | **已关闭** | 串行 drain；`bounded_view` + 运行中越界检测；死代码删除、design §3 改为实际机制 |
| R31 | **文档需修正** | `ACTIVITY_DELTA` 未实现但 spec/tasks 仍写 SNAPSHOT/DELTA（D27） |

---

## 8. 产品口径终审结论（定稿）

### 结论：**带条件符合**

**判定范围**：WP6 已冻结契约（`agent-read-model` spec/design + `protocol-agui.md` §3 + `api-v1.md`）与当前实现之间，逐条口径 **【符合】**；未发现"文档说有、代码没有"的实质项（P 项 18 条符合/部分符合、A 项 4 条符合 + 1 条文档未同步），也未发现"代码做了文档禁止的事"。

**条件（全部满足才算 WP6 可放行、G3 可宣布通过）**：

1. **独立动态验证**（不可替代）：tester 按 task-5 完成 E1–E3——100 job/10 chat 下 `storage.task`/`scanTasks` 计数为 0；单 commit 的帧数与 patch 操作数符合 O(变更)、`STATE_DELTA` 应用后等于权威视图；原始 socket 的 `Last-Event-ID` 断线重连一致、窗口外显式重同步。结论写入 `verification-status` 后，G3 才可判过。
2. **文档条件**：
   - `apps/server/README.md` 补三个新端点、`/inspect` counts、新错误码（D24）；
   - `agent-read-model` tasks 勾选完成、清理旧机制措辞（D25）；11 个历史 change 归档/建主 specs（D2）；
   - 修正 verification-status「agent-read-model complete」的不实陈述（D30）与 status.md 的旧数字（D29）；
   - 闸门时更新 `AGENTS.md:17`、`roadmap.md:8/29`、`protocol-agui.md:60/112/113`、`state-v2.md:77`、`docs/design/README.md:65/78`、328 旧值标注（D4/D5/D8/D9/D10/D28）；
   - 明确 `RUN_FAILED` 是流事件码还是 HTTP 码（D23），并文档化"只发 ACTIVITY_SNAPSHOT"的取舍（D27）。
3. **数字纪律**：所有验证数字由 Lead 在 `verification-status` 统一写入；本报告不新增数字。

**如果必须在"符合/不符合"二选一判断"WP6 是否可以宣布完成"：不符合（未达成）**——因为 roadmap:45 的三条出口判据尚未由独立证据确认，G3 不成立。本文的"带条件符合"只描述实现行为与文档口径的一致性，不等于验收通过。

---

## 附录：审核基线索引

- 契约：`openspec/changes/agent-read-model/{proposal,design,tasks,specs/read-model/spec.md}`（工作区未提交）；`docs/design/protocol-agui.md`、`api-v1.md`、`roadmap.md`、`agent-core.md`、`state-v2.md`、`server-architecture.md`。
- 实现：`apps/server/src/application/{read-model,thread-stream,run-stream}.ts`；`runtime/{read-model,commit-stream,thread-stream,run-stream,stream-budget}.ts`；`api/agui/{thread-stream,run-stream}.ts`；`api/{routes,http,errors}.ts`；`runtime/{open,jobs}.ts`。
- 测试：`apps/server/test/{read-model,commit-stream,thread-stream,stream-recovery}.test.ts`；tester 独立套件 `apps/server/test/verify/**`（未完成/未报告）。
- 审计：`docs/team/reviews/wp6-code-audit.md`（定稿，9 blocker 关闭，G3 不宣布通过）。
- 证据：`infra/pi-durable-validation/evidence/wp6-read-model-2026-10-19T12-15-22Z.json`（manifest 已登记）。
