## Why

WP1b.1/2a/2b 已能对话、注入上下文并受保护压缩，但正式 Server 仍没有产品 Job 与执行 Attempt：没有工作身份、修订 fence、工具调用和可核对产物。原型用一个 Work task 兼作执行身份，无法表达“恢复沿用同一次尝试、新修订创建新尝试”。本片建立正式 Job/Attempt 边界与最小工具/产物链。

## What Changes

- 新增 `point.job`、`point.attempt`、`point.job-execution`、`point.command.job` 文档族。
- 新增 `runtime.jobs`：start/amend/cancel/get/attempts/artifact；start/amend 单 commit 创建 Job、Attempt、execution conversation、映射和 attempt task。
- 新增 `point.job.attempt` task：恢复沿用同 task/attempt，revision fence，取消传播，模型结果只在仍是 current attempt 时落 Job。
- 新增 artifact：`point.artifact`、原子写 + sha256 + verify；`save_artifact` 工具只在 execution conversation 可用，先 writing 后 sealed。
- 新增测试与 SIGKILL fixture，覆盖恢复、修订、取消、产物篡改/半成品。

## Capabilities

### New Capabilities
- `jobs-and-artifacts`: 产品 Job 与执行 Attempt 分离、revision fence、工具产物三态与可核对封存。

### Modified Capabilities
无。

## Impact

新增 apps/server 的 domain/storage/application/runtime 文件与测试、docs/evidence/OpenSpec；不改 api/bootstrap/config，不接真实浏览器/网络工具，不做计划/判断/投递/通知（WP1b.4）。无旧库迁移，新增文档族按需创建。
