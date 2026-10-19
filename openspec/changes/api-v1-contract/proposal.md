## Why

正式 Server 目前只暴露 `/health/live` 与 `/health/ready`，业务能力没有任何 HTTP 契约：错误只有裸字符串、写操作没有对外幂等键、没有鉴权与访问日志、请求体无上限。roadmap 的 G2 要求先冻结 API 形状与错误码（WP4），WP5 才能在其上做 AG-UI 投影、Web 客户端才有稳定契约。

## What Changes

- 新增 `apps/server/src/api/**` 的 HTTP 层：路由、统一 JSON 错误对象、请求 ID、访问日志、请求体上限（413）、方法/路由拒绝（404/405）。
- 暴露 `/v1` 端点，全部是既有 application commands 的**薄适配**：不新增业务事实、不新增执行引擎、不改变 domain/storage 语义。
- 所有写操作必须携带 `Idempotency-Key`；同一 key + 同一请求重放返回**逐字节相同**的响应（复用既有 Durable 收据，不缓存第二份响应）。
- 鉴权：显式配置 `POINT_API_TOKEN` 后 `/v1` 要求 Bearer；未配置时 `/v1` fail-closed（503），`/health/*` 保持开放。
- `/inspect` 只读诊断端点：默认关闭，需显式开关 + 凭据，只读取 Durable 计数，不写入任何状态。
- 契约测试覆盖 400/404/409/413/503 与重放逐字节相等。

## Capabilities

### New Capabilities
- `api-v1`: 版本化 HTTP 路由、错误信封、幂等键、鉴权、访问日志与门控 inspect。

### Modified Capabilities
无。

## Impact

修改 `apps/server/src/api/**`、`bootstrap.ts` 与 `config.ts`（只新增 token/开关读取），新增测试与文档。不改 `domain/**`、`storage/**`、`runtime/**` 的语义；不引入依赖；不实现 SSE/AG-UI（WP5）与读模型增量事件（WP6）。
