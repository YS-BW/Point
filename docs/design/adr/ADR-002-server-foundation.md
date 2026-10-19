# ADR-002：长期产品采用 Durable 模块化单体

- 日期：2026-10-19
- 状态：按用户要求重新设计并建立骨架；实现范围 WP1a，尚未通过完整 WP1/G1。
- 上位约束：[十条不变量](../agent-core.md)。

## 背景

原型已验证核心执行，但产品语义、具体浏览器实现和基础设施集中在 service。原先 WP1 同时要求建目录、迁移全部行为，缺少基础与迁移的可独立验证边界。用户要求借鉴 NanoMuse，构建长期可维护架构。

## 决定

采用单进程模块化单体。增加 application 明确用例/事务端口，domain 纯规则；runtime 承接 Durable，storage 承接其 documents，adapters 承接外部能力，api 做边缘协议，组合根组装。仅 Durable 保存产品状态与执行进度。

产品区分 Commitment、Goal、Job、Attempt、Schedule、Decision、Interaction、Delivery、Resource、Artifact。恢复同一次 attempt 保留 ID，重试/修订新增 attempt。草稿生成与发送分开，主动触发与通知分开。详见 [完整架构](../server-architecture.md)。

先实现 WP1a 真实生命周期骨架，再 WP1b 完整迁移；保留原 WP1 的全部回归出口，不提前通过 G1。现有原型继续作为已验证实现，旧 server/ 保持只读。浏览器仍冻结。

## 候选方案与取舍

- 直接复制 NanoMuse Python/DSH 架构：违背唯一引擎；多端平台、账号中继及多状态源不适合当前单人 Server。
- 继续扩展原型 service：短期快，但资源耦合、生命周期与事务所有权不清晰。
- 微服务 + 独立队列/数据库：单用户部署与一致性成本过高，违反现行状态权威约束。
- 选定方案：保持 Durable 原语与已有验证，同时通过编译/边界测试约束依赖。增加一层 application 的成本换取明确的事务和 SDK 隔离；不引入通用工作流框架。

## 后果与复核条件

架构不是永远不变的承诺。状态所有权和副作用契约长期稳定；schema/API/依赖可版本化升级。只有现有进程的容量、隔离需求或 Durable 能力被实测证明不足时再写新 ADR，不预先做分布式化。独立迁移、恢复演练、真实行为与长跑验收仍必需。

NanoMuse 结论是固定源码版本的分析，见 [研究记录](../../research/nanomuse-architecture-2026-10-19.md)，不是对其全部平台成熟度的背书。
