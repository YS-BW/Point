> 历史快照：2026-10-16 切换 Pi SDK 前的设计，已被当前 docs/design/ 文档取代。这里的已定状态与技术断言不代表当前结论。

# 平台选型：pi-durable 作为 L0 运行时

> 状态：**✅ 已定（2026-10-16）**
> **决策：用 `@earendil-works/pi-durable` v1.3.0 作为 L0 运行时。执行层用 pi-ai / pi-codemode / pi-mcp。不二开 openmuse / nanomuse。**
> 依据：[pi-durable 审计](../../../../.research/pi-durable-audit.md) · [Pi 1.0 全景审计](../../../../.research/pi-1.0-audit.md)

---

## 0. 一句话

**Pi 把「最难做对、又最不体现能力」的那部分给了你——原子提交、崩溃恢复、任务 checkpoint、所有权树、prompt cache——而它明确缺的那五层（触发/判断/投递/治理/反馈）恰好就是你要做的差异化。**

---

## 1. 为什么是它（正面理由）

| # | 理由 | 依据 |
|---|---|---|
| 1 | **L0 语义是真的，不是营销词** | 核心不变量 ③ **"All visible progress is durable. There is no volatile publication path."**（`spec.md:66-67`）；commit-before-publish 有明确代码路径（`session.ts:690-742`：`change → settleSuccess → storage.commit → adopt → publish`） |
| 2 | **崩溃恢复有确定性判据，不靠启发式** | `scheduler.ts:1362-1365`：**「handler 没推进 checkpoint 就 fault」**。比租约方案优雅——租约要处理过期误判、续租失败、时钟偏移 |
| 3 | **副作用语义形式化** | §5.2 **Effect sandwich**：`commit intent → effect → commit outcome`。规范原文：*"Reopening in an intent phase means **the effect may have happened**."* |
| 4 | ★ **`head` + `ContextEdit` 天然匹配「事件流为底」** | `spec.md:262-265`：*"A head on an entry changes subsequent context; **it does not remove older entries from storage**."* → 投影本身进存储、可审计、可回放。**我们设计的「原文不删、记忆可以有损」是它的原生能力** |
| 5 | ★ **系统主动发起 turn 的三件套齐了** | `submit()` 是唯一 run 入口且**对程序开放**；`requestId` **幂等**（重启不重复发起）；`runtime.sleep(until)` **持久**且过期立即返回（天然 catch-up） |
| 6 | **工程质量远超它的年龄** | `src/` **0 个 `any`、0 个 TODO**；测试/源码 **1.34 : 1**；**5,352 行规范性 spec**；**18 项存储一致性契约**；真实 benchmark（32k 次 append 从 11.3s → 1.4s） |
| 7 | **MIT，完全可自托管，无闭源依赖** | 对比 CopilotKit Intelligence 的反例 |

---

## 2. 为什么不是其他（反面排除）

| 候选 | 排除理由 |
|---|---|
| **CopilotKit/openmuse** | MIT 但**每个模式强制闭源 Intelligence**（`config.ts:152` `required(...)`）；**更关键：它的 L0 是「多会话 + 会话表 + Rich Threads」，与我们已经定下的「单会话 + 事件流为底」结构不兼容**——二开要先拆掉它的 L0 |
| **nano-muse/nanomuse** | `android/` 87% 是 vendored OpenMinis 且 `AGENTS.md:62` **明令不许重构**；上游 **10 天发 8 个版本** → merge 地狱。**排除理由是结构性的，不是 license**（项目完全开源，license 不设限） |
| **Pi SDK（`pi-coding-agent`）** | 它**持久化「对话」但不持久化「工作」**——session 文件里只有 message/compaction/context_edit/usage，**没有 task/checkpoint/intent**。崩了之后你知道聊到哪了，但不知道该接着做什么 |
| **OpenClaw / Hermes** | 太重（392k★ / 254k★），且已是巨兽，用户明确排除 |
| **从零自研 L0** | 审计证明崩溃恢复/所有权树/checkpoint 是**最容易写错**的部分；durable 是「已经做完的那一遍」 |

---

## 3. 七层覆盖（明确分工）

```
Pi 白送：  L0（除记忆）+ L3
Point 写： L1 + L2 + L4 + L5 + L6 + 记忆层
```

| 层 | pi-durable | 要做什么 |
|---|---|---|
| **L0 会话/任务/文档** | ✅ 原子 commit + entry/document 双模型 + fork + rewindable | — |
| **L0 持久化** | ✅ SQLite / JSONL / Memory + **迁移机制** | — |
| **L0 崩溃恢复** | ✅ `resume()` + 每 phase checkpoint + intent/effect/outcome | — |
| **L0 上下文** | ✅ **`head` + `ContextEdit` + 10 条推导规则** | — |
| **L0 记忆** | ❌ 只有 document + 会话内摘要 | **自建**（provenance / 真删 / 时效性 / 回检） |
| **L1 触发** | ❌ 零 cron、零 interval | **自建**（零件：`runtime.sleep` + `env.watch()` + `submit()`） |
| **L2 判断** | ⚠️ 骨架（`models.classify()` 原语 + hooks） | **策略 + 五维特征 + 预算**（有 cost 数据，**无任何限额**） |
| **L3 执行** | ✅ 工具系统 + durable ToolTask + nested call + 本地/远程 env | **容器化 env**（默认无沙箱） |
| **L4 投递** | ❌ 只有进程内回调 | **全自建**（但有 `type:"write"` 绕过队列的通道） |
| **L5 治理** | ❌ **整个 Pi 生态都没有**（根 README 明文） | **✅ 已定：不做权限层，给 agent 完全权限**（见 §5） |
| **L6 反馈** | ⚠️ 一半（events/views/usage+cost） | **评估 + 反馈闭环**（方法论参考 `pi-evals`） |

---

## 4. ⛔ 三条硬约束与应对

| 约束 | 事实 | 应对 |
|---|---|---|
| **单进程，无跨进程锁** | `README.md:682` 明文：*"One process owns a storage at a time; there is no cross-process locking."*；`scheduler.ts:303-305` 打开时把**所有** `running` 改回 `pending` → 进程 B 会劫持 A 的任务 | **systemd 单例 + 退出确认**。将来要多进程，**租约必须加在 `Storage` 包装层**（业务层加锁无效） |
| **完全没有沙箱** | `NodeExecutionEnv` 直接 `spawn` 在宿主，无容器/chroot/uid/seccomp；**路径不限 cwd** | **✅ 已定：接受，不加沙箱**（见 §5）。若将来要加，参考 `pi-env` 的 SSH 加固与 gondolin 模式（凭据在宿主、执行进 micro-VM） |
| **零调度** | `setInterval` / `cron` 全仓零命中 | **自建 L1**：`runtime.sleep(until)` 搭持久定时循环 + `env.watch()` 接文件事件 + `submit()` 发起 turn |

---

## 5. ✅ 已定：L5 不做权限层（完全权限）

**决策（2026-10-16）：不给 agent 加权限限制，它拥有运行用户的一切权限。**

**依据——这与 Pi 自身的哲学一致**（根 README 原文）：

> *"Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. **By default, it runs with the permissions of the user and process that launched it.**"*

Pi 自己的 `packages/coding-agent/docs/security.md` 把安全的答案放在**操作系统层**，不是应用层：

> *"Safety comes from limiting the files, credentials, processes, and network services Pi can access and affect…"*
> *"Directly, with the permissions of its operating-system user → **A dedicated user account** can narrow those permissions"*

**→ 所以 Point 不建权限系统是对的：在单人自托管场景下，权限边界由「跑在哪个用户/哪台机器」表达，而不是由应用内的策略表达。**

**保留的两件事（它们不是权限，不冲突）：**

| 保留 | 为什么 |
|---|---|
| **审计 / 可追溯** | 它属于「**可解释**」（和 L2 的「可解释的沉默」同源），不是「限制」。而且工具调用天然是 durable 的 `ToolTask`，记录是免费的 |
| **凭据放置** | 完全权限 ≠ 凭据乱放。`pi.provider` 只存 `sessionId`，凭据来自进程 env（README:57）——这是**配置问题**，不是权限系统 |

**⚠️ 唯一零成本的可选项**：如果将来把 Point 跑在**专用系统用户**下，就免费获得一层边界（Pi 自己推荐的第一个选项）。**不需要现在做，只需要部署时别用 root/主账号。**

**放弃的**：审批弹窗、capability 授权、taint 追踪、`{{vault:NAME}}` 占位符、沙箱注入。**这是因为单人自托管场景下它们的收益低于复杂度成本**；若将来要多人/多租户，需要重新评估。

---

## 6. 已验证的事实（Lead 实跑，非纸面）

在 `.research/scratch/durable-try/` 实装并跑通：

**Demo 1 — 崩溃恢复 + 幂等**（[01-recovery.mjs](../../../../.research/scratch/durable-try/01-recovery.mjs)）
```
【第一次运行】tick 1 ✓  tick 2 ✓   → Harness 关闭（tick 2 结果未落盘）
【关闭时读出】checkpoint = {"status":"pending","checkpoint":{"phase":"tick","n":2}}
              memos      = {"printed-1":true,"printed-2":true}
【第二次运行】tick 2 重跑（结果丢了）→ memo 说已执行过 → 不重复打印
              tick 3 ✓ tick 4 ✓ tick 5 ✓
【断言】真正执行 [1,2,3,4,5]，重复：无 ✓
```
> **checkpoint 停在 `n:2` 而不是 `n:3`** —— 它知道自己*可能*执行过 tick 2，所以重跑；靠 memo 保证副作用不重复。**这是 effect sandwich 的 live 版本。**

**Demo 2 — 对话 + 人格 + 主动 turn**（[03-chat-and-proactive.mjs](../../../../.research/scratch/durable-try/03-chat-and-proactive.mjs)）
```
【1】用户提问 → 模型回答 → App 关闭
【2】重开 → transcript: ["pi.user","pi.system","pi.assistant"]  ← 持久化了
【3】★ 系统主动发起 turn（无任何用户输入）→ 模型回答
【4】write submission → "app.notification" 进记录，但不是 user message（模型看不到）
```
> 第 3 步就是 L1「定时任务 → 唤醒 agent」要用的通道：**`submit()` 不区分用户还是系统**。
> 第 4 步是 L4 的通道：`type:"write"` 立即落盘、**模型看不到**。

**踩过的坑（重要）**：第一次跑 Demo 1 时任务没动——因为**漏了 `firstRun.resume()`**。
> **durable 不会自己开始工作，必须被显式唤醒。** `open()` 只扫描不调度；`resume()` / `submit()` / `wait()` 才会启用调度。

---

## 7. 依赖清单（**锁精确版本，不用 `^`**）

```json
{
  "@earendil-works/pi-durable": "1.3.0",
  "@earendil-works/pi-ai": "1.3.0",
  "@earendil-works/chord": "1.3.0",
  "@earendil-works/pi-codemode": "1.3.0",
  "@earendil-works/pi-mcp": "1.3.0"
}
```
- **Node ≥ 22.19.0**（实测 22.22.3 通过）
- 可选：`@earendil-works/pi-env`（PC 节点远程执行）、`@earendil-works/pi-telemetry`
- 安装：`npm install --ignore-scripts`（91 包 / 32s / 111M）

**不引入**：`pi-coding-agent`（76k 行终端产品）、`pi-tui`
**独立复用**：`@earendil-works/chord/delta`（事务化 JSON delta tracker，仅依赖 typebox）

---

## 8. 实施操作规则（从审计提炼，逐条有依据）

| # | 规则 | 依据 |
|---|---|---|
| 1 | **锁精确版本**，升级前读 CHANGELOG 的 Breaking | 15 天 8 版、**14 条 breaking**；README:3 *"API changes without notice"* |
| 2 | **写一层薄的 anti-corruption 适配层**（把 `Harness`/`Conversation`/`TaskRuntime` 包进自己的接口） | 152 个导出 / 17 个子路径；升级只改适配层 |
| 3 | **存储用 SQLite，不要 JSONL** | `jsonl/storage.ts:247` 有 `private readonly memory = new MemoryStorage()` → **全量历史常驻内存**；README:662 明说长跑用 SQLite |
| 4 | **单实例部署**（systemd 单例 + 退出确认） | `README.md:682` + `scheduler.ts:303-305` |
| 5 | **自定义存储/环境必须过它的 conformance 套件** | `src/testing/storage-conformance.ts`（18 case）+ `registerEnvConformance` |
| 6 | **Document 必须写 `checkpointWhen`** | `spec.md:5268-5270`：不写则 delta **无界增长** |
| 7 | **`kind` 起名要慎重** | `spec.md:5273-5277`：**永久协议，不能改名**（改名要 copy + retire） |
| 8 | **投递不能依赖 watch** | `spec.md:5285-5289`：缓冲上限 **100 帧**，中间态会被替换 → 必须把事实持久化成 entry 再扫历史 |
| 9 | **有副作用的工具要显式声明 `replay`** | 默认 `"unsafe"`（崩溃后不重跑，给模型 `interrupted`）；4 个内建工具都没声明 |
| 10 | **模型调用是 at-least-once，无幂等键** | `generation.ts:196-222`：崩溃在 request 与 commit 之间 → **重复请求、重复计费**。成本预算要算进去 |
| 11 | **commit callback 里不能 await 外部效应，也不能做 Session 读** | `spec.md:5255-5262`：持有 mutation line → **永久挂起**（"only a cache hit returns, so the hang is intermittent"） |
| 12 | **`resume()` 要么显式调用，要么靠 `submit()`/`wait()` 触发** | 见 §6 踩坑记录 |

---

## 9. 待定

- ❓ 适配层的具体边界（包住哪几个类型）
- ❓ 是否现在就用 `pi-env` 做 PC 节点，还是 v1 先用容器化 `ExecutionEnv`
- ❓ `chord/delta` 是否引入（只在自研部分存储组件时才需要）
- ❓ 是否跟随 Pi 的版本节奏（还是冻结在 1.3.0 一段时间）
