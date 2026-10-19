# 验证状态：唯一证据口径

> 更新：2026-10-19。**本表是 Point 验证数字与时点的唯一引用来源。** 其他文档（`docs/design/`、`docs/research/`、`infra/pi-durable-validation/README.md`）中的旧数字是各自写作时点的历史值，不再作为引用依据；冲突时以本表为准。
>
> 交叉引用：[ADR-001 Agent 层选型](adr/ADR-001-agent-layer-selection.md) · [证据归档说明](../../infra/pi-durable-validation/evidence/README.md)
>
> 口径：**【事实】**= 有证据文件或命令输出可核对；**【推断】**= 分析判断。证据目录 `runDirectory` 用 UTC 命名，本地验收日期可能已是次日。

## 证据表

| 证据项 | 数值 | 时点 (UTC) | 证据路径 | 复现命令 | 边界 |
|---|---|---|---|---|---|
| 离线测试套件 | **28 项通过**（13 prototype + 11 conversations + 2 thinking + 2 回归），0 fail / 0 skip | 2026-10-18T16:55Z（最近一次 10 轮复跑）；原始记录 2026-10-18T10:13Z | `runtime/tests-2026-10-18T16-55-16-498Z/`、`runtime/tests-2026-10-18T16-55-33-796Z/`；原始 `runtime/tests-2026-10-18T10-13-26-310Z/`、`runtime/tests-2026-10-18T10-13-42-932Z/` | `cd infra/pi-durable-validation && POINT_CRASH_ROUNDS=1 npm test` | 脚本模型 `faux/faux-1` 离线运行；Node v22.22.3；集成测试含固定 sleep/超时，高负载机器上可能抖动；不是产品级验收 |
| 故障注入（强杀） | **7 个窗口 × 10 轮 = 70 次** SIGKILL，全部 passed | 同上（2026-10-18T16:55Z） | 同上两个 `tests-*/` 目录内的 `results.json` / `conversation-results.json`；窗口定义见 `test/prototype.test.mjs` 与 `test/conversations.test.mjs` | `POINT_CRASH_ROUNDS=10 npm test`（默认值即 10） | 只覆盖进程被强杀的 7 个时点；不证明任意外部动作恰好执行一次；不能替代长跑与供应商故障验收 |
| 真实模型验收 | passed：主会话工具循环、跨会话记忆、后台工作与结果回传、主题同步、模型生成跟进、重启后恢复 | 2026-10-18T04:54Z | `runtime/real-model-results.json` | `npm run test:real`（默认读 `../../server/.pi/agent/auth.json`，可用 `POINT_AUTH_FILE`） | 单次、小样本 `deepseek/deepseek-flash`（约 25 秒）；需付费凭据；不代表复杂任务完成率或成本 |
| Steel 浏览器验收 | **5 组全通过**：真实表单/过期引用/单实例隔离/接管/同 session 重启/登录恢复；创建后强杀复用预留 session；提交后强杀需 observe+reconcile 不重复提交；空闲与取消清理 | 2026-10-18T09:37Z | `runtime/steel-results.json` | `npm run test:steel`（需本地 Steel API，`POINT_STEEL_TEST_URL` 可覆盖） | **旧 Steel 基线**上的验收；发布镜像上的完整交互与原生 RTC 接管待重跑；容量 1，运行会占用唯一浏览器 |
| WebRTC 媒体桥验收 | **2 组全通过**：真实 VP8/SRTP 解码、只读拒绝输入、DataChannel 点击/中文/空格、接管与交回、父进程强杀后保留同一 Steel session | 2026-10-18T10:06Z | `runtime/webrtc-results.json` | `npm run setup:webrtc` 后 `npm run test:webrtc` | Python 桥路径（CDP JPEG → VP8/SRTP）；仅视频、无音频；无 TURN/公网穿透/硬件编码；与 Steel 原生 RTC 播放器是两条链路，结果不能互相替代 |
| 语法检查 | **28 个模块**通过 | 2026-10-19T01:05Z | 无落盘产物（命令输出） | `npm run check` | 仅 `node --check`；无 lint、类型检查、格式检查 |

【事实】28 项与 70 次均可复跑：按上表命令在本机 Node v22.22.3 上 exit 0（28/28 pass，10 轮耗时约 46 秒）。

## WP1a 正式骨架验收（2026-10-19 本地日期）

| 证据项 | 数值 / 结果 | 时点 (UTC) | 证据 | 边界 |
|---|---|---|---|---|
| 正式骨架独立测试 | **13 项通过，0 fail / 0 skip**；包含初始化事务提交前中断、启动后 SIGKILL、SIGTERM、锁竞争、版本拒绝、端口占用释放、健康接口和依赖边界反例 | 2026-10-18T19:39Z | [最终命令输出](../../infra/pi-durable-validation/evidence/wp1a-final-2026-10-18T19-39-30Z.json) | 根目录 `npm run check && npm test`；真实 Durable + 临时目录，未安装模型或产品 tasks；不是原型迁移验收 |
| 锁定安装与类型/边界检查 | `npm ci --ignore-scripts`、`npm run check` exit 0 | 2026-10-18T19:38Z | [完整回归输出](../../infra/pi-durable-validation/evidence/wp1a-foundation-2026-10-18T19-38-14Z.json) | 本机 Node；CI 配置已加入 foundation job，但未在远程 GitHub runner 执行 |
| 原型规定回归 | **28 项通过，0 fail / 0 skip**，`POINT_CRASH_ROUNDS=1`；语法检查通过 | 2026-10-18T19:38Z | 同上完整回归输出 | 未改变原型实现；这是 1 轮快速回归，不替代上表的 10 轮证据 |

**后续稳定性迭代**：2026-10-18T19:41Z，根目录类型/边界检查与 **16 项测试全部通过**（0 fail / 0 skip）。新增只读 SDK schema 预检：未知数据库、旧版和新版 schema 在进入写模式前拒绝，测试比较拒绝前后数据库字节不变；新增未注册模块层和绝对导入的边界反例。证据：[预检与边界回归](../../infra/pi-durable-validation/evidence/wp1a-preflight-2026-10-18T19-41-41Z.json)。此前骨架数字为历史验收，不覆盖本次新增行为；原型实现未变。

**生命周期迭代**：2026-10-18T19:44Z，正式骨架 **19 项测试通过，0 fail / 0 skip**，类型/边界检查通过；新增启动时 runtime 关闭、运行中异常终止、重复关闭和清理失败的结果传播。原型语法检查与 **28 项快速回归** 同时通过（1 轮强杀）。证据：[生命周期与原型回归](../../infra/pi-durable-validation/evidence/wp1a-lifecycle-2026-10-18T19-44-11Z.json)。逐项范围审计见 [foundation-acceptance](foundation-acceptance.md)。

**构建一致性迭代**：2026-10-18T19:45Z，先复现构建成功仍保留已删除模块的旧 JS，修复后验证旧输出被移除；故意加入类型错误时构建按预期 exit 1 且不生成入口，移除夹具后 `check` 与 **19 项测试** 全部通过。证据：[干净构建与失败注入](../../infra/pi-durable-validation/evidence/wp1a-clean-build-2026-10-18T19-45-56Z.json)。该证据中的失败命令是预期断言，不是遗留失败。

**本地提交前复核**：2026-10-18T19:48Z，正式骨架类型/边界检查、19 项测试、原型语法检查与 28 项快速回归、OpenSpec strict 和 diff check 全部通过。证据：[提交前检查](../../infra/pi-durable-validation/evidence/wp1a-precommit-2026-10-18T19-48-10Z.json)。

**干净检出验证**：2026-10-19T00:38:59.051788+00:00，修复 runtime 源码被忽略的问题后，从 Git 暂存内容导出独立目录，`npm ci --ignore-scripts`、`npm run check` 与 **19 项测试** 全部通过。该副本不含本机 node_modules 或未暂存文件。证据：[独立检出结果](../../infra/pi-durable-validation/evidence/wp1a-clean-checkout-2026-10-19T00-38-59Z.json)。

**完成范围**：WP1a 架构与基础生命周期；**WP1b、WP1 整体与 G1 未完成**。未迁移旧库、未启用聊天/模型/工具/计划/投递；未构建 Web；未验证 Docker、公网鉴权、浏览器原生 RTC、真实模型、长期运行和跨版本迁移。NanoMuse 为固定源码分析，未运行其测试。

本次所有数据库验证使用新临时目录，不打开个人原型数据；覆盖 latest 之前已把原型 latest JSON 备份到 `/tmp/point-pre-wp1a-tests-2026-10-18T19-38-14Z/`。正式骨架与原型证据分别记录，不相互替代。

## WP1b.1 对话命令重建（2026-10-19）

2026-10-19T00:46:57Z，根目录 `npm run check && npm test` 通过，**26 项测试全部通过，0 fail / 0 skip**。其中本片独立对话命令测试 **7 项**：参数规则、并发去重及异参冲突、不同键隔离、事务回滚、未来收据版本拒绝、提交前和提交后响应前 SIGKILL。正式实现没有原型依赖或生产故障钩子。

原型 `npm run check` 与 `POINT_CRASH_ROUNDS=1 npm test` 同时通过（**28 项，0 fail / 0 skip**）；原型源码与测试未修改。OpenSpec strict、diff check 通过。证据：[WP1b.1 完整验收输出](../../infra/pi-durable-validation/evidence/wp1b-commands-2026-10-19T00-46-57Z.json)。原型 latest JSON 运行前已备份，路径在证据中；所有数据库用临时目录，未迁移个人数据。

完成：内部应用端口的创建/读取、规范化输入、持久幂等收据、单 commit 原子创建与重启恢复。路线已按用户要求改为工程化重建，详见 [核心重建计划](agent-core-rebuild.md)。**仅 WP1b.1 完成，WP1b 和 G1 未完成**。未验证/未实现：消息与模型执行、上下文/USER.md、Job/Attempt、定时与投递、公开命令 API、浏览器、Docker、长期负载和跨产品版本迁移。正式 HTTP 仍只报告 foundation，测试通过不代表完整 personal agent 可用。

## WP1b.2a 对话执行重建（2026-10-19）

2026-10-19T01:00:22Z，根目录 `npm run check && npm test` 通过，**37 项测试全部通过，0 fail / 0 skip**。其中本片新增对话体验测试 **11 项**：发送后离开与重试去重、忙时补充排队、停止旧任务后继续、多会话隔离、供应商失败呈现未回答、模型处理中 SIGKILL 不重发、停止途中 SIGKILL 后新问题可继续、模型派发前取消、缺少保护标记时拒绝调用、历史分页与夹具耗时、空消息/未知会话/未配置模型。

实现复用原生 Durable loop、inbox 与 Submission，未新增消息队列或第二执行引擎；模型调用的 intent-before-effect 与 `unknown` 不重放由 `point.model-call` 文档和 dispatch 保护层承担。原型 `npm run check` 与 `POINT_CRASH_ROUNDS=1 npm test`（**28 项，0 fail / 0 skip**）同时通过，原型源码与测试未修改。证据：[WP1b.2a 完整验收输出](../../infra/pi-durable-validation/evidence/wp1b-experience-2026-10-19T01-00-22Z.json)。

完成：内部对话执行端口的发送、排队、停止、状态、等待与历史查询。**仅 WP1b.1/2a 完成，WP1b 与 G1 未完成**。未实现/未验证：上下文 sections、USER.md、压缩、Job/Attempt、工具与产物、计划/判断/投递/通知、公开 HTTP/AG-UI、浏览器、Docker、真实模型语义、供应商限流退避、长期负载和跨产品版本迁移。

## 已被取代、不要引用的旧口径

- `runtime/acceptance-summary.json` 写 `testsPassed 24/24`，是 2026-10-18T03:08Z 的旧口径（当时还没有后 4 项）。**不要引用。**
- `docs/research/` 多份报告分别写 13 / 26 / 28 项，是各自写作时点值。
- "语法检查模块数"在文档中出现过 16 / 17 / 21 / 27 / 28 五个值，均为时点值（28 = 新增 `scripts/backup.mjs` 后）。

## latest-* 的覆盖陷阱

`runtime/latest-results.json` 与 `runtime/latest-conversation-results.json` 只保存**最后一次运行**，任何一次快速跑（含 `POINT_CRASH_ROUNDS=1`）都会把它们降级覆盖。

- 引用"70 次强杀"时，指向具体 `runtime/tests-*/` 目录或 `infra/pi-durable-validation/evidence/` 归档，**不要指向 latest**。
- 复跑前先把 latest 复制成带时点的文件名，或直接使用归档副本。

## 未验证清单

以下项**没有任何产品级证据**，不得被"已验证"表述覆盖：

- Steel 原生 RTC 播放器接入 Point 接管互斥（凭证签发、逐次输入检查、旧连接失效、绕过受控入口的防护）。
- 数天/数周长跑（成本、状态膨胀与写放大、SSE 压力、浏览器连接泄漏）。
- 模型供应商故障、限流与退避重试。
- 公网 ICE / TURN / TLS 与信令、媒体地址配置。
- iframe 内元素、关闭的 Shadow DOM、多标签并发隔离。
- 跨平台（Windows）媒体桥路径。
- 判断层策略与评测（L2）、周期计划（cron/重复规则）。

## 证据归档

【事实】验收证据（`*-results*.json` 等）已复制到 `infra/pi-durable-validation/evidence/`；原始 `runtime/` 仍被 `.gitignore` 忽略，归档目录是唯一入库路径。归档说明见 [evidence/README.md](../../infra/pi-durable-validation/evidence/README.md)。

## 维护规则

1. 更新数字只改本表，并同时更新"时点"。
2. 新增证据必须写清边界；"通过"不等于产品可用。
3. 其他文档引用数字前，先核对本表；旧文档不追改，但不得与之冲突。
