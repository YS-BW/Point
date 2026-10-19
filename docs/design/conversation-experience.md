# 对话体验：Muse 场景与 Durable 复用

## 参照与验收方式

依据本地 NanoMuse 固定源码 `ae9eb06b37780dd5028ab885cc38625bc7d830c0`，不声称已运行其 UI 做逐项对照。`nanomuse/server/service.py:send` 负责忙时排队，`stop_thread` 清队列并停止，`_settle_stopped` 保留可继续对话；`MuseAgent.run/context_messages` 使用各会话历史。这是本片的产品参照。Point 的重启保证属于额外工程契约，不从 NanoMuse 的内存队列推导。

测试从用户交互出发，断言最终可见内容、状态、隔离与是否重复调用；不把 HTTP 成功或 task completed 当作用户收到答案。离线供应商替身只控制回复和时序，**没有验证真实模型是否理解预算、写作质量或自主完成复杂目标**。真实语义评测必须另有模型、输入、期望与结果记录，不能用固定回复宣称完美复刻。

## 先查 SDK，再补产品层

本次核对本地锁定 `@earendil-works/pi-durable@1.3.0` 的公开类型及对应实现，不修改依赖源码。

| 需求 | Durable 原生能力 | Point 的处理 |
|---|---|---|
| 推理/工具循环 | GenerationTask / ToolTask | 直接使用；不实现 Agent loop |
| 忙时补充 | Conversation.submit + whenBusy:followUp + InboxDoc | 直接使用原生队列；当前按 NanoMuse 参照采用下一轮处理，不冒充实时 steering |
| 停止与继续 | Conversation.abort，queued inputs withdrawal | 直接调用；后台控制命令不会被自身停止 |
| 运行状态 | Submission.status/wait、Task outcome | 投影 accepted/queued/running/answered/unanswered/stopped/failed；控制命令完成不等于回答完成 |
| 历史与上下文 | Conversation.entries/context | 原始历史仍是唯一事实；历史分页只做显示投影 |
| 重启执行 | Harness.resume、原生 task checkpoint、waiting dependencies | 直接复用，不另写 scheduler 或定时轮询恢复 |
| 事件与流式展示 | Conversation.watch、watchEvents、observeCommits | 后续协议层接入；本片不另建事件总线 |
| USER.md / 上下文 sections | defineExtension + section + Documents | 下一片复用；不自行写上下文引擎 |
| 压缩 | Conversation.compact / CompactionTask | 下一片接入受保护的模型调用与历史不变验收；当前关闭自动压缩 |
| 请求同键异参 | 原生 submit 仅按 requestId 返回已有 submission，不比对 content | Point 补规范化参数指纹和持久收据 |
| 停止的幂等与恢复顺序 | abort 没有业务 requestId；原生 task 可持久化和等待 | Point 用原生 command task 和前驱依赖，保证旧 stop 完成前新 send 不被派发；它只串行化控制命令，不等待模型，也不存第二个消息队列 |
| 付费模型未知结果不重发 | GenerationTask 恢复 request 会再次发起，beforeRequest 异常会被 scheduler 捕获 | 模型 dispatch 包装层先落意图；缺少身份或已有意图拒绝外部调用。仅靠 hook 抛错不可行 |

SDK 核查位置：`dist/harness/types.d.ts`、`submissions.js:admitSubmission`、`generation.js:request/streamResponse`、`scheduler.js` 的 hooks.each。内部实现仅作为行为审计依据；正式代码只 import 包公开导出。

## 产品场景矩阵

| 用户场景 | 本片验收 | 尚需的产品证据 |
|---|---|---|
| 给小王起草项目说明，发送后离开 | 只读查询能看到自动完成；输入/回答唯一；重启后可读 | 实际客户端断线与真实模型草稿质量 |
| 写到一半补充预算 | 必须先观察到 queued，再释放首轮；下一轮包含原历史和补充 | 用户对响应时机的体感与真实模型遵从度 |
| 停止方案、清掉报价要求，转而列问题 | 旧输入 unanswered，新输入 answered；重试旧 stop 不影响新问题 | 工具执行途中停止及不可撤销副作用的说明 |
| 项目聊与旅行聊同时进行 | 不串历史，独立完成 | 主会话/侧聊列表、fork、分享结论 |
| 服务在模型请求中强杀 | 重启不重发旧请求，不伪造成功；新请求可继续 | 实际供应商断线、限流、费用核对 |
| 停止途中强杀，后续问题已受理 | 恢复停止后新问题继续；旧 stop 重放只返收据 | 工具/子任务场景的停止边界 |
| 供应商失败 | 返回 unanswered，原始错误诊断不进入显示历史 | 可理解的错误文案与人工重试 UI |
| 阅读较长历史 | 分页无重复与遗漏，有固定夹具读取耗时断言 | 长跑容量、压缩、真正长上下文质量 |

后续必须补齐：USER.md 显式个性化、上下文预算与压缩；工具过程与产物；后台任务/修订/接管；承诺提醒及通知；前台流式状态和重连。浏览器仍按冻结规则处理。本表未覆盖项不能被“测试全绿”覆盖。

## 当前接口和边界

`openRuntime(dataDir, {models, model})` 显式接收原生 pi-ai Models 与模型引用；无默认假模型，无隐式读取原型凭据。供应商注册和环境凭据仍由官方 pi-ai provider 负责。未传 binding 时能读历史/状态，拒绝新 send/stop；不会因为只读查询恢复执行。

`runtime.conversation.send({chatId, requestId, text})` 与 `stop({chatId, requestId})` 返回 commandId。`status(commandId)` 只读；`wait(commandId)` 等待用户输入的最终回答或停止结果。`history(chatId, limit, cursor)` 按时间正序分页，游标必须原样带回，空显示页仍可能有 next。HTTP 入口暂未发布这些命令，健康能力仍只声明 foundation。

业务数据仍在 Durable：command task 是受理意图，submission/entries 是消息事实，收据保存指纹与 task ID，command-head 只保存前驱 ID。模型调用文档不保存另一份回复；done 表示已观察供应商完成，答案是否已交付由 submission/entry 决定。响应返回到提交答案之间崩溃，保守呈现 unanswered；不自动重发已完成或 unknown 的调用。unknown 尚无产品核销入口，后续应根据供应商可观察结果核销，不能增加盲目重试。

新文档版本为 1，新增于基础库，不迁移原型库。真实数据使用前备份；旧代码不能恢复新任务，不承诺降级。验证结果与数量统一见 [verification-status](verification-status.md)。
