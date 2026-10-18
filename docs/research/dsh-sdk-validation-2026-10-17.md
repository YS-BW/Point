# DeepSeek Harness SDK 接入验证

日期：2026-10-17。范围：验证 DSH 能否作为 Point 的候选 Agent 层，不改变当前 Pi SDK 选型。

## 结论

DSH 官方 TypeScript SDK 可以作为无界面运行时接入。真实模型、真实子 Agent、后台执行期间主对话继续响应、持久会话恢复均已跑通。

但官方 SDK 目前不满足“直接从 Point Server 精确取消一个任务而保留其他工作”的要求。重启恢复也只是恢复会话和中断记录，不是自动接回外部执行现场。推荐保留为候选；若决定采用，需补控制桥接与外部执行结果核查，不能仅用 `run()` 包装成 HTTP 接口后即视为集成完成。

## 环境与可复现性

- 本机 macOS，Node.js `v22.22.3`，未在 Docker 内运行。
- npm 安装官方 `@deepseek-ai/dsh-sdk-client@0.2.1-rc.2` 与 `@deepseek-ai/dsh@0.2.1-rc.2`，使用标准 `sdk` profile，没有修改 DSH 源码或增加控制插件。
- 真实 provider：`deepseek-official`；model：`deepseek-flash`；reasoning effort：`off`。未使用假模型。
- 独立 home / workspace 位于 `infra/dsh-validation/runtime/`，未改动原 Pi Server 的代码、依赖和会话。
- 对照源码 commit：`687f282e8625c6b8d11ff58211a90524be2e4317`；检出位置 `.research/repos/deepseek-harness/`。运行证据来自 npm 安装包，不是源码单元测试。
- 验证当日 SDK 的 npm `latest` 是 `0.0.1-rc.1`，运行时的 `latest` 是 `0.2.0-rc.2`；两者 `next` 均为本次测试版本。接入必须显式锁定兼容版本。
- 首次安装跳过 peer dependencies 时 SDK 无法导入协议包；正常安装 peers 后成功。因此复跑使用 `npm ci`，不要加 `--legacy-peer-deps`。

脚本和运行说明：[infra/dsh-validation](../../infra/dsh-validation/README.md)。

## 实测结果

| 场景 | 操作与观察 | 判断 |
|---|---|---|
| 无界面运行 | SDK 启动独立 DSH 进程，真实模型返回 `POINT_DSH_OK`，正常关闭 | 通过；不依赖 Web / GUI |
| 历史恢复 | 写入随机测试 token，关闭运行时，重新创建 SDK，`resumeSession(id)`，不在新问题中提供 token，模型准确回忆 | 通过 |
| 主对话与后台子 Agent 并行 | 主 Agent 调用原生 subagent；子 Agent 启动 shell sleep 30 秒及标记文件；确认长 shell job 已注册后向主 Agent发消息，约 817ms 收到 `MAIN_PONG`，此时子任务尚未结束 | 通过；此延迟只是本次样本，不是性能保证 |
| 子任务结果回传 | 等待 `session/wait`，收到 `subagent.finished`，实际存在 `child.done` | 通过 |
| 单任务取消 | 执行中请求 `session/cancel` | 不支持；实际返回 `JsonRpcResponseError`，code `-32603`，unknown method |
| 单会话关闭 | 执行中请求 `session/close` | 不支持；同上 |
| 取消请求被拒绝后的其他会话 | 主会话仍可返回 `STILL_ALIVE` | 运行时仍健康，但这不是成功取消目标任务 |
| 执行中正常关闭 | `harness.close()` 后等待超过 shell 原定完成时间，未出现 `cancel.done` | 本次固定 shell 被正常终止；不能由此保证所有工具均可撤销 |
| 正常关闭后的中断会话 | 新运行时恢复同一 session，模型能说明原任务，并从历史识别工具 aborted、完成未确认 | 通过会话恢复；未自动继续原命令 |
| 强制杀进程 | shell 已写 `crash.started` 后，对所属 DSH 进程 SIGKILL | DSH 退出，但原 shell 随后仍写出 `crash.done` |
| 强杀后恢复 | 新 SDK 恢复 session；不发送新任务，等过原命令时长；之后要求模型仅根据历史判断 | 恢复成功，但历史记录没有成功结果；模型准确表示完成状态未知 |

并发测试运行两次：首次确认子 Agent 活跃期间主会话可回复；第二次收紧条件，等待长 shell job 注册后才发主会话消息。报告中的 817ms 来自第二次。

强杀实验说明“运行时没有确认结果”与“外部命令没有执行”不是同一回事。此结论针对本机进程终止实验；Docker 整个容器停止时的进程行为、Steel 远端动作恢复均未验证。

## 对 Point 的设计影响

1. **接入方式可行。** Point Server 持有 SDK，由 SDK 管理 DSH 子进程；Point Web 消费 Server 的消息与执行事件，不必复用 DSH 自带界面。
2. **取消控制是明确缺口。** 官方协议没有 cancel / session-close。源码与扩展指南提供内部 Agent `cancel()` / activation disposal 机制，但本轮没有实现或验证自定义桥接。后续需要验证桥接能精确停止目标工作、等待资源释放且不影响主对话。另一选择是独立任务进程，但需重新验证任务间通信和清理语义。
3. **恢复必须包含外部核查。** 保存任务与运行时 session / 子 Agent / 工具执行的对应关系。遇到中断或结果未知时先核查文件、浏览器或远端状态，再决定是否继续，不能自动重放可能已发生的动作。
4. **不要把 SDK `run()` 当请求级事务。** 它观察的是一次活动区间直到 idle；主动注入、排队输入、子任务回报可以影响该区间。测试使用低层 `prompt()` + 事件流管理并发，并用 `session/wait` 等待后代工作收束。
   同样不能仅凭回复里的成功标记更新任务状态：第二轮中断恢复回复明确说结果未确认，但末尾仍复述了 `CANCEL_WORK_DONE`。执行状态应结合工具事件与实际产物判断。
5. **不能由这轮结果推断全部产品能力。** USER.md 注入与更新、Goal、Schedule 重启/错过触发、决策推送、Steel 接入、Web 接管、Docker 部署和细粒度实时文本流均未在此工程验证。未切换现有选型。

## 证据

以下路径是本地原始测试产物，已忽略提交；可用脚本生成新证据。

- `infra/dsh-validation/runtime/2026-10-17T10-47-40.692Z/results.json`：首次完整运行。
- `infra/dsh-validation/runtime/2026-10-17T10-49-08.634Z/results.json`：收紧并发前置条件后的运行；同目录 `events.jsonl` 为原始通知。
- `infra/dsh-validation/runtime/crash-1792234138183/results.json`：强杀与恢复实验；同目录 `crash.done` 为外部命令完成证据。

官方接口依据：

- [TypeScript SDK](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/client/README.md)
- [SDK 协议与取消限制](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/sdk/protocol/README.md)
- [协议驱动与插件扩展](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/cookbook/extension-cookbook.md)
