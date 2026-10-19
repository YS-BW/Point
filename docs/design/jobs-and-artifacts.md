# Job/Attempt、工具与产物（WP1b.3）

> 2026-10-19。本文件是 WP1b.3 的契约。目标：在正式 Server 上建立产品 Job 与执行 Attempt 的分离身份、revision fence、取消传播、受保护的工具调用与可核对产物。
> 非目标：计划/判断/投递/通知（WP1b.4）、真实浏览器/网络工具、HTTP、Docker、真实模型质量。

## 1. 范围与写作用域

| 文件 | 内容 | owner |
|---|---|---|
| `apps/server/src/domain/job.ts` | Job/Attempt 值对象、状态机、revision/尝试规则、错误码 | job-impl |
| `apps/server/src/storage/job.ts` | `point.job`、`point.attempt`、`point.job-execution`、`point.command.job` 文档族 | job-impl |
| `apps/server/src/application/job.ts` | `JobStore`/`JobCommands` 端口、严格输入、结果 fence | job-impl |
| `apps/server/src/runtime/jobs.ts` | Durable store、`point.job.attempt` task、命令编排 | job-impl |
| `apps/server/src/runtime/open.ts` | 组装 jobs/artifact/tools，返回 `jobs` 端口 | job-impl |
| `apps/server/src/domain/artifact.ts` | Artifact 值对象、名称/大小/哈希规则、验证结果 | artifact-impl |
| `apps/server/src/storage/artifact.ts` | `point.artifact` 文档族（state writing/sealed/unknown/failed） | artifact-impl |
| `apps/server/src/application/artifact.ts` | `ArtifactStore`/`ArtifactCommands`、seal/verify | artifact-impl |
| `apps/server/src/runtime/artifacts.ts` | 原子写、哈希、seal、verify、孤儿核对 | artifact-impl |
| `apps/server/src/runtime/tools.ts` | `save_artifact` 工具与 `point.job.tools` extension | artifact-impl |
| `apps/server/test/job.test.ts`、`artifact.test.ts`、`fixtures/job-crash.ts` | 验收 | senior-tester |

不改 `api/**`、`bootstrap.ts`、`config.ts`、既有 profile/resource 语义。

## 2. Job 与 Attempt 身份

```ts
type JobStatus = 'queued' | 'running' | 'ready' | 'failed' | 'cancelled';
type AttemptStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'superseded';

type Job = {
  id: string; title: string; prompt: string; requirements: string[];
  revision: number; status: JobStatus;
  sourceChatId: string; executionChatId: string | null; currentAttemptId: string | null;
  result: string | null; artifactId: string | null; error: string | null;
  createdAt: number; updatedAt: number;
};
type Attempt = {
  id: string; jobId: string; revision: number; status: AttemptStatus;
  taskId: string | null; conversationId: string; artifactId: string | null;
  result: string | null; error: string | null; startedAt: number; endedAt: number | null;
};
```

规则：

- **Job 是用户看到的工作；Attempt 是一次执行尝试**。新修订/重试创建新 attemptId；恢复沿用同一 attemptId 与同一 Durable task。
- 一个 Job 同时最多一个 current attempt；旧 attempt 结果只能审计，**不得覆盖新 revision 的 Job**。
- 修订必须带 `expectedRevision`；不匹配 `REVISION_MISMATCH`。取消可从 queued/running/ready/failed 发起；取消只把 queued/running 的 current Attempt 改为 cancelled，**completed/failed 的 Attempt 保持原状态与 result/artifactId**（Job 变 cancelled 但仍保留 result/artifactId 供审计）。终态 cancelled 不可再修订。
- 所有命令带 requestId；收据键 `${command}:${jobId}:${requestId}`（start 用 `${sourceChatId}:${requestId}`），同键同指纹返回首次结果、异指纹 `IDEMPOTENCY_CONFLICT`；不同 command 的同一 requestId 互不冲突。
- Job 完成前必须具备至少一个 **sealed artifact**；没有产物不算 ready（`ARTIFACT_REQUIRED`）。结果文本写入 Job/Attempt 与 artifact 引用，同一 commit。

## 3. 命令与任务

`runtime.jobs`：

```ts
start({requestId, title, prompt, requirements?, sourceChatId}) -> {jobId, revision, attemptId}
amend({requestId, jobId, expectedRevision, prompt?, requirements?}) -> {jobId, revision, attemptId}
cancel({requestId, jobId, expectedRevision}) -> {jobId, status}
get(jobId) -> Job | undefined
attempts(jobId) -> Attempt[]
artifact(artifactId) -> {artifact, verified: boolean, reason?} | undefined
```

`start` 事务（一个 commit）：收据 + Job(queued) + Attempt(queued) + execution conversation + `point.job-execution` 映射 + `point.job.attempt` task。execution conversation 配置 model、context extension、job tools extension，tools 数组包含 `save_artifact`。

`amend` 事务（一个 commit）：收据 + Job revision+1 / status queued / currentAttemptId 新 + 新 Attempt + 新 execution conversation + 映射 + 新 task；旧 attempt 标记 superseded。commit **之后** `abortTask(oldTaskId)`，不撤销已发生外部动作。

`cancel` 事务：收据 + Job cancelled + current Attempt cancelled；commit 之后 abort task。

`point.job.attempt` task（version 1，background，conversation-owned）：

1. 读 Job/Attempt：cancelled、非 current、revision 不匹配 → terminal cancelled/superseded。
2. 置 Job running / Attempt running；把 `[POINT_JOB]` 任务 JSON（title/prompt/requirements/revision/artifactId 要求）提交到 execution conversation，requestId=`point-job:${attemptId}`。
3. 等 submission。answered → 读 assistant 文本；读取 Attempt 的 sealed artifact；revision fence 通过则同一 commit 写 Job.ready + Attempt.completed + result + artifactId；否则 Attempt superseded，不覆盖 Job。
4. unanswered/failed → Attempt failed；若仍 current 且 Job 非 cancelled，同一 commit Job.failed。
5. abort → Attempt cancelled（不伪造 Job 完成）。
6. 恢复沿用同 task/attempt；submission requestId 稳定；模型 guard 的 unknown 不重放。

## 4. 产物与工具

Artifact：`{id, jobId, attemptId, revision, name, path, sha256, bytes, state: 'writing'|'sealed'|'unknown'|'failed', createdAt, sealedAt?}`。

- 文件名只允许 `[A-Za-z0-9._-]{1,64}`，禁止路径分隔/`..`；内容 UTF-8，最大 256 KiB。
- 路径：`<dataDir>/workspace/jobs/<jobId>/<attemptId>/<sanitized artifactId>/<name>`；artifactId=`${attemptId}:${callId}`，`sanitized artifactId` = 非 `[A-Za-z0-9._-]` 字符替换为 `_`、截断 200 字符、追加 `-` + artifactId sha256 前 12 位十六进制；这样同名不同 callId 也不互相覆盖。写入先 tmp（同目录、0600）→ fsync → rename。
- 工具 `save_artifact({name, content})`：
  - 只允许 execution conversation；通过 `point.job-execution` 映射找到 Job/Attempt；校验当前 revision/状态，否则拒绝。
  - 先 commit Artifact(writing, sha256, bytes, path)；写文件；再 commit Artifact(sealed, sealedAt)；写失败则 failed。
  - artifactId=`<attemptId>:<callId>`；同 id 同 hash 幂等返回；异 hash `ARTIFACT_CONFLICT`。
  - 返回 `{artifactId, path, sha256, bytes}`。
- `verifyArtifact`：读文件、重算 sha256、比对 doc；不一致/缺失 → `{verified:false, reason}`；不删除证据。
- 半成品/孤儿：只有 sealed 且 hash 可核对的 artifact 才能让 Job ready；writing/unknown/failed 不得算成功。孤儿文件由后续 WP 清理，本轮 `verify` 可发现。

## 5. 失败矩阵（必须测）

1. 新修订创建新 attemptId；旧 attempt 结果不覆盖新 revision；旧 attempt 标 superseded。
2. 恢复沿用同一 attemptId/task，不重复模型调用；模型 unknown 不重放。
3. 取消传播到 attempt task；取消后不再产生 ready/artifact 成功；已发生的外部写不被伪装撤销。
4. 工具：正常写入 + sealed + hash 核对；重复调用幂等；路径穿越/超限/非 execution 会话拒绝；writing 状态不算成功。
5. `expectedRevision` 不匹配拒绝；同键重放返回首次结果；异指纹冲突。
6. 崩溃窗口：task 创建后、模型返回 commit 前、artifact 写后 doc 前、结果 commit 前；用 child-process SIGKILL fixture 覆盖至少模型恢复与 artifact writing 不被当成功。
7. 既有 102 项不回归。

已知行为：优雅 close 中断 in-flight 模型调用后，带绑定重启会保守呈现 `failed SUBMISSION_UNANSWERED`、供应商 0 重放；read-only 重开在没有 resume 时可能短暂看到 running。取消不撤销已发生的外部写；artifact 文件与文档非同一事务，writing 崩溃窗口由 fixture 覆盖，孤儿文件留给后续清理 WP。

## 6. 完成判据

- `npm run check`、`npm test` 全绿；新增 job/artifact 测试可独立运行；至少一个 SIGKILL fixture。
- 独立 reviewer 通过（无未解决 blocker）。
- `verification-status`、`apps/server/README`、evidence、OpenSpec 同步；未验证项明确（真实模型质量、真实外部工具、通知/计划、HTTP、Docker）。
