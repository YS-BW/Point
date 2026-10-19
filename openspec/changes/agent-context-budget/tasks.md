## 1. 实现

- [x] 1.1 Profile：domain/storage/application/runtime，remember/forget/list/export，幂等/冲突/64 上限。
- [x] 1.2 Sections：identity/chat/profile，8000 预算与 500 单值截断，空 profile 省略。
- [x] 1.3 压缩命令：admission commit（收据+command task），command task 创建内层 compaction task，status/wait 映射内层 task。
- [x] 1.4 压缩保护：model-guard 支持 CompactionTask permit/completeSimple，fail-closed 与 ModelCalls。
- [x] 1.5 组装：openRuntime 安装 context extension、compaction settings、返回 profile 命令。

## 2. 质量

- [x] 2.1 测试：Profile 显式/幂等/冲突/上限/导出；sections 预算与隔离；压缩历史不变/摘要/保护/重放；B1/P1 回归。
- [x] 2.2 既有 84 项不回归。
- [x] 2.3 独立 reviewer 通过并给出实质意见。

## 3. 验收与文档

- [x] 3.1 `npm run check && npm test` 全绿；原型快速回归通过。
- [x] 3.2 context-budget/verification-status/README/evidence 同步；明确未验证项。
