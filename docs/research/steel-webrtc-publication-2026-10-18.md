# Steel WebRTC fork 与镜像发布

日期：2026-10-18。

已完成上游 fork、修复源码推送、AMD64 / ARM64 镜像发布、腾讯云国内副本、匿名拉取，以及本机从发布镜像启动后的真实媒体接收验证。日常运行无需克隆 Steel 源码或本地构建。

## 交付地址

- Fork：[YS-BW/steel-browser](https://github.com/YS-BW/steel-browser)，默认分支为 `webrtc-headful-fixes`。
- 上游来源：`steel-dev/steel-browser` 的 `aspectrr/headful-support`，固定提交 `08a2ddfefe3d6d25a443799e27c9bd9f3a459720`；该上游分支也保留在 fork 中。
- 修复提交：`096e19f`；镜像构建源码：`63975ed6796341b37cf8bf7a51bead97ceb62b4a`。
- 镜像：`ghcr.io/ys-bw/steel-browser-webrtc:webrtc`；同时发布 `latest` 与 `sha-63975ed6796341b37cf8bf7a51bead97ceb62b4a`。
- 多架构 digest：`sha256:ceb049f65e14cc7a8d364139646350db92c4256ea720f6bf359f4ba5c0f88b6b`。
- [中文运行说明](https://github.com/YS-BW/steel-browser/blob/webrtc-headful-fixes/WEBRTC.md)。
- [构建与测试记录](https://github.com/YS-BW/steel-browser/actions/runs/39122320593)：三个 job 全部成功。

镜像公开可拉取，已使用空的临时 `DOCKER_CONFIG`、无 Docker 登录凭据完成实际下载。镜像标签指向的 manifest 包含 `linux/amd64`、`linux/arm64`，Docker 会自动选择当前架构。

## 国内镜像副本

用户要求增加国内镜像副本，并指定优先使用免费方案。已选腾讯云 TCR 个人版：官方 [产品说明](https://cloud.tencent.com/document/product/1141/39278)说明限额免费，[个人版快速入门](https://cloud.tencent.com/document/product/1141/63910)说明公有仓库允许匿名拉取。

已在腾讯云广州个人版实例创建命名空间 `ys-bw-steel` 和公有仓库 `steel-browser-webrtc`。国内拉取地址：

```sh
docker pull ccr.ccs.tencentyun.com/ys-bw-steel/steel-browser-webrtc:webrtc
```

同时发布 `latest` 和 `sha-63975ed6796341b37cf8bf7a51bead97ceb62b4a`。国内与 GHCR 的多架构 digest 及两个子 manifest digest 完全一致。已通过无账号凭据的 Registry 请求核对平台和标签，并使用独立临时 Docker 配置、空认证信息、无 credential helper 完成实际 `docker pull`。本机已有相同内容缓存，此次 pull 不用于衡量冷下载速度。

使用 Google 官方 release 的 crane v0.22.1，校验官方 checksums 后运行 `crane copy --jobs 2`，直接复制固定源 digest 的全部架构，耗时约 436 秒。未重新构建。国内副本目前按发布批次手动同步；GitHub Actions 后续自动发布不会自动更新腾讯云标签。

免费实例的服务角色授权由用户确认，仓库密码由用户本人初始化。按用户明确要求，将密码设为 macOS 当前登录会话的用户级环境变量 `STEEL_TCR_PASSWORD`；Docker 登录凭据由 Docker Desktop credential helper 保存。密码未写入源码、文档或镜像。命名空间和公有仓库最终通过 ego-browser 创建并核验。

GitHub 上的说明与 Compose 默认地址已随文档提交 `e17c428` 更新，镜像构建源码 revision 仍为 `63975ed6796341b37cf8bf7a51bead97ceb62b4a`；文档变更未触发重复构建。

后续按用户要求删除 `mystifying_meitner`、`steel-ui`、`steel` 三个旧容器，将 `steel-webrtc` 的宿主 API 端口和 `DOMAIN` 改为 3000。Compose 配置与 GitHub 使用说明已在 `554b94b` 同步；镜像内容与 digest 保持上述版本。

## 启动与更新

在 `infra/pi-durable-validation/` 目录运行：

```sh
docker compose -p point-steel-webrtc -f steel/docker-compose.yml pull
docker compose -p point-steel-webrtc -f steel/docker-compose.yml up -d
```

配置只有 `image`，没有 `build`，默认从腾讯云仓库拉取上述验证过的固定 digest。可通过 `STEEL_IMAGE` 切换镜像仓库或显式选择浮动标签。

也可先单独下载镜像：

```sh
docker pull ghcr.io/ys-bw/steel-browser-webrtc:webrtc
```

- 操作页：[http://127.0.0.1:3001/sessions/debug](http://127.0.0.1:3001/sessions/debug)。
- API：[http://127.0.0.1:3000/v1](http://127.0.0.1:3000/v1)。
- CDP：9323；RTC UDP：10000–10010。新增端口均绑定本机，ICE 使用本机地址，无外部 TURN。
- 资源上限：3 CPU、2 GiB 内存、512 MiB shm，录像为 256 MiB tmpfs。
- 停止：`docker compose -p point-steel-webrtc -f steel/docker-compose.yml down`。

本机现运行使用腾讯云镜像引用的 `steel-webrtc`，镜像 revision 与发布提交一致，健康检查通过。之前的 `point-steel-headful-fixed` 实验容器已停止。三个指定旧容器已删除，运行中的容器为 `steel-webrtc` 与 `libretv`；Point Agent 的 3000 API 地址现由 WebRTC 镜像提供。旧 Steel 的浏览器会话不会迁移到新容器。

## 验证结果

所有帧数都来自 aiortc 实际解码 H.264 视频。每次测试持续 20 秒，连接状态为 connected、ICE completed，统计丢包均为 0。

| 环境 | 实际解码帧数 | 尺寸 | 接收端首帧时间 |
| --- | ---: | --- | ---: |
| GitHub 原生 AMD64 runner | 592 | 1920×1080 | 0.261 秒 |
| GitHub 原生 ARM64 runner | 596 | 1920×1080 | 0.147 秒 |
| 本机匿名拉取后的 ARM64 镜像 | 583 | 1920×1080 | 0.584 秒 |
| 本机改用腾讯云镜像引用后 | 595 | 1920×1080 | 0.206 秒 |
| API 改为 3000、删除旧容器后 | 571 | 1920×1080 | 0.960 秒 |

首帧时间从接收程序启动计算，包含连接协商，不代表端到端操作延迟。实际帧数也不是复杂页面的性能基准。

GitHub Actions 在两种架构各自构建完整 Dockerfile、启动容器并通过媒体测试后，才推送架构镜像；两者均成功后合并公共标签。构建不依赖本机实验镜像，发布使用 Actions 的 `GITHUB_TOKEN`。

此前相同修复源码在 Chrome 通过鼠标点击、直接按键、文字输入、单次保存和链接导航；细节见 [原始分支与修复对照](steel-headful-branch-image-validation-2026-10-18.md)。这次发布后重新验证了镜像的启动和真实媒体接收，没有重做全部交互场景。

## 镜像内容与范围

镜像包含 Steel Node API、Chromium、Xvfb、ffmpeg、Go/Pion RTC 服务与分支自带播放器、xdotool。视频链路为 Chromium → Xvfb → ffmpeg/H.264/RTP → Go/Pion → WebRTC；信令和人工输入仍走 WebSocket。

应用修复包括 RTP 轨道共享、H.264 编码匹配、播放器视频元素与播放启动、重复点击和按键发送、canvas 聚焦。Apache-2.0 许可证保留。该 fork 属于实验版本；滚轮、特殊键/剪贴板、连接资源清理、长期运行、多会话与公网场景仍需验证。原生播放器尚未接入 Point 人工接管和只读检查。

## 本地证据

目录：`infra/pi-durable-validation/runtime/steel-rtc-audit/`。

- `publication-results.json`：整合来源、digest、匿名拉取、CI 与本机媒体结果。
- `published-manifest.txt`：多架构 manifest。
- `github-publish-run.json`：GitHub workflow 成功结果。
- `ghcr-pull-result.json`、`ghcr-pull.log`：无登录凭据的镜像下载记录。
- `published-ci-evidence/{amd64,arm64}/media.json`：各架构真实解码结果；同目录有容器日志。
- `probe-published.json`、`probe-published.stderr`：本机运行发布镜像后的媒体接收结果。
- `tencent-publication-results.json`：国内发布、匿名拉取与本机运行的整合结果。
- `tencent-mirror-copy.log`、`tencent-mirror-copy-result.json`：跨仓库复制记录。
- `tencent-public-manifest.json`：无账号凭据读取的国内平台列表、manifest digest 和三个标签。
- `tencent-anonymous-pull-result.json`、`tencent-anonymous-pull.log`：独立 Docker 配置的拉取结果。
- `probe-tencent.json`、`probe-tencent.stderr`：从国内镜像引用启动后的真实媒体接收结果。
- `tencent-published-tags.png`：ego-browser 中的腾讯云版本管理页面。
- `port-3000-migration.json`、`probe-port-3000.json`：旧容器删除、端口切换与重建后的实际媒体接收结果。
