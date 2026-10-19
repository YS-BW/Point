# WP2 真实资源 Adapter 与 Durable 持久化

> 2026-10-19。WP2 contract/memory stub 已通过 G1。本片补真实可执行边界：Durable resource state、文件原子 adapter、HTTP/file notification adapter、loopback CDP browser adapter。
> 浏览器仍遵守冻结规则：只做受控 CDP 资源 adapter 与协议测试，不做 RTC/viewer/浏览器侧多会话或控制面功能，不默认连接 Steel。

## 1. Durable resource state

新增 `point.resource`（session family，key resourceId）、`point.resource-operation`（key operationId）、`point.resource-operation-request`（key resourceId:requestId）、`point.resource-command`（key resourceId:requestId）。Storage doc JSON 加 `present` 标记以区分 family seed 与已有文档；runtime `durableResourceStore(harness)` 实现 `ResourceStore.commit` 的全量 CAS 校验与单 commit。`openRuntime` 默认返回 `resources`，使用 Durable store；memory store 只保留测试入口。

Durable store 必须：

- 在 commit 内重读 resource/operation/receipt/index；expectedRevision/expectedState 失败全部不生效；guard 写不递增 revision；
- operation request index 保证 `(resourceId, requestId)` 幂等；receipt 与 resource/operation 同一 commit；
- reopen 后保留 lease/operation/unknown 状态；unknown 不自动重放；单写者仍由 owner.sqlite 保证。


## 2. 真实 Adapter 的安全前置契约（P0）

memory stub 与 Durable persistence **不等于**真实 adapter 可用。真实 adapter 必须先满足以下契约，代码/测试不满足时不得接入生产端口：

### 2.1 Operation 必须绑定 effect

`ResourceOperation` 必须持久化结构化 `effect: {kind, payload, payloadHash}`：

- `kind` 是已注册 capability 的判别值，不接受任意动态模块名；payload 是 canonical JSON，禁止凭据/无限对象，按 kind 限制大小；
- `payloadHash` 对 canonical JSON 计算，纳入 beginOperation fingerprint；同 operationId/requestId 不得换 payload/kind；
- `runOperation` 只接收已注册 kind 的 effect registry，不允许调用方传入另一份 payload/换执行效果；恢复/observe 必须引用同一 payloadHash；
- result/observation 也必须按 kind schema、大小上限、redaction 处理；大对象/截图写 Artifact 引用，禁止把任意 MB/凭据写进 Durable JSON。

### 2.2 Dispatch 必须校验 owner + lease + epoch

`controlEpoch` 比较不足以放行外部调用。dispatch 前必须在同一 resource CAS guard 下确认：

`resource.lease !== null && resource.lease.expiresAt > now && resource.lease.owner === operation.owner && resource.lease.epoch === operation.controlEpoch`。

已 release、已过期、owner 不同或 epoch 过期均 cancel 为 `failed(LEASE_EXPIRED|STALE_CONTROL)`，effect 0 调用。`expire` 是读时观察还是持久化事件必须明确；本片采用读时观察 + guard 拒绝，不伪造 revoke。

### 2.3 Attempt token 防止并发误核销

Operation 与 Delivery 都必须记录 `attemptToken/workerId`、`attemptStartedAt` 和可选 deadline：

- 第二个调用看到仍活跃的 attempting 必须返回 `IN_PROGRESS/RESOURCE_BUSY`，不能直接转 unknown；
- 只有 token 不匹配、TTL 已过或显式 recover/owner 观察证明前次 worker 已死，才允许 attempting→unknown；
- 原 worker settle 必须带 token CAS，旧 token 不得覆盖新状态。通知 task 同理，不能把正在 send 的 delivery 误核销 unknown。

### 2.4 Unknown 核销必须带 observer/evidence

`observeOperation`/delivery reconcile 必须携带 observer 身份、operation.controlEpoch、payloadHash 和结构化 evidence；服务端重新校验当前 lease/owner/epoch，并按 kind 验证 evidence schema/hash/大小/redaction 后才允许 `unknown→done|failed`。任意调用者不能用自由 JSON 伪造 done；旧 owner/takeover 后的 observer 必须拒绝。evidence 不能包含 token/凭据。

### 2.5 文件 Adapter 必须防 symlink/TOCTOU

词法 `resolve` containment 不足。真实文件 adapter 必须：root `realpath` 后固定；每次 mkdir 后 realpath 父目录并校验在 root 内；目标 `lstat` 拒绝 symlink；临时文件使用 `O_CREAT|O_EXCL|O_NOFOLLOW`、0600；写后 `fstat` 确认 regular file；rename 只覆盖已确认普通文件；fsync file + directory；read/list/observe 同样拒绝 symlink，读取后重算 hash 与 payloadHash；不删除/覆盖 root 外。Artifact writer 应复用同一硬化路径。

### 2.6 HTTP Notification 分类与凭据

HTTP adapter 的 outcome 表固定为：2xx→delivered；400/401/403/404/413/422→failed；408/425/429/5xx/DNS/TLS/timeout/网络异常→unknown；无法分类→unknown。端口应返回 `{outcome, code?, status?, detail?}`，detail 结构化且已 redacted；token 只放 header，不进 URL/日志/错误/response body；`redirect: 'error'|'manual'`，禁止跨源转发 Authorization，生产仅 HTTPS，超时 AbortSignal→unknown、不自动重试。Idempotency-Key 固定 deliveryId；没有 provider 查询/核销契约时 unknown 永久保留，不得宣称 exactly-once。

### 2.7 Effect 必须可取消且有 deadline

`ResourceEffectPort.invoke(operation, {signal, deadline})` 必须接收 abort/deadline；cancel/close 能停止 fetch/CDP/file worker；超时→unknown，不能在超时后把迟到结果伪造成 done。外部 adapter 不得无限阻塞。

### 2.8 真实 Adapter 放行条件

每种 capability 需有：payload schema/hash、owner/lease/epoch fence、attempt token、intent/settle/reconcile、abort/deadline、redacted evidence、unknown 查询/核销策略、single-process + multi-process CAS 测试、真实协议/文件权限测试。仅 memory stub 或 happy-path faux provider 不满足放行。

## 3. 文件 Resource Adapter

`adapters/resource/files.ts` 提供 `createFileResourceAdapter(rootDir, resources)`：write/read/list/observe；文件写入 tmp(0600)+fsync+rename+fsync 目录，路径 containment、大小、sha256 校验；write 通过 `resourceCommands.beginOperation/runOperation`，未知结果只 observe，不自动重放。文件 adapter 不写 Durable 事实以外的旁路队列；artifact writer 仍作为 Job 专用 adapter。

## 4. Notification Adapters

- `adapters/notification/http.ts`：使用 `fetch`，`Idempotency-Key=deliveryId`；2xx→delivered，明确 4xx→failed，5xx/timeout/network→unknown；URL/token 只从显式 options/环境读取，不打印凭据。
- `adapters/notification/file-outbox.ts`：每 delivery 一个 JSON 文件，tmp+fsync+rename；同 delivery 同 payload 幂等，异 payload 冲突；可重启观察已有 outbox 文件，不能把“文件存在”外推为远端已送达。
- 两者都实现既有 `NotificationPort`，可由 `openRuntime` options 注入；默认仍 fail-closed/memory only。

## 5. Browser Resource Adapter

`adapters/resource/cdp.ts`：loopback/configurable CDP WebSocket client，使用 Node 22 WebSocket；连接、Target.attach、Page.enable、Page.navigate、Runtime.evaluate、Page.captureScreenshot；所有操作携带 resourceId/owner/controlEpoch/operationId，通过 ResourceCommands fence。协议错误/连接断开→unknown；observe 只查询/核销，不重放。测试注入 fake transport 验证协议帧、epoch fencing、unknown；不连接真实 Steel，不接 RTC/viewer。

## 6. Composition

`openRuntime` 以 Durable resource store 为默认 `resources`；options 可注入 notification port、file root、browser adapter factories。未显式配置真实外部端点时不产生网络/浏览器动作。Adapters 可独立构造，便于离线测试。

## 7. 验收

- Durable resource reopen：lease/operation/receipt/index/unknown 状态保留；同键重放与 CAS race；`npm run check`。
- Files：原子写/权限/hash/path traversal/unknown observe/restart。
- HTTP notification：本地 HTTP server 测 2xx/4xx/5xx/timeout、Idempotency-Key、unknown 不重发。
- File outbox：幂等/冲突/reopen。
- CDP：fake transport 帧序列、navigate/evaluate/screenshot、stale epoch、disconnect unknown；明确真实 Steel 未验证。
- Root `npm test` + prototype quick regression；独立 reviewer；evidence/verification-status 同步。

## 8. 已知边界

真实 Durable resource state 新增 doc kinds，旧库不迁移；真实外部文件/HTTP/CDP 不是同一 DB 事务，unknown 只能观察；CDP 只做 loopback adapter，不接 RTC/viewer/Steel 发布镜像；长期连接泄漏、凭据轮换、并发容量、真实网络重试与 Docker 未验证。
