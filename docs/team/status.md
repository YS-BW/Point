# Agent Team 状态

> 2026-10-19。每个闸门/工作包更新一次；与 [Agent Team 方案](agent-team.md)、[验证状态](../design/verification-status.md) 配套。

## 当前状态

| 项 | 状态 |
|---|---|
| 分支 | `wp/2-real-adapters` |
| G1 | 已通过（WP1a + WP1b 五片 + WP2 contract/memory 出口） |
| WP2 Durable persistence | **完成**：`Runtime.resources` 默认真实 Durable store，官方 176/176 |
| WP2 real adapters | **Ready/blocked by P0 contract**：code-auditor 提出 8 项安全缺口，先定契约再接文件/HTTP/CDP |
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

真实 adapter 在 P0 契约与回归测试通过前不接生产端点；浏览器只做 loopback CDP adapter，不接 RTC/viewer/Steel 默认端点。
