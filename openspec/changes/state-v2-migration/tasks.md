# Tasks

## 1. SDK capability check and v2 shape freeze

- [x] 1.1 Inspect locked `@earendil-works/pi-durable@1.3.0` public document/transaction/snapshot APIs and record what can be done inside one commit (migration, backup, event append). Publish the conclusion in `design.md` before writing migration code.
- [x] 1.2 Freeze the v2 family list and key rules (`meta`/`chats`/`chat`/`memory`/`job`/`jobs`/`browser`/`requests`/`event`), version fields, and the index-vs-entity split; document rejection semantics for unknown formats.
- [x] 1.3 Add the version gate: format 2 read/write, format 1 explicit-migrate or read-only, unknown/higher refused without writing. Verify gate tests.

## 2. Migration with backup and idempotency

- [x] 2.1 Implement the online pre-migration backup (`backups/pre-migration-<ts>.sqlite`, no WAL copy); abort with no format change when the backup fails. Verify backup-failure and success tests.
- [x] 2.2 Implement the single-commit migration rewriting all documents to v2 and writing `format: 2`; any CAS/validation failure leaves format 1 intact. Verify rollback-on-failure test.
- [x] 2.3 Make migration idempotent and crash-safe: `already-migrated` when format 2, re-runnable after SIGKILL before and after commit. Verify SIGKILL fixtures.

## 3. Semantic equivalence and rollback

- [x] 3.1 Build a v1 fixture database and verify post-upgrade semantic equivalence for chats/history/jobs/attempts/deliveries/schedules/resources.
- [x] 3.2 Verify a pre-v2 snapshot can start (read-only or via explicit migrate) and that a restored backup returns the system to a working v1 state.
- [x] 3.3 Verify unknown resources/operations and `attempting` records survive migration unchanged and are never auto-replayed.

## 4. Event timeline and request-ledger cleanup

- [x] 4.1 Add `point.event` appended in the same commit as the state change it describes; verify state remains correct if events are absent/rebuilt.
- [x] 4.2 Add bounded receipt cleanup for `point.command.*` and `point.resource-command` with configurable retention; never clean `attempting` or unresolved `unknown` records. Verify retention, reference-safety and audit output.

## 5. Verification and docs

- [ ] 5.1 Update `docs/design/**` (state shape, migration/rollback procedure, retention policy) and `apps/server/README.md`.
  - [x] docs/design/state-v2.md added; apps/server/README.md is outside this task's write scope (report to Lead).
- [ ] 5.2 Run `npm run check`, full `npm test`, targeted migration suites, and prototype `POINT_CRASH_ROUNDS=1 npm test`; record evidence with explicit unverified items.
  - [x] `npm run check` + `npm test` 280/280 + targeted state/migration suites green in the WP3 worktree.
  - [ ] Prototype quick regression: `infra/pi-durable-validation` has no node_modules in this worktree (root `npm ci` only installs workspaces); not run.
