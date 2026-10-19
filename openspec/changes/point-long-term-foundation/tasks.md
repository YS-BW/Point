# Tasks

## 1. Architecture

- [x] 1.1 交付固定版本 NanoMuse 源码分析、长期架构 ADR 和路线；核对源码链接与现行约束，无第二执行引擎或第二事实来源。

## 2. Foundation

- [x] 2.1 建立严格 TypeScript 骨架、真实 Durable 生命周期与 HTTP 健康接口；通过独立生命周期、版本拒绝、关闭与锁测试，README 给出可运行命令。
- [x] 2.2 建立依赖边界检查及其反例测试，根构建与 CI；npm run check 和 npm test 通过。

## 3. Integration

- [x] 3.1 跑原型规定回归，新增不可变证据并更新 manifest、verification-status、AGENTS 和 OpenSpec；标明未验证项，验证 OpenSpec 与 git diff --check。

## 4. Stability iteration

- [x] 4.1 增加 SDK 写入前只读 schema 预检；未知/旧版/新版数据库拒绝后字节不变，测试通过并补证据。
- [x] 4.2 依赖检查拒绝未注册层和绝对路径绕过；反例测试通过。
- [x] 4.3 运行时终止传递到 Server；启动中关闭、意外终止与清理失败测试通过，CLI 根据终止结果退出。
- [x] 4.4 构建先清理生成物且类型失败不输出 JS；用残留文件和错误源码夹具验证，再跑正式检查。
- [x] 4.5 修正 runtime 源码忽略规则；从暂存内容导出干净副本，独立安装、检查与测试通过。
