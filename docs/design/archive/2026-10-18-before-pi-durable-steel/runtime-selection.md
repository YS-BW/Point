> 历史快照：2026-10-18 改用 Pi Durable + Steel 前的设计。其选型与待办仅供追溯，现行决定见[设计总览](../../README.md)。

# 运行时选型：Pi SDK

> **已定：2026-10-16 从 pi-durable 改为 Pi SDK。**
> SDK 指 `@earendil-works/pi-coding-agent`，不是只使用 pi-ai，也不是启动一个终端 UI。

## 为什么调整

Point 的目标已明确为 Muse 形态的完整 personal agent，插件、浏览器、长期任务、记忆等能力的复用价值很高。此前偏重 durable 的恢复原语，低估了 coding-agent 插件移植成本。

SDK 可以嵌入 Node.js 服务，加载 extensions、skills、工具和资源，管理持久会话并订阅执行事件。选择 SDK 是为了优先复用生态，不代表所有插件已通过服务端兼容测试。

## 两条路线的取舍

| 能力 | Pi SDK（当前选择） | pi-durable（历史方案） |
|---|---|---|
| coding-agent 扩展 | 同一扩展 API，仍需逐个验证 | 通常需要移植生命周期与状态接口 |
| 会话 | SessionManager 保存历史与分支 | 存储中的 conversation / entry |
| 中断工作 | Point/插件判断如何继续 | 内置 Task checkpoint 与恢复原语 |
| 子 Agent | 多个 session + 插件或 Point 编排 | owned conversation + background task |
| 产品状态 | Point 或选定插件持久化 | 可借助 Document 原子提交 |
| 外部副作用 | 不自动保证恰好一次 | 也不能仅凭 requestId 保证外部恰好一次 |

不再采用旧方案的 Harness、ContextEdit、durable ToolTask、runtime.sleep 或 durable 存储作为实现前提。也不同时引入两套执行引擎。

## SDK 接入边界

- `createAgentSession()` 创建会话；`SessionManager` 管理会话持久化。内部有多个 session 不影响产品的主对话入口。
- `DefaultResourceLoader` / `ResourceLoader` 提供扩展、技能及资源发现。
- `session.subscribe()` 提供实时事件；`prompt()` / `steer()` / `followUp()` / `abort()` 支撑交互与控制。
- SDK 并非自动复制 CLI 的所有配置。codemode、tool search、MCP 等要按官方 SDK 指引显式配置，并绑定扩展生命周期。
- 终端 widget 不直接成为 Web UI；确认、输入等交互需有 Web 接入或明确的无终端路径，不能静默绕过。
- 使用事件完成态判断任务时，要区分低层 `agent_end` 与最终 `agent_settled`。

这些接口已查阅本地 1.3.0 文档与官方文档，本轮没有运行集成测试。实际依赖版本需结合选定插件锁定，不沿用旧 durable 依赖清单。

## 插件优先复用

| 候选 | 已查阅的能力 | 仍需验证 |
|---|---|---|
| [@capyup/pi-goal](https://github.com/capyup/pi-goal) | 多目标文件池、单会话焦点、自动继续、暂停恢复、完成审查 | 无终端确认路径、并发文件访问、与主/子 session 的关系 |
| [@xzzpig/pi-goal-x](https://pi.dev/packages/@xzzpig/pi-goal-x) | 目标、结构化任务、自动继续、完成审查 | 版本兼容、状态权威、生命周期与 UI 依赖 |
| [pi-schedule-prompt](https://github.com/tintinweb/pi-schedule-prompt) | 单次、周期、cron、主/后台 prompt、计划持久化 | SDK 生命周期、重启和错过计划行为 |
| [@fookhsu/pi-scheduler](https://github.com/fookhsu/pi-scheduler) | 独立调度核心、Agent Adapter、运行记录 | 默认通过 CLI 启动隔离会话；与常驻 SDK Server 的连接、串行执行与恢复规则 |

具体插件**尚未选定或安装**。优先采用、其次适配，验证不满足时才自建。插件声明“持久化”不等于执行 checkpoint 或副作用幂等。

## Point 必须承担的 Server 工作

1. 主/子 session 的创建、映射、释放、恢复，以及补充指令与结果路由。
2. 任务、目标、计划、产物的产品状态与 API；每类事实只设一个权威来源。
3. 资源并发和成本预算，浏览器与共享文件的冲突处理。
4. 识别中断执行、错过的计划及外部结果未知状态。
5. 将插件需要的用户交互接到 Web，将后台结果接到判断与通知层。

## 恢复语义（设计方向，待验证）

会话历史可恢复，不承诺任意工具从断点无缝续跑。Server 重启后识别未结束执行：可安全继续的工作重新唤醒；外部动作结果未知时先核查，不能盲目重复发送或提交。

现有 durable Demo 只证明旧运行时的特定路径，不能算作 SDK 验证结果。尤其旧打印 Demo 的“先记已执行，再打印”存在两步之间退出导致漏执行的窗口，不作为端到端恰好一次保证。

## 实施前验证项

- 无终端加载候选 Goal / 调度 / 浏览器扩展，确认版本与交互契约。
- 主对话与子 Agent 并行，主对话停止不误杀独立任务；任务取消可停止对应工作。
- 重启后的会话恢复、任务状态核对、计划恢复和结果回传去重。
- 一个插件拥有状态时，Point 通过适配器访问，不另存可冲突的权威副本。

来源：[SDK](https://pi.dev/docs/latest/sdk) · [扩展](https://pi.dev/docs/latest/extensions) · [durable 的官方定位](https://earendil.com/posts/pi-durable/)
