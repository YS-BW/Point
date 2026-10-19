# WP2 真实 Adapter 最终复核（final2，code-auditor）

> 2026-10-19。对象：task-39（CDP RB1/RB2 remediation）后的 `wp/2-real-adapters` 工作树；基线仍 `0b0eb7f`。
> 依据：前次评审 `wp2-real-adapters-final.md` §RB1/RB2、[resource-adapters 契约](../../design/resource-adapters.md) §2、OpenSpec `agent-resource-adapter-safety`。
> 范围：只读；仅新增本文件。未改源码/测试/设计文档/旧评审。

## 1. 结论

**REJECT 最终 gate（1 个残留 blocker）。**

- **RB1（CDP evidence 伪造 done）已按前次要求闭合**：只有 `{format}` 的 screenshot evidence + 伪造 result 现在被拒（`RESULT_REJECTED`）；result 必须与 evidence 的 `artifactRef/sha256/bytes/format` 一致（`cdp.ts:63-70`），evaluate result 必须携带与 evidence 一致的 `observationHash`。前次 probe 的“只给 format 即可 done”不再成立。
- **RB2（CDP evaluate 秘密值持久化）仍未闭合**：evaluate 仍把 `value: safe` 整体写入 Durable；`redacted()`（`cdp.ts:44-52`）只按敏感 key 名、>4096 字符或 Bearer/JWT 前缀做 redaction。普通页面秘密（如 `SECRET_TOKEN_VALUE_1234567890`，28 字符，无 Bearer/JWT 前缀）作为 `result.value` 原样持久化，close/reopen 仍可读（probe 见 §3）。这违反契约 §2.1“result 按 kind schema、大小上限、redaction，禁止凭据写进 Durable JSON”，也与前次 final review RB2 的明确修复要求不符（“value 默认只存 hash/长度，或敏感值 redact；补 value=secret 回归”）。

修复 RB2 后可批准 gate。F/I/证据与未验证项仍由 task-27 收尾（不阻塞 RB2 判定，但不能在文档/verification-status 中省略）。

## 2. 独立验证（隔离 outDir，未写官方 dist）

| 项目 | 结果 |
|---|---|
| `npx tsc ... --outDir /tmp/point-audit-7` | BUILD_OK |
| integration（18）+ cdp + artifact-hardening(9) + delivery-concurrency(8) 隔离运行 | **38/38 pass** |
| 服务端全量隔离构建 | **251/251 pass** |
| `scripts/*.test.mjs` | 10/10 pass |
| `tsc --noEmit` / `check-boundaries.mjs` | exit 0 / passed |

task-39 新增/更新：`cdp.ts`（evaluate `{observationHash,value}`、result↔evidence 交叉校验、字符串值 Bearer/JWT/>4096 redaction）、`resource-cdp.test.ts`（3 项，含 key 名 redaction、screenshot result/evidence mismatch、no sink）。integration 18 项未变化；REDLINE-H 仍只用 `screenshotData` 放 secret，evaluate 路径未覆盖值级 secret。

## 3. 独立探针（task-39 后）

- screenshot：evidence=`{format:'png'}` + result=`{artifactRef:'artifact:forged',sha256:'a'*64,bytes:1,format:'png'}` → **`RESULT_REJECTED`**（RB1 原路径已堵）。
- screenshot：evidence 与 result 完全自洽但都是伪造（`artifactRef:'artifact:forged'`，无真实 artifact）→ **accepted，unknown→done**。这是当前进程内信任边界问题（与 file 的“caller 可构造与 payload 一致的 evidence”同类；observer 仍只是 owner 字符串），**记为非阻塞已知限制**，不是本轮 RB1 修复范围之外的回归。
- evaluate：返回 `{result:{type:'string',value:'SECRET_TOKEN_VALUE_1234567890'}}` → operation done，`result.value` 含明文；close/reopen 后仍含明文。**RB2 blocker**。
- 其余 B1–B6 修复复核沿用前次探针并复跑：registry substitute→INVALID_COMMAND + 真实写盘；伪造 file sha evidence→INVALID_EVIDENCE + 真实 reconcile done；并发 notify→单次 send + done；outbox→Delivery unknown；artifact 硬化由 REDLINE-E + 代码核对；task-30 指纹测试通过。

## 4. Blocker（仅 RB2）

**RB2（P0-1）evaluate 结果仍持久化任意页面值。**

- 代码：`cdp.ts:44-52` 的 redaction 只处理敏感 key、超长（>4096）与 Bearer/JWT 前缀字符串；`:63-66` 的 evaluate 分支返回 `{observationHash, value: safe}`，application 将该 result 持久化为 `operation.result`。
- 影响：页面上的 API key、会话串、邮箱/PII 等通常以普通字符串 `value` 返回（尤其 `Runtime.evaluate` 的 `{result:{type:'string',value:...}}`），长度 <4096 且无 Bearer/JWT 前缀时原样进入 Durable，后续可被投影/记忆读取。
- 修复 R6c（browser-impl，最小改动）：
  1. evaluate 默认只持久化结构化元数据：`{observationHash, valueType, valueBytes}`，不持久化 `value` 原文；或把原始结果经 `artifactSink` 写 Artifact，result 只存 `{artifactRef,sha256,bytes,observationHash}`。
  2. 若产品确需返回短值，显式 opt-in + 只存 bounded preview 且对 value 做敏感模式扫描/截断；默认 fail-closed。
  3. 回归：evaluate 返回普通 secret 字符串（非 Bearer/JWT）→ 持久化/reopen 不含 secret；无害短标量按新 schema 可测；扩展 REDLINE-H 到 evaluate value 路径。
- 若 lead/owner 决定“evaluate 返回值按设计允许进入 Durable”，则必须书面修订契约 §2.1、在 verification-status 列明该已知风险并禁止宣称“结果已 redact”；当前实现不能以“已修复”记录。

## 5. F/I、文档与未验证项（task-27 收尾）

- **F 组合**：`docs/design/resource-adapters.md:82` 仍写 openRuntime options 可注入 file root/browser factories；实际 `open.ts` 只接受 `resources.effects/hash/token/deadlineMs` + `notification`，file/CDP/http 需组合根手工构造 effects。task-27 需收窄 §6/README。
- **I 迁移**：v1 operation/delivery 拒绝依赖 `runtime/resources.ts:26-32`、`runtime/deliveries.ts:89-94` 的 SDK 错误 message 正则；旧库不迁移，需写入 verification-status，typed error 为后续改进。
- **worktree**：未跟踪 `.tmp-tsconfig.json` 仍在（13:05），提交前必须清理。
- **OpenSpec**：tasks 1.4、5.1、5.2 仍未勾选；evidence/manifest、verification-status 待 task-27。
- **未验证（必须显式列出）**：真实 Steel/CDP 端点与真实 WebSocket 行为；RTC/viewer/浏览器多会话；旧库迁移/备份/回滚；长连接泄漏、凭据轮换、并发容量、Docker/部署；真实 HTTP provider 的 Idempotency-Key/查询核销/exactly-once；CDP `artifactSink` 与真实 artifact store 的集成（openRuntime 未提供 sink）；notification target 仍 `'test'`。

## 6. Gate 判定

- **本轮仍 REJECT**：仅因 RB2（evaluate 普通秘密值持久化）。RB1 已按最终 review 要求修复；B1–B6 其余项均通过独立验证，无回归。
- 完成 R6c 并补 evaluate secret/reopen 回归（或 owner 明确书面豁免并改契约/verification-status）后，重跑隔离+官方 targeted/integration/full/build/原型/OpenSpec strict 与证据，我可改判通过。F/I/未验证项由 task-27 闭合，不单独阻塞代码，但阻塞 gate 的文档完整性。
