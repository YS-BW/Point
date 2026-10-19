# 上下文预算、显式 Profile 与受保护压缩（WP1b.2b）

> 2026-10-19。本文件是 WP1b.2b 的契约。目标：在正式 Server 上落地上下文 sections、显式个性化 Profile / USER.md 权威边界，以及受模型 dispatch 保护的压缩。
> 非目标：自动记忆抽取、向量检索、文件监听、真实 USER.md 双向写、工具（WP1b.3）、后台任务（WP1b.4）、HTTP。

## 1. 范围与文件

| 文件 | 内容 |
|---|---|
| `apps/server/src/domain/profile.ts` | Profile 值对象、严格输入、prompt 渲染、USER.md 导出纯函数、错误码 |
| `apps/server/src/storage/profile.ts` | `point.profile` 文档（format 1，entries map）与 `point.command.profile` 收据族 |
| `apps/server/src/application/profile.ts` | `ProfileStore` 端口、`ProfileCommands`（remember/forget/list/exportMarkdown） |
| `apps/server/src/runtime/profile.ts` | Durable `ProfileStore` 实现；收据与条目单 commit |
| `apps/server/src/runtime/context.ts` | `point.context` extension：identity/chat/profile sections、预算与截断 |
| `apps/server/src/runtime/model-guard.ts` | 增加 CompactionTask permit 与 `completeSimple` 保护 |
| `apps/server/src/runtime/conversation.ts` | 新增 `compact` 命令与状态；configure 安装 context extension |
| `apps/server/src/runtime/open.ts` | 组装 context/profile/guard；compaction settings；返回 `profile` 命令 |
| `apps/server/src/storage/conversation.ts` | 新增 `point.command.compact` 收据族 |
| `apps/server/test/context-budget.test.ts`、`profile.test.ts`、`compaction.test.ts` | 本片验收 |

不改 `api/**`、`bootstrap.ts`、`config.ts`；HTTP 仍只报告 foundation。

## 2. Profile 与 USER.md 权威边界

- **唯一权威**：`point.profile` Durable 文档。`USER.md` 只是可读导出，不由服务端写入、不监听外部文件；不得出现“文件与 documents 同时可写”的第二权威。
- 条目：`{key, value, kind: 'fact'|'preference'|'decision', sourceChatId, updatedAt}`。key `/^[A-Za-z0-9._:-]{1,128}$/`；value trim 后非空、≤ 4000 字符；最多 64 条（超出 `PROFILE_LIMIT_REACHED`）。更新已有 key 是显式覆盖，不创建重复条目。
- 显式性：只有 `remember` 命令写入；不从对话自动抽取。`forget` 删除条目不改写历史。
- `remember({requestId, key, value, kind, sourceChatId})`：同键同指纹返回首次条目；同键异指纹 `IDEMPOTENCY_CONFLICT`。收据与条目同一次 commit。
- `forget({requestId, key})`：同键幂等；返回 `{key, removed}`；条目不存在时 `removed=false`。收据与删除同一次 commit。
- `list()`：按 key 排序的只读快照。
- `exportMarkdown()`：纯函数输出可读 Markdown，不写文件：

```md
# USER.md

<!-- exported from point.profile; Durable documents are authoritative -->

- [preference] tone: 简洁 (source: chat 2)
```

## 3. 上下文 sections

`point.context` extension 依次渲染（SDK registry 的 section key 必须匹配 `^[a-z][a-z0-9_-]*$`，因此使用下划线）：

1. `point_identity`（`tag:false`）：稳定人格、边界、简洁中文、不得声称未验证成功。文本保持小规模。
2. `point_chat`：由 `input.conversationId` 读取 `point.chat`；用户会话写 `当前会话：<name>；chatId=<id>。`；找不到时写 `当前是内部执行会话。`。
3. `point_profile`：只渲染显式保存条目；空则返回 `undefined`（省略该 section）。

Profile 渲染预算 `MAX_PROFILE_PROMPT_CHARS = 8000`：

- 每条 value 最多 500 字符，超出加 `…`；
- 按 key 排序，逐条累加，超预算停止并追加 `[profile truncated: N entries omitted]`；
- 只作为参考数据，不获得系统指令权限（section 文本不得声称优先于用户当前要求）。

**预算测试**：注入超过 8000 字符的条目，断言请求中 section 总长受控、截断标记存在、最早条目优先保留；不得把整个 Profile 原样塞入。

## 4. 压缩命令（受保护）

`runtime.conversation.compact({chatId, requestId, instructions?})`：

- 严格输入；要求模型绑定（与 send 一致）且 chat 存在；
- 在**一个 commit** 内写 `point.command.compact` 收据与 `point.conversation.compact` command task（`background: true`，ownership conversation）；收据键为 `${chatId}:${requestId}`（与 send/stop 一致，requestId 作用于同一 chat），同键同指纹返回首次 commandId，异指纹 `IDEMPOTENCY_CONFLICT`；不同 chat 的同一 requestId 互不冲突；
- 压缩由 `point.conversation.compact` command task 受理：admission commit = 收据 + command task + provider identity + configure；command task 的 execute commit 再用公开 `CompactionTask` + `tx.createTask` 创建内层压缩任务（`input: {reason:'manual', instructions?}`，conversation-owned）。内层 task 是真实执行身份，command task 只保存其 taskId；命令完成只表示已受理。SDK 未导出 `createCompaction`，因此不登记 `pi.live.compactions` 展示状态（UI-only，后续需要再接入）；
- `compactStatus(commandId)`：accepted → 查内层 task，映射 `running|completed|failed`；`compactWait(commandId)` 等命令与内层 task，返回 `{status, entryId?}`；只读查询不触发执行。
- 压缩原始 entries 不由本实现删除或改写；`history` 仍可读取原记录；摘要 entry 属于 `pi.compaction`，不作为普通聊天消息投影。

## 5. 压缩模型调用保护

当前 `guardedModels` 只保护 `GenerationTask.beforeRequest`。本片必须把 `CompactionTask` 的模型调用纳入同一 intent-before-effect：

- `hook(CompactionTask, {beforeCompact})` 记录 permit：`{taskId, conversationId}`；permit 只在内存中。
- `Models.completeSimple` 包装层：通过 `ProviderDoc` 的 `sessionId` 与 `options.sessionId` 匹配到唯一 permit；找不到或匹配不唯一 → 返回固定失败消息 `MODEL_GUARD_REQUIRED`，不调用供应商。
- 匹配后按 `ModelCalls` 文档记录 `new → attempting → done|unknown|failed`（key = compaction taskId）；已有 non-new 状态 → `MODEL_RESULT_NOT_RECOVERABLE`，不重放。
- 崩溃恢复时 `summarize` 阶段没有 live permit → fail-closed，不允许无保护调用；压缩任务以失败/未完成呈现，原历史不变。
- 自动压缩 settings：`{enabled: true, reserveTokens: 4096, keepRecentTokens: 8192, backgroundTokens: 0}`；手动压缩不受 `enabled` 影响。真实模型压缩语义未验证，离线测试只用脚本供应商。

## 6. 完成判据

1. `npm run check` 通过；`npm test` 全绿且既有 84 项不回归。
2. 新增测试覆盖：显式 remember/forget/export、幂等与冲突、64 条上限、Profile 预算截断、chat section 隔离、USER.md 仅导出不写。
3. 压缩：手动 compact 后原历史仍可读、摘要 entry 可观察、后续请求包含摘要；压缩模型调用被 ModelCalls 记录；缺少 permit 时 fail-closed 且供应商 0 调用。
4. 独立 reviewer 通过；证据/验证状态/README 更新；未验证项明确（真实模型压缩质量、自动压缩长跑、USER.md 真实导入、HTTP）。

## 7. 非目标与已知限制

- 不实现 `USER.md` 文件监听或双向同步；导入留 WP15。
- 自动压缩会由 SDK 阈值触发，但本片只验证手动压缩与 settings 接线；长跑阈值行为需真实模型/长历史验收。
- 恢复后压缩失败属于保守行为，不自动重放；后续 WP 可增加压缩观察核销。**已知缺口**：进程在 compaction summarize 派发前后被杀、重启后没有 live permit 时，压缩任务会 failed，但 `point.model-call` 可能永久停留在 `attempting`（本轮没有 compaction 的恢复核销路径；generation 的 attempting→unknown 逻辑不覆盖压缩），因此三态证据不完整，必须先补核销再宣称完整。
- **同一会话并发手动压缩会被 fail-closed**：compaction permit 按 sessionId 唯一匹配，同一会话同时存在两个 permit 时 `completeSimple` 返回 `MODEL_GUARD_REQUIRED`、供应商 0 调用，两个压缩任务均失败。当前行为要求调用方串行重试，不应误判为 bug；后续可在命令层串行化压缩。
- `compact.instructions` 去空白后必须非空、≤4000 字符且不含 NUL；超过即 `INVALID_COMMAND`。
- 未验证/未入库：internal-execution 会话（无 `point.chat`）的 chat section fallback 只做过 render 探针、未进仓库测试；generation-owned 自动/阻塞压缩路径未测；供应商返回 error 与取消派发路径未进仓库测试；没有 compaction 的进程级 SIGKILL fixture。这些不能由手动压缩 happy path 外推为完整。
