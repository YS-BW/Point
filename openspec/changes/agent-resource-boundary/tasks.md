## 1. 实现

- [x] 1.1 `domain/resource.ts`：Resource/Lease/Operation 类型、initialResource、acquire/renew/release/takeover/expire/assertControl、操作状态机、ResourceError。
- [x] 1.2 `application/resource.ts`：严格输入、ResourceStore/ResourceEffectPort/EffectFailure、resourceCommands 的 acquire/renew/release/takeover/read/beginOperation/runOperation/observeOperation、幂等收据与 commit。
- [x] 1.3 `adapters/resource/memory.ts`：内存 store，revision CAS、原子 commit、收据、findOperation；load 深拷贝。

## 2. 质量

- [x] 2.1 测试矩阵：lease/epoch fencing、非法转移、unknown 不重放、attempting 恢复、幂等、并发 CAS、非法输入零写入。
- [x] 2.2 不变量检查：domain/application 不得定义 Durable task，正反例测试。
- [x] 2.3 独立 reviewer 审计并给出至少一条实质意见；无 blocker。

## 3. 验收与文档

- [x] 3.1 根目录 `npm run check && npm test` 全绿，既有测试不回归。
- [x] 3.2 `docs/design/resource-boundary.md`、`verification-status.md`、`apps/server/README.md`、evidence 与 manifest 同步。
- [x] 3.3 明确未验证项：无真实资源、无 Durable 持久化、无崩溃恢复、无 HTTP 映射、无多进程压测。
