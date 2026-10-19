## Context

WP1b.2a 的对话命令已使用原生 Durable loop；上下文仍由 SDK 原始历史投影，没有 Point 的产品 sections，也没有压缩保护。原型在 `service.mjs:609-621` 用 `section('point_memory'/'point_chat'/'point')` 注入记忆/会话/人格，在 `compactChat` 调用原生 `Conversation.compact`。正式实现需要把这些能力放入分层与契约，而不是复制原型 god module。

## Goals / Non-Goals

目标：显式 Profile 唯一权威；USER.md 只读导出；sections 有预算与截断；手动压缩可幂等受理/查询/等待；压缩模型调用与生成调用共用同一层 intent-before-effect 保护；既有对话/资源测试不回归。

非目标：自动记忆抽取、向量检索、USER.md 文件监听/双向同步、真实模型压缩质量、自动压缩长跑阈值、工具/后台任务/投递（WP1b.3/4）、HTTP。

## Decisions

- `point.profile` 单文档存 entries map（format 1）；`point.command.profile` 收据族按 requestId 幂等。remember 的“条目 + 收据”必须单 commit；forget 删除条目与收据单 commit；64 条上限在 domain 拒绝。
- USER.md 是 `exportMarkdown` 的纯函数结果，服务端不写文件、不监听；导入留 WP15，避免双权威。
- sections 由 `point.context` extension 提供；chat section 按 conversationId 读 `point.chat`；profile section 按 key 排序、单值 500 字符、总预算 8000，超出截断并标注；空 profile 省略。
- compact 用 `point.conversation.compact` command task + 收据；command task 只负责受理原生 compaction，命令完成不等于压缩完成。status/wait 通过内层 task 投影，读查询不触发执行。
- model-guard 增加 CompactionTask.beforeCompact permit；`completeSimple` 用 `ProviderDoc.sessionId` 与 options.sessionId 唯一匹配 permit，再按 ModelCalls 记录 new→attempting→done/unknown/failed。无 permit 或匹配不唯一 fail-closed；恢复时没有 live permit 不允许重放。
- compaction settings 启用但 backgroundTokens=0；本片只验证手动压缩，自动阈值/长跑另列未验证项。

## Risks / Trade-offs

压缩模型调用没有 taskId 参数，只能用 sessionId 反向匹配 permit；多个并发压缩若 sessionId 相同（不应发生）会 fail-closed。恢复后 summarize 阶段无 permit 会失败，这是保守行为，不自动重放。Profile 单文档有 64 条上限，长期容量需 WP15 重新设计。真实 USER.md 导入/导出文件、真实模型压缩质量未验证。

## Migration Plan

新增 doc kind/version=1，按需创建；不改旧文档格式，不迁移原型库。回滚只需停止使用新命令，旧对话仍可读。真实数据先备份。
