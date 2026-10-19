# 单次计划、判断、会话投递与通知（WP1b.4）

> 2026-10-19。本文件是 WP1b.4 的契约。目标：给已完成/待提醒的 Job 建立一次性计划，在到期时做可审计判断，把结果投递回源会话，并通过可替换通知端口发外部提醒。
> 非目标：周期计划/cron、时区/DST 完整规则、真实通知渠道、浏览器、HTTP、Docker、真实模型报告生成。

## 1. 范围与写作用域

| 文件 | 内容 | owner |
|---|---|---|
| `apps/server/src/domain/schedule.ts` | Schedule/Occurrence/Decision 值对象、状态机、错过合并、提醒上限、错误码 | plan-impl |
| `apps/server/src/storage/schedule.ts` | `point.schedule`、`point.occurrence`、`point.decision`、`point.command.followup` | plan-impl |
| `apps/server/src/application/schedule.ts` | `ScheduleStore`/`FollowupCommands`、严格输入 | plan-impl |
| `apps/server/src/runtime/schedules.ts` | followup task、到期等待、判断、创建 delivery task | plan-impl |
| `apps/server/src/runtime/open.ts` | 组装 followups/delivery/notification，返回端口 | plan-impl |
| `apps/server/src/domain/delivery.ts` | Delivery 值对象、channel/state、错误码 | delivery-impl |
| `apps/server/src/storage/delivery.ts` | `point.delivery` 文档族 | delivery-impl |
| `apps/server/src/application/delivery.ts` | DeliveryStore、NotificationPort、DeliveryCommands | delivery-impl |
| `apps/server/src/runtime/deliveries.ts` | report task（会话投递）、notify task（外部通知） | delivery-impl |
| `apps/server/src/adapters/notification/memory.ts` | 脚本化通知 adapter（仅测试） | delivery-impl |
| `apps/server/test/schedule.test.ts`、`delivery.test.ts`、`notification.test.ts`、`fixtures/followup-crash.ts` | 验收 | senior-tester |

不改 api/bootstrap/config；不改 Job/Attempt 既有语义（followup 只读 Job/Attempt/Artifact）。

## 2. 文档与身份

```ts
type Schedule = {
  id: string; jobId: string; revision: number; sourceChatId: string;
  status: 'active' | 'cancelled' | 'done';
  occurrenceIds: string[]; createdAt: number; updatedAt: number;
};
type Occurrence = {
  id: string; scheduleId: string; jobId: string; revision: number; index: number;
  dueAt: number; state: 'pending' | 'delivered' | 'skipped'; reason: string | null;
};
type Decision = {
  id: string; scheduleId: string; jobId: string; revision: number;
  occurrenceIds: string[]; choice: 'deliver' | 'skip'; reason: string;
  policy: 'point.followup.v1'; createdAt: number;
};
type Delivery = {
  id: string; jobId: string; scheduleId: string; occurrenceIds: string[]; revision: number;
  channel: 'chat' | 'notification';
  status: 'intent' | 'attempting' | 'done' | 'unknown' | 'failed';
  attempts: number; result: string | null; error: string | null;
  createdAt: number; updatedAt: number;
};
```

- `schedule` 创建 1 个或 2 个 occurrence：`advanceAt?` 在前、`dueAt` 在后；每个 (jobId, revision) 最多一个 schedule、最多 2 轮提醒（`提醒次数上限`）。cap 按 **已交付 occurrence 轮次** 计数，不按 chat+notification delivery 条数；一轮同时产生 chat/notification 两条 delivery，不能因此提前耗尽下一轮。单 schedule + 最多 2 occurrence 使集成路径不会触发 cap，cap 由 domain policy 边界用例覆盖。
- 所有命令带 requestId；收据键 `schedule:${jobId}:${requestId}` / `cancel:${scheduleId}:${requestId}`；同键同指纹返回首次结果，异参 `IDEMPOTENCY_CONFLICT`。
- `schedule` 需要 `expectedRevision`，且 **Job.status 必须为 `ready`**（非 ready → `JOB_NOT_READY`）；Job 不存在/已取消/`REVISION_MISMATCH` 拒绝。同一 `(jobId, revision)` 只允许一个 schedule（`ScheduleHeads`；重复 → `SCHEDULE_EXISTS`），防止多个 schedule 绕过“每 Job 最多 2 次提醒”。
- 显式 `sourceChatId` 必须等于 `Job.sourceChatId`，否则 `INVALID_COMMAND`。`dueAt`/`advanceAt` 是绝对 UTC 毫秒，允许过去时刻（用于错过测试）。

## 3. 命令

`runtime.followups`：

```ts
schedule({requestId, jobId, expectedRevision, dueAt, advanceAt?, sourceChatId?}) -> {scheduleId, occurrenceIds}
cancel({requestId, scheduleId}) -> {scheduleId, status}
get(scheduleId) -> Schedule | undefined
occurrences(scheduleId) -> Occurrence[]
decisions(jobId?) -> Decision[]
deliveries(jobId?) -> Delivery[]
```

`cancel` 只把 active schedule/occurrence 置 cancelled/skipped；不改 Job 状态。Job cancel/amend 不主动改 schedule，由判断阶段读 Job 状态/revision 后 skip（取消/修订竞态）。**已经由判断 commit 创建的 delivery 不会因随后 cancel schedule 而撤回**：Report/Notify task 只 fence Job 状态/revision；in-flight 投递仍可能发生。这与“取消不撤销已发生外部动作”一致，调用方不应把 cancel 当作投递撤回。

## 4. Followup task

`point.job.followup`（version 1，background，conversation-owned，input `{scheduleId}`）：

1. 读 schedule；不存在/cancelled/done → terminal。
2. 找 pending occurrence，按 dueAt 升序；没有 → 标 schedule done，terminal。
3. `runtime.sleep(earliest.dueAt)`；恢复后重新读取（不按“现在+间隔”顺延）。
4. 醒来后取所有 `dueAt <= now` 的 pending occurrence（**错过合并**）：多个一起处理，只产生一个 decision。
5. 判断（policy `point.followup.v1`）：
   - Job 不存在/status cancelled → skip `job-cancelled`；
   - Job.revision !== schedule.revision → skip `stale-revision`；
   - Job.status !== 'ready' → skip `job-not-ready`（运行中/失败的工作不能被伪报完成）；
   - 已交付 occurrence 轮次 >= 2 → skip `reminder-cap`；
   - 否则 deliver。
6. 一个 commit：Decision + occurrence 全部 delivered/skipped + Delivery(chat, intent) + `point.job.report` task + Delivery(notification, intent) + `point.job.notify` task。commit 后若还有 pending occurrence，继续循环；否则 schedule done，terminal。
7. abort/cancel：terminal，不创建新 delivery。

## 5. 投递与通知

`point.job.report` task（input `{deliveryId}`）：

- 读 Delivery/Job；Delivery 非 intent 或已 done/unknown/failed → terminal（幂等）。
- Job 不存在/cancelled/revision 不一致 → Delivery.failed(`job-not-current`)，不写聊天。
- Job.status !== 'ready' → Delivery.failed(`job-not-ready`)，不写聊天（防止“已完成”文案伪报运行中/失败工作）。
- 同一 commit：Delivery.attempting + 追加一条 assistant entry 到 source chat（`kind:'point.report'`，data 含 jobId/deliveryId/occurrenceIds；文本含 title、result、artifactId/路径提示）；Delivery.done。
- 会话投递不使用模型生成报告；失败不伪造成功；一条 delivery 只追加一次。

`point.job.notify` task（input `{deliveryId}`）：

- Delivery 非 intent → terminal（幂等，不重发）。
- 读 Job；不存在/cancelled/revision 不一致 → failed(`job-not-current`)；status !== 'ready' → failed(`job-not-ready`)；均不调用端口。
- 一个 commit：Delivery.attempting（attempts+1）。
- 调 `NotificationPort.send({deliveryId, target, title, text})`：
  - 成功 → done；返回 `failed` → failed；抛异常/返回 `unknown` → unknown。
- `unknown` 禁止自动重放；`failed` 也不自动重试（本轮无重试命令）。外部失败不得改变 Job/chat 投递状态。

`NotificationPort` 位于 application，`adapters/notification/memory.ts` 仅测试：脚本化 `delivered|failed|unknown|throw`，记录每次调用；默认不接真实渠道。target 本片固定 `'test'`；真实渠道的 target/凭据/限流/unknown 核销不在本片。

**已知限制**：Report 只展示 Job result 与 artifact 引用，不重新核对 artifact hash；文件完整性以 `jobs.artifact()` 的 verify 为准，报告不能替代它。同 (jobId, revision) 的 schedule 一旦 active/done 不能再建；重新安排提醒需 amend 到新 revision，或先 cancel 再 schedule（cancelled 可替换 head）。

## 6. 失败矩阵（必须测）

1. 到期重启恢复：dueAt 前后 SIGKILL/close，重启后按绝对时刻继续，不重复 reminder。
2. 错过合并：advanceAt 与 dueAt 都在过去，只产生一条 decision、一次 chat delivery、一次 notification。
3. 提醒上限：最多 2 次；超过后 skip `reminder-cap`。
4. 取消竞态：Job cancel 在 wake 前/判断后/投递前 → skip 或不投递；不产生成功。
5. 修订竞态：Job revision 变化 → skip `stale-revision`；不覆盖新 revision。
6. 通知失败不伪成功：memory adapter failed/unknown → Delivery.failed/unknown，Job/chat 不受影响；不自动重发。
7. 重试不重复投递：同 delivery id 重复执行/重启 → chat 只一条、notification 只一次；unknown 不重放。
8. 既有 127 项不回归。

## 7. 完成判据

- `npm run check`、`npm test` 全绿；新增 schedule/delivery/notification 测试可独立运行；至少一个 followup SIGKILL fixture。
- 独立 reviewer 通过（无未解决 blocker）。
- verification-status/README/evidence/OpenSpec 同步；未验证项明确（真实通知渠道、周期/时区/DST、真实模型报告、HTTP、Docker、长跑）。
