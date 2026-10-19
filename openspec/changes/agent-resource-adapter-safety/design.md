# Design

## Context

See `proposal.md` and the P0 contract in `docs/design/resource-adapters.md`. The current Durable store is correct for version-1 resource documents, but the application port accepts an arbitrary effect callback after intent. Real adapters must not use that callback as a substitute for a persisted capability effect.

## Goals / Non-Goals

**Goals:**

- Make a persisted operation self-describing, bounded, and tied to owner/lease/epoch and an attempt token.
- Make dispatch/recovery/reconcile explicit CAS operations with abort/deadline handling.
- Provide hardened local file, HTTP notification, file-outbox, and loopback CDP implementations.
- Preserve the single Durable execution engine and no-second-facts rule.

**Non-Goals:**

- Migrating existing version-1 resource documents in this change.
- Building HTTP/AG-UI endpoints, Steel deployment, RTC, viewer, or browser-side multi-session control.
- Claiming exactly-once delivery for providers without an observation/query API.

## Decisions

1. **Registry of capability kinds, not caller callbacks.** A runtime-owned registry maps a closed `kind` to an adapter. `beginOperation` stores canonical payload/hash; `runOperation` looks up the stored kind and never accepts a replacement payload. This prevents post-crash action substitution. A callback-only compatibility helper remains memory-test-only and cannot be wired by `openRuntime`.
2. **Fence before invoke and token-CAS after invoke.** Admission writes attempting plus token only after a live owner/lease/epoch check. The effect receives an AbortSignal/deadline. Settlement includes the token and fails closed if another recovery won the CAS.
3. **Explicit recovery, not heuristic concurrent unknown.** A live attempt returns `IN_PROGRESS`; only a token with expired deadline or explicit recovery proof may move it to unknown. This trades faster crash recovery for truthful audit state.
4. **Evidence is capability-specific.** File evidence is `{kind:'file',sha256,bytes}`, HTTP evidence is status/provider id without body, and CDP evidence is a bounded observation hash. Canonical JSON and maximum sizes are enforced before Durable commit. Screenshots and large responses use artifact references.
5. **No new dependencies.** Files use Node fs APIs; HTTP uses built-in `fetch`; CDP uses Node 22 WebSocket with an injectable transport in tests. This avoids a second execution engine and keeps protocol tests deterministic.
6. **No implicit production endpoints.** Composition requires explicit file root, notification URL, or CDP endpoint. Absent configuration is fail-closed; test endpoints are loopback only.

## Risks / Trade-offs

- [Risk] Version-1 documents cannot represent effects → reject them as incompatible rather than silently migrate or infer payload.
- [Risk] A remote provider can succeed while the process dies before settlement → retain unknown and expose provider-specific observation only; never auto-replay.
- [Risk] Symlink replacement races remain OS-dependent → use directory handles/realpath checks and reject suspicious replacement; test adversarial parent/target swaps.
- [Risk] CDP transport behavior differs between Steel releases → test protocol frames against a fake transport and keep Steel integration outside this change.
- [Risk] HTTP 429/5xx may be retryable but automatic replay is forbidden → return unknown and leave retry policy to an explicit operator/recovery command.

## Migration Plan

1. Land durable persistence separately (already verified) and add versioned effect document schema.
2. Reject old version-1 operation documents with a clear incompatibility error; take the required SQLite backup before any future migration WP.
3. Enable adapters one capability at a time behind explicit composition options; absent options remain fail-closed.
4. Roll back by disabling adapter options; do not replay unknown operations during rollback.

## Open Questions

None that can be safely deferred without changing the contract or task breakdown.
