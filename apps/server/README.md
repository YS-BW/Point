# Point Server foundation

WP1a：独立可运行的基础骨架。WP1b.1 新增内部对话创建/读取端口，WP1b.2a 提供显式模型绑定下的消息/排队/停止/历史应用接口，WP1b.2b 提供显式 Profile、context sections 与受保护的手动压缩；WP2 已落地 Durable 资源租约、控制权 epoch、副作用三态与安全的文件/通知/CDP adapter 契约。真实外部端点仍须由组合根显式注入；Steel/RTC/provider/迁移/长跑未验证。健康接口只报告 foundation。

在仓库根目录，Node >=22.19：

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm start
```

构建会先清理 `dist/`；类型错误不会生成可运行 JS，避免旧模块或失败构建被继续使用。

默认 `127.0.0.1:4310`；`GET /health/live` 与 `/health/ready`。可配置 `POINT_HOST`（只允许 loopback）、`POINT_PORT`、`POINT_DATA_DIR`（默认 `runtime/server`）。远程入口与令牌留给 WP4；此处不读取凭据。

数据目录：`state.sqlite` 是 Durable 唯一事实库；`owner.sqlite` 仅持有进程锁。不要删除活跃锁文件，也不要让不同进程使用不同路径替换同一个目录。仅支持本地支持 SQLite 锁的文件系统，不支持网络共享卷。

首次启动在同一事务写 root 与 `point.server.meta`。重启复用 identity；无 metadata 的已使用数据和不兼容版本会拒绝启动。请使用全新目录，**不要指向原型数据**。本次不做数据迁移；升级/迁移先备份，版本与恢复流程见设计。写模式打开前只读检查 Durable schema；未知库或需升级的 schema 会被拒绝，不触发自动迁移。这个检查与锁定的 Durable 版本绑定，升级必须独立实施。

SIGINT/SIGTERM 关闭 HTTP、Durable 与锁。运行时意外关闭也会关闭 HTTP 并释放锁；启动中关闭不能报告 ready，关闭失败通过 Server 的 closed 结果报告，CLI 以非零状态退出。日志只包含允许的生命周期事件，不输出原始异常或配置。失败的详细诊断与运行治理在 WP8 完善。

测试使用临时目录与真实 Durable，不依赖验证工程测试钩子。WP1b 按契约工程化重建，G1 未通过。模块与未来行为见 `docs/design/server-architecture.md`。

内部应用端口（构建后从仓库根目录运行；请使用全新临时目录）：

```js
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openRuntime} from './apps/server/dist/src/runtime/open.js';
const runtime = await openRuntime(await mkdtemp(join(tmpdir(), 'point-example-')));
try {
  const chat = await runtime.chats.create({requestId: 'example:1', name: '项目计划'});
  console.log(await runtime.chats.get(chat.id));
} finally {
  await runtime.close();
}
```

同键同内容返回首次结果，同键异参抛出 `CommandError`（code 为 `IDEMPOTENCY_CONFLICT`）。此端口不调用模型，HTTP 尚不暴露该能力。测试可单独运行：`npm run build && node --test apps/server/dist/test/chats.test.js`。设计及兼容边界见 [核心重建计划](../../docs/design/agent-core-rebuild.md)。

对话执行复用原生 pi-ai Models 与 Durable loop：向 `openRuntime` 传入 `{models, model: {provider, modelId}}`，再使用 `runtime.conversation.send/stop/status/wait/history`。`send` 返回命令身份，不表示已经回答；`status` 为只读查询。未传模型绑定可以读已有历史，但不能发送或停止。HTTP 仍未发布这些命令。产品场景、SDK 复用依据和未知调用恢复边界见 [对话体验](../../docs/design/conversation-experience.md)。

独立场景验收：`npm run build && node --test apps/server/dist/test/conversation-experience.test.js`，使用脚本供应商与真实 Durable；不调用外网或使用个人凭据。

## 资源边界（WP2）

资源在 Agent 层统一为 `resource{id, owner, lease, controlEpoch, state}`；外部动作走 `intent → attempting → done | unknown | failed`。`unknown` 只能观察核销，不能自动重放。实现分三层：

- `domain/resource.ts`：纯状态转移与 epoch fence（无 IO/SDK）；
- `application/resource.ts`：严格输入、幂等收据、`ResourceStore` 原子 commit、`ResourceEffectPort`；前置条件与写入共享同一个 resource CAS guard；
- `adapters/resource/memory.ts`：**仅测试/样板**，不持久化、无崩溃恢复。

```js
import { resourceCommands } from './apps/server/dist/src/application/resource.js';
import { memoryResourceStore } from './apps/server/dist/src/adapters/resource/memory.js';
const commands = resourceCommands(memoryResourceStore(), Date.now);
const resource = await commands.acquire({resourceId: 'browser:primary', requestId: 'r1', owner: 'me', ttlMs: 60000});
const operation = await commands.beginOperation({
  operationId: 'op1', requestId: 'r2', resourceId: resource.id, controlEpoch: resource.controlEpoch,
});
const outcome = await commands.runOperation(operation.id, {invoke: async () => 'done-result'});
```

`unknown` 用 `observeOperation({operationId, status, result, observation})` 核销。真实资源 adapter 通过显式 effects registry 接入 Durable store；文件、HTTP/outbox 与 loopback CDP 均 fail-closed、unknown 不重放，CDP 不接 Steel/RTC/viewer。真实端点、旧库迁移、长跑与 provider 查询核销未验证。契约与未验证项见 [资源边界](../../docs/design/resource-boundary.md) 与 [真实 Adapter](../../docs/design/resource-adapters.md)。

## 上下文、Profile 与压缩（WP1b.2b）

`openRuntime` 返回 `profile` 端口；`point.profile` Durable 文档是显式个性化唯一权威，`exportMarkdown()` 只读导出 USER.md，不写文件、不监听外部文件：

```js
await runtime.profile.remember({requestId: 'm1', key: 'tone', value: '简洁', kind: 'preference', sourceChatId: chat.id});
console.log(await runtime.profile.list());
console.log(await runtime.profile.exportMarkdown());
```

模型请求前由 `point.context` 注入 identity/chat/profile sections：profile 总预算 8000 字符、单值 500 字符截断，空 profile 省略。手动压缩：

```js
const accepted = await runtime.conversation.compact({chatId: chat.id, requestId: 'c1'});
const outcome = await runtime.conversation.compactWait(accepted.commandId); // {status, entryId?, taskId?}
```

压缩只改变活动上下文，不删除原始历史；压缩模型调用与生成调用共用 intent-before-effect 保护，缺少 permit 时 fail-closed。手动压缩需显式模型绑定；自动阈值压缩与真实模型质量未验证。同会话并发手动压缩会 fail-closed，需串行重试。契约与未验证项见 [上下文预算](../../docs/design/context-budget.md)。

## Job/Attempt、工具与产物（WP1b.3）

`openRuntime` 返回 `jobs` 端口；Job 是用户看到的工作，Attempt 是一次执行尝试（start/amend/cancel/get/attempts/artifact）：

```js
const started = await runtime.jobs.start({requestId: 'j1', title: '写方案', prompt: '给我一份方案', sourceChatId: chat.id});
const job = await runtime.jobs.get(started.jobId);
const attempts = await runtime.jobs.attempts(started.jobId);
```

execution conversation 内模型可调用 `save_artifact({name, content})`：写入 `<dataDir>/workspace/jobs/<jobId>/<attemptId>/<sanitized artifactId>/<name>`，tmp + fsync + rename，记录 sha256/bytes；只有 sealed 且 `jobs.artifact(id)` 验证通过的产物才能让 Job ready。文件与 Durable 文档不是同一事务：`verify` 只能在读取时发现篡改/缺失/半成品，不能保证 ready 后文件持续完整。amend 会创建新 attempt，旧 attempt 结果只审计、不覆盖新 revision；cancel 传播到 attempt task，但不撤销已发生的外部写。真实外部工具与 HTTP 尚未实现。契约与未验证项见 [Job/Attempt 与产物](../../docs/design/jobs-and-artifacts.md)。

## 计划、投递与通知（WP1b.4）

`finalize` 前 `runtime.followups` 可为 ready Job 建单次提醒计划（绝对 UTC 时刻、可选 advanceAt，最多 2 轮），到期由 `point.job.followup` 判断并投递：

```js
const plan = await runtime.followups.schedule({requestId: 'f1', jobId: started.jobId, expectedRevision: 1, dueAt: Date.now() + 60_000});
const schedule = await runtime.followups.get(plan.scheduleId);
const deliveries = await runtime.followups.deliveries(started.jobId);
```

只有 `Job.status === 'ready'` 可计划；同一 `(jobId, revision)` 只能有一个 schedule（cancelled 可替换），重排需 amend 或先 cancel。判断记录 `point.decision`；会话投递在 source chat 追加一条 `point.report` assistant entry（不调用模型），外部通知经可注入 `NotificationPort`（本片仅有测试用 `memoryNotificationAdapter`，target 固定 `test`）。通知先记 intent 再调用，failed/unknown 不自动重放，且不改变 Job/chat。错过合并为一次判断/一次投递；取消不撤回已创建 delivery；报告不重新核对 artifact hash（以 `jobs.artifact()` verify 为准）。契约见 [计划与投递](../../docs/design/plan-and-delivery.md)。

## HTTP API v1 契约（WP4）

`/v1` 是既有 application commands 的薄传输层：不复制业务规则、不新增事实，成功响应就是命令返回的 JSON（对象/数组/文本字段），失败统一为错误信封。除 `/health/*` 与门控 `/inspect` 外一律要求 Bearer。

### 环境变量与鉴权

| 变量 | 语义 |
|---|---|
| `POINT_API_TOKEN` | `/v1` 的 Bearer token（1..512 字符，不允许空白/控制字符）。**未配置时 `/v1` 全部 503 `API_NOT_CONFIGURED`（fail-closed）**；`/health/*` 始终开放。 |
| `POINT_API_INSPECT` | `1` 时启用只读 `GET /inspect`；缺省/`0` 时返回 404（不暴露存在性），且需要与 `/v1` 相同的 Bearer。 |

鉴权比较使用常量时间；缺失/错误 Bearer 返回 401 `UNAUTHORIZED`，不执行任何命令。未知路径先判定 404、方法不符先判定 405，再进入鉴权。

### 错误信封与状态码映射

```json
{"error":{"code":"INVALID_COMMAND","message":"invalid command","requestId":"..."}}
```

| HTTP | code（稳定，客户端不解析文案） |
|---|---|
| 400 | `INVALID_COMMAND`、`INVALID_TRANSITION`、`INVALID_EVIDENCE`、`PAYLOAD_REJECTED`、`RESULT_REJECTED`、`EFFECT_NOT_REGISTERED` |
| 401 | `UNAUTHORIZED` |
| 404 | `NOT_FOUND`、`CHAT_NOT_FOUND`、`JOB_NOT_FOUND`、`COMMAND_NOT_FOUND`、`SCHEDULE_NOT_FOUND`、`DELIVERY_NOT_FOUND`、`OPERATION_NOT_FOUND`、`ARTIFACT_NOT_FOUND` 等 `*_NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED`（带 `Allow` 头） |
| 409 | `IDEMPOTENCY_CONFLICT`、`RESOURCE_CONFLICT`、`RESOURCE_BUSY`、`STALE_CONTROL`、`LEASE_EXPIRED`、`STALE_ATTEMPT`、`IN_PROGRESS`、`RECOVERY_REQUIRED`、`ARTIFACT_CONFLICT`、`REVISION_MISMATCH`、`JOB_TERMINAL` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 503 | `API_NOT_CONFIGURED`、`RUNTIME_NOT_READY`、`MODEL_NOT_CONFIGURED`、`NOTIFICATION_NOT_CONFIGURED`、`DATA_DIR_BUSY` |
| 500 | `INTERNAL_ERROR`（固定 message，不含栈/路径/凭据；未知异常一律归入） |

### 幂等与请求约束

- 所有写端点必须带 `Idempotency-Key`（`^[A-Za-z0-9._:-]{8,128}$`，与冻结契约的 ≥8 字符一致；短于 8 字符返回 400 `INVALID_COMMAND`），HTTP 层把它映射为命令的 `requestId`；body 中出现 `requestId` 或路径参数同名键会被 400 拒绝（路由是唯一来源）。
- 同 key 同 payload 的重放返回**逐字节相同**的成功响应：靠既有 Durable 收据，不缓存 HTTP 响应（不产生第二份事实）；同 key 异 payload → 409 `IDEMPOTENCY_CONFLICT`。
- 请求体必须 `Content-Type: application/json`，严格 JSON object；上限 1 MiB，超过在读取时立即 413（不先全量缓冲）。空 body 的写端点按 `{}` 处理。
- 每个响应带 `X-Request-Id`（可由请求头提供，非法则生成 UUID），错误信封内同样携带。
- 访问日志每请求一行 JSON：`at/event/requestId/method/path/status/durationMs/bytesIn`；**绝不记录 Authorization、body 或查询串**。

### 路由表

| 方法 | 路径 | 命令 |
|---|---|---|
| POST | `/v1/chats` | `chats.create` |
| GET | `/v1/chats/:chatId` | `chats.get` |
| POST | `/v1/chats/:chatId/messages` | `conversation.send` |
| POST | `/v1/chats/:chatId/stop` | `conversation.stop` |
| POST | `/v1/chats/:chatId/compact` | `conversation.compact` |
| GET | `/v1/chats/:chatId/history?limit=&cursor=` | `conversation.history` |
| GET | `/v1/commands/:commandId` | `conversation.status` |
| POST | `/v1/profile/remember` | `profile.remember` |
| POST | `/v1/profile/forget` | `profile.forget` |
| GET | `/v1/profile` | `profile.list` |
| GET | `/v1/profile/export` | `profile.exportMarkdown`（`{markdown}`） |
| POST | `/v1/jobs` | `jobs.start` |
| GET | `/v1/jobs/:jobId` | `jobs.get` |
| POST | `/v1/jobs/:jobId/amend` | `jobs.amend` |
| POST | `/v1/jobs/:jobId/cancel` | `jobs.cancel` |
| GET | `/v1/jobs/:jobId/attempts` | `jobs.attempts` |
| GET | `/v1/artifacts/:artifactId` | `jobs.artifact`（artifactId 需 URL 编码） |
| POST | `/v1/followups` | `followups.schedule` |
| POST | `/v1/followups/:scheduleId/cancel` | `followups.cancel` |
| GET | `/v1/followups/:scheduleId` | `followups.get` |
| GET | `/v1/followups/:scheduleId/occurrences` | `followups.occurrences` |
| GET | `/v1/followups/decisions?jobId=` | `followups.decisions` |
| GET | `/v1/followups/deliveries?jobId=` | `followups.deliveries` |
| GET | `/v1/deliveries/:deliveryId` | `deliveries.get` |
| GET | `/inspect` | 门控诊断：`{version, instanceId, phase, capabilities}` |

### 契约形状注意（WP4 审计非阻塞项，如实记录）

- `/health/*` 的成功响应保持旧形状（`{phase, capabilities}`）；但 **404/405 等错误也走统一 JSON 信封**（`{error:{code,message,requestId}}`），相对旧实现的裸 `{code}` 是形状变化。
- **404/405 先于鉴权**是刻意顺序：未知路径/方法在未配置或未认证的 server 上也返回 404/405，不暴露 `/v1` 是否存在；已知路由再进入鉴权（未配置 → 503，错误 Bearer → 401）。这一顺序由契约测试固定。
- `/inspect` 返回 `{version, instanceId, phase, capabilities}`；**Durable 计数不在本片返回，留待 WP6 读模型**。默认 404，需 `POINT_API_INSPECT=1` 且通过 Bearer。
- Node `clientError`（HTTP 层解析失败等 socket 级错误）由 Node 默认响应，可能**没有统一 JSON 信封**；应用可处理的 HTTP 请求才保证信封。该边界为已知限制，不作为 `/v1` 契约的一部分。

### 边界与未验证项

成功响应不做外层包装、无分页游标之外的读模型；`/inspect` 只报 server 身份/阶段，**Durable 计数依赖尚未实现的读模型（WP6）**。不实现 AG-UI/SSE（WP5）、多租户/OAuth/限流、批量或删除类端点。`/v1` 与真实模型/外部端点组合的端到端行为取决于 `openRuntime` 绑定与注入的 adapters；HTTP 层本身不使用模型。未验证：跨进程并发压测、真实客户端重连（属 WP5/WP6）、HTTPS 终止与反向代理、限流与审计留存。

## 状态 v2 与迁移（WP3）

`point.meta` 是唯一产品格式权威：`format: 2` 正常读写；legacy `point.server.meta` (`format: 1`) 在写模式下拒绝（`MIGRATION_REQUIRED`），只允许显式迁移或 `openRuntime(dir, binding?, {mode: 'read-only'})` 只读核对（读写 store 的 `commit`/`resume` 抛 `READ_ONLY`；仍必须取得 owner 锁，SQLite/WAL 层不构成 OS 级只读）。未知/更高 format、engine 不匹配、半迁移双 meta 均零写入拒绝（`UNSUPPORTED_DATA_FORMAT`/`UNRECOGNIZED_DATA`）；全新库直接创建为 format 2。

v2 保留既有按实体文档族为唯一事实，新增派生读侧 family：`point.chats`/`point.jobs`/`point.resources`/`point.requests` 索引、`point.memory`（替代单文档 `point.profile`，收据保留）、`point.event` 时间线；`point.chat`/`point.job` 升 v2（identity migrate，形状与 domain 类型不变）。实体 + 索引 + 事件在同一 commit 写入；索引/事件是可重建的派生事实，删除事件不影响状态，`runtime.rebuildEvents()` 可从当前状态重建（当前覆盖 chat/job/memory/resource/artifact/schedule；attempt/delivery/operation 的完整时间线属已知限制）。

迁移是显式命令（不通过 HTTP）：

```js
import { migrateRuntime } from './apps/server/src/runtime/migrate.js';
const result = await migrateRuntime(dataDir); // {status:'migrated'|'already-migrated'|'initialized', backupPath?, counts?}
```

流程：owner 单写者锁 → SDK storage preflight → 格式检测 → 在线备份 `<dataDir>/backups/pre-migration-<ts>.sqlite`（Node `node:sqlite` 的 SQLite backup API，不复制 WAL；失败 `MIGRATION_BACKUP_FAILED` 且格式不变）→ **一个 Durable commit** 完成全部重写、索引/memory 回填、`point.requests` 回填与一条 `state.migrated` 事件。已是 format 2 时返回 `already-migrated`（不备份、不重写）；提交前 SIGKILL 可重跑，提交后 SIGKILL 重启即 format 2。回滚：停写后用备份覆盖 `state.sqlite`（移除 `-wal`/`-shm`），先只读核对，需要时再迁移；恢复后不重放任何 `unknown`。

请求账本清扫：

```js
const report = await runtime.cleanupReceipts({keepMs: 30 * 24 * 60 * 60 * 1000, keepCount: 10_000, dryRun: true});
// {scanned, removed, kept, dryRun, reasons, removedKeys}
```

默认 30 天 / 10k 条、单次最多 1000 条；最近 `keepCount` 条与未过 `keepMs` 的收据保留。保护规则：active job、active schedule、`attempting`/未核销 `unknown` operation、无法解析引用（fail-closed）永不删除；保护判定在删除 commit 内对已提交状态重新校验。只读 runtime 调用清扫抛 `READ_ONLY`。事件/索引均为派生数据；备份保留策略、大库迁移耗时、原型 HTTP/真实读模型不在本片。设计见 [状态 v2](../../docs/design/state-v2.md)，证据数字由 Lead 统一维护。

## AG-UI 投影：`POST /v1/agent`（WP5）

一次前台 run 一条 `text/event-stream`。端点复用 `/v1` 的 Bearer、fail-closed 503、1 MiB 请求体上限与访问日志；成功流以 `RUN_STARTED` 开始、以 `RUN_FINISHED` 结束（`outcome` + `usage`），失败以 `RUN_ERROR` 结束。内部事实仍在 Durable，AG-UI 只是投影（见 [协议评估](../../docs/design/protocol-agui.md)）。

### 输入（AG-UI `RunAgentInput` 子集）

```json
{"threadId":"9","runId":"client-supplied-ignored","messages":[{"id":"m1","role":"user","content":"你好"}]}
```

- 必须带 `Idempotency-Key`（8..128 字符）→ 映射为既有 `conversation.send` 的 `requestId`；`Content-Type: application/json`，body ≤1 MiB。
- `threadId` 必须是已存在的数字 chat id（一个 chat = 一个 thread）。`runId` 由**服务端生成**（客户端值忽略，`RUN_STARTED/RUN_FINISHED` 返回服务端 runId）。
- 取最后一条 `role:"user"` 的文本内容（string 或 text parts）；`tools`/`context`/`state`/`forwardedProps` 及其他未知字段被**容忍但忽略**（不改变服务端权威状态）。
- 已知字段类型/取值错误（缺 threadId、messages 非数组、content 非文本、runId 非 string 等）→ 仍以 SSE 返回 `RUN_ERROR`（`code: INVALID_COMMAND`），不启动 run。

### SSE 帧与生命周期

- 每个块恰好一条 `data: <一个 JSON 事件>\n\n`；不使用 `event:` 语义、不使用多事件帧（消费端可忽略 `id:`，本片不发送）。
- 首帧必须是 `RUN_STARTED` 或 `RUN_ERROR`；正常结束必须是 `RUN_FINISHED`（`outcome: success|cancelled`、`usage`）；流内失败以 `RUN_ERROR`（固定 message，不泄漏栈/路径/凭据）结束。
- **截断不伪造完成**：客户端断开或服务端关闭导致的中断流**不发** `RUN_FINISHED`，客户端据此区分"完成"与"断了"。
- **取消**：既有 `POST /v1/chats/:id/stop` 仍有效；run 被停止时先关闭已开实体（`TEXT_MESSAGE_END`/`STEP_FINISHED`/`TOOL_CALL_END`），再以 `RUN_FINISHED` `outcome:"cancelled"` 结束，不会静默断流。
- `protocolVersion`：`"1.0"`（随 `RUN_STARTED`/`RUN_FINISHED` 提供）。

### 真实投影的事件族（按 SDK 公开能力裁剪）

| 事件 | 来源 |
|---|---|
| `RUN_STARTED` / `RUN_FINISHED` | `conversation.send` 受理 + `run_start`/`run_end` + submission 结算 |
| `TEXT_MESSAGE_START/CONTENT/END` | `message_start` + 真实 `text_delta`（providers 不支持逐 token 时 SDK 可能给整段变更；投影仍按序发出，不伪造分片） |
| `TOOL_CALL_START/ARGS/END/RESULT` | `tool_execution_start/end`；`ARGS` 为一次完整 canonical JSON（SDK 无原始 JSON 分片，不伪造 token 流）；结果有界（8 KiB） |
| `STEP_STARTED/FINISHED` | `turn_start`/`turn_end`（stepName=`turn-N`，真实回合边界） |
| `RUN_ERROR` | 受理/校验/MODEL_NOT_CONFIGURED/CHAT_NOT_FOUND/运行失败（固定 message+稳定 code） |

**不投影（能力不足或范围外，宁可不发）**：`REASONING_*`、`TOOL_CALL_ARGS` 逐 token 分片、`STATE_*`/`MESSAGES_SNAPSHOT`/`ACTIVITY_*`/`SUBAGENT_*`/`RAW`、`Last-Event-ID` 重放、interrupt/resume、后台任务进度（均属 WP6/WP7）。

### usage 口径（派生，不是 provider 账单）

`RUN_FINISHED.usage = {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}`，由 run 开始与结束时的**会话 `UsageState` 账本差分**按 model/tool bucket 汇总得到。它是真实 Durable 记录上的派生口径：**按 bucket 聚合、不保证 provider 精确账单**（不拆分单次调用、不含 cost/货币、retry/compaction 的归属可能与 provider 账单不同）；未验证项。

### `point.ui.*` CUSTOM 契约（仅占位，不渲染）

- 唯一扩展通道 `CUSTOM`，name 固定 `point.ui.component`；**本片不生成任何 UI 事件**，只冻结校验契约供后续片使用。
- value 形状：`{component, props?, artifactId?}`；组件名须为已登记白名单（WP5 仅占位 `point.placeholder`，客户端需预先注册组件语义）。
- 有界：props 序列化 ≤2048 字节、深度 ≤4、key/数组 ≤32、字符串 ≤512 字符、必须 JSON-safe；**禁止** `<>`、`javascript:`、`data:` 等可在客户端执行的 HTML/JS/DOM 内容；`artifactId` 只允许受限标识符。
- 服务端不解释渲染语义、不写 Durable UI 状态；任何声称"生成 UI 代码/HTML"的行为都不属于本契约。

### 参考 CLI（协议第一个消费者）

```sh
POINT_API_TOKEN=... npm run cli -w @point/server -- --message "你好"
node apps/server/dist/src/cli.js --url http://127.0.0.1:4310 --token ... --chat 9 --message "继续"
```

打印 run/step/tool 摘要与文本增量、`[done] outcome=... totalTokens=...`；`RUN_ERROR` 以非零退出码结束。它是参考消费者，**不替换**原型 CLI。

### 未验证 / 边界

真实 provider 的逐 token 流、tool call 的 provider 参数分片、真实网络断线/重连、多客户端并发 run 隔离（本片按"一次前台 run"设计）、`Last-Event-ID`/快照恢复、interrupt/resume、usage 与 provider 账单对账均未验证。SSE 反向代理/缓冲行为与背压仅在本地 Node 环境验证。
