> 历史调研说明（2026-10-16）：本文保留当时的调研与建议。现行产品范围和运行时选型以 [设计索引](../design/README.md) 为准；2026-10-18 已改为 Pi Durable（Agent 层）+ Steel（浏览器基础设施），并明确包含 Server 端浏览器与完整执行能力。旧的“不做浏览器/容器”等范围限制不再适用。

# 技术选型调研：持续运行 · 主动交互 Personal Agent（简历项目）

> **调研日期**：2026-10-16（Asia/Shanghai）
> **数据来源**：全部 star / license / 活跃度数字均来自 **GitHub REST API v3 实时查询**（`gh api repos/OWNER/REPO`，查询时刻 2026-10-16 10:25–11:05 UTC+8），未使用任何记忆中的旧数字。
> **本报告与既有文档的关系**：工作区已有 `proactive-personal-agent-2026.md`（赛道定位/竞品/Muse 取证）与两份 teardown。本报告**只补它没覆盖的部分：横向选型的硬数据**，不重复赛道分析。若结论冲突，以本文的 API 实测数字为准。

## ⚠️ 方法学限制（影响可核查性，必读）

1. **`web_search` 工具在本会话不可用**（provider `web-search` 未注册，非额度问题）。因此**没有做通用网页检索**。
2. 替代手段有三个，全部实际使用：
   - **GitHub REST API**（`gh api`，已认证）→ 本报告绝大多数数字的来源，可逐条复现；
   - **Hacker News Algolia API**（`hn.algolia.com/api/v1/search`）→ 用于判断社区讨论热度与争议事件；
   - **`web_fetch` / `curl` 直取官方 README、LICENSE、docs 正文** → 用于确认 license 真实条款与项目自我定位。
3. 因此：**凡涉及"社区口碑""某框架比另一框架好"的定性判断，本报告一律标注为我的分析而非事实**，并写明依据。**未能确认** 的都如实标注，未做任何推测性补全。
4. `archived` 字段、`license.spdx_id` 为 `NOASSERTION` 时，我**下载了 LICENSE 原文**再判定，不依赖 GitHub 的自动识别。

---

# A. 记忆层 / Memory 框架（重点）

## A.1 原名单实查结果

| 项目 | ★ | License（实查） | 创建 | 最后 push | 关注者 |
|---|---|---|---|---|---|
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | **67,250** | Apache-2.0 | 2023-06-20 | 2026-10-14 | 255 |
| [letta-ai/letta](https://github.com/letta-ai/letta) | **25,155** | Apache-2.0 | 2023-10-11 | **2026-09-10** | 141 |
| [getzep/graphiti](https://github.com/getzep/graphiti) | **31,800** | Apache-2.0 | 2024-08-08 | 2026-10-15 | 174 |
| [getzep/zep](https://github.com/getzep/zep)（旧仓库） | **4,961** | Apache-2.0 | 2023-04-29 | 2026-10-14 | 30 |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | **32,370** | Apache-2.0 | 2023-08-16 | **2026-10-16** | 113 |
| [memodb-io/memobase](https://github.com/memodb-io/memobase) | **2,932** | Apache-2.0 | 2024-09-03 | **2026-01-11** ⚠️ | 18 |
| [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory) | **31,240** | MIT | 2024-02-27 | 2026-10-16 | 110 |
| [neuml/txtai](https://github.com/neuml/txtai) | **13,019** | Apache-2.0 | 2020-08-09 | 2026-10-15 | 114 |
| [langchain-ai/langmem](https://github.com/langchain-ai/langmem) | **1,705** | MIT | 2025-01-21 | 2026-10-02 | 13 |
| [agiresearch/A-mem](https://github.com/agiresearch/A-mem) | **1,204** | MIT | 2025-02-25 | **2025-12-12** ⚠️ | 14 |
| [BAI-LAB/MemoryOS](https://github.com/BAI-LAB/MemoryOS) | **1,604** | Apache-2.0 | 2025-05-30 | 2026-07-07 | 11 |
| [MemTensor/MemOS](https://github.com/MemTensor/MemOS) | **11,880** | Apache-2.0 | 2025-07-06 | 2026-10-10 | 53 |
| [basicmachines-co/basic-memory](https://github.com/basicmachines-co/basic-memory) | **4,235** | **AGPL-3.0** | 2024-12-02 | 2026-10-16 | 14 |
| [mindverse/Second-Me](https://github.com/mindverse/Second-Me) | **15,682** | Apache-2.0 | 2025-03-16 | **2025-09-30** ⚠️ | 129 |

> 查询命令示例（可复现）：
> `gh api repos/mem0ai/mem0 --jq '[.full_name,.stargazers_count,.license.spdx_id,.created_at,.pushed_at]'`

## A.2 关键发现（原名单之外，且更重要的）

原名单**遗漏了三个规模最大的记忆/agent 项目**。这些是当下真正在跑量的东西：

| 项目 | ★ | License | 创建 | 最后 push | 说明（README 原文摘要） |
|---|---|---|---|---|---|
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | **101,079** | Apache-2.0 | 2025-08-31 | 2026-10-16 | "Persistent Context Across Sessions for Every Agent" — 抓取 agent 会话全过程 |
| [NevaMind-AI/memU](https://github.com/NevaMind-AI/memU) | **14,546** | **Apache-2.0**（API 报 NOASSERTION，已下载 LICENSE 原文确认） | 2025-07-29 | 2026-10-16 | "Personal memory across agents" |
| [NevaMind-AI/memUBot](https://github.com/NevaMind-AI/memUBot) | **463** | **AGPL-3.0** | 2026-01-27 | 2026-08-02 | "The Enterprise-Ready OpenClaw. Your Proactive AI Assistant That Remembers Everything" |
| [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | **29,256** | **MIT**（API 报 NOASSERTION，LICENSE 原文确认为 MIT） | 未记录于本次查询 | 2026-10-15 | "team-level memory hub for AI Agents" |
| [openmemind/memind](https://github.com/openmemind/memind) | **899** | Apache-2.0 | — | 2026-08-13 | "cognitive memory … Empowering 24/7 proactive agents like OpenClaw" |
| [letta-ai/agent-file](https://github.com/letta-ai/agent-file) | **1,209** | Apache-2.0 | 2025-03-23 | 2026-10-13 | `.af` 文件格式：把有状态 agent（含记忆）序列化为一个文件 |
| [Ar9av/obsidian-wiki](https://github.com/Ar9av/obsidian-wiki) | **3,576** | MIT | — | 2026-10-13 | Obsidian 当 agent 记忆的框架 |

**`thedotmack/claude-mem` 101k★ 这个发现值得单独强调**：它不在你的名单里，但 star 数超过 mem0 + cognee 之和。它走的是「**拦截 agent 会话 → 自动持久化**」的路线，而不是「提供一个 memory API 让你调用」。这条路线对"持续运行 agent"的适配度可能比 mem0 更高。

## A.3 值得选的候选（含优劣与风险）

### ① `mem0ai/mem0` — 生态最大，但开源版是"阉割版"
- **★ 67,250 / Apache-2.0 / 最后 push 2026-10-14 / 认证贡献者 ≥100**

**官方 README 自述（一手，2026-10 版）里的关键一句**：
> "Scores reflect Mem0's managed platform, **which includes proprietary optimizations not available in the open-source SDK**; open-source users should expect directionally similar gains but not identical numbers."

- ✅ **优**：社区最大、集成最多（Chrome 扩展、MCP、各 CLI 插件）、文档全、招人认知度高（简历上 HR/面试官认得）。
- ⚠️ **坑（重要）**：官方**明确承认开源 SDK 与云平台效果不等价**。README 上的 LoCoMo 92.5 / LongMemEval 94.4 是**云版成绩，不是你能自托管跑出来的成绩**。如果你的简历里写了这些 benchmark 数字，会被面试官问穿。
- 🎯 **适用性判断**：适合"我要一个能用的记忆 API，接受它是个黑盒"。

### ② `letta-ai/letta` + `letta-ai/letta-code` — 唯一"状态化 agent"正统，但主仓库已停更
- **letta 主仓库：★ 25,155 / Apache-2.0 / 最后 push 2026-09-10（已 36 天）/ open issues = 0**
- **letta-code：★ 3,627 / Apache-2.0 / 最后 push 2026-10-16 / 51 位贡献者**

**这是本次调研发现的最重要的一条状态变化**。Letta 官方文档（docs.letta.com，我已抓取）现在把开源 harness 指向 **`letta-ai/letta-code`**：
> "The Letta agent harness is fully **open source** and builds on our lab's latest research"
> …链接指向 `https://github.com/letta-ai/letta-code`

同时 `letta-ai/lettabot` 已 **archived**，README 写明 *"has been replaced by Letta Code channels/schedules!"*。

- ✅ **优**：记忆即 agent 状态（不是外挂检索），**MemFS / 共享记忆 / schedules（定时）/ channels（Telegram·Slack·Discord·WhatsApp·Signal）全都官方自托管支持**。文档里直接有 "Self-hosting → Channels"、"Schedules → recurring prompts"、"Memory & dreaming" —— **对"持续运行 + 主动交互"这个需求，Letta 的官方能力映射度高得惊人**。
- ⚠️ **风险**：
  - 主仓库 36 天无提交、issues 数为 0（关闭策略激进或转移阵地），**重心明显已迁到 letta-code**；跟错仓库会踩空。
  - 商业公司主导（Letta Inc.），有 cloud 产品，存在"开源版做引流"的长期风险。
- 🎯 **适用性判断**：如果你要的是"**一个有身份、有记忆、有排程的常驻 agent 本体**"，Letta 是目前形态最贴合的。但如果 Point 的定位是"不做 agent 本体、只做注意力治理层"（见 `proactive-personal-agent-2026.md` §4），Letta 是**竞品参照物而非依赖**。

### ③ `getzep/graphiti` — 时序知识图谱，学术与工程都站得住
- **★ 31,800 / Apache-2.0 / 最后 push 2026-10-15 / 64 位贡献者**
- ⚠️ **注意**：`getzep/zep`（4,961★）是**旧项目**，现在的重点是 graphiti。HN 上 2024-09-04 的 Show HN《Graphiti – LLM-Powered Temporal Knowledge Graphs》**142 pts / 21 评论**，是这类项目里讨论度最高的之一（来源：HN Algolia API）。

- ✅ **优**：**时序**建模（记忆有有效期、事实会演化）——这对"主动 agent"特别关键：**「这条信息现在还有效吗」是决定该不该开口的核心判断**。用纯向量库做不出这个。
- ⚠️ **风险**：需要 Neo4j / FalkorDB 之类的图数据库。**注意 license**：`FalkorDB/FalkorDB`（★ 10,173）是 **SSPL**（已下载 LICENSE 原文确认，Server Side Public License v1），**不是 OSI 认证的开源协议**——若要求"完全开源"，图后端要选 **Neo4j Community（GPLv3）** 或直接用 **Kuzu/embedded**。
- 🎯 **适用性判断**：**如果你只选一个记忆框架做深，"时序图谱"是最有差异化的一条路**（理由见 §D.4）。

### ④ `topoteretes/cognee` — 数据管道式记忆，增长极快
- **★ 32,370 / Apache-2.0 / 最后 push 2026-10-16（当天）/ ≥100 位贡献者**

- ✅ **优**：活跃度是全名单最高档（当天有提交）、许可干净、把"记忆"当 ETL 管道做（load → cognify → search），工程味重、适合写进简历的架构图。
- ⚠️ **风险**：★ 从 2023 年仓库起家但近期增速陡（2026 年爆发），**API 稳定性未知**；文档与代码同步速度需自己验证（本次未逐版本核对）。
- 🎯 **适用性判断**：适合"我想展示我懂数据工程 + 记忆"的组合。

### ⑤ `supermemoryai/supermemory` — 明确宣称可完全本地跑
- **★ 31,240 / MIT / 最后 push 2026-10-16**
- **README 原文**："Memory and context engine + app that is extremely fast, scalable, and **can be run fully locally**."
- **生态**：`claude-supermemory`（2,788★）、`supermemory-mcp`（1,722★）、`openclaw-supermemory`（797★）、`opencode-supermemory`（1,633★）、Codex/Cursor 插件。**它同时向"闭源 CLI 做插件"和"开源 CLI 做插件"两条线扩张**。

- ✅ **优**：**MIT + 自称可完全本地**，是"完全开源可自托管"要求下 license 最宽松的高星选项；一堆现成插件说明它有真实使用量。
- ⚠️ **风险**：**同时是商业公司**（有 memory API 云服务），"fully locally"的自托管完整度需要实测（本次未部署验证，**未能确认**）。另外 `claude-supermemory` / `openclaw-supermemory` 等插件仓库 `license` 字段为空（`none`）—— **这些插件严格来说没有声明 license**，不能当开源组件用。
- 🎯 **适用性判断**：如果你想要 "MCP memory server 现成可用"，它是适配度最高的之一。

### ⑥ `basicmachines-co/basic-memory` — Markdown 即记忆，但 AGPL
- **★ 4,235 / AGPL-3.0 / 最后 push 2026-10-16 / Python**

- ✅ **优**：**Markdown 文件即记忆，人类可读可改可 git 版本控制** —— 这与 `proactive-personal-agent-2026.md` §4.6 硬约束 #2（"记忆必须用户可读可改可删的明文"）**完全一致**，是设计上最对味的一个。
- ⚠️ **风险**：**AGPL-3.0**。若你的项目要"完全开源"，AGPL 是合规的；但如果面试方是公司、或你未来想接商业场景，AGPL 会被法务直接过滤（与 nanoMuse 的 GPL 问题同源，见既有文档 §2.2）。
- 🎯 **适用性判断**：**作为设计参照极好，作为依赖需权衡**。

### A.4 A 方向的明确排除项（"看起来很美但是坑"）

| 项目 | 实查数字 | 为什么是坑 |
|---|---|---|
| `memodb-io/memobase` | 2,932★ / Apache-2.0 / **最后 push 2026-01-11（已 9 个月）** | **事实停更**。写进简历的技术栈如果已经 9 个月没动，是负分。 |
| `agiresearch/A-mem` | 1,204★ / MIT / **最后 push 2025-12-12（已 10 个月）** | **论文配套代码，非产品**。学术仓库通常发完论文就冻结。另注意：常用路径 `agiresearch/A-Memory` **404**，正确名是 `agiresearch/A-mem`（大小写敏感）。 |
| `mindverse/Second-Me` | 15,682★ / Apache-2.0 / **最后 push 2025-09-30（已 12.5 个月）** | ★ 很高但**已一年未更新**。典型"star 泡沫"：宣传期冲高后弃坑。 |
| `langchain-ai/langmem` | **1,705★** / MIT | ★ 只有 1.7k，且是 LangChain 生态的**边缘组件**（对比 LangGraph 43k★）。用它等于绑定 LangChain 全家桶，而 LangChain 的 API 变动是业内公认的痛。 |
| `BAI-LAB/MemoryOS` | 1,604★ / Apache-2.0 / 4 个月无提交 | 规模与活跃度都不足。 |
| `MemTensor/MemOS` | 11,880★ / Apache-2.0 | ★ 尚可且活跃，但**与 MemoryOS 同名易混**（一个是 `BAI-LAB/MemoryOS`，一个是 `MemTensor/MemOS`），且都偏学术 demo。 |
| `neuml/txtai` | 13,019★ / Apache-2.0 / 活跃 | **不是 memory 框架**，是 embeddings 数据库 + 语义工作流。把它当记忆层用会缺"记忆生命周期管理"。 |

---

# B. Agent 框架 / Runtime

## B.1 实查数据

| 项目 | ★ | License | 最后 push | 备注 |
|---|---|---|---|---|
| [n8n-io/n8n](https://github.com/n8n-io/n8n) | 207,554 | **Sustainable Use License**（非 OSI） | 2026-10-16 | — |
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | **43,332** | MIT | 2026-10-15 | Python；JS 版 `langgraphjs` 仅 3,357★ |
| [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | **59,750** | MIT | 2026-10-16 | — |
| [agno-agi/agno](https://github.com/agno-agi/agno) | **42,760** | Apache-2.0 | 2026-10-16 | — |
| [microsoft/autogen](https://github.com/microsoft/autogen) | 61,434 | CC-BY-4.0 | **2026-04-15** | ⛔ **官方 maintenance mode** |
| [ag2ai/ag2](https://github.com/ag2ai/ag2) | 4,996 | Apache-2.0 | 2026-10-15 | AutoGen 社区分叉 |
| [microsoft/agent-framework](https://github.com/microsoft/agent-framework) | **14,148** | MIT | 2026-10-15 | AutoGen 官方继任者 |
| [openai/openai-agents-python](https://github.com/openai/openai-agents-python) | **30,061** | MIT | 2026-10-15 | JS 版 `openai-agents-js` 3,921★ |
| [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai) | **20,649** | MIT | 2026-10-16 | **open issues 1,466** |
| [huggingface/smolagents](https://github.com/huggingface/smolagents) | 29,865 | Apache-2.0 | 2026-10-06 | — |
| [google/adk-python](https://github.com/google/adk-python) | 21,867 | Apache-2.0 | 2026-10-15 | — |
| [anthropics/claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python) | 8,289 | MIT | 2026-10-15 | — |
| [mastra-ai/mastra](https://github.com/mastra-ai/mastra) | 28,838 | **Apache-2.0 + `ee/` 例外** | 2026-10-16 | 见下方 license 说明 |
| [vercel/ai](https://github.com/vercel/ai) | 27,338 | **Apache-2.0**（API 报 NOASSERTION，已下载确认） | 2026-10-15 | — |

**License 逐条核实结果**（这几条 API 都返回 `NOASSERTION`，我下载了正文）：
- `vercel/ai` → **Apache-2.0**，干净。
- `mastra-ai/mastra` → LICENSE.md 原文："All content that resides under any directory named `ee/` … is licensed under the license defined in `ee/LICENSE`" + 其余部分 Apache-2.0。→ **core 是 Apache-2.0，但有企业闭源模块**。
- `open-webui/open-webui` → **自定义 "Open WebUI License"**，非标准开源协议。原文："Redistribution and use … are permitted provided that the following conditions are met" 且带品牌/规模限制条款（完整条款需细读）。
- `langfuse/langfuse` → "Content outside of the above mentioned directories [ee/] is licensed under MIT" → **核心 MIT + ee/ 例外**。
- `Arize-ai/phoenix` → **Elastic License 2.0**（已下载确认）。
- `kortix-ai/suna` → **Elastic License 2.0**，原文明确禁止 *"provide the software to third parties as a hosted or managed service"*。

## B.2 结论与坑

### ⛔ 最大的坑：AutoGen
`microsoft/autogen` 的 README 首屏有醒目 CAUTION 块，原文：
> **⚠️ Maintenance Mode** — AutoGen is now in maintenance mode. **It will not receive new features or enhancements** and is community managed going forward. New users should start with **Microsoft Agent Framework**. … Contributions are limited to bug fixes, security patches, and documentation improvements.

- 最后提交 **2026-04-06**，标题就是 *"Update maintenance mode banner in readme"*。
- **★ 61,434 是历史遗产，不代表可投入**。这是本报告里**最危险的一个"高 star 陷阱"**。
- 另一个坑：`microsoft/autogen` 的 `license.spdx_id` 是 **CC-BY-4.0** —— 这是**文档协议，不是软件协议**。用它做代码库有实际法律歧义。
- 若你仍想走 AutoGen 血统：用 **`microsoft/agent-framework`（14,148★ / MIT / 2026-10-15）**，注意它只有 14k★ 且创建于 2025-04-28，**相对年轻**。

### 值得选的 3 个

**① `langchain-ai/langgraph` — 持续运行场景的事实标准**
- **★ 43,332 / MIT / 2026-10-15 / 189 watchers / 810 open issues**
- ✅ **优**：checkpointer（状态持久化）+ interrupt（人工审批）+ 时间旅行重放，**这三件事正好是"常驻 agent + 注意力审批 + 可评测"的地基**。ecosystem 最大，简历认知度最高。
  - 同一组织还有一个高度相关的教学仓库：**`langchain-ai/ambient-agent-101`（35★，2026-10-12）**，主题就是通过构建 ambient email agent 学 LangGraph —— **说明"ambient/proactive agent"已经是 LangChain 官方认可的范式**。
- ⚠️ **风险**：抽象层厚、API 演进快、依赖 LangChain 生态。**810 个 open issues** 是维护压力的信号。
- 🎯 **对 Point 的意义**：如果你想讲"我的 Decision Log 支持时间旅行重放"，LangGraph 的 checkpointer 是最省力的实现路径；但若按既有文档 §4.7「不引入 LangGraph」的决议，则应自写 —— **两者取舍取决于你是否愿意为省力牺牲架构独立性**。

**② `openai/openai-agents-python` — 最薄、最少概念**
- **★ 30,061 / MIT / 2026-10-15 / open issues 仅 7**
- ✅ **优**：**只有 7 个 open issues**（对比 pydantic-ai 的 1,466、agno 的 1,903、LangGraph 的 810）—— 这个比例说明维护响应极好或用户基数与 issue 量匹配良好。API 面小，一天能读完。
- ⚠️ **风险**：OpenAI 主导，虽然 MIT 且支持非 OpenAI 模型，但**长期战略可能偏向推动自家 API**。会话持久化能力弱于 LangGraph。
- 🎯 **适合**：想要"薄内核"，与既有文档 §5「自研最薄内核」的取向一致。

**③ `mastra-ai/mastra`（TypeScript 路线）**
- **★ 28,838 / Apache-2.0(core) + ee/ / 2026-10-16**
- ✅ **优**：TS 生态里功能最全（workflows + agents + memory + evals + 本地 dev server），适合全栈 TS 项目。
- ⚠️ **风险**：有 `ee/` 闭源模块（**需逐个确认你依赖的路径不在 ee/ 下**）；`vercel/ai` 是更底层的替代。

### B.3 明确排除

| 项目 | 实查 | 原因 |
|---|---|---|
| `microsoft/autogen` | 61,434★ / CC-BY-4.0 / maintenance mode | ⛔ 官方宣判停止演进 |
| `pydantic/pydantic-ai` | 20,649★ / **1,466 open issues** | issue 积压比例偏高（~7% of stars），单人跟进成本高 |
| `agno-agi/agno` | 42,760★ / **1,903 open issues** | 同上，且 agno 由 phidata 改名而来（跨多个产品定位），方向连续性有疑问 |
| `vercel/ai` | 27,338★ / Apache-2.0 | **它不是 agent runtime，是 LLM 调用 + streaming 层**。单独用它做常驻 agent 要自己补状态机。 |
| `google/adk-python` | 21,867★ | 可用，但生态与文档成熟度明显落后于 LangGraph；且与 Google Cloud 有隐性耦合倾向（**未能确认**具体程度） |
| `anthropics/claude-agent-sdk-python` | 8,289★ | 是 Claude Code 的封装；**你已经在用 DeepSeek Harness，方向重叠** |

---

# C. 持续运行 / 后台 Agent 基础设施

## C.1 实查数据

| 项目 | ★ | License | 最后 push | 语言 |
|---|---|---|---|---|
| [temporalio/temporal](https://github.com/temporalio/temporal) | **23,738** | MIT | 2026-10-16 | Go |
| [n8n-io/n8n](https://github.com/n8n-io/n8n) | 207,554 | **Sustainable Use License** | 2026-10-16 | TypeScript |
| [PrefectHQ/prefect](https://github.com/PrefectHQ/prefect) | 24,025 | Apache-2.0 | 2026-10-15 | Python |
| [apache/airflow](https://github.com/apache/airflow) | 47,185 | Apache-2.0 | 2026-10-16 | Python |
| [windmill-labs/windmill](https://github.com/windmill-labs/windmill) | 18,196 | **AGPLv3 + Apache-2.0 + 专有** 混合 | 2026-10-16 | Rust |
| [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev) | **16,550** | Apache-2.0 | 2026-10-15 | TypeScript |
| [hatchet-dev/hatchet](https://github.com/hatchet-dev/hatchet) | **8,124** | MIT | 2026-10-15 | Go |
| [inngest/inngest](https://github.com/inngest/inngest) | 5,945 | **SSPL v1**（已确认原文） | 2026-10-16 | Go |

**License 逐条核实**：
- `inngest/inngest` → LICENSE.md 开头即 **"Server Side Public License, Version 1.0"**。**SSPL 不是 OSI 认证的开源协议**（这也是 MongoDB 当年的争议点）。对"完全开源"要求是硬伤，与 FalkorDB 同一类问题。
- `windmill-labs/windmill` → 原文："Source code in this repository is variously licensed under the Apache License Version 2.0 … **or the AGPLv3 License** … and **a proprietary license for certain enterprise features**."  `backend/` 是 AGPLv3（`enterprise` 编译标志下的除外）。
- `n8n-io/n8n` → "**Sustainable Use License**"，且 "Source code files that contain `.ee.` … are NOT licensed under the Sustainable Use License"。**非 OSI 开源**。

**HN 讨论度参考**（HN Algolia API，可复现）：
- Hatchet：【578 pts / 189 评论】"Show HN: Hatchet – Open-source distributed task queue"（2024-03-08）；【245 pts / 95 评论】Launch HN（YC W24，2024-06-27）；【240 pts / 74 评论】"Hatchet v1 – A Postgres-based task orchestration platform"（2025-04-03）。**三次登上 HN 且讨论热烈，社区验证充分。**

## C.2 事件驱动 vs 调度 —— 这个区分对你的项目是关键

**「持续运行 + 主动交互」的本质不是 cron，是"世界变了要通知我"**。由此：

| 模式 | 代表 | 适配你的需求吗 |
|---|---|---|
| **纯调度（cron/时间触发）** | Prefect、Airflow | ⚠️ 部分。Muse 用了 ~24 个每日 cron（见既有文档 §1.1），但那是"每小时抽取记忆"这类**内部维护**，不是"该不该跟用户说话" |
| **事件驱动 + 持久化执行（durable execution）** | Temporal、Hatchet、Inngest、Trigger.dev | ✅ **本质匹配**。核心价值是：**进程崩溃/重启后，一个"正在等待用户审批的主动建议"不会丢失** |
| **低代码工作流编排** | n8n、Windmill | ⚠️ 偏集成，不是 runtime |

**为什么 durable execution 对"主动 agent"是刚需（我的分析）**：
主动 agent 的典型生命周期是 `发现事件 → 判断要不要说 → 等用户回应（可能几小时）→ 根据回应行动`。这是一条**跨小时甚至跨天的长事务**，且中间要等一个不可控的外部输入。普通进程模型下，重启即丢失；**这与你既有文档 §4.3「决策审计 + 被压下的候选」直接相关：如果决策状态会丢，审计就是假的。**

不过注意：`CopilotKit/openmuse` 用 **~250 行 SQL 租约引擎**（1 秒 tick + CAS + 心跳续租 + `LostLeaseError`）就实现了这一点（见既有文档 §2.1）。**这是"自建 vs 引入 Temporal"的真实取舍基准：你要的能力，250 行就能覆盖大部分。**

## C.3 值得选的候选

**① `hatchet-dev/hatchet` — 单人项目的最佳平衡点**
- **★ 8,124 / MIT / 2026-10-15 / 90 位贡献者 / 138 open issues**
- ✅ **优**：**MIT（不是 SSPL）** + **Postgres-based**（不需要额外引入 Kafka/Cassandra 这类重型依赖）+ Go 单二进制 + 三次 HN 热帖验证。对单人自托管，**"只依赖 Postgres"是极大的运维优势**。
- ⚠️ **风险**：★ 只有 8k，生态小于 Temporal；被 YC 投资意味着有商业化压力（长期 license 变更风险需留意）。
- 🎯 **判断**：**如果你决定引入 durable execution，这是首选。**

**② `temporalio/temporal` — 工业标准，但对单人过重**
- **★ 23,738 / MIT / 2026-10-16 / ≥100 贡献者 / 1,063 open issues**
- ✅ **优**：MIT、最成熟、Uber 血统、简历上写 Temporal 是加分项（招聘市场认可度最高）。
- ⚠️ **风险**：**需要 Cassandra/MySQL/Postgres + 多个服务组件 + Elasticsearch(可选)**，本地开发要跑 `temporal server start-dev`，生产部署复杂度对单人业余项目**不成比例**。1063 个 open issues。
- 🎯 **判断**：**"简历镀金"用途 > 实际需要**。如果你只是想让简历上有 Temporal，可以考虑用它做一个独立的小 demo，而不是作为 Point 的主干。

**③ `triggerdotdev/trigger.dev` — 如果走 TypeScript**
- **★ 16,550 / Apache-2.0 / 2026-10-15**
- ✅ Apache-2.0 干净、★ 高于 Hatchet、TS 原生、有不错的本地 dev 体验。
- ⚠️ 以 Node/TS 为中心；自托管部署文档不如 Temporal 成熟（**未能确认**当前自托管完整度）。

**④ 自建 `cron + SQLite 租约队列` — 被低估的选项**
- 依据：openmuse 用 ~250 行实现了完整的租约/幂等/审计（既有文档 §2.1 逐文件核对）。
- ✅ **零依赖、完全可控、能写进简历的技术叙事更强**（"我为什么不用 Temporal"是个好面试题）；与你既有文档 §4.5「调度：自写 tick + SQLite lease，不上 Temporal/Redis」的结论**一致**。
- ⚠️ 要自己处理：时钟漂移、重复执行、失败重试、可观测性。

### C.4 明确排除

| 项目 | 原因 |
|---|---|
| `inngest/inngest` | **SSPL v1，非 OSI 开源**。对"完全开源"要求直接出局。 |
| `n8n-io/n8n` | 207k★ 极诱人，但 **Sustainable Use License 非 OSI 开源**，且它是低代码集成平台，不是你的 runtime 层。 |
| `windmill-labs/windmill` | **许可混合（AGPL + 专有 enterprise）**，且混合协议给合规审计带来麻烦。 |
| `apache/airflow` / `PrefectHQ/prefect` | 都是**数据管道调度器**，心智模型是 DAG 批处理，不是"长驻等待外部事件"。用它做主动 agent 会别扭。 |
| `FlowiseAI/Flowise` | **`archived: true`（2026-08-13 归档）** ⛔ |
| `reworkd/AgentGPT` | **`archived: true`** ⛔；`GPL-3.0` |
| `TransformerOptimus/SuperAGI` | 最后 push **2025-01-22**（21 个月无更新）⛔ |
| `microsoft/JARVIS` | 最后 push **2025-07-29**，4,221 open issues ⛔ |

---

# D. 主动式 / Proactive Agent 的开源先例

> **这是本次调研发现最大信息量的一节**。原名单里的项目（Khoj / Leon / OpenHands / Suna 等）大多是"聊天式"或"任务式"agent，**真正的 proactive/always-on 开源项目是另一批**，且规模惊人。

## D.1 通过 GitHub 搜索 API 发现的真正相关项目

搜索命令：`gh api -X GET search/repositories -f q="proactive agent in:name,description" -f sort=stars`

| 项目 | ★ | License | 最后 push | 说明（README 原文摘要） |
|---|---|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | **392,126** | MIT | 2026-10-16 | 见 §D.2 —— **这个品类的绝对巨兽** |
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem) | 101,079 | Apache-2.0 | 2026-10-16 | 跨会话持久上下文 |
| [agentscope-ai/QwenPaw](https://github.com/agentscope-ai/QwenPaw) | 35,732 | Apache-2.0 | 2026-10-16 | "Your Personal AI Assistant; deploy on your own machine" |
| [whiteguo233/OpenBiliClaw](https://github.com/whiteguo233/OpenBiliClaw) | 3,452 | MIT | 2026-10-15 | "本地私有、开源的自进化跨平台 AI 内容发现 Agent：**先理解你，再主动**…" |
| [proma-ai/Proma](https://github.com/proma-ai/Proma) | 2,222 | AGPL-3.0 | 2026-09-26 | "Built for 100× professionals and **the proactive Agent era**" |
| [hhyqhh/inno-agent](https://github.com/hhyqhh/inno-agent) | 1,298 | MIT | 2026-10-14 | "**three-layer memory** (learner profile / wiki knowledge base / cross-conversation recall), **a proactive scheduler**, personal IM channels" |
| [capitalone/VulnHunter](https://github.com/capitalone/VulnHunter) | 1,104 | Apache-2.0 | 2026-10-07 | 企业级 proactive 安全分析 |
| [existence-master/Sentient](https://github.com/existence-master/Sentient) | 704 | **NOASSERTION** | 2026-10-15 | "running on your own computer. Long-running tasks, **real memory, proactive help**" |
| [thunlp/ProactiveAgent](https://github.com/thunlp/ProactiveAgent) | 676 | Apache-2.0 | **2026-05-12** | ICLR 2025 论文，桌面事件流→任务预测。**这条路线的开创者** |
| [freddy-schuetz/n8n-claw](https://github.com/freddy-schuetz/n8n-claw) | 559 | **none** | 2026-10-11 | "OpenClaw-inspired autonomous AI agent built entirely in n8n" |
| [goruck/home-generative-agent](https://github.com/goruck/home-generative-agent) | 317 | MIT | 2026-10-16 | **Home Assistant** 的生成式 agent：自然语言建自动化、摄像头分析 |
| [smixs/agent-second-brain](https://github.com/smixs/agent-second-brain) | 402 | MIT | 2026-08-05 | "**always-on second brain** you talk to. Voice notes in Telegram → typed, linked knowledge in your Obsidian vault" |
| [AFK-surf/Comma](https://github.com/AFK-surf/Comma) | 261 | AGPL-3.0 | 2026-10-03 | "**Always-on, proactive, sessionless.** Browser, computer use, files" |
| [ssdavidai/alfred](https://github.com/ssdavidai/alfred) | 234 | **none** | 2026-09-14 | "Personal agentic infrastructure. Self-hosted. Always on." |
| [gluonfield/jaz](https://github.com/gluonfield/jaz) | 86 | Apache-2.0 | 2026-10-14 | "**loops that run overnight**, boards, memory, and git control" |
| [ClickHouse/nerve](https://github.com/ClickHouse/nerve) | 89 | Apache-2.0 | 2026-10-15 | "Self-hosted AI agent runtime — personal assistants, autonomous workers" |
| [langchain-ai/ambient-agent-101](https://github.com/langchain-ai/ambient-agent-101) | 35 | **none** | 2026-10-12 | **LangChain 官方的 ambient agent 教学仓库** |
| [nexus-research-lab/nexus](https://github.com/nexus-research-lab/nexus) | 152 | Apache-2.0 | 2026-10-10 | "persistent, proactive AI agents across rooms, workspaces" |

其他搜索关键词的结果（证明这个生态已经很大）：
- `"always-on agent"` → [beclab/Olares](https://github.com/beclab/Olares) 5,309★（AGPL-3.0，"**Open-Source Personal Cloud OS for Always-On Agents**"）、[unpeel-com/unpeel](https://github.com/unpeel-com/unpeel) 141★、[isala404/Tera](https://github.com/isala404/Tera) 96★（WhatsApp always-on）
- `"ambient agent"` → [saxenauts/syke](https://github.com/saxenauts/syke) 60★（AGPL-3.0，"ambient memory agent"）、[hao-ai-lab/hawky](https://github.com/hao-ai-lab/hawky) 31★
- `"personal AI assistant self-hosted"` → 上面多数 + [open-octo/octo-agent](https://github.com/open-octo/octo-agent) 130★（MIT，**single-binary**）、[ArgentAIOS/argentos-core](https://github.com/ArgentAIOS/argentos-core) 127★、[Bredrumb/TomoriBot](https://github.com/Bredrumb/TomoriBot) 53★（Discord）

## D.2 ⭐ 最重要的发现：OpenClaw 生态

**[openclaw/openclaw](https://github.com/openclaw/openclaw) — ★ 392,126 / 82,456 forks / MIT / 创建 2025-11-24 / 最后 push 2026-10-16 / TypeScript / 1,708 关注者 / ≥100 贡献者**

这可能是 2026 年最成功的开源 agent 项目。README 原文要点：
> "OpenClaw is an open-source AI assistant that runs on your own computer and meets you in the channels you already use: **Discord, iMessage, Slack, Teams, Telegram, WhatsApp, and 20+ more**, plus native apps for macOS, iOS, Android, Windows, and Linux."
> "**State, memory, and credentials live on your hardware.** Models and agent harnesses (Claude, Codex, local models) are **plugins you can swap**."
> "stewarded by the **OpenClaw Foundation**, an independent 501(c)(3), and has **no paid tier, hosted service, or token**."
> 架构原则："**trusted gateway, untrusted execution, policy enforced by code**"

**命名历史（重要，避免混淆）**：据 HN 标题与 `cloudflare/moltworker` README，它经历了 **Clawdbot → Moltbot → OpenClaw** 多次改名。

**⚠️ 生态风险（HN Algolia 实测，这是最值得注意的信号）**：
| HN 标题 | 分数 | 评论 | 日期 |
|---|---|---|---|
| "**Claude Code refuses requests or charges extra if your commits mention "OpenClaw"**" | **1,349** | 720 | 2026-04-30 |
| "**Tell HN: Anthropic no longer allowing Claude Code subscriptions to use OpenClaw**" | **1,099** | 827 | 2026-04-03 |
| "**Google restricting Google AI Pro/Ultra subscribers for using OpenClaw**" | **802** | 705 | 2026-02-22 |
| "OpenClaw – Moltbot Renamed Again" | 667 | 382 | 2026-01-30 |

**解读（我的分析）**：OpenClaw 证明了"自托管 always-on agent"是真实巨大需求，但**它同时验证了这个赛道最大的系统性风险：你依赖的模型厂商可以单方面切断你**。Anthropic 与 Google 都做过限制，两次都上了 HN 头条（1000+ 分）。
→ **这对你的项目是战略级情报**：一个"必须能换模型、不绑定任何单一厂商"的设计不是洁癖，是这个赛道的**生存条件**。你的 README 值得把这个作为卖点写。（既有的 `proactive-personal-agent-2026.md` §3.3 已把 OpenClaw 列为"已排除的重型底座"，本文补充的是**它的生态风险**这一面。）

**生态卫星（说明 OpenClaw 已形成平台）**：
| 项目 | ★ | License | 说明 |
|---|---|---|---|
| [VoltAgent/awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills) | 53,153 | MIT | **5,400+ skills** 分类整理 |
| [hesamsheikh/awesome-openclaw-usecases](https://github.com/hesamsheikh/awesome-openclaw-usecases) | 31,661 | MIT | 用例集 |
| [spinabot/brigade](https://github.com/spinabot/brigade) | 11,335 | MIT | "Your personal intelligence, built enterprise-grade" |
| [cloudflare/moltworker](https://github.com/cloudflare/moltworker) | 9,951 | Apache-2.0 | 在 Cloudflare Workers 上跑 OpenClaw |
| [ValueCell-ai/ClawX](https://github.com/ValueCell-ai/ClawX) | 7,605 | MIT | OpenClaw 的桌面 GUI |
| [supermemoryai/openclaw-supermemory](https://github.com/supermemoryai/openclaw-supermemory) | 797 | **none** | 记忆插件 |
| [duxiaoxiong/memu-engine-for-OpenClaw](https://github.com/duxiaoxiong/memu-engine-for-OpenClaw) | 54 | NOASSERTION | memU 记忆插件 |

## D.3 原名单项目的实查结果

| 项目 | ★ | License | 最后 push | 判断 |
|---|---|---|---|---|
| [khoj-ai/khoj](https://github.com/khoj-ai/khoj) | **37,696** | **AGPL-3.0** | **2026-08-02**（2.5 个月） | 活跃但放缓；AGPL；定位是"second brain + 调度 automations" |
| [leon-ai/leon](https://github.com/leon-ai/leon) | 17,579 | MIT | 2026-10-12 | 活跃；MIT 干净；但仍是"语音助手"范式，主动性弱 |
| [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | **91,010** | MIT | 2026-10-16 | ⚠️ **仓库已迁移**（`All-Hands-AI/OpenHands` → 301 → `OpenHands/OpenHands`）。软件工程 agent，不是 personal agent |
| [kortix-ai/suna](https://github.com/kortix-ai/suna) | 20,278 | **Elastic License 2.0** | 2026-10-16 | ⛔ **ELv2 禁 hosted service**，非 OSI 开源 |
| [open-webui/open-webui](https://github.com/open-webui/open-webui) | **155,835** | **自定义 Open WebUI License** | 2026-10-16 | ⚠️ 非标准开源协议；是 chat UI，不是 agent |
| [home-assistant/core](https://github.com/home-assistant/core) | 91,540 | Apache-2.0 | 2026-10-16 | 参考价值高（家居场景的自动化/触发模型成熟），但不是 agent 框架 |
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | **118,107** | MIT | 2026-10-16 | ✅ 见 §E |
| [OthersideAI/self-operating-computer](https://github.com/OthersideAI/self-operating-computer) | 10,291 | MIT | **2025-09-19**（13 个月） | ⛔ 已停滞，且 computer-use 已有更好方案 |
| `Ironclaw` / `Morphik` / `Scout` / `Andy` | — | — | — | **未能确认**：本次以 GitHub 搜索 API 与 HN Algolia 检索，未找到与描述匹配的明确对应仓库。可能是拼写不同、或非 GitHub 项目、或已改名。**不做推测。** |

**关于 `OpenHands/software-agent-sdk`**：★ 1,260 / MIT / 2026-10-16 / 创建 2025-08-23 —— OpenHands 团队把 SDK 拆了出来，**779 open issues 相对 1,260★ 说明还很毛糙**。

## D.4 与原名单项目相比，真正值得学的先例

按"对 Point 的可借鉴度"排序（我的判断）：

1. **`thedotmack/claude-mem`（101k★）** — "拦截会话自动持久化"路线。**它的 star 数是 mem0 + cognee 之和，却不在任何记忆框架榜单里**，值得你亲自读一遍它的实现，理解为什么这条路线更受欢迎。
2. **`smixs/agent-second-brain`（402★ / MIT）** — **"always-on second brain" + Telegram 语音输入 → Obsidian**。这是"个人 + 常驻 + 主动"最贴近 Point 形态的小而美实现，2025-12-26 创建、215 forks。**建议精读。**
3. **`THUNLP/ProactiveAgent`（676★）** — 学术开创者，ICLR 2025。**但注意最后 push 2026-05-12 且创建于 2024-09-19**，属于"论文已发、代码冻结"。
4. **`goruck/home-generative-agent`（317★ / MIT / 2026-10-16 活跃）** — Home Assistant 场景，**触发-条件-动作**这套成熟范式可以直接迁移到注意力治理。
5. **`AFK-surf/Comma`（261★ / AGPL）** — "always-on, **proactive, sessionless**"，"sessionless" 这个词值得注意（对常驻 agent 的正确抽象）。
6. **`beclab/Olares`（5,309★ / AGPL）** — "Personal Cloud OS for Always-On Agents"，作为自托管基础设施参考。

---

# E. 协议 / 接口

## E.1 实查数据

| 项目 | ★ | License | 最后 push | 创建 |
|---|---|---|---|---|
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | **91,293** | **MIT → Apache-2.0 迁移中** | 2026-10-13 | 2024-11-19 |
| [modelcontextprotocol/modelcontextprotocol](https://github.com/modelcontextprotocol/modelcontextprotocol)（规范） | 9,458 | NOASSERTION | 2026-10-15 | 2024-09-24 |
| [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk) | **24,591** | MIT | 2026-10-13 | 2024-09-24 |
| [punkpeye/fastmcp](https://github.com/punkpeye/fastmcp) | 3,275 | MIT | 2026-10-14 | 2024-12-27 |
| [a2aproject/A2A](https://github.com/a2aproject/A2A) | **26,169** | Apache-2.0 | 2026-10-15 | 2025-03-25 |
| [ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui) | **16,608** | MIT | 2026-10-15 | 2025-05-07 |
| [Arize-ai/openinference](https://github.com/Arize-ai/openinference) | 1,266 | Apache-2.0 | 2026-10-16 | 2023-12-26 |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | **38,212** | Apache-2.0 | 2026-10-08 | 2025-03-21 |
| [browserbase/stagehand](https://github.com/browserbase/stagehand) | 25,691 | MIT | 2026-10-16 | 2024-03-24 |
| [simular-ai/Agent-S](https://github.com/simular-ai/Agent-S) | 12,625 | Apache-2.0 | 2026-10-08 | 2024-10-09 |
| [microsoft/OmniParser](https://github.com/microsoft/OmniParser) | 25,528 | CC-BY-4.0 | 2026-07-20 | 2024-09-20 |
| [microsoft/UFO](https://github.com/microsoft/UFO) | 10,041 | MIT | 2026-10-14 | 2024-01-08 |

## E.2 关键治理变化：MCP 已捐给 Linux Foundation

**`modelcontextprotocol/servers` 的 LICENSE 原文**（已下载）：
> "The MCP project is undergoing a licensing transition **from the MIT License to the Apache License, Version 2.0**… All new code and specification contributions to the project are licensed under Apache-2.0. **Documentation contributions (excluding specifications) are licensed under CC-BY-4.0.** Contributions for which relicensing consent has been obtained are licensed under Apache-2.0. Contributions made by authors who originally licensed their work under the MIT License and who have not yet consented are…"

HN 佐证（Algolia 实测）：【288 pts / 145 评论】"Donating the Model Context Protocol and establishing the **Agentic AI Foundation**"（2025-12-09）；另有 2025-12-11 与 2026-01-06 的后续讨论。

- ✅ **结论**：**MCP 已成事实标准且治理中立化（Linux Foundation 旗下）**，license 从 MIT → Apache-2.0 是升级（含专利授权）。对"完全开源"要求是最安全的选择。
- ⚠️ 注意：规范仓库 `modelcontextprotocol/modelcontextprotocol` 的 `license.spdx_id` 是 `NOASSERTION` —— 它是**规范文档**仓库，license 情况需以 `servers` 那份 transition 说明为准（`docs` 部分 CC-BY-4.0）。

## E.3 AG-UI 与 A2A 的实际采纳情况

- **`a2aproject/A2A`** ★ 26,169 / Apache-2.0 —— 但 HN 上 2026-06-18 有一帖 **"Ask HN: Is anyone using the A2A protocol?"（96 pts / 45 评论）**，标题本身就说明**实际采纳存疑**。另有【6 pts】"OpenAI rejects 1,200-line community PR for Google's A2A agent protocol"（2025-10-30）。
  → **我的判断**：A2A 是"厂商中立宣言"性质更强，**真实多 agent 互操作需求在单人项目里几乎不存在**。**Skill 层面不必投入。**
- **`ag-ui-protocol/ag-ui`** ★ 16,608 / MIT / 2025-05-07 创建 —— HN 仅【36 pts】"Show HN: AG-UI Protocol"（2025-05-13），但有一条【7 pts】"**Microsoft Embraces AG-UI Protocol for Agent UI**"（2025-11-20）。
  → **我的判断**：AG-UI 解决的是"agent 状态 → 前端"的标准化。**如果你要做 Web/TUI 双前端，这是"先定协议再写界面"的现成答案**（呼应既有文档 §2.2 的 `UI Protocol` 建议）。**比 A2A 优先级高。**

## E.4 OTel GenAI / 可观测性

- **`Arize-ai/openinference`** ★ 1,266 / Apache-2.0 / 2026-10-16（活跃）—— 但 **★ 只有 1.3k**，注意区分它（OpenInference 约定）与 `Arize-ai/phoenix`（★ 11,862，**Elastic License 2.0**）。
- 对比参照：[langfuse/langfuse](https://github.com/langfuse/langfuse) ★ 35,882 / **核心 MIT + `ee/` 例外** / 2026-10-15。

**判断（我的分析）**：对单人项目，**Langfuse 是更实际的选择**（★ 是 openinference 的 28 倍，核心 MIT，自托管成熟）。但**注意两个 license 反转**：
- Langfuse 的 `license.spdx_id` 是 `NOASSERTION`，**核心 MIT 但 `ee/` 是例外**（LICENSE 原文已确认）。
- Phoenix 是 **Elastic License 2.0**，不是 OSI 开源。
→ **如果你要"完全开源"，Langfuse 核心可用（避开 ee/），Phoenix 需谨慎。**

## E.5 Computer-use

| 项目 | ★ | License | 判断 |
|---|---|---|---|
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | **118,107** | MIT | ✅ **首选**。★ 极高、MIT、2026-10-16 活跃、483 关注者。Python 原生，接你的栈最省力 |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 38,212 | Apache-2.0 | ✅ 若走 MCP 路线，这是官方级选择（1 个 open issue，维护极佳） |
| [browserbase/stagehand](https://github.com/browserbase/stagehand) | 25,691 | MIT | ✅ TS 首选；但 Browserbase 是商业公司（有云服务） |
| [simular-ai/Agent-S](https://github.com/simular-ai/Agent-S) | 12,625 | Apache-2.0 | 学术向 computer-use |
| [microsoft/UFO](https://github.com/microsoft/UFO) | 10,041 | MIT | Windows 专用，不适合 |
| [microsoft/OmniParser](https://github.com/microsoft/OmniParser) | 25,528 | **CC-BY-4.0** | ⚠️ **CC-BY-4.0 不是软件协议**，作为代码依赖有歧义；最后 push 2026-07-20 |

**关于 Anthropic computer use / OpenAI Operator**：两者都是**闭源托管产品**，没有可自托管的开源实现。**本次未查询其官方文档，不做判断。** 对"完全开源可自托管"的要求，这两条路直接不适用（除非通过 `browser-use` 这类替代实现同等能力）。

**既有文档已决议"不做浏览器/容器/computer use"（§4.7）** —— 若坚持该决议，本节仅作技术储备记录。

---

# F. 前端形态

## F.1 实查数据

| 项目 | ★ | License | 最后 push | 语言 |
|---|---|---|---|---|
| [Textualize/textual](https://github.com/Textualize/textual) | **37,465** | MIT | 2026-10-09 | Python |
| [vadimdemedes/ink](https://github.com/vadimdemedes/ink) | 40,113 | MIT | 2026-10-03 | TypeScript |
| [charmbracelet/bubbletea](https://github.com/charmbracelet/bubbletea) | 45,426 | MIT | 2026-10-08 | Go |
| [charmbracelet/wish](https://github.com/charmbracelet/wish) | 5,557 | MIT | 2026-10-04 | Go |
| [tauri-apps/tauri](https://github.com/tauri-apps/tauri) | **111,935** | Apache-2.0 | 2026-10-15 | Rust |
| [electron/electron](https://github.com/electron/electron) | 123,346 | MIT | 2026-10-16 | C++ |
| [binwiederhier/ntfy](https://github.com/binwiederhier/ntfy) | **34,846** | Apache-2.0 | 2026-10-16 | Go |
| [gotify/server](https://github.com/gotify/server) | 16,073 | **NOASSERTION**（LICENSE 文件未通过 API 返回，**未能确认**具体协议） | 2026-10-15 | Go |
| [apprise/apprise](https://github.com/apprise/apprise) | **未能确认**（API 404 / 未取到） | — | — | — |
| [zhayujie/CowAgent](https://github.com/zhayujie/CowAgent)（原 chatgpt-on-wechat） | 47,419 | MIT | 2026-10-15 | Python |

## F.2 判断

| 形态 | 推荐 | 理由 |
|---|---|---|
| **TUI** | **`Textualize/textual`**（37,465★ / MIT / 活跃） | 你是 Python 栈，Textual 是同语言最优解；`Rich` 同作者。既有文档 §4.5 已定"v1 只做 CLI（Rich）"，Textual 是自然升级路径 |
| TUI（备选） | `charmbracelet/bubbletea`（45,426★） | ★ 更高但需 Go；跨语言调用成本对单人不划算 |
| **桌面** | **`tauri-apps/tauri`**（111,935★ / Apache-2.0） | 体积/内存远优于 Electron，Rust 后端可复用；⚠️ 但引入 Rust 构建链对单人业余项目是额外负担 |
| 桌面（避坑） | `electron/electron`（123,346★ / MIT） | ★ 略高但产物体积 100MB+、内存占用高。**对简历项目是"没加分、有减分"的选择** |
| **手机通知** | **`binwiederhier/ntfy`**（34,846★ / Apache-2.0 / 活跃） | ✅ **全名单里通知方案最干净的**：Apache-2.0、★ 34k、可完全自托管（含 iOS/Android App）、HTTP PUT 即用。**强烈推荐** |
| 通知（替代） | Telegram Bot / Discord Webhook | 零运维（不用自己部署），但**依赖第三方平台**——参见 OpenClaw 被 Anthropic/Google 限制的教训。**建议 ntfy 为主、Telegram 为备** |
| 微信 | `zhayujie/CowAgent`（47,419★ / MIT） | ⚠️ 微信个人号自动化有**封号风险与 ToS 问题**，且上游协议频繁变动。**不建议作为主渠道** |

**关于 `apprise/apprise`**：这是"多通知渠道统一抽象"的库（一个 API 支持 100+ 渠道），本应很适合。但**本次 API 查询未取到数据（404）**，**未能确认**其当前 ★ 与 license，故不列为推荐。若要统一多渠道，值得你手动确认一下。

---

# G. 隐私 / 本地优先

## G.1 实查数据

| 项目 | ★ | License | 最后 push | 语言 |
|---|---|---|---|---|
| [ollama/ollama](https://github.com/ollama/ollama) | **183,352** | MIT | 2026-10-16 | Go |
| [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | **131,319** | MIT | 2026-10-16 | C++ |
| [ml-explore/mlx](https://github.com/ml-explore/mlx) | 28,801 | MIT | 2026-10-15 | C++ |
| [exo-explore/exo](https://github.com/exo-explore/exo) | 47,910 | Apache-2.0 | 2026-10-13 | Python |
| [lancedb/lancedb](https://github.com/lancedb/lancedb) | 11,682 | Apache-2.0 | 2026-10-16 | Rust |
| [chroma-core/chroma](https://github.com/chroma-core/chroma) | 29,511 | Apache-2.0 | 2026-10-15 | Rust |
| [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) | 8,190 | Apache-2.0 | **2026-05-18**（5 个月）⚠️ | C |
| [tursodatabase/libsql](https://github.com/tursodatabase/libsql) | 17,276 | MIT | 2026-10-13 | C |
| [menloresearch/jan](https://github.com/janhq/jan)（原名 janhq/jan） | 44,963 | **Apache-2.0**（已下载确认） | 2026-10-16 | Rust |
| [FalkorDB/FalkorDB](https://github.com/FalkorDB/FalkorDB) | 10,173 | **SSPL v1** | 2026-10-15 | Rust |
| [hexgrad/kokoro](https://github.com/hexgrad/kokoro)（TTS） | 9,342 | Apache-2.0 | **2025-08-06**（14 个月） | — |

**License 注意事项**：
- `FalkorDB/FalkorDB` → **SSPL v1**（已下载 LICENSE 原文，与 MongoDB 同源），**非 OSI 开源**。若用 Graphiti，**不要选 FalkorDB 作为图后端**（除非你能接受 SSPL）。
- `janhq/jan` → 仓库已改名为 **`menloresearch/jan`**（`janhq/jan` 仍可访问并返回正确数据）。LICENSE 原文是标准 Apache-2.0。
- `asg017/sqlite-vec` → Apache-2.0 但**最后 push 2026-05-18，已 5 个月**。它是很多本地向量方案的基石，**这个停滞值得警惕**（对比 LanceDB / Chroma 都在当天/前一天有提交）。

## G.2 判断与推荐组合

**推理层**：
- **`ollama/ollama`（183,352★ / MIT / 当天活跃）** —— 首选。**★ 是本报告全表最高之一**，MIT，模型管理体验最好，OpenAI-compatible API 让"云端 ↔ 本地"可一行切换。
- `llama.cpp`（131,319★ / MIT）—— 底层更灵活（GGUF 量化、CPU/GPU 混合），但 API 层要自己包。**作为 Ollama 的底层存在，通常不用直接选它。**
- `ml-explore/mlx`（28,801★ / MIT）—— **Apple Silicon 上性能最好**（你在 macOS 上开发，这点相关）。适合让本地推理不那么慢。
- `exo-explore/exo`（47,910★ / Apache-2.0）—— 多机分布式推理。**对单人项目是过度设计**，不推荐。

**向量/存储**：
- **`sqlite-vec`（8,190★ / Apache-2.0）** —— 与既有文档 §4.5 的"SQLite 单文件"决策最一致。⚠️ **但需注意它 5 个月未更新**；建议把它设计成**可替换的一层**（接口化），万一停更要能换 LanceDB。
- `lancedb/lancedb`（11,682★ / Apache-2.0 / 活跃）—— 嵌入式，是 sqlite-vec 的合理替代。
- `chroma-core/chroma`（29,511★ / Apache-2.0）—— ★ 最高但**从 Python 重写为 Rust 后定位变化较大**，且通常需要独立进程。
- **避免**：FalkorDB（SSPL）、Neo4j Enterprise。

**加密**：本次**未查到具体项目数据**（未查询 age/sqlcipher/gpg 等），**不做推荐**。方向性提示：SQLite 加密可考虑 SQLCipher / SQLite 内置加密扩展；文件级可用 `age`。**这些需要单独调研确认，本报告不编造数字。**

## G.3 ⚠️ 来自既有文档的一个必须补的洞

`proactive-personal-agent-2026.md` §2.2 记录了一条**关键的 taint 规则漏洞**（来自 nanoMuse 自己声明的边界）：
> "每条 memory 都会进入 system prompt 发给 chat model；开启语义召回后，**每条记忆和每条消息的文本也会发给 embedding 端点**（只有本地 Ollama 才不外泄）；而 **embedding 调用不算 tool call，因此落在 taint 规则之外**。"

**这条对 G 方向的直接结论**：**如果你宣称"本地优先/隐私优先"，embedding 必须走本地（Ollama / MLX），否则你的记忆层本身就是最大的数据外泄点。** 这不是理论风险——它是同类项目已经踩到的具体洞。建议把它写成一条**测试用例**（"断言：启用语义召回后，无任何非本地端点被调用"）。

---

# 二、推荐技术栈组合

## 2.1 约束回顾

| 约束 | 含义 |
|---|---|
| 单人开发 | 不能引入需要多人运维的组件；每天可维护的东西有限 |
| 3–6 个月业余时间 | 若按每周 10 小时算，总计约 **130–260 小时**。这是**非常有限**的预算 |
| 要能写进简历 | 需要"可演示 + 技术叙事清晰 + 面试官能 git clone 验证" |
| **完全开源可自托管** | **所有依赖必须 OSI 开源，且不依赖任何闭源 SaaS** |

**第 4 条是本报告最重要的过滤条件**，它一次性排除了：
`inngest`(SSPL)、`n8n`(Sustainable Use)、`suna`(ELv2)、`phoenix`(ELv2)、`FalkorDB`(SSPL)、`open-webui`(自定义)、`makemore/openmuse`(CopilotKit Intelligence SaaS)、以及 `claude-supermemory`/`openclaw-supermemory` 等 **license 字段为空（`none`）的插件仓库**。

## 2.2 推荐组合（主方案）

> **前提**：本方案**沿用**既有文档 §4.2 的定位决议（Point = 跨 agent 的注意力治理层 + 评测 harness），**不重复造 agent 本体**。若你已改变定位，主方案需相应调整。

| 层 | 选择 | ★ | License | 理由 |
|---|---|---|---|---|
| **语言** | Python 3.12+ | — | — | 与既有文档 §4.5 一致；IMAP/CalDAV/MCP 生态最好；Textual/browser-use 同栈 |
| **对外协议** | **MCP** (`modelcontextprotocol/python-sdk`) | 24,591 | MIT | ✅ **唯一治理中立（Linux Foundation）+ 协议中立 + MIT 的选项**。任何 agent 都能接 |
| **存储** | **SQLite**（WAL + FTS5）+ `sqlite-vec`（接口化） | 8,190 | Apache-2.0 | 单文件可导出、零运维；向量层做成可替换以对冲 sqlite-vec 的停滞风险 |
| **调度** | **自写 tick + SQLite 租约**（参照 openmuse `engine/worker.ts` 设计，重写不复制） | — | — | 零依赖；既有文档 §4.5 已决议；**"我为什么不用 Temporal"是好的面试叙事** |
| **审计/溯源** | 自写 `decision_log` 表 | — | — | 既有文档 §4.6 硬约束 #2/#3 要求；**这是差异化核心，不适合外包给框架** |
| **记忆（若需要）** | **参照设计，谨慎引入**：Graphiti 若你能接受图库；否则自写"Markdown + SQLite" | — | — | 见 §2.3 讨论 |
| **本地模型** | `ollama/ollama` + 可选 `ml-explore/mlx` | 183,352 / 28,801 | MIT | 保证"无 API key 也能跑"（既有文档 §4.5 的要求）；embedding **必须本地**（见 §G.3） |
| **通知** | `binwiederhier/ntfy`（主）+ Telegram Bot（备） | 34,846 | Apache-2.0 | ntfy 完全自托管 + App；Telegram 作为降级路径，**避免单点依赖**（OpenClaw 教训） |
| **前端 v1** | CLI：`Rich` → 升级 `Textualize/textual` | 37,465 | MIT | 先定 UI 协议，再写界面（既有文档 §2.2 的建议） |
| **前端 v2** | 只读 Web（Timeline / Decision Log / Digest） | — | — | **不做 Tauri/Electron**：对简历无加分，工程量翻倍 |
| **可观测** | `langfuse/langfuse`（**只用核心，避开 `ee/`**） | 35,882 | MIT + ee/ 例外 | 自托管成熟、★ 最高。⚠️ 有 `ee/` 闭源目录，需确认依赖路径 |
| **评测** | `pytest` + 确定性 scenario 断言 | — | — | 既有文档 §4.3 支柱 2；**"能被面试官 `git clone && make eval` 验证"是生死线** |
| **打包** | `uv` / `pipx` / `docker compose` | — | — | 一条命令跑起来 |
| **License** | **Apache-2.0** | — | — | 含专利授权，采用面最广（既有文档 §4.5 已定） |

## 2.3 关于"是否引入记忆框架"的关键取舍（我的分析）

**结论：主力自写薄记忆层（Markdown + SQLite），把记忆框架当作"参照物 + 可选插件"而非地基。**

> ⚠️ **勘误（2026-10-16）**：原文写的是「Markdown + SQLite + **本地 embedding**」。**「本地」已废弃**——用户不打算本地跑模型，且托管 embedding 与托管 chat model 属同一暴露等级。embedding 本身也从「地基」降级为**可选优化**（默认用 SQLite FTS5/BM25）：决策层若是一次模型调用，模型能从原始上下文判断相关性与新颖性，不必预先算向量。

理由（三条，都可核查）：
1. **你需要的记忆形态，现有框架都不给**。既有文档 §4.6 硬约束 #2（用户可读可改、用户改过的是权威、后台 job 不得覆盖）与 #3（**删除要真删**）是**产品约束，不是检索能力**。mem0/graphiti 卖的是检索效果，**没有一个把"用户编辑优先"和"可证明的删除"当作核心特性**。这部分必须自写。
2. **引框架会带来 license 与依赖风险**：唯一"MIT + 自称可完全本地"的高星选项是 supermemory，但它同时是商业公司（自托管完整度**未能确认**）；basic-memory 设计最对味但是 **AGPL**；FalkorDB（Graphiti 常用后端）是 **SSPL**。
3. **但你要精读两个**：`basic-memory`（Markdown 即记忆的正确形态）和 `graphiti`（**时序**——"这条事实现在还有效吗"是主动 agent 判断该不该开口的核心依据，纯向量库做不出）。**读设计、写自己的实现**，这样面试时你能讲得比抄的清楚（既有文档 §5 对 openmuse 也是同一建议）。

## 2.4 替代方案

**方案 B：TypeScript 全栈**
- `mastra-ai/mastra`（28,838★，Apache-2.0 core + `ee/`）+ `vercel/ai`（27,338★，Apache-2.0）+ `browserbase/stagehand`（25,691★，MIT）+ `vadimdemedes/ink`（40,113★，MIT）
- ✅ 前后端同语言，前端体验更好
- ⚠️ Mastra 有 `ee/` 需规避；TS 的 agent 生态成熟度低于 Python（LangGraph JS 仅 3,357★ vs Python 43,332★）
- 🎯 **适合**：你更擅长 TS，或想强调"全栈能力"

**方案 C：引入 durable execution**
- 把"自写 tick + SQLite 租约"换成 `hatchet-dev/hatchet`（8,124★ / MIT / Postgres-based）
- ✅ 崩溃恢复/重试/可观测性现成；简历上 Hatchet 或 Temporal 是加分项
- ⚠️ 引入额外部署组件；**偏离既有文档 §4.7 的决议**
- 🎯 **适合**：你预计 3 个月内会做到"跨天的多步审批流"，自写租约开始吃力

**方案 D：借力 Letta 而非自研 agent 本体**
- 用 `letta-ai/letta-code`（3,627★ / Apache-2.0 / 活跃）+ Letta 官方 self-hosting channels/schedules
- ✅ 官方已支持 Telegram/Slack/Discord/WhatsApp/Signal + schedules —— **"持续运行 + 主动交互"的官方能力映射度最高**
- ⚠️ **与你既有文档的核心定位（做 agent 之上的治理层）冲突**；且主仓库 36 天未更新、重心转移中
- 🎯 **适合**：你改变定位、决定"做一个更好的常驻 agent"而不是"做注意力治理层"

---

# 三、"看起来很美但是坑"的选项（汇总）

## 3.1 ⛔ 硬坑：已死或已宣判

| 项目 | 表面 | 实际 |
|---|---|---|
| `microsoft/autogen` | 61,434★，微软，多 agent 开创者 | **官方 maintenance mode**，README 首屏 CAUTION 明写不再加新功能，最后提交 2026-04-06。license 是 **CC-BY-4.0（文档协议）**。**本报告最大的高 star 陷阱** |
| `memodb-io/memobase` | 2,932★，Apache-2.0 | **最后 push 2026-01-11，已 9 个月** |
| `agiresearch/A-mem` | 1,204★，MIT，论文 | **最后 push 2025-12-12，已 10 个月**。且正确路径是 `agiresearch/A-mem`（`A-Memory` 404） |
| `mindverse/Second-Me` | **15,682★**，Apache-2.0 | **最后 push 2025-09-30，已 12.5 个月**。高 star 但弃坑 —— **典型 star 泡沫** |
| `FlowiseAI/Flowise` | 55,505★ | **`archived: true`**（2026-08-13 归档） |
| `reworkd/AgentGPT` | 36,278★ | **`archived: true`**，GPL-3.0 |
| `RooCodeInc/Roo-Code` | 24,276★ | **`archived: true`**（2026-05-15） |
| `TransformerOptimus/SuperAGI` | 17,705★ | 最后 push **2025-01-22**（21 个月） |
| `microsoft/JARVIS` | 25,439★ | 最后 push 2025-07-29，**4,221 open issues** |
| `OthersideAI/self-operating-computer` | 10,291★ | 最后 push **2025-09-19**（13 个月） |
| `open-webui/pipelines` | 2,443★ | 最后 push **2025-08-18**（14 个月） |
| `letta-ai/lettabot` | — | **archived**，被 letta-code 取代 |

## 3.2 ⛔ License 坑（对"完全开源"要求是致命的）

| 项目 | ★ | 真实协议 | 问题 |
|---|---|---|---|
| `inngest/inngest` | 5,945 | **SSPL v1** | 非 OSI 开源（MongoDB 同源争议协议） |
| `kortix-ai/suna` | 20,278 | **Elastic License 2.0** | 明确禁止提供 hosted/managed service |
| `n8n-io/n8n` | **207,554** | **Sustainable Use License** | 非 OSI；`.ee.` 文件另有企业协议 |
| `windmill-labs/windmill` | 18,196 | **AGPLv3 + Apache-2.0 + 专有 混合** | 混合协议合规审计麻烦 |
| `FalkorDB/FalkorDB` | 10,173 | **SSPL v1** | 若用 Graphiti，别选它做图后端 |
| `Arize-ai/phoenix` | 11,862 | **Elastic License 2.0** | 非 OSI |
| `open-webui/open-webui` | **155,835** | **自定义 Open WebUI License** | 非标准协议，含品牌/规模条款 |
| `mastra-ai/mastra` | 28,838 | Apache-2.0 **+ `ee/` 闭源** | core 可用，但**必须确认依赖不在 `ee/` 下** |
| `langfuse/langfuse` | 35,882 | MIT **+ `ee/` 闭源** | 同上（我仍推荐它，但要用对） |
| `microsoft/autogen` / `microsoft/OmniParser` | — | **CC-BY-4.0** | **文档协议当软件协议用**，有法律歧义 |
| `supermemoryai/claude-supermemory`(2,788★)、`openclaw-supermemory`(797★)、`opencode-supermemory`(1,633★)、`ssdavidai/alfred`(234★)、`freddy-schuetz/n8n-claw`(559★)、`langchain-ai/ambient-agent-101`(35★) | — | **license 字段为空（`none`）** | **没有任何 license 声明 = 默认保留所有权利**，严格来说不能当开源组件使用 |

## 3.3 ⚠️ 高 star 但形态不对（用了会白干）

| 项目 | ★ | 为什么不对 |
|---|---|---|
| `openclaw/openclaw` | **392,126** | 不是"坑"，是**巨兽**。你要的是"薄 + 可控 + 能讲清"，它是 20+ 渠道 + 多端 App + 插件系统。**且它有真实的平台依赖风险**（Anthropic/Google 都限制过它，两次登上 HN 1000+ 分）。**当参照物读，别当底座** |
| `browser-use/browser-use` | **118,107** | 极优秀，但**computer-use 是独立的巨大工程量**。既有文档 §4.7 已决议不做 |
| `thedotmack/claude-mem` | **101,079** | 形态是"拦截会话自动持久化"，与"记忆生命周期管理"不是一回事。**值得精读，但不一定适合当依赖** |
| `OpenHands/OpenHands` | **91,010** | 软件工程 agent，与 personal agent 场景不同。**且仓库已迁移**（`All-Hands-AI/OpenHands` → `OpenHands/OpenHands`）—— 按旧路径写进简历会 404 |
| `open-webui/open-webui` | **155,835** | 是 chat UI，不是 agent runtime，且非标准开源协议 |
| `apache/airflow` / `PrefectHQ/prefect` | 47,185 / 24,025 | 数据管道 DAG 调度器，心智模型不匹配"长驻等待外部事件" |
| `FalkorDB`(10,173★) | — | 生态小于预期且 SSPL；`getzep/zep`(4,961★) 已是旧仓库，重心在 graphiti |
| `pydantic/pydantic-ai` | 20,649 | **1,466 open issues**（约 star 的 7%），单人跟进成本高 |
| `agno-agi/agno` | 42,760 | **1,903 open issues**；且经历 phidata → agno 多次定位变更 |
| `nemotron`/`A2A` | 26,169 | HN 有 **"Ask HN: Is anyone using the A2A protocol?"（96pts）** —— **采纳存疑**，单人项目无互操作需求 |
| `exo-explore/exo` | 47,910 | 多机分布式推理，单人项目过度设计 |
| `eval`/`OmniParser` | 25,528 | CC-BY-4.0 + **2026-07-20 后无提交** |

---

# 四、最容易做出「差异化亮点」的技术切入点（3 个）

> 判断标准：(a) 大厂做了但没做对/只给开关；(b) 学术有基础但**没有工程对应物**；(c) 单人 3 个月能做出可演示版本；(d) 完全开源可自托管。

## 🥇 切入点 1：**可解释的沉默 —— 决策审计与"为什么没告诉你"**

**为什么是它**：
- **Meta Muse 官方承认这是核心难题**（既有文档 §1.1 引原文："a proactive message has to be genuinely helpful **and worth the interruption**"），而它的解法**只是"默认保守 + 一个旋钮"**。OpenAI dot 的解法是"你自己选它能做什么 + 随时暂停"。**两家都把这个决定推给了用户配置。**
- **现有开源项目全部只做"说"，没人做"不说的审计"**。OpenClaw 有 Heartbeat 但只有 per-agent 的 30s 最小间隔 + flood guard（既有文档 §3.3），**没有全局视角，也没有"被压下的候选"记录**。
- 学术上有 TRACE（拆分 answer quality / delay / **false alarms** / **missed windows**）作为理论支撑，但**是离线数据集与评分脚本，不是能挂在自己 agent 上的工具**。

**具体做什么**：`decision_log` 表记录每次裁决的 `reasons[]` + **被压下的候选**，提供 `point decisions --explain <id>`，能回答"**你昨天为什么没告诉我这件事？**"

**为什么是差异化**：这是一个**反向能力**——所有人都在比"谁更主动"，你在做"**可证明的克制**"。面试时这句话本身就是一个完整的技术叙事，且**几乎无法被大厂功能表复制**（因为大厂的商业模式要求活跃度）。

---

## 🥈 切入点 2：**时序有效性 —— "这条信息现在还说吗"**

**为什么是它**：
- 主动 agent 的**核心判断**不是"我知道什么"，而是"**这条信息现在还有效吗**"。纯向量库（mem0 默认形态）和"全量塞 context"都做不出这个。
- **Graphiti 证明了工程可行性**（31,800★ / Apache-2.0 / 2026-10-15 活跃 / 64 贡献者），它的定位就是 **temporal** knowledge graph（HN Show HN 142 pts）。**但它的设计目标是"给 agent 提供记忆检索"，不是"给注意力治理层提供时效判断"。**
- 学术上有 **OverAct**（arXiv 2610.01508，2026-10-01）研究 "proactive over-authorization"（agent 越权读取超出请求所需的数据），提出 SelfAudit 减少 43% 隐私越界 —— **说明"主动性的边界"正被学术当作独立问题研究，但还没有工程化产物。**

**具体做什么**：记忆条目带 **`valid_from` / `valid_until` / `superseded_by` / `asserted_by`（用户明说 vs 系统推断）/ `confidence`**；Salience 打分里"时效性"是一项**可回归测试**的维度。既有文档 §4.6 硬约束 #4 已经要求 `asserted_by` + `confidence` —— 本切入点是把这条约束**做成一个可评测的具体机制**。

**为什么是差异化**：它同时解决了**主动性**（该不该现在说）和**信任**（区分"你说的"和"我猜的"）两个问题，而后者正是 Muse 被公众反弹最猛的点（既有文档 §1.2：Muse 的 Instagram skill 被明确指示**不要区分**推断与明说）。**在大厂那是被爆出的丑闻，在你这是默认架构 —— 免费的差异化。**

---

## 🥉 切入点 3：**可回放的主动性回归测试（Replay Harness）**

**为什么是它**：
- **度量方式存在于论文里，但缺工程化 harness**（既有文档 §3.1 已确认：60+ benchmark，但**全是离线数据集**）。`refixai/proactivity-sdk` 只有 **15★** —— 这个生态位**已被验证存在、但完全没被占住**。
- **PROACTIVITY-GYM 的真人研究结论直接给你产品决策背书**（既有文档 §3.1 引原文）："participants show **sharp trust declines after intervention misalignment despite correct outcomes**, and prefer **sleep-time assistance**, even when imperfect, to preserve ongoing focus."
  → **"做对了事但打断时机不对，信任会断崖式下跌"** —— 这一条足以论证"时机比内容更重要"，从而论证 harness 的价值。
- **nanoMuse 自己承认这是空白**（既有文档 §2.2 引 roadmap 原文）："a personal agent is also judged by **whether it knows you** and **whether it asked at the right moments**. **We do not have a way to measure that yet.**" —— **连最完整的开源同类项目都公开承认不会测。**

**具体做什么**：事件流录制/回放（**时间可加速**）+ 可插拔 agent adapter（走 MCP）+ persona-conditioned 模拟用户 + 指标（Interruption Precision / **False-silence rate** / Interruptions per day / Budget adherence / Time-to-signal / Trust proxy）+ **CI 断言**（"改动 salience 权重后 precision 不得下降超过 X"）+ **A/B 对比出图**。

**为什么是差异化**：这是**简历里最有说服力的一张图**（同一事件流跑两套策略，输出差异），且**能被面试官 `git clone && make eval` 直接验证**。三个切入点是递进关系：**1 定义能力 → 2 提供判据 → 3 证明有效**。

---

# 附录 A：数据复现方法

所有数字可用以下命令复现（需 `gh` 已认证）：

```bash
# 单个仓库核心字段
gh api repos/OWNER/REPO --jq '[.full_name, (.stargazers_count|tostring),
  (.license.spdx_id // "NONE"), (.pushed_at|split("T")[0]),
  (.created_at|split("T")[0]), (.archived|tostring),
  (.open_issues_count|tostring)] | @tsv'

# license 原文（当 spdx_id 为 NOASSERTION 时必查）
gh api repos/OWNER/REPO/license --jq '.content' | base64 -d | head -c 600

# 贡献者数量
gh api "repos/OWNER/REPO/contributors?per_page=100" --jq 'length'

# 仓库检索（发现新项目）
gh api -X GET search/repositories -f q="proactive agent in:name,description" \
  -f sort=stars -f order=desc -f per_page=20 \
  --jq '.items[] | [.full_name, (.stargazers_count|tostring),
    (.license.spdx_id // "none"), (.pushed_at|split("T")[0]),
    ((.description // "")|.[0:110])] | @tsv'

# HN 社区信号（无需认证）
curl -s "https://hn.algolia.com/api/v1/search?query=QUERY&tags=story&hitsPerPage=10"
```

# 附录 B：本次"未能确认"清单（如实披露）

| 项 | 情况 |
|---|---|
| `apprise/apprise` | GitHub API 返回 404，**未能确认** ★ 与 license |
| `gotify/server` | `license.spdx_id` 为 `NOASSERTION`，且 LICENSE 文件未通过 API 返回，**未能确认**具体协议 |
| `Ironclaw` / `Morphik` / `Scout` / `Andy` | 以 GitHub 搜索 API + HN Algolia 检索**未找到匹配仓库**，**未能确认**是否存在同名项目 |
| `lingzhi/...`（`agent-second-brain` 的 star 语义） | ★ 402 系 API `stargazers_count`，与“watchers”字段在不同 API 版本下语义有别，已统一按 `stargazers_count` |
| `supermemory` 自托管完整度 | README 自称 "can be run fully locally"，**本次未实际部署验证** |
| `trigger.dev` 自托管完整度 | **未能确认** |
| `microsoft/OmniParser` 的 CC-BY-4.0 适用性 | 作为代码依赖的法律效果**未能确认** |
| 加密方案（SQLCipher / age 等） | **本次未查询**，不做推荐 |
| Anthropic computer use / OpenAI Operator 的开源可自托管路径 | **未查询官方文档**，不做判断 |
| 各框架"社区口碑优劣" | `web_search` 不可用，**未做通用检索**；报告中的优劣判断均已标注为我的分析 |
| `langfuse` / `mastra` 的 `ee/` 具体目录范围 | 已确认存在 `ee/` 例外，但**未逐个依赖核对路径** |

---

**报告完。所有 star / license / 活跃度数字查询时刻：2026-10-16 10:25–11:05 (UTC+8)，来源为 GitHub REST API v3。**
