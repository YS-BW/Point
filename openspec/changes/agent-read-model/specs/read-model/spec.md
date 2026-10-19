# Spec Delta

## Purpose

给客户端提供一份与服务端权威状态一致的只读视图与增量帧，使 Web/第三方客户端能在不轮询的前提下渲染 chats/jobs/resources/memory，并在断线后诚实重建；同时保证读模型永远是派生物，不成为第二事实源。

## ADDED Requirements

### Requirement: The read model is a derived view, never an authority

`GET /v1/state` MUST be built from the v2 derived index documents (`point.chats`, `point.jobs`, `point.resources`, `point.memory`, `point.event`) and MUST NOT read entity documents or enumerate Durable task records. No product decision may depend on the read model: dropping or rebuilding the indexes MUST NOT change any product state.

#### Scenario: No task-table scan
- **WHEN** `GET /v1/state` is served against a fixture with 100 jobs and 10 chats
- **THEN** the storage task reader is never invoked

#### Scenario: Index documents only
- **WHEN** the state view is constructed
- **THEN** only index-family documents are read; `point.chat`, `point.job` and `point.resource` entity documents are not

### Requirement: The state view is bounded and reports truncation

`GET /v1/state` MUST return `seq` observed **before** the view scan (a lower bound: the view may contain newer commits, and overlapping replay MUST be applied idempotently), plus `chats`, `jobs`, `resources`, `memory` and `events` as objects keyed by entity id (not arrays), each bounded (1000 / 1000 / 1000 / 200 / 200 entries). `chats`, `jobs`, `resources` and `memory` are delta-managed; `events` is snapshot-only and MUST NOT be patched by a delta. Keyed objects are required so incremental patches are idempotent-tolerant: `add` on an existing key replaces, and `remove` on a missing key is ignored. Exceeding a bound MUST NOT silently truncate: the response MUST carry a `truncated` marker naming the affected family. Memory entries MUST NOT include the stored value body. Key order carries no meaning; clients sort.

#### Scenario: Bounded families
- **WHEN** more chats exist than the chat bound
- **THEN** the response contains at most the bound and `truncated.chats` is `true`

#### Scenario: Memory has no value body
- **WHEN** the state view lists memory entries
- **THEN** each entry carries key, kind, source chat, revision and update time but not the memory value

### Requirement: The read endpoint reuses the WP4 transport contract

`GET /v1/state` MUST reuse the existing bearer authentication, fail-closed `API_NOT_CONFIGURED`, error envelope, request id and access-log redaction. It MUST NOT require an `Idempotency-Key` because it is a read.

#### Scenario: Unauthorized read
- **WHEN** `/v1/state` is called without a valid bearer
- **THEN** it returns 401 with the standard error envelope and no state

#### Scenario: No idempotency key required
- **WHEN** an authenticated client calls `/v1/state` without an `Idempotency-Key`
- **THEN** the request succeeds

### Requirement: Inspect reports Durable counts with a frozen shape

The gated `GET /inspect` MUST report Durable counts that WP4 deferred to WP6, without removing or changing its existing fields, and MUST keep the same gating, authentication and 404-when-disabled behavior. The counts object MUST have exactly these keys: `chats`, `jobs`, `attempts`, `resources`, `resourceOperations`, `memory`, `events`, `schedules`, `occurrences`, `decisions`, `deliveries`, `artifacts`, `requests`. It MUST count entity families only and MUST NOT also count the derived index families under a second name. Counts are exact and `countsTruncated` MUST be present and `false`.

#### Scenario: Counts are additive
- **WHEN** `/inspect` is enabled and authenticated
- **THEN** the response still contains version, instanceId, phase and capabilities, plus a counts object with exactly the frozen keys and `countsTruncated: false`

#### Scenario: No duplicate entity/index counting
- **WHEN** counts are reported
- **THEN** the entity families are counted once and the derived index families are not counted under a second name

#### Scenario: Disabled stays indistinguishable
- **WHEN** `/inspect` is disabled
- **THEN** it returns 404 before authentication, exactly as before

### Requirement: Bounded response does not claim bounded cost

The read model MUST NOT be documented as a constant-cost endpoint. `point.event`, `point.chats`, `point.jobs`, `point.resources` and `point.memory` have no ordering in the storage query API, so selecting the newest N rows requires a full scan of the family. The resulting cost is O(total documents) per call and MUST be recorded as a known limitation rather than hidden behind the response bounds.

#### Scenario: Cost is documented
- **WHEN** a reader checks the read-model documentation
- **THEN** the per-family full-scan cost is stated explicitly as a known limitation

### Requirement: Events are snapshot-only

The `events` family MUST be delivered only inside `STATE_SNAPSHOT` and MUST NOT be patched by `STATE_DELTA`. Patching it on every commit would make the bounded family cross its limit almost immediately and force a snapshot for nearly every commit, defeating the O(change) requirement.

#### Scenario: A commit that appends an event
- **WHEN** a commit appends a product event
- **THEN** no delta path is created for `/events`

### Requirement: Incremental frames are O(change)

A single commit MUST be projected with a constant number of frames carrying a number of patch operations proportional to the changed entities, not as a full state resend. `STATE_DELTA` MUST carry an RFC 6902 JSON Patch containing only the changed paths, and applying that patch to the previous view MUST produce the authoritative view.

#### Scenario: One commit, one entity
- **WHEN** a commit changes exactly one job
- **THEN** the frame count for that commit does not grow with the total number of jobs, the delta carries one changed path, and no full `STATE_SNAPSHOT` is sent

#### Scenario: Patch application equals authority
- **WHEN** a client applies every delta to its view
- **THEN** the delta-managed families equal the server's authoritative view field by field, while `events` is refreshed only by snapshots

#### Scenario: Remove means leaving the view
- **WHEN** a delta removes a row
- **THEN** the client stops rendering it, understanding that removal means the row left the bounded view (this product has no delete endpoint) rather than that the entity was deleted

#### Scenario: Truncation is delivered by snapshots, never by a delta
- **WHEN** a family crosses or leaves its bound
- **THEN** the server emits a bounded `STATE_SNAPSHOT` carrying the truncation marker, and no delta claims to express it

### Requirement: Frames are emitted in commit order

Frames for different commits MUST be emitted in strictly ascending commit order even though the projection may await (a bulk snapshot or a run-identity read). A client replaying by frame cursor MUST never apply a higher sequence before a lower one.

#### Scenario: Awaiting projection does not reorder frames
- **WHEN** one commit's projection awaits while a subsequent commit arrives
- **THEN** the earlier commit's frames are emitted first

### Requirement: Truncated families degrade to snapshots, not partial patches

When the initial snapshot had to truncate a family, that family can no longer be expressed as a patch: an insert may have evicted a row whose identity the projection cannot name without a cache. Any commit touching a truncated family MUST be projected as a fresh bounded `STATE_SNAPSHOT` instead of a delta. Families that were not truncated MUST keep the delta path.

#### Scenario: Insert into a truncated family
- **WHEN** a commit adds a row to a family whose snapshot was truncated
- **THEN** the projection emits a bounded snapshot, not an incomplete patch

#### Scenario: Non-truncated family keeps deltas
- **WHEN** a commit changes a family that fits its bound
- **THEN** the projection emits a delta

### Requirement: Large commits degrade to an explicit snapshot

When one commit affects more keys than the patch-operation bound (100), the projection MUST emit a single `STATE_SNAPSHOT` instead of a large patch, and MUST NOT emit both a snapshot and a delta for the same commit.

#### Scenario: Bulk change
- **WHEN** a commit affects more keys than the bound
- **THEN** a `STATE_SNAPSHOT` replaces the view and no partial delta is emitted

### Requirement: Background progress uses ACTIVITY, extensions use CUSTOM

Background job progress MUST be projected as `ACTIVITY_SNAPSHOT` (with `replace: true`) carrying `activityType: "point.job"` outside conversation content. `ACTIVITY_DELTA` is NOT emitted in this change: bounded progress snapshots are simpler and cannot drift. Point-specific lifecycle notifications MUST use `CUSTOM` events under the `point.*` namespace with bounded declarative payloads and MUST NOT carry HTML, JavaScript or DOM.

#### Scenario: Job progress is not conversation content
- **WHEN** a background job changes status
- **THEN** an activity event carries the progress and no text message is appended

#### Scenario: Executable payload refused
- **WHEN** a custom payload would contain HTML or script
- **THEN** it is rejected and nothing is persisted or emitted

### Requirement: The thread stream opens with a sync run

`GET /v1/threads/:threadId/stream` MUST be a documented custom SSE binding whose first connection opens with a sync run: `RUN_STARTED`, then `STATE_SNAPSHOT` and `MESSAGES_SNAPSHOT`, then `RUN_FINISHED`. The sync run MUST be identifiable using only official schema fields: its `runId` is `sync-<commitSeq>` (prefix `sync-`) and its `RUN_STARTED.metadata` carries `point.sync: true`. No non-schema `sync` field may be added. Transport-level failures MUST stay on the REST envelope and MUST NOT open a stream.

#### Scenario: First connect
- **WHEN** a client opens the thread stream without `Last-Event-ID`
- **THEN** the stream starts with a sync run carrying an authoritative state and messages snapshot

#### Scenario: Sync run is schema-valid and identifiable
- **WHEN** the sync run is emitted
- **THEN** every frame passes the official event schema, the run id has the `sync-` prefix, and metadata carries `point.sync: true`

#### Scenario: Unknown thread
- **WHEN** the thread does not exist
- **THEN** the request fails with the REST error envelope and no stream opens

### Requirement: The thread stream carries state and lifecycle, not foreground tokens

The thread stream MUST carry only the sync run, `STATE_SNAPSHOT`/`STATE_DELTA`, `ACTIVITY_*`, `CUSTOM` and a completion `MESSAGES_SNAPSHOT`. It MUST NOT duplicate per-token text or tool-call frames that the accepted `POST /v1/agent` run stream already emits for the same run. `MESSAGES_SNAPSHOT` MUST remain bounded visible text history and MUST declare `point.toolsIncluded: false` in its metadata so clients do not treat it as complete tool history.

#### Scenario: No duplicate tokens
- **WHEN** a foreground run streams tokens on `POST /v1/agent`
- **THEN** the thread stream does not emit the same token frames

#### Scenario: Messages snapshot declares its scope
- **WHEN** a `MESSAGES_SNAPSHOT` is emitted
- **THEN** its metadata carries `point.toolsIncluded: false`

### Requirement: Custom events in this change are an explicit closed set

Only `point.job.started`, `point.job.finished` and `point.stream.resync` MAY be emitted by this change. Other `point.*` extensions named in the protocol evaluation (notifications, memory changes, browser leases, archival, `point.ui.*`) MUST remain unimplemented and documented as deferred rather than silently missing.

#### Scenario: Only the closed set is emitted
- **WHEN** the projection emits a custom event
- **THEN** its name is one of the three documented names

#### Scenario: Deferred extensions are documented
- **WHEN** a reader compares the protocol evaluation mapping table with this change
- **THEN** the still-unimplemented extensions are explicitly marked deferred

### Requirement: New stream errors use stable codes

`TOO_MANY_STREAMS` (503) and `RUN_NOT_FOUND` (404) MUST be added to the documented v1 error-code table and MUST be reachable only on the new endpoints.

#### Scenario: Documented codes
- **WHEN** a client receives either error
- **THEN** the code appears in the documented v1 error table

### Requirement: Incremental frames live inside a long-lived run

Because AG-UI defines event semantics relative to run boundaries, the thread stream MUST wrap all post-sync incremental frames in a long-lived live run: after the sync run's `RUN_FINISHED`, it opens `RUN_STARTED` with a `runId` prefixed `live-`, and every `STATE_DELTA`, `ACTIVITY_*`, `CUSTOM` and later `MESSAGES_SNAPSHOT` frame belongs to that live run. A resync MUST close the live run before opening the new sync run. No frame MAY be emitted outside a run.

#### Scenario: No frame outside a run
- **WHEN** a client consumes the thread stream
- **THEN** every frame is either inside the sync run or inside the live run

#### Scenario: Resync closes the live run first
- **WHEN** a reconnect requires a resync
- **THEN** the current live run is finished before the new sync run starts

### Requirement: Live runs have defined connection lifecycle

A live run belongs to exactly one connection. When that connection ends for any reason, the server MUST treat the live run as ended and MUST NOT emit a `RUN_FINISHED` for it on a stream that no longer exists. Frames retained in the ring MUST NOT be replayed to a client that has no matching run boundary: on reconnect, if the frames after the client's cursor belong to a live run the client never saw start, or to a run that already ended, the server MUST resync instead of replaying them.

#### Scenario: Disconnect ends the live run
- **WHEN** a client disconnects from the thread stream
- **THEN** that connection's live run is ended and no orphan live run remains

#### Scenario: Unknown run boundary triggers resync
- **WHEN** a client reconnects and the retained frames after its cursor belong to a run it never observed start
- **THEN** it receives a resync rather than frames with a missing run boundary

#### Scenario: Ended run is not replayed
- **WHEN** retained frames belong to a live run that already ended
- **THEN** the server resyncs instead of replaying those frames

### Requirement: Messages snapshots are emitted on visible-history change

The thread stream MUST emit an authoritative `MESSAGES_SNAPSHOT` when visible history changes (a commit appends a visible user or assistant entry), inside the live run, bounded to 10,000 messages / 8 MiB / 1,000 pages (the MESSAGES_SNAPSHOT bound, not the state-view bound). A commit that does not change visible history MUST NOT produce a snapshot.

#### Scenario: Assistant reply produces a snapshot
- **WHEN** a run appends an assistant entry
- **THEN** the thread stream emits a bounded `MESSAGES_SNAPSHOT` within the live run

#### Scenario: Unrelated commit produces none
- **WHEN** a commit changes only a job status
- **THEN** no `MESSAGES_SNAPSHOT` is emitted for it

### Requirement: Frames carry a frame-level cursor as the event id

Every thread-stream frame MUST carry an `id` of the form `<commitSeq>:<frameIndex>`, where `frameIndex` starts at 0 within each commit and increases monotonically. Multiple frames produced by one commit MUST NOT share an id. A client resumes from the last frame it fully applied.

#### Scenario: Frames of one commit have distinct ids
- **WHEN** a commit produces a delta and an activity frame
- **THEN** their ids are `<seq>:0` and `<seq>:1`, not the same value

#### Scenario: Resume granularity is the frame
- **WHEN** a client applied only the first frame of commit S and reconnects with that frame id
- **THEN** it receives the remaining frames of commit S, not a jump past them

### Requirement: Reconnect replays only inside a bounded window

The thread stream MUST keep a bounded retention ring (4096 frames or 5 minutes, whichever comes first). A `Last-Event-ID` inside the window MUST replay only the frames after that frame cursor and then continue live. A cursor outside the window, unknown, or lost to a process restart MUST trigger a fresh sync run followed by a `CUSTOM point.stream.resync` event whose value carries a `reason` of `window_exceeded`, `unknown_seq` or `process_restarted`, plus the requested cursor and the current sequence. The stream MUST NOT fake continuity by emitting deltas it cannot prove contiguous.

#### Scenario: Replay inside the window
- **WHEN** a client reconnects with a `Last-Event-ID` still inside the retention ring
- **THEN** it receives only the frames after that cursor and no new snapshot

#### Scenario: Resync outside the window
- **WHEN** a client reconnects with a `Last-Event-ID` older than the retention window
- **THEN** it receives a fresh sync run and a `point.stream.resync` event with `reason: window_exceeded`, and no delta claiming continuity

#### Scenario: Process restart
- **WHEN** the server restarted since the client's last event id
- **THEN** the client receives a resync with `reason: process_restarted`

### Requirement: Streams are bounded and backpressured

Each stream MUST enforce a bounded per-client send buffer (1024 frames) and a per-process concurrent-stream cap (64). Exceeding the connection cap MUST return a stable `TOO_MANY_STREAMS` error; exceeding a client's buffer MUST drop that client only.

#### Scenario: Connection cap
- **WHEN** more than the allowed number of streams are open
- **THEN** the excess request is rejected with `TOO_MANY_STREAMS`

#### Scenario: Slow client isolation
- **WHEN** one client stops reading
- **THEN** that client is dropped and other streams keep receiving frames

### Requirement: The run stream observes without controlling

`GET /v1/runs/:runId/stream` MUST observe one background execution identified by its Durable task id. A client disconnect MUST NOT cancel the task, observation interruption MUST NOT claim execution failure, and the stream MUST NOT replay work. An unknown run MUST return 404 `RUN_NOT_FOUND` without opening a stream.

#### Scenario: Disconnect does not cancel
- **WHEN** a client disconnects from a run stream
- **THEN** the underlying task keeps running

#### Scenario: Failed execution is not reported as success
- **WHEN** the observed execution reaches a failed terminal state
- **THEN** the stream ends with `RUN_ERROR` and never with a successful `RUN_FINISHED`

#### Scenario: Cancelled execution
- **WHEN** the observed execution is cancelled
- **THEN** the stream ends with `RUN_FINISHED` and an outcome of `cancelled`

#### Scenario: Observation interruption
- **WHEN** observation times out or its buffer overflows
- **THEN** the stream ends with `OBSERVATION_TIMEOUT` or `OBSERVATION_RESYNC_REQUIRED` and does not report the task as failed

#### Scenario: Unknown run
- **WHEN** the run id does not resolve to a Durable task
- **THEN** the request returns 404 `RUN_NOT_FOUND` and no stream opens
