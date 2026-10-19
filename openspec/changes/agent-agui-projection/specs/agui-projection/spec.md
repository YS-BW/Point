# Spec Delta

## Purpose

把一次前台运行投影为 AG-UI 1.0 事件流，使客户端（先 CLI，后 Web）能用同一套事件语义表达文本、工具、阶段、用量与取消；同时把 UI 扩展限制在声明式 `CUSTOM` 通道内，避免 UI 代码或第二事实源进入服务端。

## ADDED Requirements

### Requirement: Transport failures stay on the REST envelope

Failures before a request is accepted (auth, content type/JSON, body limit, Idempotency-Key, agent/runtime not ready, unknown path or method) MUST return the WP4 JSON error envelope and MUST NOT open an SSE stream. Only an accepted request opens `text/event-stream`, whose first event is then `RUN_STARTED` or `RUN_ERROR`.

#### Scenario: Unauthorized request
- **WHEN** a configured server receives `/v1/agent` without a valid bearer
- **THEN** it returns 401 with `{error:{code:'UNAUTHORIZED',...}}` and no SSE stream

#### Scenario: Missing Idempotency-Key
- **WHEN** `/v1/agent` is called without `Idempotency-Key`
- **THEN** it returns 400 `INVALID_COMMAND` as JSON and no run starts

### Requirement: The run stream has a mandatory boundary

`POST /v1/agent` MUST return `text/event-stream` whose first event is `RUN_STARTED` or `RUN_ERROR`, and whose normal close is `RUN_FINISHED` with an `outcome`.

#### Scenario: Successful run
- **WHEN** a client posts a valid `RunAgentInput`
- **THEN** the first SSE event is `RUN_STARTED`, and the last is `RUN_FINISHED` with `outcome: {type: success}`; standard `usage` is omitted unless accurately attributed

#### Scenario: Truncated stream
- **WHEN** the connection drops or the server closes before the run ends
- **THEN** no `RUN_FINISHED` is emitted, so the client can distinguish truncation from completion

#### Scenario: Failing run
- **WHEN** the run fails internally
- **THEN** the stream ends with `RUN_ERROR` carrying a fixed message and no stack, path or credential

### Requirement: Cancellation is explicit

Stopping a run MUST close every open entity and finish with `outcome: {type: cancelled}`, not by silently dropping the stream.

#### Scenario: User stops
- **WHEN** the client requests stop for an active run
- **THEN** open messages/steps are closed and the stream ends with `RUN_FINISHED` and `outcome: {type: cancelled}`

### Requirement: Compatibility rules are enforced

Unknown event types and unknown fields MUST be tolerated, while an invalid value in a known field MUST fail closed.

#### Scenario: Unknown event
- **WHEN** the projection would emit an event type the client does not know
- **THEN** the client tolerates it without error and the stream continues

#### Scenario: Invalid known field
- **WHEN** a known event field carries a wrongly typed or illegal value
- **THEN** the stream terminates with `RUN_ERROR`

### Requirement: The run input is a bounded AG-UI subset

`POST /v1/agent` MUST accept an AG-UI `RunAgentInput` subset: `threadId` (an existing chat id) and `messages` (the last `user` text is sent); `runId` is server-generated and client values are ignored. Unknown fields MUST be tolerated; invalid values in known fields MUST fail closed with `RUN_ERROR` and MUST NOT start a run.

#### Scenario: Unknown field tolerated
- **WHEN** a client sends `tools`, `context`, `state`, `forwardedProps` or another unknown field
- **THEN** the run proceeds and the server ignores those fields

#### Scenario: Invalid thread
- **WHEN** `threadId` is absent, non-string or not a string of digits
- **THEN** the first event is `RUN_ERROR` and no run starts

### Requirement: SSE framing is exact

Each SSE `data` line MUST contain exactly one JSON event, with no multi-event frames and no implicit `event:` semantics.

#### Scenario: One JSON per frame
- **WHEN** a client parses the stream
- **THEN** every `data:` payload parses as exactly one AG-UI event object

### Requirement: UI extensions are declarative and non-executable

`point.ui.*` CUSTOM events MAY carry a component name, bounded props and artifact references, and MUST NOT carry HTML, JavaScript, DOM or arbitrary executable content into events or Durable state. WP5 reserves the namespace as a contract only: no event is emitted and no renderer exists.

#### Scenario: Bounded contract
- **WHEN** a `point.ui.component` payload is validated
- **THEN** it has a registered component name, JSON-safe props within the documented bounds and an optional bounded artifact reference

#### Scenario: Component reference
- **WHEN** the server wants the client to render a known component
- **THEN** it emits a `point.ui.*` CUSTOM event with a registered component name and bounded props only

#### Scenario: Executable content refused
- **WHEN** a UI payload would contain HTML, script or unbounded data
- **THEN** it is rejected and nothing is persisted

### Requirement: Official client interoperability

The edge MUST use pinned official SDK schemas and encoding. The reference CLI MUST use HttpAgent and reject malformed or truncated streams. Live provisional message IDs MUST be unique across runs; completed history MUST use stable Durable identities and replace provisional messages through an authoritative snapshot.

#### Scenario: Consecutive dialogue
- **WHEN** an official client completes two requests on the same thread
- **THEN** both replies remain distinct and its final messages match Durable history without duplicate drafts

#### Scenario: EOF without terminal event
- **WHEN** a stream ends before RUN_FINISHED or RUN_ERROR
- **THEN** the CLI exits nonzero and does not claim that the underlying task failed or completed
