# Point 项目现状分析

> 日期：2026-10-19。方法：4 路并行只读分析（原型 / 遗留工程 / 设计文档 / 治理运维）+ Lead 独立复验。
> 口径：**【事实】**= 有文件、行号或命令输出可核对；**【推断】**= 分析判断。本文不改写任何既有文档。

---

## 一、结论速览

**阶段判定：验证原型已完成，正式产品尚未开工。** 项目处在「设计 + 验证」阶段的收尾点，而不是实现阶段的中途。

一句话概括：**一套质量相当高的单人持续 Agent 设计，加上一个 3.7k 行、可运行、做过 70 次进程级强杀注入的原型，证明了两件最难的事（崩溃恢复、浏览器接管互斥）；但产品化的四块地基——正式 Server、Web 客户端、原生 RTC 控制权、鉴权/部署/备份——全部为空，且工程治理让"已验证"无法被外部独立复核。**

| 维度 | 判断 | 一句话依据 |
|---|---|---|
| 产品与架构设计 | **A-** | 11 份设计文档共用严整的「已定/已验证/待实现」口径，主动披露缺口；缺 roadmap、ADR、license |
| 活跃原型质量 | **B+** | 3746 行 mjs + 432 行 py，28 项离线测试全绿、70 次强杀、5 组真实 Steel、2 组 WebRTC 全部通过；但 `service.mjs` 781 行是 god module，无单测 |
| 验证证据强度 | **B** | 证据真实且可复跑，但**证据不入库、可被覆盖、无代码版本号**；Steel 侧仍是旧基线交互验收 |
| 工程治理 | **D** | 无 git、无 CI、无 lint、无备份；2.0 GB 工作区，可提交源码仅 135 文件 / 1.55 MB |
| 运维就绪度 | **D** | Server 无 Dockerfile/supervisor/日志/备份；手工启动裸跑约 7 小时 |
| 产品完成度 | **≈25%** | 五阶段路线图中**阶段 1-5 全部未开始**，仅阶段 1 的前置资产已备 |

---

## 二、这是什么项目

**【事实】** Point 是只服务一个人的、持续运行的 personal agent，参考 Muse 形态：长期主会话 + 主题侧聊 + 后台执行会话 + 共享记忆 + 浏览器与产物（[docs/design/README.md](design/README.md:8)）。首个验证场景是承诺与待办，不是能力边界。

**三层架构（10-18 定）**：Point 产品层（会话关系、任务/目标语义、记忆策略、触发判断、结果路由、浏览器控制权）→ Pi Durable（Agent loop、上下文/压缩、工具、持久任务、checkpoint 与恢复）→ Steel（独立容器，Chromium + REST/CDP + 原生 WebRTC）。不建多用户/租户/角色系统。

**架构演进有两次反转（【事实】）**：

| 时点 | 决定 | 证据强度 |
|---|---|---|
| 10-16 | 最初就选 **pi-durable** 作 L0（`.research/` 4 份代码级审计） | 强 |
| 10-16 稍后 | 改为 **Pi coding-agent SDK**（理由是终端插件复用） | **零实验证据**——档案自述"本轮没有运行集成测试"（[archive/2026-10-18-before-pi-durable-steel/runtime-selection.md](design/archive/2026-10-18-before-pi-durable-steel/runtime-selection.md:36)） |
| 10-18 | 切回 **Durable + 引入 Steel** | 中偏强（当天原型 + 6 份验证/发布报告） |

【推断】净结果是回到起点。第一轮转向用"未量化的插件复用收益"换掉了已验证的恢复原语；第二轮用"承认的适配成本"换了回来。**问题被绕回原点，而不是被回答**：两侧都从未实测过 Pi 插件迁移成本，这是当前选型证据链上最薄的一环。

**仓库构成**：`docs/`（design 11 + research 13）、`openspec/`（已配置、未启用）、`.research/`（554 MB 调研期材料，永不入库）、`server/`（旧 SDK 验证，166 MB）、`infra/`（3 个验证工程，1.3 GB）。全仓 **2.0 GB**，但排除 node_modules/runtime/.research 后真实源码只有 **157 个文件**。

---

## 三、当前实况（全部可核实）

### 3.1 代码

| 项 | 数值 |
|---|---|
| 活跃实现 | `infra/pi-durable-validation/`：src 2424 + test 1071 + scripts 251 = **3746 行 .mjs**，另有 webrtc Python **432 行** |
| 核心模块 | `src/service.mjs` 781 行（4 个 Durable Task + 全部产品工具 + 状态迁移 + 文件 IO）、`src/browser.mjs` 427、`src/client.mjs` 277、`src/steel.mjs` 256、`src/server.mjs` 164 |
| 依赖 | `@earendil-works/{pi-durable,pi-ai,chord}` 全部精确 **1.3.0**、puppeteer-core 25.14.0、Node ≥22.19（实测 v22.22.3）；**全部来自 npmjs 公开包 + integrity**，无漂移 |
| 遗留 | `server/` 旧 Pi SDK 验证：src 373 + test 733 行；`infra/agent-browser` 81 行；`infra/dsh-validation` 212 行 |

### 3.2 验证（本轮独立复跑）

- **【事实】** `npm run check`：exit 0，27 个模块语法检查通过（仅 `node --check`，无 lint/类型检查）。
- **【事实】** `POINT_CRASH_ROUNDS=1 npm test`：exit 0，**28/28 pass、0 skip、20.06 秒**。28 = prototype 13 + conversations 11 + thinking 2 + 回归 2，与 README 口径一致。
- **【事实】** 恢复默认 **10 轮（7 窗口 × 10 = 70 次强杀）复跑**：exit 0，**28/28 pass、0 fail、45.5 秒**；`latest-results.json` / `latest-conversation-results.json` 已回到 `crashRoundsPerPoint:10`。即"70 次故障注入"这条 README 声称在本机当前代码上是**可独立复现的**，不只是历史记录。
- **【事实】** 既有证据（10-18）：`steel-results.json` 5/5、`webrtc-results.json` 2/2、`real-model-results.json` passed（deepseek-flash，25 秒）、原 10 轮强杀 run 目录仍完整保留。
- **【事实·已修复】** 我们的快速跑曾把 `runtime/latest-*.json` 从 rounds=10 覆盖为 rounds=1；分析结束前已用 10 轮重跑恢复。这本身暴露了一个问题（见 §5 P1-6）。

### 3.3 运行中的实例

- **【事实】** Point 原型进程 PID 15551 已连续运行约 **7 小时**，手工 CLI 启动，监听 `127.0.0.1:4788`，带 `--steel-url` + `--webrtc`（数据目录 `runtime/deepseek`）。
- **【事实】** Steel 容器 `steel-webrtc` Up 约 1 小时（healthy），固定腾讯云 digest，端口全部 loopback。
- **【事实】** 实时状态：1 个 chat（main）、0 个 job、0 条记忆、1 个已关闭浏览器 session。**当前处于空闲演示态**。
- **【推断】** 崩溃即停，无人拉起——没有任何 supervisor/launchd/systemd 配置。

### 3.4 磁盘

**【事实】** 2.0 GB：`infra/pi-durable-validation/runtime` 约 627 MB / 9136 个文件（其中 `steel-rtc-audit` 337 MB 是两个外部源码克隆、`tests-*` 50 个目录 188 MB、webrtc-venv 72 MB）、`infra/dsh-validation/node_modules` 529 MB、`.research` 554 MB、三处 node_modules 合计 855 MB。可用 **≈1.1 GB** 是可回收的。

---

## 四、健康度：设计诚实，实现扎实，治理空白

### 4.1 设计层面（11 份文档）

**【事实】** 设计体系本身质量高：统一状态口径、逐份分工、主动披露缺口（例如 [browser-infrastructure.md](design/browser-infrastructure.md:60) 直接写明"已发布 Steel 原生调试播放器尚未接入这些检查"）。约 73 条"已定"决定中，约 1/3 有实验证据，约 45% 被文档自己标为待实现/待验证。

**【事实】证据分布极不均匀**：L3 执行层与浏览器层厚；L2 判断层（[decision-layer.md](design/decision-layer.md)）、L1 周期计划、L4 真实通知渠道、L5 部署、L6 评测几乎为零证据。

**【事实】OpenSpec 已配置但未启用**：[openspec/config.yaml](../openspec/config.yaml) 的 context 与设计高度一致，但 `specs/`、`changes/` 只有 `.gitkeep`。设计"已定"没有可机器校验的 spec 基线。

### 4.2 值得肯定的部分（不是客套，是资产）

1. **【事实】** 70 次进程级强杀注入覆盖 7 个故障窗口，另有幂等接收端双账本、`unknown` 态与 reconcile 语义——这是同类个人 agent 原型里少见的严谨度。
2. **【事实】** 报告记录/完成状态/回传任务/跟进计划确实在**单个 commit** 内完成（`service.mjs:464-484`），比设计的"尽量同事务"更严格。
3. **【事实】** 单写者锁实现可靠：`owner.sqlite` 上 `BEGIN EXCLUSIVE`，第二个进程被明确拒绝，SIGKILL 后由 OS 释放。
4. **【事实】** 投递 intent-before-effect、浏览器动作 `unknown/reconcile`、stale snapshotRef 拒绝、预留 session ID 恢复——这些是把"外部副作用恰好一次"问题当真处理了。
5. **【事实】** 原型能力**领先**设计文档的地方：故障注入矩阵、单事务回传、浏览器恢复契约、CLI 异步输入。

---

## 五、关键风险（按冲击排序）

### P0 —— 会直接摧毁"已验证"的可信度或数据

**1. 没有 git，且验收证据全部落在被 ignore 的 `runtime/` 里。**
**【事实】** 全仓无 `.git`；`runtime/*-results*.json` 共 48 KB，全部在 `runtime/`，而 `runtime/` 被 `.gitignore` 忽略。结果文件里只记 `version:"1.3.0"`（pi-durable 版本），**没有任何 Point 代码版本/提交号**。
→ 即使现在 `git init`（会得到干净的 135 文件 / 1.55 MB），"已验证"仍然不可溯源。**这是本项目最需要先修的一项**，因为后三项风险都会因为它的存在而继续累积。

**2. 零备份，且现有手工备份在 WAL 模式下不安全。**
**【事实】** 全仓无备份脚本，`runtime/backups/` 的 7 个目录是手工 `cp state.sqlite`（无 `-wal`）；SQLite 为 WAL 模式（auto-checkpoint 1000 页）。**在线拷贝会丢未 checkpoint 的数据**。`runtime/` 不在任何版本库、也不在任何备份中 → 一次磁盘故障丢掉全部会话、记忆与验收证据。
→ 设计文档承诺的"正式部署前验收备份/恢复一致性"（[product-and-architecture.md](design/product-and-architecture.md:56)）**无实现、无演练**。

**3. 凭据是单点，且路径进入进程参数。**
**【事实】** `server/.pi/agent/auth.json`（96 B / 600，明文 deepseek key）是**三个工程的凭据宿主**（`infra/dsh-validation` 与原型 test/real-model 都默认读它）；运行中的 PID 15551 把 `--auth ../../server/.pi/agent/auth.json` 暴露在 `ps` 里；全仓无 `.dockerignore` → "凭据不进镜像"目前是空真。全 runtime `grep sk-` 零命中，**承诺未被违反**。

**4. 产品化的四块地基全空。**
**【事实】** ①Point Server 无 Dockerfile/compose/supervisor/日志；②无 Web 客户端（只有 CLI + 单页观看页）；③**Steel 原生 RTC 播放器未接入 Point 接管互斥**——设计把它列为"正式集成前必做"，原生信令端口 3001 在 `src/` 内零命中；④无任何鉴权（仅 loopback Host/Origin 校验）。

### P1 —— 决定能否从原型走到产品

**5. 长跑风险未验证，且结构上有放大隐患。**
**【推断】** `State` 是单个 document（`history=latest`），jobs/shares/requests/actions 从不清理（只有 events 截断 200）；每次 commit 重写整文档；SSE 每次 commit 推完整 snapshot，且 snapshot 对每个 job 调 `harness.getTask` → 事件流成本 O(jobs)。单用户短期无碍，数天/数周运行需压测。

**6. 测试证据可被静默覆盖，且一处汇总已陈旧。**
**【事实】** `runtime/latest-results.json` 与 `latest-conversation-results.json` 只存"最后一次运行"，任何快速跑都会降级（我们这次就触发了）；`runtime/acceptance-summary.json` 仍写 **24/24**，而 README 与实际都是 **28**。

**7. 已知能力边界没有进入产品决策表**：iframe 不支持（只走 document + open shadowRoot）、浏览器容量硬编码 1、本地 HTTP 无鉴权、无 CI、无 lint。

### P2 —— 文档与工程卫生

**8. 文档口径分叉。** 【事实·已于 2026-10-19 修复】两处 research 的"历史调研说明"banner 当时仍写「**已改用 Pi SDK**」（[proactive-personal-agent-2026.md](research/proactive-personal-agent-2026.md:1)、[tech-stack-selection-2026-10-16.md](research/tech-stack-selection-2026-10-16.md:1)），与现行决定**直接相反**——修 banner 的人把 banner 加在了被推翻的结论上。另外"测试数"在 4-5 份文档有 13/26/28 三个时点值，"语法模块数"有 16/17/21/27 四个值；`design/README.md:51` 的"Steel 接入已验证"缺少"旧基线、发布镜像待重跑"的限定。（以上四项修复见文末「治理落地记录」）

**9. 依赖与供应链的单点**：`@earendil-works` 1.3.0 早期生态（content 有 integrity 保障、可获得性无保障）；typebox 顶层 1.4.0 与 SDK 内嵌 1.3.27 双版本共存；`STEEL_IMAGE` 环境变量可覆盖 digest 为浮动 tag；无 `.npmrc`，而 Steel 走腾讯云、npm 走 npmjs，网络策略不一致。

**10. 工具链空转**：无 CI、无 lint/format、OpenSpec 未启用、`.agents/skills` 与 `.dsh/skills` 是同一批 skill 的三份拷贝且无同步机制（当前未漂移）、无 license 决定、无 roadmap、无 ADR 记录两次选型反转。

**11. 【待复核，低优先】** 浏览器登录检查点：机制已实现且测试断言 0600 文件存在（`browser.mjs:71-92`、`test/browser-real.mjs:35-39`），但当前磁盘上 40 余个 `browser-contexts/` 目录**全部为空、0 个 profile 文件**。可能是测试后清理或目录复用，建议用一次真实登录复核证据链。

---

## 六、与设计目标的差距：五阶段全部未开始

设计已给出明确实施顺序（[runtime-selection.md](design/runtime-selection.md:55-63)），逐项对照：

| 阶段 | 设计内容 | 现状 | 性质 |
|---|---|---|---|
| 1. 正式 Server | 从原型提取运行时与产品模块，稳定状态与 ID | **未开始**。全部仍在 `infra/pi-durable-validation/`；`server/` 是旧工程且是凭据宿主 | 有基础，缺动工 |
| 2. 稳定状态与 API | chat/task/plan/artifact/delivery/browser ID 与版本、HTTP/SSE 契约、幂等与升级 | **部分**。有增量状态升级（`initializeState`）、局部幂等键；无 API 版本、无契约测试、无迁移框架 | 部分 |
| 3. Steel 原生 RTC | 拉固定 digest、复测 REST/CDP、原生信令/输入接入同一控制权校验 | **未开始**。控制权检查只在自建 Python 桥；设计明确"不把 Python 桥设为长期必需组件" | **缺口最大** |
| 4. 薄 Web 产品 | 对话/主题/任务/产物/浏览器侧栏 | **未开始**。只有 CLI | 缺 |
| 5. 长期使用 | 常驻部署、周期计划、供应商故障退避、记忆规模、备份与资源回收 | **未开始**。仅一次性 Followup（≤24h） | 缺 |

**【推断】** 一个结构性的判断：**阶段 1-2 是"整理已有资产"，阶段 3 是"未验证的新技术风险"，阶段 4-5 是"产品工程量"。** 其中阶段 3 风险最高——它不是"再写一遍"，而是要在别人 fork 的原生 WebRTC 播放器上补齐凭证签发、逐次输入检查、陈旧连接失效，且当前 fork 还有滚轮/特殊键/多会话待验收项。**如果要压缩总工期，阶段 3 的技术预研应该与阶段 1 并行启动，而不是串行等 Server 稳定。**

---

## 七、判断与建议

### 7.1 我的判断

1. **不该再验证一次。** 现有原型的证据强度已经足够支撑"进入实现"这个决定；再跑一轮验收只会增加时间、不增加信息。
2. **也不该把原型直接当产品部署。** 它缺的不是功能，是四条产品地基和全部运维面。
3. **真正的下一个决策点是：冻结基线，开工阶段 1。** 而在此之前必须先花半天把治理补上——否则接下来的实现过程依然无法回溯、无法备份、无法协作。

### 7.2 建议动作顺序

**本周（约 2 天，全部低成本高杠杆）**

1. `git init` + 补 ignore（`*.DS_Store`、`.env`、`server/.pi/agent/models.json`）+ **把 48 KB 验收证据从 `runtime/` 提升为入库路径**（如 `infra/pi-durable-validation/evidence/`，README 改引用），首提交打 tag `baseline`。→ 解决 P0-1，这是其他一切的前提。
2. 写 SQLite 在线备份脚本（`VACUUM INTO` 或 backup API），覆盖 `state.sqlite + owner.sqlite + workspace/ + browser-contexts/`；停服做一次**恢复演练**。→ 解决 P0-2，同时兑现设计承诺。
3. 凭据从 argv 移到 `POINT_AUTH_FILE` 环境变量；补 `.dockerignore`。→ 解决 P0-3。
4. 文档口径收敛：修两处「已改用 Pi SDK」banner、给"Steel 接入已验证"加限定、把旧 `acceptance-summary.json` 标记为废止（实际 28 项口径写入新文档）、新增 `docs/design/verification-status.md` 作为单一证据口径。→ 解决 P2-8。**已于 2026-10-19 落地。**

**两周内**

5. 阶段 1：从原型抽离正式 Server。**建议不要按设计原文"迁入 `server/`"**——那会把新代码塞进旧目录并牵动 3 个工程的相对路径（`../../server/.pi/agent/auth.json`），成本 L。改为"新目录 + `server/` 只读归档"，成本可降到 M。顺手拆 `service.mjs`（god module 是后续所有改动的摩擦源）。
6. 最小 CI：`npm ci && npm run check && POINT_CRASH_ROUNDS=1 npm test`（离线套件，不跑 real/steel）。→ 解决 P1-6/7。
7. runtime 归档清理：保留证据指向的 `tests-*` 与 `results`，回收约 1.1 GB。

**并行的技术预研（不要串行等）**

8. 阶段 3：在发布镜像上验证原生 RTC 输入的逐次控制权校验、凭证签发与旧连接失效。这是全项目最大的未知数，值得单独开一个 spike。

**不要做**

- 不要再换执行引擎（已两次反转，且设计明确禁止第二套引擎）。
- 不要并行跑旧 SDK。
- 不要在没有备份和版本控制的情况下继续加功能。

---

## 八、口径说明（本次分析做了什么、没做什么）

**做了**：4 路并行只读分析 + Lead 复验；独立运行 `npm run check` 与离线测试套件；读取全部设计/调研文档、全部 runtime 证据文件、全部源码模块结构；盘点了磁盘、凭据、依赖来源、运行中进程与容器。

**没做（能力或约束边界）**：
- 未复跑 `test:real` / `test:steel` / `test:webrtc`（会消耗付费模型、占用唯一浏览器容量）。因此 §3.2 中真实模型、Steel、WebRTC 的结论**仅依据 10-18 的既有证据文件**，不是本轮独立复验。
- 未验证：原生 RTC 接管、数天/数周长跑、供应商故障退避、公网 ICE/TURN/TLS、iframe/关闭 Shadow DOM、跨平台媒体桥。
- 未执行任何删除、移动、docker 变更或依赖安装；唯一副作用是测试写入了 `runtime/` 新目录，并已恢复 10 轮基线。

**一句话收尾**：这个项目最稀缺的不是更多的验证，而是**把已经验证过的东西固定下来**——版本、证据、备份、部署。设计文档值得信任的程度，已经超过了它当前被保存的方式。

---

## 九、治理落地记录（2026-10-19）

本文列出的建议在分析完成后立即执行了一轮，结果如下。目标是让后续实现有基线、可回溯、可回滚。

| 项 | 动作 | 结果 |
|---|---|---|
| P0-1 版本控制 | `git init`，首次提交为 `baseline` tag，托管到 GitHub `YS-BW/Point`（公开，MIT） | 可提交源码 **135 个文件**；`.gitignore` 覆盖 `runtime/`、`sessions/`、`workspace/`、`node_modules/`、`.research/`、`auth.json`、`models.json`、`.env` |
| P0-1 证据溯源 | 验收 JSON 从 `runtime/` 复制为 `infra/pi-durable-validation/evidence/`，附 `manifest.json`（SHA-256）与索引 | 证据入库；`runtime/latest-*.json` 的覆盖陷阱写入索引 |
| P0-2 备份 | 新增 `scripts/backup.mjs`（SQLite `VACUUM INTO` + 工作区 + 登录检查点 + integrity_check），并做一次恢复演练 | `npm test` 28/28 前已确认；演练：快照启动服务后 `/health`、`/chats`、历史可读，`integrity_check=ok` |
| P0-3 凭据 | `--auth` 改为 `POINT_AUTH_FILE` 环境变量回退；README 改用 `DEEPSEEK_API_KEY`；补 `.dockerignore`、`.env.example`、`models.example.json` | 凭据路径不再必须出现在 argv |
| P1-6 测试证据 | `POINT_CRASH_ROUNDS=10` 复跑确认 70 次强杀可复现；`acceptance-summary.json` 标注废止 | `verification-status.md` 成为唯一口径 |
| P2-8 文档口径 | 修两处「已改用 Pi SDK」banner；给"Steel 接入已验证"加限定；新增 `verification-status.md` 与 `ADR-001` | `npm run check` 模块数更新为 28 |
| P1-7 CI | `.github/workflows/check.yml`：`npm ci` + 语法检查 + 单轮离线套件 + 凭据扫描 | 最小质量闸门 |
| 体积 | 可再生 1.1 GB 移出源码树（本地归档 `~/.point-archive/2026-10-19/`，含清单） | 工作区 **2.0 GB → 约 0.9 GB** |

**仍未做**：正式 Server 抽离、Web 客户端、Steel 原生 RTC 控制权、容器化与常驻拉起、鉴权、长跑压测。它们仍然是本文 §6 与 §7 的判断对象，本轮治理只解决"基线、证据、备份、凭据、流程"这五项前置条件。
