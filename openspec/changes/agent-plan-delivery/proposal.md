## Why

WP1b.3 已能让用户交代的工作完成并封存产物，但工作完成后没有回到会话、没有到期提醒、也没有可审计的判断与外部通知端口。本片建立单次计划、判断、会话投递与通知三态，完成 WP1b 的最后一块。

## What Changes

- 新增 `point.schedule`、`point.occurrence`、`point.decision`、`point.delivery`、`point.command.followup` 文档族。
- 新增 `runtime.followups`：schedule/cancel/get/occurrences/decisions/deliveries。
- 新增 `point.job.followup` task：绝对时刻等待、恢复重读、错过合并、最多 2 次提醒、取消/修订判断、单 commit 写 decision+occurrence+delivery intent+tasks。
- 新增 `point.job.report`（会话投递，直接追加 assistant entry，不调用模型）与 `point.job.notify`（外部通知端口，三态、unknown 不重放）。
- 新增 `NotificationPort` 与内存脚本 adapter（仅测试）；openRuntime 可注入。
- 新增 schedule/delivery/notification 测试与 followup SIGKILL fixture。

## Capabilities

### New Capabilities
- `plan-and-delivery`: 单次计划、可审计判断、会话结果投递与通知三态。

### Modified Capabilities
无。

## Impact

新增 apps/server domain/storage/application/runtime/adapters 文件与测试、docs/evidence/OpenSpec；不改 api/bootstrap/config，不接真实通知渠道，不做周期/cron/时区规则。无旧库迁移。
