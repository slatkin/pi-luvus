# Subagent Completion

## Purpose

Defines how a sub-agent session reliably reaches completion: explicit `luvus_done` / `caller_ping`, restored child-side auto-exit for `auto-exit: true` agents, and a child-side completion nudge for sessions that remain open.

## Requirements

### Requirement: Explicit exit only
A sub-agent session SHALL end its run (writing the `done` `.exit` sidecar) when the child calls the `luvus_done` tool or the `caller_ping` tool. Additionally, when the session runs with auto-exit active (`PI_LUVUS_AUTO_EXIT=1`, set from `auto-exit: true` agent frontmatter), the latest assistant message of the ending turn does not carry `stopReason: "aborted"`, and the user has not taken over the session, the child extension SHALL write the `done` `.exit` sidecar from the `agent_end` event so the session exits automatically. The `auto-exit` frontmatter field and the `PI_LUVUS_AUTO_EXIT` environment variable SHALL continue to drive the `interactive` default and the task hint wording.

#### Scenario: Auto-exit agent finishes its turn
- **WHEN** a sub-agent with `auto-exit: true` finishes a turn normally without calling `luvus_done`
- **THEN** the child writes the `done` `.exit` sidecar and the session exits, delivering the completion to the parent

#### Scenario: Auto-exit agent aborted mid-turn
- **WHEN** a sub-agent with `auto-exit: true` has its turn end with `stopReason: "aborted"`
- **THEN** the session stays open for inspection or another prompt and no `done` sidecar is written

#### Scenario: Auto-exit agent after user takeover
- **WHEN** the user has sent input to the sub-agent after its first agent run started, and the agent then finishes a turn normally
- **THEN** the session stays open and the completion nudge path applies instead of auto-exit

#### Scenario: Non-auto-exit agent finishes its turn
- **WHEN** a sub-agent without `auto-exit` finishes a turn normally without calling `luvus_done`
- **THEN** the session stays open and the completion nudge is scheduled

#### Scenario: Explicit exit
- **WHEN** the child calls `luvus_done`
- **THEN** the session exits and the parent receives the completion as before

### Requirement: Error exit is preserved
When a sub-agent's turn ends with the latest assistant message carrying `stopReason: "error"`, the child extension SHALL still write the error `.exit` sidecar so the parent learns about the provider failure promptly — including auto-exit agents, whose normal-completion exit path does not apply to error turns.

#### Scenario: Provider error ends the turn
- **WHEN** the child's latest assistant message ends with `stopReason: "error"` (e.g. auto-retry exhausted)
- **THEN** the child writes the error `.exit` sidecar and the parent is woken with the failure

### Requirement: Completion nudge after a normal stop
When a sub-agent session remains open after a turn ends normally (the latest assistant message has `stopReason: "stop"`) — a non-auto-exit session, or an auto-exit session the user has taken over — and `luvus_done` has not been called, the child extension SHALL schedule a nudge: a follow-up message reminding the agent to call `luvus_done`, or `caller_ping` if it is spinning in place. The nudge SHALL be delivered after a delay (default 5 seconds, configurable via `PI_LUVUS_NUDGE_DELAY_MS` with a 1-second minimum, disable entirely with `PI_LUVUS_NUDGE_DISABLE=1`). Provider-error and aborted stops SHALL NOT schedule a nudge.

#### Scenario: Model forgets to call luvus_done
- **WHEN** a non-auto-exit child finishes a turn normally without calling `luvus_done` and stays idle for the nudge delay
- **THEN** the child receives a follow-up message reminding it to call `luvus_done` (or `caller_ping` when spinning in place)

#### Scenario: Auto-exit session exits before any nudge
- **WHEN** an auto-exit session (not user-taken-over) finishes its turn normally
- **THEN** the session exits with the `done` sidecar and no nudge is scheduled

#### Scenario: Error stop does not nudge
- **WHEN** the child's turn ends with `stopReason: "error"`
- **THEN** no nudge is scheduled

### Requirement: Nudge cancellation
A pending nudge SHALL be cancelled when the child calls `luvus_done` or `caller_ping`, when the user sends input, when a new agent generation cycle starts, or when the session shuts down. Input that arrives after the first agent run has started SHALL additionally mark the session as user-taken-over.

#### Scenario: User takes over
- **WHEN** the user types into the sub-agent pane after the first agent run has started and a nudge is pending
- **THEN** the pending nudge is cancelled and the session stays open for the user

#### Scenario: Agent resumes work
- **WHEN** a new agent generation cycle starts while a nudge is pending
- **THEN** the pending nudge is cancelled

### Requirement: Terminal Luvus status on completion
A sub-agent child running inside Luvus SHALL publish a terminal status through its existing leased `agent report` source before writing a completion sidecar: `done` for a done exit, and `blocked` (message: the ping question or error text) for a ping or error exit. Publishing SHALL be best effort and SHALL NOT delay or prevent the sidecar write or shutdown.

#### Scenario: Child completes with luvus_done
- **WHEN** a child inside Luvus calls `luvus_done`
- **THEN** its pane's reported status becomes `done` before the `done` sidecar is written and the session shuts down

#### Scenario: Child pings the parent
- **WHEN** a child calls `caller_ping` with a question
- **THEN** its pane's reported status becomes `blocked` with the question as the message, and the `ping` sidecar is written as before

#### Scenario: Report fails
- **WHEN** the status report command fails or times out
- **THEN** the sidecar is still written and the session still shuts down

#### Scenario: Not inside Luvus
- **WHEN** the Luvus environment variables are absent
- **THEN** no status is reported and behavior is unchanged

### Requirement: Terminal status survives shutdown
After publishing a terminal status (`done` or `blocked`), the child's `session_shutdown` handling SHALL NOT release the status lease, so the terminal value stays observable (for example by `luvus wait agent-status` in an external orchestrator) until the lease TTL expires or the pane is closed. A shutdown without a terminal status SHALL release the lease as before.

#### Scenario: External orchestrator waits for done
- **WHEN** an orchestrator runs `luvus wait agent-status <child-pane> --status done` and the child completes with `luvus_done`
- **THEN** the wait returns while the child pane still exists

#### Scenario: Shutdown without completion
- **WHEN** the session shuts down without having published `done` or `blocked`
- **THEN** the status lease is released
