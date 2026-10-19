# Design

## Context

`docs/design/roadmap.md` 定义 WP4 为 API v1 基础契约，出口判据是契约测试覆盖 400/404/409/413/503 且重放响应逐字节相等。现有 application 层已有 `ChatCommands`、`ConversationCommands`、`ProfileCommands`、`JobCommands`、`FollowupCommands`、`DeliveryCommands`，全部接收 `unknown` 输入并返回结构化结果或抛带稳定 code 的错误；HTTP 层只做传输适配。

## Goals / Non-Goals

**Goals:**

- 冻结 `/v1` 形状：路径、方法、错误信封、幂等键位置、鉴权方式、日志字段。
- 让重复请求天然幂等：把 `Idempotency-Key` 映射为既有 command 的 `requestId`，靠 Durable 收据保证同一结果。
- 所有失败都有稳定 code，客户端不需要解析文案。

**Non-Goals:**

- AG-UI/SSE、流式事件、`POST /v1/agent`（WP5）。
- 读模型、增量事件、离线重连（WP6）。
- 新的业务规则、新的持久状态、第二份响应缓存。
- 多租户/多用户鉴权、OAuth、速率限制。

## Decisions

1. **薄传输层，不复制业务逻辑。** 每个 handler 只做：解析 HTTP → 校验幂等键/参数形状 → 调 command → 序列化。任何业务校验仍在 application 层，避免出现第二套规则。
2. **错误信封 `{error:{code,message,requestId}}`。** HTTP 状态由稳定 code 映射：`INVALID_COMMAND`/`INVALID_TRANSITION`→400，`*_NOT_FOUND`→404，`IDEMPOTENCY_CONFLICT`/`RESOURCE_CONFLICT`→409，`NOTIFICATION_NOT_CONFIGURED`/`RUNTIME_NOT_READY`→503，未知异常→500（message 固定，不泄漏内部细节）。
3. **幂等键映射 requestId。** 写操作要求 `Idempotency-Key`（≥8 字符）；同 key 落在同一条 Durable 收据上。重放命中收据返回首次结果；序列化固定 key 顺序，保证逐字节相等。**不缓存 HTTP 响应**，否则会产生第二份事实。
4. **鉴权 fail-closed。** `POINT_API_TOKEN` 未配置时 `/v1` 一律 503 `API_NOT_CONFIGURED`（而不是开放访问）；配置后要求 `Authorization: Bearer <token>`，使用常量时间比较；`/health/*` 永久开放且不含敏感信息。
5. **请求体上限 1 MiB。** 超限在读 body 时立即 413 并断开，不缓冲全部内容；非法 JSON→400；`Content-Type` 必须为 `application/json`。
6. **访问日志只记元数据。** 每请求一行 JSON：`requestId/method/path/status/durationMs/bytesIn`；禁止记录 Authorization、body、查询串中的敏感值。日志写 stdout，不落 Durable。
7. **`/inspect` 双重门控。** 需 `POINT_API_INSPECT=1` 且通过鉴权，只读返回计数与版本；关闭时 404（不暴露存在性）。
8. **路由表显式。** 不使用文件系统自动扫描；未匹配→404，方法不符→405 + `Allow` 头。

## Risks / Trade-offs

- [Risk] 把写操作直接暴露为 HTTP 会放大误用面 → 所有写操作强制幂等键，且不提供批量/删除类破坏性端点。
- [Risk] 错误码映射可能泄漏内部状态 → 未知异常统一 500 固定文案；只在 4xx/409 返回稳定 domain code。
- [Risk] 访问日志可能被写入凭据 → 只记录白名单字段，测试断言 token 不出现在日志中。
- [Risk] `/inspect` 暴露运维信息 → 默认关闭，需显式开关；测试断言默认 404。

## Migration Plan

无状态迁移：新增路由不改变既有数据；回滚即关闭 `/v1` 开关（`POINT_API_TOKEN` 未配置时 503）或回退提交。`/health/*` 行为保持向后兼容，只新增字段不删除字段。

## Open Questions

无。AG-UI 事件形状留到 WP5，不在本变更内决定。
