## Purpose

给模型注入可预算、可审计的产品上下文，并把显式个性化与压缩纳入正式 Agent 层的幂等、恢复和副作用保护，而不是让外部文件或第二个状态库成为权威。

## ADDED Requirements

### Requirement: Explicit profile authority
系统 SHALL 以 Durable `point.profile` 文档作为显式个性化唯一权威；`USER.md` SHALL 只是只读导出结果。只有显式 remember 命令 SHALL 写入条目；系统 SHALL NOT 从对话自动抽取个性化。条目 SHALL 带来源与更新时间；forget 删除条目但 SHALL NOT 改写历史。

#### Scenario: Remember then export
- **WHEN** 用户明确保存一条偏好并请求导出 USER.md
- **THEN** 条目出现在 Durable 文档与导出文本中，服务端不创建或监听 USER.md 文件

#### Scenario: Forget keeps history
- **WHEN** 用户要求忘记一条已保存条目
- **THEN** 条目从后续上下文注入中消失，原会话历史仍可读

### Requirement: Budgeted context sections
系统 SHALL 按 identity、chat、profile 顺序注入 sections；profile SHALL 受总字符预算与单值截断约束，超出时标注截断；空 profile SHALL 省略该 section；chat section SHALL 只反映当前会话。

#### Scenario: Large profile is truncated
- **WHEN** 显式 Profile 超过预算
- **THEN** 模型请求中的 profile section 不超过预算并带截断标记，不把全部条目原样注入

### Requirement: Guarded compaction
系统 SHALL 通过 `conversation.compact` 命令幂等受理手动压缩；命令完成 SHALL NOT 等同于压缩完成。压缩 SHALL NOT 删除或改写原始历史。压缩模型调用 SHALL 先记录 intent 再 dispatch，缺少保护 permit 时 SHALL fail-closed；`unknown` 结果 SHALL NOT 自动重放。

#### Scenario: Compact keeps raw history
- **WHEN** 用户对一段长历史执行手动压缩并等待完成
- **THEN** 摘要进入活动上下文，原始 entries 仍可按历史读取

#### Scenario: Missing compaction permit
- **WHEN** 压缩模型调用没有匹配的 permit
- **THEN** 供应商不被调用，模型调用以固定保护错误失败
