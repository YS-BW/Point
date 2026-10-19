# WP5 AG-UI 投影最终复核（final）

> 2026-10-19。对象：`wp/5-agui-projection`，HEAD **`b5e1211`**（fix: reject DOM dot references），父 `e8daa27`，基线 `44c657c`/main `3f0ae3d`。
> 评审人：code-auditor。只读复核；仅写本文件，未改源码/测试。worktree clean。
> **结论：WP5 审计通过（无残留 blocker）**，可合并 main / 宣布 G2。§5 为不影响本次放行的非阻塞/未验证项。

## 1. 验证

| 项目 | 结果 |
|---|---|
| 隔离构建（`/tmp/point-wp5c`） | BUILD_OK |
| `node --test agui.test.js` | **13/13 pass** |
| 服务端全量隔离构建 | **305/305 pass** |
| `scripts/*.test.mjs` | **11/11 pass** |
| `tsc --noEmit` / `check-boundaries.mjs` | exit 0 / passed |
| 作者自测声明 | 316/316（305 server + 11 scripts，与本次隔离复跑一致） |

## 2. B1（LIFO）无回归（通过）

用上一轮独立探针（真实 `createHttp` + fake `AgentRunPort`）复跑：

- 旧序列 `step_start(turn-1) → message_start(m-1) → tool_start(c-1) → run_end(cancelled)`：
  `TOOL_CALL_END(c-1) → TEXT_MESSAGE_END(m-1) → STEP_FINISHED(turn-1) → RUN_FINISHED` ✅
- 嵌套 tool：`TOOL_CALL_END(p/n) → TOOL_CALL_END(p) → TEXT_MESSAGE_END → STEP_FINISHED` ✅
- 多 step：`STEP_FINISHED(turn-2) → STEP_FINISHED(turn-1)` ✅
- 自然结束 success：每类 END 恰好 1 次（`end:1, toolEnd:1, stepEnd:1`），无重复关闭 ✅
- 代码仍为单一 `open[]` 栈（`api/agui/projection.ts:88-99`），`finish`/`error` 复用；无回归。

## 3. point.ui 最终加固（通过）

独立探针（`/tmp/point-wp5c`）：

| 输入 | 结果 |
|---|---|
| `document.cookie` / `window.location.href` / `document . cookie` | **REJECTED**（`ui.ts:24-25,47-48` 归一化后 DOM_REFERENCE） |
| `onerror=alert(1)` / `alert(1)` | REJECTED |
| `java\nscript:` / `data:` / `vbscript:` | REJECTED |
| `{"__proto__":...}` / `constructor` / `prototype` key | REJECTED |
| 非白名单组件（`point.unknown`） | REJECTED |
| 合法 `point.placeholder` + `{title:'plain text'}` | **ACCEPTED** |
| 控制字符/超长/深度/大小 | 仍按此前规则拒绝 |

- 无 UI 状态持久化、无渲染器：`point.ui.*` 仅 `api/agui/events.ts`/`ui.ts` 类型与 validator；route/runtime 无 CUSTOM/point.ui 发射与写入；`pointUiEvent` 仅测试使用。
- 非阻塞残留：`document["cookie"]`（方括号 DOM 访问）当前未被 DOM_REFERENCE 覆盖（探针 ACCEPTED）。任务只要求 dot 形式，且当前无发射/渲染路径；建议未来启用 CUSTOM UI 前收紧（同时补 `document[...]` 拒绝测试）。

## 4. 前轮已通过项（本轮未改，复核仍成立）

- **分层**：AG-UI wire 只在 `api/agui/**`；`application/agent-stream.ts` 零 import；runtime 只用 pi-durable 公开 API + 中性类型；application/domain 无 SDK/AG-UI 依赖。
- **cli.ts lane**：`check-boundaries.mjs:15,28-31` 显式 cli lane 且只允许 `node:`；相对/pi-durable/@ag-ui import 均拒；runtime→api、api/domain→SDK、未注册 lane 规则未放宽；scripts 11/11。
- **传输级失败 vs SSE**：README/design/spec 已一致声明；探针缺 key/坏 JSON/无 auth/GET/无 agent → WP4 JSON 4xx/5xx 无 SSE；受理后坏输入 → 200 SSE 首帧 RUN_ERROR。
- **秘密**：RUN_ERROR 500 固定 internal error，含路径/token 的异常不泄漏；访问日志白名单无 token/body。
- **无第二事实/无新依赖**：runtime 不写 run/stream 状态；b5e1211 仅改 `ui.ts` + 测试；package 无新依赖。
- **lifecycle 404→405**：路由表新增 POST /v1/agent 的正确结果，`/v1/unknown`→404 保留，未削弱契约。

## 5. 非阻塞 / 未验证（不影响本次通过/G2）

- `document["cookie"]` 等方括号 DOM 访问未覆盖（无发射路径）。
- 重复 end 事件可能导致重复 END（SDK 正常不重复；建议后续做“存在才关闭”或测试）。
- 多客户端/follow-up run 隔离、真实 provider 逐 token/断线重连、SSE 反代缓冲/背压、`Last-Event-ID`/interrupt-resume、usage 与 provider 账单对账仍未验证（README 已列）。
- `response` 未安装 `error` 监听；半开/EPIPE 无显式测试。
- point.ui 仍为占位契约，未来启用 CUSTOM UI 前需进一步收紧（方括号/更多 DOM 形式）并补测试。

## 6. 结论

**WP5 审计通过（无残留 blocker）。** 最后一个 blocker（point.ui 未拒绝 `document.`/`window.`）已在 `b5e1211` 修复，独立探针确认全部要求的拒绝项与合法接受项；B1 LIFO 无回归；分层、boundaries、传输/SSE 文档与行为、秘密、无第二事实/新依赖均保持通过。可以合并 main 并宣布 G2。
