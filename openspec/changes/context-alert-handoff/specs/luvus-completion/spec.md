# Spec Delta

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
