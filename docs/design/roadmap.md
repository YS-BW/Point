# 实施路线（工作包制，不排时间）

> 2026-10-19 修订（第二版）：**不按周排期**。这个项目由人类与 agent 协作推进，进度用"工作包 + 闸门"衡量，而不是日历。
> 约束见 [Agent 层架构基调](agent-core.md)；客户端协议见 [AG-UI 评估](protocol-agui.md)；证据口径见[验证状态](verification-status.md)。

## 0. 推进方式

- **工作单元 = 工作包（WP）**：一个 WP 是一个可独立验收、可独立回滚的改动，对应一个分支/PR、一个 owner（人或 agent）。
- **进度 = 闸门（G）**：过闸门才进入下一批工作。没有"第几周完成"这种东西，只有"依赖是否满足、判据是否通过"。
- **并行 = 文件所有权互斥**：同一 lane 内串行，candidate lane 之间可以并行，前提是接口先冻结、写文件不重叠。
- **人类负责判断，agent 负责实现**：见 §5 的协作协议。

## 1. "坐稳 Agent" 的定义

四类契约可验证，而不是功能多：

| 契约 | 内容 | 当前状态 |
|---|---|---|
| 状态 | 会话/任务/记忆/事件的唯一权威、版本与迁移 | 单文档 v1 + `??=` 补丁；无迁移框架；事件环形截断 |
| 执行 | 任务生命周期、幂等、崩溃恢复、副作用三态 | 原型有 70 次强杀证据，但绑定在验证工程里 |
| 接口 | 稳定 ID、`/v1`、错误码、事件游标与重连、客户端协议 | 无版本；SSE 每次全量；错误只有字符串 |
| 运营 | 单写者、常驻、日志、指标、备份、成本 | 单写者可靠；其余为零 |

## 2. 工作包清单

依赖标注：`→` 表示必须在前一个完成后开始；`∥` 表示可并行。

| WP | 内容 | 依赖 | 出口判据（可运行） | 修改范围 |
|---|---|---|---|---|
| **WP0** ✅ | 基线：仓库、证据入库、备份脚本、CI、凭据 | — | 全新克隆 `npm ci && check && test` 全绿 | 已完成 |
| **WP1** | Server 骨架：`apps/server/src/{api,domain,runtime,adapters,storage}`；`service.mjs` 拆组合根 + tasks/domain；配置与数据目录固定；结构化日志骨架 | WP0 | 28 项离线测试在新结构全绿；`domain/` 无 `defineTask`；单测不 spawn 服务 | `apps/server/**`（新建） |
| **WP2** | 资源抽象：`resource{owner,lease,controlEpoch,state}` 接口 + `adapters/resource`；文件/通知/浏览器统一"意图→执行→三态"；domain 不 import 具体实现 | WP1 | 同一接口能用内存桩跑通租约、过期、`unknown`；`grep` 证明 domain 无 steel/cdp | `apps/server/src/adapters/**`、`domain/**` |
| **WP3** | 状态 v2 + 迁移：`point.meta/chats/chat/memory/job/jobs/browser/requests` 分片；事件改时间线；单 commit 迁移；升级前自动备份；版本闸门 | WP1（与 WP4 可并行，但**事务组唯一 owner**） | v1 夹具库升级语义等值；重启两次迁移幂等；恢复 pre-v2 快照可启动；请求账本有清扫 | `apps/server/src/storage/**`、`runtime/**` |
| **WP4** | API v1 基础契约：`/v1`、错误码对象、所有写操作幂等键、`/inspect` 门控、鉴权、访问日志 | WP1 | 契约测试覆盖 400/404/409/413/503；重放响应逐字节相等 | `apps/server/src/api/**` |
| **WP5** | AG-UI 投影：`POST /v1/agent`、run 生命周期、文本/工具/step 事件、`RUN_FINISHED.usage`、cancelled 语义 | WP4 | 契约测试：流以 `RUN_STARTED` 开头；未知事件被容忍；截断流不伪造 FINISHED；CLI 作为第一个消费者 | `apps/server/src/api/agui/**` |
| **WP6** | 读模型 + 增量事件：`subscribeCommits` 投影；`STATE_SNAPSHOT/DELTA`、`MESSAGES_SNAPSHOT`、`ACTIVITY`、`CUSTOM`；线程流（自定义绑定 + `Last-Event-ID` + 同步 run）；运行流 | WP3、WP4、WP5 | 100 job/10 chat 夹具下 `/state` 的 `storage.task` 调用=0；单 commit 只发 O(变更) 帧；离线重连后状态/消息一致 | `apps/server/src/api/**`、`storage/**` |
| **WP7** | Agent 行为加固：任务状态转移表（含非法转移）、artifact/deliver 的 revision 复检、上下文/压缩边界、记忆上限与遗忘、投递 `unknown` 核销、成本记录 | WP1、WP2（部分依赖 WP3） | 状态转移表 100% 覆盖；每类副作用都有 `unknown` 用例；一次任务可从事件重建 | `apps/server/src/domain/**`、`adapters/**` |
| **WP8** | 常驻化与运维：Dockerfile + compose（restart/healthcheck/资源限制/卷/TZ/非 root）、日志保留、定时备份、指标（任务数/失败率/延迟/费用） | WP1 | 容器重启状态与计划无损；恢复演练通过；一次任务全链路可追溯 | `apps/server/Dockerfile`、`deploy/**`、`infra/**` |
| **WP9** | 长期运行：7 天挂机、供应商故障退避、周期计划最小版、判断层最小规则、成本预算与告警 | WP6、WP7、WP8 | 7 天无泄漏/无丢计划/无陈旧通知；人为注入超时与限流可恢复 | `apps/server/**`、`docs/design/**` |
| **WP10** | 浏览器止血（**冻结，不集成**）：Steel P1 补丁（WS 写串行化）、端口收敛、compose `restart`、文档标注；代码只修 bug | WP0 | 并发 12+ 连接不再 panic；崩溃回归用例通过；测试仍绿 | `infra/pi-durable-validation/**`（最小） |

## 3. 依赖图与并行轨道

```mermaid
flowchart LR
    WP0[WP0 基线 ✅] --> WP1[WP1 骨架]
    WP1 --> WP2[WP2 资源抽象]
    WP1 --> WP3[WP3 状态 v2]
    WP1 --> WP4[WP4 API v1]
    WP1 --> WP8[WP8 运维]
    WP1 --> WP10[WP10 浏览器止血]
    WP4 --> WP5[WP5 AG-UI 投影]
    WP3 --> WP6[WP6 读模型 + 增量]
    WP4 --> WP6
    WP5 --> WP6
    WP2 --> WP7[WP7 行为加固]
    WP3 --> WP7
    WP6 --> WP9[WP9 长期运行]
    WP7 --> WP9
    WP8 --> WP9
```

四条可并行 lane（文件不重叠）：

| Lane | 工作包 | 拥有的文件 | 约束 |
|---|---|---|---|
| **A 状态与读模型** | WP3 → WP6 | `storage/**`、`api/**` 的事件投影部分 | **schema/事务组唯一 owner**，其他 lane 不得改 |
| **B 接口与协议** | WP4 → WP5 | `api/http/**`、`api/agui/**` | 只读 A 的存储接口，不改 schema |
| **C 领域行为** | WP2 → WP7 | `domain/**`、`adapters/**` | 依赖 B 的契约草案，不改 api |
| **D 运维与止血** | WP8、WP10 | `Dockerfile`、`deploy/**`、`infra/**` | 不改应用逻辑 |

**闸门**：

- **G1 骨架就绪**：WP1 + WP2。`domain` 与具体实现解耦，资源接口可用桩验证。
- **G2 契约就绪**：WP4 + WP5。REST 与 AG-UI 的契约测试通过，CLI 已切到新协议。
- **G3 状态就绪**：WP3 + WP6。迁移可回滚，增量事件与重连同步通过。
- **G4 行为与运营就绪**：WP7 + WP8。状态转移表、`unknown` 用例、容器重启、备份恢复全部通过。
- **G5 稳定**：WP9。7 天挂机与故障注入通过，方可称为"底层"。

## 4. 串行规则（违反就会返工）

1. **状态 schema 与事务组**：WP3 与 WP6 必须同一 owner 顺序推进；其他 lane 在 G3 前不得改 schema。
2. **接口冻结点**：WP1 的 ports → 各 lane 才能并行；WP2 的资源接口 → adapter 才能写；WP4 的 API 形状 → WP5 才能写；WP5 的事件形状 → Web 才能接。
3. **一个 WP = 一个分支/PR**：迁移提交必须独立，不夹带功能改动。
4. **契约变更需 owner 批准**：改测试断言等于改契约，必须由对应 lane owner 确认。
5. **副作用三态与资源租约先于所有 adapter**：否则每加一个外部能力都要改 domain。
6. **备份/恢复演练早于真实数据**；**日志/指标早于长跑**。
7. **浏览器在 P1 补丁前不开放入口**；浏览器集成（原 M3）不在本路线内，等 G5 后重新评估。

## 5. 人类与 Agent 的协作协议

### 5.1 角色

| 角色 | 负责 |
|---|---|
| **人类** | 定基调、过闸门、做取舍（如 A/B/C 决策）、真实验收（真实模型/真实浏览器/体感）、掌管凭据与发布 |
| **Agent** | 实现 WP、写测试、更新文档、跑判据、报告证据；不自行改契约、不自行扩范围 |
| **Lead（可为人或 agent）** | 拆分 WP、并行分派、审查 diff、合并、跑全局回归 |

### 5.2 每个 WP 的交接格式

开始前（Ready）必须写清：范围（文件）、依赖、验收命令、动的契约、文档更新点、回滚方式。
完成后（Done）必须满足：

1. 验收命令通过，输出附在 PR/提交说明里；
2. 新增/修改的测试可独立运行；
3. 相关文档同步（`docs/design/**`、`verification-status`）；
4. 没有跨 lane 的文件改动；
5. 明确写出"未验证项"。

### 5.3 并行分派规则

- 一个 agent 一次只持有一个 WP；同一 lane 不并行。
- 分派时给出：WP 编号、允许写的前缀、禁止写的目录、验收命令。
- 冲突检测靠写前缀互斥；一旦要动别人 lane 的文件，先升级为串行或换 owner。
- 合并顺序按依赖图，不按完成时间。
- 每个闸门由 Lead 跑一次全局回归 + 人工抽查，再宣布通过。

### 5.4 决策与记录

- 架构取舍写成 ADR（`docs/design/adr/`），不留在聊天里。
- 未定问题开 issue，不阻塞 lane 的其它部分。
- 证据数字只写进 [verification-status](verification-status.md)，其它地方引用它。

## 6. 风险与决策点

| 风险 | 证据 | 处理 |
|---|---|---|
| 状态重构期间语义漂移 | 单文档 + 隐式 `??=` | WP3 以"v1 夹具库语义等值"为硬判据 |
| 长跑状态膨胀 / 事件成本 | 单文档、无清理、O(jobs) | WP3 + WP6；WP9 先压测 |
| AG-UI 规范演进 | 1.0 已有 31 事件且仍在加 | 锁 `protocolVersion`，vendored schema 契约测试，未知事件容忍 |
| 判断层无证据 | [decision-layer](decision-layer.md) 自述未验证 | WP9 只做可审计的最小规则，不做黑盒评分 |
| pi-durable 实验性 API | 1.3.0 锁定、无兼容承诺 | 升级前跑固定回归 + 迁移演练；每季度评估 |
| 成本不可见 | 无 token/费用记录 | WP5 `usage` + WP7 记录 + WP8 指标 |
| Steel 崩溃/暴露面 | 已实测未鉴权并发打挂容器 | WP10 止血；正式集成另行评估 |

## 7. 反模式

1. 在 WP1 期间顺手加功能——只搬不改，否则测试基线失效。
2. 浏览器推迟但资源抽象写成"浏览器专用"。
3. 先做 UI 再定契约。
4. 迁移与功能混在一个 PR。
5. 跳过备份/恢复就跑长任务。
6. 引入第二执行引擎。
7. 用"第几周"衡量进度——只看闸门。
8. agent 自行扩大范围或修改契约测试。
