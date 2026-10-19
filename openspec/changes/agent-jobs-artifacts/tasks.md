## 1. 实现

- [x] 1.1 Job/Attempt domain/storage/application/runtime：身份、状态机、revision fence、命令与收据。
- [x] 1.2 `point.job.attempt` task：execution conversation、submission、结果 fence、取消、恢复。
- [x] 1.3 artifact：文档、原子写、sha256、verify、writing/sealed 状态。
- [x] 1.4 `save_artifact` 工具：execution 映射授权、幂等/冲突、路径与大小限制。
- [x] 1.5 openRuntime 组装 jobs/artifact/tools。

## 2. 质量

- [x] 2.1 测试：start/amend/cancel/get、revision fence、恢复、工具授权、产物核对、SIGKILL。
- [x] 2.2 既有 102 项不回归。
- [x] 2.3 独立 reviewer 通过并给出实质意见。

## 3. 验收与文档

- [x] 3.1 `npm run check && npm test` 全绿；原型快速回归通过。
- [x] 3.2 jobs-and-artifacts/verification-status/README/evidence 同步；未验证项明确。
