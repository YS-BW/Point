# Steel headful 分支镜像实测

日期：2026-10-18。分支：官方仓库 `aspectrr/headful-support`，固定提交 `08a2ddfefe3d6d25a443799e27c9bd9f3a459720`。平台：Apple Silicon / Docker Desktop，镜像为 linux/arm64。

后续发布已完成：源码 fork、双架构 GHCR 镜像、匿名拉取和本机运行结果见 [发布记录](steel-webrtc-publication-2026-10-18.md)。本文保留最初的本机构建对照过程；其中“当前容器”等描述指发布前的实验阶段。实验容器现已停止，运行服务已改用发布镜像的 `steel-webrtc`。

## 结果

分支原始应用源码可以编译、启动，API 和 Go RTC 页面均返回 HTTP 200，但不能直接正常播放。Chrome 显示 Connected 后一直黑屏，独立 aiortc 接收端连接 20 秒，ICE completed，解码帧数为 0。

对该分支做小范围修复后，分支自带播放器在 Chrome 中显示实时浏览器桌面，并验证了鼠标点击、直接按键、文字输入、单次保存和链接导航。未使用 Point 原型中的 Python JPEG → VP8 媒体桥。

| 项目 | 原始应用源码 | 验证补丁后 |
| --- | --- | --- |
| API 与 RTC 页面 | HTTP 200 | HTTP 200 |
| RTC 连接 | connected / ICE completed | connected / ICE completed |
| 20 秒实际解码 | 0 帧 | 588 帧，1920×1080，约 29.4 fps |
| 接收端 RTP 统计 | 无 inbound RTP 记录 | 2100 个包，统计丢包 0 |
| 首帧时间 | 无首帧 | 接收端启动后约 0.441 秒；不是端到端操作延迟测量 |
| Chrome 播放 | 黑屏 | 视频 currentTime 持续增长、paused=false |
| 输入与保存 | 未通过 | 输入 `hello RTC`；一次 Save，服务端 saveCount=1 |
| 链接导航 | 未通过 | 通过视频点击 Next page，到达 `/next`，画面显示 Navigation passed |

此次只证明本机基本链路，不是 WebSocket 与 WebRTC 的同画质性能对照，也未证明该实验分支可直接用于生产环境。一次运行快照约占用 1 个 CPU 核、435 MiB 内存，不代表长期或峰值负载。

## 实际修复

共修改分支内 4 个文件，最终补丁为 11 行新增、34 行删除：

1. Go RTP listener 接收轨道列表的指针，在锁保护下读取后续加入的轨道，修复空 slice 副本导致无法转发的问题。
2. Go 媒体引擎和视频轨道改为 H.264，匹配原 entrypoint 中 ffmpeg 的 libx264 输出，并声明相应 fmtp。
3. 分支播放器的视频元素补上脚本所需的 `hiddenVideo` ID，并显式调用 play；原版在 ontrack 中给 null 设置 srcObject，Chrome 控制台有对应异常。
4. 删除重复的左键 click 和 keydown 发送，在按下鼠标时聚焦 canvas 并禁止焦点滚动。实测此前一次点击会让 saveCount 增加 2，修复后为 1；直接键盘 h 也只产生一组 down/up。

链路为：Chromium → Xvfb 桌面 → ffmpeg/H.264/RTP → 分支 Go/Pion → WebRTC → 分支播放器。信令和人工输入仍为 WebSocket，后端通过 xdotool 发送系统输入。

没有改动 Pi Durable 原型的后端地址，原型仍连接原先 3000 端口的 Steel。本次没有测试真实站点登录，也没有验证或修复此前抖音场景。

## 镜像与容器

公开 GHCR 的 `steel-dev/steel-browser`、`steel-dev/steel-browser-api` 当时均只列出 latest，没有找到此分支的专用公开标签；仓库的发布工作流也只监听 main。因此这些是本机从分支源码构建的镜像，没有推送到外部仓库。

- 原始应用源码镜像：`point/steel-headful:08a2ddf-original`。
- 媒体修复阶段镜像：`point/steel-headful:08a2ddf-media-fix`。
- 当前验证镜像：`point/steel-headful:08a2ddf-validation`。
- 原版对照容器 `point-steel-headful-original` 已停止，镜像和日志保留。
- 当前容器 `point-steel-headful-fixed` 运行中，播放器已在 Chrome 打开。

本地播放器：<http://127.0.0.1:3001/sessions/debug>；API：<http://127.0.0.1:3100/v1>；CDP：9323。所有新增发布端口只绑定 127.0.0.1。ICE UDP 使用 10000–10010，EXTERNAL_IP=127.0.0.1，ICE_SERVERS_JSON=[]，未使用示例中的外部 TURN 配置。

容器限制 3 个 CPU、2 GiB 内存、512 MiB shm，测试录像目录为 256 MiB tmpfs。原有 Steel、Steel UI 及其他容器没有重启或替换。需要结束本次实验时可执行 `docker stop point-steel-headful-fixed`。

## 构建过程

第一次原始 Dockerfile 构建因继承的本机代理失联中断；清空本次构建的代理参数后，又在 Chromium 软件包下载阶段发生 HTTP 连接中断。最终仅在独立的 `Dockerfile.local` 中为 Chromium 安装步骤切换 HTTPS Debian 软件源并增加 APT 重试，原始应用源码没有修改后完成构建。没有修改 Docker 的全局代理设置。

后续 `Dockerfile.patched` 从原始镜像继承 Node、Chromium、ffmpeg 等内容，仅重新编译和替换分支的 Go 二进制；播放器 HTML 随 Go embed 一起编译。

在 `infra/pi-durable-validation/runtime/steel-rtc-audit/headful-source` 中可复现构建：

```sh
docker build --build-arg HTTP_PROXY= --build-arg HTTPS_PROXY= --build-arg ALL_PROXY= --build-arg http_proxy= --build-arg https_proxy= --build-arg all_proxy= -f ../Dockerfile.patched -t point/steel-headful:08a2ddf-validation .
```

## 保留的材料与边界

实验目录：`infra/pi-durable-validation/runtime/steel-rtc-audit/`。

- `validation-results.json`：整合结果、镜像 ID、来源提交。
- `probe-original.json`、`probe-media-fix.json`、`probe-validation.json`：真实 RTC 媒体接收结果。
- `ui-input-result.json`：服务端保存的内容和提交次数。
- `navigation-result.json`：导航后的 URL、标题和内容。
- `original-player-chrome.png`、`validation-player-chrome.png`、`validation-navigation-chrome.png`：Chrome 画面证据。
- `validation.patch`：与官方固定提交的应用源码差异。
- `Dockerfile.local`、`Dockerfile.patched`、`build-*.log`、`container-*.log`：构建和运行记录。
- `fixture-server.mjs`、`probe-official.py`：隔离测试页和接收端。

源码仍存在未纳入本次修复的粗糙部分：滚轮 4/5 按钮映射、特殊键/剪贴板、连接轨道清理及默认 H.264 level 与 1080p 采集的匹配等。公网 ICE/TURN、多会话、长时运行和资源恢复也未验证。上述结果不能推广为所有浏览器操作均已正常。
