# NanoMuse 架构复核与 Point 的取舍

> 2026-10-19。只读分析本地源码快照 `ae9eb06b37780dd5028ab885cc38625bc7d830c0`，不代表上游当前最新版本。本次未启动 NanoMuse 或复跑其测试；事实来自文档与关键实现，可靠性判断属于分析。

源码入口：[固定版本](https://github.com/nano-muse/nanoMuse/tree/ae9eb06b37780dd5028ab885cc38625bc7d830c0)。覆盖架构、产品设计、路线、部署/服务/harness 文档，并沿组合根、Agent loop、会话、UI、定时器、目标、工具门控和桌面工作状态追踪；不声称逐行审计全部移动端/云端代码。此前研究结论保留，本记录补充架构层分析。

## 结构事实与源码地图

以下路径均相对上述固定版本，可在本地 `.research/repos/nanomuse/` 只读核对。

| 关注点 | 源码与符号 | 观察到的设计 |
|---|---|---|
| 组合根 | `nanomuse/app.py::NanoMuseApp` | 组装 settings、LLM、stores、vault、Sentinel、tools、agent |
| Agent 执行 | `nanomuse/agent/core.py::MuseAgent.run` | 构建 prompt、模型调用、逐个工具门控、反馈、步骤上限与卡住检测；finally 保存 session |
| 上下文 | 同文件 `build_system_prompt/context_messages` | profile、相关记忆、目标、日历与设备 sections；窗口切分避开工具交换，图片裁剪不直接改原历史 |
| 工具约束 | `nanomuse/sentinel/gate.py::Sentinel` | task/conversation scope、策略/授权、凭据解析、执行结果处理与审计 |
| UI 隔离 | `nanomuse/ui.py::UI`、`server/webui.py` | 核心通过 callbacks 呈现文字/工具/问题；Web 将问题等候存入 Future，contextvar 路由线程 |
| 会话服务 | `nanomuse/server/service.py::MuseService` | 每 thread 独立 agent/worker，共享 memory/goals/vault；后台目标推进独立 thread 回主会话 |
| 展示历史 | `nanomuse/server/events.py` | 每 thread JSON timeline 与内存 bus；合并延迟写入、文件替换；不是执行 checkpoint |
| 后台任务 | `nanomuse/background.py::spawn` | asyncio Task 集合持强引用并记录异常；本身不是持久任务引擎 |
| 主动调度 | `server/service.py::_goal_scheduler` | reminder/check-in、日历/邮件触发、feed、记忆整理与 goal advance 条件串联；去重与空闲检查 |
| 长期目标 | `nanomuse/goals/store.py::Goal/Step` | 独立状态、steps、截止、check-in、下一次检查、计划修订 proposal；不等于持续模型循环 |
| 人工接管 | `nanomuse/agent/holds.py` | 内存 hold、event 释放、timeout；统一设备操作等待 |
| 桌面宿主 | `harness/dsh-nanomuse/src/index.ts`、`work.ts` | DSH 插件入口与 UI 资产；Turns 等 Map 聚合运行活动，保护退出，不能视作通用持久执行存储 |

## 不能把它当作一种单一后端

[架构文档](https://github.com/nano-muse/nanoMuse/blob/ae9eb06b37780dd5028ab885cc38625bc7d830c0/docs/architecture.md) 主要解释 Python 路径；[路线](https://github.com/nano-muse/nanoMuse/blob/ae9eb06b37780dd5028ab885cc38625bc7d830c0/docs/roadmap.md) 同时说明 Android/OpenMinis 子树、iOS、DSH desktop、Python runtime、Web 和 cloud relay。体验统一不等于所有端共享一个执行内核。

Point 要的是 Server 常驻、客户端可替换，因此借鉴主会话/侧聊/后台工作与工具环境，不引入 NanoMuse 的账号、中继、跨设备宿主、多运行时适配面。DSH 插件模式也不适合 Point 当前独立 Server 的选择。

## 值得借鉴的原则

1. composition root 显式组装依赖，产品核心不直接打印 UI。
2. UI 是执行的观察者与交互入口；结果不因某个窗口关闭而失去归属。
3. Goal 有自己的业务生命周期；检查、提醒与推进不是同一动作。
4. 工具在真正执行前有统一门控与上下文，不能只在提示词中约束。
5. 设备/浏览器属于环境，人工接管是资源控制问题，不是停止整个 agent。
6. profile、相关记忆、当前目标等上下文按明确来源组装，不能只靠长 system prompt。

## 不照搬的部分及风险推断

- Python 自有 `messages` 与 timeline/stores 分开持久化：Point 已选 Durable，复制会制造第二事实来源。仅保留可重建视图。
- asyncio task + worker + scheduler：不能据此推断崩溃恢复保证。Point 使用 Durable task 的持久等待/恢复，不在外层增加 job queue。
- Web 的 pending Future 与 holds：进程内等待可用于连接优化，但用户问题和控制权必须有持久身份，重启可查询/重新连接。
- 主服务承担大量触发/设备/业务职责：Point 将触发、判断、执行、结果与投递分开，事务由明确用例拥有，避免成为新 service 巨型模块。
- Sentinel 的授权体系：只借鉴执行前统一约束和私密数据边界。Point 不新增通用审批/角色平台，落实已确认的发送边界和资源互斥即可。
- 依靠 session finally 保存不能证明外部操作 exactly-once；Point 仍需 intent、unknown、observe/reconcile，尤其付费模型和通知。

这些是源码结构带来的风险推断，不是已运行复现的 NanoMuse 缺陷报告。Point 新骨架同样不能用单元测试替代真实模型、通知、浏览器和长期运行验收。

## 落到 Point

采用 [ADR-002](../design/adr/ADR-002-server-foundation.md) 与 [Server 架构](../design/server-architecture.md)。承诺/目标/工作/尝试分离；用户等待持久化；上下文与展示是权威数据的投影；资源与投递受三态契约约束。代码重新实现，无 NanoMuse 源码复制。完整实施路径见 [roadmap](../design/roadmap.md)。
