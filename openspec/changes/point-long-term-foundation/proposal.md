# Proposal

## Why

Point 已有 Durable 原型，但正式 Server 尚不存在，现行路线混合了目录建立、完整迁移与长期产品能力。需要从 NanoMuse 的实际实现提炼职责边界，建立能逐步验收的长期架构与可运行基础。

## What Changes

- 记录固定版本 NanoMuse 的源码分析及取舍，不复制其运行时。
- 定义单用户模块化单体、状态权威、身份、事务、恢复、上下文、主动判断与外部能力边界。
- 将 WP1 分为 WP1a 基础骨架与 WP1b 原型迁移；保留完整迁移验收，不宣称骨架等于产品就绪。
- 建立 TypeScript Server、真实 Durable 初始化、单写者与健康接口、独立测试和构建检查。
- 不迁移现有数据库，不提供未实现的聊天接口，不接浏览器控制面。

## Capabilities

### New Capabilities

- `server-lifecycle`: 独占数据目录、持久初始化、兼容性拒绝、健康状态与关闭释放。

### Modified Capabilities

无。现有 OpenSpec 尚无正式 specs。

## Impact

WP1a，依赖已完成 WP0。串行拥有 apps/server/、根构建配置与 scripts/、docs/design/、新增 docs/research/、openspec/changes/point-long-term-foundation/、AGENTS.md、README.md、现有 CI 的骨架检查以及新增 evidence 与 manifest。保留原型代码、历史研究、退役工程与本地调研素材。新增精确版本 TypeScript 开发依赖；运行引擎仍为 Durable 1.3.0。回滚删除新增骨架与恢复文档即可，原型数据不受影响。
