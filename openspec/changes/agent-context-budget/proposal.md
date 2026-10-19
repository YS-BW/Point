## Why

WP1b.1/2a 已能对话，但模型上下文仍只有原始历史：没有产品注入的人格/会话身份、没有显式个性化，也没有受保护的压缩路径。外部 `USER.md` 若直接可写会形成第二权威。本片建立 sections、显式 Profile 导出边界和受模型 dispatch 保护的压缩。

## What Changes

- 新增 `point.profile` Durable 文档与 `remember/forget/list/exportMarkdown` 命令；USER.md 只做只读导出，不监听文件。
- 新增 `point.context` extension：identity、chat、profile 三个 section，带 8000 字符预算与截断。
- 新增 `conversation.compact` 命令：收据 + command task 单 commit，status/wait 映射内层 compaction task。
- 扩展 `model-guard`：CompactionTask permit 与 `completeSimple` 包装，压缩模型请求同样 intent-before-effect、unknown 不重放；无 permit fail-closed。
- 启用受控 compaction settings；离线测试只用手动压缩与脚本供应商。

## Capabilities

### New Capabilities
- `context-budget`: 显式 Profile、上下文 sections 预算、USER.md 导出边界与受保护压缩。

### Modified Capabilities
无。

## Impact

只改 apps/server 的 domain/storage/application/runtime 与测试、文档/证据；不改 api/bootstrap/config，不接 HTTP，不新增真实文件写入，不做自动记忆抽取或 USER.md 导入。无 Durable schema 迁移，新增文档族按需创建。
