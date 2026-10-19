# Point Server foundation

WP1a：独立可运行的基础骨架，不是完整 Agent 产品。模型、聊天、工具、定时任务与浏览器尚未迁入；健康接口只报告 foundation。

在仓库根目录，Node >=22.19：

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm start
```

构建会先清理 `dist/`；类型错误不会生成可运行 JS，避免旧模块或失败构建被继续使用。

默认 `127.0.0.1:4310`；`GET /health/live` 与 `/health/ready`。可配置 `POINT_HOST`（只允许 loopback）、`POINT_PORT`、`POINT_DATA_DIR`（默认 `runtime/server`）。远程入口与令牌留给 WP4；此处不读取凭据。

数据目录：`state.sqlite` 是 Durable 唯一事实库；`owner.sqlite` 仅持有进程锁。不要删除活跃锁文件，也不要让不同进程使用不同路径替换同一个目录。仅支持本地支持 SQLite 锁的文件系统，不支持网络共享卷。

首次启动在同一事务写 root 与 `point.server.meta`。重启复用 identity；无 metadata 的已使用数据和不兼容版本会拒绝启动。请使用全新目录，**不要指向原型数据**。本次不做数据迁移；升级/迁移先备份，版本与恢复流程见设计。写模式打开前只读检查 Durable schema；未知库或需升级的 schema 会被拒绝，不触发自动迁移。这个检查与锁定的 Durable 版本绑定，升级必须独立实施。

SIGINT/SIGTERM 关闭 HTTP、Durable 与锁。运行时意外关闭也会关闭 HTTP 并释放锁；启动中关闭不能报告 ready，关闭失败通过 Server 的 closed 结果报告，CLI 以非零状态退出。日志只包含允许的生命周期事件，不输出原始异常或配置。失败的详细诊断与运行治理在 WP8 完善。

测试使用临时目录与真实 Durable，不依赖验证工程测试钩子。完整原型迁移是 WP1b，G1 未通过。模块与未来行为见 `docs/design/server-architecture.md`。
