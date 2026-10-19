# WP2 真实 Adapter 最终复核（final3，code-auditor）

> 2026-10-19。对象：task-41（CDP evaluate 明文修复）后的 `wp/2-real-adapters` 工作树；基线 `0b0eb7f`。
> 依据：`wp2-real-adapters-final2.md` §RB2、[resource-adapters 契约](../../design/resource-adapters.md) §2、OpenSpec `agent-resource-adapter-safety`。
> 范围：只读；仅新增本文件。未改源码/测试/设计文档/旧评审。

## 1. 结论

**APPROVE 最终 gate（代码/安全层）。** 前次唯一残留 blocker RB2 已修复：CDP evaluate 不再持久化任何页面值原文；nested/string 普通秘密不进入 `operation.result`，close/reopen 亦不可读。RB1 与 B1–B6 复核仍通过，无回归。

批准附带 task-27 的**文档/证据条件**（非代码 blocker）：F 组合契约收窄、I 迁移说明、`.tmp-tsconfig.json` 清理、OpenSpec 1.4/5.1/5.2、未验证项与增量 evidence 必须写入 verification-status；不得宣称未验证能力。

## 2. 独立验证（隔离 outDir，未写官方 dist）

| 项目 | 结果 |
|---|---|
| `npx tsc ... --outDir /tmp/point-audit-8` | BUILD_OK |
| targeted（integration 18 + cdp + artifact-hardening 9 + delivery-concurrency 8） | **38/38 pass** |
| 服务端全量隔离构建 | **251/251 pass** |
| `scripts/*.test.mjs` | 10/10 pass |
| `tsc --noEmit` / `check-boundaries.mjs` | exit 0 / passed |

task-41 改动：`cdp.ts` evaluate 分支返回 `{observationHash, valueType, valueBytes}`（显式删除 `value`）；`evaluateDefinition.validateResult` 拒绝含 `value` 的 result；`resource-cdp.test.ts` 增加 ordinary string `SECRET_TOKEN_VALUE`/nested password/token 不出现的断言。integration 18 项未变。

## 3. RB2 修复验证（独立探针）

- Fake CDP evaluate 返回 `{result:{type:'string', value:{ordinary:'SECRET_TOKEN_VALUE_1234567890', nested:{token:'abc', password:'pw'}, arr:[secret]}}}`：
  - `operation.result` 仅为 `{observationHash, valueType:'object', valueBytes:177}`，**不含 secret/token/password**；
  - close/reopen 后持久化 operation 仍不含 secret；
  - screenshot 仍只存 `{artifactRef, sha256, bytes, format}`，不含 raw base64（`A.repeat(1000)` 不出现）。
- 结论：evaluate 的普通/嵌套字符串值不再以任何形式写入 Durable；`observationHash` 只用于核销绑定，不泄露原文。
- RB1 复核：`screenshotDefinition.validateResult` 仍要求 result 与 evidence 的 `artifactRef/sha256/bytes/format` 完全一致；只给 `{format}` 的伪造 evidence + result 被拒（cdp 单测）。evidence/result 绑定保持 sound（在既有 schema 语义内）。

## 4. 前次 B1–B6 / RB1 复核

| 项 | 状态 |
|---|---|
| B1 registry 绑定 | 通过（替换 registry→INVALID_COMMAND，真实 dispatch；application/resource.ts:809-818） |
| B2 file evidence/result 绑定 | 通过（files.ts:243-296；伪造 sha→INVALID_EVIDENCE，真实 reconcile done） |
| B3 Delivery attempt token | 通过（domain/delivery.ts v2 字段、runtime/deliveries.ts admission/token CAS；delivery-concurrency 8 项） |
| B4 outbox unknown | 通过（file-outbox.ts localAccepted；Delivery unknown，本地记录存在） |
| B5 artifact writer 硬化 | 通过（artifacts.ts secureDirectory/O_NOFOLLOW/read-back；REDLINE-E 9 项） |
| B6 screenshot raw/secret | 通过（artifactSink + result 仅引用；probe 无 raw base64） |
| RB2 evaluate 明文 | 通过（本节 §3） |

B1–B6/RB1 的修复代码在 task-41 中未改动；本次全量 251/251 与 targeted 38/38 重新确认无回归。

## 5. 非阻塞残留（如实记录，task-27 文档/后续）

1. **进程内 observer 信任边界**：`observeOperation` 的 observer 仍只是 owner 字符串；能读取 payload/owner 的内部调用方可构造“自洽但无真实 artifact”的 CDP screenshot evidence+result 把 unknown 核销 done（file 也可构造与 payload 一致的 evidence）。这是当前单进程/信任域设计边界，建议写入 §7/verification-status；若未来 expose HTTP API，需 observer 凭据/签名。
2. **F 组合契约**：`docs/design/resource-adapters.md:82` 仍写 openRuntime options 可注入 file root/browser factories；实际只有 `resources.effects/hash/token/deadlineMs` + `notification`，file/CDP/http 需组合根手工构造 effects。task-27 收窄 §6/README。
3. **I 迁移/版本**：v1 operation/delivery 拒绝依赖 SDK 错误 message 正则（resources.ts:26-32、deliveries.ts:89-94）；旧库不迁移；写入 verification-status，typed SDK error 为后续改进。
4. **CDP artifactSink 未在 openRuntime 组合**：真实 artifact store 集成未验证；screenshot 必须显式 sink（fail-closed）。
5. **notification target** 仍 `NOTIFICATION_TARGET='test'`；真实渠道 target/route 配置未定义。
6. **worktree 卫生**：未跟踪 `.tmp-tsconfig.json`（13:05）需在提交前清理；OpenSpec tasks 1.4、5.1、5.2 未勾选；evidence/manifest、verification-status 待 task-27。
7. **未验证项（必须显式列出）**：真实 Steel/CDP 端点与真实 WebSocket 行为；RTC/viewer/浏览器多会话；旧库迁移/备份/回滚；长连接泄漏、凭据轮换、并发容量、Docker/部署；真实 HTTP provider 的 Idempotency-Key/查询核销/exactly-once；真实 artifact sink 集成。

## 6. Gate 判定

- **代码/安全门：APPROVE。** 前次 RB2（CDP evaluate 明文持久化）已通过源码+探针+回归闭合；B1–B6/RB1 无回归。
- **task-27 必须完成**：F/I 文档与 README 收窄、清理 `.tmp-tsconfig.json`、勾选 OpenSpec 1.4/5.1/5.2、生成 append-only evidence、更新 verification-status 并列出 §5 未验证项；不得在 evidence/文案中宣称真实 Steel/RTC/迁移/long-run 已验证或 exactly-once。
- 本评审只新增 `wp2-real-adapters-final3.md`，未改旧评审/源码/测试/设计文档。
