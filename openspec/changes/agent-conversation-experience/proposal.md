## Why

用户要求从 Muse 的真实产品场景验收 Agent 体验。已有对话创建不足以验证交谈、补充要求、停止、返回与恢复。本次建立对话执行的第一组场景，而非宣称完整 Muse 已复刻。

## What Changes

- WP1b.2a：自然语言消息受理、忙时排队、停止及继续、历史读取与断线后查询。
- 使用原生 Durable loop/inbox；模型调用在实际 dispatch 前记录意图，未知结果不重放。
- 建立固定 NanoMuse 源码到产品场景的映射。测试替身仅控制供应商时序，不替代真实模型质量评测。
- WP1b.2b 继续上下文预算、USER.md 与压缩；后台任务和主动行为按已有后续包推进。

## Capabilities

### New Capabilities
- `conversation-execution`: 对话发送、排队、停止、恢复和失败的用户可见结果。

### Modified Capabilities
无。

## Impact

串行 apps/server、docs/design、OpenSpec、AGENTS 与新增 evidence。原型与浏览器不动；无新引擎、无外部真实数据迁移。公开 HTTP/AG-UI 仍在后续工作包。
