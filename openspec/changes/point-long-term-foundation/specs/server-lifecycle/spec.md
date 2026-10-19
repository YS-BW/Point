# Server lifecycle

## Purpose

Provide an independently runnable Point server foundation with exclusive ownership of its data, persistent identity, truthful health reporting and safe shutdown before product capabilities are migrated.

## ADDED Requirements

### Requirement: Exclusive data ownership
The server SHALL reject a concurrent owner of the same data directory and SHALL release ownership after shutdown or process death.

#### Scenario: Competing process
- **WHEN** another server holds the data directory
- **THEN** startup fails without taking ownership

#### Scenario: Restart
- **WHEN** the previous process closes or is killed
- **THEN** a new server can acquire the directory

### Requirement: Persistent compatible initialization
The server SHALL preserve its identity across restart and SHALL reject unsupported application metadata or unrecognized populated storage without enabling execution.

#### Scenario: Reopen supported storage
- **WHEN** the server reopens its initialized directory
- **THEN** the same identity is returned

#### Scenario: Incompatible data
- **WHEN** metadata is unsupported or populated storage has no recognized metadata
- **THEN** startup fails and the owner lock is released

### Requirement: Truthful local health
The foundation SHALL listen only on loopback, expose GET /health/live and GET /health/ready, and list only implemented capabilities. Unsupported routes SHALL return 404, and unsupported methods on health routes SHALL return 405.

#### Scenario: Ready foundation
- **WHEN** initialization and listening succeed
- **THEN** readiness is 200 with foundation capability only

#### Scenario: Invalid configuration
- **WHEN** a non-loopback address or invalid port is configured
- **THEN** startup fails before initializing storage

### Requirement: Cleanup on failure
The server SHALL close opened resources when startup or shutdown fails and SHALL NOT report raw errors containing private data to clients or logs.

#### Scenario: Port in use
- **WHEN** the HTTP bind fails after storage opens
- **THEN** the data directory can be acquired again

#### Scenario: Runtime terminates unexpectedly
- **WHEN** the runtime ends during startup or after readiness
- **THEN** the server does not remain ready, releases its resources and reports failure

#### Scenario: Shutdown disposal fails
- **WHEN** a runtime resource fails to close
- **THEN** the server closes HTTP and reports a failed shutdown outcome instead of success
