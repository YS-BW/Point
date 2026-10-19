# Agent Team 状态

> 2026-10-19。每个闸门/工作包更新一次；与 [Agent Team 方案](agent-team.md)、[验证状态](../design/verification-status.md) 配套。

## 当前工作包

| 项 | 状态 |
|---|---|
| 分支 | `wp/2-agent-resource-infra` |
| WP | WP2 资源边界契约与内存桩（前置片；非完整 WP2/G1） |
| Lead | lead |
| 实现 | resource-impl（domain/application/memory） |
| 测试 | senior-tester（resource.test.ts / resource-operations.test.ts） |
| 审计 | code-auditor（独立评审，发现并复核 CAS guard blocker） |
| 平台 | boundary-impl（domain/application 不得定义 Durable task 的 AST 检查） |

## 角色与写作用域

| 角色 | 写作用域 | 状态 |
|---|---|---|
| Lead | docs/design、verification-status、evidence、commit | 收尾 |
| resource-impl | `apps/server/src/domain/resource.ts`、`application/resource.ts`、`adapters/resource/memory.ts` | 完成 |
| senior-tester | `apps/server/test/resource*.test.ts` | 完成 |
| code-auditor | `docs/team/reviews/` | 通过（无 blocker） |
| boundary-impl | `scripts/check-boundaries.mjs`、`scripts/boundaries.test.mjs` | 完成 |

## 闸门

| 命令 | 结果 |
|---|---|
| `npm run check` | 通过（tsc --noEmit + Architecture boundaries passed） |
| `npm test` | **84/84 pass**（服务端既有 33 + resource 41 + boundary 10） |
| `node --test apps/server/dist/test/resource*.test.js` | **41/41 pass** |
| `npm run build` | exit 0 |
| 原型 `POINT_CRASH_ROUNDS=1 npm test` | **28/28 pass** |
| OpenSpec `agent-resource-boundary` strict | valid |
| 独立评审 | 通过；B1 已修复并复核 |

证据：[verification-status](../design/verification-status.md#wp2-资源边界基建2026-10-19) · [评审](../team/reviews/wp2-resource-boundary.md)。

## 未决 / 下一步

- WP2 真实资源 adapter、Durable 持久化/迁移、组合根接线、HTTP 错误码映射仍未做；G1 仍需 WP1b.2b/3/4 + WP2 完整片。
- 下一片：WP1b.2b（上下文 sections / USER.md / 压缩），再 WP1b.3/4。
- 浏览器按冻结规则不动；不启动第二条 lane。
