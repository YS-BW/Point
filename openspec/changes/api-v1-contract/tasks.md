# Tasks

## 1. Transport skeleton

- [x] 1.1 Add the `/v1` router with requestId, JSON envelope, 404/405 with `Allow`, and one-line JSON access logging that never records credentials or bodies. Verify routing/method/log-redaction tests.
- [x] 1.2 Enforce `Content-Type: application/json`, strict JSON parse, and a 1 MiB body limit returning 413 without buffering the whole body. Verify 400/413 tests.
- [x] 1.3 Implement Bearer auth with constant-time comparison and fail-closed 503 `API_NOT_CONFIGURED` when `POINT_API_TOKEN` is absent; keep `/health/*` open. Verify auth matrix.

## 2. v1 endpoints (thin adapters over existing commands)

- [x] 2.1 Chat endpoints: create/get chat, send/stop/compact message, command status, history pagination.
- [x] 2.2 Profile endpoints: remember/forget/list/export markdown.
- [x] 2.3 Job endpoints: start/amend/cancel/get/attempts/artifact.
- [x] 2.4 Follow-up and delivery endpoints: schedule/cancel/get/occurrences/decisions/deliveries, delivery get.
- [x] 2.5 Gated `/inspect` read-only diagnostics (counts + version only, default 404 when disabled).（实现：返回 version/instanceId/phase/capabilities；Durable 计数留 WP6 读模型。）

## 3. Idempotency and error contract

- [x] 3.1 Require `Idempotency-Key` on every write; map it to the command requestId; replay returns byte-identical output; conflicting payload returns 409.
- [x] 3.2 Freeze the status/code mapping table and cover 400/404/409/413/503 in contract tests, including unknown-error 500 with a fixed message.

## 4. Verification and docs

- [x] 4.1 Update `apps/server/README.md` and OpenSpec spec with the frozen `/v1` shape, env vars, and non-goals.
- [ ] 4.2 Run `npm run check`, `npm test`, targeted API contract tests, and prototype `POINT_CRASH_ROUNDS=1 npm test`; record evidence and unverified items.
