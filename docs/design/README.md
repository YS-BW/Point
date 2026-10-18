# Point 产品与技术设计

> 更新：2026-10-18。已定：**Pi Durable 作为 Agent 层，Steel 作为浏览器基础设施**。
> 状态口径：**已定**是产品或架构决定；**已验证**只覆盖对应实验；**待实现/待验证**不是可用性保证。

## 产品定位与架构决定

Point 是参考 Muse 形态的、持续运行的 personal agent：长期主会话、主题侧聊、后台工作、共享记忆、浏览器与产物。承诺与待办是首个验证场景，不是产品能力边界。

- 整个项目只服务一个人，不建设多用户、租户、团队或角色系统。
- Point Server 以 Docker 常驻；Client 首先采用 Web，CLI 继续作为开发和验证入口。关闭客户端不停止后台工作。
- Agent 层采用 **`@earendil-works/pi-durable`**。直接复用 Agent loop、上下文与压缩、工具系统、会话存储、Task checkpoint 和恢复。
- 浏览器基础设施采用 **Steel**，独立容器运行。默认使用本项目已发布的**腾讯云国内镜像**，按验证过的 digest 拉取；无需克隆源码或本地构建。
- Point 实现会话关系、任务/目标语义、记忆策略、触发判断、结果路由、通知与浏览器控制权；这些通过 Durable extension / task / document 接入。
- 一个长期 main，多个可长期保留的主题侧聊；后台工作拥有独立执行会话。同步主题结论与保存长期记忆是两个不同操作。
- 不再以 Pi coding-agent SDK 作为另一套生产执行引擎。旧 SDK 验证保留为参考，插件按 Durable 接口逐项评估和适配。
- 第一轮上下文来自直接对话，其他平台数据源后续接入。通知是可替换的单向渠道。

## 文档导航

| 文档 | 内容 |
|---|---|
| [产品与架构](product-and-architecture.md) | Point / Durable / Steel 职责、部署、状态权威与客户端范围 |
| [运行时选型](runtime-selection.md) | Durable 的复用边界、版本、现有证据与迁移顺序 |
| [浏览器基础设施](browser-infrastructure.md) | 国内镜像、REST/CDP/RTC、资源归属、接管与恢复 |
| [任务与 Agent](tasks-and-agents.md) | 产品任务与 Durable Task、内部执行会话、长期工作 |
| [会话与跟进](conversation-and-followup.md) | main / 侧聊 / 同步、待办与提醒默认策略 |
| [上下文与记忆](context-and-memory.md) | Durable 原生上下文、产品注入、历史与记忆边界 |
| [记忆适配](memory-adapter.md) | 显式记忆起点、替换契约与自托管候选 |
| [触发与后台工作](trigger-and-jobs.md) | Durable 持久任务、到期唤醒、取消与错过计划 |
| [判断层](decision-layer.md) | 是否推进、是否询问、是否通知及评测 |
| [投递层](delivery-layer.md) | 结果回到会话、客户端同步与外部通知 |
| [验证状态](verification-status.md) | 唯一证据口径：数值、时点、证据路径、复现命令与未验证清单 |
| [ADR-001 Agent 层选型](adr/ADR-001-agent-layer-selection.md) | 两次选型反转的时间线、依据、未量化项与复核触发条件 |
| [当前 Durable 原型](../../infra/pi-durable-validation/README.md) | 可运行入口、CLI、故障注入与真实 Steel 验收 |

## 七层职责与承载

| 层 | 职责 | 当前决定 |
|---|---|---|
| L0 状态 | 历史、任务进度、产品状态 | Durable storage / entries / tasks / documents；文件与产物独立持久化 |
| L1 触发 | 时间、对话、事件、状态变化 | Point 定义触发语义，Durable task 持久化并唤醒 |
| L2 判断 | 是否推进、需要用户、值得通知 | Point 可替换策略，通过 Durable 执行 |
| L3 执行 | 模型、工具、后台执行会话、浏览器 | Pi Durable；浏览器 extension 连接 Steel |
| L4 投递 | 会话结果与外部提醒 | Point 路由和渠道适配，Durable task 保存待投递工作 |
| L5 运行治理 | 并发、资源租约、成本、退避、审计 | Point 规则 + Durable 状态；Docker 负责进程拉起 |
| L6 反馈 | 用户纠正、任务更新、评测 | Point 应用反馈，关联原会话与任务 |

不新增通用应用内审批/角色系统。浏览器接管互斥、已确认的草稿发送边界和本人访问验证仍需落实。

## 当前实现与下一步

`infra/pi-durable-validation/` 是后续实现的基础，已验证主/侧会话、后台执行、显式记忆、结果回传、一次跟进与进程恢复。Steel 侧只在**旧 Steel 基线**上验证过 REST/CDP、接管互斥与恢复；发布镜像上的完整交互与原生 RTC 接管**待重跑、尚未完成**（见[验证状态](verification-status.md)）。`server/` 仍是旧 Pi SDK 验证代码，尚未迁移；本次调整的是设计与实施方向。

优先把 Durable 原型整理为正式 Server，稳定 API、状态版本与恢复流程；随后接入 Web，并把 Steel 原生 RTC 播放器接入 Point 控制权检查。长时间运行、模型供应商故障、周期计划、完整记忆与外部通知仍需产品级验收，不能由既有实验结果代替。

## 历史材料

- [本次调整前的 SDK 设计快照](archive/2026-10-18-before-pi-durable-steel/README.md)。
- [2026-10-16 切换 SDK 前的设计快照](archive/2026-10-16-before-pi-sdk/README.md)：其中未经本轮复核的旧断言不自动恢复。
- `docs/research/` 与 `.research/` 保留调研时点的结论，现行选型以本目录为准。
- OpenSpec 当前没有正式 specs 或 changes；未来变更沿用本次架构决定。
