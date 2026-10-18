# 浏览器基础设施：Steel

> 已定，2026-10-18：使用本项目已打包的 Steel 国内镜像，浏览器作为独立服务；通过 Pi Durable 扩展接入 Agent。

## 镜像与部署入口

默认公共仓库：`ccr.ccs.tencentyun.com/ys-bw-steel/steel-browser-webrtc`。默认部署引用固定为：

```text
ccr.ccs.tencentyun.com/ys-bw-steel/steel-browser-webrtc@sha256:ceb049f65e14cc7a8d364139646350db92c4256ea720f6bf359f4ba5c0f88b6b
```

此镜像含 Steel Node API、Chromium、Xvfb、ffmpeg、Go/Pion 与分支播放器，支持 AMD64 / ARM64。来自本项目修复的上游 headful 分支，不等同官方主线发布；源码见 [YS-BW/steel-browser](https://github.com/YS-BW/steel-browser)。不要求部署者拉源码或本地构建。

现有 [Compose](../../infra/pi-durable-validation/steel/docker-compose.yml) 已默认使用上述国内 digest。在 `infra/pi-durable-validation/` 运行：

```sh
docker compose -p point-steel-webrtc -f steel/docker-compose.yml pull
docker compose -p point-steel-webrtc -f steel/docker-compose.yml up -d
```

| 用途 | 当前本机地址/映射 |
|---|---|
| Steel REST API | `http://127.0.0.1:3000/v1` |
| 分支原生 RTC 调试播放器 | `http://127.0.0.1:3001/sessions/debug` |
| CDP | 宿主 9323 → 容器 9223 |
| RTC 媒体 | UDP 10000–10010 |

现配置端口仅绑定本机，限额 3 CPU、2 GiB 内存、512 MiB shm，录像为 256 MiB tmpfs。Point 容器与 Steel 容器互访应使用 Docker 网络内的服务地址，并分别配置对客户端可达的信令/媒体地址；不能把容器里的 `127.0.0.1` 当作另一个服务。

GHCR 的 `ghcr.io/ys-bw/steel-browser-webrtc` 是备用镜像源，已发布相同 digest。`:webrtc` 是便捷浮动标签，正式配置固定 digest。国内副本目前按发布批次同步，后续 GHCR 更新不代表国内标签已更新；升级需确认双架构 manifest、匿名拉取与实际媒体/交互验证。发布证据见[镜像报告](../research/steel-webrtc-publication-2026-10-18.md)。

## 三类通道

| 通道 | 协议 | 职责 |
|---|---|---|
| Agent 控制 | Steel REST + CDP/WebSocket | 建立/查询/释放 session，观察、截图与页面自动操作 |
| 用户画面 | Steel 原生 WebRTC 视频 | Chromium → Xvfb → ffmpeg H.264/RTP → Go/Pion → Client |
| 原生播放器信令与输入 | WebSocket | 协商、鼠标/键盘输入；当前 fork 不是 RTC DataChannel 输入 |

Point Client 与 Server 的 HTTP/SSE 承载聊天与产品状态，不承载浏览器视频。Steel 没有独立 Agent loop，页面理解、工具选择、任务执行和恢复由 Durable 中的 Agent 与 Point 适配器完成。

旧 `--webrtc` 原型路径使用 CDP JPEG → Python/aiortc → VP8/SRTP，输入为 DataChannel。它已验证接管规则，保留作验证/回归辅助；正式方向优先集成 Steel 原生媒体栈，不把 Python 桥设为长期必需组件。两条链路的测试结果不能互相替代。

## Point 浏览器扩展契约

沿用原型工具：`browser_open`、`browser_observe`、`browser_act`、`browser_reconcile`、`browser_screenshot`、`browser_handoff`、`browser_close`，全部挂在 Durable 原生工具系统中。

- 句柄记录所属 conversation / 产品任务、Steel session/context/page ID、profile 引用、控制权、租约和动作状态。
- 每个浏览器资源有明确所有者。聊天切换/fork 不复制浏览器句柄；执行任务与聊天本身分别管理资源。
- 初版本地适配器容量为 1；并发请求排队或返回 busy，不能依赖 Steel 自动解决产品资源冲突。多标签/多 session 在验证前不承诺并行隔离。
- 观察产生 snapshotId/ref；动作只接受最新快照，重启、导航或人工操作后重新观察。
- 适配器断开 CDP 只释放客户端连接，不关闭整个 Chromium；结束任务或到期清理才按所有者释放对应资源。
- 页面内容、cookie 与连接凭据不进入共享记忆。截图/下载作为带任务来源的产物保存。

## 人工接管与原生 RTC 集成缺口

产品契约为默认观看 → 显式接管 → 手动操作 → 交还 → Agent 重新观察。接管必须阻止对应 Agent 输入；默认观看、交还、租约过期后必须拒绝人工输入。

现原型通过自己的控制入口验证了上述互斥，**已发布 Steel 原生调试播放器尚未接入这些检查**。直接打开调试页只能说明播放器可操作，不代表 Point 控制契约已经成立。正式 Web 接入需完成：

1. 由 Point 签发绑定 browser ID、当前控制状态与连接有效期的访问凭证，观看与输入分开校验。
2. 原生输入 WebSocket 通过 Point 控制入口或 Steel 的服务端校验适配，逐次输入检查最新控制权；所有 Agent 动作也检查同一份状态。
3. 交还、取消、过期与资源重建时使旧输入连接失效，防止旧标签页继续操作。断线重连重新获取身份与控制状态。
4. 限制产品使用者绕过受控入口直连原生输入端点。本人登录验证和资源互斥是本产品需求，不扩张为通用角色/审批系统。
5. 视频、输入和 Agent 工具核对同一 session/page；输入坐标按实际帧尺寸转换，导航后不能继续展示旧画面。

当前 fork 还有滚轮、特殊键/剪贴板、连接清理与多会话方面的待验收项。公网部署另需验证 ICE、TURN、TLS 与地址配置；本机连接成功不证明公网可用。

**2026-10-19 实测阻断项（浏览器轨道暂缓期间的状态）**：原生链路的信令 WebSocket 无任何鉴权（伪造 Origin 仍握手成功），并发 12–13 个未授权 offer 即可触发 `panic: concurrent write to websocket connection`（`cmd/main.go:124`，ICE 候选回调与主循环并发写），使容器退出；`3000` 的任意路径 WS 可直通 CDP，`9323` 直接暴露 CDP，clipboard 动作存在命令拼接。**在此之前原生 RTC 不接入、不对外暴露**。处理顺序：WS 写串行化（P1）→ 收敛端口与重启策略（P2）→ 握手凭证/连接上限（P4）→ 再谈控制面集成。集成时机见[实施路线](roadmap.md)。

## 持久化与恢复

| 情况 | 处理 |
|---|---|
| 创建完成但 Point 尚未保存响应 | 先持久化预留 session ID，恢复核查同一 ID，避免重复创建 |
| Point 重启，Steel session 仍活着 | 按保存 ID 重连并观察；旧元素引用失效 |
| Steel 重启或 session 已过期 | 标记失效；可用命名配置与最后 URL 重新打开，重新判断任务进度 |
| 动作发出后未确认 | 动作日志进入 `unknown`；先观察/查询，有证据再核销，不能自动重复提交 |
| 人工登录/操作后 | 交还控制并读取新状态，再继续模型工作 |
| 任务结束/取消/租约到期 | 保存允许的检查点，释放自己拥有的资源；清理也需重试与核对 |

命名登录配置初版保存 cookies 和 localStorage，文件权限受限，document 仅保存名称/检查点引用。不保证恢复 IndexedDB、sessionStorage、页面内存或网站业务状态。遗忘配置删除保存文件，不等于撤销网站当前会话。

租约采用 Durable task 管理。原型默认空闲 2 分钟、人工接管 10 分钟、总计 30 分钟；这是当前可调参数，不是产品永久限制。Point 离线时租约不执行，重启需补清理；Steel 自身失效和 Point 租约状态要分别核对。

## 正式接入验收

- 在国内发布镜像重跑原型 REST/CDP、登录检查点、动作中断核对与资源清理测试。
- 原生 RTC 实际解码、点击/输入/滚动、导航后画面更新，以及坐标缩放、中文/特殊键验证。
- 默认观看拒绝输入，接管拒绝 Agent 动作，交还/过期拒绝旧连接输入；不能只测试 UI 按钮。
- Point/Steel 分别重启、页面关闭、多个观看连接与任务取消后，控制权、租约和资源均可核对。
- 长时间运行观察编码 CPU、内存、带宽与连接泄漏；不预先承诺 WebRTC 在所有页面都更省带宽。
