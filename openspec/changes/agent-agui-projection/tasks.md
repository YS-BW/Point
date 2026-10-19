# Tasks

## 1. Capability check and contract freeze

- [x] 1.1 Inspect `@earendil-works/pi-durable@1.3.0` / `@earendil-works/chord` public streaming, commit-subscription and task-progress APIs; record which AG-UI event families can be projected truthfully (text delta vs whole message, tool call args, step boundaries, usage) and which must be omitted rather than faked. Publish the conclusion in `design.md` before implementing the projection.
- [x] 1.2 Freeze `POST /v1/agent` input/output: `RunAgentInput` accepted fields, `threadId`/`runId` identity, header/auth reuse, SSE frame shape, `protocolVersion`, and the first/last-frame rules. Document it in the OpenSpec spec and `apps/server/README.md`.

## 2. Run lifecycle and projection

- [x] 2.1 Implement the SSE endpoint with strict framing, `Cache-Control: no-store`, auth reuse, access-log entry/exit records, and client-disconnect handling.
- [x] 2.2 Project the run: `RUN_STARTED` first, then text/step/tool-call events per the frozen capability set, then `RUN_FINISHED` with an `outcome` object (standard `usage` omitted until per-run attribution is reliable) or `RUN_ERROR` with a fixed message.
- [x] 2.3 Implement cancellation: close open entities, end with `outcome: cancelled`, never a silent disconnect; verify the documented `stop` command path still works.

## 3. Tolerance, errors and reserved UI namespace

- [x] 3.1 Enforce AG-UI compatibility rules: unknown event types/fields ignored or stripped; invalid values for known fields fail closed with `RUN_ERROR`; truncated streams never emit `RUN_FINISHED`.
- [x] 3.2 Reserve `point.ui.*` CUSTOM namespace with a bounded declarative payload contract (component name + bounded props + optional artifact reference) and an explicit prohibition on HTML/JS/DOM in events or Durable. Contract only, no renderer.

## 4. Client interop and verification

- [x] 4.1 Prove official-client interop with the dev-dependency `@ag-ui/client` `HttpAgent` in contract tests; no reference CLI is required (first product client is Web, WP13).
- [x] 4.2 Add AG-UI contract tests: first frame is RUN_STARTED (or RUN_ERROR), truncated stream does not fake FINISHED, unknown event tolerated, cancelled closes entities, official terminal `outcome` objects (no unattributed `usage`), bounded MESSAGES_SNAPSHOT, SSE frame exactly one JSON per data line.
- [x] 4.3 Run `npm run check`, full `npm test`, targeted AG-UI tests, and prototype `POINT_CRASH_ROUNDS=1 npm test`; update docs and record evidence with unverified items.

## 5. Owner-approved SDK compatibility correction

- [x] 5.1 Lock official SDKs, validate emitted events, correct outcome/usage and consume with HttpAgent; keep engine isolated.
- [x] 5.2 Fix cross-run message identity and reconcile completed drafts with Durable history; detect truncation and observation failures without cancelling execution.
- [x] 5.3 Add official-client consecutive-dialogue, retry/disconnect and malformed/truncated official-client regressions; run root and prototype checks, append evidence and synchronize current status.
