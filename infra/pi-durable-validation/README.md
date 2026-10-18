# Point · Durable 个人 Agent 原型

长期主会话、可持续的主题侧聊、后台工作、共享记忆与结果回传。执行基础直接使用 `@earendil-works/pi-durable@1.3.0`，包括 Agent loop、工具、上下文压缩、任务与恢复；Node.js 要求 ≥ 22.19。

这是当前选定 Agent 架构的可运行原型，作为后续正式 Server 的实现基础。2026-10-18 起，正式设计采用 Pi Durable + Steel，见[设计总览](../../docs/design/README.md)。现有 `server/` 仍是旧 Pi SDK 验证工程，尚未迁移。Steel 已选为浏览器基础设施，通过启动参数启用 Durable 浏览器扩展。

## 启动真实模型

在本目录运行；已有依赖时可跳过安装：

```sh
npm ci --ignore-scripts
DEEPSEEK_API_KEY=... npm start -- --model deepseek/deepseek-flash --data runtime/deepseek
```

凭据只从环境变量或只读凭据文件读取，不要写进仓库、聊天、记忆或镜像：

- 推荐 `DEEPSEEK_API_KEY`（provider 原生支持，无需凭据文件）。
- 也可 `POINT_AUTH_FILE=/绝对路径/auth.json`（结构 `{"deepseek":{"type":"api_key","key":"..."}}`，或 `--auth <路径>`）。该文件权限应为 `600` 且必须在 `.gitignore` 覆盖范围内。
- 旧 `server/.pi/agent/auth.json` 只是历史默认位置，不再要求。

另一个终端，在本目录运行：

```sh
npm run cli
```

CLI 明确显示当前模型。凭据文件只读，也支持 provider 对应的 API key 环境变量；未实现登录和 OAuth 刷新。支持 DeepSeek / OpenAI provider，模型填写为 `provider/modelId`。现有会话保留持久配置，切换模型时使用新的数据目录。

思考默认请求 `medium`，与 Pi SDK 一样按模型能力调整；当前 DeepSeek Flash 实际为 `high`。服务启动时也会更新已有会话和未完成工作的思考配置。CLI 和 `/state` 显示实际级别。可用 `--thinking high` 显式选择，或 `--thinking off` 关闭；不支持思考的模型使用 `off`。

只想离线检查流程：`npm start` 默认启动脚本模型 `faux/faux-1`，不请求付费模型。它不是正常聊天模型；CLI 会标明。调度、工具、SQLite、文件、HTTP 和进程恢复仍真实执行。

## 体验一条完整链路

普通聊天直接输入文字，回车发送。模型处理时 CLI 仍接受输入；新消息默认排队，`/steer 内容` 补充当前执行，`/stop` 停止当前会话。后台任务独立继续。

可以先输入：

```text
你好，帮我梳理一下今天的事情
/new 杭州旅行
这次带长辈出行，行程安排要轻松，每天少走路。
请记住我的长期饮食偏好：不吃辣。
请在后台根据这个主题的要求，生成一份两天旅行安排，写入 trip-plan.md 并检查内容，完成后也给主会话一条摘要。
/main
我们继续聊别的事情。
```

后台工作会继承所属主题的背景，真实模型可直接使用 `read/write/edit/bash` 做事。新任务不再强制执行两个测试步骤；固定步骤仅用于脚本模型和显式 `--verify-steps` 验证模式。

完成后，报告先保存，结果再交给对应会话的 Agent 回答。侧聊中的任务默认只回侧聊；用户要求主会话摘要时可设置 `notifyMain`。从主会话委派到侧聊的任务默认也回报 main。CLI 在其他会话时会显示新消息提示。

继续一个主题，输入 `/use 杭州旅行`。要把该主题已有结论整理给主会话，输入 `/share`；看到“已同步主会话”后，用 `/main` 接着讨论。它不会把全部历史拼进 main，也不会自动把暂时探索保存为长期记忆。

`/quit` 仅退出 CLI。再次运行 CLI、用 `/chats` 找到主题，就能接着聊。

## 会话、任务和记忆

| 命令 | 用法 |
|---|---|
| `/chats` | 列出主会话、主题侧聊与归档状态 |
| `/new 名称` | 创建全新主题并切换过去，共享已保存记忆 |
| `/fork 名称` | 从当前会话的完整消息边界继承上下文，创建侧聊并切换 |
| `/use 名称或ID`、`/main` | 切换会话，名称重复时使用 ID 或唯一 ID 前缀 |
| `/rename 名称` | 重命名当前主题 |
| `/archive`、`/restore ID` | 归档当前主题或恢复指定主题；main 保持活跃 |
| `/start 内容` | 明确交给后台执行，不等待模型决定是否委派 |
| `/jobs`、`/job ID` | 查看后台工作与结果，支持唯一 ID 前缀 |
| `/amend ID 要求` | 给 queued/running 任务补充要求；当前模型轮结束后处理新版 |
| `/cancel ID` | 取消一个任务及其尚未交付的通知、后续计划 |
| `/after ID 毫秒` | 为已完成任务设置或替换一次跟进 |
| `/share` | 将当前主题的已确认结论、产物及未解决事项整理到 main |
| `/remember 名称=内容`、`/memory` | 显式保存、查看跨会话记忆 |
| `/forget 名称` | 删除该条保存的记忆；原会话历史仍保留 |
| `/compact [要求]` | 调用 Durable 原生上下文压缩，保留原始历史 |
| `/history`、`/history older` | 最近历史和更早记录 |
| `/steer 内容`、`/stop` | 补充或停止当前会话执行 |
| `/state`、`/help`、`/quit` | 诊断、命令说明、退出客户端 |

也支持自然语言管理侧聊、保存记忆、查询/补充/取消任务和设置一次跟进。模型使用的应用工具负责这些操作；Steel 按下面的方式启用，其他外部连接器尚未接入。

CLI 会自动重连，先读取当前快照，不承诺无限事件回放。需要恢复更早内容时查看历史。加 `--verbose` 显示工具开始执行的状态。当前 CLI 展示执行状态和完整回复，尚未实现逐字输出。

一次性命令仍可使用：

```sh
npm run cli -- chats
npm run cli -- --chat 杭州旅行 chat "我们上次决定了什么？"
npm run cli -- --chat 杭州旅行 start "整理行程" --notify-main --followup 30000
npm run cli -- --chat 杭州旅行 history
```

支持 `--json`、`--url`、`--request-id`，以及诊断用的 `history --conversation 数字ID`。主题创建与任务提交支持稳定请求 ID 去重；外部动作的幂等需另外保证。

## 本地 Docker Steel

### 默认基础设施：国内原生 RTC 镜像

已将上游 headful 分支及修复发布到 [YS-BW/steel-browser](https://github.com/YS-BW/steel-browser)，支持 AMD64 / ARM64。国内公开镜像为 `ccr.ccs.tencentyun.com/ys-bw-steel/steel-browser-webrtc:webrtc`，GHCR 副本为 `ghcr.io/ys-bw/steel-browser-webrtc:webrtc`。以后运行无需克隆 Steel 源码或本地构建：

```sh
docker compose -p point-steel-webrtc -f steel/docker-compose.yml pull
docker compose -p point-steel-webrtc -f steel/docker-compose.yml up -d
```

此配置默认使用腾讯云仓库，固定到已经发布并验证的镜像 digest。原生 RTC 操作页为 `http://127.0.0.1:3001/sessions/debug`，API 为 `http://127.0.0.1:3000/v1`。可用 `STEEL_IMAGE` 切换 GHCR，或显式使用浮动标签再执行 pull/up。国内镜像按发布批次同步，后续 GHCR 发布不代表国内标签已经更新。完整参数及试验范围见 fork 中的 [WEBRTC.md](https://github.com/YS-BW/steel-browser/blob/webrtc-headful-fixes/WEBRTC.md)。

当前本机使用这套原生 RTC 镜像提供 3000 端口的 Steel API，旧的官方 Steel 与 5173 UI 容器已移除。这套镜像独立于下方的原型媒体桥；原生播放器尚未接入 Point 的人工接管与只读控制检查。

### Steel 扩展接入

使用上方国内固定 digest 启动的 Steel 容器，不需要安装 Steel CLI。先确认 `http://127.0.0.1:3000/v1/sessions` 可访问。以下命令启用已有接管校验的 Point 原型媒体桥；正式产品优先接入 Steel 原生 RTC，原生播放器的控制权校验仍待实现，见[浏览器设计](../../docs/design/browser-infrastructure.md)：

```sh
DEEPSEEK_API_KEY=... npm start -- --model deepseek/deepseek-flash --data runtime/deepseek --thinking high --steel-url http://127.0.0.1:3000/v1 --webrtc
```

也支持 `STEEL_BROWSER_API_URL`、`STEEL_VIEWER_URL` 和独立的 `STEEL_API_KEY` 环境变量。已有会话会在启动时获得扩展，历史保留。适配器通过 Steel REST 创建和释放 session，通过 CDP 操作页面；Agent loop、工具调度和上下文继续由 Pi Durable 提供。

在 CLI 直接用自然语言，例如：

```text
打开 https://example.com，告诉我页面标题和主要内容，完成后关闭浏览器。
```

页面打开时 CLI 会显示实际任务页面的观看链接，默认只读。需要手动登录或接管时：

```text
/browser
/browser take
/browser resume
```

`take` 返回可操作的链接，并阻止 Agent 继续点击；手动操作后执行 `resume`，再发一句话让 Agent 继续。后台任务的浏览器可以在命令后指定完整 browser ID。也支持 `/browser snapshot [ID]`、`/browser screenshot [ID]`、`/browser close [ID]`。

登录状态需显式选择命名配置，例如 `/browser open https://example.com 工作账号`，或告诉 Agent 使用名为“工作账号”的 profile。保存内容为该任务隔离浏览器上下文中的 cookies 和 localStorage，写入数据目录下 `browser-contexts/` 的本地权限受限文件；不会把凭据注入共享记忆或公开状态。关闭使用此配置的浏览器后，可用 `/browser forget-profile 工作账号` 删除保存文件。它不等同于完整 Chromium profile，不包含 IndexedDB、页面内存等状态。

模型获得 7 个工具：`browser_open`、`browser_observe`、`browser_act`、`browser_reconcile`、`browser_screenshot`、`browser_handoff`、`browser_close`。页面动作必须使用最新 snapshotId/ref；进程重启后旧引用失效。浏览器记录归属具体会话或后台任务，切换/分叉会话不继承其浏览器句柄。

创建前先持久化预留 session ID，重启优先连接原 session；原 session 失效时，重新打开可从命名配置恢复登录和最后访问的 URL。动作执行前记录日志；如果提交已发生但结果还没落盘，恢复后进入 `unknown`，需观察页面并用可见证据核销，禁止自动重复点击。不承诺任意网站动作恰好执行一次。

当前本地适配器容量为 1，其他主题/任务会收到忙碌提示。默认空闲 2 分钟、人工接管 10 分钟、总计最多 30 分钟后清理；空闲期限可用 `--browser-idle-ms` 调整。后台任务完成或取消也会清理。租约由 Durable task 管理，服务离线时不执行清理，重启后补做。页面快照目前支持主文档和开放的 Shadow DOM，尚未支持 iframe 内元素。

### WebRTC 操作页（原型媒体桥，保留用于验证）

本机使用 `uv` 和 Python ≥ 3.10 安装媒体桥接依赖，再在原启动参数后加 `--webrtc`：

```sh
npm run setup:webrtc
DEEPSEEK_API_KEY=... npm start -- --model deepseek/deepseek-flash --data runtime/deepseek --thinking high --steel-url http://127.0.0.1:3000/v1 --webrtc
```

打开 `http://127.0.0.1:4788/browser/view`，有活动浏览器时会自动显示画面；CLI 返回的观看链接也会指向此页。右上角“接管”“交回 Agent”与 CLI 命令共享同一控制状态；接管后可直接点击、输入、滚动，中文输入或粘贴也可使用下方“发送文字”。只读/交回状态的输入由服务端拒绝，关闭页面会释放媒体连接。分支自带的原生 RTC 播放器位于 `http://127.0.0.1:3001/sessions/debug`。

下方会显示输入通道是否连接以及输入是否送达；通道断开时文字入口禁用，画面连接失败会提示并自动重试。截图有独立的超时，不占用接管和媒体连接的操作队列。采集端保留每一次画面更新，视频轨道单独限制为 15 fps，避免静态网页最后一次更新被丢掉。

视频按窗口可视高度缩放，聚焦时保留外层页面的滚动位置，防止点击坐标在聚焦过程中偏移。主框架导航后会重启采集，避免跳转成功后继续播放旧网页；媒体桥不再用截图回退来等待首帧。

画面是 VP8 视频轨道，通过 WebRTC SRTP 传输；输入通过有序 DataChannel（SCTP/DTLS）回传。SDP offer/answer 通过本地 HTTP 协商。Steel → 本地媒体桥仍使用 CDP screencast 的 JPEG 帧，桥接层解码、编码为 VP8；没有把 JPEG 包装成 DataChannel 冒充视频。Agent 的 CDP 工具通道不变。

媒体桥是服务按需启动的独立 Python 进程，绑定本机随机端口，使用临时令牌。父进程退出/强杀时通过 stdin EOF 清理，不拥有 Steel 生命周期；浏览器状态由 Durable 保留。单个页面共享一个 CDP 采集源，最多 4 个观看连接分别编码。当前输出最多 1280×800、15 fps，仅视频；不含音频、TURN、外网穿透或硬件编码，尚未做带宽/CPU 优势的对照评测。`--webrtc-python` 可指定其他已装依赖的 Python。未加 `--webrtc` 时沿用原生 Steel 播放器。

## 状态、恢复与结果路由

```text
CLI ── HTTP / SSE ── 常驻服务
                      ├─ main：长期主会话
                      ├─ 主题侧聊：独立历史，fresh / fork
                      │    └─ Work task → 内部执行会话 → 产物 → Report task
                      ├─ Share task：整理主题结论 → main
                      ├─ Followup task：持久时间点 → 模型生成跟进
                      └─ 共享显式记忆：值、类型、来源会话、更新时间
                                    │
                              Durable / SQLite
```

工作成功后，报告记录、业务完成状态、结果回传任务和跟进计划在同一事务创建。回传任务通过带稳定请求 ID 的 `submit()` 将结果送入目标 Agent：结果进入模型上下文，主/侧聊能继续追问。生成后发布 UI 事件，强杀恢复不会重复提交同一个通知。

主题归档不终止已有后台任务。归档后新路由的结果和跟进转入 main；已经进入模型队列的消息可能仍留在原会话历史。恢复主题后沿用原会话。取消不能撤销已经发生的外部动作或已被目标模型接收的消息。

记忆目前是最多 64 条用户明确保存的事实、偏好、决定，带来源记录，按大小限制注入每次请求。不是向量记忆或自动知识抽取；完整值可由工具读取。遗忘保存条目不删除历史；旧历史仍可能包含这些内容。工作结果、主题摘要、长期记忆分别管理。

主会话和主题会话身份、任务、记忆均持久化。Durable 自动压缩沿用默认策略；本轮还通过手动压缩验证了活动上下文缩小、原记录仍可分页读取、共享记忆继续生效。

服务启动行包含 PID。可强杀该 PID，再以相同参数重启；同一目录只允许一个服务进程。进程停止时工作不会执行，重启后恢复调度；原型不负责自动拉起进程。既有验证目录通过增补字段升级，保留原 root、会话和任务。默认离线目录是 `runtime/default`。

## 独立外部接收端

```sh
npm run sink
```

另一个终端启动服务时加：

```sh
npm start -- --sink http://127.0.0.1:4789 --data runtime/with-sink
```

接收端使用独立 SQLite 记录请求与实际效果，仅模拟本地通知，不发给邮箱或其他人。`GET http://127.0.0.1:4789/deliveries` 可查看账本。

有幂等契约时，恢复后以相同键重发；没有幂等契约时必须给服务加 `--unsafe-delivery`，未确认的投递进入 `unknown`，不自动重复。接收端 `--no-idempotency` 可模拟此渠道。普通网络错误同样保守进入 `unknown`；尚无自动退避或人工核销界面。

## 验收

```sh
npm run check
npm test
npm run test:real
npm run test:steel
npm run test:webrtc
```

完整离线套件 28 项：原有 13 项恢复/执行测试、11 项会话与产品链路测试、2 项思考配置与旧会话升级测试，以及截图阻塞隔离、聚焦坐标稳定性两项回归测试。默认七个关键故障窗口各强杀 10 轮，共 70 次关键故障注入；新窗口包括模型通知已提交后、UI 发布前。另覆盖主题隔离、fork、共享记忆纠正与遗忘、原生压缩、历史分页、归档路由、结论同步、CLI 异步输入，以及改期/取消撤回排队中的消息。

`POINT_CRASH_ROUNDS=1 npm test` 可快速检查。每轮用独立进程与数据目录。**`runtime/latest-*.json` 只保存最后一次运行，任何一次快速跑都会覆盖它**；需要长期引用的证据在 [`evidence/`](evidence/README.md)，数字与时点的唯一口径见[验证状态](../../docs/design/verification-status.md)。

**已入库证据**（`evidence/`，含 SHA-256 清单与复现命令）：

- `evidence/offline-execution-2026-10-18T16-55Z.json`：原有执行/恢复场景 13/13，含 4 个故障窗口 × 10 轮。
- `evidence/offline-conversations-2026-10-18T16-55Z.json`：会话与结果回传 11/11，含通知 2 个窗口 × 10 轮。
- `evidence/real-model-2026-10-18T04-54Z.json`：真实模型验收；没有凭据时明确输出 `SKIPPED`。
- `evidence/steel-2026-10-18T09-37Z.json`：5 组真实 Steel 浏览器验收，包括同 session 恢复、创建/提交窗口强杀、过期恢复登录、引用失效、人工接管、空闲与取消清理，以及真实模型自然语言操作（该次运行使用 `http://127.0.0.1:3000/v1`，未记录镜像 digest）。
- `evidence/webrtc-2026-10-18T10-06Z.json`：实际 SRTP 视频解码、DataChannel 点击/中文/空格输入、保存和导航后视频像素更新、只读与交回后拒绝输入、连接清理、父进程强杀与原 Steel session 保留。
- `evidence/acceptance-summary-2026-10-17-obsolete.json`：已废止的 24 项旧口径，仅作历史。

原始运行目录（含 SQLite 与逐轮 `work-attempts.jsonl`）保留在 `runtime/tests-*/`，属于本地产物、不入库。

真实模型验收包括：主会话 write/read；自然语言保存偏好；全新侧聊读取共享记忆；从主题背景取两个参数，后台实际计算、写文件、read 核对；两处模型可见的交付；主会话正确回答计算结果；主题同步；模型生成定时跟进；强杀重启后仍能读取偏好与同一主题。使用独立目录，不修改交互演示的数据。

`test:real` 默认读取 `../../server/.pi/agent/auth.json`，也可设 `POINT_AUTH_FILE` / `POINT_REAL_MODEL`。最新运行状态以结果文件为准，历史记录见各 `runtime/tests-时间/` 目录。运行目录用 UTC 命名，本地验收日期可能已是次日。`runtime/`、`node_modules/` 和 `.env` 均被忽略。

`test:steel` 是显式运行的真实集成验收，需要本地 Docker Steel API；可设 `POINT_STEEL_TEST_URL`。测试创建自己的本地表单站点和独立数据目录，不改交互演示会话。有真实模型凭据时同时验证自然语言工具循环，否则明确跳过该项。测试会占用唯一浏览器容量，应在无其他浏览器任务时运行。

`test:webrtc` 需先执行 `setup:webrtc`，同样占用本地 Steel 容量；用真正的 WebRTC 接收端解码视频，并将输入经 DataChannel 写入本地测试表单。另一次浏览器 UI 实测记录在 `runtime/webrtc-ui-results.json`：真实 Chromium 解码 VP8、鼠标点击/中文保存、两个观看连接共享一个采集源，以及媒体进程强杀后重连。

## 备份与恢复

`state.sqlite` 处于 WAL 模式，**不要直接 `cp`**：未 checkpoint 的 WAL 内容会丢。使用 SQLite 自身的一致性快照：

```sh
node scripts/backup.mjs --data runtime/deepseek --out backups --keep 7
# 等价：npm run backup -- --data runtime/deepseek
```

产物：`backups/<UTC 时间戳>/{state.sqlite, workspace/, browser-contexts/, manifest.json}`，其中 `manifest.json` 记录文件大小、SHA-256、表清单与 `integrity_check` 结果；脚本在写完后会重新打开快照校验，失败则退出码 1。`owner.sqlite` 只是进程锁文件，不备份。

恢复步骤（**先停止服务**，同一数据目录只允许一个写入者）：

```sh
# 1. 选一份备份并核对清单
ls backups/
node -e "const m=require('./backups/<时间戳>/manifest.json'); console.log(m.integrity, m.files.length)"
# 2. 恢复到新目录，确认无误后再替换
mkdir -p restored && cp backups/<时间戳>/state.sqlite restored/ && cp -r backups/<时间戳>/workspace restored/
# 3. 用恢复目录启动并检查 /health 与 /chats
node src/server.mjs --port 4799 --data restored
```

2026-10-19 做过一次完整演练：`runtime/default` 在线快照 → 用快照单独启动服务 → `/health` 正常、`/chats` 与历史条目可读，`integrity_check=ok`。这只证明单机单进程的恢复路径，**不覆盖**浏览器侧 Chrome profile、Steel 容器重建与跨机恢复。

## 文件与边界

- `src/service.mjs`：会话与任务操作、业务工具、Work / Report / Share / Followup。
- `src/conversations.mjs`：会话查找、安全分叉点、共享记忆呈现、可见消息。
- `src/client.mjs`：交互 CLI、会话切换、异步消息与自动重连；`src/cli.mjs` 为入口。
- `src/browser.mjs`：Durable 浏览器扩展、会话归属、动作日志、登录检查点和清理租约；`src/steel.mjs`：Steel REST/CDP 适配器。
- `src/webrtc.mjs`、`webrtc/bridge.py`：受监督的 WebRTC 媒体桥；`src/rtc-viewer.*`：操作页；`webrtc/requirements.txt`：固定版本的 Python 依赖。
- `scripts/check.mjs`：语法检查；`scripts/backup.mjs`：在线备份；`scripts/audit-context.mjs`、`scripts/audit-native-pi.mjs`：调研期提示词/上下文审计脚本。**注意**：两个 audit 脚本直接引用旧 `server/node_modules` 里的 Pi SDK 内部模块，需要先在 `server/` 执行 `npm install` 才能运行，且不在 `npm test` 内；正式 Server 迁移后应删除或重写。
- `src/server.mjs`：本地 HTTP/SSE；`src/models.mjs`：provider 与脚本模型；`src/sink.mjs`：接收端。
- `test/`：进程集成测试、故障注入和真实模型验收。

服务监听本机。没有独立 Web 产品界面、完整连接器生态、独立 Goal 规划器或判断何时主动联系用户的策略。一次跟进需用户明确设置；长任务的真正完成效果仍取决于模型与验收标准。尚未做数天压力测试、Pi 插件迁移、自动压缩质量与复杂供应商故障的全面验收。

[初始执行机制验证](../../docs/research/pi-durable-validation-2026-10-18.md) · [会话设计调研](../../docs/research/muse-conversation-design-2026-10-18.md) · [Steel 接入验证](../../docs/research/steel-durable-validation-2026-10-18.md) · [WebRTC 验证](../../docs/research/steel-webrtc-validation-2026-10-18.md)
