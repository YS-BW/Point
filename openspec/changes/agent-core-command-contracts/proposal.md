# Proposal

## Why

用户要求从工程角度重建正式 Agent 核心。原型验证功能可行性，但按请求键返回旧结果而不校验内容、集中可变状态和测试钩子不应成为正式契约。

## What Changes

- 将 WP1b 从源码迁移改为逐条业务链路重建；保留原型作为行为与失败案例参考。
- 本次完成第一片：创建独立对话的应用端口、参数规则、Durable 原子写入及持久幂等收据。
- 同键同内容返回首次结果，同键不同内容明确冲突；失败不留下半个对话。
- 后续分别重建消息受理与模型执行、Job/Attempt、计划与投递，不以旧测试数量定义完成。

## Capabilities

### New Capabilities

- `conversation-commands`: 创建对话的输入、幂等性和原子持久化契约。

### Modified Capabilities

无。

## Impact

串行修改 apps/server、docs/design、AGENTS.md、OpenSpec 和新增验收证据。使用已有 Durable 1.3.0，不引入依赖，不修改原型、浏览器、HTTP 或真实数据。应用端口先独立验收，公开协议由 WP4 定义。
