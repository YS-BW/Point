## Context

WP1a 只建立了 `adapters/resource/README.md` 边界说明；WP1b.1/2a 验证了对话命令与模型 dispatch 保护。外部能力尚未有统一契约，若直接接浏览器/通知，容易把租约、控制权和 unknown 语义散落到各 adapter。

Ready：WP2，依赖 WP1a/WP1b.1/2a 的模块边界。写作用域仅 domain/application/adapters、`scripts/check-boundaries.mjs`、测试与文档；不新增 Durable schema，不改运行时/API。

## Goals / Non-Goals

目标：定义资源身份、租约、`controlEpoch` 与副作用三态；用纯函数实现状态转移；用应用层命令保证幂等、epoch fencing、unknown 不重放；用内存适配器跑通契约与并发 CAS；把"domain/application 不得定义 Durable task"变成机器检查。

非目标：真实浏览器/文件/通知 adapter；Durable 持久化与恢复；HTTP 错误码映射；长时间多进程压测；WP1b.2b/3/4 业务分片。

## Decisions

- 资源状态用 `revision` 做存储 CAS，`controlEpoch` 做控制权 fence：任何输入动作先 `assertControl`，`takeover` 与过期后的重新 acquire 递增 epoch。
- 副作用状态机固定为 `intent → attempting → done|failed|unknown`，`unknown` 只能 `reconcile`，任何路径不得从 `unknown` 回到 `attempting`；`runOperation` 对 `attempting` 先转 `unknown` 再返回，不调用 effect。
- 写命令使用 `(resourceId, requestId)` 幂等键与规范化指纹；资源、收据、操作状态在同一次 `store.commit` 原子写入。内存 store 先校验全部 CAS 再落 Map，避免"半状态"。
- 应用层不 import `node:crypto`；指纹默认是纯函数规范化 JSON，需要哈希时由组合根注入。
- 本轮不写 Durable schema：内存适配器明确标注 test-only，不宣称持久化或崩溃恢复。真实接入时需要 storage 设计、迁移与恢复验收。
- `domain/application` 不得定义 Durable task；由 `scripts/check-boundaries.mjs` 的内容检查拒绝。

## Risks / Trade-offs

内存 store 只能证明接口与单进程并发语义，不证明跨进程或崩溃恢复；`unknown` 的观察核销只有应用层入口，没有真实供应商观察器；CAS 仅对内存实现有意义。以上均列为未验证项，不能由测试全绿外推为生产资源可用。

## Migration Plan

无 schema、无数据迁移。旧库可继续打开；本片新增文件不改变既有对话行为。回滚只需删除新增文件与检查规则，不涉及数据降级。
