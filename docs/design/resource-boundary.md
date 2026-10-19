# 资源边界与副作用三态（WP2 基建）

> 2026-10-19。本文件是 WP2 的契约，代码与测试以此为准；实现细节可调整，接口、状态转移和拒绝语义不可悄悄改变。
> 目标：把浏览器、文件、通知、网络等外部能力统一成 Agent 层的 `resource{id, owner, lease, controlEpoch, state}` 边界，并把外部动作收敛为 `intent → attempting → done | unknown | failed`。
> 非目标：不接 Steel/CDP/puppeteer/RTC，不实现真实通知/文件/网络 adapter，不新增 Durable schema，不改 `openRuntime` 的既有对话行为。

## 1. 范围与文件

| 文件 | 内容 | 归属 |
|---|---|---|
| `apps/server/src/domain/resource.ts` | 纯类型、状态转移函数、错误类型；无 IO、无 SDK、无 node 内置模块 | 实现 |
| `apps/server/src/application/resource.ts` | 输入规范化、`ResourceStore` 端口、命令/查询用例、`ResourceEffectPort`、幂等收据 | 实现 |
| `apps/server/src/adapters/resource/memory.ts` | 内存 `ResourceStore` 实现（CAS + 收据 + 操作表），仅测试/样板 | 实现 |
| `apps/server/test/resource.test.ts` | 契约、租约/epoch、缺失资源、幂等、输入校验、原子 commit、边界矩阵 | 测试 |
| `apps/server/test/resource-operations.test.ts` | 副作用状态机、unknown 不重放、attempting 恢复、控制权 fence、竞态 A–E、并发 CAS | 测试 |
| `scripts/check-boundaries.mjs`、`scripts/boundaries.test.mjs` | `domain` 不得定义 Durable task 的不变量检查 | 平台 |

本轮**不改** `storage/**`、`runtime/**`、`api/**`、`bootstrap.ts`、`config.ts`、`open.ts`。资源状态的 Durable 持久化留给真实资源接入时的工作包（需要 schema 设计与迁移）。

## 2. 领域类型

```ts
// domain/resource.ts
export type ResourceId = string;
export type OwnerId = string;
export type ControlEpoch = number;

export type Lease = Readonly<{
  owner: OwnerId;
  expiresAt: number;
  epoch: ControlEpoch;
}>;

export type ResourceState = 'idle' | 'leased';

export type Resource = Readonly<{
  id: ResourceId;
  owner: OwnerId | null;
  lease: Lease | null;
  controlEpoch: ControlEpoch;
  revision: number;
  state: ResourceState;
}>;

export type OperationState = 'intent' | 'attempting' | 'done' | 'unknown' | 'failed';

export type ResourceOperation = Readonly<{
  id: string;
  requestId: string;
  resourceId: ResourceId;
  controlEpoch: ControlEpoch;
  state: OperationState;
  revision: number;
  fingerprint: string;
  result?: unknown;
  observation?: string;
}>;

export type ResourceErrorCode =
  | 'INVALID_COMMAND' | 'RESOURCE_NOT_FOUND' | 'RESOURCE_BUSY' | 'LEASE_EXPIRED'
  | 'STALE_CONTROL' | 'RESOURCE_CONFLICT' | 'OPERATION_NOT_FOUND'
  | 'INVALID_TRANSITION' | 'IDEMPOTENCY_CONFLICT';

export class ResourceError extends Error {
  constructor(readonly code: ResourceErrorCode) { super(code); this.name = 'ResourceError'; }
}
```

约束：`controlEpoch`、`revision` 是安全递增整数（`Number.isSafeInteger` 且 `>= 0`）；`revision` 在语义状态变化时加一，用于存储层 CAS；**guard 写可以带相同 revision 重写同一值，不递增 revision**，只用于把“读到的前置条件”和写入绑定在同一次 CAS。`lease.epoch` 必须等于写入时的 `controlEpoch`；`state === 'leased'` 当且仅当 `lease !== null`。

## 3. 资源状态转移（纯函数）

所有函数接收 `now: number`（毫秒），返回新 `Resource` 或抛 `ResourceError`；不得修改入参。

| 函数 | 语义 | 拒绝 |
|---|---|---|
| `initialResource(id)` | `owner=null, lease=null, controlEpoch=0, revision=0, state='idle'`；应用层 `acquire` 在资源缺失时用它创建资源 | 非法 id |
| `acquire(resource, {owner, ttlMs}, now)` | 无有效租约或租约已过期：创建新租约，`controlEpoch+1`，`expiresAt=now+ttlMs`；同 owner 且有效：原样返回（不重复递增） | 其他 owner 持有有效租约 → `RESOURCE_BUSY` |
| `renew(resource, {owner, epoch, ttlMs}, now)` | 租约有效且 owner/epoch 匹配：`expiresAt=now+ttlMs`，`revision+1` | 无有效租约 → `LEASE_EXPIRED`；owner/epoch 不匹配 → `STALE_CONTROL` |
| `release(resource, {owner, epoch})` | 租约匹配：清空 owner/lease，`state='idle'`，`revision+1`；已 idle 且 owner/epoch 匹配 → 原样返回 | owner/epoch 不匹配 → `STALE_CONTROL` |
| `takeover(resource, {owner, ttlMs}, now)` | 无论当前是否被租用，授予新租约，`controlEpoch+1`，旧 epoch 立即失效 | 非法 owner/ttl |
| `expire(resource, now)` | 有租约且 `now >= expiresAt`：清空 owner/lease，`state='idle'`，`revision+1`；否则原样返回 | — |
| `assertControl(resource, epoch)` | `epoch === controlEpoch` 时通过 | 不相等 → `STALE_CONTROL` |

“有效租约”统一为 `lease !== null && lease.expiresAt > now`。`takeover` 与过期后的 `acquire` 都递增 `controlEpoch`；`release`/`expire` 不递增。任何输入动作在执行前必须 `assertControl`，否则旧控制权会覆盖新 owner。

## 4. 副作用操作状态机

```text
intent ──attempt──▶ attempting ──settle(done|failed)──▶ done | failed
  │                        └────markUnknown────▶ unknown ──reconcile(done|failed)──▶ done | failed
  └──cancel(failed)──▶ failed        （派发前确定不执行：epoch 过期/资源缺失）
```

规则：

1. `intent` 只表示“已决定要做”，外部动作尚未发生。
2. 只有 `attempting` 可以进入 `done/failed/unknown`；`intent` 不能直接 `settle(done)`，但可以在派发前因控制权失效/资源缺失被 `cancel` 为 `failed`（result 记录原因），因为这确定没有外部副作用。
3. `unknown` 是保守终态：**禁止**再次 `attempt`、禁止自动重放；只能 `reconcile(observation)` 为 `done` 或 `failed`。
4. `done`、`failed` 是终态；重复结算返回原操作（幂等），不产生新写。
5. 任何非法转移抛 `INVALID_TRANSITION`。
6. 进程在 `attempting` 状态恢复时，必须先 `markUnknown`，再由观察核销；不得重新调用外部动作。

## 5. 应用层端口与命令

```ts
// application/resource.ts
export type CommandReceipt = Readonly<{fingerprint: string; result: unknown}>;

export type ResourceMutation = Readonly<{
  /** 同一业务结果的多条写入必须在一次 commit 内完成。 */
  resource?: Readonly<{value: Resource; expectedRevision: number | undefined}>;
  operation?: Readonly<{value: ResourceOperation; expectedRevision: number | undefined}>;
  receipt?: Readonly<{requestId: string; receipt: CommandReceipt}>;
}>;

export interface ResourceStore {
  load(id: ResourceId): Promise<Resource | undefined>;
  loadOperation(id: string): Promise<ResourceOperation | undefined>;
  findOperation(resourceId: ResourceId, requestId: string): Promise<ResourceOperation | undefined>;
  loadReceipt(resourceId: ResourceId, requestId: string): Promise<CommandReceipt | undefined>;
  /** 原子提交；任一 CAS 失败抛 RESOURCE_CONFLICT，全部不生效。 */
  commit(resourceId: ResourceId, mutation: ResourceMutation): Promise<void>;
}

/** 外部能力只实现这一个端口；unknown 只能由 observe 核销，不能由 invoke 重试。 */
export interface ResourceEffectPort {
  invoke(operation: ResourceOperation): Promise<unknown>;
}

/** 适配器用 known failure 表达“确定失败”；其他异常一律按 unknown 处理。 */
export class EffectFailure extends Error {
  constructor(readonly certainty: 'failed' | 'unknown', readonly code: string) { super(code); }
}

export interface ResourceCommands {
  acquire(input: unknown): Promise<Resource>;
  renew(input: unknown): Promise<Resource>;
  release(input: unknown): Promise<Resource>;
  takeover(input: unknown): Promise<Resource>;
  read(id: string): Promise<Resource | undefined>;

  beginOperation(input: unknown): Promise<ResourceOperation>;
  /** 幂等执行：intent 才派发；attempting 转 unknown 且不派发；unknown/done/failed 不派发。 */
  runOperation(operationId: string, effect: ResourceEffectPort): Promise<ResourceOperation>;
  /** 只核销 unknown；done/failed 原样返回；intent/attempting 拒绝。 */
  observeOperation(input: unknown): Promise<ResourceOperation>;
}

export function resourceCommands(
  store: ResourceStore,
  now: () => number,
  fingerprint: (value: unknown) => string = canonicalJson,
): ResourceCommands;
```

命令输入严格校验（多字段、缺字段、类型错误、超长一律 `INVALID_COMMAND`，不得隐式转换）：

| 命令 | 输入 |
|---|---|
| acquire | `{resourceId, requestId, owner, ttlMs}` |
| renew | `{resourceId, requestId, owner, epoch, ttlMs}` |
| release | `{resourceId, requestId, owner, epoch}` |
| takeover | `{resourceId, requestId, owner, ttlMs}` |
| beginOperation | `{operationId, requestId, resourceId, controlEpoch}` |
| observeOperation | `{operationId, status: 'done' \| 'failed', observation?, result?}` |

ID/owner 规则：`/^[A-Za-z0-9._:-]{1,128}$/`；`ttlMs` 为 `1..86400000` 的安全整数；`epoch` 为非负安全整数；`observation` 最长 512 字符。

幂等与事务语义：

- 资源写命令以 `(resourceId, requestId)` 为幂等键，`fingerprint` 是规范化命令的确定性 JSON 字符串；同键同指纹返回首次结果，同键异指纹抛 `IDEMPOTENCY_CONFLICT`。应用层不 import `node:crypto`；需要哈希时由组合根注入。
- `acquire` 在资源不存在时用 `initialResource` 创建资源（资源注册入口）；`renew`/`release`/`takeover`/`beginOperation` 对缺失资源抛 `RESOURCE_NOT_FOUND`。
- 资源状态变更与收据写入必须在同一次 `store.commit(...)` 中完成；任一 CAS 失败则全部不生效。内存实现必须在 commit 内先完成全部 CAS 校验再落 Map；真实 Durable 实现用单 commit。并发同键写入的失败方返回 `RESOURCE_CONFLICT`，顺序重试必须返回首次结果。
- **任何依赖已读 resource 的写入都必须带 resource guard**：`{value: 已读或新值, expectedRevision: 已读 revision}`。包括 no-op 资源命令（收据与 guard 同一 commit）、`beginOperation` 创建操作、`runOperation` 的 attempt 写回；这样 takeover/acquire 抢先时 CAS 失败，而不是把陈旧判断当成成功。
- CAS guard 写不递增 revision；只有语义状态真的变化时才 +1。guard 失败后**不得**派发外部动作；应用层必须重读 resource：epoch 过期或资源缺失则把 intent `cancel` 为 `failed` 并抛 `STALE_CONTROL`/`RESOURCE_NOT_FOUND`，epoch 仍匹配才有界重试 attempt（最多 2 次），仍冲突抛 `RESOURCE_CONFLICT`。
- `beginOperation` 以 `(resourceId, requestId)` 查找已有操作：同指纹返回原操作，异指纹 `IDEMPOTENCY_CONFLICT`；创建前对当前资源 `assertControl(controlEpoch)`，不存在资源 → `RESOURCE_NOT_FOUND`。
- `runOperation`：
  1. 加载操作；`intent` → 加载当前 resource 并 `assertControl(operation.controlEpoch)`；epoch 过期或资源缺失时把 intent `cancel` 为 `failed`（result 写对应 code），抛错且**不调用** effect；
  2. 通过 fence 后 `attempt` 写回 → 调 `effect.invoke`；
  3. 成功 → `done(result)`；抛 `EffectFailure('failed')` → `failed(result=code)`；其他抛出 → `unknown`；
  4. 结算写回失败时保持 `attempting`，交给恢复路径按第 4 节处理；
  5. `attempting` → 先 `unknown` 再返回（不派发）；`unknown/done/failed` → 原样返回，不派发。
- `observeOperation` 只接受 `unknown → done|failed`；`done/failed` 幂等返回；其他状态 `INVALID_TRANSITION`。

## 6. 内存适配器

`adapters/resource/memory.ts` 提供 `memoryResourceStore(): ResourceStore`：

- `Map` 保存 resource、operation、receipt；`load` 返回深拷贝，防止调用方改内部状态；
- `commit` 做 revision CAS：期望 `undefined` 时要求不存在，否则要求当前 revision 相等；先校验全部写入，再一次性落 Map，不满足抛 `RESOURCE_CONFLICT`；
- 收据同键同指纹幂等，异指纹 `IDEMPOTENCY_CONFLICT`；
- `commit` 的 CAS 窗口是同步的，单靠内存 store 无法复现 load→commit 竞态；测试必须包装 store，在 `load` 返回后、应用 `commit` 前对内部 store 插入一次抢占（takeover/acquire），断言应用返回 `RESOURCE_CONFLICT`/`STALE_CONTROL`，而不是用陈旧前置条件成功；
- 不持久化、不冒充生产存储；没有 Durable 文档、没有恢复语义。
- 时钟由调用方注入 `resourceCommands(store, now)`，测试不依赖真实时间。

## 7. 错误码与映射

| 码 | 含义 |
|---|---|
| `INVALID_COMMAND` | 输入不合法 |
| `RESOURCE_NOT_FOUND` | 资源不存在 |
| `RESOURCE_BUSY` | 有效租约被其他 owner 持有 |
| `LEASE_EXPIRED` | 续租/确认时租约已过期 |
| `STALE_CONTROL` | epoch/owner 不匹配，旧控制权被拒绝 |
| `RESOURCE_CONFLICT` | 存储 CAS 失败 |
| `OPERATION_NOT_FOUND` | 操作不存在 |
| `INVALID_TRANSITION` | 非法操作状态转移 |
| `IDEMPOTENCY_CONFLICT` | 同请求键不同内容 |

`ResourceError.code` 是后续 API 错误码映射的稳定来源；本轮不写 HTTP 映射。

## 8. 验收矩阵（测试必须覆盖）

1. acquire：空闲获取成功；第二 owner 被 `RESOURCE_BUSY`；同 owner 重复获取不递增 epoch。
2. 过期：过期后 acquire 成功且 epoch+1；renew 过期租约 `LEASE_EXPIRED`。
3. renew/release：owner/epoch 不匹配 `STALE_CONTROL`；release 幂等。
4. takeover：epoch+1，旧 epoch 的 renew/release/beginOperation 全被拒。
5. 操作状态机：非法转移全被拒；`unknown` 不能回 `attempting`；`reconcile` 后终态。
6. unknown 不重放：effect 抛未知错误后 `runOperation` 不再次调用 effect；恢复时 `attempting` 转 `unknown` 且不调用。
7. 幂等：同键同参返回首次结果、effect 只调用一次；同键异参 `IDEMPOTENCY_CONFLICT`。
8. 并发：同一资源并发 acquire（不同 owner）只有一个成功；同一 requestId 并发 beginOperation 只落一个 operation，失败方 `RESOURCE_CONFLICT`、顺序重试返回已有 operation；不同 operationId 允许并发。
9. 输入校验：缺字段/多字段/类型错误/超长/非法 epoch 均 `INVALID_COMMAND` 且无写入。
10. 边界：`domain/resource.ts`、`application/resource.ts` 无 `node:`/`@earendil-works`/`adapters`/`defineTask`；`scripts/check-boundaries.mjs` 的 AST 检查对函数类型泛型也生效。

## 9. 完成判据

- `npm run check` 通过（类型 + 边界/不变量）；
- `npm test` 全绿：服务端既有 33 项与边界脚本 10 项不回归，全量 84 项（33 既有 + 41 resource + 10 boundary）；
- 新增测试可独立运行：`npm run build && node --test apps/server/dist/test/resource*.test.js`（41/41）；
- 独立 reviewer 按 `docs/team/review-checklist.md` 给出至少一条实质意见并确认无 blocker；
- `docs/design/resource-boundary.md`、`verification-status.md`、`apps/server/README.md`、evidence 同步；
- 明确写出未验证项：无真实资源、无 Durable 持久化、无 HTTP 映射、无长时间并发压测。

## 10. 已知限制（本轮不解决，真实 adapter 必须承担）

- `runOperation` 的 attempt commit 与 `effect.invoke` 之间仍有一个窗口：takeover 可以在 attempt 已落盘之后、外部动作发生之前提交。CAS guard 只能保证“派发前没被抢先”，不能把外部调用与数据库事务变成原子操作。真实 adapter 必须在执行不可撤销动作前用资源端口再次 `assertControl`，或由资源侧互斥/租约机制保证；本轮内存实现不验证这一点。
- 内存 store 用同步 Map 模拟 commit；真实 Durable store 需要单 commit 和同一组 guard 语义。多进程/异步存储重排不在本轮验证范围。
- 不自动重试 CAS 冲突；调用方在 `RESOURCE_CONFLICT` 后重试是幂等安全的。

## 11. WP2 真实 adapter 增补（2026-10-19）

本节 supersede 本文件开头“本轮不实现真实 adapter/不新增 Durable schema”的历史范围描述。真实 adapter 已在独立变更中实现并通过最终安全评审：

- Durable resource/operation 文档版本、owner/lease/controlEpoch、attempt token、payload/evidence/result 绑定及 unknown 观察核销均为生产前置条件；unknown 永不自动重放。
- 文件与 Job artifact writer 使用 canonical realpath、逐级 lstat、O_NOFOLLOW/O_EXCL、0600 临时文件、fsync、原子发布与读回校验；symlink/TOCTOU 失败关闭。
- HTTP 与 file-outbox 仅由组合根显式构造；outbox 本地写入返回 `unknown/outbox-written`，不表示远端送达。CDP 仅允许显式 loopback/configured endpoint；截图只存 artifact 引用，evaluate 只存观察元数据，不存页面原文。
- `openRuntime` 不自动装配 file root、CDP endpoint 或通知 target；调用方必须显式构造 adapter effects 并注入 registry。真实 Steel、RTC/viewer、多会话、旧库迁移、长跑、真实 provider 查询核销和真实 artifact sink 集成仍未验证。

最终代码/安全评审见 `docs/team/reviews/wp2-real-adapters-final3.md`；本片数字与命令以 `docs/design/verification-status.md` 最新 WP2 段为准。
