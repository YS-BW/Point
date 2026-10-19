## Purpose

让用户可以像使用持续在线的个人助手一样交谈、补充要求、停止和返回查看结果，并且在断线或服务恢复时得到真实可解释的状态，而不会把消息已接收误当作任务已完成。

## ADDED Requirements

### Requirement: Durable conversational input
系统 SHALL 接收带 requestId 的非空自然语言消息，返回可查询身份；同键异参拒绝，同键重试不生成第二条输入。未配置模型或未知会话 SHALL 拒绝。

#### Scenario: Return after sending
- **WHEN** 用户发送“帮我起草给小王的项目说明”后离开调用方
- **THEN** 服务继续处理，用户返回能够读取原输入、回答和完成状态

### Requirement: Follow-up ordering and isolation
系统 SHALL 将忙碌时补充的消息排队，在前一轮结束后连同该会话历史提供给模型；其他会话 SHALL 独立执行且不混入上下文。

#### Scenario: Add a constraint
- **WHEN** 助手处理方案时用户补充“预算控制在五千以内”
- **THEN** 补充不丢失、不与当前模型调用并发混写，下一轮看到原方案与补充

### Requirement: Stop and continue
系统 SHALL 让停止命令结束该会话当前执行、清掉此前排队输入，并保留历史；停止后的新输入 SHALL 能继续。重放停止命令不得取消更新的输入。

#### Scenario: Change direction
- **WHEN** 用户停止正在撰写的方案，再发送“先帮我列三个问题”
- **THEN** 旧排队内容不再执行，新请求正常回答，重试旧停止请求不影响它

### Requirement: Honest recovery
系统 SHALL 将模型结果未确认显示为未回答或失败，禁止自动重放已登记的模型调用；已完成回答在重启后仍可查询。

#### Scenario: Restart during model request
- **WHEN** 模型已收到请求但服务在提交结果前终止
- **THEN** 重启不会再向供应商发送该请求，也不会显示成功回答

#### Scenario: Provider fails
- **WHEN** 模型返回错误
- **THEN** 用户查询到未回答状态，历史中没有伪造的成功回复
