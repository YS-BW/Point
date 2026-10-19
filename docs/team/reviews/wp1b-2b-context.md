# WP1b.2b 上下文预算 / Profile / 压缩保护独立评审（code-auditor）

> 2026-10-19。评审对象：分支 `wp/1b-context-budget`（基线 `315ec7e`，WP2 之后）上的 WP1b.2b 工作树改动。
> 评审人：code-auditor（独立于实现作者）；作者：context-impl（实现）/ senior-tester（测试）；契约与裁决：lead。
> 依据：[context-budget 契约](../../design/context-budget.md)、[agent-core 十条不变量](../../design/agent-core.md)、[评审检查清单](../review-checklist.md)、[server 架构](../../design/server-architecture.md)。
> 收尾复核后定稿：官方窗口 102/102；B1/P1 已修复并复核；F3/F4 为契约 §7 已记录的已知限制/未验证项；结论通过。

## 1. 结论

**通过（无未解决 blocker）。**

- 唯一 blocker **B1（契约要求的安全路径缺测试）** 已由 tester 补测试，我复核通过（unknown/attempting 两种 non-new → `MODEL_RESULT_NOT_RECOVERABLE`、供应商 0 调用、记录不被覆盖）。
- **P1（compact 幂等收据 key 未按 chat 作用域）** 已由 context-impl 修复为 `${chatId}:${requestId}`，tester 补跨 chat 测试，我独立探针复核通过。
- 收尾发现 **F3（崩溃后 ModelCalls 停留 attempting）** 与 **F4（若干未入库路径）** 为非阻塞；lead 已写入契约 §7 已知限制/未验证项。
- 最终验证：官方 `npm test` **102/102 pass**（服务端 92 = 既有 74 + 新增 18；`scripts/boundaries.test.mjs` 10）；targeted Profile/sections/compaction **18/18**；`npm run check` 通过；`npm run build` exit 0（官方窗口，lead/tester）。
- Scope 干净：只改契约列出的 10 个 src 文件、3 个测试文件、`docs/design/context-budget.md`、OpenSpec change；未改 `api/**`、`bootstrap.ts`、`config.ts`，既有 84 项测试未修改。
- 合并前仍需 task-9 完成 `verification-status.md`、`apps/server/README.md`、evidence/manifest 与 OpenSpec strict（文档收尾，不是代码 blocker）。

## 2. 评审范围与方法

- 新增：`domain/profile.ts`、`storage/profile.ts`、`application/profile.ts`、`runtime/profile.ts`、`runtime/context.ts`；`test/profile.test.ts`、`context-budget.test.ts`、`compaction.test.ts`。
- 修改：`runtime/model-guard.ts`、`runtime/conversation.ts`、`runtime/open.ts`、`application/conversation.ts`、`storage/conversation.ts`；`docs/design/context-budget.md`、OpenSpec `agent-context-budget`。
- 方法：只读代码与测试 + 官方 `apps/server/dist` 只读执行 + `/tmp` 独立探针（不写入仓库）。探针覆盖：compaction summarize 阶段 SIGKILL 恢复、跨 chat 同 requestId、不同 chat 并发压缩、同 chat 并发压缩、provider error、`__proto__` profile key、internal-execution chat section fallback、stale+new permit 歧义。

复核结果（官方窗口，2026-10-19 本地时点）：

| 命令 | 结果 |
|---|---|
| `npm run check`（tsc --noEmit + check-boundaries） | exit 0 |
| `npm test`（lead/tester 官方窗口） | **102/102 pass，0 fail** |
| `node --test apps/server/dist/test/*.test.js scripts/*.test.mjs`（我以只读方式复跑） | **102/102 pass**（server 92 + scripts 10） |
| `node --test apps/server/dist/test/compaction.test.js .../context-budget.test.js .../profile.test.js` | **18/18 pass** |
| `npm run build` | exit 0（lead/tester 窗口） |
| 既有测试文件 | 74 项服务端既有测试未修改，全部通过（84 项总基线不回归） |

## 3. Blocker（均已修复并复核）

### B1（已解决）契约 §5 的 non-new ModelCalls 不重放路径缺测试

- 问题：契约 §5 要求"已有 non-new 状态 → `MODEL_RESULT_NOT_RECOVERABLE`、不重放"，但原测试只覆盖 no-permit、permit 歧义、done 与 one-shot；缺少对 unknown/attempting 记录的回归保护。付费模型调用的 `unknown 禁止自动重放` 是 agent-core #3 的硬规则，不能只靠实现自觉。
- 修复：`compaction.test.ts:227` 预置 `point.model-call` state=unknown（81/22）与 attempting（82/23），注入唯一 permit 调 `completeSimple`，断言 `MODEL_RESULT_NOT_RECOVERABLE`、faux `callCount === 0`、doc 状态保持 unknown/attempting（不覆盖）。
- 复核：18/18 通过；我另用 Harness 直测确认实现行为正确（此前已手工验证，非实现缺陷）。

### P1（已解决）compact 幂等收据 key 未含 chatId

- 问题（修复前）：`CompactReceipts` 只用 `requestId` 作 key，而既有 send/stop 用 `${chatId}:${requestId}`。实测同一 requestId 在 chat A/B 各 compact 一次，第二次抛 `IDEMPOTENCY_CONFLICT`（两个合法命令被串话）。契约 §4 未写明 key 作用域，server-architecture §4 要求 requestId 作用于对象。
- 修复：`runtime/conversation.ts:108` 改为 `${command.chatId}:${command.requestId}`；契约 §4 明确"收据键为 `${chatId}:${requestId}`，不同 chat 的同一 requestId 互不冲突"。
- 复核：`compaction.test.ts:256` 覆盖跨 chat 同 key 两命令成功/各自重放/0 模型调用；我的独立探针得到两个不同 commandId、均 completed、0 次模型调用。

## 4. 实质意见

1. **F3（非阻塞，契约已记为已知缺口）崩溃恢复时 compaction 的 ModelCalls 不会核销为 unknown。** 我用 child-process SIGKILL 在 summarize 派发时杀进程，重启后：供应商 **0 调用**、压缩任务 terminal failed（`MODEL_GUARD_REQUIRED`）、原历史 10 条不变——fail-closed 正确；但 `point.model-call` 永久停留在 `attempting`（没有 permit 时 guard 甚至不会读 ModelCalls）。generation guard 的 attempting→unknown 恢复逻辑不覆盖压缩，因此"副作用三态"证据在 crash 路径不完整。契约 §7 已明确记录并要求后续补核销；建议 `verification-status` 的 WP1b.2b 证据段也写明"三态证据不完整"，不要用 happy path 外推。
2. **压缩 permit 的 sessionId 唯一匹配是正确但严格的设计：同一会话并发压缩会被 fail-closed（两个任务都失败）**，不同会话并发压缩正常（我验证两 chat 并发均 completed）。这符合契约"匹配不唯一 → 不调用供应商"，但调用方必须串行重试；契约 §7 已记录，后续可在命令层串行化。
3. **permit 依赖 `ProviderDoc` 先存在这一不变量是隐式的。** `beforeCompact` 通过 `ProviderDoc.sessionId` 记录 permit，missing 时静默不记录 → 压缩 fail-closed。当前 manual compact 在 admission commit 里预创建 ProviderDoc（`conversation.ts:114`），generation 路径由首次请求创建，因此两条路径都成立；建议保留该注释/测试，避免未来把 ProviderDoc 创建移到 summarize 之后而静默破坏 guard。
4. **sections 的文本边界可被用户内容伪造（低风险硬化项）。** chat name / profile value 允许 `<`/`>` 与 `</point_chat>` 序列；SDK 以结构化 `sections` 字段重放，功能不受影响，但模型看到的标签文本可能被内容打断。单用户产品下是自注入、非信任边界，建议后续对 section 内容做最小转义或明确"参考数据"框架。
5. **测试整体质量好于"smoke"**：sections 用 faux provider 捕获真实请求并断言结构化 sections 顺序/隔离/预算；compaction 覆盖真实 SDK 任务链、重启后 status、ModelCalls 持久记录；fail-closed 用真实 guard + Harness 验证供应商 0 调用。剩余缺口（F4）已由契约 §7 显式列出，不是隐藏假设。

## 5. 逐条检查（review-checklist：通用十条）

1. **事务边界**：Profile 收据 + 条目同一次 `tx`（`runtime/profile.ts:24-56`）；compact admission commit = 收据 + command task + ProviderDoc + configure（`conversation.ts:106-120`），command execute commit = 内层 CompactionTask 创建 + command terminal（`conversation.ts:34-47`）；ModelCalls 每次调用单独 commit。**通过**。
2. **幂等键**：Profile 用 `requestId + sha256(fingerprint)`（同键同指纹返回首次条目、异指纹冲突）；compact 收据键 `${chatId}:${requestId}`，同键重放返回首次 commandId；均与单 commit 绑定。**通过（P1 修复后）**。
3. **副作用三态**：generation guard 保持原语义；compaction 的 done 有测试、provider error → unknown（代码路径，我 probe 验证；未入库）、缺少 permit/歧义 fail-closed 且供应商 0 调用、non-new → `MODEL_RESULT_NOT_RECOVERABLE` 不重放（B1 测试）。crash 后 attempting 不核销为 unknown（F3，§7 已记录）。**通过（含 §7 已知缺口）**。
4. **状态与迁移**：新增 doc kinds 均 version 1（`point.profile`、`point.command.profile`、`point.command.compact`），无对既有 schema 的改写；Meta format 未变；仅新增文档族，无需迁移。**通过**。
5. **依赖方向**：`domain/profile.ts` 无任何 import；`application/profile.ts` 只 import domain；domain/application 无 fs/crypto/SDK；USER.md 仅字符串导出（domain/render + application 组合），服务端无写文件代码。**通过**。
6. **错误契约**：`ProfileError`（INVALID_COMMAND/IDEMPOTENCY_CONFLICT/PROFILE_LIMIT_REACHED）与 `CommandError`（compact 输入/冲突）稳定；guard 固定失败码 `MODEL_GUARD_REQUIRED`/`MODEL_RESULT_NOT_RECOVERABLE`/`MODEL_RESULT_UNKNOWN`/`MODEL_CANCELLED_BEFORE_DISPATCH`；HTTP 映射按契约留后续 WP。**通过**。
7. **测试**：见 §6 对照；B1 已补；F4 列出的缺口（internal fallback、自动/阻塞压缩、error/取消派发、无 crash fixture）已写入 §7。**通过（附已知缺口）**。
8. **文档与证据**：契约已同步（section key 下划线、admission/execute commit 边界、收据 key、instructions 上限、§7 限制与未验证项）；`verification-status`/README/evidence/OpenSpec strict 属 task-9，**合并前必须完成**。**部分完成**。
9. **性能敏感路径**：无 snapshot/SSE/迁移改动；profile 渲染最多 64 条、预算 8000，无新增无界循环；未做规模断言（本片非性能路径）。**不适用/可接受**。
10. **写作用域**：仅契约列出的 10 个 src 文件、3 个测试、context-budget.md、OpenSpec；未改 `api/**`、`bootstrap.ts`、`config.ts`，未改既有测试，未改依赖。**通过**。

## 6. 契约 §6 验收矩阵对照

| # | 要求 | 覆盖 |
|---|---|---|
| 1 | `npm run check` + `npm test` 全绿、既有 84 不回归 | 官方 102/102（92 server + 10 scripts）；74 既有服务端测试未改且全过；`check` exit 0 |
| 2 | 显式 remember/forget/export、幂等/冲突、64 上限、Profile 预算、chat 隔离、USER.md 仅导出 | `profile.test.ts:37/62/87/99/154/180`；`context-budget.test.ts:54/69/92/108` |
| 3 | 手动 compact 后历史可读、摘要可观察、后续请求含摘要、ModelCalls 记录、缺 permit fail-closed 且 0 调用 | `compaction.test.ts:102/158/180/204/227`（+ 我的 crash probe，见 §10） |
| 4 | 独立 reviewer + 证据/验证状态/README + 未验证项明确 | 本文件；文档收尾见 §7 N4（task-9） |

## 7. 非阻塞建议

- **N1（F3 后续）**：为 compaction 增加 `attempting → unknown` 的恢复核销路径（例如重启/下次压缩时按 conversationId 扫描遗留 ModelCalls，或由 guard 在 fail-closed 时核销），然后补 crash-injection 回归测试；在此之前 `verification-status` 必须写明"压缩三态证据不完整"。
- **N2（F4 测试）**：可低成本补：internal-execution 会话的 chat section fallback（render 探针已验证行为）、compaction provider error → ModelCalls unknown、取消派发 → failed、`compactStatus` 的 queued/submission 中间态。自动/阻塞压缩路径与进程级 crash fixture 成本较高，继续留在 §7 未验证项。
- **N3（并发压缩）**：如后续希望"同 chat 并发 compact 不双失败"，可在命令层串行化（同 conversationId 排队）并把行为写进契约；当前 fail-closed 是安全且已文档化的。
- **N4（合并前收尾，task-9）**：`verification-status.md` 增加 WP1b.2b 证据段（102 项、命令、时点、边界、F3 未验证）；`apps/server/README.md` 写 profile/compact 用法与边界（Profile 走 Durable 文档、USER.md 只导出不落盘、压缩模型调用受 permit 保护）；evidence JSON + manifest（只增不覆盖）；OpenSpec strict；AGENTS 当前阶段。
- **N5（硬化，低优先）**：section 文本对 `</point_chat>`/`</point_profile>` 等标签序列做最小转义或明确数据框架；当前结构化重放不受影响，属模型可读性/防混淆硬化。
- **N6（可选）**：为 Profile remember/forget 增加提交前/后故障注入（相邻 commit 失败不产生半条收据）——当前单 commit 结构上正确，测试未注入失败。

## 8. 未验证项与已知限制

- 真实模型压缩质量（本片只用 faux 脚本供应商）；自动压缩长跑阈值行为（只验证 settings 接线与手动压缩）。
- crash 后 compaction 的 ModelCalls 停留 `attempting`、无恢复核销（F3，§7 已记录；本轮不宣称三态完整）。
- 同一会话并发手动压缩 fail-closed，需调用方串行重试（§7 已记录）。
- internal-execution chat section fallback、generation-owned 自动/阻塞压缩、provider error/取消派发路径未进仓库测试（§7 已记录；其中 error/fallback 我用 /tmp 探针验证了行为）。
- 无进程级 SIGKILL fixture 入库（我用的 /tmp child-process 探针不属于交付测试）。
- `USER.md` 真实导入/双向同步、文件监听、HTTP/CLI 入口、成本/限流治理均留后续 WP。

## 9. 写作用域与越界检查

- `git status` 仅：5 个新增 src 文件、5 个修改 src 文件、3 个新增测试、`docs/design/context-budget.md`、OpenSpec change。
- 未触碰 `apps/server/src/api/**`、`bootstrap.ts`、`config.ts`；未改既有 84 项测试；未改 `package.json`/依赖（无第二引擎、版本锁定未变）。
- 本评审只写 `docs/team/reviews/wp1b-2b-context.md`，未改源码/测试/scripts，未执行 git 写操作。

## 10. 审计证据（独立探针，/tmp，不写入仓库）

| 场景 | 结果 |
|---|---|
| compaction summarize 派发时 SIGKILL → 重启（带模型绑定） | provider **0 调用**；压缩任务 terminal failed（`MODEL_GUARD_REQUIRED`）；原历史 10 条不变；**ModelCalls 停留 `attempting`**（F3） |
| 同 chat 两个并发手动 compact（不同 requestId） | 两个都 failed（permit 歧义 fail-closed），compaction 供应商 0 调用；符合契约 §5/§7 P2 |
| 不同 chat 两个并发 compact | 两个都 completed（entryId 各自产生），provider 12 次 = 10 seed + 2 summary |
| 跨 chat 同 requestId（P1 修复后） | 两个不同 commandId、均 completed、0 模型调用 |
| provider 返回 error 的压缩 | 压缩 failed，`ModelCalls` 落 `unknown`（代码路径正确，未入库测试） |
| `ModelCalls` 预置 non-new（B1 场景） | `MODEL_RESULT_NOT_RECOVERABLE`、供应商 0 调用、记录不覆盖 |
| internal-execution chat section | `当前是内部执行会话。`（fallback 正确，未入库测试） |
| profile key `__proto__` | 正常写入/列出/导出，无静默丢失 |
| stale permit + new permit | 新调用一次 fail-closed（歧义）后清空，下一次 permit 正常成功（自愈） |

## 11. 收尾状态

- 代码/测试在审计后仅做 B1/P1 修复（P1 改 `runtime/conversation.ts` 收据 key，B1/P1 各补测试），此外只有 lead 对 `docs/design/context-budget.md §4/§7` 的文档更新；未发现其他代码漂移。
- 最终官方：`npm test` 102/102、targeted 18/18、`npm run check` 通过、`npm run build` exit 0。
- 结论：**通过**。合并前完成 task-9 的文档/证据/验证状态收尾（N4），并在证据段如实标注 F3/F4。
