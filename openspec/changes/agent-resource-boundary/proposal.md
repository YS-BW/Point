## Why

Agent 层需要浏览器、文件、通知、网络等外部能力，但当前 `apps/server/src/adapters/resource/` 只有 README，domain 没有统一的资源身份、租约、控制权与副作用三态，外部动作无法在不引入第二套状态机的前提下接入。WP2 先建立这个边界，并用内存适配器证明接口可验证；真实资源与 Durable 持久化另立工作包。

## What Changes

- 新增 `domain/resource.ts`：`resource{id, owner, lease, controlEpoch, state, revision}`、纯状态转移、操作状态机。
- 新增 `application/resource.ts`：严格输入、`ResourceStore`/`ResourceEffectPort`、命令与查询用例、幂等收据、原子 commit。
- 新增 `adapters/resource/memory.ts`：内存 store，仅测试/样板，不持久化、不冒充生产实现。
- 扩展不变量检查：`domain`/`application` 不得定义 Durable task。
- 测试：lease/epoch fencing、非法转移、unknown 不重放、幂等、并发 CAS、非法输入零写入。
- 文档与验证状态：新增资源边界契约与 WP2 证据。

## Capabilities

### New Capabilities
- `resource-boundary`: 资源租约、控制权 epoch、副作用三态与幂等边界。

### Modified Capabilities
无。

## Impact

只新增 `apps/server/src/domain/resource.ts`、`apps/server/src/application/resource.ts`、`apps/server/src/adapters/resource/memory.ts`、测试与 `scripts/check-boundaries.mjs`；不改 storage/runtime/api/bootstrap/open，不新增 Durable schema，不接真实浏览器/通知/文件。无数据迁移。
