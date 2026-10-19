## Context

原型 Followup（service.mjs:272-332）用单次 `dueAt` + `runtime.sleep` 等待，醒来校验 taskId/cancelled；通知投递（519-462）先 commit intent 再 fetch，异常→unknown 不重放；Report（144-190）以稳定 requestId 把结果提交回会话。原型没有 occurrence/decision/提醒上限/错过合并。正式实现需要把“计划→判断→投递”拆成 Durable 文档与任务，并保持取消/修订/重启下的真实语义。

## Goals / Non-Goals

目标：单次 schedule（最多 2 个 occurrence）、绝对时刻恢复、错过合并、判断可审计、取消/修订竞态 skip、会话投递幂等、外部通知三态与失败不伪成功、独立故障注入。

非目标：周期/cron、完整时区/DST、真实通知渠道、真实模型报告、HTTP、Docker、长期运行。

## Decisions

- Schedule/Occurrence/Decision/Delivery 分族；`point.job.followup` 以 scheduleId 为输入，恢复重读并重算 pending；`sleep` 使用绝对 dueAt，不用相对间隔。
- 醒来时把所有 dueAt<=now 的 pending occurrence 合并为一条 decision（错过合并）；同 schedule 最多 2 次提醒，超出 skip `reminder-cap`。
- 判断只读 Job/Attempt/Artifact：Job 不存在/cancelled → skip job-cancelled；revision 不匹配 → skip stale-revision；否则 deliver。
- 一个 commit 写 Decision + occurrence delivered/skipped + Delivery(chat, intent)+ReportTask + Delivery(notification, intent)+NotifyTask；commit 后继续下一个 pending occurrence。
- report task 直接追加 assistant entry（带 kind point.report 与 job/delivery 来源），不调用模型；重复执行按 Delivery 状态幂等，不重复追加。
- notify task 先 attempting 再 send；port 返回 failed/unknown 或抛异常分别落 failed/unknown，不自动重试；unknown 不重放。
- delivery 状态与 Job/chat 分离：外部通知失败不改变 Job ready 或聊天投递成功；重试键为 deliveryId（含 job/schedule/occurrence/revision/channel）。
- openRuntime 增加可选 notification port 注入；默认不接真实渠道，测试用脚本 adapter。

## Risks / Trade-offs

绝对时刻与重启恢复依赖 Durable sleep/任务恢复；长时区/DST 规则未实现。report 直接追加 entry 不做模型润色，体验较原型粗但可验证；notification 本轮无重试命令，unknown 只保留证据。文件/聊天/通知不是同一事务：chat entry commit 成功而通知失败是允许的可观察状态。

## Migration Plan

新增 doc kind/version=1，按需创建；不改旧文档。回滚停止使用新命令，旧数据仍可读。真实数据先备份。
