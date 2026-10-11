# luvus-agent-status Specification

## Purpose
Defines the leased status that a pi process inside Luvus reports for its own pane, so the Luvus AGENTS sidebar and `luvus wait` show the true state of every pi pane.

## Requirements

### Requirement: Status follows the pi session state
A pi process inside a Luvus pane SHALL report `working` while a turn runs and `idle` while the session waits for input, through its `pi-luvus-status` lease. Outside Luvus it SHALL report nothing.

#### Scenario: Turn starts and ends
- **WHEN** a pi session inside Luvus starts a turn and later finishes it
- **THEN** `luvus agent list` shows the pane as `working` during the turn and as `idle` after it, with `state_source` `integration_report`

#### Scenario: Outside Luvus
- **WHEN** pi runs without `LUVUS_ENV`, `LUVUS_BIN_PATH`, or `LUVUS_PANE_ID`
- **THEN** the extension makes no Luvus status calls

### Requirement: Status lease stays alive while pi runs
The extension SHALL renew the current non-terminal status before the lease TTL expires, for as long as the pi process runs. Renewal SHALL also happen while the session is idle.

#### Scenario: Idle longer than the TTL
- **WHEN** a pi session inside Luvus stays idle for longer than the lease TTL
- **THEN** `luvus agent explain <pane>` still shows `authority.source` `pi-luvus-status` and status `idle`

#### Scenario: Renewal stops after a terminal status
- **WHEN** a subagent child has published `done` or `blocked`
- **THEN** the extension sends no further renewals, and the terminal status stays until its TTL expires or the pane closes

#### Scenario: Renewal stops on shutdown
- **WHEN** pi shuts down without a terminal status
- **THEN** the extension releases the lease and sends no further renewals

### Requirement: Working status names the running tool
While a tool runs, the `working` report SHALL carry a message that holds the tool name. When no tool runs, the `working` report SHALL carry no message.

#### Scenario: Tool runs during a turn
- **WHEN** pi starts the `bash` tool during a turn
- **THEN** the pane status is `working` with message `bash`

#### Scenario: Tool ends
- **WHEN** the tool ends and the turn continues
- **THEN** the pane status is `working` with no message

### Requirement: Non-terminal reports do not block pi
`working` and `idle` reports, and renewals, SHALL NOT block the pi event loop. A failed or slow report SHALL NOT delay a turn. Terminal reports keep their existing ordering rules from `luvus-completion`.

#### Scenario: Luvus server is slow
- **WHEN** a `working` report takes longer than the call timeout
- **THEN** the turn continues without waiting, and a later transition reports again

### Requirement: Session id is bound to the pane
At session start, the extension SHALL bind the pi session id to its Luvus pane, so `luvus agent sessions` lists the session and `luvus agent resume <id>` can reopen it.

#### Scenario: Resume a finished pi session
- **WHEN** a pi session inside Luvus has ended
- **THEN** `luvus agent sessions` lists it with `agent` `pi`, and `luvus agent resume <session id>` reopens it in a new pane
