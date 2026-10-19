# WP1b.4 单次计划、判断、投递与通知独立评审（code-auditor）

> 2026-10-19。评审对象：分支 `wp/1b-plan-delivery`（基线 `ead710b`，WP1b.3 之后）上的 WP1b.4 工作树改动。
> 评审人：code-auditor（独立于实现作者）；作者：plan-impl / delivery-impl / senior-tester；契约与裁决：lead。
> 依据：[plan-and-delivery 契约](../../design/plan-and-delivery.md)、[agent-core 十条不变量](../../design/agent-core.md)、[评审检查清单](../review-checklist.md)、[trigger-and-jobs](../../design/trigger-and-jobs.md)、[delivery-layer](../../design/delivery-layer.md)。
> 收尾复核后定稿：B1/P1/T1–T3 已修复并复核；官方 162/162。

## 1. 结论

**通过（无未解决 blocker）。**

- **B1（已解决）**：对 running/failed Job 建计划会投递“已完成”并发送通知。修复：`schedule` 要求 `Job.status === 'ready'`（`JOB_NOT_READY`）；判断在 revision 之后增加 `job-not-ready` skip；Report/Notify task 同样 gate `job-not-ready`，不写聊天/不调端口。契约 §2/§4.5/§5 同步。
- **P1（已解决）**：多个 schedule 可绕过“每 Job 最多 2 次提醒”。修复：`ScheduleHeads` 以 `${jobId}:${revision}` 限制一个 current schedule；active/done 重复 → `SCHEDULE_EXISTS`，只有 cancelled 可替换。契约 §2 同步。
- **T1–T3（已解决）**：domain `complete/fail` 终态幂等；memory adapter 脚本耗尽先抛不记录；tester 修正 interrupted-attempting fixture（先 `initialDelivery` 再覆盖状态）。
- 最终验证（我以官方 dist 只读复跑）：**162/162 pass**（server 152 = 既有 117 + 新增 35；scripts 10）；targeted schedule/delivery/notification **35/35**（15/9/11）；`tsc --noEmit` exit 0；`check-boundaries` passed；build 由 lead/tester 官方窗口 exit 0。
- Scope 干净：9 个新增 src + 1 个修改（`runtime/open.ts`）+ 3 测试 + 1 fixture + 契约/OpenSpec；未改 `api/**`、`bootstrap.ts`、`config.ts`，既有 127 项测试未修改且全绿。
- 仍有 1 处**契约措辞**与实现/产品规则不一致（reminder-cap 的计数口径，见 P2）以及若干已知限制（§7/§8），均非阻塞；`verification-status`/README/evidence/OpenSpec 属 task-19（G1 收尾）。

## 2. 评审范围与方法

- 新增：`domain/schedule.ts`、`storage/schedule.ts`、`application/schedule.ts`、`runtime/schedules.ts`；`domain/delivery.ts`、`storage/delivery.ts`、`application/delivery.ts`、`runtime/deliveries.ts`、`adapters/notification/memory.ts`；`test/schedule.test.ts`、`delivery.test.ts`、`notification.test.ts`、`fixtures/followup-crash.ts`；`docs/design/plan-and-delivery.md`、OpenSpec `agent-plan-delivery`。
- 修改：`runtime/open.ts`（组装 followups/deliveries、session document scanner、notification 端口、返回新端口）。
- 方法：只读代码/测试 + 官方 dist 只读执行 + `/tmp` 独立探针：running/failed Job 计划、repeat schedule、sourceChatId 分叉、错过合并、两次提醒、cancel/amend/job-cancel 竞态、notification failed、通知端口缺省。
- 复核结果：

| 命令 | 结果 |
|---|---|
| `node --test apps/server/dist/test/*.test.js scripts/*.test.mjs`（只读） | **162/162 pass**（server 152 + scripts 10） |
| `node --test .../schedule.test.js delivery.test.js notification.test.js` | **35/35 pass** |
| `npx tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| `node scripts/check-boundaries.mjs` | `Architecture boundaries passed` |
| `npm run build` | exit 0（lead/tester 官方窗口） |

## 3. Blocker / 审计修复项（全部关闭）

### B1（已解决）非 ready Job 的计划会伪报完成

- 发现（修复前 probe）：start job 并卡住模型（attempt running）→ `followups.schedule({expectedRevision:1, dueAt: past})` → decision `deliver:due-reminder` → source chat 追加 `工作「进行中任务」已完成。产物：无`，notification adapter 调用 1 次；Job 实际仍 `running`。failed Job 同样被伪报完成。
- 修复：`runtime/schedules.ts:306` schedule 非 ready → `JOB_NOT_READY`；`domain/schedule.ts:173` 判断新增 `job-not-ready`；`runtime/deliveries.ts:171/234` Report/Notify 非 ready → `failed(job-not-ready)`，不写聊天/不调端口；`domain/delivery.ts:153 reportText` 的“已完成”现在只在 ready job 路径出现。契约 §2 line 52、§4.5 line 81、§5 line 93/100 同步。
- 复核：我的 probe 复跑 → running/failed schedule 均 `JOB_NOT_READY`；wake 时非 ready 由 tester 用例覆盖（schedule.test:477）→ skip `job-not-ready`、无 delivery。

### P1（已解决）多个 schedule 绕过提醒上限

- 发现（修复前 probe）：同一 ready Job revision 建两个 schedule（不同 requestId）→ 2 个 decision、2 条 chat 报告、2 次 notification（共 4 次投递）。
- 修复：`storage/schedule.ts:12 ScheduleHeads`，key `${jobId}:${revision}`；`runtime/schedules.ts:317` active/done 重复 → `SCHEDULE_EXISTS`，仅 cancelled 可替换。契约 §2 line 52 同步“每 Job 最多 2 次提醒”。
- 复核：probe → 第二次 schedule `SCHEDULE_EXISTS`，同 requestId 重放返回首次结果；tester 用例 schedule.test:438。

### T1–T3（已解决）

- T1：`domain/delivery.ts:112/124` 对终态 Delivery 的 `completeDelivery`/`failDelivery` 返回原值（幂等），非终态非法转移仍抛；`markDeliveryUnknown` 仍要求 attempting（unknown 终态不可重标），与测试断言一致。
- T2：`adapters/notification/memory.ts:42-43` 脚本耗尽先抛 `NOTIFICATION_SCRIPT_EXHAUSTED`，不记录调用。
- T3：interrupted-attempting 测试改为 `{...initialDelivery(...), status:'attempting'}`（先构造再覆盖），不再被 helper 丢掉状态。

## 4. 实质意见与剩余发现

1. **P2（非阻塞，契约措辞需修）reminder-cap 计数口径不一致。** 契约 §4.5 line 82 写“已交付次数（同 schedule 的 chat+notification delivery）>= 2 → skip reminder-cap”；实现/domain 计数的是**已 delivered 的 occurrence 次数**（`runtime/schedules.ts:209`、`domain/schedule.ts:174` 的 deliveredCount + batchSize）。这两个口径不同：每一轮提醒会创建 chat+notification 两条 delivery，按 delivery 计数会在第一轮后就达到 2、把第二轮也 skip 掉，与已确认产品规则“提前一次 + 到期追问一次”以及 `two reminder rounds` 测试（2 decisions/2 chat/2 notify）矛盾。按 occurrence/提醒轮次计数才是正确语义。另因一个 (job, revision) 只有一个 schedule、occurrence 最多 2 个，`reminder-cap` 在实际集成路径**不可达**（tester 已如实报告）；domain 边界有直接用例（schedule.test:103）。建议 task-19 把契约改为“已 delivered 的 occurrence（提醒轮次）>= 2”，并注明“集成层 cap 不可达、由 occurrence 上限保证，domain 用例覆盖”。
2. **P3（非阻塞，行为需文档化）取消 schedule 不撤回已创建的 delivery。** `cancel` 只把 schedule/occurrence 置 cancelled/skipped 并 abort followup task（`runtime/schedules.ts:348-387`）；若判断 commit 已经创建了 Report/Notify delivery 与 task，这两个 task 只 fence Job（ready/revision/cancelled），不读 schedule 状态，因此仍可能投递。与“已发生的外部动作不被伪装撤销”一致，但用户取消提醒后仍可能收到已 in-flight 的投递。建议契约 §3/§4 写明“取消只阻止未来判断；已落盘的 delivery 不撤回”，或后续在 delivery task 内加 schedule 状态检查（需要产品决定）。
3. **P4（非阻塞，已知限制）通知 target 硬编码 `'test'`。** `runtime/deliveries.ts:65 NOTIFICATION_TARGET`；memory adapter 不关心 target；真实渠道接入时需要从配置/计划携带 target，并在 Delivery 文档或端口请求中定义目标语义。本轮非目标，建议写入未验证项。
4. **P5（非阻塞，证据边界）Report/Notify 只 gate Job，不重新核对 artifact hash。** Job ready 时 artifact 已 sealed+verifed；若之后文件被篡改，chat 报告仍会投递 artifactId/路径（文案不断言 hash）。`jobs.artifact()` 的 verify 仍是核对入口；建议 README 写明“报告展示产物引用，不替代 verify”。
5. **P6（非阻塞）一个 (job, revision) 的 schedule 一旦 done/active 就不能再建。** 重新安排提醒需要 amend 到新 revision 或先 cancel 再 schedule（ScheduleHeads 只允许 cancelled 替换）。这是 P1 修复的直接后果，建议契约/README 说明。

## 5. 逐条检查（review-checklist：通用十条）

1. **事务边界**：schedule 单 commit（收据 + Schedule + Occurrences + followup task，`runtime/schedules.ts:291-345`）；cancel 单 commit（收据 + schedule/occurrence 状态，`:348-384`）；判断单 commit（Decision + occurrence 状态 + 2 个 Delivery(intent) + ReportTask/NotifyTask，`:193-271`）；Report 单 commit（Delivery done + `point.report` entry + task terminal，`runtime/deliveries.ts:180-190`）；Notify 严格 intent → attempting（commit）→ send → done/failed/unknown（commit）。**通过**。
2. **幂等键**：schedule/cancel 收据键 `schedule:${jobId}:${requestId}` / `cancel:${scheduleId}:${requestId}`，同键同指纹重放/异参冲突（`runtime/schedules.ts:296/360`，测试 schedule.test:438）；delivery 任务按 Delivery 状态幂等（非 intent 不再执行/发送）；判断批次由 occurrence 状态保证不重复创建 Delivery。**通过**。
3. **副作用三态**：notification `intent→attempting→done|failed|unknown`；`unknown`/`failed` 终态不自动重试/重放；崩溃后 attempting → unknown('interrupted')（`runtime/deliveries.ts:210-219`）；异常→unknown；无端口→failed NOTIFICATION_NOT_CONFIGURED；chat 投递失败不伪成功、不影响 Job。**通过**。
4. **状态与迁移**：新增 doc kinds 均 version 1（`point.schedule`/`point.occurrence`/`point.decision`/`point.command.followup`/`point.schedule-head`/`point.delivery`/`point.report` entry）；不改既有 schema/Meta，无需迁移。**通过**。
5. **依赖方向**：domain 无 import；application 只 import domain；adapter 只 import application；runtime 才 import SDK；`check-boundaries` 通过；domain 无 `node:`/SDK。**通过**。
6. **错误契约**：`ScheduleError`（INVALID_COMMAND/IDEMPOTENCY_CONFLICT/REVISION_MISMATCH/JOB_NOT_FOUND/JOB_TERMINAL/JOB_NOT_READY/SCHEDULE_EXISTS/SCHEDULE_NOT_FOUND）与 `DeliveryError` 稳定；notification outcome 映射 done/failed/unknown。**通过**。
7. **测试**：见 §6；失败矩阵主要项有覆盖；cap 集成不可达与 cancel-after-judgment 为已知/未覆盖（诚实写入 §8）。**通过（附限制）**。
8. **文档与证据**：契约已随 B1/P1/sourceChatId/新增错误码更新；`verification-status`/README/evidence/OpenSpec 属 task-19，**合并前必须完成**。**部分完成**。
9. **性能敏感路径**：无 snapshot/SSE/迁移；判断/delivery 均为有界小集合；`decisions/deliveries` list 用 session document scan（全量、无分页）——本片数据量小，属后续 API/读模型治理。**不适用/可接受**。
10. **写作用域**：仅契约列出的文件 + `open.ts` + 3 测试 + fixture + docs/openspec；未改 `api/**`、`bootstrap.ts`、`config.ts`，未改既有 127 项测试/依赖；实现期临时文件已清理（复核时无 stray）。**通过**。

## 6. 契约 §6 失败矩阵对照

| # | 要求 | 覆盖 |
|---|---|---|
| 1 | 到期重启恢复：绝对时刻，不重复 reminder | `schedule.test.ts:367`（close 后绝对时间恢复）、`:392`（SIGKILL before-due，fixture `followup-crash.ts`）、`:224`（absolute occurrences/stale/cancelled） |
| 2 | 错过合并：advance+due 都在过去 → 1 decision、1 chat、1 notification | `schedule.test.ts:282`；我的 probe 复核：1 decision（2 occurrenceIds）/1 chat report/1 notify |
| 3 | 提醒上限最多 2 次，超限 skip reminder-cap | `schedule.test.ts:103`（domain 边界）；`:301` 两次提醒后无第三次；集成层 cap 不可达（occurrence 上限 + 单 schedule），见 P2 |
| 4 | 取消竞态：Job cancel 在 wake 前/判断后/投递前 skip/不投递 | `schedule.test.ts:321`（cancel schedule 不 wake）、`:336`（job-cancelled）；判断 commit 内 re-read Job/ schedule fence；P3 说明已落盘 delivery 不撤回 |
| 5 | 修订竞态：revision 变化 → skip stale-revision，不覆盖新 revision | `schedule.test.ts:350`；probe 复核 skip stale-revision、0 notify |
| 6 | 通知失败不伪成功：failed/unknown → Delivery.failed/unknown，Job/chat 不受影响，不自动重发 | `notification.test.ts:102/115/125/137/145/153/171/182`；probe failed → chat done/notify failed/Job ready |
| 7 | 重试不重复：同 delivery 重复执行/重启 chat 一条、notification 一次；unknown 不重放 | `delivery.test.ts:164/182`、`notification.test.ts:102/145/190`；Report 单 commit + 状态幂等 |
| 8 | 既有 127 项不回归 | 官方 162/162；既有 117 服务端 + 10 scripts 全过 |

## 7. 非阻塞建议

- **N1（task-19 文档）**：修契约 §4.5 reminder-cap 口径（P2）；写入 P3（取消不撤回已落盘 delivery）、P4（notification target 未接入）、P5（报告不替代 verify）、P6（同 revision 只能一个 schedule）到契约/README/未验证项。
- **N2（后续）**：真实通知渠道接入时定义 target/凭据/限流/退避与 `unknown` 的查询核销；本片 memory adapter 仅协议验证。
- **N3（后续）**：`decisions/deliveries` 查询目前全量 scan；WP4/读模型接入时加分页/索引（不要在 API 前假设数据量）。
- **N4（可选测试）**：补 cancel-after-judgment 的确定性用例（可用可控 adapter 延迟 + 在 delivery task 执行前 cancel schedule），断言当前“仍可能投递”的行为被文档化，避免未来误判。
- **N5（低优先）**：`schedule` 的显式 `sourceChatId` 现在只允许与 Job 相同（否则 INVALID_COMMAND，契约 line 53）；可考虑从公开输入移除该字段以减少误导，或保留并文档化“仅重述”。

## 8. 未验证项与已知限制

- 真实通知渠道、时区/DST 与周期计划、真实模型报告生成、HTTP、Docker、长跑：均为非目标/未验证。
- reminder-cap 在集成路径不可达（单 schedule + 最多 2 occurrence；domain 边界用例覆盖）；契约计数措辞待修（P2）。
- 取消 schedule 不撤回已创建的 delivery；判断 commit 之后取消仍可能收到 in-flight 投递（P3，未做确定性测试）。
- notification target 目前硬编码 `'test'`；无真实渠道、无凭据、无限流/退避/查询核销（P4）。
- Report/Notify 不重新核对 artifact hash（Job ready 门禁 + `jobs.artifact()` verify 分离；P5）。
- 优雅关闭/强杀下 followup 的绝对时间恢复与 exactly-once 有 fixture 覆盖；delivery 任务的崩溃窗口由 Delivery 状态（attempting→unknown）覆盖，未做独立 SIGKILL fixture。
- 单进程语义；多进程/多客户端订阅、通知读回执均未验证。

## 9. 写作用域与越界检查

- `git status` 仅：9 个新增 src、`runtime/open.ts` 修改、3 个测试 + 1 fixture、`docs/design/plan-and-delivery.md`、OpenSpec change、本评审文件。
- 未触碰 `apps/server/src/api/**`、`bootstrap.ts`、`config.ts`；未改既有 117 服务端 + 10 scripts 测试；未改 `package.json`/依赖；实现期 `.tmp-*`/`.followup-*` 临时文件已清理（复核时不存在）。
- 本评审只写 `docs/team/reviews/wp1b-4-plan-delivery.md`，未改源码/测试/scripts，未执行 git 写操作。

## 10. 审计探针（/tmp，不写入仓库，最终版对官方 dist 复跑）

| 场景 | 结果 |
|---|---|
| 对 running Job 建计划（B1 修复前/后） | 修复前：deliver + “已完成” chat + notify；修复后：`JOB_NOT_READY` |
| 对 failed Job 建计划 | `JOB_NOT_READY` |
| 同 (job, revision) 第二次 schedule / 同 requestId 重放（P1） | `SCHEDULE_EXISTS` / 返回首次结果 |
| 显式 sourceChatId 与 Job 不同 / 相同 | `INVALID_COMMAND` / 成功（仅重述） |
| 错过合并（advance+due 均过去） | 1 decision（2 occurrenceIds）/1 chat report/1 notification |
| 两次提醒（advance 过去、due 未来） | 2 decisions/2 chat/2 notify，schedule done |
| cancel schedule before due | schedule cancelled，0 delivery，0 notify |
| amend before due | decision skip `stale-revision`，0 notify |
| Job cancel before due | decision skip `job-cancelled`，0 notify |
| notification failed | chat done、notification failed、Job ready 不变 |
| 既有测试 | 官方 162/162（既有 117 + 10 scripts 全过，新增 35） |

## 11. 收尾状态

- 审计后代码仅按 lead 裁决修复 B1/P1/T1–T3（plan/delivery/domain/storage/open + tests），契约同步更新；复核后未见其他代码漂移。
- 官方：`npm test` 162/162、targeted 35/35、`npm run check` 通过、`npm run build` exit 0。
- 结论：**通过**。合并/G1 前完成 task-19 文档/证据/验证状态收尾（N1），并如实标注 §8 限制（尤其 P2–P6）。
