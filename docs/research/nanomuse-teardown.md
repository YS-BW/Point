# nanoMuse 技术调研报告

> 调研对象：`https://github.com/nano-muse/nanoMuse`
> 调研时间：2026-10-16（Asia/Shanghai）
> 方法：GitHub REST API（`/repos`、`/contents`、`/git/trees`）、`raw.githubusercontent.com` 逐文件抓取、GitHub Atom feed（commits / releases）、Hacker News Algolia API、官方 docs 与源码交叉验证。
> 说明：`web_search` 工具本次不可用（Tavily 额度耗尽、火山搜索免费额度耗尽），第三方讨论仅通过 Hacker News API 直接检索到，**Reddit / X 的讨论未能确认**。

---

## 1. 一句话定位 + 想解决什么问题

**定位**：nanoMuse 是一个 GPL-3.0-or-later 的**开源个人 agent（personal agent）**，主打「一个 agent，覆盖你所有的设备」——手机（Android / iOS）、桌面（Windows / macOS / Linux）、浏览器，外加一个可自托管的账号中继（relay）。

官方原话：

> **nanoMuse is an open-source personal agent for every device you own.** One agent with a name and a look of its own, in the style of Meta's Muse: **it does things instead of answering questions, keeps working while the app is closed, remembers you, and stops to ask before anything you could not undo.**
> — https://raw.githubusercontent.com/nano-muse/nanoMuse/main/README.md

仓库描述（API 原文）：

> nanoMuse: an open-source personal agent for every device you own. One agent with a name and a look of its own that does things, keeps working while the app is closed, remembers you, and asks before anything you cannot undo. On Android, iPhone and iPad, Windows / macOS / Linux and in the browser; **your phone's screen and your computer as its hands.**
> — https://api.github.com/repos/nano-muse/nanoMuse

**它想解决的问题**：Meta 的 Muse 把每个用户的 agent 放在云 VM 里（需要联网、数据在别人手上、无法触达你自己的设备）。nanoMuse 的回答是：把 agent 放到你自己的设备上，模型自选、中继自托管，"每个人真正拥有一个 personal agent"（README / docs/roadmap.md）。

**是否属于「持续运行、主动交互的 personal agent」——是，而且是明确以此为核心卖点的。** 证据：

- README 的 "Keeps going" 一栏：`Goals checked on a schedule, routines that run while the app is closed, a feed written for you each morning.`（README.md）
- 官方 roadmap 把「Proactivity」列为独立能力线：`Goals are checked on a schedule, routines run with the app closed, the feed is written each morning.` — https://raw.githubusercontent.com/nano-muse/nanoMuse/main/docs/roadmap.md
- 代码层确实有一个常驻的 asyncio 目标调度器（见 §3）。

**额外信息**：项目挂了一篇 arXiv 论文 *nanoMuse: An Open-Source Personal Agent for Every Device You Own*（Guangyi Liu, Yong Liu, Jiangning Zhang, 浙江大学），编号 arXiv:2610.08699，2026-10-07 上 arXiv，2026-10-08 登上 Hugging Face Daily Papers 第 3 名（README 的 News 段）。
> 论文页面本身我未直接打开验证，此项**依据 README 与 HN 上的同名条目**（https://arxiv.org/abs/2610.08699 出现在 https://hn.algolia.com/api/v1/search?query=nano-muse 的结果中）。

---

## 2. Stars / License / 语言 / 活跃度 / 归档状态

全部来自 `https://api.github.com/repos/nano-muse/nanoMuse`（抓取时间 2026-10-16 10:26 CST）：

| 项目 | 值 |
|---|---|
| Stars | **1,269**（`stargazers_count`） |
| Forks | 140 |
| Watchers / Subscribers | 1,269 / 6 |
| Open issues | 50 |
| License（API） | `GPL-3.0`（`spdx_id: GPL-3.0`） |
| License（仓库文件） | README 与 `pyproject.toml` 均写 **GPL-3.0-or-later** |
| 主语言（API `language`） | **Swift** |
| 创建时间 | 2026-09-23T06:13:06Z |
| 最后 push | 2026-10-15T12:00:14Z |
| 最后更新 | 2026-10-16T02:24:29Z |
| 归档 / 停用 | `archived: false`, `disabled: false` —— **未归档、未停更** |
| 仓库体积 | 86,818 KB（约 85 MB） |
| 默认分支 | `main` |
| 主页 | https://nanomuse.cn/ |

**关于 License 的小差异**：API 报 `GPL-3.0`，但仓库 README（`![badge](...license...)` alt 文本与文末 License 段）和 `pyproject.toml` 写的是 `GPL-3.0-or-later`。`cloud/pyproject.toml` 同样是 `GPL-3.0-or-later`。以仓库文件为准：**GPL-3.0-or-later**。注意 README 提到「Earlier versions of the Python line were MIT (tag `pre-openminis`)」，且手机端基于 OpenMinis 1.13（GPL-3.0）以 `git subtree` 引入（`docs/roadmap.md`、`AGENTS.md`）。

**关于「主语言 = Swift」的误导性**：GitHub 统计出 Swift 是因为 `android/` 这个 subtree（2,686 个文件，占整个仓库文件数的绝大多数）内含 iOS Swift 源码 `android/src/ios/`。项目真正的运行时是 **Python（≥3.11）+ TypeScript/React + Kotlin + Swift**。见 `AGENTS.md` 的 Repository layout 与 §3。

**活跃度 —— 极高**：

- Releases Atom feed（https://github.com/nano-muse/nanoMuse/releases.atom）显示发版节奏密集：`0.1.39 Keys`（2026-10-06）→ `0.1.40 Clear`（2026-10-06）→ `0.1.41 Choice`（2026-10-08）→ **`1.0.0 Keel`（2026-10-08）** → `1.0.1`（10-09）→ `1.0.2`（10-11）→ `1.0.3`（10-11）→ `1.0.4`（10-12）→ **`1.0.5 Lookout`（2026-10-13）**。
- Commits Atom feed（https://github.com/nano-muse/nanoMuse/commits/main.atom）最近 20 条，最新一条 2026-10-15T12:00:12Z，主体为 PR 合并（如 `Merge pull request #479 from nano-muse/feat/chatgpt-gpt6-models-475`、`#478 ... memory-first-turn-recall-477`、`#474 ... multi-device-sync-order-395`）。
- `CHANGELOG.md`（1,973 行，抓取自 raw）有一个内容充实的 **`## [Unreleased]`** 段落，说明 `main` 上有待发版改动 —— 典型的活跃维护状态。
- README News 自述：2026-10-13 达到 1,000 stars（首个 release 后 18 天），并在 GitHub Trending 的 Swift 榜上停留 4 天（Trendshift 第 7 / 第 4）。

**社区信号（第三方）**：Hacker News 上有一条 **Show HN**（2026-10-07，**68 分、21 条评论**），标题 *"Show HN: NanoMuse – An open-source AI agent for your phone and computer"*，链接即该仓库 —— https://news.ycombinator.com/item?id=49987765 。**Reddit 与 X 的讨论未能确认**（搜索工具额度耗尽）。

**维护者结构（bus factor 提示）**：README 的 Maintainers 表只列了 **Guangyi Liu（@lgy0404）** 一人；Contributors 段落列出 9 位社区贡献者。Commits feed 中最近 20 条几乎全部由 `lgy0404` 合并/提交 —— **典型「单人主导 + 社区 PR」模式，bus factor 偏低**。

---

## 3. 架构与技术栈拆解

### 3.1 仓库分层（来源：`AGENTS.md` Repository layout，raw 抓取）

```
nanomuse/               Python 运行时：agent loop、Sentinel、tools、hands（手机/电脑 operator）、web app 的 server
cloud/                  nanoMuse Cloud，中继：FastAPI + SQLite；登录、模型、hub、会话同步、/app 控制台
web/                    web 控制台（Vite + React）；npm run build 写入 nanomuse/server/static/（已提交入库）
harness/dsh-nanomuse/   桌面 app 本体：DeepSeek Harness 插件（TypeScript、React client、i18n）
harness/desktop/        包住 dsh + 插件 的 Electron shell；随包附带 Python runtime
android/                OpenMinis 1.13 subtree（GPL-3.0）；"do not restructure"
android/src/android     Android app；自有代码在 io.github.nanomuse.*
android/src/ios         iOS app；自有代码在 NanoMuse/（Swift）
demo/                    showcase（录制的 trace，页面在 site/）
docs/                   用户与贡献者文档；website/ 下的 VitePress 站点投影此目录
scripts/                发版、rebrand、图标、catalogue 生成；self-host.sh
tests/                  Python 运行时的 pytest（仅 MockLLM，不联网）
website/                VitePress 配置（srcDir ../docs）
```

顶层目录经 GitHub contents API 核对一致（`android, assets, cloud, config, demo, docs, harness, nanomuse, scripts, site, tests, web, website` + 根级配置/文档文件）。

**技术栈汇总**（来源：`pyproject.toml`、`cloud/pyproject.toml`、`AGENTS.md`）：

- Python 运行时：Python **≥3.11**，依赖 `openai`、`pydantic` v2、`httpx`、`typer`、`rich`、`loguru`、`cryptography`（Fernet）、`tenacity`、`ddgs`、`beautifulsoup4`、`html2text`、**`mcp`**、`fastapi`、`uvicorn`、`qrcode`、`pywebpush`、`pillow`、`pypdf`、`zstandard`。可选组：`browser`（Playwright）、`hands`（mss / pyautogui / pyperclip / pyobjc）、`feishu` / `dingtalk` / `wecom`（国内 IM）。
- 中继：FastAPI + uvicorn + SQLite + `websockets` + `cryptography`。
- Web 控制台：Vite + React + TypeScript + Tailwind。
- 桌面：Electron shell（`harness/desktop/src/*.ts`）+ DeepSeek Harness 插件（`harness/dsh-nanomuse/`，pnpm 构建）；macOS 侧还有一个 Swift 写的 computer-use helper（`harness/desktop/mac/computer-use/Sources/*.swift`）。
- 手机：Android = OpenMinis 1.13（Gradle, JDK 21, NDK r27c）+ proot + Alpine Linux 沙箱；iOS = Swift（`android/src/ios/NanoMuse/`）。

### 3.2 进程模型：常驻 daemon + asyncio 调度器 + 外部 tick + 事件驱动

**不是 cron，而是「常驻服务 + asyncio 内部调度器 + 移动端精确闹钟补刀」的混合模型。** 具体证据（全部来自源码交叉验证）：

1. **组合根**：`nanomuse/app.py:63 class NanoMuseApp` —— 把 settings → LLM、tools、vault、Sentinel、memory、goals、agent 串起来（`architecture.md` 的 Source map；`app.py:306 _build_tools`）。
2. **Agent loop**：`nanomuse/agent/core.py:53 class MuseAgent`，`run()` 在 `core.py:395`，主循环 `while step < self.settings.agent.max_steps:`（`core.py:432`），并有卡死检测 `_is_stuck()`（`core.py:383`）。
3. **常驻服务**：`nanomuse/server/service.py` 首行 docstring 直接写着 *"The always-on nanoMuse: threads, background workers, goals scheduler, ideas, profile."* `MuseService` 为每个 thread 维护一个 `MuseAgent`，共享 memory / goals store、vault、audit log（`architecture.md`）。
4. **调度器**：`service.py:442` 持有 `self._scheduler: asyncio.Task[None]`，`service.py:487` 创建 `asyncio.create_task(self._goal_scheduler(), name="goal-scheduler")`，实现体在 `service.py:1919 async def _goal_scheduler`；配套有 `schedule_next_pass()`（`service.py:1586`）、`next_wake_at`（`1544`）、`interval_seconds`（`229`）、`goal_interval_minutes` 默认 **60**（`220`），并按等级伸缩 + 安静时段（quiet hours）。
5. **外部 tick（手机精确闹钟）**：`service.py:1539` 注释 *"Run the scheduler's pass now. The Android app calls this from the exact alarm it ..."*，对应 `POST /api/tick`；`service.py:451` 注释说明调度器「打盹」时 `wake()` 会结束睡眠。**这是为了绕开移动端后台被杀**，设计很聪明。
6. **其它后台循环**：邮件触发器轮询 `mail_poll_minutes`（`service.py:1800-1812`，*"Look at the inbox for the mail triggers, every `mail_poll_minutes` while at least one is active"*）；每日 feed `feed_scheduled_at`（`service.py:2200`）。
7. **CLI 侧的独立常驻/一次性入口**（`docs/cli.md`）：
   - `nanomuse serve [--host] [--port 8787]` —— 常驻 agent + 手机 app 后端（FastAPI/uvicorn）
   - `nanomuse chat [--resume] [--auto]` —— 终端交互会话
   - `nanomuse run "<task>" [--auto]` —— 一次性任务
   - `nanomuse daemon [--interval 3600] [--once]` —— *"Advance every active goal, sleep, repeat. Runs in Sentinel `auto` mode"*
   - 根 `docker-compose.yml` 提供 `app` / `muse` / `daemon` 三个 service（`docker compose up -d daemon` = "advance goals on a timer, no UI"）。
8. **跨设备：hub 事件驱动**（`docs/hub.md`）：每台设备向中继 `/v1/hub` 开**一条出站长连 WebSocket**并保持，*"Nothing listens on the device, nothing needs a port forwarded"*；设备间以帧通信（`action` / `task` / `event` / `approve` / `stop` / `result`）。审批结果通过 `event {stage:"approval"}` 回到发起端。

**一句话**：单进程 asyncio 事件循环里跑「常驻 HTTP/WS 服务 + 目标调度器 + 触发器轮询 + 每 thread 一个 agent」，移动端用系统精确闹钟驱动 `/api/tick`，跨设备用长连 WebSocket 帧。

### 3.3 记忆方案

- **存储**：SQLite。`nanomuse/memory/store.py:100 class MemoryStore`（`sqlite3`，`check_same_thread=False`）。
- **检索（默认、无外部依赖）**：按**词稀有度（IDF）**排序 —— `store.py` 顶部 docstring：*"by how rare each word is in the store (words in any alphabetic script, Latin, Cyrillic, ...)"*；`search()`（`store.py:248`）、`relevant()`（`278`）、`_fill()`（`286`）、`tokenize()`（`78`）、`similarity()`（`88`）。
- **检索（可选、语义）**：`nanomuse/memory/embeddings.py:93 class Embedder`，默认模型按端点推断（docstring 提到 `qwen3-embedding:0.6b`，"small and reads Chinese and English"），`default_model()`（`45`）、`cosine()`（`54`）、`fuse()`（`61`，多路排名融合）、`standouts()`（`73`，因为 *"Cosines are model-dependent (one model's 'unrelated' is 0.1, another's 0.45)"* 而做归一化取舍）。向量按「一条记忆 × 一个 embedding 模型」存，带文本 hash（`store.py:139`）。
- **整理/固化**：`nanomuse/memory/consolidate.py` —— `TidyReport`（`61`）、`plan()`（`200`）、`apply()`（`264`），并有**拒绝机制**：`_no_new_words()`（`166`）等检查，"refuse a merge they cannot judge"（roadmap 与 `architecture.md` 均提到 1.0.2 强化了这点）。
- **可读的 Markdown 身份/记忆**：agent 维护 `SOUL.md`、`USER.md`、`MEMORY.md`、`HEARTBEAT.md`，外加 `remember` 工具（`docs/roadmap.md` 第 15 行）。**用纯文件表达 persona + 记忆 + 心跳，是这个项目很好的一个设计取向。**
- **变更历史与撤销**：`MemoryStore.history()`（`store.py:364`）、`restore()`（`370`）、`drop(reason=...)`（`354`）、`MemoryChange`（`55`）—— 记忆有审计与回滚。
- **注入策略**：`architecture.md` 说 prompt 里注入 "profile, language rule, relevant memories, active goals"；CHANGELOG 记录 `MEMORY_OPENING_NOTE` + `_fill` 为最新记忆**预留槽位**，使新存事实在下一段对话首轮就能被主动提起（对应 issue #477）。

### 3.4 模型接入方式

- **抽象**：`nanomuse/llm/base.py` 的 `BaseLLM`；工厂 `llm/factory.py`；实现 `openai_chat.py`、`openai_responses.py`、`prompt_tools.py`（**对不支持 function calling 的模型用 prompt 驱动工具调用**）、`mock.py`（`MockLLM`，测试用）。
- **目录与密钥**：`llm/catalogue.py` + `llm/providers.json`（README 称支持 **20 家 provider**：Bailian、OpenRouter、OpenAI、Gemini、DeepSeek 等）；`llm/vision.py` 处理图像能力。
- **订阅制账号也能用**：`llm/chatgpt.py`（PKCE 登录 + token store）、`llm/codex.py`（Chat Completions ↔ Codex Responses 互译）、`llm/chatgpt_proxy.py`（`nanomuse chatgpt proxy`）—— 即把 ChatGPT / Claude / Kimi 这类「已付费订阅」当作模型来源。
- **中继免费额度**：`cloud/` 的 relay 以 OpenAI 兼容形状代理（`GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/images/generations|edits` 翻译到 DashScope 原生图像 API），注册即送额度，自带 key 亦可（`cloud/README.md`）。

### 3.5 前端形态：CLI / TUI / Web / 桌面 / mobile / IM 全都有

| 形态 | 实现 | 来源 |
|---|---|---|
| CLI / TUI | Typer + Rich，带内联审批与 slash 命令（`/memory`、`/goals`、`/audit`、`/tainted`、`/permissions`、`/revoke`）；`nanomuse/console.py`、`cli.py` | `docs/cli.md`、`architecture.md` |
| Web 控制台 | Vite + React + TS + Tailwind，`web/src/`（`store.tsx` 状态与 WebSocket，`screens/`，`components/`），构建产物提交到 `nanomuse/server/static/` | `architecture.md`、`AGENTS.md`；实测 `nanomuse/server/static/assets/` 下有 `AccountScreen-*.js`、`GoalsScreen-*.js`、`MemoryScreen-*.js`、`HandsStage` 相关 chunk 等 |
| 桌面 app | Electron shell + DeepSeek Harness 插件（`harness/desktop/src/*.ts`、`harness/dsh-nanomuse/src/client/*`，含 `AvatarChat.tsx`、`Trajectory.tsx`、`Capsule.tsx`、`locales.ts`） | `AGENTS.md`、`docs/harness.md`、`docs/roadmap.md` |
| Android | OpenMinis 1.13 subtree，自有 Kotlin 代码 `io.github.nanomuse.*`；Alpine Linux under proot 作为 shell 沙箱 | README、`AGENTS.md`、`docs/every-device.md` |
| iOS / iPadOS | Swift，`android/src/ios/NanoMuse/`（`NanoMuseChatCards.swift`、`NanoMuseComposer.swift`），通过 TestFlight 分发 | `docs/roadmap.md`、README Install 表 |
| IM 通道 | 飞书 / 钉钉 / 企业微信 / Telegram：`nanomuse/channels/{feishu,dingtalk,wecom,telegram,manager,store}.py` | README、`pyproject.toml` 可选依赖 |
| 浏览器 demo | https://demo.nanomuse.dev/ （模拟手机上的 nanoMuse） | README Install 表 |

**关键的架构解耦**：所有前端都实现同一个 `nanomuse/ui.py:45 class UI(Protocol)` —— `on_text_delta` / `on_assistant_message` / `on_tool_call` / `on_tool_result` / `on_sentinel` / `ask_approval()` / `ask_user()`。`ConsoleUI` 是终端，`WebUI` 把同样回调转成 timeline 事件 + WebSocket 消息并把审批挂起为 future；`ui.py:57 HeadlessUI` 用于无人值守。**「新前端 = 实现一个 Protocol」是这个仓库最值得抄的设计之一。**

---

## 4. 关键设计亮点与可复用的代码/思路

### 亮点 1：Sentinel —— 把「安全审批」做成独立于 agent 的强制关卡（最值得学）

- `nanomuse/sentinel/gate.py:55 class Sentinel`，唯一入口 `async def guard(call, tool)`（`gate.py:212`）；**agent 永不自己执行工具**，一律交给 guard：`policy → approval → vault.resolve → execute`，回程 `redact(result) + taint bookkeeping`（`docs/sentinel.md`、`docs/architecture.md`）。
- `nanomuse/sentinel/policy.py:27 class Decision(str, Enum)`、`:60 class Policy`、`evaluate()`（`:77`）。**决策顺序是有明确定义的 6 步**：① `deny_tools` → ② `[[sentinel.rules]]`（tool glob + 参数名→glob）→ ③ `always_allow_tools` / `always_ask_tools` → ④ 风险 × 模式矩阵（`ask`/`strict`/`auto`）→ ⑤ **污点（taint）** → ⑥ **警告（warnings）**。其中 5、6 步「只能把决定变成 ask，即使 auto 模式也不能放过」。
- **污点追踪（taint）**：`gate.py:84 tainted()` / `88 tainted_for(conversation)` / `95 taint()` / `101 untaint()`，按 conversation 隔离且仅存内存。读过邮件/日历/联系人后，任何发往白名单外主机的调用都要审批 —— 这是**针对 prompt injection 的具体防御**。
- **授权是 capability 而非 mood**：绑定 grant key（`web_fetch:example.com`、`shell:git`、`send_email:alice@example.com`），`nanomuse/sentinel/grants.py:46 class Grant`、`:79 class GrantStore`，作用域分 `once` / `for this conversation` / `until restart` / `24 hours` / `always`，可逐个 revoke（`revoke()` `:204`、`purge_expired()` `:225`）。
- **凭据不进模型**：Fernet 加密 vault（`nanomuse/vault/vault.py`），配置里写 `{{vault:NAME}}` 占位符，**审批通过后**才在 Sentinel 内替换；工具结果里若出现密钥替换为 `[REDACTED:NAME]`（`gate.py:397 _redact_obj`）。内置工具一律不 `accepts_secrets`，`shell`/`python_execute` 拿到占位符会直接拒绝而不是当字面量执行。
- **审计**：`nanomuse/sentinel/audit.py` → `<data_dir>/audit.jsonl`，每条 user message / model turn / decision / approval / tool call / result 都带 UTC 时间戳；`nanomuse audit -n 50` 可读。

> 可复用思路：**「风险分级 + 参数级 assess() + capability 授权键 + 污点追踪 + 占位符凭据」这套组合，是个人 agent 项目里最容易做出深度的部分**，且不依赖任何特定模型。

### 亮点 2：沙箱与子进程环境洗白（Linux 上用 bubblewrap）

- `nanomuse/sandbox.py` + `docs/sentinel.md`：每次 `shell` / `python_execute` 调用在**独立 namespace** 中执行（bubblewrap）；workspace 是唯一可写处，`/usr`、`/etc`、`/opt`、`/var` 只读，`/tmp` 私有，`$HOME` 不存在（因此 vault、数据目录、ssh key、云凭据都不可见）。
- **默认无网络**，只有判定「需要网络」（命令里出现 `curl`/`git`/`pip`… 或含 URL，或脚本 import `requests`/`socket` 等）才放行，且此时按 egress 调用走同一套审批。
- 子进程环境变量按名字清洗：`*KEY*`、`*TOKEN*`、`*SECRET*`、`*PASSW*`、`*CREDENTIAL*`、`*AUTH*`、`*COOKIE*`、`*SESSION*`、`NANOMUSE_*`、`AWS_*`、`AZURE_*`、`GOOGLE_*`、`GH_*`、`GITHUB_*`、`NPM_*`、`SSH_AUTH_SOCK` 全部剥离 —— **防止模型自己写的代码读走模型自己的 API key**。
- `[sandbox] mode = auto | bwrap | off`，`nanomuse doctor` 会打印沙箱状态；README/sentinel.md 还诚实记录了 Ubuntu 24.04 AppArmor 限制 unprivileged userns 导致的具体报错与修复（`apparmor-profiles`）。

### 亮点 3：工具基类把「安全元数据」做成一等公民

`nanomuse/tools/base.py`：`BaseTool`、`CallAssessment`、`ToolCollection`、`safe_execute`。每个工具声明：

- `risk`（`safe` / `moderate` / `sensitive`）
- `reads_private_data`（触发 taint）
- `egress` + 可选 `egress_target`
- 可覆写 `assess()` 做**参数级**提权，并生成人类可读 `summary`（审批卡片上显示的内容）

内置工具集在 `nanomuse/tools/`：`files.py`、`shell.py`、`web.py`、`email_tool.py`、`browser.py`+`browser_backends.py`、`memory_tools.py`、`goal_tools.py`、`phone.py`、`computer.py`、`devices.py`、`coding_tool.py`、`mcp_tools.py`、`skills_tool.py`、`reminder_tools.py`、`trigger_tools.py`、`calendar_tool.py`、`contacts_tool.py`、`terminate.py`。

> 可复用：**让每个工具自带风险声明 + 参数级评估函数**，审批 UI 直接消费这些元数据。这比在 agent loop 里散落 if-else 干净得多。

### 亮点 4：手机/电脑「屏幕即双手」的 GUI operator

- 手机：`nanomuse/phone/{link,screen,operator,trace}.py` + `nanomuse/tools/phone.py`（`phone_screen` / `phone_act` / `phone_task`）；operator 使用 MemGUI 的 `mobile_use` 方言，坐标系 999 网格。
- 电脑：`nanomuse/computer/{operator,coords,screen,hands,link,mac_window}.py`（`computer_screen` / `computer_act` / `computer_task`），operator 是 UI-TARS-desktop 的移植，marker 沿用其 ScreenMarker（README Acknowledgements）。
- **按点击目标的文字（label）做风险判定**：label 含 确认支付 / 转账 / 提交订单 / 发送 / 删除 等 `[gui] sensitive_words` → 最高级审批，且**任何常驻授权都无法覆盖**；label 缺失的点击也自带警告。这是很实用的一招。
- Trace：JSONL 记录 + HTML 渲染（`phone/trace.py`），roadmap 明确说要靠这些 trace 攒评测集。

### 亮点 5：跨设备 hub 协议（帧设计清晰，可当协议设计参考）

`docs/hub.md`：每设备一条出站 WS → 中继路由同账号帧，**中继不看任务内容**；文件与截图不上传，"files and screenshots stay where they were made"。两类请求：

- **Actions**（即时、原始）：`info`、`shell`、`files`、`file.get`、`file.put`、`open`、`screen`、`notify`。`shell` 在**调用方**先按同一套阶梯判定，然后再发送。
- **Tasks**（整件事交给目标设备自己的 Muse）：`task {text, conversation?, language?}`；执行中回 `event` 帧（`tool` / `tool_result` / `approval` / `approval_result` / `text` / `image` / `file` / `error`），审批**回到发起设备**显示卡片，答复以 `approve {approval_id, allow}` 返回；可用 `stop {call|conversation}` 取消。
- **明确的「未实现」约定**：`proxy_fetch`（手机借电脑的网络访问 provider）在文档里标了 *"Not built yet; written down here so the three implementations agree before anyone starts."* —— **先把协议写进文档再实现，值得学习**。

### 亮点 6：主动性的具体零件（goals / reminders / triggers / nudges / feed）

- `nanomuse/goals/store.py:181 class GoalStore`（SQLite）+ `Step`（`:103`）/ `Goal`（`:114`）；**cadence 语法** `parse_check_in()`（`:53`）、`next_check_in()`（`:71`）、`parse_due()`（`:95`）、`due_check_ins()`（`:385`）、`mark_checked_in()`（`:395`）、`propose()`/`accept_proposal()`（目标可以**自己提出新步骤**等你接受）。
- `nanomuse/reminders/store.py:106 class ReminderStore`，复用同一套 cadence 语法（`daily HH:MM`、`weekdays HH:MM`、`weekly <mon…sun> HH:MM`、`monthly <day> HH:MM`）；`repeating()`（`:76`）、`mark_fired()`（`:188`）。
- `nanomuse/triggers/store.py` —— 三种触发器：**新邮件到达、日历事件临近、webhook**（`docs/roadmap.md` 第 23 行）。
- `nanomuse/nudges.py`（253 行）—— 把后台发生的事变成「值得看一眼」的提醒，投递到设备。
- 每日 feed：`service.py:2200 feed_scheduled_at()`，早上写一份 feed。
- 无人值守时的审批降级：`auto` 模式下，若某步仍需询问，`nanomuse daemon` 会自动拒绝并记录（"has nobody at the keyboard: a step that still asks there is declined with a note"），而不是静默执行或卡死 —— **很务实的设计**。

### 亮点 7：工程规范（对简历项目同样有参考价值）

- `AGENTS.md` 给了「一屏版架构 + 每个子项目该跑什么检查命令」；`CLAUDE.md` 也在。
- 测试用 `MockLLM` 保证无网络可跑：`python -m pytest -q`；`tests/test_server.py` 用脚本化 `MockLLM` 端到端驱动 app server（消息、审批卡、提问、goals、memory、文件、设置）。
- 严格的 lint/类型：ruff（line-length 100）+ mypy（`check_untyped_defs`、`warn_unreachable`）。
- 发版工程化：`CHANGELOG.md`（Keep a Changelog + SemVer）、每版一个 GitHub Release（`nanoMuse <version> · <Codename>`）、`docs/releases/` 逐版说明、`scripts/release-*.sh`、`scripts/gen-*-icons.py`、catalogue 生成与 `--check` 校验脚本。
- CI 覆盖 Python 多平台（macOS/Windows runner）+ Node 22 + 构建产物一致性（`node scripts/providers-json.mjs --check`）。

---

## 5. 明显的局限、坑、未完成部分

### 5.1 项目**自己承认**的缺口（`docs/roadmap.md`，可信度最高）

- **记忆**：*"What is missing: memory that surfaces on its own at the right moment, forgetting that you can see, and **the same memory on every device rather than per device**."*（即记忆目前是**每设备独立**、不跨端同步）
- **主动性**：只有 3 种触发器；*"What is missing: the agent noticing other things between schedules, such as a device that came online, and deciding whether what it noticed is worth a word."*（**「持续运行 + 主动交互」目前是「按计划跑」而非「随时在感知」**）
- **对话体验**：*"it still feels like a chat client"*；各客户端的「在场感」不齐；**语音只有输入，没有输出**（0.1.22 移除了通话，见 `docs/calls.md`）；hands 的 stage 尚未在所有客户端统一。
- **双手成功率**：*"It fails on grounding (the model names the wrong element) and on recovery after an unexpected dialog, and we have no fixed set of tasks to measure it against."*（**GUI agent 的老问题：定位错、异常弹窗后不能恢复、无评测集**）
- **自托管**：`scripts/self-host.sh` 管中继，web runtime 另有 `docker-compose.yml`，*"What is missing: one command for both, updates that keep the data"*。
- **国际化**：英文/中文之外，Android 15 个 locale 是上游带来的，自有字符串 `nm_strings.xml` 质量差。

### 5.2 安全模型**自己声明**的边界（`docs/sentinel.md` 的 "Not covered: know this before you run it"）

- **Sentinel 与 agent 同进程同用户**，不是 Meta Muse 那样的独立 VM：*"its Sentinel is a module in the same process"*。
- **没有 OS 级隔离的地方**（macOS / Windows / 多数 Docker 容器）：`shell` 和 `python_execute` **以你自己的身份运行**，模式匹配只是「绊线」，对抗性脚本可绕过；官方建议放容器或专用账号。
- **vault 密钥与 vault 同目录**（`vault.key`，0600）：能读数据目录就能解密。需要靠 `NANOMUSE_VAULT_KEY` 环境变量缓解。
- **DNS rebinding** 未完全防住；**「always allow `shell:curl`」的强度就是它听起来那样**（不检查目的地）。
- **默认 API 是明文 HTTP + bearer token**：*"Do not expose the port to the internet; use Tailscale or a TLS reverse proxy."*
- **隐私事实**：每条 memory 都会进入 system prompt 发给 chat model；开启「按语义召回」后，**每条记忆和每条消息的文本也会发给 embedding 端点**（本地 Ollama 才不外泄）；embedding 调用不算 tool call，**在 taint 规则之外**。
- **审批疲劳**：*"If cards are approved without reading them, none of this helps."*

### 5.3 架构与工程上的坑

- **`android/` 是一个 2,686 文件的 OpenMinis 1.13 subtree**（占仓库绝大多数文件），`AGENTS.md` 明确写 *"do not restructure"*；构建需要 JDK 21 + NDK r27c，还要先 `build-natives.sh`。**这是本仓库最大的「不可照抄」负担。**
- **iOS 没有 hands**：系统不允许，「the screen as a hand」只在 Android 和桌面可用（README 对比表）。
- **沙箱只在 Linux + bubblewrap 成立**；Ubuntu 24.04 的 AppArmor 限制会导致 bwrap 报错或网络无法隔离（文档给了修复步骤，但说明这不是开箱即用）。
- **`proxy_fetch` 未实现**（`docs/hub.md` 明写 "Not built yet"）。
- **主语言显示为 Swift**，会误导外部评估者（GitHub 的语言统计被 subtree 里的大型 iOS 代码库主导）。
- **Open issues 50 个**；仓库 85 MB，克隆与构建成本高（本次浅克隆在 10 分钟量级仍未完成，最终改用 raw 逐文件抓取，**因此本报告未对全仓库做穷尽 grep**）。
- **GPL-3.0-or-later 是强 copyleft**：手机端又基于 GPL-3.0 的 OpenMinis。如果只想做一个「简历项目」，直接 fork 会背上许可证与 subtree 双重包袱。
- **bus factor 低**：维护者表仅 1 人（@lgy0404），近期提交几乎全部由该账号合并。

### 5.4 社区侧的负面/质疑（Hacker News，https://news.ycombinator.com/item?id=49987765）

- **命名与品牌风险**：多位评论者把它误认为 Meta 产品 —— `herbst`: *"Sounds like a meta product made to steal my data on yet another device, not good marketing"*；`shlewis`: *"Great name to be replaced in about a week."*；`ch_sm` 与 `jpage2` 也都建议重新考虑命名。
- **信任质疑**：`tiku`: *"Yeah not installing this on my daily phone yet..."*；`thatsabadlook`: *"Anyone running ai agents directly on their phone deserves exactly what they get."*
- **需求质疑**：`i_love_retros` 长篇质疑个人 agent 的必要性，并与几位 ADHD 用户就「agent 作为无障碍工具的价值」激烈交锋 —— 这反过来说明**「谁在用、为什么用」是这个品类需要回答的问题**。
- **值得注意的对比**：评论中 `vidarh` 描述了自己用「bubblewrap 沙箱 + identity/soul/memory 拆分 + heartbeat 固化记忆 + 邮件只读」的同类自建 agent（提到 Kimi、openclaw、Matrix），与 nanoMuse 的设计高度重合 —— **说明这套「SOUL/USER/MEMORY + heartbeat + 沙箱 + 读私数据后限制外发」已是这个赛道的共识做法，而非 nanoMuse 独有创新。** 反面也说明：仅复刻这套结构不足以构成差异化。
- 正面声音：`ch_sm`: *"We need any and all open source alternatives to products that people obviously find useful but do not respect their privacy."*
- **未能确认**：Reddit / X / 其他博客的讨论（`web_search` 与两个搜索后端本次均因额度耗尽不可用）。

---

## 6. 对「想做一个同类开源项目做简历项目」的启示

### 6.1 可以直接借鉴（性价比高、可迁移）

1. **`UI` Protocol 把前端做成可插拔**（`nanomuse/ui.py:45`）：CLI、Web、桌面、IM 都是同一回调协议的实现。你的项目只要先定这个协议，就能用极低成本展示「CLI + Web 双端」。
2. **Sentinel 式的独立审批关卡**（`sentinel/gate.py:212` + `policy.py:77`）：`risk` 分级 + 参数级 `assess()` + capability 授权键（`tool:target`）+ 可 revoke + JSONL 审计。**这是最能体现工程判断力、又最容易在面试里讲清楚 15 分钟的部分。**
3. **污点追踪防 prompt injection**（读私数据 → 外发需审批，ttl 按 conversation 隔离）：一个几十行就能实现、但很少有玩具项目做的点。
4. **`{{vault:NAME}}` 占位符 + 结果侧 `[REDACTED:NAME]`**：让密钥永不进入模型上下文，实现简单、演示效果好。
5. **子进程环境变量按名字洗白**：一个函数的事，安全叙事价值极高。
6. **「常驻 asyncio 调度器 + 外部 tick 接口（`POST /api/tick`）」**：既解决了移动端后台被杀，又让调度可被测试和手动触发。**比直接 cron 优雅，也比纯 cron 更适合作品集叙事。**
7. **cadence 语法统一**（`parse_check_in` / `next_check_in`，goals 与 reminders 共用）：一个小的 DSL 解析器就能撑起「主动 agent」的核心观感，成本极低。
8. **工具基类自带安全元数据**（`tools/base.py` 的 `risk` / `reads_private_data` / `egress` / `assess()`）。
9. **MockLLM + 端到端 server 测试**（`tests/test_server.py`）：让 CI 不依赖网络、不烧 token，评审者一条命令就能验证。
10. **先写协议文档再实现**（`docs/hub.md` 里 `proxy_fetch` 的 "Not built yet" 约定）。
11. **发布工程化**：Keep a Changelog + SemVer + 每版一个 Release + codename + `AGENTS.md` 式的「一屏架构 + 检查命令」。**这几乎零技术难度，却显著提升项目的「专业感」。**
12. **记忆用「IDF 稀有词排序」做零依赖默认 + 可选 embedding 语义召回**（`memory/store.py`、`embeddings.py` 的 `fuse`/`standouts`）：避免了「没有向量库就跑不起来」，同时保留了进阶路径。

### 6.2 不要照抄 / 要主动规避

1. **不要 fork `android/` 这种巨型 subtree**。OpenMinis 2,686 个文件、`do not restructure`、JDK+NDK 构建链 —— 简历项目里这是纯粹的负担。**手机端最多做一个轻客户端，或者干脆只做 Web + 桌面。**
2. **不要一开始就做全平台。** nanoMuse 有 1 个主维护者 + 9 位贡献者，仍然要每天发版才追得上 6 个客户端（Android/iOS/桌面/Web/CLI/IM）。个人项目同时维护 4 个以上前端 = 全部做不深。
3. **不要背上 GPL-3.0-or-later + 上游 GPL 的双重 copyleft**，除非你确实想清楚要开源到那个程度。用 MIT/Apache-2.0 的原始实现，把 nanoMuse 当**参考读物**而不是**代码来源**。
4. **不要用「Meta Muse 开源替代」或任何与 Meta 产品混淆的命名**。HN 的反馈很直接：多位读者第一反应是「Meta 又来偷数据了」。取一个中性、可搜索、不撞车的名字（`shlewis` 甚至断言这名字一周内就得改）。
5. **不要把「主动」做成「只有定时任务」**。nanoMuse 自己承认这是个缺口（roadmap: 只有 3 种触发器，缺「计划之间注意到别的变化」）。你若能做出**事件驱动的感知 + 值得不值得打扰的判断**，反而是相对它的差异化机会。
6. **不要承诺你也做不到的安全保证**。nanoMuse 最值得尊敬的一点是 `docs/sentinel.md` 有一整节 "Not covered"，明确列出「没有沙箱的平台上以你的身份运行」「vault key 就在旁边」「DNS rebinding 未防住」「明文 HTTP」。**照抄它的诚实，而不是照抄它的宣传。**
7. **不要忽视「记忆跨设备同步」和「可见的遗忘」** —— 这两点是 nanoMuse 尚未完成的（roadmap），也是任何 personal agent 的真实难点；做了就是明显的加分项。
8. **不要用厂商中继 + 免费额度作为默认路径**。nanoMuse 这样做是为了「零门槛上手」，但代价是要维护计费/限流/防刷（CHANGELOG 里能看到 `domain_limited`、`INVITE_SETTLE_MIN_SPENT_UY`、同 IP 检测等大量反滥用代码）。个人项目直接 BYO-key 更干净。
9. **不要低估 GUI agent 的难度**。nanoMuse 明确写 hands 「fails on grounding and on recovery after an unexpected dialog, and we have no fixed set of tasks to measure it against」。如果做，**先建 10 条可复现任务的评测集再写代码**（这正是它 roadmap 里的建议）。
10. **在简历叙事上，强调「你解决了什么难题」而不是「你覆盖了几个端」**。可以讲的硬核点：审批/授权模型、taint 防注入、沙箱与凭据隔离、调度与唤醒、记忆召回融合、跨设备协议。这些都是 nanoMuse 真正有深度的地方，也都是可以在小项目里独立做扎实的部分。

---

## 结论（200 字以内）

nanoMuse 是一个真实、活跃、工程质量高的开源 personal agent：2026-09-23 建库，**1,269 stars / 140 forks / GPL-3.0-or-later / 未归档**，10 月中旬仍在每日提交并发版到 1.0.5。它不是套壳：Python 运行时用一个常驻 asyncio 调度器 + 手机精确闹钟 tick 实现「应用关闭也继续跑」的目标推进，配 Sentinel 审批关卡、污点防注入、Fernet 凭据隔离、bubblewrap 沙箱与 SQLite+IDF/向量混合记忆，桌面端还是 DeepSeek Harness 插件。

对简历项目：**抄它的设计（UI Protocol、Sentinel 授权模型、cadence 语法、MockLLM 测试），别抄它的规模（OpenMinis subtree、六端齐发、厂商免费额度中继），也别抄它的命名。**

---

## 来源清单

- 仓库主页：https://github.com/nano-muse/nanoMuse
- 仓库元数据（stars/forks/license/语言/时间/归档）：https://api.github.com/repos/nano-muse/nanoMuse
- README（raw，185 行）：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/README.md
- 架构：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/docs/architecture.md
- Sentinel：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/docs/sentinel.md
- Hub 协议：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/docs/hub.md
- 每设备设计：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/docs/every-device.md
- 桌面/DeepSeek Harness：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/docs/harness.md
- CLI：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/docs/cli.md
- Roadmap（局限与未完成）：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/docs/roadmap.md
- AGENTS.md（仓库布局、检查命令）：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/AGENTS.md
- CHANGELOG：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/CHANGELOG.md
- 运行时依赖与版本：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/pyproject.toml
- 中继说明：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/cloud/README.md 与 https://raw.githubusercontent.com/nano-muse/nanoMuse/main/cloud/pyproject.toml
- 关键源码：https://raw.githubusercontent.com/nano-muse/nanoMuse/main/nanomuse/{app.py,ui.py,background.py,nudges.py,agent/core.py,sentinel/gate.py,sentinel/policy.py,sentinel/grants.py,memory/store.py,memory/consolidate.py,memory/embeddings.py,goals/store.py,reminders/store.py,server/service.py}
- 提交活动（Atom）：https://github.com/nano-muse/nanoMuse/commits/main.atom
- 发版记录（Atom）：https://github.com/nano-muse/nanoMuse/releases.atom
- Hacker News 讨论（68 分 / 21 评论）：https://news.ycombinator.com/item?id=49987765
- HN 检索（Algolia API）：https://hn.algolia.com/api/v1/search?query=nano-muse
