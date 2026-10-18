# 运行时选型：Pi Durable

> **已定：2026-10-18 采用 Pi Durable 作为 Point 的 Agent 层，Steel 作为浏览器基础设施。**
> 替代 2026-10-16 的 Pi coding-agent SDK 选型。当前验证基线为 `@earendil-works/pi-durable@1.3.0`。

## 选择依据

Point 的核心体验是长期主会话、可持续主题、独立后台工作、结果回传与未来唤醒。Durable 已提供会话、模型—工具循环、上下文与压缩、持久任务和恢复原语；原型已经跑过这些原语与产品流程的组合，可以作为后续 Server 的基础。

此前选择 Pi SDK 主要考虑终端插件复用。现在明确优先采用 Durable 的执行与恢复模型，接受按 Durable extension 适配插件的成本。Steel 独立承接浏览器服务，使浏览器能力不依赖 Pi SDK 插件。不是把旧 SDK session 外面再包一层任务账本。

## 直接复用与 Point 增量

| 能力 | Durable 直接提供 | Point 负责 |
|---|---|---|
| Agent loop | generation → tool tasks → tool results → 后续 generation | 角色、任务指令、完成判据和模型配置，不重写继续循环 |
| 上下文 | 历史投影、sections/instructions、工具声明、自动/手动压缩 | 人格、环境/cwd、当前聊天、记忆索引、任务约束和检索预算 |
| 工具 | 定义、调度、调用记录、工具结果及 replay 策略 | 业务工具、Steel 适配、外部动作日志与结果核对 |
| 会话 | conversation、entries、fork、submission、busy/abort 机制 | main/侧聊目录、归档与结果路由；产品关系不等于运行时 ownership |
| 后台工作 | defineTask、checkpoint、任务 ownership、持久等待与恢复 | 产品 Task / Goal、Work / Report / Share / Followup 及状态转换 |
| 业务存储 | document 与 entry/task 的原子提交 | schema、状态版本、迁移、请求去重和单一事实来源 |
| 浏览器 | 扩展接入点 | Steel REST/CDP、资源归属、接管、租约、登录检查点与恢复 |

主会话直接使用 Durable 对话能力；复杂工作才创建独立后台执行会话。工具循环存在与模型 thinking 开关是两件事。思考级别按模型能力配置，当前原型默认请求 medium、实际 DeepSeek Flash 为 high；不能以关闭思考的个别失败判定 Durable 没有 Agent loop。

## 接入与版本边界

1. 使用 `Harness` + 持久 storage，安装 registry 中的扩展，恢复同一 root 和 conversation ID。启动恢复需显式启用调度，原型调用 `harness.resume()`。
2. 使用原生 `submit()`、busy 时的 steer/followUp、abort、compact 与历史查询，不另存替代性的 messages 数组。
3. 产品能力用 `defineExtension` / `defineTool` / `defineTask` / document 接入；业务状态与回传任务创建尽量在同一 commit 完成。
4. 思考、模型、工具集与角色按会话配置；既有会话配置已持久化，修改默认值时需明确升级范围。
5. Durable 不自动扫描 Pi Coding Agent 的 AGENTS/skills，也不自动加载其终端插件。需要的资源显式加载并适配生命周期与交互。
6. 初版锁定已验证的 Durable、pi-ai、Chord 1.3.0，Node.js ≥ 22.19；Steel 使用固定镜像 digest。Durable 当前包标记为实验性 API，升级需验证接口、状态迁移和恢复，不跟随 latest 自动升级。

不同时引入 Pi coding-agent SDK、DSH 等第二套生产执行引擎。已有候选 Goal/调度/记忆插件保留为参考；优先复用可独立调用的逻辑，以 Durable 适配器接入。只有在兼容性、状态权威与恢复契约验证后才引入依赖。

## 恢复与长期执行的承诺

Durable 在服务运行时执行任务，持久化阶段与等待点；进程中断后重开相同存储并恢复调度，可继续未完成工作。Docker/supervisor 负责把进程重新拉起。长期目标无事可做时只保存状态，按未来时间或事件唤醒，不需要永远占用一个模型循环。

checkpoint 不能证明任意外部动作恰好执行一次：读操作与确定性写入可按契约重试；发送、提交等动作需接收端幂等、可查询回执或先观察核对。中断窗口中的动作保留 `unknown`，不盲目重放。运行时任务完成也不自动证明网站/文件中的业务结果满足用户要求。

## 已有验证与仍需验收

| 范围 | 已有证据 | 实际限制 |
|---|---|---|
| 基础执行与恢复 | [执行验证](../research/pi-durable-validation-2026-10-18.md)、原型故障注入 | 确定性场景为主，不能替代任意外部副作用验证 |
| 会话与产品链路 | [原型 README](../../infra/pi-durable-validation/README.md)：main/侧聊、fork、记忆、后台回传、一次跟进、取消与恢复 | 尚无完整 Web 产品、Goal 规划器或主动通知策略 |
| 上下文与工具循环 | [本地包审计及 thinking 对照](../research/pi-durable-context-audit-2026-10-18.md) | 小样本，不等于复杂任务完成率或自动压缩质量验收 |
| Steel Agent 工具 | [REST/CDP 与接管恢复验证](../research/steel-durable-validation-2026-10-18.md) | 容量 1、页面能力有限；旧 Steel 基线上的验收需在发布镜像重跑 |
| Steel 原生 RTC 镜像 | [国内/GHCR 发布、双架构解码验证](../research/steel-webrtc-publication-2026-10-18.md) | 原生播放器未接 Point 控制权；长期、公网与完整交互待验收 |

调研报告保留当时“SDK 选型不变”等历史描述；本文件代表新的决定，不改写历史实验结论。

## 实施顺序与完成标准

| 阶段 | 工作 | 完成标准 |
|---|---|---|
| 1. 正式 Server | 从 `infra/pi-durable-validation/` 提取运行时与产品模块，迁入/整理 `server/`，隔离模型与部署配置 | 同一 Durable 数据重启后保留聊天、任务和待回传结果；停止/补充/取消作用域正确；不新启旧 SDK 引擎 |
| 2. 稳定状态与 API | 定义 chat/task/plan/artifact/delivery/browser ID 与版本，稳定 HTTP/SSE，补齐幂等与状态升级 | main/侧聊完整链路与原型恢复用例在正式 Server 通过；客户端重连可重建状态；旧数据有明确迁移/保留路径 |
| 3. Steel 原生 RTC | 拉国内固定 digest，复测 REST/CDP，将原生信令/输入接入同一控制权校验 | 默认观看不接受输入；接管时 Agent 被阻止；交还/断线/过期/取消后陈旧连接被拒绝；画面和输入指向同一资源 |
| 4. 薄 Web 产品 | 对话、主题、任务、产物、浏览器侧栏 | 交代 → 离开 → 回来 → 追问/纠正 → 跟进的真实使用链路通过 |
| 5. 长期使用 | 常驻部署、周期计划、供应商故障与退避、记忆规模、备份与资源回收 | 长时间运行与强杀后无丢失计划/陈旧通知/浏览器泄漏；未知副作用可见且可核对 |

前两阶段不重写 Durable 内核。旧 `server/` 和 DSH/浏览器实验代码保留为历史验证，迁移前不删除已有数据或凭据；无需把旧 SDK 历史强行解释为 Durable checkpoint。完整外部通知与更复杂的记忆后端按产品需要随后接入。
