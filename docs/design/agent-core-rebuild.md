# WP1b：正式 Agent 核心工程化重建

用户于 2026-10-19 明确要求重建。WP1a 保留；Durable 1.3.0 仍是唯一引擎。原型提供案例，不提供默认正确的架构或生产保证。

## 原型审计与处理

| 可定位的现状 | 工程风险 | 正式处理 |
|---|---|---|
| `service.mjs:createChat` 的 chatRequests 只有请求键到 chat 的映射 | 同键异参静默返回旧结果；以后重命名还可能改变历史请求响应 | 不可变命令收据，规范化参数比对，冲突明确返回 |
| `service.mjs:updateChat/cancelJob` 无统一请求契约 | 网络重试与并发覆盖语义不一致 | 每个写命令单独定义幂等键、预期 revision 和状态转移 |
| `state.mjs` 与 `conversations.mjs:initializeState` 把多类状态汇入同一文档，用缺省值补字段 | 写入耦合，版本变更难验证 | 按聚合分片；版本明示，拒绝未知版本；旧库升级另包验收 |
| `service.mjs` 同时装配模型、浏览器、工具、业务规则与故障注入 | 单模块承载多职责，离线验证难隔离 | domain/application/runtime/storage/adapters 分层；测试只在宿主装配处注入故障 |
| `server.mjs` 通过完整状态快照提供事件；测试依赖验证服务入口 | 不能直接证明正式协议、重连或规模性能 | 应用契约先独立测试；公开 API/投影按 WP4–WP6 建立 |

以上是源码审计，不是新增运行证据。原型付费模型恢复、修订 fencing、取消竞态与资源回收仍需逐项审计和独立验收，不能由已有 happy path 推导。

## 串行分片与出口

| 分片 | 交付 | 必须验证 |
|---|---|---|
| WP1b.1 已落地 | 创建独立对话、读取、持久幂等收据 | 同键并发、异参冲突、非法输入无写入、事务回滚、提交前/响应前强杀、重启、版本拒绝 |
| WP1b.2a 已落地 | 消息受理、原生 loop、排队、停止和历史查询 | 产品交互、未知调用不重发、停止途中恢复；见 [对话体验与 SDK 复用](conversation-experience.md) |
| WP1b.2b 已落地 | 上下文 sections、显式 Profile/USER.md 导出边界、受保护压缩 | 显式个性化、预算与压缩后恢复、原历史不变、压缩模型请求同样受保护；见 [上下文预算](context-budget.md) |
| WP1b.3 已落地 | Job/Attempt、工具与产物 | 恢复沿用 attempt，新修订新 attempt；revision 拒绝旧结果；取消传播；外部动作三态；产物落盘可核对；见 [Job/Attempt 与产物](jobs-and-artifacts.md) |
| WP1b.4 已落地 | 单次计划、判断、会话投递与通知端口 | 到期重启恢复、错过合并、提醒次数上限、取消/修订竞态、通知失败不伪造成功、重试不重复投递；见 [计划与投递](plan-and-delivery.md) |

后续分片开始前分别准备 Ready、契约和测试矩阵。WP2 负责资源适配公共边界，WP3 负责旧库迁移和升级框架，WP7 做跨分片组合与行为评测；安全性不推迟到 WP7 才补。完整记忆、浏览器功能、Web 和多用户不在本次范围。

## WP1b.1 使用与持久化

通过 `openRuntime(dataDir).chats` 调用 `create({requestId, name})` 与 `get(id)`；调用者必须关闭 runtime。当前 HTTP 保持健康接口，不对外宣称聊天能力已经就绪。独立测试：根目录构建后运行 `node --test apps/server/dist/test/chats.test.js`。

名称 trim 后比较；请求键在创建命令范围内有效，不自动生成或过期。同键异参返回 `IDEMPOTENCY_CONFLICT`；非法输入返回 `INVALID_COMMAND`。对话 ID 是 Durable conversation ID 的字符串投影。`point.chat` 与 `point.command.chat-create` 是 session 文档族，均为版本 1；原子创建 conversation、metadata 和 receipt，收据保存首次命令结果，实时读取使用 chat 文档。无第二事实库，无根级全量 map，无自动恢复模型执行。

现有 WP1a 空白业务库可按需创建新文档，不改旧文档格式；不升级原型库。测试仅用临时目录。真实使用前必须备份；不承诺旧二进制能理解新业务数据，不把代码回滚冒充数据库降级。收据保留策略以后需要单独契约，当前不自动清扫。

## 完成边界

以 [verification-status](verification-status.md) 的证据为准。WP1b.1/2a 完成不代表 WP1b 或 G1 完成；公开消息 API、USER.md、压缩、fork/归档、后台执行、定时与投递均需后续实现。长期负载、收据增长、真实模型故障和 Docker 未在本片验证。
