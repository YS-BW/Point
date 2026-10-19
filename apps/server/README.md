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
