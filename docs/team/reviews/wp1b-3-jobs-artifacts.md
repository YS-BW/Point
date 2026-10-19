# WP1b.3 Job/Attempt、工具与产物独立评审（code-auditor）

> 2026-10-19。评审对象：分支 `wp/1b-jobs-artifacts`（基线 `ba56477`，WP1b.2b 之后）上的 WP1b.3 工作树改动。
> 评审人：code-auditor（独立于实现作者）；作者：job-impl / artifact-impl / senior-tester；契约与裁决：lead。
> 依据：[jobs-and-artifacts 契约](../../design/jobs-and-artifacts.md)、[agent-core 十条不变量](../../design/agent-core.md)、[评审检查清单](../review-checklist.md)、[tasks-and-agents](../../design/tasks-and-agents.md)。
> 收尾复核后定稿：B1/P1/P2/P3 已修复并复核；P4 已写入契约已知行为；官方 127/127。

## 1. 结论

**通过（无未解决 blocker）。**

- **B1（已解决）**：契约 §5.6 要求的 artifact writing 崩溃窗口 child-process fixture 已补（`fixtures/artifact-crash.ts` + `artifact.test.ts:332`），复核通过。
- **P1/P2/P3（已解决）**：收据键作用域、取消已完成/失败 Job 的 Attempt 语义、同名 artifact 路径覆盖均已修实现并补测试；我的独立探针复核通过。
- **P4（已文档化）**：优雅 close 后 in-flight 模型调用重启保守 `failed SUBMISSION_UNANSWERED`、0 重放、read-only 短暂 running，已写入契约 §5 已知行为。
- **P5/P6（非阻塞观察）**：取消只 abort attempt task、不 abort execution conversation（in-flight 模型循环可能继续消耗调用，但不会成功/ready）；`ArtifactState.unknown` 本片未产生。建议后续文档/实现明确。
- 最终验证（我以官方 dist 只读复跑）：**127/127 pass**（server 117 = 既有 92 + 新增 25；scripts 10）；targeted job/artifact **25/25**；`tsc --noEmit` exit 0；`check-boundaries` passed；build 由 lead/tester 官方窗口 exit 0。
- Scope 干净：9 个新增 src + 1 个修改（`runtime/open.ts`）+ 3 个测试/夹具 + 契约/OpenSpec；未改 `api/**`、`bootstrap.ts`、`config.ts`，既有 92 服务端 + 10 scripts 测试未修改且全绿。

## 2. 评审范围与方法

- 新增：`domain/job.ts`、`domain/artifact.ts`、`storage/job.ts`、`storage/artifact.ts`、`application/job.ts`、`application/artifact.ts`、`runtime/jobs.ts`、`runtime/artifacts.ts`、`runtime/tools.ts`；`test/job.test.ts`、`artifact.test.ts`、`fixtures/job-crash.ts`、`fixtures/artifact-crash.ts`；`docs/design/jobs-and-artifacts.md`、OpenSpec `agent-jobs-artifacts`。
- 修改：`runtime/open.ts`（组装 jobs/artifact/tools、返回 `jobs` 端口）。
- 方法：只读代码/测试 + 官方 dist 只读执行 + `/tmp` 独立探针（不写入仓库）：cancel-in-flight、cancel-from-ready、amend-from-failed、receipt key 跨命令复用、优雅 close + 重启、同名 artifact 双写、SIGKILL 模型恢复、cancel 后模型循环。
- 复核结果：

| 命令 | 结果 |
|---|---|
| `node --test apps/server/dist/test/*.test.js scripts/*.test.mjs`（只读） | **127/127 pass**（server 117 + scripts 10） |
| `node --test apps/server/dist/test/job.test.js apps/server/dist/test/artifact.test.js` | **25/25 pass**（job 16 + artifact 9） |
| `npx tsc -p apps/server/tsconfig.json --noEmit` | exit 0 |
| `node scripts/check-boundaries.mjs` | `Architecture boundaries passed` |
| `npm run build` | exit 0（lead/tester 官方窗口） |

## 3. Blocker（已解决）

### B1（已解决）契约 §5.6 的 artifact 崩溃窗口缺 child-process fixture

- 原问题：契约要求 child-process SIGKILL fixture 至少覆盖“模型恢复”与“artifact writing 不被当成功”；原只有 `job-crash.ts model-pending`（模型恢复），artifact 文件已 rename、sealed 记录未提交的窗口没有 fixture。合成 writing 测试不等于真实崩溃窗口。
- 修复：`fixtures/artifact-crash.ts:27-34` 用真实 `artifactFiles.write` 写完文件后 IPC 通知父进程并挂起；`artifact.test.ts:332` 父进程 SIGKILL 后重开同一数据目录，断言 artifact 仍 `writing`、`verify → {verified:false, reason:'NOT_SEALED'}`、文件保留且 0600、sha256/bytes 与记录一致。
- 复核：targeted 25/25 通过；该项从 blocker 转为已解决。结果 commit 前窗口未单做 fixture（契约只要求“至少”上述两项），列为可选后续（N1）。

## 4. 实质意见与问题处置

1. **P1（已解决）收据键作用域。** 原实现 `amend`/`cancel` 用 `${jobId}:${requestId}`，与契约 `${command}:${requestId}` 不符；同 Job 上 amend+cancel 复用 requestId 会 `IDEMPOTENCY_CONFLICT`。修复：`runtime/jobs.ts:344/385/439` 改为 `start:${sourceChatId}:${requestId}` / `amend:${jobId}:${requestId}` / `cancel:${jobId}:${requestId}`，契约 §2 line 49 同步“不同 command 的同一 requestId 互不冲突”；测试 `job.test.ts:484`；我的 probe 复核两者均成功且各自重放。
2. **P2（已解决）取消已完成/失败 Job 的 Attempt 语义。** 原实现把 `completed|failed` Attempt 改成 `cancelled` 并保留 result/artifactId，状态自相矛盾。修复：`ATTEMPT_TRANSITIONS` 中 completed/failed 只允许 superseded（`domain/job.ts:125-132`），cancel 仅对 queued/running current attempt 生效；Job 仍变 cancelled 并保留 result/artifactId 供审计。测试 `job.test.ts:512/536`；probe 复核 completed attempt 保持 completed、Job cancelled 保留结果与证据。
3. **P3（已解决）同名 artifact 路径覆盖。** 原路径 `…/<attemptId>/<name>` 使同一 attempt 两次同名保存（不同 callId）共享文件路径、后写覆盖先写、先 sealed 记录变不可验证。修复：路径改为 `<attemptId>/<sanitized artifactId>-<sha12>/<name>`（`runtime/artifacts.ts:55-79`，tools 调用点 `runtime/tools.ts:156`），契约 §4 line 85 更新。probe：两个 artifact 各自独立目录、latest 的 `verified=true` 且文件内容与其记录一致；artifact.test 路径断言已更新。
4. **P4（已文档化）优雅关闭时 in-flight 模型调用。** probe：abort 感知 provider，`runtime.close()` 后带绑定重启 → Attempt/Job `failed SUBMISSION_UNANSWERED`、provider 0 调用；read-only 重开短暂 running。契约 §5 line 104 已写为已知行为；不是 bug（不重放、不伪造成功）。
5. **P5（非阻塞观察，建议后续明确）取消不 abort execution conversation。** probe：cancel 在 tool round 中发生后，attempt/job 正确 cancelled 且无 ready/artifact 成功；但 execution conversation 的 generation 仍继续到下一轮模型调用（provider `callCount` 1→2）。契约只要求取消传播到 attempt task/不伪造成功，未要求停止模型成本；建议在契约已知行为或后续 WP 明确“取消可能仍有 in-flight 模型轮次”，必要时在 cancel commit 后 `conversation.abort`（需评估是否会撤销已发生结果）。
6. **P6（非阻塞小项）`ArtifactState.unknown` 未产生。** 契约 §4 列 `writing|sealed|unknown|failed`，本片只有 writing/sealed/failed；文件是本机原子写，当前不需要 unknown。建议契约注明“预留，真实外部工具接入时定义”。
7. **测试质量：不是 smoke。** 真实走 `point.job.attempt` task、execution conversation、save_artifact 工具、artifact 文件与 Durable 文档；覆盖 revision fence（amend-in-flight 旧 attempt 不覆盖新结果）、cancel 传播、SIGKILL 模型恢复、artifact crash 窗口、工具授权/幂等/冲突/穿越/超限、verify 篡改与缺失。

## 5. 逐条检查（review-checklist：通用十条）

1. **事务边界**：`start` 单 commit（收据 + Job + Attempt + execution conversation + JobExecution 映射 + attempt task，`runtime/jobs.ts:333-368`）；`amend` 单 commit（`:370-423`）commit 后 `abortTask(old)`；`cancel` 单 commit（`:426-466`）commit 后 abort；artifact `writing`/`sealed` 各自单 commit，sealed commit 同事务写 `Attempt.artifactId`（`runtime/tools.ts:101-119`）。**通过**。
2. **幂等键**：command 收据键含 command 前缀（P1 修复，契约 line 49）；工具以 `artifactId=<attemptId>:<callId>` + sha256 幂等，异 hash `ARTIFACT_CONFLICT`。**通过**。
3. **副作用三态**：artifact `writing → sealed|failed`，writing/unknown/failed 永不 success；attempt task 只接受 sealed + 本 Job/Attempt/revision + 文件 hash 核对（`runtime/jobs.ts:189-224`、`domain/job.ts:176-187`）；模型调用走既有 guard；取消/amend 后工具被 `STALE_ATTEMPT/JOB_NOT_RUNNING` 拒绝。**通过**。
4. **状态与迁移**：新增 doc kinds 均 version 1（`point.job`、`point.attempt`、`point.job-execution`、`point.command.job`、`point.artifact`）；不改既有 schema/Meta，无需迁移。**通过**。
5. **依赖方向**：domain 无 import；application 只 import domain；runtime 才 import SDK/fs/crypto；`check-boundaries` 通过。**通过**。
6. **错误契约**：`JobError`/`ArtifactError` 稳定 code；工具把 domain code 映射为 `isError` 结果。**通过**。
7. **测试**：见 §6；B1 已补 crash fixture，fail matrix 主要项有覆盖；结果 commit 前窗口未单做 fixture（可选 N1）。**通过**。
8. **文档与证据**：契约已同步（收据键、artifact 路径、cancel/ready 语义、P4 已知行为、P5 待说明）；`verification-status`/README/evidence/OpenSpec 属 task-14，**合并前必须完成**。**部分完成**。
9. **性能敏感路径**：无 snapshot/SSE/迁移；artifact 256 KiB 上限、工具参数有界；未做吞吐断言（本片非性能路径）。**不适用**。
10. **写作用域**：仅契约列出的 9 个 src + `open.ts` + 3 个测试/夹具 + docs/openspec；未改 `api/**`、`bootstrap.ts`、`config.ts`，未改既有测试/依赖；临时构建残留已清理（复核时无 stray 文件）。**通过**。

## 6. 契约 §5 失败矩阵对照

| # | 要求 | 覆盖 |
|---|---|---|
| 1 | 新修订新 attempt；旧 attempt 不覆盖新 revision、标 superseded | `domain/job.ts:107-114/163-170`；`job.test.ts:282/326` |
| 2 | 恢复沿用同 attempt/task、不重复模型调用、unknown 不重放 | `job.test.ts:433`（child SIGKILL model-pending；同 attemptId、provider 0 重放、不伪造成功） |
| 3 | 取消传播；取消后不产生 ready/artifact 成功；不伪装撤销外部写 | `job.test.ts:351`；`runtime/jobs.ts:96-133/241-253`；P5 说明 in-flight 模型轮次 |
| 4 | 工具正常写入 sealed+hash；重复幂等；穿越/超限/非 execution 拒绝；writing 不算成功 | `artifact.test.ts:142/168/178/206/273`；`runtime/tools.ts:134-177` |
| 5 | expectedRevision 不匹配拒绝；同键重放；异指纹冲突 | `job.test.ts:282-324/386-431/484`；`domain/job.ts:153-155` |
| 6 | 崩溃窗口（task 创建后 / 模型返回 commit 前 / artifact 写后 doc 前 / 结果 commit 前；至少模型恢复 + artifact writing 不被当成功） | 模型恢复：`job.test.ts:433`；**artifact writing：`artifact.test.ts:332` + `fixtures/artifact-crash.ts`**；结果 commit 前窗口未单做（N1，契约只要求“至少”） |
| 7 | 既有 102 项不回归 | 官方 127/127；既有 92 服务端 + 10 scripts 全过，新增 25 |

## 7. 非阻塞建议

- **N1（可选）**：补结果 commit 前窗口的 child-process fixture（模型回答已提交、Job/Attempt ready commit 前 kill），断言恢复后不 ready、无伪造成功；当前契约不强制。
- **N2（P5 文档/后续）**：明确取消不 abort execution conversation 的行为（in-flight 模型轮次可能继续），或后续 WP 在 cancel/amend commit 后 `conversation.abort` 并评估对已发生结果的影响。
- **N3（P6 文档）**：`ArtifactState.unknown` 注明预留或删除；如后续接真实外部工具，再补 unknown 的观察核销流程。
- **N4（task-14）**：`verification-status` 新增 WP1b.3 证据段（127 项、命令、时点、边界、未做项）、`apps/server/README.md` 写 jobs/artifacts 用法与“workspace 文件非数据库事务、verify 可发现半成品/篡改”边界、evidence JSON + manifest（只增）、OpenSpec strict、AGENTS 当前阶段。
- **N5（低优先测试）**：补工具在 amend 后旧 execution conversation 上返回 `STALE_ATTEMPT` 的直接用例（当前由 job cancelled 用例 + sealed commit fence 间接覆盖）。

## 8. 未验证项与已知限制

- 结果 commit 前的真实崩溃窗口没有 child-process fixture（N1）；artifact writing 窗口已由 fixture 覆盖。
- 真实模型质量、真实外部工具、浏览器/网络资源、通知/计划/投递、HTTP、Docker 均为非目标。
- 取消不撤销已发生的外部写；取消不 abort execution conversation，in-flight 模型轮次可能继续（P5），但不会产生 ready/artifact 成功。
- 优雅关闭时 in-flight 模型调用：重启后保守 failed（不重放）；read-only 重开短暂 running（契约 §5 已知行为，P4）。
- `unknown` artifact state 未使用（P6）；workspace 文件系统与 Durable 文档非同一事务，`verify` 只能在读取时发现篡改/缺失。
- 单进程真实并发未压测；多进程/分布式语义不在本片。

## 9. 写作用域与越界检查

- `git status` 仅：9 个新增 src、`runtime/open.ts` 修改、3 个测试/夹具、`docs/design/jobs-and-artifacts.md`、OpenSpec change、本评审文件。
- 未触碰 `apps/server/src/api/**`、`bootstrap.ts`、`config.ts`；未改既有 92 服务端 + 10 scripts 测试；未改 `package.json`/依赖；实现期临时 `.tmp-dist/`/`.p1p2-smoke.mjs` 已清理（复核时不存在）。
- 本评审只写 `docs/team/reviews/wp1b-3-jobs-artifacts.md`，未改源码/测试/scripts，未执行 git 写操作。

## 10. 审计探针（/tmp，不写入仓库）

| 场景 | 结果 |
|---|---|
| 模型调用中 cancel | provider 不再发起新调用；Job/Attempt cancelled、result/artifactId null；迟到答案不写结果 |
| cancel from ready（P2） | Job cancelled 保留 result/artifactId；Attempt 保持 completed + result/artifactId（不再被改写） |
| amend from failed | 允许：revision 2、新 attempt、Job 重新 queued→ready |
| 同 Job 同 requestId amend+cancel（P1） | 两者均成功、各自重放，无串话（修复前为 IDEMPOTENCY_CONFLICT） |
| 优雅 close + 带绑定重启（P4） | Attempt/Job → failed `SUBMISSION_UNANSWERED`，provider 0 调用 |
| 同名 artifact 双写（P3） | 两个 artifact 各自独立目录、均 sealed；latest `verified=true` 且文件内容一致（修复前共享 path 互相覆盖） |
| cancel 发生在 tool round 中（P5） | Job/Attempt 正确 cancelled、无成功；但 execution conversation 继续到下一轮模型调用（`callCount` 1→2） |
| artifact 文件写后、seal commit 前 SIGKILL（B1） | artifact 仍 `writing`、`verify=false/NOT_SEALED`、文件保留且 0600、无 sealed/成功 |
| 既有测试不回归 | 官方 127/127；既有 92 服务端 + 10 scripts 全过 |
