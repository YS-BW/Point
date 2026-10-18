# ADR-001：Agent 层选型（Pi Durable）

> 状态：**已接受**（2026-10-18）。影响范围：Agent 执行层、后台任务、浏览器接入方式、插件与工具接入。
> 相关：[运行时选型](../runtime-selection.md) · [验证状态](../verification-status.md) · [产品与架构](../product-and-architecture.md)
>
> 口径：**【事实】**= 有文件行号或证据可核对；**【推断】**= 判断。

## 背景

Point 需要承载「长期主会话 + 主题侧聊 + 后台工作 + 崩溃恢复」的 Agent 层。2026-10-16 起，团队在 `@earendil-works/pi-durable` 与 `@earendil-works/pi-coding-agent`（Pi SDK）之间做过两次判断，中间没有产品实现落地，最终回到 Durable 并引入 Steel 独立承接浏览器能力。

## 决定

采用 **`@earendil-works/pi-durable@1.3.0`** 作为 Agent 层（Agent loop、上下文与压缩、工具、会话存储、Task checkpoint 与恢复），**Steel** 作为独立浏览器基础设施；不并行引入第二套生产执行引擎（[runtime-selection.md](../runtime-selection.md):3-4、:35）。

## 时间线与两次反转的依据

| 时点 | 决定 | 依据 | 证据强度 |
|---|---|---|---|
| 2026-10-16 | 初选 **pi-durable 作 L0 运行时**（执行层 pi-ai / pi-codemode / pi-mcp） | `.research/` 四份只读代码审计：5,352 行 spec、18 项存储一致性契约、commit-before-publish 代码路径、head+ContextEdit 语义（[archive/2026-10-16-before-pi-sdk/runtime-selection.md](../archive/2026-10-16-before-pi-sdk/runtime-selection.md):5-6、:21-23） | 强（代码级审计） |
| 2026-10-16 同日 | 改为 **Pi coding-agent SDK** | 理由：Muse 形态下插件、浏览器、长期任务复用价值高，此前"低估了 coding-agent 插件移植成本"（[archive/2026-10-18-before-pi-durable-steel/runtime-selection.md](../archive/2026-10-18-before-pi-durable-steel/runtime-selection.md):5、:10）。该轮**明确没有运行集成测试**（同文件:36） | **零实验证据** |
| 2026-10-18 | 切回 **Durable + 引入 Steel** | 优先 Durable 的执行与恢复模型，接受按 extension 适配插件的成本；Steel 独立承接浏览器，使浏览器能力不再依赖 SDK 插件（[runtime-selection.md](../runtime-selection.md):10） | 中偏强（当天原型 + 6 份验证/发布报告） |

【事实】第一次转向没有集成测试，而反对 SDK 的核心论据在转向之前就已写在档案里：**"Pi SDK 持久化「对话」但不持久化「工作」——崩了之后你知道聊到哪了，但不知道该接着做什么"**（[archive/2026-10-16-before-pi-sdk/runtime-selection.md](../archive/2026-10-16-before-pi-sdk/runtime-selection.md):37）。

【推断】因此这不是"新证据推翻旧结论"，而是权衡被重新排列：第一次用未量化的插件复用收益，换掉了已验证的恢复原语；第二次用承认的适配成本，换回了恢复原语。**净结果是回到起点，"问题"被绕回，而非被回答。**

## 决定理由

1. **恢复与长期执行是产品核心**：Durable 原生提供 Task checkpoint、持久调度与恢复原语，原型已用 70 次强杀注入验证（[verification-status.md](../verification-status.md)）。
2. **浏览器能力解耦执行引擎**：Steel 作为独立容器通过 REST/CDP 接入，插件不再是浏览器的必要条件（[browser-infrastructure.md](../browser-infrastructure.md)）。
3. **状态权威单一**：会话、任务、产品状态落到 Durable storage 与 document，不为同一执行另建队列（[product-and-architecture.md](../product-and-architecture.md):47-56）。
4. **愿意承担的代价**：插件按 Durable extension 逐项适配；Durable 不自动扫描 Pi Coding Agent 的 AGENTS/skills，也不自动加载终端插件（[runtime-selection.md](../runtime-selection.md):32）。

## 未量化的关键项

【事实】**Pi 插件迁移成本从未被量化**，两侧都靠推断：

- 原型自认"Pi 插件生态能否迁移，以及复用 SDK 插件与重写 Durable extension 的实际成本"尚不能下结论（[pi-durable-validation-2026-10-18.md](../../research/pi-durable-validation-2026-10-18.md):62）。
- 设计侧只写"接受按 Durable extension 适配插件的成本"（[runtime-selection.md](../runtime-selection.md):10），没有工时或复杂度估计。
- 第一次转向的收益侧同样未测量："插件、浏览器、长期任务、记忆等能力的复用价值很高"是判断，不是实验结论。

【推断】这是本 ADR 证据链上最薄的一环：若后续实测适配成本过高，选型的收益/成本比需要重新评估，而不是继续沿用"已接受"。

## 后果

- **正面**：崩溃恢复、后台任务、上下文压缩、会话 fork 直接复用；原型在故障注入、单事务结果回传、浏览器 `unknown/reconcile` 上已有可复跑证据。
- **负面**：Pi 终端插件、skills、MCP 资源不能直接加载，需显式适配生命周期与交互；Durable 包标记为实验性 API，升级需验证接口、状态迁移与恢复（[runtime-selection.md](../runtime-selection.md):33）。
- **约束**：不同时引入 Pi coding-agent SDK、DSH 等第二套生产执行引擎；旧 SDK 验证仅作历史参考（[runtime-selection.md](../runtime-selection.md):35、[product-and-architecture.md](../product-and-architecture.md):31）。
- **迁移**：`server/` 旧 SDK 工程不迁代码；其 README 中记录的 SDK 行为坑作为历史风险记录保留。

## 复核触发条件

出现以下任一情况时重开本 ADR：

1. **插件迁移成本超预期**：单个核心插件适配超过 3 人日，或必须修改 Durable 内核才能接入。
2. **Durable 破坏性升级**：实验性 API 发生不兼容变更，且无法在合理成本内完成状态迁移与恢复验证。
3. **出现只有 Pi SDK 生态才能满足的产品能力**，且无 Durable extension 等价路径。
4. **Durable 发布稳定版并提供插件兼容层**，成本模型发生变化。

## 参考

- 现行设计：[运行时选型](../runtime-selection.md) · [验证状态](../verification-status.md) · [浏览器基础设施](../browser-infrastructure.md) · [产品与架构](../product-and-architecture.md)
- 历史快照：[2026-10-16 切换 SDK 前](../archive/2026-10-16-before-pi-sdk/README.md) · [2026-10-18 改用 Durable+Steel 前](../archive/2026-10-18-before-pi-durable-steel/README.md)
- 调研：[Pi Durable 执行机制验证](../../research/pi-durable-validation-2026-10-18.md)
