# WP2 真实 Adapter 最终独立评审（code-auditor）

> 2026-10-19。评审对象：`wp/2-real-adapters` 工作树（基线 `0b0eb7f`，含 task-31..36 remediation 后的当前源码）。
> 依据：[resource-adapters 契约](../../design/resource-adapters.md) §2 P0、§4/§5/§7/§8；OpenSpec `agent-resource-adapter-safety`；[agent-core 十条不变量](../../design/agent-core.md)；前次评审 `wp2-real-adapters.md`（未修改）。
> 范围：只读审计；仅新增本文件。未改源码/测试/设计文档/旧评审。

## 1. 最终结论

**拒绝最终 gate（2 个残留 blocker）。** 前次 B1–B6 中 B1/B2(file)/B3/B4/B5 已确认修复，B6 screenshot 部分已修复；但独立探针发现两个仍未闭合的契约缺口：

- **RB1（P0-4，B2 残留）**：CDP 的 evidence 未绑定真实 observation。screenshot evidence 只校验 `format`，攻击者可伪造 `{format:'png'}` + 任意 `artifactRef` 把 unknown 核销为 done（probe 已复现）。
- **RB2（P0-1，B6 残留）**：CDP evaluate 的 redaction 只按 key 名匹配；页面 token 常以 `{result:{type:'string',value:'<secret>'}}` 返回，`value` 不匹配敏感 key，**秘密原样持久化**（probe 已复现，reopen 仍可读）。

修复 RB1/RB2 并补对应回归后，本评审建议 gate 通过。F/I 为文档/已知限制项，须在 task-27 闭合（见 §5），不能静默省略。

## 2. 独立验证结果（隔离 outDir，未写官方 dist）

| 命令 | 结果 |
|---|---|
| `npx tsc -p apps/server/tsconfig.json --outDir /tmp/point-audit-6` | BUILD_OK |
| `node --test .../resource-adapter-integration.test.js`（task-29，18 项含 REDLINE-A/B/C/D/E/G/H） | **18/18 pass** |
| `node --test .../artifact-hardening.test.js .../delivery-concurrency.test.js` | **17/17 pass**（9 + 8） |
| 服务端全量隔离构建 `node --test /tmp/.../test/*.test.js` | **251/251 pass** |
| `node --test scripts/*.test.mjs` | 10/10 pass |
| `npx tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| `node scripts/check-boundaries.mjs` | Architecture boundaries passed |
| 官方窗口（tester/lead 报告） | integration 18/18；server 251/251；tsc/boundaries 绿 |

测试真实性：integration 仍保留负向 + 正向断言（REDLINE-A 拒绝 fake registry 后真实 dispatch；REDLINE-B 拒绝伪造 evidence 后真实 observation done；REDLINE-C 并发 send 仅一次且 done；REDLINE-D 本地记录存在但 Delivery unknown；REDLINE-E root 外零写入+sentinel 不变+正常写入；REDLINE-G token/body 不入 audit；REDLINE-H screenshot raw 不落 Durable）。未见测试弱化。

## 3. 前次六 blocker 复核（当前源码 + 探针）

| 前次 | 状态 | 证据 |
|---|---|---|
| B1 registry substitution | **已修复** | `application/resource.ts:809-818`：secure 只接受缺省或绑定的 `registry`，替换 registry → `INVALID_COMMAND`；probe：fake invoked=0、真实 file effect 写盘、state=done |
| B2 file evidence/result binding | **已修复（file）** | `files.ts:267-296` parseEvidence 校验 path/sha/bytes 与 payload；`files.ts:243-265` result 必须复述 payload/evidence；REDLINE-B；probe 伪造 sha → `INVALID_EVIDENCE`，真实 reconcile done |
| B3 Delivery attempt token | **已修复** | `domain/delivery.ts:28-33` v2 字段；`runtime/deliveries.ts:240-289` admission：同 worker 恢复/过期 recover/活跃 `in-progress`；`:318-326` token CAS settle；`delivery-concurrency.test.ts` 8 项；probe：并发任务 mid=attempting 有 live token、send 仍仅 1 次、最终 done |
| B4 outbox delivered | **已修复** | `file-outbox.ts:75-76` 返回 `{outcome:'unknown', code:'outbox-written'}`；probe：Delivery=`unknown`、error=`notification-unknown:outbox-written:local-only`，outbox 文件仅本地记录 |
| B5 artifact writer hardening | **已修复** | `runtime/artifacts.ts:125-240`：realpath/lstat/secureDirectory/O_NOFOLLOW temp/fstat/pre-rename 复检/fsync dir/read-back；REDLINE-E 9 项 hardening 测试 |
| B6 CDP raw result | **部分修复** | screenshot 走 `artifactSink`，result 只存 `{artifactRef,sha256,bytes,format}`（probe：无 raw base64）；evaluate 仍按 key 名 redaction（RB2） |

## 4. 残留 Blocker（必须修复或 owner 书面豁免）

### RB1（P0-4）CDP evidence 未绑定 observation，可伪造 unknown→done

- 代码：`cdp.ts:58-66` 的 `evidenceFor`：navigate 只比 `evidence.url`；evaluate 只比 `expressionHash`；screenshot 只比 `format/quality`。`screenshotDefinition` 的 result 只校验 `artifactRef/sha256/bytes/format` 的类型；application 的 `observeOperation`（`application/resource.ts:920-931`）把调用方 evidence/result 交给 definition 校验后直接 `reconcileWithEvidence`。
- 探针：screenshot 超界导致 unknown 后，提交 evidence=`{format:'png'}` + result=`{artifactRef:'artifact:forged', sha256:'a'*64, bytes:1, format:'png'}`（observer/epoch/payloadHash 正确）→ **accepted，unknown→done，伪造 artifactRef 持久化**。
- 影响：违反契约 §2.4/OpenSpec “matching evidence for the operation payload”与 CDP “observe 只查询/核销”：任意能调 `observeOperation` 的调用方可在无真实 artifact 的情况下把 CDP 操作核销成功（与 file 已修复的同类问题在 CDP 仍未闭合）。
- 修复 R6b（browser-impl）：
  1. 定义 CDP capability 的 evidence schema：screenshot 至少 `{kind:'cdp.screenshot', format, artifactRef, sha256, bytes}`，evaluate `{kind:'cdp.evaluate', expressionHash, resultSha256, bytes}`，navigate `{kind:'cdp.navigate', url, status?}`；`evidenceFor` 必须校验全部字段并与 payload/result 交叉一致。
  2. `validateResult` 对 reconcile 路径要求 result 与 evidence 的 artifactRef/sha256/bytes 完全一致；不允许“只有 format”的 evidence。
  3. 回归：伪造 artifactRef/sha 的 screenshot evidence → `INVALID_EVIDENCE`；真实 artifact sink 观察 → done；evaluate 伪造 result 被拒。
- 若本轮不做：必须由 owner 明确把“CDP 不支持 unknown→done reconcile（只能保持 unknown/人工介入）”写入契约与 verification-status，并禁止该调用路径，不能保留可伪造的 done。

### RB2（P0-1）CDP evaluate 的秘密值仍原样持久化

- 代码：`cdp.ts:44-56` 的 `redacted()` 只对 key 名匹配 `/secret|token|password|cookie|authorization|api[-_]?key|private[-_]?key|credential/` 的字段置 `[REDACTED]`；`evaluateDefinition` 的 result 仅做大小校验（`cdp.ts:69`），`Runtime.evaluate` 的真实返回通常是 `{result:{type:'string', value:'<页面值>'}}`，key `value` 不匹配敏感模式。
- 探针：evaluate 返回 `{result:{type:'string', value:'SECRET_TOKEN_VALUE_…'}}` → operation state=done，result 含明文 secret；close/reopen 后从持久化 operation 仍读出 secret。REDLINE-H 只用 `screenshotData` 放 secret，evaluate 返回 `'ok'`，因此 18/18 绿并未覆盖此路径。
- 影响：违反契约 §2.1“result 按 kind schema、大小上限、redaction 处理，禁止凭据写进 Durable JSON”；真实浏览器页面 token/PII 会进入 Durable/后续投影。
- 修复 R6c（browser-impl）：
  1. evaluate result 改为受限 schema：例如 `{type, valueLength, valueSha256, preview?}`；字符串值默认只存 hash/长度，或对字符串值做敏感模式扫描后截断/`[REDACTED]`，大值走 artifact ref（与 screenshot 一致）。
  2. 若产品需要返回值，必须显式 opt-in 且只允许 bounded preview，并记录“不允许 secret”契约；默认 fail-closed。
  3. 回归：evaluate 返回 `value:'SECRET…'` → 持久化 result 不含 secret；reopen 后不含；正常无害值可返回（或按 schema 返回 hash/preview）。
- REDLINE-H 测试需扩展 evaluate 值路径，当前只覆盖 screenshot 的 raw base64。

## 5. F/I 与文档/已知限制（task-27 必须闭合）

- **F 组合契约收窄**：`docs/design/resource-adapters.md §6` 仍写“options 可注入 notification port、file root、browser adapter factories”；实际 `runtime/open.ts:35-54` 只有 `resources.effects/hash/token/deadlineMs` + `notification`，file root/CDP endpoint/target 需组合根手工构造 effects（integration `secureRuntime` 即手工注入）。task-27 必须把 §6/README 改为“adapters 由组合根构造并以 effects registry 注入；openRuntime 不隐式连接外部端点”，并保留 fail-closed 说明；否则实现与契约不符。
- **I 迁移/版本拒绝**：`runtime/resources.ts:26-32` 与 `runtime/deliveries.ts:89-94` 用 SDK 错误 message 正则 `/version|migration/i` 映射 `OPERATION_INCOMPATIBLE` / `DELIVERY_INCOMPATIBLE`；v1 resource-operation / delivery 文档被拒绝、**旧库不迁移**。该文案正则脆弱（SDK 文案变化会漏出原始错误）；task-27 应在契约/verification-status 记录“旧 v1 文档需显式迁移 WP、当前 fail-closed”，并把 typed SDK error 作为后续改进（非本轮 blocker）。
- **CDP artifact sink 未在 openRuntime 组合**：screenshot 要求显式 `artifactSink`（`cdp.ts:66`）；`open.ts` 无该 option，测试用 fake sink。真实 composition（artifactFiles 作为 sink）未集成，必须列入未验证/后续 WP。
- **notification target**：`runtime/deliveries.ts` 仍用 `NOTIFICATION_TARGET='test'`，真实渠道 target/route 配置未定义（HTTP adapter 只按 options.url 固定端点）；task-27 记录为组合限制。
- **工作树卫生**：存在未跟踪的 `.tmp-tsconfig.json`（13:05，疑似实现临时文件），gate/提交前必须清理，不能入库。
- **OpenSpec tasks**：`tasks.md` 1.4、5.1、5.2 仍未勾选；verification-status/README/evidence/manifest 由 task-27 更新。
- 文档 §7/§8 目前未列出真实 Steel/RTC/migration/long-run 的“未验证”口径，task-27 需补。

## 6. 未验证项（必须在 task-27 evidence/verification-status 显式列出）

- **真实 Steel/CDP 端点**：所有 CDP 测试用 fake transport；未连接真实 Steel/Chrome，未验证真实 WebSocket、Target attach、帧序列差异、断线重连/长连接泄漏。
- **RTC/viewer/浏览器侧多会话**：本 WP 明确未做，未验证。
- **旧库迁移**：v1 operation/delivery 文档拒绝路径有测试，但真实 SQLite 旧库升级/备份/回滚流程未验证；不迁移。
- **长期运行**：长连接泄漏、凭据轮换、并发容量、真实网络重试/超时分布、Docker/部署环境未验证。
- **真实 HTTP provider**：Idempotency-Key 生效、provider 查询/核销、exactly-once 未验证（契约明确没有 provider 查询时 unknown 永久保留）。
- **真实 artifact sink 集成**：CDP screenshot → Artifact 的真实写入/读取/权限未验证（测试用 fake sink）。

## 7. 测试覆盖建议（修复 RB1/RB2 时同步补）

1. `CDP forged evidence cannot settle unknown screenshot done`（伪造 artifactRef/sha/bytes → INVALID_EVIDENCE）；
2. `CDP evaluate does not persist secret values (reopen included)`（value=secret → 持久化/reopen 不含 secret，正常值按 schema 返回）；
3. 扩展 REDLINE-H：evaluate 的 value 含 secret；screenshot 的 artifactSink 被真实调用一次且 result 仅引用；
4. 可选：deadline 并发 recover（当前 resource 端已有 deadline/recover 测试；delivery 并发已有 8 项，可补“并发 recover 只有一个赢家”）。

## 8. Gate 判定

- **REJECT（本轮不能通过最终 gate）**：RB1（CDP evidence 可伪造 done）与 RB2（CDP evaluate 秘密值持久化）违反 P0-4/P0-1；现有 18/18 与 251/251 未覆盖这两条路径，不能作为放行依据。
- 修复 RB1/RB2（或 lead/owner 对 CDP reconcile 与 evaluate 返回语义做出**明确书面豁免**并写入契约/verification-status）后，重新跑：隔离+官方 targeted、integration 18+new、full `npm test`、`npm run build`、原型快速回归、`openspec validate --strict`；证据只增不覆盖。之后本评审可改判通过。
- F/I 与未验证项不阻塞代码 merge，但阻塞“最终 gate 的文档/证据完整性”：task-27 必须收窄 §6、记录 v1/迁移/Steel/RTC/long-run 未验证、清理 `.tmp-tsconfig.json`、勾选 OpenSpec 5.1/5.2 并生成 evidence。
- 前次 B1–B5 与 B6(screenshot) 修复质量通过独立探针，记录在 §3；本轮只新增本文件，未修改旧评审/源码/测试。
