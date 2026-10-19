## Purpose

把外部能力统一到 Agent 层的资源边界：明确谁拥有资源、控制权何时失效、外部动作处于哪一态；让 domain 不依赖具体实现，让 `unknown` 永远只能被观察核销，而不是被自动重放。

## ADDED Requirements

### Requirement: Resource lease and control epoch
系统 SHALL 用 `resource{id, owner, lease, controlEpoch, state}` 表示外部资源；有效租约被其他 owner 持有时 SHALL 拒绝获取。首次 `acquire` SHALL 注册资源；`renew`/`release`/`takeover`/`beginOperation` 对缺失资源 SHALL 返回 `RESOURCE_NOT_FOUND`。`takeover` 与过期后的重新获取 SHALL 递增 `controlEpoch`；使用旧 epoch 的续租、释放和动作受理 SHALL 被拒绝。确定失败的外部动作 SHALL 记录稳定的错误码作为结果，供审计与后续错误映射使用。

#### Scenario: Takeover fences the old owner
- **WHEN** 用户接管一个已被租用的资源，旧 owner 随后尝试续租或发起动作
- **THEN** 旧 owner 收到 `STALE_CONTROL`，新 owner 的租约保持有效

#### Scenario: Expired lease can be reacquired
- **WHEN** 租约到期后另一个 owner 获取资源
- **THEN** 获取成功且 `controlEpoch` 递增，旧租约不能续期

### Requirement: Side-effect tri-state
外部动作 SHALL 先记录 `intent`，派发前进入 `attempting`，结果只能落为 `done`、`failed` 或 `unknown`。`unknown` SHALL 禁止重放，只能通过观察核销为 `done` 或 `failed`；进程在 `attempting` 状态恢复时 SHALL 先转 `unknown`，不得再次调用外部动作。派发前若 `controlEpoch` 已失效或资源缺失，`intent` SHALL 被取消为 `failed`，且 SHALL NOT 调用外部动作。

#### Scenario: Unknown result is not replayed
- **WHEN** 外部动作抛出无法确认是否发生的异常后再次执行同一操作
- **THEN** 不再次调用外部动作，操作保持 `unknown`，等待观察核销

#### Scenario: Reconcile an unknown result
- **WHEN** 观察确认之前 `unknown` 的动作已经成功
- **THEN** 操作落为 `done`，且仍不会重新调用外部动作

### Requirement: Idempotency and atomic commit
每个资源写命令 SHALL 带 `requestId`；顺序重放同键同内容 SHALL 返回首次结果，同键不同内容 SHALL 返回 `IDEMPOTENCY_CONFLICT`。并发同键写入的失败方 MAY 返回 `RESOURCE_CONFLICT`，重试后 SHALL 返回首次结果。资源状态、操作状态与幂等收据 SHALL 在一次原子 commit 内写入；CAS 失败 SHALL 全部不生效。

#### Scenario: Retry does not double-execute
- **WHEN** 调用方用同一 requestId 重试一次已经完成的资源动作
- **THEN** 返回首次结果，外部动作只执行一次

### Requirement: Domain purity and adapter boundary
`domain` 与 `application` SHALL NOT import SDK、平台模块或具体 adapter，也 SHALL NOT 定义 Durable task；外部能力只能通过 application 端口与 adapter 实现。内存 adapter SHALL 明确标注 test-only，不宣称持久化或生产可用。

#### Scenario: Boundary check rejects a domain task
- **WHEN** `domain/` 或 `application/` 中出现 `defineTask(` 定义
- **THEN** 根目录检查失败并指出违规文件
