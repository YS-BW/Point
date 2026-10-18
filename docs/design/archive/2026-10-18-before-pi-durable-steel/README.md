> 历史快照：2026-10-18 改用 Pi Durable + Steel 前的设计。其选型与待办仅供追溯，现行决定见[设计总览](../../README.md)。

# Point 产品与技术设计

> 更新：2026-10-18。当前阶段：产品设计与独立运行时验证，尚未开始完整产品或 Web 原型。
> 状态口径：**已定**是用户确认的决定；**默认策略**可在使用中调整；**待验证**不是可用性保证。

## 产品定位与边界（已定）

Point 是参考 Muse 形态的、持续运行的 personal agent。它能对话、记忆、主动推进工作、运行命令、操作浏览器和交付产物。承诺与待办是首个验证场景，不是产品能力边界。

- 整个项目只为一个人服务，不考虑多用户、租户、团队、角色权限或这些能力的预留抽象。
- Server 以 Docker 部署并持续工作；Client 首先采用 Web，未来可增加 App 或其他入口。
- 运行时改为 **Pi coding-agent SDK**（`@earendil-works/pi-coding-agent`），替代此前的 pi-durable 选型。
- 主 Agent 负责对话和协调；复杂工作委派给按任务创建的子 Agent，完成后回传结果。
- Server 具备终端、文件、联网、工具调用及持久浏览器；浏览器可从 Web 查看和接手。
- 第一轮以直接对话为上下文来源；邮箱、社交媒体、网购平台等作为后续数据源。
- 通知是可替换的单向渠道，不绑定邮箱，不通过邮件回复处理指令。
- 本轮新增独立 Durable CLI 可行性原型；完整产品实现仍先做 Server，再做 Client。

## 文档导航

| 文档 | 内容 |
|---|---|
| [product-and-architecture.md](product-and-architecture.md) | 产品定位、Server/Client 职责、浏览器和客户端范围 |
| [runtime-selection.md](runtime-selection.md) | Pi SDK 选型、与 durable 的取舍、插件复用和兼容性验证 |
| [Durable 原型](../../../../infra/pi-durable-validation/README.md) | 主/侧会话、后台工作、共享记忆、结果回传与恢复验收；不改变当前正式选型 |
| [tasks-and-agents.md](tasks-and-agents.md) | Goal / Task / Session / 子 Agent 的关系与生命周期 |
| [conversation-and-followup.md](conversation-and-followup.md) | 已确认的对话、待办、草稿与跟进默认策略 |
| [context-and-memory.md](context-and-memory.md) | 主对话、执行上下文、记忆和原文边界 |
| [memory-adapter.md](memory-adapter.md) | 自托管记忆、适配边界及候选状态 |
| [trigger-and-jobs.md](trigger-and-jobs.md) | 调度插件优先复用、触发、错过提醒和恢复规则 |
| [decision-layer.md](decision-layer.md) | 执行与通知判断、沉默审计、评测边界 |
| [delivery-layer.md](delivery-layer.md) | 单向通知、渠道适配与投递状态 |

## 七层职责仍保留，技术承载已调整

| 层 | 职责 | 当前承载方向 |
|---|---|---|
| L0 状态 | 对话、任务、目标、记忆 | SDK 会话持久化 + Point/选定插件的业务状态 |
| L1 触发 | 时间、事件、状态变化、自省 | 优先评估调度扩展；Point 统一接入 |
| L2 判断 | 是否推进、是否需要用户、是否值得通知 | 可替换策略，先明确契约 |
| L3 执行 | 模型、工具、命令、浏览器、子 Agent | Pi SDK + 扩展 + Server 编排 |
| L4 投递 | 对话呈现与外部通知 | 可替换单向渠道 |
| L5 运行治理 | 成本、退避、审计、凭据配置 | 不新增应用内角色/审批/权限系统 |
| L6 反馈 | 用户纠正、状态更新、评测 | Point 记录与应用反馈 |

SDK 不替 Point 保证执行 checkpoint、跨插件状态一致性、外部副作用幂等或业务任务恢复。

## 后续 SDK 集成验证

以下是产品集成验收方向；独立 Durable 原型的通过结果不等于 SDK 插件兼容性已通过。

1. 无终端 SDK 加载候选 Goal、调度和浏览器扩展，确认 UI 依赖与版本兼容。
2. 主会话与子 Agent 并行；补充指令、停止、结果回传；隔离插件状态。
3. 重启后恢复会话，识别中断工作，处理错过的计划和结果未知的外部动作。
4. 在上述结果基础上确定具体插件、业务状态权威来源与存储契约。

## 历史材料

- [切换 SDK 前的设计快照](../2026-10-16-before-pi-sdk/README.md)：仅供追溯，不是现行规范。
- `docs/research/` 与 `.research/`：保留调研和验证材料，旧技术建议不自动成为当前决定。
- OpenSpec 当前没有正式 specs 或 changes；独立 Durable 验证代码位于 `infra/pi-durable-validation/`。
