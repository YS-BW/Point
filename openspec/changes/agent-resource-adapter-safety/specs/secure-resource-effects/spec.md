# Spec Delta

## Purpose

为资源外部副作用提供可持久审计、可取消、可恢复且不会把过期控制权误派发到真实系统的安全执行契约。

## ADDED Requirements

### Requirement: Operation effect is immutable and bound to its intent
A resource operation MUST persist a registered effect kind, canonical JSON payload, payload hash, owner, control epoch, and idempotency fingerprint before any external dispatch.

#### Scenario: Same operation cannot change effect
- **WHEN** an existing operation or request key is reused with a different kind or payload
- **THEN** the command is rejected with an idempotency conflict and no external effect is invoked

#### Scenario: Non-JSON or oversized payload is rejected
- **WHEN** an effect payload is not bounded canonical JSON for its registered kind
- **THEN** beginOperation fails without writing an intent

### Requirement: Dispatch is fenced by live ownership
A dispatch MUST verify owner identity, unexpired lease, control epoch, operation state, and attempt token in the same CAS boundary immediately before invocation.

#### Scenario: Expired or released lease
- **WHEN** a lease is expired, released, or owned by another principal before dispatch
- **THEN** the operation becomes failed with a structured stale-control error and the effect is not invoked

#### Scenario: Live lease dispatch
- **WHEN** owner, lease expiry, epoch, and attempt token all match
- **THEN** exactly one worker may enter the external invocation

### Requirement: Attempts are recoverable without concurrent false unknown
An active attempt MUST record a worker token, start time, and deadline; a concurrent caller MUST not convert a live attempt to unknown.

#### Scenario: Concurrent run
- **WHEN** a second worker sees an attempt whose token is live and deadline has not expired
- **THEN** it returns IN_PROGRESS and leaves the attempt unchanged

#### Scenario: Dead attempt recovery
- **WHEN** a worker token is proven dead or its deadline has expired
- **THEN** an explicit recovery command may mark the attempt unknown, and the original token cannot settle it

### Requirement: Unknown reconciliation is evidence-bound
Unknown reconciliation MUST authenticate an observer and validate operation epoch, payload hash, evidence schema, redaction, and size before changing status.

#### Scenario: Valid file evidence
- **WHEN** an authorized observer presents matching file hash/bytes evidence for the operation payload
- **THEN** the operation may transition from unknown to done in one CAS commit

#### Scenario: Forged or stale evidence
- **WHEN** an observer, epoch, payload hash, or evidence schema does not match
- **THEN** reconciliation is rejected and the unknown operation remains unchanged

### Requirement: External effects are cancellable and bounded
Every effect invocation MUST receive an AbortSignal and deadline; timeout or cancellation is recorded as unknown unless a deterministic pre-dispatch failure is proven.

#### Scenario: Deadline
- **WHEN** an external call reaches its deadline
- **THEN** its signal is aborted, the operation is settled unknown, and it is not automatically replayed
