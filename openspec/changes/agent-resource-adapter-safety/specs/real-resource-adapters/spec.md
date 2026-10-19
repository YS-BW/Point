# Spec Delta

## Purpose

为本地文件、HTTP 通知和受控 CDP 浏览器资源提供真实协议适配，同时保持三态副作用、幂等键、凭据隔离和不接入浏览器 RTC 控制面的边界。

## ADDED Requirements

### Requirement: File effects are confined and atomic
A file adapter MUST canonicalize its root, reject symlink traversal, enforce regular-file checks, use exclusive mode-0600 temporary files, fsync file and directory, and verify hash/bytes on observation.

#### Scenario: Traversal or symlink
- **WHEN** a path contains `..`, a symlink component, or a symlink target replacement
- **THEN** the operation fails without reading or writing outside the canonical root

#### Scenario: Atomic write
- **WHEN** a valid write is dispatched
- **THEN** readers observe either the previous regular file or the fully sealed new file, never a partial temporary file

### Requirement: HTTP notification classifies outcomes without leaking credentials
An HTTP notification adapter MUST use an idempotency key, classify 2xx as delivered, deterministic client errors as failed, transient/network/timeout errors as unknown, redact details, reject unsafe redirects, and never place credentials in URLs or persisted results.

#### Scenario: Status classification
- **WHEN** the endpoint returns 2xx, 400/401/403/404/413/422, or 408/425/429/5xx
- **THEN** the adapter returns delivered, failed, or unknown respectively and persists no response body or secret

#### Scenario: Timeout or redirect
- **WHEN** the request times out or attempts an unsafe redirect
- **THEN** it returns unknown, aborts the request, and does not automatically replay it

### Requirement: File outbox is idempotent
A file notification outbox MUST atomically create one record per delivery id, return the original outcome for the same payload, and reject a different payload under the same id.

#### Scenario: Same delivery replay
- **WHEN** the same delivery id and canonical payload are sent twice
- **THEN** the outbox has one record and the second call does not append a duplicate

#### Scenario: Conflicting delivery
- **WHEN** the same delivery id is reused with a different payload
- **THEN** the adapter returns a deterministic idempotency conflict

### Requirement: CDP effects stay behind the resource boundary
The CDP adapter MUST support only configured loopback/protocol endpoints for navigate, evaluate, and screenshot, and MUST enforce the resource lease/epoch/effect payload contract; it MUST not implement RTC, viewer, or browser-side multi-session control.

#### Scenario: CDP disconnect
- **WHEN** the transport disconnects after intent or during an invocation
- **THEN** the operation becomes unknown and is not automatically replayed

#### Scenario: Stale browser control
- **WHEN** the resource epoch or owner is stale
- **THEN** no CDP command is sent
