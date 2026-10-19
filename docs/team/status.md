# Agent Team 状态

> 2026-10-19。每个闸门/工作包更新一次；与 [Agent Team 方案](agent-team.md)、[验证状态](../design/verification-status.md) 配套。

## 当前工作包

| 项 | 状态 |
|---|---|
| 分支 | `wp/1b-context-budget` |
| WP | WP1b.2b：上下文 sections、显式 Profile/USER.md 导出、受保护压缩 |
| Lead | lead |
| 实现 | context-impl（domain/storage/application/runtime profile、context、guard、compact） |
| 测试 | senior-tester（profile/context-budget/compaction） |
| 审计 | code-auditor（B1 non-new 不重放测试、P1 compact 收据 key） |
| 平台 | boundary-impl（此前 WP2 的 AST 不变量检查） |

## 角色与写作用域

| 角色 | 写作用域 | 状态 |
|---|---|---|
| Lead | docs/design、verification-status、evidence、commit | 收尾 |
| context-impl | `apps/server/src/{domain,storage,application,runtime}/profile.ts`、`runtime/context.ts`、`runtime/{model-guard,conversation,open}.ts`、`application/conversation.ts`、`storage/conversation.ts` | 完成 |
| senior-tester | `apps/server/test/{profile,context-budget,compaction}.test.ts` | 完成 |
| code-auditor | `docs/team/reviews/` | 通过（无未解决 blocker） |
| boundary-impl | `scripts/check-boundaries.mjs`、`scripts/boundaries.test.mjs` | 完成 |

## 闸门

| 命令 | 结果 |
|---|---|
| `npm run check` | 通过（tsc --noEmit + Architecture boundaries passed） |
| `npm test` | **102/102 pass**（服务端 92 = 既有 74 + 新增 18；scripts 10） |
| targeted `profile/context-budget/compaction` | **18/18 pass** |
| `npm run build` | exit 0 |
| 原型 `POINT_CRASH_ROUNDS=1 npm test` | **28/28 pass** |
| OpenSpec `agent-context-budget` strict | valid |
| 独立评审 | 通过；B1/P1 已修复并复核 |

证据：[verification-status](../design/verification-status.md#wp1b2b-上下文profile受保护压缩2026-10-19) · [评审](../team/reviews/wp1b-2b-context.md)。

## 未决 / 下一步

- WP1b.2b 已完成；WP1b.3（Job/Attempt、工具与产物）尚未开始，WP1b.4 与 G1 仍未完成。
- 2b 未验证：自动阈值压缩长跑/真实模型质量、USER.md 真实导入/监听、HTTP、进程级 SIGKILL summarize 恢复（ModelCalls 可能停留 attempting）、internal fallback/provider error/取消派发未入库测试。
- 浏览器按冻结规则不动；不启动第二条 lane。
