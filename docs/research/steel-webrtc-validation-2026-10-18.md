# Steel WebRTC 操作页验证

日期：2026-10-18。基于现有 Pi Durable 1.3.0 原型和本机 Docker Steel 0.5.3，新增本地 WebRTC 操作页。未改动、重启或替换 Steel 容器。运行依赖为 aiortc 1.15.0、aiohttp 3.14.5 及固定版本的 PyAV 等依赖，见 `infra/pi-durable-validation/webrtc/requirements.txt`。

## 传输与职责

```text
Agent ── CDP / WebSocket ────────── Steel Chromium
                                      │ CDP screencast / JPEG（本地）
                                      ▼
                             Python aiortc 媒体桥
                                      │ VP8 / SRTP 视频
                                      ▼
                            Point WebRTC 操作页
                                      │ DataChannel / SCTP / DTLS 输入
                                      ▼
                         Node 会话归属与控制权检查 → CDP Input
```

SDP 信令走本地 HTTP，媒体和用户输入实际经过 RTCPeerConnection。浏览器调用 getStats 能看到 `video/VP8` 的 inbound-rtp 与增长的 framesDecoded；输入经有序 DataChannel 到桥接进程，再通过父进程管道交给 Node 检查，成功后才发送 CDP Input。没有把 JPEG 帧直接塞进 DataChannel。

Steel 到媒体桥仍为 JPEG/CDP；这不是修改 Steel Chromium 的原生编码器，也不是端到端消除 JPEG 编码。每个目标页面共享一个采集源，最多 4 个接收端各自编码。当前设定最多 1280×800、15 fps，不含音频。复用现有 Durable 会话、浏览器归属、人工接管与租约，模型工具接口不变。

桥接进程只绑定 loopback 随机端口，HTTP 需临时随机令牌；连接具体已验证的 pageId。只读/交回状态时服务端拒绝输入；页面切换后旧连接不能向新 pageId 输入。操作内容和 SDP 不进入应用日志。父进程的 stdin EOF 触发媒体清理，媒体进程退出不释放 Steel session。

操作页为 `http://127.0.0.1:4788/browser/view`；CLI 在 `--webrtc` 模式返回此地址。原 `5173` Steel 控制台自身的播放器保持原状。浏览器工作完成、关闭操作页、服务关闭时会清理对应媒体连接。页面提供“接管”“交回 Agent”“重新连接”和中文/粘贴文字入口。

## 验证结果

`npm run test:webrtc` 使用独立服务、数据目录、本地表单和真正的 aiortc 接收端：

- 实际解码 SRTP 视频帧，确认有宽高和递增时间戳。
- 未接管时，DataChannel 输入收到服务端拒绝。
- 接管后，通过 DataChannel 点击 Note、输入 `WebRTC 数据通道`、空格键和 `OK`，再点击 Save；页面出现 `Saved: WebRTC 数据通道 OK`，外部保存次数为 1。
- 检查实际解码的视频像素：保存前标记为红色，异步保存完成后变为绿色。DOM 已成功而视频仍停留旧画面也会使测试失败。
- 交回 Agent 后，再次输入被拒绝。
- 接收端关闭后，媒体 peers/sources 都归零。
- 强杀父进程后媒体 worker 退出；重启 Durable 后仍为原 Steel session，已保存页面保留。

另用真实 Chromium 操作实际 UI：收到 `video/VP8`，解码 1280×713 画面；通过画面点击、发送中文、保存成功。两个观看页面同时连接时，桥接状态为 peers=2、sources=1。强杀独立媒体 worker 后，重新加载操作页成功启动新 worker、重新收到 VP8，Steel 页面保持。

证据：`runtime/webrtc-results.json`、`runtime/webrtc-ui-results.json`、`runtime/webrtc-ui.png`。离线套件增加了截图阻塞隔离和聚焦坐标稳定性回归，共 28 项；原 Steel 集成套件另外验证。

## 操作页阻塞与旧画面修复

真实页面排查发现两个独立问题。截图可能长时间等待 Chromium 合成器，原先又与接管、媒体连接共用串行队列，导致截图卡住时整个操作页也无法接管。现在截图使用独立 CDP 会话，激活页面和截图分别有 3 秒、5 秒上限；接管先提交控制权，截图和媒体读取不占用该操作队列。回归测试主动挂住截图，验证接管和媒体源仍在 1 秒内返回。

另一问题是页面已成功保存，视频却仍显示旧的“未保存”。采集端原先每两帧取一帧，会漏掉静态页面最后一次合成更新。现改为采集每次更新，输出视频轨道仍按 15 fps 节流。新增红转绿的解码像素断言，验证最终变化真正到达接收端；本次得到 1280×800 的 VP8 画面，最终标记 RGB 为 `[0,255,0]`。

输入端持续复用 CDP 会话；页面显示输入通道和送达状态，通道未连接时禁用文字发送。首次连接等待实时采集帧，不再调用可能阻塞的截图回退；连接错误会显示并重试。

当前仅验证本机连接，没有 STUN/TURN、跨公网部署、音频、硬件编码、复杂 IME/快捷键、长期资源稳定性及同画质性能对照。视频码率和延迟以实际网络、画面变化与编码负载为准。

实现参考 [aiortc API](https://aiortc.readthedocs.io/en/latest/api.html) 和 [官方 server 示例](https://github.com/aiortc/aiortc/blob/main/examples/server/server.py)，未调用云媒体服务。

## Chrome 对照排查与导航回归

在 Chrome 实测发现，自制操作页调用 `video.focus()` 时会滚动外层页面，点击坐标在聚焦之后计算，导致纵坐标偏移。修复为 `focus({preventScroll:true})`，并按可视窗口高度缩放视频。新增回归通过模拟原生焦点滚动，确认鼠标按下、释放及发送文字均不会改变外层滚动位置。

另外，跨页面导航后 CDP 采集可能停留在旧页面。现监听主框架 `Page.frameNavigated`，停止并重启采集。真实 Chrome 中已验证 example.com 的滚动和链接点击，以及 IANA Example Domains → Domain Name Services 的视频跟随更新。页面标题栏使用当前已连接页面缓存的 URL。

`test:webrtc` 增加导航后的蓝色像素断言，完成红（初始）→绿（保存）→蓝（下一页）的实际视频解码验证；父进程强杀恢复后仍在原 Steel session 的 `/next` 页面。本轮得到 1280×713 视频，最终像素为 `[0,0,255]`，保存次数仍为 1，媒体连接释放后 peers/sources 均为 0。证据在 `runtime/tests-2026-10-18T10-06-22-727Z/webrtc-results.json`。

抖音页面仍有独立的输入无响应现象：Chrome、自制操作页和原生 Steel 播放器对照都未能关闭登录弹窗；坐标命中关闭图标，CDP 输入有回执，但页面未发生预期变化。通用浏览和本地表单通过，不等于抖音场景已经修好。本轮保留 Chrome 操作页，等待手动操作对照结果，不将该站点列为通过。

## 官方播放器能力核验

用户反馈手动点击也无响应，并要求优先使用官方 Web。已在 Chrome 切换至当前 Steel 会话返回的官方 `debugUrl`（指定同一个 pageId），仍未关闭抖音登录弹窗。当前展示的是官方播放器，传输方式为本地版本提供的 WebSocket/CDP 截图流。

必须区分两套后端：官方 [Live Sessions 文档](https://docs.steel.dev/overview/sessions-api/embed-sessions/live-sessions) 已说明 headful 会话可由官方播放器直接提供 WebRTC、H.264、25 fps 和 OS 级画面采集，使用会话返回的 `debugUrl` 即可嵌入。该文档中的 API 示例连接 Steel Cloud。

本机 Docker API 版本 0.5.3 的 `live-session-streamer.ejs` 仍通过 WebSocket 接收截图及发送输入，未提供对应 RTC 媒体后端；同时核验官方开源仓库 main 的同名模板，仍含 `new WebSocket`，不含 `RTCPeerConnection`。因此不能把官方 headful/Cloud 播放能力当作当前本地镜像已有的功能，也不能靠替换前端 URL 开启 RTC。

后续扩展核验发现：官方仓库的 `aspectrr/headful-support` 分支实际包含 Go/Pion WebRTC、Xvfb/ffmpeg 采集、播放器及 xdotool 输入代码。因此此前将 main/本地镜像的情况推广为“整个开源仓库不支持 RTC”不准确。相关 PR #185 关闭未合并，该分支还有编解码不匹配、轨道列表传递和未完成帧处理等问题。详见 [官方仓库 RTC 源码核验](./steel-official-webrtc-audit-2026-10-18.md)。随后按用户要求构建并实际运行：原版 connected 但 0 帧，修复分支内媒体及播放器问题后，分支自带播放器在 Chrome 通过 1080p 实时画面、输入、单次保存和链接导航验证，详见 [分支镜像实测](./steel-headful-branch-image-validation-2026-10-18.md)。该实验容器与原型当前连接的 Steel 独立。此前直接自建播放器没有先充分核验官方方案，增加了不必要的验证范围。
