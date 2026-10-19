# Spec Delta

## Purpose

为客户端与后续 AG-UI 投影提供稳定、可版本化、失败可判定的 HTTP 契约：所有失败都有稳定 code，所有写操作天然幂等，凭据不进入日志，诊断端点默认关闭。

## ADDED Requirements

### Requirement: Every response is a versioned JSON envelope
`/v1` responses MUST be JSON with a fixed shape and MUST reject unsupported methods and unknown paths with stable codes.

#### Scenario: Unknown path
- **WHEN** a client requests an unregistered path under `/v1`
- **THEN** the server returns 404 with `{error:{code:'NOT_FOUND',...}}`

#### Scenario: Unsupported method
- **WHEN** a client uses a method a route does not support
- **THEN** the server returns 405 with an `Allow` header and a stable code

### Requirement: Errors carry stable codes, not strings
Failures MUST map domain error codes to HTTP status codes deterministically; unexpected exceptions MUST NOT leak internal messages.

#### Scenario: Invalid input
- **WHEN** a command rejects its input as invalid
- **THEN** the response is 400 with code `INVALID_COMMAND`

#### Scenario: Unknown resource
- **WHEN** a client addresses a missing chat, job, command or delivery
- **THEN** the response is 404 with the corresponding `*_NOT_FOUND` code

#### Scenario: Unexpected failure
- **WHEN** a handler throws an unexpected error
- **THEN** the response is 500 with a fixed message that contains no stack, path or credential

### Requirement: Writes are idempotent through a header key
Every write endpoint MUST require an `Idempotency-Key` header and MUST return byte-identical responses for replays of the same key and payload.

#### Scenario: Replay
- **WHEN** the same write request is sent twice with the same key and payload
- **THEN** both responses are byte-identical and the durable effect happens once

#### Scenario: Key reuse with different payload
- **WHEN** the same key is reused with a different payload
- **THEN** the response is 409 with `IDEMPOTENCY_CONFLICT` and no new effect is applied

#### Scenario: Missing key
- **WHEN** a write request omits `Idempotency-Key`
- **THEN** the response is 400 and nothing is written

### Requirement: Authentication is fail-closed
When no API token is configured `/v1` MUST refuse all requests; `/health/*` MUST remain open and MUST NOT expose sensitive data.

#### Scenario: Unconfigured token
- **WHEN** `POINT_API_TOKEN` is not configured and a client calls `/v1`
- **THEN** the response is 503 with `API_NOT_CONFIGURED`

#### Scenario: Missing or wrong bearer
- **WHEN** a configured server receives a missing or incorrect bearer token
- **THEN** the response is 401 and no command runs

### Requirement: Request size and logs are bounded and redacted
Oversized bodies MUST be rejected with 413 before buffering the whole payload, and access logs MUST NOT contain credentials or bodies.

#### Scenario: Oversized body
- **WHEN** a client sends a body larger than the configured limit
- **THEN** the server returns 413 and does not execute the command

#### Scenario: Credential redaction
- **WHEN** any authenticated request is logged
- **THEN** the log line contains method/path/status/duration/requestId only, never the Authorization value or body
