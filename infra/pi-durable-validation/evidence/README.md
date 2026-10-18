# 验收证据归档

本目录保存 Point 原型的**可入库验收证据**。`runtime/`（SQLite 状态、测试运行目录、截图、venv）被 `.gitignore` 排除，因此"已验证"的结论不能只指向 `runtime/`：这里的 JSON 是证据本体，`manifest.json` 记录字节数与 SHA-256。

**口径**：数字与时点的唯一来源是 [`docs/design/verification-status.md`](../../../docs/design/verification-status.md)。本目录只放证据，不放结论。

## 文件

| 文件 | 内容 | 时点 (UTC) | 复现命令 | 边界 |
|---|---|---|---|---|
| `offline-execution-2026-10-18T16-55Z.json` | 离线执行套件 **13/13**：CLI 真实工具与去重、SIGKILL 后偏好保留、后台独立执行、修订复用子会话、停止/取消隔离、停机期间错过的定时补跑一次、改期作废旧定时、**4 个故障窗口 × 10 轮**（tool-after-effect / after-model / after-artifact / before-report）、幂等接收端（2 请求 1 效果）、unsafe 投递转 unknown、SSE 重连与双写者拒绝、工具失败不能被模型自信回答掩盖、不可达接收端不报成功 | 2026-10-18T16:55Z（本地 10-19 00:55） | `POINT_CRASH_ROUNDS=10 npm test` | 确定性脚本模型 `faux/faux-1`；不证明真实站点副作用恰好一次 |
| `offline-conversations-2026-10-18T16-55Z.json` | 离线会话套件 **11/11**：新鲜/分叉主题跨重启隔离、显式共享记忆与来源/遗忘、主题工作继承上下文并把答案送回指定会话、`/share` 结论同步、归档后路由到 main、模型工具建会话不复制未完成工具调用、改期撤回排队消息、取消撤回通知并保留产物、**通知提交后/发布前 2 个窗口 × 10 轮**、原生压缩、CLI 异步输入 | 同上 | 同上 | 同上 |
| `../runtime/tests-2026-10-18T10-13-42-932Z/` 与 `...10-13-26-310Z/`（已归档，见下） | 同一套 10 轮强杀的**原始运行目录**（README 历史引用的那次） | 2026-10-18T10:13Z | — | 与 16:55Z 复验互证 |
| `real-model-2026-10-18T04-54Z.json` | 真实模型验收 **passed**：deepseek/deepseek-flash，25.4s；主会话 `write/read/remember`、后台 `write/read`；`sharedMemory`、`inheritedTaskContext`、`mainUnderstandsResult`、`shareToMain`、`modelFollowup`、`survivesRestart` 全为 true | 2026-10-18T04:54Z | `npm run test:real`（需凭据） | 单次小样本；不证明复杂任务完成率 |
| `steel-2026-10-18T09-37Z.json` | 真实 Steel 浏览器 **5/5**：真实表单/过期引用拒绝/单实例隔离/接管/同 session 重启/登录恢复；创建后强杀复用预留 session 不重复创建；提交后强杀必须 observe+reconcile 不再提交；空闲与取消清理只释放自己的浏览器；真实 DeepSeek 走完整工具循环 | 2026-10-18T09:37Z | `npm run test:steel`（需本地 Steel + 凭据） | 容量 1；**该次只记录了 API 地址 `http://127.0.0.1:3000/v1`，未记录镜像 digest**，因此不能直接断言对应哪个发布镜像；发布镜像上的完整交互待重跑 |
| `webrtc-2026-10-18T10-06Z.json` | Python 媒体桥 **2/2**：真实 VP8/SRTP 解码、只读拒绝输入、DataChannel 点击/中文/空格、接管/交回、peer 清理；父进程 SIGKILL 后媒体 worker 退出而 Durable 保留同一 Steel session 与页面 | 2026-10-18T10:06Z | `npm run test:webrtc`（需 `setup:webrtc`） | 验证/回归路径；正式方向是 Steel 原生 RTC，未接入控制权 |
| `webrtc-ui-2026-10-18T07-09Z.json` | 真实 Chromium 界面复核：2 个观看连接共用 1 个采集源、VP8 解码 1280×713、媒体进程强杀后重连恢复、UI 保存成功 | 2026-10-18T07:09Z | 手工界面复核 | 非自动套件，补充证据 |
| `acceptance-summary-2026-10-17-obsolete.json` | **已过期，仅保留历史**：当时口径 24/24、70 次关键强杀、真实模型 passed | 2026-10-17T19:08Z | — | 24 项是加入 4 项回归测试之前的数字；现行口径为 **28**，见 verification-status |

## 归一化与置信边界

- 副本仅把字符串中的绝对家目录前缀（形如 `/Users/<user>`）归一化为 `<home>`；ID、状态、计数、`cases` 数组逐字保留。`manifest.json` 记录每个文件的 SHA-256。
- 证据目录里的 `runDirectory` 指向 `runtime/tests-*`。这些运行目录不属于源码仓库（见 `.gitignore`），治理归档位置见 `~/.point-archive/2026-10-19/`（本地目录，不入库、不公开）。
- **不可用本目录替代产品级验收**：长跑、供应商故障、公网 ICE/TURN/TLS、原生 RTC 控制权、判断层策略均无证据。

## 维护规则

1. 任何新验收若改变结论，**新增**带时点的文件，不覆盖旧文件。
2. 不要把 `runtime/latest-*.json` 直接复制进来当证据：它只保存最后一次运行，任何快速跑都会覆盖（见 verification-status）。
3. 更新后重新生成 `manifest.json`，并在 `docs/design/verification-status.md` 同步数字与时点。
