# Tasks

## 1. Capability check and contract freeze

- [x] 1.1 Verify `@earendil-works/pi-durable@1.3.0` public commit-subscription surface: `Session.subscribeCommits`, `CommitPublication{seq,changes}`, `Storage.scanDocuments/document(id, at)`. Record what is real (live-only publication, no commit-history enumeration, `Seq` monotonic across reopen) and what must therefore be omitted rather than faked. Publish in `design.md` §2 before implementing.
- [x] 1.2 Freeze `GET /v1/state` shape, `seq` semantics, per-family bounds and truncation flags. Document the "no `Storage.task`" rule as the roadmap exit criterion it is.
- [x] 1.3 Freeze `STATE_DELTA` policy: build RFC 6902 patches by diffing the projected state view, never by mechanically translating Chord `Op` tuples; degrade to `STATE_SNAPSHOT` above 100 operations.
- [x] 1.4 Freeze thread-stream binding: `GET /v1/threads/:threadId/stream`, sync run on open, `id: <commitSeq>:<frameIndex>` frame-level cursors, bounded retention (4096 frames / 5 min), `Last-Event-ID` replay inside the window and explicit resync outside it with reason codes.
- [x] 1.5 Freeze run-stream identity and semantics: `runId` = Durable task id; observation only (never cancels, never replays); `OBSERVATION_*` on interruption.

## 2. Read model

- [x] 2.1 Add neutral read-model types in `application/read-model.ts` (no SDK, no AG-UI imports).
- [x] 2.2 Implement `runtime/read-model.ts`: build the state view from `point.chats`/`point.jobs`/`point.resources`/`point.memory`/`point.event` index documents only; expose the committed `seq`; enforce per-family bounds with `truncated` flags.
- [x] 2.3 Add `GET /v1/state` reusing WP4 auth, error envelope and access log; no Idempotency-Key requirement for a read.
- [x] 2.4 Add Durable counts to the gated `GET /inspect` (the field WP4 deferred to WP6) without changing existing fields.

## 3. Commit subscription and incremental frames

- [x] 3.1 Implement the commit-subscription port in `runtime/**`: subscribe via `subscribeCommits` and map each `DocumentCommitChange` from the value it already carries (no re-read, no view diff); entity reads happen only for job lifecycle `runId` resolution by exact attempt id.
- [x] 3.2 Produce `STATE_DELTA` as RFC 6902 operations from the committed document values (`add` = insert-or-replace, idempotent-tolerant); degrade to `STATE_SNAPSHOT` for bulk changes (>100 ops), truncated families and mid-stream bound crossings; never emit both for one commit.
- [x] 3.3 Project background progress as `ACTIVITY_SNAPSHOT`/`ACTIVITY_DELTA` with `activityType: "point.job"`, outside conversation content.
- [x] 3.4 Emit `CUSTOM` for `point.job.started` / `point.job.finished` / `point.stream.resync`, reusing the WP5 bounded declarative payload rules (no HTML/JS/DOM).

## 4. Thread stream and reconnect

- [x] 4.1 Implement `GET /v1/threads/:threadId/stream` (custom SSE binding): transport-level failures stay on the REST envelope; an accepted request opens the stream.
- [x] 4.2 Open with a sync run: `RUN_STARTED` → `STATE_SNAPSHOT` + `MESSAGES_SNAPSHOT` → `RUN_FINISHED`.
- [x] 4.3 Attach `id: <commitSeq>:<frameIndex>` (frame-level cursor) to every frame; keep a bounded ring (4096 frames / 5 min).
- [x] 4.4 Implement `Last-Event-ID`: replay frames after that seq inside the window; outside the window emit a fresh sync run plus `CUSTOM point.stream.resync` with `window_exceeded` / `unknown_seq` / `process_restarted`. Never fake continuity.
- [x] 4.5 Enforce backpressure and the per-process concurrent-stream cap (64) with a stable error code.

## 5. Run stream

- [x] 5.1 Implement `GET /v1/runs/:runId/stream` observing one Durable task by id; 404 `RUN_NOT_FOUND` before opening SSE when absent.
- [x] 5.2 Keep observation-only semantics: client disconnect does not cancel; interruption emits `OBSERVATION_TIMEOUT`/`OBSERVATION_RESYNC_REQUIRED` without claiming execution failure or replaying work.

## 6. Verification and documentation

- [x] 6.1 Contract tests: `/v1/state` shape and bounds; no `Storage.task` call; patch application equals the authoritative snapshot; single commit yields O(changed) frames; reconnect inside and outside the retention window; run-stream observation does not cancel.
- [x] 6.2 Independent dynamic verification by the tester: real `startServer` + real SQLite + 100 job / 10 chat fixture counting `storage.task` calls; raw-socket SSE reconnect consistency.
- [x] 6.3 Run `npm run check`, full `npm test`, targeted read-model/stream tests and the prototype `POINT_CRASH_ROUNDS=1 npm test`; record evidence with a timestamped file and update the manifest.
- [x] 6.4 Documentation: `apps/server/README.md` route/stream tables; `docs/design/protocol-agui.md` WP6 section; `docs/design/api-v1.md` `/inspect` counts; `docs/design/roadmap.md` WP6 scope to include `runtime/**`; `docs/design/verification-status.md` WP6 evidence section with unverified items; `docs/team/status.md` current-state table.

