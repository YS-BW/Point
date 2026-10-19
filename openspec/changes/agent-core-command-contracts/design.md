# Design

## Context

WP1a 已提供单写者、版本预检、进程生命周期。用户明确将 WP1b 从迁移改为工程化重建。原型 createChat 只记录请求键到 chat 的映射，不能检测同键异参；集中 State 使无关业务共享写入单元。

## Goals / Non-Goals

本次 WP1b.1 建立创建 fresh 对话的正式应用端口及真实 Durable 集成测试。模型、提交消息、fork/归档、计划、投递及浏览器分别后续实现；不宣称整个 WP1b 完成。HTTP 仍只发布基础健康状态。

Ready：依赖 WP1a；独占 apps/server、docs/design、AGENTS.md、openspec 和新增 evidence；验收根 check/test、原型 check/快速 test、OpenSpec strict、diff check。契约是新增内部应用契约，不修改原型断言。无真实数据迁移。

## Decisions

- domain 负责严格输入校验与稳定错误码；application 定义 ChatCommands 和持久端口；runtime 绑定事务，storage 定义有版本的文档。
- 使用 Durable conversation ID 作为产品 chat ID。元数据为 session 文档族，按 ID 分片；历史只留在 entries。
- 收据为独立 session 文档族，按请求 ID 定位，保存规范化命令和不可变创建结果。结果是历史收据，不作为实时 chat 状态；不维护根级无界 map。
- 在唯一一个 harness.commit 中读取/创建收据、创建 conversation、写 metadata、写 result。任何异常回滚全部写入；成功响应只在 commit 返回后发布。
- 不使用快照后再写的去重流程。串行化由 Durable commit 保证；不新增锁、队列或数据库。
- 新文档 kind/version=1，旧 WP1a 数据按需添加文档，不改变 Meta 或已有历史。未来版本不匹配由 SDK 拒绝；不添加隐式迁移。首次用于真实数据前必须备份；本片仅临时目录测试。代码回滚后旧基础版只能查看健康，不能操作新数据；禁止把它作为产品数据降级方案。
- 崩溃测试通过包裹真实 Harness commit 在测试宿主内阻断提交前/返回前边界并 SIGKILL；正式代码不包含故障触发入口。

## Risks / Trade-offs

收据不清扫，保证长期重试语义但持续占用空间；清扫必须先定义幂等有效期协议。按键文档避免每次写全量 map，但未作规模/长跑性能承诺。名称规范化只有 trim，保留 Unicode 差异；请求标识严格 ASCII，不悄悄 trim。此片没有外部副作用，三态留到下一片模型请求先行实现。
