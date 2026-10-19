# Spec Delta

## Purpose

把持久状态升级为可版本化、可分片、可迁移、可回滚的 v2 格式，让升级旧库成为一个有备份、可重入、语义等值的显式操作，而不是靠拒绝或人工处理。

## ADDED Requirements

### Requirement: State format is gated by an explicit version
The runtime MUST refuse writable opens of a database whose product state format is unknown or newer than the supported version, and MUST require an explicit migration for older formats.

#### Scenario: Newer format
- **WHEN** a database declares a product state format newer than the runtime supports
- **THEN** the writable open is refused without modifying the database

#### Scenario: Older format in write mode
- **WHEN** a v1 database is opened for writing without migration
- **THEN** the runtime refuses the open with a stable error and does not rewrite documents

#### Scenario: v2 database
- **WHEN** the database declares format 2
- **THEN** the runtime opens it read-write normally

### Requirement: Migration backs up before it writes
A migration MUST create a verified online snapshot of the database before changing any state, and MUST abort without changing the format when the backup fails.

#### Scenario: Backup failure
- **WHEN** the pre-migration snapshot cannot be written
- **THEN** migration aborts, no document is rewritten, and the database remains format 1

#### Scenario: Backup success
- **WHEN** the snapshot is written successfully
- **THEN** migration proceeds and the backup path is reported in the result

### Requirement: Migration is atomic, idempotent and crash-safe
All document rewrites and the format change MUST happen in a single commit; re-running migration MUST be a no-op once the database is format 2, and an interrupted run MUST be safely re-runnable.

#### Scenario: Failure during migration
- **WHEN** any rewrite or validation fails before the commit
- **THEN** no change is applied and the database remains format 1

#### Scenario: Re-run after success
- **WHEN** migration runs against an already migrated database
- **THEN** it reports already-migrated, performs no rewrite and creates no additional backup

#### Scenario: SIGKILL around the commit
- **WHEN** the process is killed before or after the migration commit
- **THEN** a restart observes either format 1 (re-runnable) or format 2, never a partial state

### Requirement: Upgrade preserves semantics
A migrated database MUST be semantically equivalent for existing chats, history, jobs, attempts, deliveries, schedules and resources, and unresolved `unknown`/`attempting` records MUST survive unchanged and never be replayed.

#### Scenario: Semantic equivalence
- **WHEN** a v1 fixture database is migrated
- **THEN** all product queries return the same values and states as before migration

#### Scenario: Unknown preservation
- **WHEN** an operation or delivery was `unknown` before migration
- **THEN** it is still `unknown` afterwards and no effect is dispatched

### Requirement: Product events form a rebuildable timeline
Product-visible events MUST be appended in the same commit as the state change they describe, and MUST be reconstructible from state.

#### Scenario: Event and state commit together
- **WHEN** a command changes state
- **THEN** its event is committed in the same transaction

#### Scenario: Events are not the source of truth
- **WHEN** events are missing or discarded
- **THEN** product state remains correct and can regenerate them

### Requirement: Request ledgers are bounded
Command receipts and resource request ledgers MUST be cleanable by an explicit retention policy that never removes records still referenced or awaiting reconciliation.

#### Scenario: Retention cleanup
- **WHEN** cleanup runs with a retention window
- **THEN** only terminal receipts outside the window are removed and the audit output reports what was removed

#### Scenario: Unresolved records are protected
- **WHEN** a receipt belongs to an `attempting` or unresolved `unknown` record
- **THEN** it is never removed by cleanup
