# Steel 官方仓库 WebRTC 源码核验

核验日期：2026-10-18。本文记录最初的源码、分支和 PR 状态核验。随后已完成独立镜像实测：原版 connected 但 0 帧，少量补丁后实现 1080p 实时播放、输入、单次保存和导航。详见 [分支镜像实测](./steel-headful-branch-image-validation-2026-10-18.md)。现有 Steel Docker 没有替换。

## 结论与更正

“Steel 开源仓库完全不支持 WebRTC”的表述不准确。官方 `steel-dev/steel-browser` 仓库的 `aspectrr/headful-support` 分支包含播放器、Go/Pion 服务、桌面采集、信令以及鼠标键盘输入代码。此前只检查 main 和本地镜像就推广到整个仓库，遗漏了这一分支。

但存在这些源码，不代表当前发布版本已经提供可直接启用的功能。核查的 main、本机 0.5.3 镜像和 v0.5.4-beta 播放器仍使用 WebSocket/JPEG；实验分支也有明确未完成之处。

| 核查对象 | 版本 / 提交 | 结果 |
| --- | --- | --- |
| 本机 Docker API | 0.5.3 | 已在前一轮核查，官方播放器使用 WebSocket/CDP 截图流 |
| 官方 main | `d8a4a7e9fb1d49db833b41acf04e894b9ebb2b37` | 播放器创建 WebSocket，将 JPEG 数据绘制到 canvas；未发现对应 RTC 远程浏览器媒体服务 |
| v0.5.4-beta | `3fe2410ad0861303cc06d4aabdb20d0a6a60d888` | 同名播放器仍为 WebSocket/JPEG |
| 官方 `aspectrr/headful-support` | `08a2ddfefe3d6d25a443799e27c9bd9f3a459720` | 有真正的 WebRTC 实现代码，但不是经本次运行验证的可用版本 |

main 的正向证据是 [WebSocket 创建及 JPEG 绘制](https://github.com/steel-dev/steel-browser/blob/d8a4a7e9fb1d49db833b41acf04e894b9ebb2b37/api/src/templates/live-session-streamer.ejs#L584)。仓库里 recorder 扩展对 RTCPeerConnection 的覆写不是远程浏览器 RTC 媒体服务，不应将字符串命中直接当成功能支持。

## 实验分支包含什么

以下链接均固定到本次审计的分支提交，避免后续变更影响结论。

- [Go/Pion PeerConnection](https://github.com/steel-dev/steel-browser/blob/08a2ddfefe3d6d25a443799e27c9bd9f3a459720/api/src/webrtc/internal/steelrtc/peer.go#L36)：注册 VP8、创建视频轨道、设置 ICE 和 UDP 端口范围。
- [Go HTTP/WebSocket 服务](https://github.com/steel-dev/steel-browser/blob/08a2ddfefe3d6d25a443799e27c9bd9f3a459720/api/src/webrtc/cmd/main.go#L52)：提供 `/v1/sessions/webrtc` 信令和输入入口，处理 offer、answer、ICE，另有 `/sessions/debug` 页面。
- [播放器](https://github.com/steel-dev/steel-browser/blob/08a2ddfefe3d6d25a443799e27c9bd9f3a459720/api/src/webrtc/cmd/web/live-session-streamer.html#L130)：创建浏览器 RTCPeerConnection、接收视频，并经 WebSocket 发送鼠标键盘事件。
- [输入处理](https://github.com/steel-dev/steel-browser/blob/08a2ddfefe3d6d25a443799e27c9bd9f3a459720/api/src/webrtc/internal/steelrtc/actions.go#L33)：通过 xdotool 向 X11 桌面发送输入，不是当前 demo 的 CDP Input 路线。
- [Dockerfile](https://github.com/steel-dev/steel-browser/blob/08a2ddfefe3d6d25a443799e27c9bd9f3a459720/api/Dockerfile#L56) 与 [entrypoint](https://github.com/steel-dev/steel-browser/blob/08a2ddfefe3d6d25a443799e27c9bd9f3a459720/api/entrypoint.sh#L229)：构建 Go 二进制，安装 Xvfb、ffmpeg、xdotool，启动桌面采集及 Go 服务。

其意图是：Chromium 有头运行于 Xvfb → ffmpeg 采集桌面并发 RTP → Go/Pion → 浏览器 WebRTC 视频；信令和人工输入经 WebSocket，输入由 xdotool 执行。不能据此说输入也已走 DataChannel。

还有一套 TypeScript `plugins/webrtc` 代码，但 [stream-capture.ts](https://github.com/steel-dev/steel-browser/blob/08a2ddfefe3d6d25a443799e27c9bd9f3a459720/api/src/plugins/webrtc/stream-capture.ts#L327) 明确保留 RTP 帧处理 TODO；其测试帧生成函数也未实现实际画面写入。因此不能把目录和接口的齐全视作整条链路已完成。

## 合并状态

相关 [PR #185：feat: adding webrtc support](https://github.com/steel-dev/steel-browser/pull/185) 于 2025-08-15 关闭，API 返回 `merged: false`。该 PR 的来源是 `aspectrr/steel-browser` fork 中的同名分支，PR head 为 `c473594be1d909d2f5dc84c1e72faa107082a0b4`；不应混同为本次官方仓库分支最新提交。官方同名分支的本次 head 提交日期是 2025-08-28。

关闭未合并不等于官方永久放弃；本次没有找到说明关闭原因的证据，也没有把 Cloud 当前实现与此实验分支视为同一实现。

## 源码可直接发现的阻碍

以下为静态代码判断，不是本次容器运行观测：

1. 编码器不一致：[entrypoint 第 231 行起](https://github.com/steel-dev/steel-browser/blob/08a2ddfefe3d6d25a443799e27c9bd9f3a459720/api/entrypoint.sh#L231) 使用 `libx264` 输出 H.264 RTP；Go 媒体引擎和轨道却只注册 VP8。该链路中没有看到对应转码，不能按现状认定能解码。
2. Go RTP 转发列表不能跟随后续 append：[main.go](https://github.com/steel-dev/steel-browser/blob/08a2ddfefe3d6d25a443799e27c9bd9f3a459720/api/src/webrtc/cmd/main.go#L52) 将初始空 slice 按值传给 listener，后续在处理连接时才 append；[listener](https://github.com/steel-dev/steel-browser/blob/08a2ddfefe3d6d25a443799e27c9bd9f3a459720/api/src/webrtc/internal/steelrtc/rtp.go#L14) 持有旧 slice 长度，不能得到后来加入的轨道。锁不能解决 slice 头不共享的问题。
3. TypeScript 采集实现保留实际视频帧处理 TODO，不能充当已经完成的替代后端。

本地验证还需要独立构建其 Dockerfile，使用 `CHROME_HEADLESS=false`、Xvfb/ffmpeg/xdotool，并配置 Go 服务端口、ICE 可达 IP 和 UDP 映射。分支 compose 映射 3001/TCP、10000–10010/UDP，ffmpeg 与 Go 之间使用 5004/UDP。示例中的外部地址及 ICE 配置不能直接当作本机配置。

因此合理的下一步是隔离验证这条官方仓库分支，并先解决明确的媒体链路问题。不能直接承诺升级镜像或切换官方页面 URL 就能开启 RTC，也不能再断言必须从零自建整个媒体桥。

## 核验材料

本地只读研究副本：`infra/pi-durable-validation/runtime/steel-rtc-audit/repository`。审计覆盖官方全部分支的名称列表（131 个）、main、v0.5.4-beta、5 条 RTC/headful 相关命名分支的文件树，以及选出的 headful-support 关键源码；并未逐行审计所有分支。

同目录上层保存 `branches.json`、`pull-185.json`、`branch-compare.json` 等 GitHub API 原始证据。没有基于本次审计修改或重启现有容器。
