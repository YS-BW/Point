## Purpose

让 Agent 在到期时按绝对时间醒来、做可审计判断、把结果送回用户会话，并通过可替换的通知端口提醒用户；重启、错过、取消、修订或通道失败都不能伪造成功。

## ADDED Requirements

### Requirement: Absolute one-shot plan
系统 SHALL 为 Job 保存绝对 UTC 时刻的单次计划，最多两个 occurrence；重启 SHALL 按绝对时刻恢复，不得按“现在+间隔”顺延。到期时多个已错过 occurrence SHALL 合并为一次判断与投递。

#### Scenario: Restart after due
- **WHEN** 服务在 dueAt 之后重启
- **THEN** 计划按绝对时刻继续，只产生一次到期投递

#### Scenario: Missed occurrences merge
- **WHEN** advance 与 due 两个 occurrence 都已过期
- **THEN** 只产生一条 decision、一次会话投递和一次通知

### Requirement: Auditable decision
判断 SHALL 在执行前读取 Job 状态与 revision；取消或修订后的计划 SHALL skip，并记录 decision 与原因。每个计划 SHALL 最多产生两次提醒，超出 SHALL skip `reminder-cap`。

#### Scenario: Cancel before wake
- **WHEN** Job 在计划到期前被取消
- **THEN** decision=skip、reason=job-cancelled，不产生投递成功

### Requirement: Chat delivery idempotency
会话投递 SHALL 只追加一条带来源的 assistant entry；重复执行/重启 SHALL NOT 重复追加；Job cancelled/revision 不符 SHALL 不写聊天。

#### Scenario: Restart during report
- **WHEN** report task 在追加 entry 前后重启
- **THEN** 同一 delivery 不会产生第二条报告 entry

### Requirement: Notification tri-state
外部通知 SHALL 先记录 intent 再调用端口，结果落为 done/unknown/failed；`unknown` 与 `failed` SHALL NOT 自动重发。通知失败 SHALL NOT 改变 Job 完成状态或会话投递结果。

#### Scenario: Channel fails
- **WHEN** 通知端口返回 failed
- **THEN** Delivery=failed，Job 仍 ready，会话结果仍可读，不自动重试

#### Scenario: Unknown result
- **WHEN** 通知端口抛异常或返回 unknown
- **THEN** Delivery=unknown，后续执行不调用端口
