## Context

原型 `service.mjs:346-494` 的 Work task 同时承担产品 Job 与执行身份，`workerId` 即唯一 task，修订只递增 revision 并复用 conversation；`steps` 用 `r{revision}s{step}` 记录工具回执。正式架构要求 Job 与 Attempt 分离（agent-core.md #2、server-architecture.md §3）：恢复沿用 attemptId/task，新修订/重试创建新 attemptId。产物在原型仅 `${jobId}.md` + tmp/rename，无哈希；正式需要可核对封存。

## Goals / Non-Goals

目标：Job/Attempt 身份与 revision fence、恢复沿用 attempt、取消传播、工具受控授权、artifact 原子写/哈希/半成品不算成功、独立故障注入测试。

非目标：计划/判断/投递/通知（WP1b.4）、真实浏览器/网络工具、真实模型质量、HTTP、Docker、旧库迁移、artifact 孤儿自动清理（仅 verify 可发现）。

## Decisions

- `point.job` 与 `point.attempt` 分离；Attempt 保存 taskId/conversationId/revision；`Job.currentAttemptId` 指向当前。新 revision 创建新 attemptId + 新 execution conversation + 新 task；旧 attempt superseded，旧 task abort 在 commit 后。
- 所有完成写入先做 revision fence（job.revision === attempt.revision && currentAttemptId === attempt.id && 非 cancelled）；否则 attempt superseded，不覆盖 Job。至少一个 sealed artifact 才能 ready。
- 恢复沿用同 attempt/task；execution conversation 的 submission requestId 稳定；模型 guard 的 unknown 不重放。
- 取消在单 commit 写 Job/Attempt cancelled，然后 abort task；不撤销已发生的外部写，不伪造成功。
- artifact 文档 state writing→sealed；工具先 commit writing、再 tmp+fsync+rename、再 sealed；writing/unknown/failed 不得计入成功。verify 读文件重算 sha256；不删除证据。
- `save_artifact` 只允许 execution conversation：通过 `point.job-execution`（key=conversationId）映射校验 job/attempt/revision/status；路径只允许 workspace/jobs/<jobId>/<attemptId>/<name>，name 白名单，内容 ≤256KiB。
- 命令收据：start 用 `${sourceChatId}:${requestId}`，amend/cancel 用 `${jobId}:${requestId}`；同键同指纹返回首次结果。

## Risks / Trade-offs

artifact 写文件与文档不是同一事务：崩溃可能留下孤儿文件/ writing 文档；本轮保证半成品不算成功，但不自动清理。attempt task 与模型调用使用现有 guard；恢复时若模型 unknown，job 呈现失败/未完成，不重放。真实外部工具/浏览器不在本片。

## Migration Plan

新增 doc kind/version=1，按需创建；不改旧文档。回滚停止使用新命令，旧数据仍可读。真实数据先备份。
