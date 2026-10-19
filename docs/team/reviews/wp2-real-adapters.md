# WP2 真实资源 Adapter 与 Durable 持久化独立评审（code-auditor）

> 2026-10-19。评审对象：分支 `wp/2-real-adapters` 工作树（基线 `0b0eb7f` "persist resources in Durable and define adapter safety"）上的 WP2 真实 adapter/安全契约改动。
> 评审人：code-auditor（独立于实现作者）；作者：resource-impl / browser-impl / delivery/notification-impl / senior-tester；契约 owner 与裁决：lead。
> 依据：[resource-adapters 契约](../../design/resource-adapters.md) §2 P0、OpenSpec `agent-resource-adapter-safety`、[agent-core 十条不变量](../../design/agent-core.md)、[评审检查清单](../review-checklist.md)。
> 结论先行：**需修改（6 个 blocker）**。现有 targeted/full 测试全绿，但 P0 安全契约存在可复现缺口；不能以“测试绿”放行真实 adapter。仅写本文件，未改源码/测试。

## 1. 结论

**需修改（不可合并；存在 6 个未解决 blocker）。**

- B1：安全模式下 `runOperation` 使用**调用方传入的 effect registry**，可替换同一 kind 的执行实现（P0-1 未闭合）。
- B2：unknown 核销的 evidence 只校验 schema/size，**未与 operation payload 绑定**；schema 合法的伪造 sha 可把 unknown 核销为 done（P0-4 未闭合，observer 也只是字符串比较）。
- B3：**Delivery 未实现 attemptToken/workerId/attemptStartedAt/deadline**；并发 NotifyTask 会在 send 进行中把 delivery 误核销 unknown（P0-3 只覆盖了 Operation，契约明确要求 Delivery 同理）。
- B4：file-outbox 返回 `delivered`，实际只写了本地文件；经 delivery runtime 变成 Delivery.done，与契约 §4“不能把文件存在外推为远端已送达”冲突。
- B5：契约 §2.5 要求 “Artifact writer 应复用同一硬化路径”，`runtime/artifacts.ts` 未改，仍是词法 containment + 自写 tmp/rename，无 realpath/lstat/O_NOFOLLOW/读回校验。
- B6：CDP `screenshot`/`evaluate` 的原始结果（base64、页面值，可能含凭据）被直接持久化为 `operation.result`；违反 P0-1“大对象/截图写 Artifact 引用、result 按 kind schema+redaction”。

其余 P0-2/P0-6(HTTP)/P0-7/P0-8 主体实现正确；另有非阻塞问题见 §4。测试真实性总体好，但**恰好没有覆盖上述六类行为**（§6 给出应补回归）。

## 2. 验证与范围

- 新增/修改：`domain/resource.ts`、`application/resource.ts`、`storage/resource.ts`、`runtime/resources.ts`、`adapters/resource/{files,cdp}.ts`、`adapters/notification/{http,file-outbox}.ts`、`application/delivery.ts`、`runtime/deliveries.ts`、`runtime/open.ts`；测试 `resource-secure.test.ts`、`resource-durable.test.ts`、`resource-files.test.ts`、`notification-http.test.ts`、`notification-outbox.test.ts`、`resource-cdp.test.ts`、`resource-adapter-integration.test.ts`、`fixtures/resource-crash.ts`。
- 我以隔离 outDir 编译并只读运行，不写 `apps/server/dist`：

| 命令 | 结果 |
|---|---|
| `node --test .../resource-adapter-integration.test.js`（task-29 adversarial suite） | **11/11 pass** |
| `node --test resource-secure resource-durable resource-files notification-http notification-outbox resource-cdp` | **62/62 pass** |
| 服务端全量（隔离构建） | **225 项中 224 pass**；唯一 fail 是 `/tmp` 构建布局下 `resource.test.ts` 按相对 URL 读源码的已知路径断言（官方 dist 布局下通过；tester/lead 官方窗口 **225/225**） |
| `scripts/*.test.mjs` | 10/10 pass |
| `npx tsc -p apps/server/tsconfig.json --noEmit` / `node scripts/check-boundaries.mjs` | exit 0 / passed |
| 官方窗口（tester/lead 报告） | targeted 11/11；server 225/225；tsc exit 0 |

- 独立探针（/tmp，未入库）：registry 替换、伪造 evidence、并发 NotifyTask、outbox→Delivery、CDP 大结果/秘密持久化；结果见 §7。
- Scope：只改本 WP 列出的文件；未改 `api/**`、`bootstrap.ts`、`config.ts`；domain/application 无平台/SDK 导入；无凭据写入仓库/日志/文档。

## 3. Blocker（必须有 owner 决策或修复）

### B1（P0-1）runOperation 使用调用方 registry，可替换同一 kind 的执行实现

- 代码：`application/resource.ts:555` 在构造时绑定 `registry = options.effects`（beginOperation/observe 用它校验）；但安全 `runOperation` 只做 duck-typing（`:536-538`），把**参数传入的 registry** 交给 `runSecureOperation`（`:789-792`），dispatch 在该 registry 上 `effects.resolve(...)`（`:570`）并 invoke。`openRuntime` 注入的 `options.effects` 不参与 dispatch。
- 探针：正常 `openRuntime`（注入真实 file effect）→ begin file.write → 调用 `runOperation(opId, registryOf([fakeEffect]))`（fake 同 kind、同 definition、invoke 不写文件而直接返回成功）→ **fake invoked，operation done，配置的 file effect 一个文件都没写**。
- 影响：违反契约 §2.1“runOperation 只接收已注册 kind 的 effect registry，不允许调用方……换执行效果”、OpenSpec design decision #1“runtime-owned registry”；内部误用或后续 API 透传即可绕过 payload/result schema 的实际执行者。
- 修复任务 R1：secure `ResourceCommands.runOperation` 改为只接受 `operationId`（或强制 registry === 构造时注入的同一对象），registry 在 `resourceCommands` 内绑定；更新适配器/测试调用；补“同 kind 不同 registry 被拒绝且零副作用”的回归（integration P0-1 扩展）；README 同步。

### B2（P0-4）evidence 未绑定 payload；schema 合法的伪造 evidence 可核销 done

- 代码：`application/resource.ts:531-534` 只按 definition 校验 schema/大小；`:889` 只比较调用方给的 `payloadHash` 与 operation 内值；`domain/resource.ts:443` 同样只比较该字符串。file 的 `validateEvidence`（`files.ts:246-259`）只检查 `{kind:'file',path,exists,regular,sha256,bytes}` schema，**不要求 sha/bytes/path 与 operation.effect.payload 一致**。observer 认证仅是 `command.observer === operation.owner`（`:884`），owner 可从 operation 读出。
- 探针：file.write 在 rename 后崩溃 → operation `unknown`（文件内容 `content`，payload sha=sha256('content')）；用伪造 evidence（同 schema，sha=sha256('totally different content')，bytes=7）+ 正确 payloadHash/observer/epoch 调 **公开 `resources.observeOperation`** → **accepted，state=done，result.sha256=伪造值**。
- 影响：违反契约 §2.4/OpenSpec secure spec“validate evidence schema/hash… matching file hash/bytes evidence for the operation payload”“authenticate an observer”。file adapter 自身的 `reconcile` 使用真实 observation（正常路径安全），但公开命令/未来 HTTP API 可伪造；这正是 tester 主动上报的残留风险。
- 修复任务 R2：
  1. 扩展 `EffectDefinition`，把 evidence 与 payload 的绑定做成 capability 级校验（如 `validateEvidence(evidence, payload)`）：file 必须 `path/sha256/bytes` 等于 payload 对应值；CDP 的 evidence 必须绑定 payload/observation hash；result 不得由调用方自由伪造（应由 evidence/adapter observation 派生或与 evidence 再用 kind schema 交叉校验）。
  2. observer 不能只是 owner 字符串：增加 adapter/owner 的 observer 凭据或在 application 层限制 observe 只能由 adapter 端口调用（当前 `resources` 对内部公开）。
  3. 回归：schema 合法但 sha/bytes/path 不匹配 payload → `INVALID_EVIDENCE`；伪造 result 被拒；takeover 后旧 owner 被拒（已有）。
- 注意：此项为 blocker（不是“加固建议”），因为它直接破坏 unknown 只能由真实观察核销的硬规则。

### B3（P0-3）Delivery 没有 attempt token，并发通知被误核销 unknown

- 契约：`resource-adapters.md:40-44` 明确“Operation **与 Delivery** 都必须记录 `attemptToken/workerId`、`attemptStartedAt` 和可选 deadline；第二个调用看到仍活跃的 attempting 必须返回 `IN_PROGRESS`…通知 task 同理，不能把正在 send 的 delivery 误核销 unknown”。
- 代码：`domain/delivery.ts:16-29` 的 Delivery 只有 `attempts` 计数，无 token/start/deadline；`storage/delivery.ts` 无相应字段；`runtime/deliveries.ts:213-219` 仍是**仅按 `status === 'attempting'` 就 `markDeliveryUnknown('interrupted')`**，不判断是否仍有活跃 worker。
- 探针：seed ready Job + notification Delivery(intent)，用 gated `NotificationPort`（send 进入后挂起，随后返回 delivered），创建两个 NotifyTask；第二个 task 在第一个 send 进行中执行 → 第一个 send 返回 delivered、adapter 只被调用 1 次，但最终 **Delivery.status = unknown / error='interrupted'**（外部事实上成功，账本为 unknown，且永不自动重放）。
- 影响：真实通知/告警会“实际成功但记 unknown”，运维无法区分；与 P0-3 直接冲突。resource Operation 侧实现是正确的（IN_PROGRESS/RECOVERY_REQUIRED/token CAS，见 §5），Delivery 侧缺失。
- 修复任务 R3：为 Delivery 增加 attemptToken/workerId/attemptStartedAt/deadline（考虑 Durable doc 版本策略：version 2 + 拒绝旧文档，或明确仅新增字段的兼容策略，不得静默迁移）；NotifyTask 活跃 attempt → `IN_PROGRESS`/不写、deadline 过期才允许显式 recover→unknown；settle 带 token CAS；补“并发 NotifyTask 只 send 一次、首个 send 成功则 Delivery done”“deadline 过期才 unknown”的回归；更新契约/README。

### B4（P0-6）file-outbox 的 `delivered` 会外推成远端已送达

- 契约：`resource-adapters.md:73`“可重启观察已有 outbox 文件，**不能把‘文件存在’外推为远端已送达**”；OpenSpec real-adapter spec 也强调 outbox 只证明本地记录。
- 代码/测试：`file-outbox.ts:70-71/132/238-264` 返回 `{outcome:'delivered', code:'outbox-written'}`；`notification-outbox.test.ts:42` 断言 `['delivered','outbox-written']`；delivery runtime 将 `delivered` 落为 Delivery.done（`runtime/deliveries.ts:254-270`）。
- 探针：delivery runtime + outbox port 运行 NotifyTask → **Delivery.status=done**，而“已送达”的唯一证据只有本地 outbox 文件。
- 影响：用户/后续汇报会把本地入队当成外部已送达；tester/lead 未把该行为写入已知限制。
- 修复任务 R4（需 lead 契约裁决，二选一）：
  (a) outbox adapter 返回 `outcome:'unknown'`（code `outbox-written`），Delivery 保持 unknown，明确需渠道核销；或
  (b) 修改契约明确“outbox 是本地 sink，delivered 仅表示 local accepted”，并保证 Delivery/汇报/README 不把它表述为远端送达，补边界测试。
  不允许保持现状但不改契约。

### B5（P0-5）Artifact writer 未复用文件硬化路径

- 契约：`resource-adapters.md:52` 末句“Artifact writer 应复用同一硬化路径”。
- 代码：`runtime/artifacts.ts:40-44` 仍用词法 `resolve` 前缀 containment；`:89` 用 `open(temporary,'wx',0o600)`，无 realpath/父目录 lstat/O_NOFOLLOW/rename 前复检/读回 hash；与 files.ts 已实现的硬化路径不一致（git status 无 artifacts.ts 修改）。
- 影响：Job 产物的写入路径仍可能被父目录 symlink 替换/TOCTOU 影响；与“真实文件的统一安全边界”和 P0-5 明文要求不符。
- 修复任务 R5：把 artifacts.ts 重构到 files.ts 的 primitives（canonical root、per-component realpath/lstat、O_NOFOLLOW|O_EXCL、fstat regular、fsync file+dirt、read-back hash），补 symlink/TOCTOU 用例；或由 lead 明确将本项转为 §7 已知限制 + verification-status 的“未做到”，不得静默忽略。

### B6（P0-1）CDP result 直接持久化，无 Artifact 引用/redaction

- 契约：`resource-adapters.md:28`“result/observation 也必须按 kind schema、大小上限、redaction 处理；大对象/截图写 Artifact 引用，禁止把任意 MB/凭据写进 Durable JSON”。
- 代码：`adapters/resource/cdp.ts:43` evaluate 的 `validateResult` 是 `() => {}`（无 schema/redaction）；`:44` screenshot 只检查 base64 长度 ≤192KiB；application 随后把结果作为 `operation.result` 持久化（acceptResult 只做大小/schema）。`resource-cdp.test.ts` 用 `'aGVsbG8='` 小数据，integration P0-7 只测“超界→unknown”。
- 探针：CDP screenshot 返回 190,000 字符 base64 → operation done，`result.data.length=190000` 持久化；evaluate 返回 `SECRET_TOKEN_VALUE…` → done，result 含该值；**close/reopen 后仍可读到秘密**。
- 影响：Durable JSON 膨胀 + 页面凭据/PII 进入长期状态，违反 P0-1；真实 browser adapter 放行条件不满足。
- 修复任务 R6：screenshot 结果写 Artifact（引用 artifactId/path/hash/bytes），operation.result 只存引用与元数据；evaluate 结果定义 bounded schema + redaction（或显式选择 artifact ref），默认拒绝/裁剪疑似秘密；补“截图不内联 base64”“evaluate 秘密不落 Durable”“超界→RESULT_REJECTED/unknown”回归。

## 4. 非阻塞发现（合并前建议处理/文档化）

1. **F1 组合（P0-8 部分）**：`openRuntime` 选项只有 `resources.effects/hash/token/deadlineMs` 与 `notification`；契约 §5 说可注入 file root/browser factories/notification target，实现上 file/CDP/target 需组合根手工构造再注入 effects（integration `secureRuntime` 即如此）。建议补显式 options（fileRoot/cdpEndpoint/notificationTarget）或把 §5 改成“adapters 由组合根构造并注入 effects registry；openRuntime 不隐式连接外部端点”，并加 fail-closed 测试。
2. **F2 HTTP 结构化结果未持久化**：adapter 返回 `{outcome,code,status,detail}` 且已 redact，但 `runtime/deliveries.ts` 只取 `outcome`（notification-http 测试断言 Delivery 只保留 tri-state）。真实渠道失败分类（401/429/5xx）无法从 Delivery 审计；建议至少持久化 redacted `code/status` 到 Delivery（或契约明确不持久化）。
3. **F3 notification target 仍硬编码 `'test'`**（`runtime/deliveries.ts:65`）；真实 HTTP/channel 的 target/route 配置未定义（HTTP adapter 目前只按 options.url 发固定端点）。建议加入 composition 配置并在 request 中传真实目标。
4. **F4 迁移拒绝靠错误文案正则**：`runtime/resources.ts:26-32` 用 `/version|migration/i.test(error.message)` 映射 `OPERATION_INCOMPATIBLE`；SDK 文案变化会让旧 v1 operation 以原始错误泄漏。建议用 SDK 明确错误类型/错误码（或预检文档版本字段）。
5. **F5 CDP 错误码不是稳定 ResourceError**：`cdp.ts` 的 definition validatePayload/validateResult、transport 失败抛普通 `Error('PAYLOAD_REJECTED'/'RESULT_REJECTED'/'CDP_DISCONNECTED')`；beginOperation 对非 ResourceError 会原样抛出，未来 API 错误映射不稳定。建议 adapter 统一抛 `ResourceError`/`EffectFailure` 稳定 code（files adapter 已这样做）。
6. **F6 dispatch fence 的残余窗口**：`dispatchFence`（application/resource.ts:505-510）在 attempt CAS 时校验 owner/lease/epoch；attempt 提交成功到 effect.invoke 之间若发生 takeover，effect 仍会执行（文件很短、CDP 可能长）。建议契约/README 明示“fence 保证派发前检查；in-flight 不撤销”，或 adapter 在首个外部帧前再次校验（需额外 resource 读）。
7. **F7 payload 内容长期驻留**：file.write 的 content（≤256KiB）作为 canonical payload 持久化在 Durable operation 文档；真实文件常含秘密。建议文档明确 payload 保留策略/清理（后续 WP），或在 adapter 层对敏感路径/内容做策略。
8. **F8 文档/任务状态**：OpenSpec `tasks.md` 的 1.4、3.1、3.2、4.1、4.2、5.1、5.2 仍未勾选；`docs/design/resource-boundary.md` 未更新 secure protocol；`verification-status`/README/evidence 属 task-27。`resource-adapters.md §7 已知边界` 未列出 B1–B6（修复/豁免后必须同步）。

## 5. P0-1..P0-8 逐条判定

| P0 | 判定 | 依据 |
|---|---|---|
| P0-1 effect 绑定/结果边界 | **不通过** | payload/hash/fingerprint 已持久化并纳入 idempotency（secure test 179/234），但 runOperation registry 可替换（B1）；CDP 结果未 redaction/artifact（B6） |
| P0-2 owner+lease+epoch fence | **通过（附 F6 残余窗口）** | `dispatchFence` :505-510 + 同 CAS attempt；integration P0-2 stale takeover 零副作用；expiry/release 测试在 resource-files/resource-secure |
| P0-3 attempt token | **不通过** | Operation 侧正确（IN_PROGRESS/RECOVERY_REQUIRED/token CAS；secure 330/347/487），Delivery 侧缺失（B3） |
| P0-4 unknown evidence 核销 | **不通过** | owner/epoch/payloadHash/schema 有校验，但 evidence 未绑定 payload、observer 仅字符串（B2） |
| P0-5 文件 symlink/TOCTOU | **不通过（主体通过，artifact writer 未做）** | files.ts 硬化与测试通过；artifacts.ts 未复用（B5） |
| P0-6 HTTP/outbox | **不通过（HTTP 通过，outbox 语义冲突）** | HTTP 分类/redirect/超时/凭据测试通过；outbox delivered 外推远端（B4）；结构化结果未持久化 F2 |
| P0-7 abort/deadline | **通过** | effect 收到 signal+deadline；deadline→unknown；late result 不 success（secure 395；files/http/cdp 超时） |
| P0-8 组合/fail-closed | **部分通过** | 无显式配置时 factories/openRuntime fail-closed（integration P0-8）；但 file root/CDP endpoint/target 无 openRuntime options（F1） |

## 6. 测试真实性评估与应补回归

- **优点**：task-29 integration 11 项是跨 adapter 的真实链路（openRuntime + durable store + file/CDP 真实 transport/文件系统 + loopback HTTP + outbox + delivery task），覆盖 payload 替换、stale epoch 零副作用、live IN_PROGRESS、schema 伪造 evidence、symlink、HTTP 分类/redirect/token、outbox 原子/冲突、CDP 超界、fail-closed、reopen 不重放。测试不是 smoke。
- **决定性缺口**（现有全绿但 blocker 仍在）：
  1. 未测 runOperation **registry substitution**（B1）；应补“同 kind 另一 registry → INVALID_COMMAND/零副作用”。
  2. 未测 schema 合法但 **sha/bytes/path 与 payload 不一致** 的 evidence（B2）；当前 P0-4 只测 `{}`、extra key、错误 payloadHash、错误 observer/epoch。
  3. 未测 **并发 NotifyTask / send 进行中的 Delivery**（B3）；现有 interrupted-attempting 是单 worker 重启场景。
  4. 未测 outbox → Delivery 语义（B4）；只测 adapter 自身返回 delivered。
  5. 未测 artifact writer 的 symlink/TOCTOU（B5）。
  6. 未测 CDP 大 screenshot/evaluate 秘密是否进入 Durable（B6）；只测超界→unknown。
- 建议 regression 名称：`P0-1 different registry for the same kind is rejected`、`P0-4 evidence content must match payload`、`P0-3 live notify attempt returns IN_PROGRESS and one send`、`P0-6 outbox delivery is not remote success`、`P0-5 artifact writer rejects symlinked parents`、`P0-1 CDP screenshot/evaluate never persist raw data or secrets`。
- 已核官方/隔离数字见 §2；task-27 gate 前必须重新跑全量（含上述新增）并附证据。

## 7. 独立探针证据（/tmp，不写入仓库）

| 探针 | 结果 |
|---|---|
| B1 registry substitution | fake effect invoked=1，operation=done，配置的真实 file effect 未写任何文件 |
| B2 forged schema-valid evidence | 伪造 sha ≠ payload sha；`observeOperation` accepted，unknown→done，result 记录伪造 sha |
| B3 concurrent NotifyTask | send 返回 delivered、adapterCalls=1，但 Delivery 最终 `unknown/interrupted` |
| B4 outbox→Delivery | outbox 目录仅 `notify-1.json`，Delivery.status=`done` |
| B6 CDP 结果 | screenshot result 190,000 字符 base64 持久化；evaluate 含 `SECRET_TOKEN_VALUE…`，close/reopen 后仍可读出 |
| J task-30 omitted-deadline | secure 测试 219 通过：省略 deadline 重放稳定，显式 deadline 与省略视为不同 command |

## 8. 文档、证据与 Gate

- 契约 §2 已写入 P0，但 §7 已知边界未列出 B1–B6 的现状；OpenSpec tasks 1.4/3.1/3.2/4.1/4.2/5.1/5.2 未勾选；`docs/design/resource-boundary.md` 未同步 secure protocol；`verification-status`/README/evidence/manifest 属 task-27。
- **task-27 gate 前必须**：修复 B1–B6 或获得 lead/owner 对每项的**显式书面豁免**（写入 §7 + verification-status“未验证/已知缺口”），并补 §6 回归；重新跑 `npm test`（含 integration）、targeted suites、`npm run build`、原型快速回归、`openspec validate --strict`，证据只增不覆盖。
- 不得在 evidence/文案中宣称“真实 adapter 安全”“exactly-once 通知”；真实 Steel/RTC/迁移/长期连接/凭据轮换仍未验证，必须显式列出。

## 9. 审查结论与任务建议

- 结论：**需修改**。代码/测试基础扎实（Durable v2、token/CAS、files 硬化、HTTP 安全分类、outbox 原子发布），但 B1/B2/B3/B4/B6 直接违反已冻结的 P0 安全契约，B5 为契约明列未做项；不能以 225/225 绿放行。
- 建议 remediation tasks（由 lead 分派）：
  - **R1（resource-impl）** 绑定 runtime registry，secure runOperation 不再接受 caller registry；回归 B1。
  - **R2（resource-impl + artifact/browser）** capability-level evidence-payload 绑定 + observer 认证/内部化；回归 B2。
  - **R3（delivery-impl）** Delivery attemptToken/workerId/deadline + live→IN_PROGRESS + token CAS + recover；回归 B3。
  - **R4（lead 决策 + delivery/resource）** outbox delivered 语义修正或契约豁免；回归 B4。
  - **R5（artifact/job owner）** artifacts.ts 复用 files.ts 硬化路径；回归 B5。
  - **R6（browser-impl）** CDP screenshot artifact ref + evaluate redaction/bounded schema；回归 B6。
  - **R7（lead/task-27）** 契约 §5/§7、README、OpenSpec tasks、verification-status、evidence 更新；F1–F8 逐条记录或修复。
- 若 lead 决定豁免某项：必须写清“本轮未做到、影响、真实 adapter 放行条件”，并同步 verification-status；review 不因豁免而隐藏该风险。
