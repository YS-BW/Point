## Purpose

让用户交代的一项工作有稳定的产品身份与可恢复的执行尝试，并让 Agent 产出的文件可核对、半成品不被伪装成成功。

## ADDED Requirements

### Requirement: Job and Attempt identity
系统 SHALL 将产品 Job 与执行 Attempt 分离；恢复 SHALL 沿用同一 attemptId 与 Durable task；新修订或重试 SHALL 创建新 attemptId。旧 attempt 的结果 SHALL NOT 覆盖新 revision 的 Job。

#### Scenario: Amend during execution
- **WHEN** 用户在工作运行中修改要求
- **THEN** Job revision 递增并创建新 attempt；旧 attempt 标记 superseded，旧结果不覆盖新 revision

#### Scenario: Restart keeps the attempt
- **WHEN** 进程在 attempt 执行中重启
- **THEN** 同一 attemptId/task 恢复，不重复已完成的外部动作

### Requirement: Revision fence and cancellation
完成写入 SHALL 校验 Job revision、currentAttemptId 与取消状态；不匹配 SHALL 只记录 attempt superseded。取消 SHALL 传播到 attempt task，且 SHALL NOT 撤销已发生的外部动作或伪造成功。

#### Scenario: Cancel a running job
- **WHEN** 用户取消正在运行的工作
- **THEN** Job/Attempt 变为 cancelled，task 被中止，后续不产生 ready 结果

### Requirement: Artifact sealing
系统 SHALL 将产物写入受限路径，使用临时文件 + fsync + rename，并记录 sha256/bytes；只有 sealed 且哈希可核对的产物才能让 Job ready。writing/unknown/failed 或缺失引用 SHALL NOT 计为成功。

#### Scenario: Verify an artifact
- **WHEN** 用户或审计读取 Job 产物
- **THEN** 系统重算文件哈希并与 Artifact 文档比对，篡改/缺失返回未通过

### Requirement: Authorized artifact tool
`save_artifact` SHALL 只在 execution conversation 中可用，并通过 Job/Attempt/revision 校验；路径穿越、超限、非 execution 会话 SHALL 被拒绝；同一 artifact 重复写 SHALL 幂等，异内容 SHALL 冲突。

#### Scenario: Tool called in a normal chat
- **WHEN** 普通对话尝试调用 save_artifact
- **THEN** 工具拒绝，不写文件、不产生 sealed artifact
