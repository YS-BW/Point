## 1. 实现

- [x] 1.1 Schedule/Occurrence/Decision domain/storage/application：严格输入、状态机、最多 2 次、命令与收据。
- [x] 1.2 `point.job.followup` task：绝对时刻、恢复重读、错过合并、判断 skip/deliver、单 commit 事务、取消/修订。
- [x] 1.3 Delivery domain/storage/application：点投递、NotificationPort、DeliveryCommands。
- [x] 1.4 `point.job.report` / `point.job.notify` task：会话 entry 幂等、通知三态、unknown 不重放。
- [x] 1.5 openRuntime 组装 followups/delivery/notification，兼容既有调用。

## 2. 质量

- [x] 2.1 测试：重启恢复、错过合并、提醒上限、取消/修订竞态、通知 failed/unknown、重试不重复、既有 127 不回归。
- [x] 2.2 followup SIGKILL fixture。
- [x] 2.3 独立 reviewer 通过并给出实质意见。

## 3. 验收与文档

- [x] 3.1 `npm run check && npm test` 全绿；原型快速回归通过。
- [x] 3.2 plan-and-delivery/verification-status/README/evidence 同步；G1 验收记录；未验证项明确。
