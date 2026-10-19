# WP4 `/v1` API 契约独立代码审计

> 2026-10-19。对象：main HEAD `7fd0a44`（实现 `023b352` + OpenSpec `7fd0a44`，已快进合并；基线 `a261216`）。
> 评审人：code-auditor。范围：只读代码审计；动态验证由 senior-tester 的 task-47（18/18）负责，本审阅复核其结论并独立运行契约测试。仅写本文件，未改源码/测试。
> 结论：**通过（无 blocker）**；非阻塞项见 §4，均不改变安全/契约放行。

## 1. 验证

| 项目 | 结果 |
|---|---|
| `npx tsc -p apps/server/tsconfig.json --outDir /tmp/point-wp4` | BUILD_OK |
| `node --test /tmp/point-wp4/test/api-v1.test.js` | **13/13 pass** |
| 服务端全量隔离构建 | **264/264 pass** |
| `scripts/*.test.mjs` | 10/10 pass |
| `tsc --noEmit` / `check-boundaries.mjs` | exit 0 / passed |
| task-47（senior-tester 动态验证，lead 报告） | 18/18 通过；本次重点为代码审计 |

## 2. 审计重点逐条

### 2.1 handler 不复制业务规则（通过）

- `api/routes.ts` 每个 handler 只做：读 body / 查 query / 绑定路径参数 → 调 application command → 返结果；无状态转移、无领域校验。`api/http.ts` 只做路由/鉴权/限流/错误映射/日志。
- 输入绑定：`writeInput` 强制 `Idempotency-Key`→`requestId`、拒绝 body 覆盖 `requestId` 与路径绑定字段（`routes.ts:50-68`）；历史 `limit` 的 1..100 属于传输契约，application 仍有自己的校验。
- 路由表显式、无自动扫描；未匹配 404、方法不符 405+`Allow`（`http.ts:78-105`）。
- scope 干净：`git diff --stat a261216..HEAD` 仅 `api/**`、`bootstrap.ts`、`config.ts`、README、tests、OpenSpec；未改 domain/application/storage/runtime（业务规则未动）。

### 2.2 错误信封覆盖与不泄漏（通过）

- 统一信封 `{error:{code,message,requestId}}`（`errors.ts`）；所有程序路径抛错由 `createServer` 的 `handle(...).catch` 统一 `mapError`（`http.ts:177-190`）：health/route/auth/body/domain 异常均落入；500 固定 `internal error`，不附 stack/path/原文（`errors.ts:80-92`；测试 `api-v1.test.ts:250-279` 抛 `provider stack /Users/secret token=abc`，断言 500 固定且不含敏感片段）。
- 4xx/409 使用冻结 `STATUS_BY_CODE`；未知 code 回退 INTERNAL_ERROR 500；`*_NOT_FOUND`/`INVALID_` 后缀规则稳定。
- 头部/日志不泄漏：响应仅 `X-Request-Id` 与稳定 JSON；访问日志白名单字段（`http.ts:182-190`；测试 `:281-305` 断言 token/body 不出现）。

### 2.3 Idempotency-Key→requestId，且无响应缓存（通过）

- `routes.ts:54-68`：写操作必须 header；body 禁止自带 `requestId`；生成的 command input 由 header 覆盖。无 HTTP 级响应缓存；重放等价来自 Durable 收据（`api/http.ts:1-8` 注释、`routes.ts` handler 直接返回 command 结果）。
- 契约测试：fake runtime 重放逐字节相等/异 payload 409（`api-v1.test.ts:213-249`）；**真实 runtime** 经 `startServer` 重放逐字节相等（`:393-421`），证明不是第二份事实。
- 唯一非阻塞差异：实现 key 正则 `1..128`（`routes.ts:46`），design 写“≥8 字符”（`openspec/.../design.md:26`）——见 §4.1。

### 2.4 鉴权 fail-closed + 常量时间（通过）

- 未配置 `POINT_API_TOKEN`：`/v1` 所有已解析路由 503 `API_NOT_CONFIGURED`，health 保持开放（`http.ts:149-155`；测试 `:167-176`）；`/inspect` 同时受开关与 token 双重门控（`http.ts:120-140`）。
- 配置后：`Authorization: Bearer <token>` 精确匹配，长度相等后 `timingSafeEqual`（`http.ts:46-51`）；测试覆盖缺失/错误/小写 bearer（`:177-190`），且断言拒绝请求不执行 command。
- token 只从 `POINT_API_TOKEN` 读取并校验（`config.ts`），错误不打印值；无日志泄露。

### 2.5 1 MiB 上限与日志脱敏真实（通过）

- `json.ts`：先查 `Content-Length`，流式读取并在超限瞬间 413，暂停/断开而不全量缓冲；`Content-Type` 必须 application/json；非法 JSON/非对象 400。测试构造 1 MiB+10 body 得 413 且无 write（`api-v1.test.ts:193-212`）。
- 日志：仅 `at/event/requestId/method/path/status/durationMs/bytesIn`，path 去掉 query，绝不记录 header/body/token（`http.ts:182-190`；测试 `:281-305`）。

### 2.6 `/inspect` 默认关闭（通过）

- `HttpOptions.inspect` 默认未设置 → `!== true` → 404，且在鉴权前返回（不可区分存在性，`http.ts:120-127`）；`config.apiInspect` 默认 false，仅 `POINT_API_INSPECT=1` 开启（`config.ts`）。测试 `:359-377`。

### 2.7 `/health` 向后兼容（通过；附小注）

- 旧实现（`a261216:apps/server/src/api/http.ts`）返回 `JSON.stringify(status)`，字段 `phase/capabilities`；新实现同样返回 `health.status()`，仅排序键序并新增 `X-Request-Id` 响应头（`http.ts:108-117`）。200 body 字段未删未改；status 码逻辑（live: not stopped/failed；ready: phase==='ready'）与旧一致；`/health/*` 仍不鉴权（测试 `:147-151`、`:421`）。
- 小注：旧实现的 405/404 错误体是 `{code}`，新实现走统一错误信封；若把“health 行为”理解为包含错误响应形状，则这是格式变化（非成功字段删除）。非阻塞，记录见 §4.3。

## 3. 测试真实性

- 13 项契约测试覆盖：路由/方法/Allow、信封+requestId、auth 矩阵、body/Content-Type/1MiB、Idempotency-Key 必填/覆盖拒绝/映射、重放逐字节/冲突 409、错误映射（400/404/409/500/503）与 500 脱敏、日志白名单、全路由表转发、`/inspect` 双重门控、config 校验、**真实 runtime** 重放。
- 路由表测试（`api-v1.test.ts:306-357`）断言每个路由调用对应 application command（fake command 记录），能证明“薄适配、无第二套规则”；真实 runtime 仅覆盖 chat 创建/读取，其他路由的端到端语义由 application 既有测试保证。
- 未覆盖（非阻塞）：malformed HTTP（Node `clientError`）未进入信封；空 body 且无 Content-Type 时会先返回 `{}` 再被 command 拒绝（不执行写）；`/health` 旧 405 形状兼容性未断言。

## 4. 非阻塞项

1. **Idempotency-Key 长度下限不一致**：`routes.ts:46` 接受 1..128；`design.md:26` 要求 ≥8。建议统一为“≥8 且 ≤128”并补低于 8 的 400 回归（当前虽不破坏幂等语义，但弱化碰撞抗性，且与契约文案不符）。
2. **`/inspect` 缺少“计数”**：`design.md:30`/`tasks.md:2.5` 要求“计数+版本”；实现返回 `{version,instanceId,phase,capabilities}`（`http.ts:136-140`），无 counts。建议补只读计数（或把契约/任务改为“版本+instance+phase/capabilities”并说明不含业务计数）。
3. **health 405/404 错误体形状变化**：成功字段兼容；错误体由旧 `{code}` 变为统一信封。若外部有依赖，需在 README/契约注明；否则仅记录。
4. **OpenSpec tasks/证据未同步**：`openspec/changes/api-v1-contract/tasks.md` 全部 checkbox 未勾选；README 已更新（`apps/server/README.md` +72），但 verification-status/evidence 尚未记录 task-47 与本次审计。属 WP4 gate 收尾，不是代码缺陷。
5. **malformed HTTP 无信封**：Node `clientError` 默认响应不在统一信封内；如要求“所有失败”包括协议级错误，需要补 `server.on('clientError')`；当前契约测试未覆盖。
6. **空 body 的 Content-Type 检查顺序**：`readJsonObject` 在空 body 时先返回 `{}` 再做 Content-Type 判断（`json.ts:45-48`）；不会执行写（command 会拒），但与“必须 application/json”文案有细微出入。
7. **auth 常量时间**：长度比较先短路，理论上泄露 token 长度信息（非内容）；标准做法，记录即可。
8. **健康/日志无敏感数据**已验证；`/inspect` 返回 `instanceId` 属运维信息，默认关闭+鉴权下可接受。

## 5. 未验证 / 边界

- 仅 loopback HTTP（`config.host` 限制）；未验证 TLS/反向代理、限流、多租户/OAuth（WP4 non-goals）。
- 路由表对 application 的“薄”性由 fake command 测试覆盖；真实 runtime 仅覆盖 chat 创建/读取与 replay，其余路由依赖既有 application 测试。
- 未验证大并发/慢客户端/连接数、access log 落盘轮转、AG-UI/SSE（WP5）。
- task-47 的 18/18 动态结果为 lead/tester 报告；本审计独立复跑 13/13 API + 264/264 server + scripts/tsc/boundaries。

## 6. 结论

**通过（无 blocker）。** 代码满足 WP4 契约的关键安全点：薄 handler、统一且不泄漏的错误信封、Idempotency-Key→requestId 且无响应缓存、fail-closed 常量时间鉴权、真实 1 MiB 限制与脱敏日志、`/inspect` 默认关闭、`/health` 成功行为向后兼容。§4 非阻塞项建议在 WP4 gate 文档/后续小修中处理（尤其 Idempotency-Key ≥8 与 `/inspect` counts 的契约对齐）。
