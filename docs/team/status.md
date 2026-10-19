# Agent Team 状态

> 2026-10-19。每个闸门/工作包更新一次；与 [Agent Team 方案](agent-team.md)、[验证状态](../design/verification-status.md) 配套。

## 当前状态

| 项 | 状态 |
|---|---|
| 分支 | `wp/2-real-adapters` |
| G1 | 已通过（WP1a + WP1b 五片 + WP2 contract/memory 出口） |
| WP2 Durable persistence | **完成**：`Runtime.resources` 默认真实 Durable store，官方 176/176 |
| WP2 real adapters | **完成安全闸门**：18/18 adversarial、服务端 261/261、独立 final3 评审通过；真实 Steel/RTC/provider 仍未验证 |
| Lead | lead |
| 实现 | resource-impl（Durable store已完成，下一片负责P0/adapter） |
| 测试 | senior-tester（resource-durable 14/14 官方） |
| 审计 | code-auditor（P0-1..8 安全审计已完成） |

## Durable persistence 验收

- `npm run build` exit 0
- targeted `resource-durable.test.js` 14/14
- 全量 `npm test` 176/176（服务端 166 + scripts 10）
- `tsc --noEmit`、架构边界通过
- close/reopen 保留 lease/operation/receipt/index/unknown
- CAS 回滚无 phantom doc；commit 内 snapshot=0；未来版本拒绝；SIGKILL attempting/intent 两窗口不重放

证据：[WP2 Durable resource](../../infra/pi-durable-validation/evidence/wp2-durable-resource-final.json) · 设计：[真实 Adapter 契约](../design/resource-adapters.md)

## P0 安全契约（下一片必须先完成）

1. operation effect payload/kind/payloadHash 绑定；
2. owner + lease expiry + controlEpoch dispatch fence；
3. attempt token/worker TTL，禁止并发 attempting 误核销；
4. observer identity + payloadHash + 结构化 evidence 核销 unknown；
5. 文件 symlink/TOCTOU 硬化；
6. HTTP status 分类、凭据/redirect/timeout 规则、结构化回执；
7. result/observation schema、大小上限与 redaction；
8. AbortSignal/deadline/close 取消语义。

## WP2 真实 adapter 最终 gate（2026-10-19）

- 根目录 `npm run check`、`npm test`：**261/261**；`scripts/*.test.mjs` 10/10；OpenSpec strict 通过。
- `resource-adapter-integration`：**18/18**；原型 `POINT_CRASH_ROUNDS=1 npm test`：28/28；边界检查通过。
- 安全评审：[final3](reviews/wp2-real-adapters-final3.md) 已批准；追加证据：[wp2-real-adapters-final](../../infra/pi-durable-validation/evidence/wp2-real-adapters-final-2026-10-19T05-25-00Z.json)。
- 组合根仅显式注入 adapter effects；`unknown` 不自动重放。真实 Steel/CDP、RTC/viewer、多会话、旧库迁移、长跑/容量、真实 HTTP 查询核销与 artifact sink 集成仍未验证。
