## Why

WP2 的 memory stub 与 Durable store 已通过 176 项测试，但 code audit 发现旧 `runOperation(operationId, effect)` 契约不能安全承载真实文件/HTTP/CDP：操作没有 effect payload/hash，lease 只比较 epoch，attempting 可被并发调用误核销，unknown 可由任意调用者伪造，文件路径存在 symlink/TOCTOU，HTTP outcome/凭据/超时规则不足，结果无界且没有 abort/deadline。

## What Changes

- 扩展 ResourceOperation：`effectKind/effectPayload/payloadHash/owner/attemptToken/attemptStartedAt/deadline`，effect registry 固定 capability；run/reconcile 只执行/核销同一 payload。
- 加强 dispatch fence：owner + 未过期 lease + epoch + attempt token；并发 attempting 返回 IN_PROGRESS，不自动转 unknown；abort/deadline 传入 effect。
- unknown 核销要求 observer、epoch、payloadHash 和结构化 evidence（schema/大小/redaction）。
- 实现真实 file adapter（原子写、realpath/symlink/TOCTOU 防护）、HTTP NotificationPort（状态分类、Idempotency-Key、凭据与 redirect/timeout 安全）、file-outbox adapter。
- 实现 loopback CDP adapter（navigate/evaluate/screenshot，unknown/epoch fence），不接 RTC/viewer/Steel 默认端点。
- 增加 Durable/SQLite、文件、HTTP、CDP fake transport、并发/强杀/unknown 回归。

## Capabilities

### New Capabilities
- `secure-resource-effects`: 受控 effect payload、fence、attempt token、evidence 核销和 deadline。
- `real-resource-adapters`: file、HTTP notification、file outbox、loopback CDP adapters。

### Modified Capabilities
- `resource-boundary`: ResourceOperation/ResourceEffectPort/reconcile 契约升级，旧未绑定 effect 的调用禁止接入真实 adapter。

## Impact

会修改 domain/application/storage/runtime/resource adapter 与 tests；可能新增 `adapters/resource/files.ts`、`adapters/resource/cdp.ts`、`adapters/notification/http.ts`、`adapters/notification/file-outbox.ts`。不改 browser-side RTC/viewer，不默认连接 Steel；不改第二执行引擎。旧 Durable resource 文档 version 1 不自动迁移，升级需明确拒绝或独立 migration WP。
