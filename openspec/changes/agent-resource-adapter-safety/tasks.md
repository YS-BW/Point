# Tasks

## 1. Secure resource effect protocol

- [x] 1.1 Extend resource domain/storage documents with registered effect kind, canonical bounded payload/hash, owner, attempt token/start/deadline, evidence and structured result limits; reject version-1 operation documents rather than inferring an effect. Verify domain/application purity and JSON-boundary tests.
- [x] 1.2 Replace real-runtime callback dispatch with an effect registry and abort/deadline-aware port; enforce live owner + unexpired lease + epoch + token fence in one CAS boundary, return IN_PROGRESS for live attempts, and make recovery/reconcile observer/evidence/payloadHash-bound. Verify lease-expiry, release, stale owner, concurrent attempt, timeout, unknown and forged-evidence tests.
- [x] 1.3 Persist and reopen the new operation fields atomically with resource/index/receipt; add SIGKILL windows for intent/attempting/recovery and prove no automatic replay. Verify `resource-secure.test.ts`, `npm run check`, and targeted tests.
- [x] 1.4 Update `docs/design/resource-boundary.md`, `docs/design/resource-adapters.md`, and runtime README with the frozen protocol, migration rejection, error codes, and explicit non-goals; verify links and OpenSpec strict validation.

## 2. Hardened file resource adapter

- [x] 2.1 Implement the registered file capability with canonical root, realpath parent checks, symlink rejection, O_NOFOLLOW/O_EXCL mode-0600 temp writes, regular-file checks, fsync file+directory, atomic rename, bounded payload/evidence, and hash/bytes observation. Verify traversal, symlink, TOCTOU, atomicity and restart tests.
- [x] 2.2 Wire file capability through explicit runtime options only (no implicit filesystem/network side effect) and document root/permission/error semantics. Verify absent configuration is fail-closed and composition tests pass.

## 3. Notification adapters

- [x] 3.1 Extend the notification port with redacted structured outcome (`outcome/code/status/detail`) and implement HTTP classification, AbortSignal timeout, manual/error redirect, HTTPS/explicit URL policy, token header isolation, and Idempotency-Key. Verify local loopback 2xx/400/401/403/404/413/422/408/425/429/5xx/timeout/redirect cases with no secret persistence.
- [x] 3.2 Implement atomic file-outbox notification with one canonical record per delivery id, replay/conflict handling and observation limits; wire only via explicit options. Verify idempotency, conflict, crash-before-rename and reopen tests; update notification design docs.

## 4. Loopback CDP browser adapter

- [x] 4.1 Implement injectable Node-22 WebSocket CDP transport and registered navigate/evaluate/screenshot capabilities with bounded payload/result/evidence, lease/epoch fence, abort/deadline, disconnect→unknown and no automatic replay. Verify fake-transport frame tests and stale-control tests.
- [x] 4.2 Wire CDP only through explicit loopback/configured endpoint options; reject RTC/viewer/multi-session actions and default Steel connection. Verify protocol tests, boundary scan, and documentation of real-Steel unverified status.

## 5. Integration and gate

- [x] 5.1 Add adversarial cross-adapter tests and independent senior audit covering P0-1..P0-8; fix blockers without weakening contract. Verify targeted adapter suites and review report.
- [x] 5.2 Run `npm run check`, `npm run build`, targeted secure/resource/file/notification/CDP suites, full `npm test`, and prototype `POINT_CRASH_ROUNDS=1 npm test`; generate append-only evidence/manifest and update verification-status. Verify OpenSpec strict and clean worktree.
