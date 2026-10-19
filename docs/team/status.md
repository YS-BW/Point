# Agent Team 状态

> 2026-10-19。每个闸门/工作包更新一次；与 [Agent Team 方案](agent-team.md)、[验证状态](../design/verification-status.md) 配套。

## 当前工作包

| 项 | 状态 |
|---|---|
| 分支 | `wp/1b-jobs-artifacts` |
| WP | WP1b.3：Job/Attempt 身份、工具与产物 |
| Lead | lead |
| 实现 | job-impl（Job/Attempt/attempt task/open 装配）；resource-impl（artifact/工具） |
| 测试 | senior-tester（job/artifact/crash fixtures） |
| 审计 | code-auditor（B1 artifact crash fixture、P1 收据键、P2 cancel 语义、P3 同名路径） |
| 平台 | boundary-impl（AST 不变量；本片无新增） |

## 角色与写作用域

| 角色 | 写作用域 | 状态 |
|---|---|---|
| Lead | docs/design、verification-status、evidence、commit | 收尾 |
| job-impl | `apps/server/src/{domain,storage,application}/job.ts`、`runtime/jobs.ts`、`runtime/open.ts` | 完成 |
| resource-impl | `apps/server/src/{domain,storage,application}/artifact.ts`、`runtime/artifacts.ts`、`runtime/tools.ts` | 完成 |
| senior-tester | `apps/server/test/{job,artifact}.test.ts`、`fixtures/{job,artifact}-crash.ts` | 完成 |
| code-auditor | `docs/team/reviews/` | 通过（无未解决 blocker） |
| boundary-impl | `scripts/check-boundaries.mjs`、`scripts/boundaries.test.mjs` | 完成（本片无改动） |

## 闸门

| 命令 | 结果 |
|---|---|
| `npm run check` | 通过（tsc --noEmit + Architecture boundaries passed） |
| `npm test` | **127/127 pass**（服务端 117 = 既有 92 + 新增 25；scripts 10） |
| targeted `job/artifact` | **25/25 pass** |
| `npm run build` | exit 0 |
| 原型 `POINT_CRASH_ROUNDS=1 npm test` | **28/28 pass** |
| OpenSpec `agent-jobs-artifacts` strict | valid |
| 独立评审 | 通过；B1/P1/P2/P3 已修复并复核，P4/P5/P6 文档化 |

证据：[verification-status](../design/verification-status.md#wp1b3-jobattempt工具与产物2026-10-19) · [评审](../team/reviews/wp1b-3-jobs-artifacts.md)。

## 未决 / 下一步

- WP1b.3 已完成；WP1b.4（单次计划、判断、会话投递与通知端口）尚未开始，G1 未通过。
- WP1b.3 未验证：真实模型质量、真实外部工具/浏览器、HTTP/Docker/旧库迁移；artifact 文件与 Durable 文档非同一事务，其余崩溃窗口未单独 fixture；cancel 不 abort execution conversation（P5）；`ArtifactState.unknown` 未产生（P6）；无长跑/性能。
- 浏览器按冻结规则不动；不启动第二条 lane。
