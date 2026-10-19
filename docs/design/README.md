# Point 产品与技术设计

> 更新：2026-10-19。已定：**Pi Durable 作为 Agent 层，Steel 作为浏览器基础设施**。
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
| [长期 Server 架构](server-architecture.md) | 模块、身份、事务、恢复、主动性与长期演进 |
| [ADR-002](adr/ADR-002-server-foundation.md) | 模块化单体、WP1a/WP1b 与 NanoMuse 借鉴边界 |
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
| [实施路线](roadmap.md) | 工作包（WP）与闸门、并行/串行规则、人机协作协议（不排时间） |
| [Agent 层架构基调](agent-core.md) | 十条不变量、完成定义（DoD）、边界图与"坐稳"验收清单 |
| [资源边界](resource-boundary.md) | WP2 资源租约、控制权 epoch、副作用三态与幂等/CAS 契约 |
| [真实资源 Adapter](resource-adapters.md) | WP2 Durable resource persistence、文件/通知/CDP adapter 的安全契约与未验证边界 |
| [上下文预算](context-budget.md) | WP1b.2b 上下文 sections、显式 Profile/USER.md 导出、受保护压缩 |
| [Job/Attempt 与产物](jobs-and-artifacts.md) | WP1b.3 Job 与执行尝试、revision fence、save_artifact 工具与可核对产物 |
| [计划与投递](plan-and-delivery.md) | WP1b.4 单次计划、可审计判断、会话投递与通知三态 |
| [客户端协议：AG-UI](protocol-agui.md) | 可行性、概念映射、自定义传输补齐断线与后台并发、落地顺序 |
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

`infra/pi-durable-validation/` 是行为与可行性参考，已验证主/侧会话、后台执行、显式记忆、结果回传、一次跟进与进程恢复。Steel 侧只在**旧 Steel 基线**上验证过 REST/CDP、接管互斥与恢复；发布镜像上的完整交互与原生 RTC 接管**待重跑、尚未完成**（见[验证状态](verification-status.md)）。`apps/server/` 已完成 WP1a、WP1b.1/2a/2b/3/4、WP2 Durable persistence 与真实资源 adapter 安全闸门；真实 adapter 仅按显式组合根注入，生产 Steel/RTC/provider/migration/long-run 仍未验证，见 [核心重建计划](agent-core-rebuild.md)、[上下文预算](context-budget.md)、[Job/Attempt 与产物](jobs-and-artifacts.md)、[计划与投递](plan-and-delivery.md)、[资源边界](resource-boundary.md) 与 [真实资源 Adapter](resource-adapters.md)。`server/` 仍是只读的旧 Pi SDK 验证代码。

**当前优先级（2026-10-19 调整）**：先把 Agent 层坐稳——正式 Server 骨架、状态与事件契约、API v1、任务/上下文/记忆/投递的行为契约、常驻与长跑；**浏览器原生 RTC 集成暂缓**，只做止血与资源抽象。推进方式改为工作包（WP）+ 闸门，不按时间排期，人类定判断、agent 负责实现，见[实施路线](roadmap.md)与[AGENTS.md](../../AGENTS.md)。客户端流协议采用 [AG-UI 1.0](protocol-agui.md) 作为边缘投影，内部事件模型不变。必须遵守的约束见[Agent 层架构基调](agent-core.md)。

**2026-10-19 补充事实**：原生 RTC 链路当前无鉴权，且并发 12–13 个未授权信令连接即可使 Steel 容器 panic 退出（`cmd/main.go:124` 并发写 WebSocket）；`3000` 的任意路径 WS 可直通 CDP。修复（WS 单写者、握手凭证、连接上限）列为浏览器轨道第一步，补丁前浏览器入口只应留在 loopback。

长时间运行、模型供应商故障、周期计划、完整记忆与外部通知仍需产品级验收，不能由既有实验结果代替。

## 历史材料

- [本次调整前的 SDK 设计快照](archive/2026-10-18-before-pi-durable-steel/README.md)。
- [2026-10-16 切换 SDK 前的设计快照](archive/2026-10-16-before-pi-sdk/README.md)：其中未经本轮复核的旧断言不自动恢复。
- `docs/research/` 与 `.research/` 保留调研时点的结论，现行选型以本目录为准。
- OpenSpec 的 `point-long-term-foundation` 记录本次 WP1a；未归档前以该 change 的规格与任务为准。
