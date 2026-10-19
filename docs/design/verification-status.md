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

## WP2 资源边界基建（2026-10-19）

2026-10-19T01:31:19Z，根目录 `npm run check` 与 `npm test` 通过：**84 项测试全部通过，0 fail / 0 skip**。构成：服务端既有 **33 项**（chats 7 + conversation-experience 11 + lifecycle 15）+ 本片新增资源边界 **41 项**（resource 18 + resource-operations 23）+ `scripts/boundaries.test.mjs` **10 项**。单独运行 `node --test apps/server/dist/test/resource*.test.js` 为 **41/41**；`node --test scripts/*.test.mjs` 为 **10/10**。

实现：`domain/resource.ts` 纯规则（lease/controlEpoch、acquire/renew/release/takeover/expire、副作用 `intent→attempting→done|failed|unknown` + `cancel`）；`application/resource.ts` 严格输入、幂等收据、`ResourceStore` 原子 commit、`ResourceEffectPort`，以及把“已读前置条件”和写入绑定在同一次 resource CAS guard；`adapters/resource/memory.ts` 仅测试/样板。独立 reviewer 按评审清单审计，发现并修复一个 check-then-write 缺 CAS guard 的 blocker（race A–E 回归测试）；残余的 attempt commit↔effect.invoke 窗口写入契约限制，真实 adapter 必须在执行前自检 epoch。

原型 `npm run check` 与 `POINT_CRASH_ROUNDS=1 npm test`（**28 项，0 fail / 0 skip**）同时通过，原型源码与测试未修改；OpenSpec `agent-resource-boundary` strict 通过。证据：[WP2 完整验收输出](../../infra/pi-durable-validation/evidence/wp2-resource-2026-10-19T01-31-19Z.json)。

审计修复后最终复核（2026-10-19T01:35:09Z，src 已冻结，仅 scripts/test 注释与用例更新）：`npm run check` 通过，`npm test` **84/84 通过**，targeted **41/41**；独立 reviewer 复核通过、无 blocker。证据：[WP2 最终复核输出](../../infra/pi-durable-validation/evidence/wp2-resource-final-2026-10-19T01-35-09Z.json)。

完成边界：资源契约、内存桩、边界不变量与独立测试。**不是完整 WP2，也不是 G1 通过**。未实现/未验证：真实浏览器/文件/通知/网络 adapter；Durable 持久化、迁移与崩溃恢复；组合根接线与 HTTP 错误码映射；多进程/异步存储并发压测、真实 SIGKILL、长时间运行与费用。资源状态目前只在内存 store 中，不能用于真实数据。

## WP2 Durable resource persistence（2026-10-19）

官方窗口结果（具体时点与命令见 evidence）：根目录 `npm run check`、`npm run build` 与 `npm test` 通过：**176 项测试全部通过，0 fail / 0 skip**；targeted `resource-durable.test.js` **14/14**；服务端 166（既有 152 + Durable persistence 14）+ scripts 10。

实现：`point.resource`、`point.resource-operation`、request index、command receipt 四个 Durable session family；nullable/present envelope、注入安全 request key、严格 JSON 转换与深拷贝；`durableResourceStore` 在单次 Harness.commit 内执行 CAS/receipt/index 全量校验，失败无 phantom doc，guard 写不递增 revision；`openRuntime.resources` 默认使用 Durable store；close/reopen 保留 lease/operation/unknown，unknown 不自动重放。

证据：[WP2 Durable resource 最终验收](../../infra/pi-durable-validation/evidence/wp2-durable-resource-final.json)。

**真实 adapter 尚未放行**：code audit 识别出 operation payload/hash、lease owner/expiry fence、attempt token、evidence-bound reconcile、symlink/TOCTOU、HTTP 分类/凭据、result bounds、abort/deadline 8 项 P0 契约缺口；这些已写入 [真实 adapter 契约](resource-adapters.md)，契约与回归测试完成前不得把真实文件/HTTP/CDP 接入生产。

## WP1b.2b 上下文/Profile/受保护压缩（2026-10-19）

2026-10-19T01:54:21Z，根目录 `npm run check`、`npm run build` 与 `npm test` 通过：**102 项测试全部通过，0 fail / 0 skip**。构成：服务端既有 **74 项**（chats 7 + conversation-experience 11 + lifecycle 15 + resource 18 + resource-operations 23）+ 本片新增 **18 项**（profile 6 + context-budget 4 + compaction 8）+ `scripts/boundaries.test.mjs` **10 项**。targeted `node --test apps/server/dist/test/{profile,context-budget,compaction}.test.js` 为 **18/18**。

实现：`point.profile` 唯一权威 + 显式 remember/forget/list/USER.md 纯导出；`point.context` 的 identity/chat/profile sections（8000 总预算、500 单值截断、空 profile 省略）；`conversation.compact` 幂等命令（收据+command task，内层 `pi.compaction` 为真实执行身份）；`model-guard` 用 `ProviderDoc.sessionId` 唯一匹配 compaction permit，无 permit/歧义/非 new 状态 fail-closed，`unknown` 不重放。独立 reviewer 审计发现并修复：B1（non-new ModelCalls 不重放的回归测试缺失）、P1（compact 收据 key 缺 chatId）；P2（同 chat 并发压缩 fail-closed）文档化为已知限制。

原型 `POINT_CRASH_ROUNDS=1 npm test`（**28 项，0 fail / 0 skip**）通过；OpenSpec `agent-context-budget` strict 通过。证据：[WP1b.2b 完整验收输出](../../infra/pi-durable-validation/evidence/wp1b-2b-context-2026-10-19T01-54-21Z.json)。

完成边界：显式 Profile、上下文 sections/预算、手动压缩与压缩模型保护。**WP1b.2b 完成不代表 WP1b/G1 完成**。未验证/未实现：自动阈值压缩长跑与真实模型压缩质量、USER.md 真实导入/文件监听、HTTP/CLI；进程在 compaction summarize 前后被杀时压缩任务 fail-closed，但 `point.model-call` 可能停留 `attempting`（本轮无压缩恢复核销路径，压缩三态证据不完整）；internal-execution chat section fallback、provider error/取消派发路径未进仓库测试；无进程级 SIGKILL fixture。上述项不能由手动压缩 happy path 外推。

## WP1b.3 Job/Attempt、工具与产物（2026-10-19）

2026-10-19T02:13:33Z，根目录 `npm run check`、`npm run build` 与 `npm test` 通过：**127 项测试全部通过，0 fail / 0 skip**。构成：服务端既有 **92 项**（chats 7 + conversation-experience 11 + lifecycle 15 + resource 18 + resource-operations 23 + profile 6 + context-budget 4 + compaction 8）+ 本片新增 **25 项**（job 16 + artifact 9）+ `scripts/boundaries.test.mjs` **10 项**。targeted `node --test apps/server/dist/test/{job,artifact}.test.js` 为 **25/25**。

实现：Job 与 Attempt 分离（`point.job`/`point.attempt`/`point.job-execution`/`point.command.job`）；start/amend/cancel 单 commit + commit 后 abort；attempt task 恢复沿用同 task/attempt，完成写入 revision fence（current attempt + revision + 非 cancelled），至少一个 sealed artifact 才能 ready；`save_artifact` 只在 execution conversation 可用，`point.artifact` writing→sealed、tmp+fsync+rename、sha256/bytes、受限路径（`<jobId>/<attemptId>/<sanitized artifactId>/<name>`），verify 可发现篡改/缺失。独立 reviewer 审计关闭：B1（artifact writing 崩溃窗口缺 fixture）、P1（收据键作用域）、P2（cancel 改写已完成 attempt）、P3（同名 artifact 路径覆盖）；P4 优雅关闭/重启行为与 P5/P6 已知限制写入契约。

原型 `POINT_CRASH_ROUNDS=1 npm test`（**28 项，0 fail / 0 skip**）通过；OpenSpec `agent-jobs-artifacts` strict 通过。证据：[WP1b.3 完整验收输出](../../infra/pi-durable-validation/evidence/wp1b-3-jobs-artifacts-2026-10-19T02-13-33Z.json)。

完成边界：Job/Attempt 身份、工具与产物。**WP1b.3 完成不代表 WP1b/G1 完成**。未验证/未实现：真实模型质量、真实外部工具/浏览器、计划/判断/投递/通知（WP1b.4）、HTTP、Docker、旧库迁移；artifact 文件与 Durable 文档非同一事务，`verify` 只能在读取时发现篡改/缺失，不能在 ready 后持续保证；artifact 写后 doc 前/结果 commit 前的其余崩溃窗口、结果 commit 前窗口未单独 fixture；cancel 只 abort attempt task、不 abort execution conversation，取消后 in-flight 模型循环可能继续消耗调用但不会 ready（P5）；`ArtifactState.unknown` 本片未产生（P6）；无长跑/性能/多层并发压力。上述项不能由 127 项绿推为完整。

## WP1b.4 计划/判断/投递/通知（2026-10-19）

2026-10-19T02:28:22Z，根目录 `npm run check`、`npm run build` 与 `npm test` 通过：**162 项测试全部通过，0 fail / 0 skip**。构成：服务端既有 **117 项**（chats 7 + conversation-experience 11 + lifecycle 15 + resource 18 + resource-operations 23 + profile 6 + context-budget 4 + compaction 8 + job 16 + artifact 9）+ 本片新增 **35 项**（schedule 15 + delivery 9 + notification 11）+ `scripts/boundaries.test.mjs` **10 项**。targeted `node --test apps/server/dist/test/{schedule,delivery,notification}.test.js` 为 **35/35**。

实现：`point.schedule`/`point.occurrence`/`point.decision`/`point.delivery`/`point.schedule-head`；`runtime.followups` 的 schedule/cancel/get/occurrences/decisions/deliveries；`point.job.followup` 绝对时刻等待、恢复重读、错过合并、最多 2 轮提醒、只对 ready Job、cancel/revision 竞态 skip；判断单 commit 写 Decision + occurrence + 2 条 Delivery intent + Report/Notify task；`point.job.report` 追加一条 `point.report` assistant entry（不调模型）且幂等；`point.job.notify` 先 attempting 再调用可注入 `NotificationPort`，failed/unknown 不自动重放；`memoryNotificationAdapter` 仅测试。独立 reviewer 审计关闭 B1（非 ready Job 被伪报完成）、P1（多 schedule 绕过上限）、T1–T3；P2–P6 已知限制写入契约。

原型 `POINT_CRASH_ROUNDS=1 npm test`（**28 项，0 fail / 0 skip**）通过；OpenSpec `agent-plan-delivery` strict 通过。证据：[WP1b.4 完整验收输出](../../infra/pi-durable-validation/evidence/wp1b-4-plan-delivery-2026-10-19T02-28-22Z.json)。

完成边界：单次计划、判断、会话投递与外部通知端口。未验证/未实现：真实通知渠道（target 固定 `test`）、周期/cron、时区/DST、真实模型报告（报告由文档拼接）、HTTP、Docker、旧库迁移；cancel schedule 不撤回判断 commit 已创建的 delivery；Report 不重新核对 artifact hash；同 (job,revision) 只能一个 schedule，重排需 amend/先 cancel；followup crash 仅覆盖 before-due 窗口；无长跑/性能/多进程压力。

## G1 骨架就绪验收（2026-10-19）

**G1 = WP1a + WP1b + WP2**。按本仓库闸门定义（[roadmap](roadmap.md#L83)）验收：**通过**（骨架就绪，不等于 G2+ 或完整产品）。

| 闸门要求 | 证据 | 结果 |
|---|---|---|
| WP1a 架构与基础骨架 | WP1a 验收段 | 通过 |
| WP1b 正式 Agent 核心逐片重建 | WP1b.1/2a/2b/3/4 各段 | 通过（边界见各段） |
| WP2 资源接口 + 内存桩跑通租约/过期/unknown | WP2 段 + resource 41 项 | 通过 |
| `domain` 与具体实现解耦 | `npm run check`（boundaries）+ `grep -rniE 'steel\|cdp\|puppeteer\|rtc' apps/server/src/domain apps/server/src/application` 为空 | 通过 |
| 无第二事实库 | `grep -rn 'messages\s*=\s*\[' apps/server/src` 为空；Durable docs/entries/tasks | 通过 |
| 独立测试与故障注入 | 162/162 根目录测试；SIGKILL fixtures（init/chat/conversation/job/artifact/followup） | 通过 |
| 独立评审 | WP2、WP1b.2b、WP1b.3、WP1b.4 各评审报告均通过、无未解决 blocker | 通过 |
| 原型回归 | `POINT_CRASH_ROUNDS=1 npm test` 28/28 | 通过 |
| OpenSpec strict | WP1b.2a/2b、WP2、WP1b.3、WP1b.4 changes valid | 通过 |

证据：[G1 完整验收输出](../../infra/pi-durable-validation/evidence/g1-foundation-2026-10-19T02-28-22Z.json)；分支 `wp/1b-plan-delivery`，G1 提交与 `gate-g1` tag 见仓库。

**G1 明确不包含**：真实模型语义质量、真实浏览器/外部工具/通知渠道、HTTP/AG-UI（G2）、状态 v2 迁移（G3）、Docker/长跑（G4/G5）、多层并发与长期收据治理。WP2 真实资源 adapter/持久化仍按后续 WP；WP1b 各片未验证项不得被 162 项绿覆盖。

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

## WP2 真实浏览器/文件/通知 Adapter 与 Durable 持久化最终闸门（2026-10-19）

最终官方窗口：根目录 `npm run check`、`npm test`、边界检查与 OpenSpec strict 均通过；原型 `npm run check && POINT_CRASH_ROUNDS=1 npm test` 通过。服务端干净构建后全量 **261/261 项通过，0 fail / 0 skip**；跨 adapter adversarial integration **18/18**；独立最终安全评审通过。追加证据：[WP2 real adapters final](../../infra/pi-durable-validation/evidence/wp2-real-adapters-final-2026-10-19T05-25-00Z.json)，最终评审：[final3](../team/reviews/wp2-real-adapters-final3.md)。

本片闭合：runtime-owned registry 防替换、payload/evidence/result 绑定、owner/lease/epoch/attempt token 与 Delivery fencing、HTTP 分类及 redacted structured audit、file-outbox `unknown/outbox-written` 语义、文件与 artifact symlink/TOCTOU 硬化、CDP screenshot artifact 引用与 evaluate 元数据化脱敏。`unknown` 永不自动重放；真实 adapter 由组合根显式构造并注入，`openRuntime` 不自动创建 file root、CDP endpoint 或 notification target。

未验证且不得外推：真实 Steel/生产 CDP 与 artifact sink 集成、RTC/viewer/浏览器侧多会话、旧 Durable 库迁移、数天/数周长跑与连接泄漏、凭据轮换/并发容量/Docker、真实 HTTP provider 查询核销与 exactly-once、外部 observer 的签名认证。v1 文档拒绝仍依赖 SDK 错误文案正则，作为后续 typed-error 改进项；本片不宣称真实 provider 已就绪。

## WP3 状态 v2/迁移 与 WP4 API v1（2026-10-19）

**范围**：WP3 状态格式闸门、v2 文档分片、单 commit 迁移（备份/幂等/SIGKILL）、`point.event` 时间线、请求账本清扫；WP4 `/v1` HTTP 契约（错误信封、幂等键、鉴权、访问日志、门控 inspect）。两者独立分支并行实现，回滚点分别是 `wp/3-state-v2`/`wp/4-api-v1` 分支头。

| 证据项 | 数值 / 结果 | 证据 |
|---|---|---|
| 根目录全量 | `npm run check`、`npm test` 通过：**302 项通过，0 fail / 0 skip**（服务端 292 + scripts 10） | 本段命令输出；HEAD 合并提交 |
| WP4 契约测试 | `api-v1` 13 + `api-v1-write-guards` 2 = **15/15**（含 5 并发同 key、11 写操作守卫矩阵） | `apps/server/test/api-v1*.test.ts` |
| WP3 迁移/闸门/清扫 | `state-gate` 8 + `state-migration` 8 + `state-events` 1 + `state-cleanup` 7 + `profile-concurrency` 2 = **26/26** | `apps/server/test/state-*.test.ts`、`profile-concurrency.test.ts` |
| 独立动态验证（WP4） | **18/18**，真实 `startServer` + 真实 SQLite + 原始 socket 驱动（413 非缓冲、重放逐字节、重启后重放、日志脱敏、`/inspect` 门控） | task-47 报告 |
| 独立动态验证（WP3） | **21/21**，自建 v1 夹具库（含 unknown/attempting operation 与 6 类收据），真实 `migrateRuntime`/`openRuntime` | task-51 报告 |
| 独立代码审计 | WP4 **通过（无 blocker）**；WP3 发现 1 blocker（profile 上限用陈旧计数）→ 已修复并复验 | [WP4 评审](../team/reviews/wp4-api-v1.md)、[WP3 评审](../team/reviews/wp3-state-v2.md) |
| 原型回归 | `npm run check` + `POINT_CRASH_ROUNDS=1 npm test`：**28/28** | 本段命令输出 |
| OpenSpec strict | `state-v2-migration`、`api-v1-contract` 均 valid | `openspec validate --strict` |

**关闭的 blocker**：WP3 profile `MAX_PROFILE_ENTRIES` 并发越界（63 条后两并发 remember 到 65）→ 计数改为同一 commit 内判定；迁移 `engine/instanceId` 不匹配误报 `already-migrated` → 改为 `MIGRATION_INCOMPATIBLE` 零写入；cleanup 保护判定移入删除 commit；`dryRun` 预览改为与真实可删集合相等。

**闸门状态**：**G2 未通过（需 WP4 + WP5）**，**G3 未通过（需 WP3 + WP6）**。本次只完成 WP3/WP4 两个工作包本身，不等于契约/状态闸门。

**WP3 未验证项（不得据此外推"生产级迁移已安全"）**：(1) 语义等值用的 v1 fixture 由 SDK token 直接合成，非真实 v1 产品命令全链路生成的库，真实旧库脏数据未覆盖；(2) 备份失败分支仅有代码审查，备份保留策略/旧备份清理未实现；(3) 清扫仅验证 `keepMs=0/keepCount=0` 场景，默认 30 天窗口、最近 keepCount 窗口、单次 1000 上限与大批量分页未压测；(4) 真实大库迁移耗时、在线备份磁盘峰值、事件规模未压测（WP9）；(5) 仅单进程：迁移要求停写窗口与目录单写者锁，不支持多进程/在线热迁移；(6) "只读模式"是产品层 commit/resume guard，SDK 无公开 read-only storage，SQLite/WAL 仍可能文件级写入，不是 OS 级只读；(7) SIGKILL 用确定性 beforeCommit/afterCommit hook，未覆盖指令级随机时机与断电/磁盘满；(8) profile 上限并发仅验证单进程 2 并发，未验证多写入者；(9) 事件是**部分可重建**派生物：`rebuildEvents()` 只重建当前快照，不恢复历史变迁，历史时间线不可精确重放；(10) cleanup 并发注入为确定性单次提交，未做随机交错压测。

**WP4 未验证项 / 已知边界**：`/health` 的 404/405 错误体改走统一信封（形状变化，已在 README 记录）；404/405 先于鉴权是刻意顺序；`/inspect` 只返回 `{version,instanceId,phase,capabilities}`，Durable 计数留 WP6；Node `clientError` 可能无信封；未测跨进程并发压测、HTTPS 终止/反向代理、限流与审计留存、真实模型/外部 adapter 组合的端到端（HTTP 层不调用模型，未绑定 provider 时 `send` 映射 503）。另：一次全量运行中出现过 1 项瞬时失败（并发的 WP3 worktree 全量运行），随后同树重跑 287/287 全绿且未复现，归为高负载下时序敏感，不作为通过依据也不隐藏。

证据：`infra/pi-durable-validation/evidence/wp3-wp4-gate-<ts>.json`（追加式，manifest 登记）。


## WP5 AG-UI 投影与 G2 契约闸门（2026-10-19）

**范围**：`POST /v1/agent` 将一次前台运行投影为 AG-UI 1.0 事件流（`RUN_STARTED`/`TEXT_MESSAGE_*`/`TOOL_CALL_*`/`STEP_*`/`RUN_FINISHED(outcome+usage)`/`RUN_ERROR`），严格 LIFO 实体关闭、容忍未知/拒绝坏值、截断不伪造完成、传输级失败仍走 REST 信封、预留 `point.ui.*` 声明式契约（不实现渲染）、参考 CLI 作为首个消费者。

| 证据项 | 数值 / 结果 | 证据 |
|---|---|---|
| 根目录全量 | `npm run check`、`npm test` 通过：**316 项通过，0 fail / 0 skip**（服务端 305 + scripts 11） | 本段命令输出 |
| AG-UI 契约测试 | `agui` **13/13**（首帧/末帧、严格 LIFO 顺序、嵌套 tool、多 step、截断、取消、容忍、坏值 fail-closed） | `apps/server/test/agui.test.ts` |
| 边界检查 | `scripts/*.test.mjs` **11/11**，新增 `cli.ts` 显式 lane（仅允许 `node:` 内置） | `scripts/boundaries.test.mjs` |
| 原型回归 | `npm run check`（28 modules）+ `POINT_CRASH_ROUNDS=1 npm test` **28/28** | 本段命令输出 |
| 独立动态验证 | 第一轮 **10/10**、LIFO 修复后 **15/15**（真实 `startServer` + 真实 SQLite + 自写 SSE 解析器 + faux provider） | task-54 / task-57 报告 |
| 独立代码审计 | 首轮 1 blocker（实体关闭按类型分组）→ 修复；复审 1 blocker（`point.ui` 未拒 `document.`）→ 修复；[最终](wp5-agui-projection-final.md) **通过（无 blocker）** | [评审](wp5-agui-projection.md)、[复审](wp5-agui-projection-reaudit.md)、[终审](wp5-agui-projection-final.md) |
| OpenSpec strict | `agent-agui-projection` valid 且 complete | `openspec validate --strict` |

**G2（契约就绪）= WP4 + WP5：判定通过。** REST 契约（WP4 15/15）与 AG-UI 契约（13/13）测试通过，参考 CLI（`apps/server/src/cli.ts`）消费新协议。**口径说明**：此前没有产品 CLI 可"切换"，原型 CLI 明确未替换；若"CLI 已切到新协议"要求替换某个既有产品 CLI，此项仍是后续动作。

> **本节已被下方「WP5 纠偏收口」修订**：当时所称的“参考 CLI 消费新协议”已按用户决定取消（Web-first），`RUN_FINISHED` 不再发送标准 `usage`。旧数字与结论作为历史记录保留。

**usage 口径**：`RUN_FINISHED.usage` 是会话 `UsageState` 账本差分（按 model/tool bucket 聚合），**派生值**，不是 provider 精确账单（无 cost、不拆单次调用，retry/compaction 归属可能与账单不同）。

**未验证项**：真实 provider 逐 token 流/网络断线重连/限流（仅 faux）；真实工具执行到 `TOOL_CALL_*` 端到端（前台 chat run 不注册 tool extension，工具顺序由 projection 与脚本化 port 覆盖）；usage 与 provider 账单对账；多客户端/follow-up run 隔离；SSE 反向代理缓冲/背压/半开/EPIPE（`response` 未装 `error` 监听）；重复 end 事件可能双发 END；`point.ui` 方括号 DOM 形式未覆盖且当前无发射路径；`Last-Event-ID`/快照/`ACTIVITY`/运行流（WP6）与 interrupt/resume（WP7）不在本片；高频并发与长跑未测。

证据：[WP5/G2 追加证据](../../infra/pi-durable-validation/evidence/wp5-agui-g2-2026-10-19T07-22-51Z.json)。

## WP5 官方 SDK 纠偏验收（2026-10-19T07:50:28.464825+00:00）

**勘误**：此前 WP5/G2 的自写 wire types、汇总 usage 对象和字符串 outcome 不足以证明官方 AG-UI 1.0 兼容。原证据保留，不覆盖。此次按用户确认方案替换为官方 SDK，并通过官方客户端的真实 Server/Durable 场景。G2 的原自动化依据由本次结果补充；本次没有新的独立评审，不把自动化通过外推为完整产品验收。G3/WP6 仍未完成。

最终同树验收：根目录 `npm run check`、`npm test` **328/328 通过，0 fail / 0 skip**；AG-UI 独立套件 **24/24**，最终 HTTP+AG-UI 联合 targeted **38/38**；原型 `npm run check` 与 `POINT_CRASH_ROUNDS=1 npm test` **28/28**；OpenSpec strict 与 diff check 通过。所有数据库为测试夹具，未迁移个人数据；prototype latest JSON 运行前已备份，路径见证据。

修复：官方 `@ag-ui/core/client/encoder@1.0.3` + 显式 schema peer `zod@3.25.76`；outcome 对象、标准 usage 暂省略；草稿跨 run 唯一与 Durable entry 历史对账；HttpAgent 消费、权威消息快照回调、截断/坏 JSON/坏字段非零退出；完成命令同键重试不再次执行；断开观察不停止执行；取消、重复 END 与持续活动超出两分钟的回归；观察缓冲有界，resnapshot/空闲超时明确要求同步；异步响应错误监听。

最终复验曾出现共享 HTTP 的 oversized-body `fetch failed`（旧实现提前关闭 socket），失败输出保留在证据。修复读取迭代器退出销毁与过早 close，新增连续声明长度上传及 chunked 溢出回归，不放宽 413 或“不得执行命令”的断言；修复后最终全量通过。

**边界与未验证项**：结束快照目前仅为既有可见文本历史，Point 消费者必须使用官方快照回调显式替换视图，默认 HttpAgent 合并不能自动清掉本地草稿。缓冲溢出/SDK resnapshot 显式中断观察，不提供 WP6 接续；活动请求重试不保证补齐已丢 token。未验证真实 provider/工具全链路、完整工具历史、代理/半开/慢消费压测、正式 Docker/长跑与本轮独立评审。没有引入第二引擎、第二事实库或持久 schema。

证据：[WP5 SDK 纠偏完整输出](../../infra/pi-durable-validation/evidence/wp5-sdk-correction-2026-10-19T07-50-28Z.json)（含最终源码哈希与前次失败输出）。

## WP5 纠偏收口：官方 AG-UI SDK + CLI 移除（2026-10-19）

**勘误并取代上文两段**：此前 WP5 的自写 wire types、字符串 `outcome` 与汇总 `usage` 不能作为官方 AG-UI 1.0 兼容证据；参考 CLI 已按用户决定删除（产品改为 **Web-first**）。旧证据与旧段落保留，不覆盖。

**当前契约（实现口径）**：边缘使用官方 `@ag-ui/core`+`@ag-ui/encoder@1.0.3` 逐帧 `EventSchema` 校验后编码，`zod@3.25.76` 显式 pin；`@ag-ui/client@1.0.3` 仅在 devDependencies，由契约测试作为官方消费者。`RUN_FINISHED.outcome` 为对象 `{type: success|cancelled}`，**标准 `usage` 不发送**（会话账本差分无法归属单次运行）；run 结束前发送**有界** `MESSAGES_SNAPSHOT`（10,000 条 / 8 MiB / 1,000 页，超限抛 `OBSERVATION_RESYNC_REQUIRED` 且不发不完整快照）；观察中断以 `OBSERVATION_TIMEOUT`/`OBSERVATION_RESYNC_REQUIRED` 表达，**只停观察、不代表执行失败、不取消不重放**；临时草稿 id 跨 run 唯一（`draft-<streamId>-N`），多消息 history entry 使用 `entryId:index`。

**同时修复的真实缺陷**：超大 body 的 413 路径提前销毁 socket（客户端看到连接重置而不是 413 信封）；重复 END 帧；观察 loop 的 timer/abort 监听泄漏；缺少响应 `error` 监听。

| 证据项 | 数值 / 结果 | 证据 |
|---|---|---|
| 根目录全量 | `npm run check`、`npm test` 通过：**325 项通过，0 fail / 0 skip** | 本段命令输出 |
| AG-UI 定向 | `agui` **22/22**（含官方 HttpAgent 契约测试、快照超限 `OBSERVATION_RESYNC_REQUIRED` 不残缺、观察中断不取消执行） | `apps/server/test/agui.test.ts` |
| 边界检查 | `scripts/*.test.mjs` **10/10**（CLI lane 已删除，其余规则未动） | `scripts/boundaries.test.mjs` |
| 原型回归 | `npm run check`（28 modules）+ `POINT_CRASH_ROUNDS=1 npm test` **28/28** | 本段命令输出 |
| 独立动态验证 | **8/8**：真实 server + 官方 `@ag-ui/client` `HttpAgent`（outcome 对象、无 usage、LIFO 取消、截断、id 唯一、快照对账、413 两种形态） | task-61 报告 |
| 独立代码审计 | **PASS（无 blocker）**：分层/边界只放行 api lane 的 `@ag-ui/*`、旧保证未回归、413 非测试放宽、依赖为协议库而非 Agent 运行时 | [WP5 纠偏审计](../team/reviews/wp5-agui-sdk-correction.md) |
| OpenSpec strict | `agent-agui-projection` valid（已清理 CLI/usage 陈旧表述） | `openspec validate --strict` |

**G2 判据更新（2026-10-19 用户决定）**：G2 由“REST/AG-UI 契约测试通过 + CLI 切到新协议”改为“REST 与 AG-UI 契约测试通过，并由官方 `@ag-ui/client` 在契约测试中消费”；**不再提供产品 CLI 或参考 CLI**，首个真实客户端是 WP13 的 Web 客户端。

**未验证项（不得外推）**：真实 provider 逐 token/网络断线重连/限流与背压（仅 faux）；真实 120s 空闲触发 `OBSERVATION_TIMEOUT`（映射与“不取消执行”已由既有重试测试与超限回归覆盖）；快照上限只验证 10,001 条一条路径，8 MiB/1,000 页边界未逐一触发；前台 chat run 仍无工具事件（工具历史属 WP6）；`/v1/agent` 同幂等键重放语义与流式访问日志脱敏未单独复测；Web 客户端（WP13）尚未存在。
