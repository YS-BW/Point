# Agent Team 状态

> 2026-10-19。每个闸门/工作包更新一次；与 [Agent Team 方案](agent-team.md)、[验证状态](../design/verification-status.md) 配套。

## 当前工作包

| 项 | 状态 |
|---|---|
| 分支 | `wp/1b-plan-delivery` |
| WP | WP1b.4：单次计划、判断、会话投递与通知端口 |
| 闸门 | **G1 骨架就绪：通过**（WP1a + WP1b.1/2a/2b/3/4 + WP2） |
| Lead | lead |
| 实现 | job-impl（schedule/decision/followup）、resource-impl（delivery/notification） |
| 测试 | senior-tester（schedule/delivery/notification + followup-crash） |
| 审计 | code-auditor（B1 非 ready 伪报完成、P1 多 schedule 绕过上限、T1–T3） |
| 平台 | boundary-impl（AST 不变量） |

## 角色与写作用域

| 角色 | 写作用域 | 状态 |
|---|---|---|
| Lead | docs/design、verification-status、evidence、commit/tag | 收尾 |
| job-impl | `domain/schedule.ts`、`storage/schedule.ts`、`application/schedule.ts`、`runtime/schedules.ts`、`runtime/open.ts` | 完成 |
| resource-impl | `domain/delivery.ts`、`storage/delivery.ts`、`application/delivery.ts`、`runtime/deliveries.ts`、`adapters/notification/memory.ts` | 完成 |
| senior-tester | `test/{schedule,delivery,notification}.test.ts`、`fixtures/followup-crash.ts` | 完成 |
| code-auditor | `docs/team/reviews/` | 通过（无未解决 blocker） |
| boundary-impl | `scripts/check-boundaries.mjs`、`scripts/boundaries.test.mjs` | 完成 |

## 闸门

| 命令 | 结果 |
|---|---|
| `npm run check` | 通过（tsc --noEmit + Architecture boundaries passed） |
| `npm test` | **162/162 pass**（服务端 152 = 既有 117 + 新增 35；scripts 10） |
| targeted `schedule/delivery/notification` | **35/35 pass** |
| `npm run build` | exit 0 |
| 原型 `POINT_CRASH_ROUNDS=1 npm test` | **28/28 pass** |
| OpenSpec `agent-plan-delivery` strict | valid |
| 独立评审 | 通过；B1/P1/T1–T3 已修复并复核，P2–P6 文档化 |
| **G1 骨架就绪** | **通过**（证据 `g1-foundation-2026-10-19T02-28-22Z.json`） |

证据：[verification-status](../design/verification-status.md#g1-骨架就绪验收2026-10-19) · [G1 evidence](../../infra/pi-durable-validation/evidence/g1-foundation-2026-10-19T02-28-22Z.json) · [评审](../team/reviews/wp1b-4-plan-delivery.md)。

## 未决 / 下一步

- G1 通过；下一阶段按 roadmap：WP2 真实资源适配/持久化、WP3 状态 v2 迁移、WP4 API（G2）。
- 未验证：真实模型质量、真实通知渠道、真实浏览器/外部工具、HTTP/AG-UI、Docker、长跑/多进程、旧库迁移。
- 浏览器按冻结规则不动。
