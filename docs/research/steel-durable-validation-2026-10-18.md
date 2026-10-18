# Steel × Pi Durable 原型接入验证

日期：2026-10-18。原型：`infra/pi-durable-validation/`。Pi Durable / pi-ai / Chord 均为 1.3.0；CDP 客户端为 puppeteer-core 25.14.0。实测使用用户本机现有 Docker Steel 0.5.3，API 为 `http://127.0.0.1:3000/v1`，未替换或重启 Steel 容器。

## 实现与边界

浏览器作为 `point.browser` 扩展加入主会话、主题侧聊和后台执行会话，沿用 Durable 的模型请求、工具循环、原生上下文和压缩。没有另写一个浏览器 Agent loop。

`src/steel.mjs` 通过 REST 管理 session，通过 CDP 观察和操作具体页面。`src/browser.mjs` 管理会话归属、预留 session ID、动作日志、人工接管、登录检查点与持久清理租约。CLI 显示实际页面的观看链接并提供接管命令。未启用 Steel 参数时不向模型注册浏览器工具。

官方 [Steel CLI 文档](https://docs.steel.dev/overview/steel-cli) 与下载到的 CLI 0.4.4 功能存在差异：实查该版本帮助和 [官方仓库发布源码](https://github.com/steel-dev/cli)，没有连接指定既有 CDP session 的入口，start 会新建 session。因此没有把 CLI start 作为恢复协议，改用 REST + CDP。CLI 未安装到全局，也不是运行时依赖。预留 ID 的做法对应官方 [session lifecycle](https://docs.steel.dev/overview/sessions-api/session-lifecycle) 的会话标识机制。

每个浏览器记录属于一个具体 conversation；后台工作与所属主题分别管理句柄。页面使用单独创建的 Chromium BrowserContext，重启按 context ID/page ID 重连，不使用 Steel 默认共享上下文。新弹出页面也只在该上下文中选择。当前本地 Steel 只维护一个活动 session，适配器容量明确设为 1；被其他任务或外部客户端占用时返回 busy。

观察返回文本、最多 100 个交互元素与新的 snapshotId/ref；动作只能引用当前快照。每次启动后内存引用重置。工具支持打开、观察、点击/填入/选择/按键/滚动、截图、核销、接管和关闭，目前元素观察不含 iframe。

## 恢复契约

1. **创建 session**：先在 Durable 状态预留 UUID，再请求 Steel 创建。创建成功但应用进程中断时，恢复复用相同 ID。
2. **保留远端页面**：应用进程停止只断开 CDP，不主动关闭 Chromium。重启优先重新连接原 session 和原页面。
3. **远端 session 失效**：再次打开时可从命名配置恢复 cookies、localStorage 和最后 URL。不是恢复完整页面内存或任意网站业务状态。
4. **动作结果不明**：执行前保存 running 记录，恢复将未完成记录转为 unknown；先观察，再给出可见证据核销。`browser_act` 声明为 unsafe，不能承诺任意点击恰好发生一次。
5. **人工接管**：默认观看链接只读。take/handoff 切换为可操作链接，同时阻止模型动作；用户 resume 后获取新快照。resume 不自动生成下一轮对话，用户需发消息继续。
6. **清理**：Durable lease 默认每 3 秒检查；空闲默认 2 分钟，接管 10 分钟，总时限 30 分钟。任务结束/取消也触发清理。应用完全离线时租约不运行，重启后补做。

本地 Steel 0.5.3 的 context API 实测可返回旧会话缓存，release/context 路由也没有可靠使用传入 ID。本适配器读取任务专属 CDP BrowserContext 的 cookies 和 localStorage；释放前检查活动 session ID。自身操作串行执行，但无法阻止任意外部客户端在检查与请求之间更换 session，不应把它视为多租户隔离服务。

只有显式命名 profile 才保存登录检查点。文件存于数据目录下 `browser-contexts/`，目录初始权限 0700、文件 0600；公开状态与共享记忆仅保留配置名称和检查点时间，不注入 cookie 内容。保存范围不包含 IndexedDB、sessionStorage、页面内存等。忘记配置会删除其保存文件，当前登录仍受远端网站自身会话规则约束。

## 实测证据

执行 `npm run check`、`npm test` 和 `npm run test:steel`。语法检查覆盖 21 个模块，原有离线套件 26/26 通过，包含 70 次既有关键窗口强杀。Steel 使用真实 Docker 浏览器、本地独立表单服务器和各场景独立 Durable 数据目录。

| 真实 Steel 场景 | 结果 |
|---|---|
| 表单填写/保存、截图、旧引用拒绝、重复请求去重、主题占用检查、接管/恢复 | 通过 |
| 服务强杀后连接原 session；远端过期后恢复 cookies/localStorage；忘记配置 | 通过 |
| session 创建后、状态确认前强杀 | 使用预留 ID 接回，没有另建 session |
| 真实保存生效后、动作结果落盘前强杀 | 观察到已保存，核销后实际保存次数为 1 |
| 服务离线期间空闲超期、重启补清理；取消拥有浏览器的后台任务 | 通过 |
| DeepSeek Flash high：自然语言打开网页、填写 Note、保存、核对、关闭 | 实际工具循环完成，表单效果 1 次 |

以上分为 5 组自动验收，详细条目见 `runtime/steel-results.json` 与各 `runtime/tests-时间/steel-results.json`。真实模型没有收到固定工具调用脚本，实际调用链为 `browser_open → browser_act(fill) → browser_act(click) → browser_close`，以动作返回的新页面快照核对 Saved 文本。

这验证了浏览器扩展与 Durable 的组合、恢复边界和一条真实模型执行链路。尚未覆盖数天运行、复杂登录/MFA、iframe、多标签复杂工作流、任意网站提交结果核对及 Steel Cloud；不能据此宣称通用浏览器任务已全面验收。

启动参数与交互命令见 [原型 README](../../infra/pi-durable-validation/README.md)。正式 Point server 的 SDK 选型保持原状。
