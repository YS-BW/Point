> 历史快照：2026-10-16 切换 Pi SDK 前的设计，已被当前 docs/design/ 文档取代。这里的已定状态与技术断言不代表当前结论。

# 记忆层：先外挂（MemoryAdapter）

> 状态：**✅ 已定（2026-10-16）**
> **决策：记忆层第一版用外挂框架。接口定死，实现可换；后续可能自研或换别的。**
> ⚠️ 本文不做深度技术评估（用户明确「不用深究」）——只做选型对比 + 接口约束。

---

## 0. 为什么是「外挂」

三个现实：

1. **我们需要的记忆属性，外部框架基本都给不了**（见 §3）——所以外挂版**必然是临时方案**
2. **但现在不知道「记忆到底有没有用」** ——先接一个跑起来，看到效果再决定要不要自研
3. **所以真正要定的不是「选哪个」，而是「接口长什么样」**

> **结论：`MemoryAdapter` 接口是正式设计；具体实现是临时件。**

---

## 1. 候选对比（2026-10-16 实查）

> **筛选口径**：**license 不作为筛选条件**（项目本身完全开源，用户已明确）。下表只按**技术定位**排序；license 列仅作信息，不用于排除。

### A 类：成熟 drop-in 记忆层

| 项目 | ★ | License（信息） | 语言 | 定位 | 备注 |
|---|---|---|---|---|---|
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | **67,279** | Apache-2.0 | Python | "The Memory Layer for AI Agents — **Drop-in** memory infrastructure" | **定位最贴合「外挂」**；生态最大 |
| [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) | **50,256** | MIT | Python | "Agent Memory That Learns" | 会学习；较新 |
| [volcengine/OpenViking](https://github.com/volcengine/OpenViking) | **40,068** | AGPL-3.0 | Python | "**Self-evolving** Context Database for AI Agents. Unify Agent Memory, Knowledge RAG and Skills" | ⭐ **字节 volcengine 出品**；topics 里有 **`dsh-plugin`**（原生对接 DSH）；主页 openviking.ai |
| [topoteretes/cognee](https://github.com/topoteretes/cognee) | 32,382 | Apache-2.0 | Python | 开源 AI memory platform | 图 + 向量 |
| [getzep/graphiti](https://github.com/getzep/graphiti) | 31,808 | Apache-2.0 | Python | 实时**时序知识图谱** | 时序边 → 最接近我们要的「时效性」 |
| [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory) | 31,246 | MIT | TS | "**can be run fully locally**" | 可全本地；**TS（和我们的栈同语言）** |
| [letta-ai/letta](https://github.com/letta-ai/letta) | 25,163 | Apache-2.0 | — | stateful agent platform | ⚠️ **它本身就是一个 agent 平台**，会和我们的内核重叠；最后提交 2026-09-10 |

### B 类：存储形态对口的（Markdown / 文件为源）

| 项目 | ★ | License（信息） | 定位 | 备注 |
|---|---|---|---|---|
| [EverMind-AI/EverOS](https://github.com/EverMind-AI/EverOS) | 13,445 | Apache-2.0 | "One portable memory layer for every AI agent: **local-first, Markdown**" | ⭐ 形态最对口（用户可读可改） |
| [tigerless-labs/agent-memory](https://github.com/tigerless-labs/agent-memory) | 3,880 | MIT | "Long-term memory runtime — **plain Markdown as the source of truth**" | 形态对口，但**生态太小**（3.8k★） |
| [NevaMind-AI/memU](https://github.com/NevaMind-AI/memU) | 14,547 | Apache-2.0 | "**Personal** memory across agents" | 定位最贴「personal」 |

### ⛔ 硬性门槛：必须能自托管

**用户已明确：记忆层一定自托管**（不是「哪个托管方便用哪个」）。→ **不能自托管的直接出局。**

实查各家自托管形态（2026-10-16）：

| 项目 | Dockerfile | docker-compose | 自托管评价 |
|---|---|---|---|
| **mem0** | ✅ `server/Dockerfile` | ✅ `server/docker-compose.yaml` | ⭐ **一等 server + compose**；还带 **`mem0-ts`（TS SDK）** |
| **OpenViking** | ✅ | ✅ `docker-compose.yml` | ⭐ 一等 compose |
| **cognee** | ✅ | ✅ `docker-compose.yml` | ⭐ 一等 compose |
| **graphiti** | ✅ | ✅ `docker-compose.yml` | ✅ 但**需要一个图数据库**（Neo4j / FalkorDB）→ 多一个依赖 |
| **腾讯 TencentDB-Agent-Memory** | ❌ 无根 Dockerfile | ✅ 有 `MemoryCore/` 内的构建 + `deploy/` | ⭐ **`tdai-gateway.standalone.yaml` = 单机、零外部依赖**（见 C 类） |
| **EverOS** | ❌ | ❌（有 `deploy/` + Makefile） | 待核实 |
| **supermemory** | ❌ 根目录无 | — | ⚠️ 自称 "run fully locally"，但根目录无 docker 文件，待核实 |

**实用判据：有 `docker-compose` 的 = 自托管最省事。**

---

### C 类：你点名的腾讯 —— ⚠️ **我之前评价错了，实际很对味**

| 项目 | ★ | License（信息） | 语言 | 定位 |
|---|---|---|---|---|
| [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | **29,285** | MIT | TypeScript | "为任意 Agent 框架提供**四层渐进式记忆**" |

**R1 我之前写的「定位是 team-level，与单人 personal agent 不完全对齐」是错的。** 实查后：

**① 有四层记忆模型，正好是我们要的分层**

> `L0 Conversation → L1 Atom → L2 Scenario → L3 Persona` —— 原始对话逐层蒸馏

对应我们的需求：会话 → 事实 → 场景归纳 → **用户画像**。而 README 明确写：
> "**A brain that remembers people and context** — Chat Memory retains preferences, facts, decisions, and interaction history. **Each Agent automatically gets its own memory when created** — no need to re-introduce yourself next time."

**② npm 包的描述几乎逐条命中**

> `@tencentdb-agent-memory/memory-tencentdb` v1.0.3 **MIT**：
> *"Four-layer **local** memory system plugin for OpenClaw — auto-captures, structures, and profiles conversational knowledge using **local LLM + SQLite vector search** (L0→L1→L2→L3 pipeline)"*

| 命中点 | 说明 |
|---|---|
| **local + SQLite vector search** | ⭐ **和我们定的「SQLite + FTS5/向量」路线完全一致** |
| **plugin for OpenClaw** | ⭐ 明确为 agent harness 做的，不是通用 SaaS |
| **TS / npm** | ⭐ 和 pi-durable 同栈 |
| **四层 pipeline** | ⭐ 会话→事实→场景→画像 |

**③ 可以完全自托管**

`MemoryCore/` 提供两个配置模板：
- `tdai-gateway.standalone.yaml` —— **本地开发 / 单机部署 / 零外部依赖** ✅
- `tdai-gateway.service.yaml` —— K8s 多副本 / 多租户云服务

镜像 `tencentdb-agent-memory`（node:22-slim，~920MB，端口 8420）。另有 `deploy/` + `INSTALL.md` 一键部署。

**④ 但有一个张力要核实** ⚠️

> 它的四层蒸馏（L0→L1→L2→L3）需要模型，而默认是 **local LLM**。
> **而用户明确不打算本地跑模型。**

**→ 待核实：能否把它的 LLM 端点配成远程模型。** 如果只能本地 LLM，就和我们的约束冲突。

**⑤ 排除理由（非 license）**：**没有。**

### ⭐ A′ 类：OpenViking（字节 volcengine）—— 有 Pi 集成，但要写一层胶水

| 项目 | ★ | License | 语言 | 自托管 |
|---|---|---|---|---|
| [volcengine/OpenViking](https://github.com/volcengine/OpenViking) | **40,068** | AGPL-3.0 | Python + Rust | ✅ `docker-compose.yml` |

**它确实有 Pi 集成**（用户判断正确）——官方文档 `docs.openviking.ai/en/agent-integrations/11-pi`：

> *"Recall, capture, and takeover run on **pi's native extension API**: recall happens automatically before every prompt, conversation turns are captured after every turn, and OpenViking can **replace committed local history with an archive overview in pi's context hook**. The extension uses the official MCP client and registers the server's MCP tools as native pi tools."*

**⚠️ 但它的集成点是 `pi-coding-agent` 的 extension API，不是 `pi-durable`：**

| | `pi-coding-agent` | `pi-durable` |
|---|---|---|
| extension 安装 | **放目录自动发现**（`~/.pi/agent/extensions/*.ts`） | **只能在代码里** `registry.install(defineExtension({...}))` |
| 目录扫描机制 | ✅ | ❌ **零命中** |

→ **OpenViking 的安装脚本对 durable 无效**，要自己写一个 durable extension。

**✅ 但它用的钩子 durable 都有对应物：**

| OpenViking 做的事 | durable 里靠什么 | 工作量 |
|---|---|---|
| 系统提示词注入 profile 块 | **`section()` 的 render 函数** | 很小 |
| 每 prompt 前语义召回 | **`beforeRequest` hook** | 小 |
| 每 turn 后捕获对话 | **`afterResponse` / `afterTools` hook** | 小 |
| MCP tools 注册成原生工具 | **`pi-mcp` + `registry.install()`** | 小 |
| 一键安装脚本 | ❌ 无目录发现 → 自己包一层 | 小 |

**⚠️ 必须避开的冲突：关掉它的 takeover**

> OpenViking 的 takeover 会「替换本地历史」，而 **durable 的 `head` + `ContextEdit` 已经在做这件事，而且是声明式、持久化、可审计的**。
> **两个 takeover 同时开 = 打架。**

**正确分工**：
```
OpenViking  →  recall（召回）+ capture（捕获）   ← 记忆存取
pi-durable  →  head / ContextEdit               ← 上下文管理
```
（符合已定分工：记忆层是可替换外挂，上下文管理是 L0 职责）

**三个加分项：**

| 项 | 说明 |
|---|---|
| **不强制本地模型** | `init` 支持 **Volcengine / OpenAI / Codex OAuth / Kimi / GLM / 本地 Ollama** → ✅ 解决了腾讯那个「默认 local LLM」的张力 |
| **记忆抽成 Markdown** | 原文 *"extracts memories as **Markdown you can inspect**"* → ⭐ 用户可读可改 |
| **有 TypeScript SDK** | `sdk/typescript` → ⭐ 与 pi-durable 同栈 |
| **有实测数字** | LoCoMo 用户记忆：三家 agent 原生 24–57% → 接入后 **80–83%** |

---

### 因技术定位排除（与 license 无关）

| 项目 | 原因 |
|---|---|
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)（101,145★） | 定位是**捕获 coding agent 的会话**，不是用户级长期记忆 |
| [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory)（29,574★） | 同上，偏 coding agent |
| memobase（2,932★） | **2026-01 停更**（9 个月） |

---

## 2. 候选池判断（自托管门槛已过）

| 池 | 优势 | 代价 | 适合 |
|---|---|---|---|
| **C 腾讯** ⭐ | **四层模型对口** + **SQLite 向量（栈一致）** + **TS/npm** + standalone 零外部依赖 + 对接 OpenClaw/Hermes | ⚠️ 默认 local LLM；三件套（Core/Hub/Proxy）略重 | **接入成本可能最低**（同栈 + 同存储路线） |
| **A 成熟 drop-in**（mem0 / supermemory / hindsight） | 生态大、**mem0 有 `mem0-ts`** | 存储格式黑盒；mem0 需要向量库 | 先跑起来看效果 |
| **A′ 大厂自演化**（OpenViking，字节） | 40k★、活跃、**topics 有 `dsh-plugin`** | 概念多（自演化/context database） | 若 dsh-plugin 真能一键挂 |
| **B Markdown-first**（EverOS / tigerless / memU） | **存储形态对口**（用户可读可改） | 生态小、成熟度未知；自托管形态待核实 | 如果要「用户能直接看记忆」 |

---

## 3. ⚠️ 但外挂给不了我们要的四件事

这是**必须写清楚的**——避免以后有人以为接上外挂就完事了：

| 我们的需求（[context-and-memory.md](context-and-memory.md) §3） | 外部框架能给吗 |
|---|---|
| **provenance**（每条记忆指向来源消息） | ❌ 基本都是黑盒，不暴露来源链 |
| **真删 + 可校验** | ⚠️ 大多有 delete，但**无法证明删干净**（向量索引/缓存） |
| **用户改过的行是权威** | ❌ 框架会按自己的策略重写 |
| **时效性**（`valid_from`/`valid_until`/`superseded_by`） | ⚠️ **graphiti 的时序边最接近**，但目标是检索不是时效判据 |
| **定期回检**（发现漏记） | ❌ 没有框架做这个 |

> **所以外挂版必须被当作「临时方案」，而且要能随时撤掉。**

---

## 4. ★ `MemoryAdapter` 接口约束（这是正式设计）

**唯一硬约束：实现必须可替换，且不外泄框架概念。**

```
MemoryAdapter
  ├── remember(item)     → id
  ├── recall(query)      → [item + score + 来源]
  ├── forget(id)         → Outcome（true delete）
  ├── list(filter)       → [item]（给用户看的（可编辑）视图）
  └── health()           → 状态（供 §5 的失败处理）
```

**四条要求：**

| # | 要求 | 为什么 |
|---|---|---|
| 1 | **接口不暴露底层框架的类型**（不返回 mem0/graphiti 自己的对象） | 否则换实现要改所有调用点 |
| 2 | **返回结构里必须留 provenance 字段**（即使当前实现填不上） | 留位置，自研时不用改调用方 |
| 3 | **`forget` 必须能回报「删了什么」** | 我们的「真删可校验」在自研版要兑现，接口现在就得支持 |
| 4 | **`list` 必须能给出人类可读的形态** | 它是「用户可读可改」的唯一入口 |

**四个预留位（当前实现可以先返回空/默认值）：**

```ts
source_ref        // 来源消息 id —— 自研版必填
asserted_by       // user | agent-inference | external-doc
valid_from / valid_until / superseded_by
confidence
```

> **接口先留位置，实现可以先不填。** 这样从外挂换到自研时，调用方零改动。

---

## 5. 外挂接入的三个工程注意

| # | 注意 | 依据 |
|---|---|---|
| 1 | **所有出口走同一套 egress 策略** | nanoMuse 的洞：embedding 调用落在 taint 规则之外。**外挂记忆必然要发数据出去**，必须纳入策略 |
| 2 | **记忆失败不能让你失忆到崩溃** | 外挂是外部依赖。`recall` 失败要降级（返回空 + 记一条日志），不能抛穿 |
| 3 | **要能一键切换/回退** | 配置项选择实现（`MEMORY_BACKEND=mem0|file|none`），且提供 `none`（纯文件）作为兜底 |

---

## 6. 落地路径

```
第 1 步  MemoryAdapter 接口 + FileMemoryAdapter（纯 Markdown/SQLite）
         ← 零依赖，先保证系统能跑
第 2 步  接一个外部实现（TS 优先：mem0 / supermemory / 腾讯）
         ← 验证「记忆到底有没有用」
第 3 步  看效果决定：继续用 / 换一个 / 自研
         ← 自研时补齐 provenance / 真删 / 时效性 / 回检
```

**第 1 步不能跳**——它是兜底，也是接口的参照实现。

---

## 7. 待定

- ❓ 第 2 步接哪个 —— 两个候选并列：
  - **OpenViking**（40k★，**已有 Pi 集成可参考**，Markdown 记忆，TS SDK，provider 自由，有 LoCoMo 实测）→ 需写一层 durable extension
  - **腾讯**（同栈，SQLite 向量，四层模型 L0→L3 对口）→ 需核实能否配远程 LLM
- ❓ ⚠️ **腾讯那个能否把 LLM 端点配成远程模型**（它默认 local LLM，与「不本地跑模型」有张力）—— 这决定它是否可用
- ❓ OpenViking 的 `dsh-plugin` 是否真能一键挂进 DSH（若能，接入成本最低）
- ❓ supermemory / EverOS 的自托管形态待核实（根目录无 docker 文件）
- ❓ 记忆的检索是否需要向量（当前判断：**不需要**，SQLite FTS5 够用；但腾讯那个自带 SQLite 向量检索，接入时顺带就有）
- ❓ 自研的触发条件（什么时候判定「外挂不够用」）
- ❓ 是否需要记忆的可视化界面（`list` 的 UI 形态）
