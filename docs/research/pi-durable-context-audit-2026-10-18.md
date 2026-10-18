# Pi Durable 上下文与原型执行行为审计

日期：2026-10-18。范围：当前原型实际安装的 `pi-durable`、`pi-ai`、`pi-coding-agent`，均为 **1.3.0**；运行模型 `deepseek/deepseek-flash`。

后续修复：原型已将默认思考改为按模型能力调整的 `medium`（当前 DeepSeek Flash 实际为 `high`），启动时同步已有会话和未完成工作；支持 `--thinking`，CLI 与 `/state` 显示实际级别。下文保留修复前的审计和对照记录。

## 结论

当前证据不支持“Durable 缺少上下文封装”“原型没有 ReAct”或“未复用 Pi 默认提示词就是这次失败的原因”。此前把这些判断混在一起，是错误归因。

本次找到并验证了一个关键配置差异：**原型把用户会话的 `thinkingLevel` 显式设为 `off`，实际 Pi SDK 对同一模型使用默认配置时会开启思考，最终级别为 `high`。**

保持提示词、工具声明和输入历史不变，仅开启思考后，四组条件的共 8 次请求均返回工具调用。关闭思考时，原型提示词与 Pi 默认提示词都出现过直接拒绝或再次确认。这个结果说明推理配置对本次行为有直接影响；样本很小，不构成长期成功率评估，也不能据此宣布桌面任务已完成验收。

本次只新增审计脚本和报告，未修改正在运行的 agent 配置或系统提示词。

## Durable 已经封装的上下文链路

```text
conversation.submit(input)
  → 持久化用户输入
  → GenerationTask.prepare
      读取当前 agent 与已提交历史
      渲染选中扩展的 sections，最后追加 instructions
      对系统指令与工具声明计算增量，保存 pi.system
      判断是否需要压缩
  → GenerationTask.request
      按已提交 cutoff 读取 ContextView.messages
      执行 beforeRequest hooks
      pi-ai 根据提供商能力转换请求
      调用模型
  → toolUse：创建并执行工具任务，提交 toolResult
      → finishToolRound 创建下一次 generation
  → stop：提交最终回答并结束 run
```

审计依据是原型安装包实际执行的以下模块，而不只是 README：

- `infra/pi-durable-validation/node_modules/@earendil-works/pi-durable/dist/harness/context.js`：从持久化 entries 推导活动上下文，应用 head/edits，整理工具结果顺序，排除 error/aborted/deferred 助手记录。
- `.../harness/agent.js`：解析 agent 配置，组合扩展 sections/tools，最后追加会话 instructions；内置自动压缩默认开启。
- `.../harness/prompt.js`：按顺序渲染 sections，并计算系统提示词、工具声明的增量。
- `.../harness/generation.js`：准备请求、自动压缩检查、请求快照、工具轮次、后续 generation 和最终结束。
- `infra/pi-durable-validation/node_modules/@earendil-works/pi-ai/dist/utils/transcript.js`：重放 sections 与工具增量，得到当前有效状态。
- `.../api/openai-completions.js`：将上述上下文转换成 DeepSeek 实际接收的 messages/tools/thinking 参数。

原型使用这些原生能力，没有自行维护一份替代性的 messages 数组，也没有自行重写模型—工具循环。

工具执行后继续生成与“模型开启思考”是两项独立设置。关闭 thinking 不会关闭工具循环，但会改变模型的执行决策表现。

## 实际请求检查

通过 `GET /chats/main/context` 读取运行服务的活动上下文，再调用同版本 `pi-ai` 的 `completeSimple`。在 `onPayload` 捕获提供商请求体并立即中断，同时注入禁止出网的 fetch，验证捕获过程没有发送模型请求。

检查通过：

1. 当前 Point 中文指令、共享记忆段和当前会话段均出现在 DeepSeek 请求体中。
2. 旧英文 `point` section 已被新同名 section 替换，没有与新提示词同时作为当前指令生效。
3. DeepSeek Flash 的请求最终只有一个系统消息；历史中的系统增量已正确合并。
4. 请求声明的工具与重放后的工具列表一致，当前用户会话共 19 个工具，包含 `bash/read/write/edit`。
5. 检查环境后的请求包含真实 `bash` 工具结果，tool_call_id 匹配；没有孤立工具结果或未完成工具调用。
6. 原型原始配置对应 `thinking: { type: "disabled" }`。

执行环境配置中的 cwd 会影响工具实际运行目录，但不会自动变成一段给模型看的 cwd 提示词。当前 Point 的三个系统段没有显式说明“工具执行于当前 Mac 本机”及工作目录。这是可以完善的上下文内容；只补环境信息的两次探测中，一次调用工具、一次仍然询问，不能把它认定为完整修复。

## Pi Agent 的封装边界

Pi Coding Agent 的 `AgentSession._rebuildSystemPrompt` 从 `ResourceLoader` 取得 skills、AGENTS 等项目上下文、SYSTEM/APPEND_SYSTEM 配置，再调用 `buildSystemPromptState`，组合默认身份、工具摘要、工具规则、文档说明和 cwd。

Durable 提供相应的组合机制：扩展 `sections`、会话 `instructions`、tools、hooks；**它不会默认替应用扫描 AGENTS/skills，也不会自动装入 Pi 编程助手的角色提示词。** `CodingTools` 注册四种工具，未附带上述 Pi 应用层资源加载逻辑。

应用为个人助手提供自己的角色、记忆和会话 sections，是正常的使用方式。没有复用 Pi 编程助手身份，本身不等于上下文构建有 bug。

官方示例 `packages/durable/test/examples/15-system-prompt.ts` 展示由应用提供身份、cwd、项目指令等 sections；`26-coding-agent.ts` 也显式定义 Coding 扩展并注入 cwd。

## 实际 Pi SDK 默认配置检查

运行了真正的 `createAgentSession` 与 `ModelRuntime`，使用独立目录、内存设置和会话，禁用外部资源加载；同样在 `onPayload` 截获并中断，未调用提供商网络。

| Pi SDK 选项 | session 实际 thinkingLevel | DeepSeek 请求 |
|---|---|---|
| 不指定 thinkingLevel | high | thinking enabled |
| 显式指定 off | off | thinking disabled |

Pi 源码的基础默认值是 `medium`，随后按模型能力调整。这个版本的 DeepSeek Flash 不支持 medium 映射，因此实际调整为 high。不能把这个结果推广为“Pi 对所有模型都默认 high”。

对应源码：`server/node_modules/@earendil-works/pi-coding-agent/dist/core/defaults.js`、`sdk.js`、`system-prompt.js`、`resource-loader.js`。

当前原型 `src/service.mjs` 在 root 和新主题会话中显式指定 `thinkingLevel: 'off'`。这是本次最关键的、已经实际核对的默认行为差异。

## 同模型决策对照：24 次请求

所有请求均为 DeepSeek Flash，工具参数 schema 保持 Durable 当前版本，输出上限为 2048；同一条件执行两次。第二轮反转条件顺序。开启思考的探测请求 medium，提供商请求实际为 `thinking enabled`、`reasoning_effort: high`。

Pi 提示词来自本机安装的官方 1.3.0 `buildSystemPromptState`，工具摘要和规则也来自同版本工具定义，不是人工改写的“类似 Pi”提示词。决策探测没有执行模型返回的工具，也没有向现有会话追加消息。

“调用工具”只表示下一次模型回答包含工具调用，不表示已启动应用或完整任务成功。

| 条件 | 思考关闭：调用工具 | 思考开启：调用工具 |
|---|---:|---:|
| 重放“打开微信”前的原始历史 | 0/2 | 2/2 |
| Point 提示词，干净会话，19 个工具 | 0/2 | 2/2 |
| Pi 默认提示词，干净会话，4 个工具 | 0/2 | 2/2 |
| 重放检查环境后的原始历史和工具结果 | 1/2 | 2/2 |

额外四组仅在关闭思考下检查：

| 条件 | 调用工具 |
|---|---:|
| Point 提示词，干净会话，4 个工具 | 0/2 |
| Pi 默认提示词，干净会话，19 个工具 | 1/2 |
| Point 提示词，补充本机环境，19 个工具 | 1/2 |
| 检查环境后的同一历史，替换 Pi 提示词，19 个工具 | 0/2 |

观察：

- 仅替换 Pi 默认提示词，没有稳定消除拒绝和确认。
- 仅把工具减少到四个，没有稳定消除该现象。
- 干净会话中也复现，不能把旧历史污染当作已确定的原因。
- 原 Point 提示词不变，只开启思考即可在本次样本中改变执行决策。
- 开启思考后的环境检查结果探测，均直接生成了 `open -a WeChat` 及检查进程的 bash 调用。

## 原型后续修正依据

应先允许选择 thinkingLevel，并将普通执行会话的默认值对齐 Pi 的默认选择与模型能力调整；保留显式 off 作为可选设置。已有会话持久化了 agent 配置，只修改新建 root 的默认值不会自动修复旧会话。

然后补充与真实宿主一致的环境/cwd section，使用自然任务做端到端验收，分别观察任务完成、工具轮次、重复确认和耗时。原有真实模型验收大量显式指定了工具名，证明了接线和任务链路，但不足以证明自然指令下的自主执行质量。

当前没有证据支持重写 Durable 上下文管理、增加无条件继续循环，或围绕微信硬编码特殊规则。

## 证据与复现

- 汇总：`infra/pi-durable-validation/runtime/context-audit-summary.json`
- 关闭思考的 16 次决策：`runtime/context-audit-2026-10-18T04-38-08.808Z/results.json`
- 干净会话开启思考的 4 次决策：`runtime/context-audit-2026-10-18T04-39-44.382Z/results.json`
- 原始历史开启思考的 4 次决策：`runtime/context-audit-2026-10-18T04-40-55.726Z/results.json`
- 实际 Pi SDK 截获记录：`runtime/native-pi-audit-2026-10-18T04-40-55.803Z/`
- 各探测目录保留输入快照、逐条件 wire 请求体和完整模型结果；不包含 API key。

在 `infra/pi-durable-validation` 运行：

```sh
node scripts/audit-context.mjs
node scripts/audit-native-pi.mjs
node scripts/audit-context.mjs --real --repeat 2 --reasoning off
node scripts/audit-context.mjs --real --repeat 2 --only point-clean-19,pi-clean-4 --reasoning medium
node scripts/audit-context.mjs --real --repeat 2 --only recorded-initial,recorded-after-probe --reasoning medium
```

`audit-context.mjs` 专门针对主会话保留的这次微信记录；需要运行中的本地服务。默认只离线检查请求体，并使用 `/state` 返回的实际思考级别；`--real` 才产生真实模型请求，`--reasoning` 显式覆盖探测级别。`audit-native-pi.mjs` 只离线检查真正的 SDK 默认请求。

审计脚本执行成功；当前 16 个 JavaScript 模块语法检查通过。未因本次只读调查重跑已有完整故障注入套件。
