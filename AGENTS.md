# AGENTS.md

给在这个仓库里工作的 agent 的入口说明。人类同样适用。

## 先读什么（按顺序）

1. [Agent 层架构基调](docs/design/agent-core.md)：**十条不变量**与完成定义（DoD）。违反即架构退化。
2. [实施路线](docs/design/roadmap.md)：工作包（WP）、依赖、闸门、并行/串行规则、协作协议。
3. [验证状态](docs/design/verification-status.md)：所有数字与时点的唯一口径。
4. [AG-UI 协议评估](docs/design/protocol-agui.md)：客户端协议的决定与边界。
5. [设计总览](docs/design/README.md)：产品与架构决定。
6. [Agent Team 方案](docs/team/agent-team.md)：角色、分支、评审、闸门与协作循环（提案，待人类确认）。

## 当前阶段

- `WP0 基线` 已完成（git、证据入库、备份、CI、凭据）。
- **WP1a（架构与基础骨架）已落地**，验收见 verification-status；当前推进 **WP1b（正式 Agent 核心工程化重建）**，WP1b.1 对话命令和 WP1b.2a 对话执行已落地，下一片为 USER.md/上下文预算与压缩。完整产品能力仍在 `infra/pi-durable-validation/`；`apps/server/` 的产品能力按独立分片重建，不代表完整 WP1/G1 已完成。
- **浏览器原生 RTC 集成暂缓**：只做 WP10 止血，不要加功能、不要接控制面。

## 命令

```bash
# 原型（当前产品能力实现）
cd infra/pi-durable-validation
npm ci --ignore-scripts
npm run check                 # 语法检查
npm test                      # 28 项离线套件（默认 10 轮强杀）
POINT_CRASH_ROUNDS=1 npm test # 快速检查

# 备份（SQLite 在线快照，不要 cp WAL 数据库）
npm run backup -- --data runtime/deepseek --out backups

# CI 等价检查（提交前至少跑这个）
npm run check && POINT_CRASH_ROUNDS=1 npm test
```

正式骨架在仓库根目录运行（与原型回归分开）：

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run build && npm start
```

正式代码改动需通过根目录检查，并继续运行上面的原型规定回归。Server 分层与依赖规则见 [长期架构](docs/design/server-architecture.md)。

## 仓库结构

| 路径 | 内容 | 能不能改 |
|---|---|---|
| `apps/server/` | 正式 Server；WP1a 基础、WP1b 按契约重建 | 可以，遵守模块边界 |
| `infra/pi-durable-validation/` | 活跃原型：Agent、CLI、浏览器适配、验收 | 可以（但 WP1 开始后新代码进 `apps/server/`） |
| `infra/pi-durable-validation/evidence/` | 验收证据（只增不覆盖） | 只增 |
| `docs/design/` | 现行设计、ADR、路线、验证口径 | 可以，但按 §5.4 |
| `docs/research/` | 调研时点结论 | 不改历史结论，只加勘误 |
| `server/` | 旧 Pi SDK 验证工程 | **不要改**，只读参考 |
| `infra/agent-browser/`、`infra/dsh-validation/` | 已退役验证 | **不要改** |
| `.research/` | 本地调研素材 | 不入库，不要动 |

## 硬规则

1. **不引入第二执行引擎**（Pi coding-agent SDK、DSH 等）。Agent 层只有 `@earendil-works/pi-durable` 1.3.0。
2. **不存第二份事实**：会话历史、任务进度、产品状态只在 Durable entries/tasks/documents。不要加自有 `messages[]`、旁路队列或第二个数据库。
3. **副作用三态**：外部动作必须先记意图再执行，结果落盘为 `done/unknown/failed`；`unknown` 只能观察核销，**禁止自动重放**。
4. **写操作必须幂等键 + 明确事务边界**；同一业务结果的多条记录在同一个 commit。
5. **domain 不 import 具体实现**：`apps/server/src/domain` 不得出现 `steel`、`cdp`、`puppeteer`、`rtc`；外部能力走 `adapters/resource` 接口。
6. **单写者**：同一数据目录只允许一个服务进程；迁移/升级前必须先备份。
7. **凭据只从环境变量或只读文件读取**，不得进入仓库、日志、聊天、记忆或镜像；不要打印密钥。
8. **证据只增不覆盖**：新增验收结果用带时点的新文件，更新 `evidence/manifest.json` 与 `verification-status`。
9. **AG-UI 只在边缘**：客户端协议是投影层，内部事件模型不依赖 AG-UI 类型。
10. **提交前**：`npm run check && POINT_CRASH_ROUNDS=1 npm test` 必须通过；CI 会跑同样的检查。

## 工作方式（WP 协议）

每个任务都应以一个工作包（WP）为单位：

**开始前（Ready）**：确认 WP 编号与依赖、允许写的文件前缀、验收命令、会不会改契约、需要同步的文档。不清楚就问，不要猜。

**完成后（Done）**：

1. 验收命令通过，把输出摘要写进提交说明；
2. 新增测试可独立运行（不依赖验证工程的测试钩子）；
3. 同步更新的文档列出；
4. 没有触碰其它 lane 的文件；
5. 明确写出"未验证项"。

**提交约定**：一个 WP 一个分支/PR；迁移提交独立；提交信息用 `type(scope): summary`（`feat`/`fix`/`refactor`/`test`/`docs`/`chore`）。

**并行约定**：一个 agent 同时只持有一个 WP；同一 lane 不并行；不同 lane 的文件互斥（见 roadmap §3）。需要动别人 lane 的文件时，停下来升级为串行。

## 禁止事项

- 不要在 `server/`、`infra/agent-browser/`、`infra/dsh-validation/` 里加功能。
- 不要在浏览器侧加功能（RTC、viewer、多会话）——只允许 WP10 的止血补丁。
- 不要修改契约测试来让实现通过；契约变更需 owner 确认。
- 不要在文档里写新的性能/验证数字——先写进 `verification-status`，再引用。
- 不要提交 `runtime/`、`sessions/`、`workspace/`、`node_modules/`、`.env`、`auth.json`、`models.json`。
- 不要在没有备份的情况下运行迁移或长任务。
