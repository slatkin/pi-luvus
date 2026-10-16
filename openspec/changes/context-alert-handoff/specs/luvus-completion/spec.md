# Spec Delta

## MODIFIED Requirements

### Requirement: Explicit exit only
A sub-agent session SHALL end its run when the child calls the `luvus_done` tool or the `caller_ping` tool. `luvus_done` writes the `done` `.exit` sidecar, or the `handoff` sidecar when it is called with a `handoff` (see "Handoff exit"). Additionally, when the session runs with auto-exit active (`PI_LUVUS_AUTO_EXIT=1`, set from `auto-exit: true` agent frontmatter), the latest assistant message of the ending turn does not carry `stopReason: "aborted"`, and the user has not taken over the session, the child extension SHALL write the `done` `.exit` sidecar from the `agent_end` event so the session exits automatically. The `auto-exit` frontmatter field and the `PI_LUVUS_AUTO_EXIT` environment variable SHALL continue to drive the `interactive` default and the task hint wording.

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

#### Scenario: Explicit exit with handoff
- **WHEN** the child calls `luvus_done` with a `handoff`
- **THEN** the session exits with the `handoff` sidecar instead of the `done` sidecar

## ADDED Requirements

### Requirement: Handoff exit
`luvus_done` SHALL accept an optional `handoff` string. When `handoff` is present and holds non-whitespace text, the tool SHALL publish the terminal status `done`, write `{"type":"handoff","message":"<handoff>"}` to the `.exit` sidecar, and shut the session down. When `handoff` is absent, the tool SHALL behave as before and write `{"type":"done"}`. When `handoff` is present but empty or whitespace only, the tool MUST fail with an error and the session MUST stay open.

#### Scenario: Done with handoff
- **WHEN** a child calls `luvus_done` with `handoff` set to `"Goal: X. Done: A. Left: B."`
- **THEN** `<session>.exit` holds `{"type":"handoff","message":"Goal: X. Done: A. Left: B."}`, the pane status is `done`, and the session shuts down

#### Scenario: Done without handoff
- **WHEN** a child calls `luvus_done` with no parameters
- **THEN** `<session>.exit` holds `{"type":"done"}` as before

#### Scenario: Empty handoff
- **WHEN** a child calls `luvus_done` with `handoff` set to `"  "`
- **THEN** the tool returns an error, no sidecar is written, and the session stays open

### Requirement: Pi parent receives a handoff
When a pi parent reads a child's `.exit` sidecar with `type` `handoff`, it SHALL end the child's run with the reason `handoff`, and SHALL deliver one message that triggers a turn. The message SHALL say that the named child handed off, and SHALL contain the handoff text and the child's session file. A `handoff` sidecar whose `message` is not a non-empty string SHALL be delivered with a placeholder text that says the handoff text is missing.

#### Scenario: Handoff delivered to the parent
- **WHEN** a pi parent's child exits with a `handoff` sidecar
- **THEN** the parent gets a message that names the child, holds the handoff text and the session file, and starts a parent turn

#### Scenario: Handoff without text
- **WHEN** the sidecar is `{"type":"handoff"}` with no `message`
- **THEN** the parent gets the handoff message with a placeholder that says the text is missing
