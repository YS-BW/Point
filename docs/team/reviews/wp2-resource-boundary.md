# WP2 资源边界独立评审（code-auditor）

> 2026-10-19。评审对象：分支 `wp/2-agent-resource-infra`（基线 `51d9023`）上的 WP2 工作树改动。
> 评审人：code-auditor（独立于实现作者）；作者：resource-impl / senior-tester / boundary-impl；契约 owner 与裁决：lead。
> 依据：[resource-boundary 契约](../../design/resource-boundary.md)、[agent-core 十条不变量](../../design/agent-core.md)、[评审检查清单](../review-checklist.md)、[agent-team §5.2](../agent-team.md)。
> 本文件在收尾复核后更新：N2–N6 已解决，补最终官方数字与“审计后仅 scripts/test 改动、src 冻结”说明；结论仍为通过。

## 1. 结论

**通过（无未解决 blocker）。**

- 评审中发现的唯一 blocker（B1：check-then-write 缺少 resource CAS guard，内存同步 commit 掩盖竞态）经 lead 裁决本轮修复；修复后我用独立复现脚本与 race A–E 回归测试复核，全部 fail-closed。
- 收尾复核（第二轮）：**N2/N3/N4/N5/N6 已全部解决**（见 §7）；仅 N1（beginOperation 冲突码，需 lead 决策）、N8/N9（后续 WP 事项）仍开放，均为非阻塞。
- 最终验证：官方 dist 全量 **84/84**、targeted resource **41/41**、`npm run check` 通过、官方 build 通过（lead/tester 窗口）、原型快速回归 **28/28**、OpenSpec `agent-resource-boundary` strict valid。
- 审计定稿后源码冻结：B1 修复完成（09:22–09:27）之后，`domain/resource.ts`、`application/resource.ts`、`adapters/resource/memory.ts` 未再修改；后续改动只在 `scripts/**` 与 `apps/server/test/**`（见 §11）。
- 已知限制（attempt commit↔effect.invoke 窗口由真实 adapter 自检 epoch）已写入契约 §10 与本文 §8，不作为本 WP 的 blocker。

## 2. 评审范围与方法

- 新增：`apps/server/src/domain/resource.ts`、`application/resource.ts`、`adapters/resource/memory.ts`；`test/resource.test.ts`、`test/resource-operations.test.ts`；`docs/design/resource-boundary.md`、`docs/team/review-checklist.md`、`docs/team/status.md`、`openspec/changes/agent-resource-boundary/`、WP2 evidence JSON。
- 修改：`scripts/check-boundaries.mjs`、`scripts/boundaries.test.mjs`（N2 改为 AST 检查）；收尾窗口另更新 `verification-status.md`、`apps/server/README.md`、`docs/design/README.md`、`AGENTS.md`、evidence manifest。
- 复核基线：`storage/**`、`runtime/**`、`api/**`、`bootstrap.ts`、`config.ts`、`open.ts` 无改动；既有测试文件未被修改。
- 方法：只读代码与测试 + 独立运行检查；额外写了 /tmp 下的竞态复现脚本（不写入仓库）。为避免与 lead/tester 的 `npm run build` 冲突，**没有**自己跑 `npm test`；改为在官方 `apps/server/dist/` 上只读执行测试，并用临时 outDir 编译对照。

复核结果（收尾窗口，2026-10-19 本地时点）：

| 命令 | 结果 |
|---|---|
| `npx tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| `node scripts/check-boundaries.mjs` | `Architecture boundaries passed` |
| `node --test apps/server/dist/test/*.test.js scripts/*.test.mjs` | **84/84 通过，0 fail**（服务端既有 33 + resource 41；`scripts/boundaries.test.mjs` 10） |
| `node --test apps/server/dist/test/resource*.test.js`（targeted） | **41/41 通过，0 fail** |
| 原型 `cd infra/pi-durable-validation && npm run check && POINT_CRASH_ROUNDS=1 npm test` | check exit 0；**28/28 通过，0 fail** |
| `openspec validate agent-resource-boundary --strict` | `Change 'agent-resource-boundary' is valid` |
| 独立竞态复现（用当前 dist 的 src 产物） | no-op acquire → `RESOURCE_CONFLICT`；runOperation → `STALE_CONTROL` 且 effect 0 次（与首轮修复后一致，证明 src 已冻结） |
| 官方 `npm run build` | 由 lead/tester 最终窗口报告通过；评审未重跑以避免写入 dist（dist 产物 09:32 之后仅 `resource.test.ts` 注释一行改动，不影响编译/测试语义；tester 隔离构建 resource 18/18） |

## 3. Blocker

### B1（已修复并复核）check-then-write 缺少 resource CAS guard

- 位置（修复前）：`application/resource.ts` 的 `mutateResource` no-op 分支只写收据、不写 resource；`beginOperation` 的 operation 创建 commit 不带 resource guard；`runOperation` 的 attempt commit 不带 resource guard。
- 影响：资源前置条件（epoch/revision）的检查与写入不在同一次 CAS 内。真实 Durable/异步 store 的 commit 是排队执行的，takeover 可以排在“检查之后、写入之前”，导致：
  1. 同 owner 重复 `acquire`（no-op）**返回陈旧成功**：返回 owner-a/epoch 1，store 实际 owner-b/epoch 2；
  2. `beginOperation` 在 takeover 后仍创建并返回 epoch 1 的 operation；
  3. `runOperation` fence 通过后 takeover 先落盘，**effect 仍被派发**（effect 收到 epoch 1，当前 epoch 2）。
- 为什么是 blocker：这是 WP2 要冻结给后续真实 adapter 照抄的模式；内存 adapter 的 commit 同步完成，修复前的测试不可能暴露。属于“内存实现掩盖竞态”，不是测试假象。
- 修复（当前工作树，src 已冻结）：`mutateResource` 无条件在同一次 commit 写 resource guard（no-op 用相同 revision；create 用 `expectedRevision: undefined`）；`beginOperation` 创建 operation 时带 `resource: {value: resource, expectedRevision: resource.revision}`；`runOperation` fence 后 attempt commit 带 resource guard，冲突时重读、epoch 变化/资源消失则 `cancel` 为 `failed` 且不派发，同 epoch 有界重试（`MAX_ATTEMPT_RETRIES = 2`）。
- 复核（用包装 store 在“检查后、commit 前”插入真实 takeover 命令，首轮与收尾各跑一次）：
  - no-op acquire → `RESOURCE_CONFLICT`，store owner 为 takeover 方，顺序重试得到 `RESOURCE_BUSY`；
  - beginOperation → `RESOURCE_CONFLICT`，未落 operation（race B 接受 `STALE_CONTROL|RESOURCE_CONFLICT`）；
  - runOperation → `STALE_CONTROL`，`effect` 调用次数 0，operation 落 `failed(result='STALE_CONTROL')`；
  - 回归测试：`resource-operations.test.ts:490/511/527/552`（race A–D）、`:596`（race E，重试耗尽不派发）。
- 残余（契约 §10 已记录，非 blocker）：attempt commit 与 `effect.invoke` 之间仍有不可避免窗口；真实 adapter 必须在执行不可撤销动作前用资源端口再次 `assertControl`，或由资源侧互斥保证。本轮内存实现不验证。

## 4. 实质意见

1. **B1 的根因是“检查与写入没有绑定进同一个 CAS”，修复方向正确，但契约需要把 guard 语义固定下来。** 契约已补 §2（guard 写可带相同 revision 重写同一值、不递增 revision）与 §5（任何依赖已读 resource 的写入都必须带 resource guard、失败后重读/取消/有界重试）。这是后续真实 Durable store 必须实现的语义，建议在真实资源接入 WP 的验收里加一条“guard 写不改变 revision 且 CAS 可失败”的契约测试。
2. **`runOperation` 的 fence 是“派发前尽力而为”，不是原子保证。** 即使加了 attempt commit guard，takeover 仍可在 attempt 已落盘之后、`effect.invoke` 之前提交。契约 §10 与本评审 §8 已注明由 adapter 承担；后续 adapter WP 的评审必须检查这条，不能把 WP2 的 fence 当成外部动作的最终互斥。
3. **新增的 `cancel`（intent → failed）改变了副作用三态的语义边界，但方向合理。** 派发前因控制权失效/资源缺失取消，确定没有外部副作用，归入 `failed` 并保留稳定 code 到 `result` 是自洽的；风险在下游若把 `failed` 一律解释为“尝试过且失败”会失真，建议 WP4 错误码映射时区分 `failed` 的 `result` 来源（cancel code vs adapter code）。

## 5. 逐条检查（review-checklist：通用十条）

1. **事务边界**：明确。资源变更 + 收据在同一次 `store.commit`；`beginOperation` 的资源 guard + operation 创建同一次 commit；内存 commit 先完成全部 CAS 校验再落 Map，无半状态（`memory.ts:63`；直测 `resource.test.ts:368` 用三种失败 CAS 验证 resource/operation/receipt 全部不生效）。**通过**。
2. **幂等键**：资源写命令以 `(resourceId, requestId)` + 确定性 fingerprint 去重，同键异参 `IDEMPOTENCY_CONFLICT`（`application/resource.ts:258-290`；测试 `resource.test.ts:225`）；`beginOperation` 用 `findOperation` 按同键重放（`resource-operations.test.ts:388`）；`runOperation` 由操作状态幂等（done/failed/unknown 不再派发）。**通过**。
3. **副作用三态**：`EffectFailure('failed') → failed(result=code)`；`EffectFailure('unknown')` 与任何其他抛出 → `unknown`；`unknown` 只可由 `observeOperation` 核销；`attempting` 恢复先 `markUnknown` 且不调用 effect（`resource-operations.test.ts:283/309/334`）。**通过**。
4. **状态与迁移**：本轮只有内存 store，无 Durable schema/迁移；契约 §6/§10 明示“仅测试、无持久化/恢复”。**通过（符合本轮边界）**。
5. **依赖方向**：`domain/resource.ts` 无任何 import；`application/resource.ts` 只 import domain；`scripts/check-boundaries.mjs:36`（AST）与 `resource.test.ts:414` 双重检查（domain/application 无 `node:`/SDK/adapter/defineTask）。**通过**。
6. **错误契约**：9 个稳定 `ResourceErrorCode`，应用层不 import `node:crypto`，fingerprint 由组合根注入；HTTP 映射按契约留到后续 WP。**通过**。
7. **测试**：正常/非法/并发/unknown/attempting 恢复/race A–E/不同 operationId 并发均有覆盖（§6 对照）；首轮指出的 IDEMPOTENCY_CONFLICT、OPERATION_NOT_FOUND、cancel 矩阵、多写原子性、不同 operationId 并发、重试耗尽已全部补齐。**通过**。
8. **文档与证据**：契约（含 §10 限制）、`verification-status.md`（WP2 段，84 项口径）、`apps/server/README.md`（资源边界与“仅内存、未持久化”）、`docs/team/status.md`、evidence JSON + manifest、OpenSpec strict 均已同步。**通过**。
9. **性能敏感路径**：本轮无 snapshot/SSE/迁移；内存 store 无规模断言，非本 WP 目标。**不适用**。
10. **写作用域**：实现仅本 WP 列出的文件 + `scripts/**`；未改 `storage/runtime/api/bootstrap/config/open`，未改既有测试。**通过**。

WP2 附加项：domain 无 node/SDK/adapter/defineTask（通过；AST 检查已覆盖函数类型泛型）；epoch 转移与 `assertControl` 一致（通过）；`unknown` 不可回 `attempting`（通过）；同键同参 effect 只执行一次、同键异参冲突（通过）；内存 commit 先校验后落盘（通过）；并发 acquire/beginOperation + race 覆盖（通过）；文档明确“仅测试、无持久化/HTTP 映射”（通过）。

## 6. 契约 §8 验收矩阵对照

| # | 要求 | 覆盖 |
|---|---|---|
| 1 | acquire 空闲成功 / 第二 owner BUSY / 同 owner 不递增 epoch | `resource.test.ts:85/103/192/205` |
| 2 | 过期后 acquire epoch+1；renew 过期 LEASE_EXPIRED | `resource.test.ts:112/127` |
| 3 | renew/release owner/epoch 不匹配 STALE_CONTROL；release 幂等 | `resource.test.ts:127/139/253` |
| 4 | takeover epoch+1，旧 epoch 的 renew/release/beginOperation 被拒 | `resource.test.ts:151/287`；`resource-operations.test.ts:359` |
| 5 | 非法转移全拒；unknown 不可回 attempting；reconcile 后终态 | `resource-operations.test.ts:158/182/200/210/220/334` |
| 6 | unknown 不重放；attempting 恢复转 unknown 且不调 effect | `resource-operations.test.ts:283/309/334` |
| 7 | 同键同参返回首次结果、effect 只一次；同键异参冲突 | `resource.test.ts:205/225`；`resource-operations.test.ts:267/283/424` |
| 8 | 并发 acquire / beginOperation / 不同 operationId + race A–E | `resource-operations.test.ts:388/406/424/572/490/511/527/552/596` |
| 9 | 输入校验 INVALID_COMMAND 且零写入 | `resource.test.ts:313/357`；`resource-operations.test.ts:449` |
| 10 | domain/application 边界 | `resource.test.ts:414`；`scripts/boundaries.test.mjs:23-53` |

§8 全部条目均有直接覆盖（原缺口“不同 operationId 允许并发”已由 `resource-operations.test.ts:572` 补齐）。

## 7. 非阻塞建议（收尾状态）

- **N1（open，需 lead 决策）**：beginOperation 的 guard 冲突当前直接抛 `RESOURCE_CONFLICT`，未按 lead 方向“重读后 epoch 变→`STALE_CONTROL`”。行为是 fail-closed、测试 race B 接受两种码；若要单次调用给调用方稳定 `STALE_CONTROL`，补一次重读即可；否则建议把该行为写进契约，避免 WP4 映射歧义。
- **N2（已解决）**：`scripts/check-boundaries.mjs:36` 已改为 AST `ts.isCallExpression` + 标识符 `defineTask`；实测 `defineTask<Input, () => void, Result>(...)` 命中，`obj.defineTask` / 同名本地函数 / 字符串 / 注释不误报；测试 `scripts/boundaries.test.mjs:48/53` 覆盖函数类型泛型正反例。
- **N3（已解决）**：契约 §1 已列 `resource.test.ts` + `resource-operations.test.ts`；§9 独立运行命令改为 `node --test apps/server/dist/test/resource*.test.js`（41/41）。
- **N4（已解决）**：`resource.test.ts:45-48` fixture 注释已改为“only `acquire` creates a missing resource, every other command reports RESOURCE_NOT_FOUND”，与 acquire 创建契约及 192/205 行用例一致；仅注释改动，测试逻辑未变（tester 隔离构建 18/18）。
- **N5（已解决）**：`resource-operations.test.ts:572` 新增“different operation ids on one resource commit concurrently without overwriting each other”。
- **N6（已解决）**：`resource-operations.test.ts:596` 新增 race E“exhausted attempt retries throw RESOURCE_CONFLICT without dispatching the effect”。
- **N7（已解决）**：`verification-status.md` WP2 段（84 项口径/命令/时点/边界）、`apps/server/README.md` 资源边界与仅内存说明、`docs/team/status.md`、evidence JSON + manifest、OpenSpec strict 均已完成。
- **N8（open，后续 WP）**：fence 取消后首次 `runOperation` 抛 `STALE_CONTROL`，重放返回 `failed(result='STALE_CONTROL')`（契约 §5 允许 failed 原样返回）。对重试型调用方是“错一次、之后返回失败记录”，建议在 WP4 错误映射时明确，或契约补一句。
- **N9（open，deferred）**：`done(result)` 的 result 无大小限制（内存 store 无持久化）。真实 Durable 接入时应加限额/裁剪，否则可能把外部大对象写进状态。

## 8. 未验证项与已知限制

- 无真实资源 adapter：`ResourceEffectPort` 只有测试桩；浏览器/文件/通知/网络均未接入。
- 无 Durable 持久化：内存 store 无崩溃恢复、无多进程/单写者语义、无迁移。
- 无 HTTP/API 错误码映射；无 AG-UI 投影。
- 无长时间/高并发压测；无异步真实 store 的 commit 重排验证（本轮用 wrapper 模拟）。
- **不可避免窗口**：attempt commit 与 `effect.invoke` 之间 takeover 仍可生效；真实 adapter 必须在执行不可撤销动作前自检 `assertControl`，或由资源侧互斥/租约机制保证（契约 §10，本 WP 不验证）。
- guard 写语义（相同 revision 重写同一值、不递增 revision）只在内存 store 验证；真实 Durable store 必须实现同一语义（契约 §2/§5）。

## 9. 写作用域与越界检查

- 实现写作用域：新增 3 个 `apps/server/src/**` 文件、2 个 `apps/server/test/**` 文件、`scripts/check-boundaries.mjs` + `scripts/boundaries.test.mjs`；未触碰 `storage/**`、`runtime/**`、`api/**`、`bootstrap.ts`、`config.ts`、`open.ts`，未修改既有 37 项测试，未改 `package.json`/依赖。
- 审计后（首轮评审完成之后）的变更只有：`scripts/check-boundaries.mjs`、`scripts/boundaries.test.mjs`（N2）、`apps/server/test/resource-operations.test.ts`（N5/N6）、`apps/server/test/resource.test.ts`（N4 注释）；另有 lead/task-5 的文档/证据/状态更新。**src 未再改动**（见 §11）。
- 本评审只写 `docs/team/reviews/wp2-resource-boundary.md`，未改源码/测试/scripts，未执行 git 写操作。

## 10. 复核记录（修复前后）

| 场景（包装 store 在“检查后、commit 前”插入 takeover） | 修复前 | 修复后 |
|---|---|---|
| 同 owner 重复 acquire（no-op） | 返回 owner-a/epoch 1，store 为 owner-b/epoch 2（陈旧成功） | `RESOURCE_CONFLICT`，store 为 takeover 方；重试 `RESOURCE_BUSY` |
| beginOperation | 返回 epoch 1 operation，store epoch 2 | `RESOURCE_CONFLICT`，无 operation 落盘 |
| runOperation fence | effect 被派发 1 次（收到 epoch 1，当前 epoch 2，state done） | `STALE_CONTROL`，effect 0 次，operation `failed(result='STALE_CONTROL')` |

## 11. 审计后变更与最终状态（src 冻结说明）

| 文件 | 审计定稿后是否改动 | 内容 | 验证 |
|---|---|---|---|
| `apps/server/src/domain/resource.ts`（09:22） | 否 | — | 当前 dist 行为与审计时一致 |
| `apps/server/src/application/resource.ts`（09:27） | 否 | — | 重跑 race 探针仍 fail-closed |
| `apps/server/src/adapters/resource/memory.ts`（09:27） | 否 | — | 原子性/深拷贝测试通过 |
| `scripts/check-boundaries.mjs`（09:30） | 是 | N2：正则 → AST | boundaries 10/10；泛型函数实参命中 |
| `scripts/boundaries.test.mjs`（09:30） | 是 | N2 正反例 +2 | 随全量 84/84 |
| `apps/server/test/resource-operations.test.ts`（09:30） | 是 | N5/N6 用例 +2 | targeted 41/41 |
| `apps/server/test/resource.test.ts`（09:33） | 是（仅注释） | N4 一行注释 | tester 隔离构建 18/18；全量口径不变 |

结论：**审计后只有 `scripts/**` 与 `apps/server/test/**` 的改动（N2、N4、N5、N6），`apps/server/src/**` 未再修改**；最终官方窗口 84/84、targeted 41/41、check/build 通过、原型 28/28、OpenSpec strict valid，与 §2 复核一致。
