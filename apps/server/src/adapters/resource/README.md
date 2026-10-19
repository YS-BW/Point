# Resource boundary

WP2 在此实现外部能力端口。租约与动作三态是 domain 规则，Durable 资源协议负责持久阶段（intent / attempting / done / unknown / failed），adapter 只执行或观察一次外部调用。

通用约束：

- 接口必须携带 resourceId、owner、controlEpoch、operationId；unknown 只允许 observe/reconcile，**禁止自动重放**。
- 能力必须经闭集 registry 注册（`openRuntime` 的 `{resources: {effects}}`），调用方不能替换 payload 或执行效果；未注册 kind 返回 `EFFECT_NOT_REGISTERED`。
- adapter 不另建队列/第二事实来源；Durable operation 是唯一事实。
- 外部端点必须显式配置；缺省配置 fail-closed。

## File capability (`files.ts`)

硬化后的本地文件 capability，kind = `file.write`。显式 factory：

```ts
const effect = await createFileResourceEffect(rootDir);        // 组合根注入
const runtime = await openRuntime(dataDir, binding, {
  resources: {effects: createEffectRegistry([effect])},
});
const files = await createFileResourceAdapter(rootDir, runtime.resources); // 高层 API
```

`rootDir` 必须是已存在的绝对目录。缺失、相对路径或不可用 root 一律 fail-closed（`FILE_ROOT_REQUIRED` / `FILE_ROOT_UNAVAILABLE`），不会隐式创建 root、不会使用 cwd、不会回退到进程可写的任意位置。root 在构造时 `realpath` 固定，调用方路径只能是相对路径。

### Payload / result / evidence

| 项 | 形状 | 上限 |
|---|---|---|
| payload | `{path, content, sha256, bytes}`（canonical JSON 由应用层计算 payloadHash） | content ≤ 256 KiB（`MAX_FILE_BYTES`），payload ≤ 260 KiB |
| result | `{path, sha256, bytes}` | 4 KiB |
| evidence | `{kind:'file', path, exists, regular, sha256, bytes}` | 4 KiB；全局 8 KiB 上限 |

- `path`：相对路径，拒绝绝对路径、`..`、反斜杠、NUL/控制字符、超长段/路径；不允许凭据进入 payload/evidence。
- `sha256`（payload 内）是 content 的 UTF-8 SHA-256，`bytes` 是 UTF-8 字节数；两者必须与实际内容一致，否则 `PAYLOAD_REJECTED`，不写 intent。
- 大内容/截图等必须作为 Artifact 引用，不得塞进 payload。
- result 只在文件已落盘且读回校验通过后才可能为 `done`；非法 result 会转为 `unknown`（effect 可能已发生）。

### 路径与写入硬化

- 每次操作都逐级 `lstat` 父路径组件：`..`、symlink 组件、非目录组件直接拒绝；创建目录后用 `realpath` 复核父目录仍等于 root 内的预期路径。
- 目标已存在时必须是普通文件：symlink 目标、目录、其它类型一律拒绝，绝不跟随。
- 写入流程：同目录临时文件 `O_CREAT|O_EXCL|O_NOFOLLOW`、mode `0600` → `fstat` 确认普通文件与 0600 → 写入→`fsync(file)` → 重写后再次 `fstat` 校验 size → 最后复核父目录 canonical 与目标非 symlink → `rename` 原子替换 → `fsync(directory)` → 以 `O_NOFOLLOW` 读回重算 sha256/bytes 校验。
- 失败清理只删除临时文件，且仅在父目录仍为预期 canonical 目录时执行；不会删除/覆盖 root 外文件。
- 读取/列表/观察同样不跟随 symlink，读取有大小上限；list 不把 symlink 当作受管条目。

### 操作协议与 unknown

`write` 通过 `resources.beginOperation({effect:{kind:'file.write', payload}})` + `resources.runOperation(id)` 执行；registry 由组合根绑定，调用方不能替换，因此受 owner/lease/epoch fence、attempt token/deadline 保护：

- rename 之前的失败是确定失败（`EffectFailure('failed', code)`）：路径/symlink/权限/大小等；操作落为 `failed` 并保留稳定 code。
- rename 之后（文件可能已可见）的任何失败一律 `unknown`；不重放，只能 `files.reconcile({operationId})` 以观察核销。
- `reconcile` 只读文件、重算 sha256/bytes，生成 bounded evidence，经 `observeOperation` 核验 observer/controlEpoch/payloadHash 与 persisted payload 后才可落 `done`；观测不匹配返回 `FILE_EVIDENCE_REJECTED` 并保持 `unknown`，不会伪造成 `done` 或用伪造 evidence 结算。文件不存在、被篡改或不再是普通文件都不会伪造成 `done`。- 只有同一个 owner/epoch 才能核销；takeover 后的旧 observer 会被拒绝。

### 错误语义

| code | 含义 |
|---|---|
| `FILE_ROOT_REQUIRED` | 未提供绝对 root |
| `FILE_ROOT_UNAVAILABLE` | root 不存在/不是目录/无法 realpath |
| `FILE_INVALID_COMMAND` | 高层 API 入参不合法 |
| `FILE_PATH_REJECTED` | 相对路径非法（绝对路径/`..`/控制字符/空路径） |
| `FILE_SYMLINK_REJECTED` | 组件或目标为 symlink（写入时操作 failed，code 持久化） |
| `FILE_NOT_REGULAR` / `FILE_NOT_DIRECTORY` | 类型不符 |
| `FILE_NOT_FOUND` | 读取目标不存在 |
| `FILE_TOO_LARGE` | 超过 `MAX_FILE_BYTES` |
| `FILE_IO` / `FILE_IO_AFTER_COMMIT` | IO 失败；后者为 unknown，只能观察 |
| `FILE_EVIDENCE_REJECTED` | 试图在观测不匹配时伪造 `done` |

### 已知限制

- Node 没有 `openat`/`renameat`：check-to-rename 窗口无法做到完全原子。实现会在 rename 前紧邻地复核 canonical 父目录与目标类型，并拒绝被替换的父/目标；恶意进程若赢得最后微秒仍可能超出本 adapter 的保证（OS 级限制，README 不宣称完全免疫）。
- 只提供显式 root 内的受管文件操作；不实现删除、递归复制、文件锁或跨进程并发写协议。
- 上限与 evidence schema 是能力契约的一部分，变更需同步 `resource-adapters.md` 与本 README。
- `maxPayloadBytes`/`maxResultBytes`/`maxEvidenceBytes` 由应用层再次强制；adapter 的边界不能替代应用层校验。
- 真实多进程竞态、真实磁盘/文件系统断电行为、网络文件系统（NFS/SMB）语义未验证。
