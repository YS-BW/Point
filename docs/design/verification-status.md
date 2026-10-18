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
