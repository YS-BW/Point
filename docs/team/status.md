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

## WP3 state v2 + WP4 API v1（2026-10-19）

- 两个工作包在独立分支/worktree 并行完成：`wp/3-state-v2`（`406ed62`）、`wp/4-api-v1`（`18aefa9`），分别经独立动态验证（WP3 21/21、WP4 18/18+守卫矩阵）与独立代码审计（WP4 无 blocker；WP3 1 blocker 修复后复验）后合并进 main。
- 根目录 `npm run check`、`npm test`：**302/302**；原型 `POINT_CRASH_ROUNDS=1 npm test`：28/28；两个 OpenSpec change strict 通过。
- 审计/验证关闭的 blocker：profile 上限并发越界、迁移 engine 误报 already-migrated、cleanup 保护 TOCTOU、cleanup dryRun 预览不准确。
- **闸门未过**：G2 需 WP4+WP5，G3 需 WP3+WP6；本轮只完成 WP3/WP4 工作包本身。
- 未验证项（迁移与清扫、HTTP 层）见 [verification-status](../design/verification-status.md) 对应段落；证据：[wp3-wp4-gate](../../infra/pi-durable-validation/evidence/wp3-wp4-gate-2026-10-19T06-49-53Z.json)。

## WP5 AG-UI 投影与 G2（2026-10-19）

- `wp/5-agui-projection`（`b5e1211`）经两轮独立验证（10/10、15/15）与两轮审计（各 1 blocker，修复后终审通过）合并进 main。
- 根目录 `npm run check`、`npm test`：**316/316**；原型 28/28；`agent-agui-projection` OpenSpec strict 通过。
- **G2（契约就绪）宣布通过**：REST（WP4 15/15）+ AG-UI（13/13）契约测试通过，参考 CLI 消费新协议。口径注意：此前无产品 CLI 可切换，原型 CLI 未替换。
- 下一个闸门 G3 = WP3 + WP6（读模型 + 增量事件/线程流/`Last-Event-ID`/运行流），WP6 已解锁。
- 证据：[wp5-agui-g2](../../infra/pi-durable-validation/evidence/wp5-agui-g2-2026-10-19T07-22-51Z.json)。

## WP5 官方 SDK 纠偏与 CLI 移除（2026-10-19）

- Codex 提交的官方 SDK 纠偏经 Lead 复核后收拢到 `fix/wp5-agui-sdk-compliance`（`fef0c34` 纠偏 + `bc17c6f` 移除 CLI），并通过独立验证（官方 `@ag-ui/client` HttpAgent，8/8）与独立审计（PASS，无 blocker）。
- 用户决定：**接受官方依赖**（`@ag-ui/core|encoder@1.0.3` + `zod@3.25.76`，`@ag-ui/client` 转 devDependency 供契约测试）；**删除参考 CLI，产品改 Web-first**。G2 判据相应改为“REST 与 AG-UI 契约测试通过 + 官方 client 在契约测试中消费”，首个真实客户端是 WP13。
- 契约修正：`RUN_FINISHED.outcome={type}`、标准 `usage` 不再发送（无法归属单次运行）、run 末有界 `MESSAGES_SNAPSHOT`、`OBSERVATION_*` 只停观察不代表失败；修复 413 socket 重置、重复 END、监听泄漏。
- 数字：`npm run check` pass；`npm test` **325/325**；agui **22/22**；原型 **28/28**；openspec strict 通过。证据：[WP5 SDK 纠偏](../../infra/pi-durable-validation/evidence/wp5-sdk-correction-2026-10-19T07-50-28Z.json)。
