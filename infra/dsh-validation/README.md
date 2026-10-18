# DSH SDK 独立验证

这是历史候选运行时的验证工程，不是 Point Server。2026-10-18 起，正式设计采用 Pi Durable + Steel，见[设计总览](../../docs/design/README.md)；后续实现基于 [Durable 原型](../pi-durable-validation/README.md)。本实验保留作对照，不作为第二套生产执行引擎。

详细结论见 [验证报告](../../docs/research/dsh-sdk-validation-2026-10-17.md)。

## 运行

需要 Node.js 22.19+。在本目录执行：

```sh
npm ci
npm run smoke
npm run verify
npm run crash
```

这些命令会真实调用 DeepSeek API，产生少量费用。凭据优先读取 `DEEPSEEK_API_KEY`，未设置时读取现有 `server/.pi/agent/auth.json` 中的 `deepseek.key`；不复制、不打印密钥。没有可用凭据时执行失败，不把跳过算作通过。

- `smoke`：无界面启动、真实模型调用、关闭。
- `verify`：历史恢复、真实子 Agent 并发、取消协议探测、执行中正常关闭及恢复。
- `crash`：仅向脚本自己启动的 DSH 子进程发送 SIGKILL，观察其 shell 命令与会话恢复。用于 macOS/Linux，有 `ps` 命令；不适用于 Windows。

真实模型选择如何调用工具，因此测试设有超时和关键断言；它不是固定输出的 mock。取消接口探测会记录“不支持”，这属于验证发现，并不代表该能力通过。

产物在忽略提交的 `runtime/` 下，每轮有独立目录、会话 home 和结果 JSON。`verify` 另外保存原始事件 JSONL。每轮最多执行少量固定目录内的写文件、sleep 操作；不操作 Point 的业务数据或 Steel。`crash` 会等到原 shell 的预期结束时间之后再退出。

SDK 与运行时均锁定 `0.2.1-rc.2`，锁文件一并保留。不要将两个包分别安装为各自 `latest`：验证当日其默认标签指向不同版本。
