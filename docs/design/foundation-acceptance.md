# 基础骨架完成审计

> WP1a，2026-10-19。按实际代码与行为逐项核对；不替代 WP1b 产品能力迁移和后续闸门。测试数字与时点仅以 [verification-status](verification-status.md) 为准。

| 要求 | 权威实现 | 验证证据 | 结论 |
|---|---|---|---|
| 可独立安装/编译/启动 | 根 package-lock、apps/server/tsconfig、main.ts、runtime 源码忽略例外 | 从 Git 暂存内容导出的干净目录独立安装、check、test；entrypoint 子进程测试 | 已验证本机及独立检出目录 |
| 构建不残留旧代码，失败不输出入口 | clean-build.mjs、noEmitOnError | 残留文件探针与类型错误夹具，随后正常检查通过 | 已验证 |
| 单写者与进程死亡释放 | storage/owner.ts | 同进程竞争、独立子进程竞争、SIGKILL 后重开 | 已验证本机本地文件系统 |
| 初始化原子性与身份稳定 | runtime/open.ts、storage/meta.ts | root 初始化事务内强杀；正常重启身份保持 | 已验证 |
| SDK 不自动升级现有库 | storage/preflight.ts | 未知库、旧/新 schema 拒绝，文件字节相同 | 已验证锁定 SDK schema |
| 产品 metadata 兼容性 | storage/meta.ts、runtime/open.ts | 不支持 format 不重写；未识别会话/session document 拒绝 | 已验证 |
| 启动失败释放 | bootstrap.ts | HTTP 端口已占用、runtime 启动时已终止 | 已验证 |
| 运行时失败不会伪装为服务可用 | RuntimeHandle.closed → bootstrap.closed → main | 意外终止后 HTTP 关闭；cleanup 失败返回 failed | 已验证生命周期端口故障注入；没有故意损坏真实在线磁盘 |
| 幂等关闭与进程退出 | bootstrap/main | 并发 close 只释放一次；SIGTERM；失败退出不打印输入 | 已验证 |
| 真实且最小的健康接口 | api/http.ts | foundation capability、未实现路由 404、错误方法 405 | 已验证；不是 Agent readiness |
| 分层与唯一执行引擎 | scripts/check-boundaries.mjs、package.json | AST 导入/导出/dynamic/type import 反例、未注册层拒绝 | 已验证结构检查；不是能识别所有业务违规的形式化证明 |
| 无原型测试钩子依赖 | apps/server/test、scripts/*.test.mjs | 正式测试独立启动正式模块，使用真实 Durable/临时目录与组合端口桩 | 已核对 |
| 无改动原型行为 | infra/pi-durable-validation/src 与 test 未修改 | 原型规定回归 | 已验证原有离线范围 |
| 文档与证据 | architecture/ADR/roadmap/OpenSpec/manifest | OpenSpec strict、diff check、链接核对、不可变结果文件 | 已核对 |

尚未证明：Linux 容器部署、真实供应商、真实外部动作、长跑、产品数据迁移、资源/通知 adapter、Web 和浏览器控制面。GitHub CI job 已配置，尚未远程执行。上述条目不得被本表的“已验证”扩大解释。

完整 WP1 的产品迁移要求仍未完成；当前骨架保持可运行基础，未实现的功能不提供模拟成功接口。用户于 2026-10-19 明确确认：本次完成基础骨架与稳定性验收，产品迁移单独做。因此本次交付范围已完成；WP1b 和 G1 仍保留为后续工作，不在本次完成声明内。
