# 评审检查清单（WP 通用）

> 2026-10-19。由 [Agent Team 方案](agent-team.md) §5.2 落地。REVIEWER 每次评审逐条勾选；作者不能自审。

## 通用十条

1. **事务边界**：同一业务结果的多条记录是否在一次 commit 内？跨模块事务是否有唯一 owner？
2. **幂等**：每个写操作是否有 `requestId`/幂等键？同键同参与同键异参是否都验证？
3. **副作用三态**：外部动作是否先记 intent 再执行？`done/unknown/failed` 是否齐全？`unknown` 是否禁止自动重放、只能 observe/reconcile？
4. **状态与迁移**：新增/修改状态字段是否有版本、迁移/回滚路径或明确“仅内存/仅测试”？
5. **依赖方向**：domain 是否仍不依赖具体实现？application 是否平台/SDK 无关？adapter 是否只做执行/观察？
6. **错误契约**：错误是否分类为稳定 code？是否映射到后续 API 错误码？有没有把未知结果伪装成成功？
7. **测试**：新增/修改路径是否有对应测试（正常/非法/并发/故障注入）？测试是否断言行为而非实现细节？失败能否独立复现？
8. **文档与证据**：`docs/design`、`verification-status`、evidence/manifest 是否同步？未验证项是否显式写出？
9. **性能敏感路径**：snapshot/SSE/迁移/长历史是否有规模或耗时断言？
10. **写作用域**：PR 是否只动了本 WP 允许的路径？是否越界改 storage/runtime/api/open 或别人 lane？

## WP2 资源边界附加

- [ ] `domain/resource.ts` 无 `node:`、`@earendil-works`、adapter 导入，且不定义 Durable task。
- [ ] 有效租约、过期、takeover、release 的 epoch 转移与 `assertControl` 一致。
- [ ] `unknown` 不能回到 `attempting`；`attempting` 恢复先转 `unknown` 且不调用 effect。
- [ ] 同键同参 effect 只执行一次；同键异参 `IDEMPOTENCY_CONFLICT`。
- [ ] 内存 store 的 commit 先校验全部 CAS 再落盘，失败不留下半状态。
- [ ] 测试覆盖并发 acquire/beginOperation，不仅覆盖串行 happy path。
- [ ] 文档明确“内存适配器仅测试、无持久化/崩溃恢复/HTTP 映射”。

## 结论格式

- 结论：通过 / 需修改 / 阻塞
- blocker：逐条列出（文件:行 + 复现/理由）
- 实质意见：至少一条（不能只写 LGTM）
- 非阻塞建议：可转 issue / deferred，不得静默忽略
