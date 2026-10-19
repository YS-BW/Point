## Context

NanoMuse 固定快照 ae9eb06 的 server/service.py:send 将输入排队；stop_thread 取消运行并清理队列，保留 thread。Point 使用 Durable 原生 inbox/loop 实现相同可观察语义。固定源码是参照，不是已运行的 Muse 体验基准。

Ready：WP1b.2a，依赖 WP1b.1。串行写 apps/server、docs/design、OpenSpec、AGENTS、新增 evidence；独立自然语言场景、根 check/test、原型快速回归、OpenSpec strict。只用临时库，无真实迁移；不改浏览器。

## Goals / Non-Goals

本片完成应用端口的发送→排队→完成/失败，停止→继续，以及离开后读取历史。上下文使用 Durable 原始历史；USER.md、压缩和预算在 WP1b.2b 单独验收。后台任务、工具、通知、公开传输和视觉 UI 属于后续片；本片不能标记完整复刻。

## Decisions

- 写请求先原子建立命令收据与 Durable command task；每个 chat 的 command task 依赖前一 command task。它只串行化受理/停止，不等待模型回答，实际消息排队仍使用原生 Inbox，不引入外部队列。
- send task 原生 submit 使用稳定 requestId，恢复重复受理安全。stop task 在该命令链中执行 abort；后续 send 必须等 stop 完成，避免恢复旧 stop 杀掉新的请求。command tasks 是 background ownership，停止会话不会取消自己的控制命令。
- 模型可注入 Models/model，未配置时拒绝发送。正式配置不默认脚本模型，不自动读取旧原型凭据。
- beforeRequest 钩子不能作为拒绝门：SDK 捕获钩子错误。钩子仅附加内存身份标记，真正 Models.streamSimple 包装层验证标记、提交调用意图后再 dispatch，缺标记一律拒绝。标记从供应商上下文移除，不进入历史或提示词。
- 意图以 generation task 身份记录。禁用 SDK 自动 retry/compaction，避免绕开保护。第一次调用写 attempting，响应观察写 done/unknown；调用前已取消写 failed。重新进入已有意图不调用供应商；attempting 转 unknown。done 只表示供应商已返回，不表示用户已收到回答；会话答案与 run 完成仍由 SDK 原子提交。崩溃后若答案尚未提交，显示未回答，不伪造结果或重新付费。
- 所有模型、异常说明不把原始供应商错误/凭据写进业务结果；guard 返回固定失败码。供应商输出本身属于模型内容，需真实 provider 验收。
- 历史从 Durable entries 分页投影，无新 messages 存储。消息处理状态由 command task 与 submission 读取，接收命令不等于完成回答。

## Risks / Trade-offs

响应返回但 SDK 尚未提交时会保守显示无法恢复，用户可发新请求；不许自动重放 unknown。离线脚本提供确定性时序，不证明语义质量。逐字流式/工具过程/USER.md/压缩/真实模型必须另有产品场景验收。

## Migration Plan

新 kind/version=1，已有基础库按需新增，不改原型库。只在配置执行能力后恢复已登记 tasks；未配置仍可读取已有聊天。未来版本拒绝/迁移需单独包，真实数据先备份。回滚到上一片仅能读取 metadata，不能恢复新 task，禁止当作业务降级方案。
