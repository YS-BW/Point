# Point Server 旧验证工程（Pi SDK + 扩展）

> **2026-10-18 选型已更新**：正式设计采用 Pi Durable 作为 Agent 层、Steel 国内镜像作为浏览器基础设施，见[设计总览](../docs/design/README.md)和[迁移顺序](../docs/design/runtime-selection.md)。本目录保留旧 SDK 实测，尚未迁移；后续 Server 基于 [Durable 原型](../infra/pi-durable-validation/README.md)整理，不沿用下文的插件优先实施路线。

> 状态：**已跑通并留证的第一轮**。用 `@earendil-works/pi-coding-agent` 1.3.0（精确锁定）验证服务端形态。
> 本轮范围：模块 1（服务端运行，含**真实模型**）+ UI 契约（插件兼容性风险的核心一项）。
> 状态口径沿用 `docs/design/`：**已实测** = 有可复跑命令和真实输出；**待验证** = 尚未跑过。
> 真实模型走 DeepSeek（凭据在 `.pi/agent/auth.json`，已 gitignore，权限 600）。

## 为什么先做这一轮

按当时的选型，Point 使用 Pi SDK + 扩展。SDK 与插件生态都是**终端优先**设计的，
服务端（无 TTY、无终端 UI）能不能跑、插件会不会静默失效，是全部后续工作的前提。
这一轮先把这个前提变成事实，再谈上下文、子 Agent、调度。

## 目录

```
server/
  src/
    session-service.mjs   无终端会话服务：open / prompt / steer / followUp / abort / 事件订阅
    paths.mjs             路径约定（工程内隔离，不碰用户 ~/.pi）
    faux.mjs              官方 faux provider 通道，确定性测试不依赖模型凭据
    stub-ui.mjs           ExtensionUIContext 桩：模拟"把对话框接到 Web"这个位置
    runner.mjs            服务端入口骨架：事件归一化成 JSONL，之后换 SSE 不动会话逻辑
  .pi/agent/
    models.example.json   模型声明示例（含 faux 假模型）
    models.json           本地副本（已 gitignore；`cp models.example.json models.json` 生成）
    auth.json             凭据（已 gitignore，不入库）
    extensions/probe.ts   UI 契约探针扩展
  test/
    01-headless-session.mjs   无终端 / 工具调用 / 流式 / 会话保存
    02-restart-continue.mjs   跨进程重启后继续对话
    03-stop-semantics.mjs     停止当前回答 + 停下后仍可用
    04-ui-contract.mjs        扩展的 UI 契约（头号风险）
    05-real-model.mjs         真实模型 + 真实工具调用（无凭据自动跳过）
    run-all.mjs               汇总
```

## 怎么跑

```bash
cd server
cp .pi/agent/models.example.json .pi/agent/models.json   # 本地配置，不入库
npm install          # 121 个包、约 167MB、约 40s
npm test             # 5 个验证脚本，全部输出实测数字
```

注意：`npm test` 会跑一次真实 API（约 0.1~0.6 美分）。要跳过就 `POINT_SKIP_REAL=1 npm test`。
没有凭据时 05 会自动跳过，所以无凭据环境下这套仍然全绿。

单跑：`node test/04-ui-contract.mjs`。

服务端形态试跑（用假模型，无需凭据）：

```bash
node src/runner.mjs --prompt "用 bash 在 out/ 下写个文件"
node src/runner.mjs --continue --prompt "刚才写了什么？"
```

真实模型：

```bash
# 凭据放 server/.pi/agent/auth.json（已 gitignore），格式 { "<provider>": { "type": "api_key", "key": "..." } }
# 或直接 export DEEPSEEK_API_KEY=...，不落任何文件
node src/runner.mjs --model deepseek/deepseek-flash --prompt "用 bash 写个文件"
POINT_REAL_MODEL=deepseek/deepseek-v4-pro node test/05-real-model.mjs
```

## 已实测的结论

| 结论 | 证据 |
|---|---|
| 无终端可完整运行：建会话、真实执行 bash 工具、事件流、落盘 | 01：9/9；15 个 `message_update`、4 个 `tool_execution_*`、工具产物内容与预期一致 |
| `agent_end` 与 `agent_settled` 确实是两个事件 | 01 事件直方图两者各 1 |
| 跨进程重启后继续同一会话，历史与新轮次都正常 | 02：7/7；两进程 sessionId 相同、会话文件 14089 字节 |
| `abort()` 能中途停下正在跑的工具调用，且停下后会话仍可用 | 03：5/5；494ms 返回（对比工具内 6s 睡眠），随后新轮次成功 |
| 扩展可从 `<agentDir>/extensions/` 自动发现并加载，工厂只执行一次 | 04：`factoryRuns=1` |
| 注入对话框代理后，扩展能拿到答复，且能看到 `ui_prompt_start/end` | 04 阶段 B：`kind=confirm,select` 各 2 次 |
| **真实模型自主决定调工具并完成任务** | 05：6/6；`deepseek-flash` 2003ms、1 次 bash、33 个 delta、$0.0012 |

## 真实模型实测（DeepSeek）

pi-ai 内置 `deepseek` provider（`baseUrl: https://api.deepseek.com`，`api: openai-completions`，
环境变量名 `DEEPSEEK_API_KEY`），它读 `auth.json` 里的凭据即可，不需要自己写 `models.json`。
目录里的模型与线上 `GET /models` 完全一致：`deepseek-flash`、`deepseek-v4-pro`。

同一句任务（在 `out/` 下写一个内容固定的文件再 cat 出来）下的实测对比：

| | `deepseek-flash` | `deepseek-v4-pro` |
|---|---|---|
| 整轮耗时 | 2003ms | 3551ms |
| 工具调用 | 1 次（bash） | 2 次（write + bash） |
| input / output tokens | 3444（其中 cacheRead 3200）/ 112 | 3559（其中 cacheRead 6784）/ 204 |
| 按目录价的成本 | $0.00119 | $0.00580（约 **4.9 倍**） |

对设计的意义：`docs/design/decision-layer.md` 要求判断层和执行层不用同一档模型。
这两个档次在同一任务上差 ~4.9 倍成本，且强档并不必然更快——判断层用 flash 档是有数据支撑的。

另一个实测细节：同一任务第二次运行时 input 从 3444 降到 430、cacheRead 升到 6272，成本降到 $0.00038。
说明系统提示词被 DeepSeek 的上下文缓存命中了。服务端形态下每轮复用同一份系统提示，
这条对成本核算很重要（按 input 全价估算会显著高估）。

## 实测发现的坑（这一轮最值钱的部分）

### 1. `session_start` 只在 `bindExtensions()` 里发出

SDK 的 `agent-session.js` 中，`await this._extensionRunner.emit(this._sessionStartEvent)`
只出现在 `bindExtensions()` 内部。**不调用 `bindExtensions` 的集成里，扩展虽然被加载、工具也注册了，
但所有 `session_start` 初始化逻辑永远不执行。**

对插件意味着什么：Goal 类插件正是在 `session_start` 里恢复目标池和继续状态。
如果 Point 只 `createAgentSession` 就开跑，这些插件会"看起来加载成功、实际什么都没恢复"。

→ 本工程把 `bindExtensions` 作为 `openServerSession` 的固定步骤（`activateExtensions`）。

### 2. `hasUI` 是一个全局开关，没有中间态

`runner.hasUI()` 的实现是 `this.uiContext !== noOpUIContext`。
也就是**只要注入任意 UI 上下文，所有扩展的 `hasUI` 同时变 true**，全部交互路径被激活；
不存在"只给某个插件开 UI"。

### 3. 无终端时扩展不会卡死，而是静默失效

默认 `noOpUIContext`：`confirm → false`、`select/input → undefined`。**不抛错、不挂起、不打日志。**
更麻烦的是 `ctx.ui.select` 在无 UI 时仍然是函数，所以插件里
`typeof ctx.ui.select === "function"` 这类"无终端自检"判断不出无终端
（`pi-goal-x` 正是这样自检的）。

→ 给插件接 Web 对话框时，"没实现"和"被用户拒绝"在插件看来是同一件事，必须由 Point 自己区分。

### 4. UI 上下文必须在第一次 `bindExtensions` 就位

因为 `session_start` 由 `bindExtensions` 发出，先建会话、后注入 UI（分两次）会让
`session_start` 阶段永远看到 `hasUI=false`。

→ 推荐形态：**第一次激活就带上对话框代理**（04 阶段 D 已验证 `session_start` 里 `hasUI=true`）。
这意味着代理本身要能处理"当前没有客户端连接"的情况（排队或给默认值），而不是等客户端上线才存在。

### 5. 撤销 UI 上下文必须传 `null`

`bindExtensions` 的实现是 `if (bindings.uiContext !== undefined)` 才赋值，
所以传 `undefined` 是"什么都不做"；只有 `null` 才会回到 `noOpUIContext`。
类型声明 `uiContext?: ExtensionUIContext` 完全看不出这个差异。

### 6. faux provider 的 api id 默认是随机的

`registerFauxProvider()` 默认 `api = randomId("faux")`（形如 `faux:1792...:h1ivg`），
与 `models.json` 里声明的 `"api": "faux"` 对不上时，错误只在**对话期**暴露：
`No API provider registered for api: faux`，加载期与建会话期都不报错。
必须显式传 `api: "faux"`。

### 7. 探针日志不清空会得出假结论

第一次跑 04 时读到上一轮进程留下的 `session_start`，一度误判"扩展被加载两次"。
凡是有跨进程持久观测的验证，都必须在**建会话之前**清空观测文件。

## 尚未验证

| 项 | 说明 |
|---|---|
| 多任务并行、取消互不影响、补充指令 | 模块 3，未开始 |
| 单次/周期调度、重启不丢计划、错过合并 | 模块 4，未开始 |
| 决策与真实推送、失败重试不重复发送 | 模块 5，未开始 |
| 崩溃注入与"已完成/未完成/结果未知"三态 | 模块 6，未开始（本工程只有会话级恢复，没有任务级账本） |
| 插件组合能否无终端共存 | 未开始。轮子已备好：探针扩展 + `hasUI`/`ui_prompt` 观测 |
| 浏览器接手互斥 | 未开始（`infra/agent-browser` 只验证了观看链路） |

## 当时的后续建议（历史 SDK 路线）

以下保留实验时的建议，现行实施计划以[运行时选型](../docs/design/runtime-selection.md)为准。

1. 把 Day-0 插件组合 spike 放进这个工程：Goal 三选一、调度二选一，
   用同一个 probe 观测 `hasUI`、`ui_prompt`、重复加载与状态路径冲突。
2. 再往上做模块 2（上下文注入）——SDK 有原生机制可用：`<agentDir>/AGENTS.md`
   作为全局上下文、`<cwd>/AGENTS.md` 作为项目上下文，以及
   `SessionManager.appendContextEdit` 做上下文改写。
3. 决策层（模块 5）可以先用 `deepseek-flash` 档做策略判断，用数据支撑"两档模型"的分工。
