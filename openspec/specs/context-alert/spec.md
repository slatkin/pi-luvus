# context-alert Specification

## Purpose

Lets a subagent child that has filled much of its context window stop and hand its work to a fresh child, through an opt-in alert with a configurable threshold, and records each alert and handoff for later counting.

## Requirements

### Requirement: Context alert configuration
The extension `config.json` SHALL accept an optional `contextAlert` object with the keys `enabled` and `threshold`. `enabled` is a boolean and defaults to `false`. `threshold` defaults to `200000`. Any other key in `contextAlert` MUST be a config error.

#### Scenario: No contextAlert block
- **WHEN** `config.json` has no `contextAlert` key
- **THEN** the alert is off

#### Scenario: Enabled with no threshold
- **WHEN** `contextAlert` is `{"enabled": true}`
- **THEN** the alert is on with a threshold of 200000 tokens

#### Scenario: Unknown key
- **WHEN** `contextAlert` holds a key other than `enabled` or `threshold`
- **THEN** loading the config fails with an error that names the key

### Requirement: Threshold forms
`threshold` SHALL be a positive integer, read as a count of context tokens, or a string of a decimal number (for example `80` or `80.5`) followed by `%`, read as a percentage of the model's context window. A percentage MUST be greater than 0 and not more than 100. Any other value MUST be a config error. The configured value SHALL be used as it is, with no limit from the model's window or compaction settings.

#### Scenario: Absolute threshold
- **WHEN** `threshold` is `150000`
- **THEN** the alert compares the context token count with 150000

#### Scenario: Percentage threshold
- **WHEN** `threshold` is `"80%"`
- **THEN** the alert compares the context usage percentage with 80

#### Scenario: Invalid threshold
- **WHEN** `threshold` is `0`, `-5`, `1.5`, `"0%"`, `"120%"`, `"80"`, `"abc%"`, or `true`
- **THEN** loading the config fails with an error that names `contextAlert.threshold`

### Requirement: Alert trigger
When the alert is on, a subagent child (a session with `PI_LUVUS_SESSION` set) SHALL check its current context usage after each turn ends, and SHALL fire the alert when the usage is at or above the threshold. A check where the usage is unknown SHALL do nothing. The alert SHALL fire at most one time for each pi process. A session without `PI_LUVUS_SESSION` SHALL never fire the alert.

#### Scenario: Threshold reached
- **WHEN** the alert is on with threshold 200000 and a turn ends with 201000 context tokens
- **THEN** the child gets the alert message

#### Scenario: Below threshold
- **WHEN** a turn ends with 150000 context tokens and the threshold is 200000
- **THEN** no alert fires

#### Scenario: Fires once
- **WHEN** the alert has fired and a later turn ends above the threshold
- **THEN** no second alert fires

#### Scenario: Usage unknown
- **WHEN** a turn ends and pi gives no context usage, or no token count (for example just after a compaction)
- **THEN** no alert fires for that turn, and a later turn can still fire it

#### Scenario: Resume in a new process
- **WHEN** a session that already got the alert is resumed in a new pi process and a turn ends above the threshold
- **THEN** the alert fires again in that process

#### Scenario: Alert off
- **WHEN** `contextAlert.enabled` is `false` and a turn ends above the threshold
- **THEN** no alert fires

#### Scenario: Not a subagent
- **WHEN** a top-level pi session with no `PI_LUVUS_SESSION` ends a turn above the threshold
- **THEN** no alert fires

### Requirement: Alert message
The alert SHALL reach the child as a steer user message. The message SHALL state the context token count and the threshold, and SHALL tell the child to stop the task, to commit finished work or list uncommitted changes, to write a handoff that a fresh agent can continue from, to send it to the parent the way its instructions say, and to end the session with `luvus_done` and the handoff text in its `handoff` parameter.

#### Scenario: Message content
- **WHEN** the alert fires at 201000 tokens with threshold 200000
- **THEN** the child receives one steer message that contains `201000`, `200000`, and `luvus_done` with `handoff`

### Requirement: Alert is a takeover
The alert message SHALL count as input after the first agent run, so it marks the session as taken over, as for any other input. An auto-exit child SHALL therefore not auto-exit after the alert. When it ends a turn normally without calling `luvus_done`, the session SHALL stay open and the completion nudge path SHALL apply.

#### Scenario: Auto-exit child ignores the alert
- **WHEN** an auto-exit child gets the alert and then ends a turn normally without calling `luvus_done`
- **THEN** no sidecar is written, the session stays open, and the completion nudge is scheduled

### Requirement: Nudge after the alert
When the alert has fired, the completion nudge SHALL tell the child to end the session with `luvus_done` and the handoff text in its `handoff` parameter. It SHALL NOT say that the last message was already delivered as the report. Without an alert, the nudge text SHALL not change.

#### Scenario: Nudge text after the alert
- **WHEN** the alert has fired and the completion nudge is delivered
- **THEN** the nudge names `luvus_done` with `handoff` and does not say that the last message was already delivered

#### Scenario: Nudge text without an alert
- **WHEN** the alert has not fired and the completion nudge is delivered
- **THEN** the nudge text is the same as before this change

### Requirement: Handoff log
The child SHALL append one JSON line to `handoffs.jsonl` in the extension config directory when the alert fires (`event` `alert`) and when it ends with a handoff (`event` `handoff`). Each line SHALL hold `at` (ISO time), `event`, `luvusSession`, `child`, `session`, and `tokens`. An `alert` line SHALL also hold `threshold`. Writing the log SHALL be best effort and SHALL NOT delay or prevent the alert, the sidecar write, or shutdown.

#### Scenario: Alert and handoff rows
- **WHEN** a child gets the alert and then calls `luvus_done` with a handoff
- **THEN** `handoffs.jsonl` gets an `alert` line and then a `handoff` line, both with the same `session`

#### Scenario: Alert with no handoff
- **WHEN** a child gets the alert and then calls `luvus_done` with no handoff
- **THEN** `handoffs.jsonl` has the `alert` line and no `handoff` line for that session

#### Scenario: Log write fails
- **WHEN** the log file cannot be written
- **THEN** the alert is still delivered, and a handoff still writes its sidecar and shuts down

### Requirement: Server session in log rows
`luvusSession` SHALL be the name of the Luvus server session whose `socket_path`, from `luvus session list --json`, equals the child's `LUVUS_SOCKET_PATH`. When no entry matches or the list cannot be read, it SHALL be the value of `LUVUS_SOCKET_PATH`. Outside Luvus it SHALL be `null`.

#### Scenario: Named session
- **WHEN** the session list has `mbv` with `socket_path` equal to the child's `LUVUS_SOCKET_PATH`
- **THEN** the row has `"luvusSession": "mbv"`

#### Scenario: No match
- **WHEN** no listed session has the child's socket path
- **THEN** the row has the socket path as `luvusSession`

#### Scenario: Outside Luvus
- **WHEN** `LUVUS_SOCKET_PATH` is not set
- **THEN** the row has `"luvusSession": null`
