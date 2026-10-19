## Purpose

为个人 Agent 的对话创建提供明确、可恢复的命令边界，使客户端在网络断开或服务重启后能够安全重试，并能区分原请求的成功结果与误用了请求标识的新请求。

## ADDED Requirements

### Requirement: Validated create command
系统 SHALL 要求显式 requestId（1–128 个 ASCII 字母、数字、点、下划线、冒号或连字符）及 name（trim 后 1–120 个 Unicode 码点），拒绝额外字段和非法输入，且不产生持久变更。名称控制字符不合法。

#### Scenario: Invalid command
- **WHEN** 输入缺少 requestId、name 为空或带有未知字段
- **THEN** 返回 INVALID_COMMAND，且不创建对话或收据

### Requirement: Persistent idempotency
系统 SHALL 在创建对话命令范围内按 requestId 去重；相同规范化输入返回原始结果，不同输入返回 IDEMPOTENCY_CONFLICT。并发请求、重启和首次响应丢失后 SHALL 保持该行为。收据不得自动过期。

#### Scenario: Concurrent identical requests
- **WHEN** 同键同内容的创建请求并发到达
- **THEN** 全部得到相同的对话标识，只有一个对话被创建

#### Scenario: Conflicting reuse
- **WHEN** 已成功的请求标识携带不同名称重试
- **THEN** 返回 IDEMPOTENCY_CONFLICT，原结果不变

#### Scenario: Lost response
- **WHEN** 服务在提交后、调用者收到响应前退出，随后重试
- **THEN** 返回首次创建的结果，不创建第二个对话

### Requirement: Atomic creation and lookup
系统 SHALL 将对话、初始元数据和创建收据作为一个原子结果持久化；查询不存在的对话返回 undefined 且不得创建数据。该命令不启动模型执行。

#### Scenario: Interrupted commit
- **WHEN** 事务在提交前异常或进程终止
- **THEN** 对话、元数据和收据均不存在，重试可正常创建

#### Scenario: Restart lookup
- **WHEN** 重启后按返回的对话标识查询
- **THEN** 返回已提交的名称、创建时间和标识
