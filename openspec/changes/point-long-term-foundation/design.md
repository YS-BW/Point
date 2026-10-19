# Design

## Context

See proposal.md. 当前原型把产品与适配器放在同一服务模块，正式服务不存在；原型证据不得直接算正式服务验收。

## Goals / Non-Goals

Goals：以模块化单体固定依赖方向，建立可独立启动、测试的生命周期，以及完整产品的演进路径。
Non-Goals：本次不迁移原型、不开放模型与工具、不实现客户端、不接浏览器、不做状态升级。

## Decisions

- TypeScript 严格检查；domain 纯业务，application 定义用例端口，runtime 适配 Durable，storage 定义文档和版本，adapters 承接外部能力，api 仅边缘协议；组合根负责组装。较微服务减少单用户部署成本，较 service 巨型模块隔离变更。
- 使用真实 Durable session 文档保存基础元数据；一个 root 与初始化元数据同事务创建。无自有数据库表。owner.sqlite 仅锁，不存产品数据。
- 未识别、有业务内容但无 metadata 的存储拒绝启动；不自动升级。在 SDK 写模式打开前只读检查其 schema，阻止自动升级；驱动版本固定，本次仅对全新目录和本版本目录提供支持。
- 健康接口只表示基础运行就绪；能力列表明确聊天/执行未开放。默认 loopback；本次不支持远程监听，远程单用户令牌在 WP4 实现。
- WP1a 只交付基础骨架，WP1b 保留完整原型迁移验收，G1 不提前通过。长期契约见 docs/design/server-architecture.md。

## Risks / Trade-offs

- [骨架被误认为完整产品] → README、健康能力与路线明确分开。
- [依赖升级隐式迁移] → 精确版本；跨版本启动和迁移在 WP3 独立备份验收。
- [“不变架构”阻碍演进] → 固定状态权威与依赖规则，schema/API/adapter 通过版本演进；不承诺目录永远不变。

## Migration Plan

只使用新目录；旧原型和数据库保持不变。骨架回滚为删除新增正式工程，现有原型仍可运行。未来迁移 WP3 先快照、演练、停写，再切换，禁止同目录双写。

## Scope confirmation

2026-10-19 用户确认“本次完成基础骨架与稳定性验收，产品迁移单独做”。本 change 的完成范围为 WP1a；WP1b、G1 与产品功能不包含在本次完成声明中。逐项证据见 docs/design/foundation-acceptance.md。
