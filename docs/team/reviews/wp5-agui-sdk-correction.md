# WP5 官方 AG-UI SDK 兼容性纠偏独立审计

> 2026-10-19。对象：主检出分支 `fix/wp5-agui-sdk-compliance`，HEAD **`fef0c34`**，base `17cb911`（`git diff 17cb911..fef0c34`）。
> 评审人：code-auditor。只读审计 + 独立探针；仅写本文件，未改源码/测试。worktree clean。
> 结论：**PASS（无 blocker）**；§7 非阻塞项建议在合入/后续片处理。

## 1. 验证

| 项目 | 结果 |
|---|---|
| 隔离构建（`tsc --outDir /tmp/point-wp5sdk`） | BUILD_OK |
| AG-UI 套件 | **24/24 pass** |
| API 套件 | **14/14 pass** |
| 服务端全量隔离构建 | **317/317 pass** |
| `scripts/*.test.mjs` | **11/11 pass** |
| 合计 | **328/328**（与 `verification-status`/证据的 328/328 一致） |
| `tsc --noEmit` / `check-boundaries.mjs` | exit 0 / passed |
| 证据 `root-tests`（同树） | exit 0，tests 328 / fail 0；**前次失败 326/327 输出保留在 `priorFailedVerification`** |
| 原型/OpenSpec（证据） | prototype 28/28、openspec exit 0；本次未重复长跑 |

独立探针（未复用作者断言）：
- 真实 runtime 流：`RUN_STARTED → STEP_STARTED → TEXT_MESSAGE_* → STEP_FINISHED → MESSAGES_SNAPSHOT → RUN_FINISHED`；全部事件通过官方 `EventSchema.safeParse`；`outcome={type:'success'}`、无 `usage`；snapshot IDs 与 `conversation.history` **完全一致**（`["22","27"]`）。
- `document` 类 UI 检查仍通过（本纠偏未回退 b5e1211 的 DOM_REFERENCE）。
- 边界探针：`api/agui`/`api` 可 `@ag-ui/*`，runtime/application/domain/storage 禁止；cli 仅 `@ag-ui/client`/`node:`；其它 lane 规则未变。
- 413 探针：5 次 declared oversized 全 413 `PAYLOAD_TOO_LARGE`；chunked 溢出 413；未执行命令。
- LIFO 探针沿用上轮：取消/嵌套 tool/多 step 仍严格逆序。
- Observation 错误探针：`OBSERVATION_RESYNC_REQUIRED` → 最后 `RUN_ERROR`，code/message 固定；`cancel()` 仅停止观察（1 次），无 stop 命令。

## 2. Wire 契约变更（通过）

- **官方 schema/encoder**：`api/agui/events.ts:1-17` 改为 `@ag-ui/core` 的 `Event`/`EventSchema` 与 `@ag-ui/encoder` `EventEncoder`；`PROTOCOL_VERSION` 从官方包导出。`sseFrame` 先 `EventSchema.parse` 再编码，非法事件在出口即失败。
- **outcome 对象**：`api/agui/projection.ts:105-115` 发 `RUN_FINISHED.outcome = {type:'success'|'cancelled'}`；官方 schema 实测接受。
- **usage 省略**：`projection.finish` 不再发标准 usage；代码注释与 README/`protocol-agui.md` 说明“会话账本差分不能归属单次 run”，`AgentRunEvent.run_end.usage` 仅保留可选内部字段。`verification-status` 明确此前汇总 usage 不足以证明官方兼容。
- **官方客户端**：`cli.ts:11,100-130` 使用 `HttpAgent`；测试覆盖 consecutive dialogue、重试不重复执行、truncated/坏 JSON/坏已知字段非零退出、unknown event 容忍。
- **无第二事实/无持久 schema**：runtime 不写 run/stream 状态；`MESSAGES_SNAPSHOT` 由 `conversation.history`（Durable）派生并只发事件；op（OpenSpec）明确“无 persistent schema change”。

## 3. MESSAGES_SNAPSHOT（通过，附测试缺口）

- 代码：`runtime/agui.ts:258-274` 分页读 `conversation.history`，限制 **1000 页 / 8 MiB / 10,000 条**；超限在 `yield messages_snapshot` **之前** `throw OBSERVATION_RESYNC_REQUIRED`，不会发不完整快照。`projection.ts:80-84` 先 `closeEntities()` 再写 `MESSAGES_SNAPSHOT`。
- 真实探针：snapshot 2 条消息、ID 与 Durable history 一致；官方 `EventSchema` 通过；随后 `RUN_FINISHED`。
- 范围：仅现有可见文本历史，完整工具历史/重连/增量仍 WP6；OpenSpec correction/README 已写明；用户已确认该 scope。**不是第二事实源**（不落盘、可重建）。
- 测试缺口（非阻塞）：没有直接覆盖 10k/8MiB/1000 页边界与“超限不发快照”的测试；建议补 runtime 单测/fake history。

## 4. OBSERVATION_TIMEOUT / RESYNC（通过语义，测试缺口）

- `runtime/agui.ts:133/137/253/272` 分别对队列溢出、SDK resnapshot、空闲超时抛 `OBSERVATION_RESYNC_REQUIRED`/`OBSERVATION_TIMEOUT`；`route.ts:95-99` 映射为 `RUN_ERROR` 固定 message/code。
- **不取消执行**：route finally 只 `run.cancel()`（停止观察）；不调用 `conversation.stop`。探针确认 cancel 调用 1 次、无 stop 命令；真实测试“closing observation does not stop execution; same-key retry recovers result”通过。
- 语义注意：wire 上仍是标准 `RUN_ERROR`（终态观察事件），但 code/message 明示“observation interrupted; execution status must be synchronized”；文档说明不代表执行失败。属官方协议无 observation 专用事件下的合理表达；非阻塞。
- 测试缺口：没有 OBSERVATION_TIMEOUT/RESYNC 的测试；建议补 route/runtime 回归。

## 5. 分层与边界（通过）

- `@ag-ui/*` 只在 `apps/server/src/api/agui/events.ts`；`runtime/agui.ts` 只用 pi-durable 公开 API + `application/agent-stream` 中性类型；`application/agent-stream.ts` 零 import；domain/storage 无 AG-UI。
- `cli.ts` 仅额外允许 `@ag-ui/client`：`scripts/check-boundaries.mjs:25,28-31` 的条件为 `spec === '@ag-ui/client'` 且仅 `lane === 'cli.ts'`；其它 lane 规则原样。
- 探针：api/agui、api 放行 `@ag-ui/*`；runtime 导入 `@ag-ui/encoder` 报 forbidden；application/domain/storage 报 forbidden/platform；cli 的 `@ag-ui/core/schemas`、相对 import、pi-durable import 均拒；`@ag-ui/client` 放行；未注册 lane 仍报错。`scripts/*.test.mjs` 11/11。
- 依赖：`@ag-ui/core/client/encoder@1.0.3`、`zod@3.25.76` 精确 pin（package/lock）；`@ag-ui/client` 只由 CLI 使用。**是否与“只采用协议、不采用 CopilotKit 运行时”冲突**：不冲突；`protocol-agui.md` 已更新为“复用官方协议 SDK、保持 Durable 唯一执行引擎、CLI 用 HttpAgent、不引入 CopilotKit Agent 运行时”。非阻塞注意：client 传递依赖 rxjs/protobuf/uuid，并作为 server 生产依赖存在（CLI 需要），增加体积但非第二引擎。

## 6. 旧 guarantee 回归核对（无 blocker）

- **截断不伪造完成**：`route.ts` 对 close/abort 仍不发 RUN_FINISHED、不补实体 END；测试未改。
- **严格 LIFO**：`projection.closeEntities` 单一栈；取消/嵌套/多 step 测试保留并通过；重复 END 现在“实体不存在则不写”（`projection.ts:47/63/77`），是增强。
- **容忍规则**：官方 `EventSchema` 只用于出站已知事件；官方 `HttpAgent` 测试 unknown event 容忍；`isAguiEvent` 从“任意大写 type 为 true”改为“官方已知出站事件才 true”（测试 `unknown input is not a known outbound event`），这是 helper 语义收紧，不是端到端容忍回归（见 §7）。
- **鉴权/日志脱敏**：WP4 复用路径未改；测试仍断言 token 不入日志。
- **RUN_ERROR 无秘密**：固定 message、`mapError` 粗化；测试仍用路径/token 异常断言不泄漏。
- **旧 wire guarantee 变更（均为本次批准/文档化）**：`protocolVersion` 只在 RUN_STARTED（官方 schema 可选，README 已改）；`RUN_FINISHED.usage` 省略；`outcome` 字符串→对象；`MESSAGES_SNAPSHOT` 新增；`conversation.history` 多消息 entry ID 从重复 entryId 改为 `entryId:index`（修复唯一性，API 可观察，建议文档注明）。
- **测试放宽核查**：413 断言增强（40 次 declared + chunked，且断言无命令执行）；截断/LIFO/秘密/日志断言保留；usage 断言移除属批准契约变更，不是放宽；`isAguiEvent` 一条 true→false 是 helper 契约变化，容忍由官方 client 测试覆盖。

## 7. 非阻塞项

1. **OpenSpec 文档仍有旧口径**：`proposal.md` 仍写 non-goal “不实现 state+messages 快照（WP6）”，`design.md` 的 Non-Goals/§1.1 仍写 “不投影 MESSAGES_SNAPSHOT / RUN_FINISHED 带 usage”，`tasks.md` 4.2 仍写 “usage present”。虽然后部 “Approved correction” 已覆盖，但 archive 前应统一，避免契约自相矛盾。
2. **MESSAGES_SNAPSHOT/OBSERVATION 边界无测试**：建议补“超限不发快照、OBSERVATION_TIMEOUT/RESYNC 不取消执行/重试恢复”的回归。
3. **helper `isAguiEvent` 语义收紧**：现在只认官方已知出站事件；若未来用于入站容忍需改名/另实现。
4. **RUN_FINISHED.protocolVersion 省略**：官方 schema 可选；旧客户端若依赖需注意；README 已改。
5. **OBSERVATION_* 以 RUN_ERROR 表达**：官方客户端可能视为 run 失败；code/message 已自解释，建议在客户端/协议文档中明确“观察中断≠执行失败”。
6. **@ag-ui/client 作为 server 生产依赖**：仅 CLI 需要；传递依赖增加体积；可考虑隔离 CLI 包或 optional/依赖分层，但不违反协议决定。
7. **snapshot 无事务快照**：分页读 history 期间若有并发写入，快照可能混入新消息；单用户/前台设计下可接受，WP6 增量/重连时再处理。
8. **settle 超时 timer 未 clear**（unref，无泄漏级影响）；可清理。
9. **history 多消息 ID 变化**：对 REST 消费者可观察，建议在 api-v1/README 注明。

## 8. 证据/verification-status 诚实性（通过）

- `verification-status` 明确“此前自写 wire types、汇总 usage、字符串 outcome 不足以证明官方兼容，原证据保留不覆盖；本次没有新的独立评审，不把自动化通过外推为完整产品验收”；`priorFailedVerification`（326/327 fail 1）保留在证据；最终 `root-tests` 328/328 exit 0。本次审计即是缺失的独立评审。
- 证据含最终源码哈希、命令 exitCode、targeted/root/prototype/openspec/diff；unverified 列表包含真实 provider/工具、WP6 重连、代理/半开/长跑、独立评审、生产容器。属诚实记录。

## 9. 结论

**PASS（无 blocker）。** 官方 wire schema/encoder、outcome 对象、usage 省略、HttpAgent、MESSAGES_SNAPSHOT（有界、非第二事实）、OBSERVATION_* 语义、413 修复、边界收窄、LIFO/截断/秘密/日志旧保证均通过独立代码审阅与探针；328/328 与证据一致。§7 的 OpenSpec 旧口径、边界测试缺口、依赖/语义说明为**非阻塞**，建议在合入/归档前清理；不影响本次纠正的通过判定。
