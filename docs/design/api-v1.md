# HTTP API v1 契约（WP4）

> 2026-10-19。WP4 冻结 `/v1` 传输契约：路由、错误信封、幂等键、鉴权、访问日志与门控诊断。实现见 `apps/server/src/api/**`，路由细节与状态码表在 [apps/server/README.md](../../apps/server/README.md)；本文件是设计层口径，数字以 [验证状态](verification-status.md) 为准。

## 1. 定位

`/v1` 是既有 application commands 的**薄传输层**：不复制业务规则、不新增事实、不新增执行引擎。成功响应就是命令返回的 JSON；失败统一为错误信封。后续 WP5 在此之上做 AG-UI 投影，WP6 提供读模型与增量事件，本片都不包含。

## 2. 冻结的形状

- **路径**：`/v1/<资源>`，资源名用复数、动作作为子路径（如 `POST /v1/jobs/:jobId/amend`）；`GET /inspect` 与 `/health/{live,ready}` 不在 `/v1` 下。
- **错误信封**：`{"error":{"code":"...","message":"...","requestId":"..."}}`；`code` 稳定、客户端不得解析文案；未知异常固定 500 `INTERNAL_ERROR` + 固定 message，不含栈/路径/凭据。
- **状态码映射**：400（输入/校验/未注册能力）、401（鉴权）、404（`*_NOT_FOUND`/未知路径）、405（方法不符 + `Allow`）、409（幂等或资源冲突、`IN_PROGRESS`、`RECOVERY_REQUIRED`）、413（体过大）、500、503（`API_NOT_CONFIGURED`/`RUNTIME_NOT_READY`/`MODEL_NOT_CONFIGURED`/`NOTIFICATION_NOT_CONFIGURED`/`DATA_DIR_BUSY`）。
- **幂等键**：所有写端点必须带 `Idempotency-Key`（`^[A-Za-z0-9._:-]{8,128}$`），HTTP 层把它映射为命令的 `requestId`；body 不得自带 `requestId`。同 key 同 payload 重放返回**逐字节相同**响应（靠 Durable 收据，**不缓存 HTTP 响应**），同 key 异 payload → 409。
- **鉴权**：`POINT_API_TOKEN` 未配置时 `/v1` 一律 503 `API_NOT_CONFIGURED`（fail-closed），`/health/*` 始终开放；配置后要求 `Authorization: Bearer`，常量时间比较。
- **请求约束**：`Content-Type: application/json`、严格 JSON object、体上限 1 MiB（超出在读取时立即 413，不先全量缓冲）；响应带 `X-Request-Id`。
- **访问日志**：每请求一行 JSON（`at/event/requestId/method/path/status/durationMs/bytesIn`），**绝不记录 Authorization、body、查询串**。
- **顺序**：404/405 先于鉴权判定（不暴露路由存在性），已知路由再进入鉴权。
- **门控诊断**：`/inspect` 默认 404；`POINT_API_INSPECT=1` 且通过同一 Bearer 时返回 `{version,instanceId,phase,capabilities}`。

## 3. 非目标

AG-UI/SSE 与 `POST /v1/agent`（WP5）、读模型与增量事件（WP6 已交付）、多租户/OAuth/限流、批量或删除类端点。**WP6 已把 Durable 计数放进 `/inspect`**（键固定 13 个实体族，`countsTruncated` 当前恒为 false、计数为精确值）。

**WP6 新增只读端点**：`GET /v1/state`（派生读模型，GET 不需要 Idempotency-Key）、`GET /v1/threads/:threadId/stream`（线程流，自定义 SSE 绑定，帧 `id` 为 `<commitSeq>:<frameIndex>` 帧级游标）、`GET /v1/runs/:runId/stream`（后台执行观察流，`runId` = Durable task id）。新增稳定错误码：`TOO_MANY_STREAMS`(503)、`RUN_NOT_FOUND`(404)、`OBSERVATION_TIMEOUT`(503)、`OBSERVATION_RESYNC_REQUIRED`(503)、`RUN_FAILED`（**仅作为 SSE `RUN_ERROR.code`**，不参与 HTTP 错误信封，故不在 `STATUS_BY_CODE` 注册）、`CHAT_NOT_FOUND`(404)。

## 4. 已知边界与未验证

- **`GET /v1/state` 在持续写入时可能返回 503 `OBSERVATION_RESYNC_REQUIRED`**：读模型要求一次快照的多 family 扫描期间没有并发提交，否则整轮重扫（最多 4 轮）；仍不一致时显式失败，而不是返回一个混合了不同时间点的旧快照。这是刻意的正确性取舍，运维不应把它当成服务故障——客户端重试即可。

- `/health` 的 404/405 错误体现在也走统一信封（相对旧裸 `{code}` 是形状变化）；Node `clientError` 级别错误可能没有信封。
- 未验证：跨进程并发压测、HTTPS 终止/反向代理、限流与审计留存、真实模型或外部 adapter 组合下的端到端（HTTP 层不调用模型；未绑定 provider 时 `send` 映射 503）。
