# luvus-uhp-events Specification

## Purpose
Defines how a process that watches child subagents reads Luvus events through one long-lived `luvus uhp events` child process instead of polling the pane on a fixed interval.

## Requirements

### Requirement: Events come from one long-lived event stream
A process that watches child subagents SHALL read Luvus events through a single long-lived `luvus uhp events` child process. A process that watches no child SHALL NOT start a stream. The extension SHALL start the stream lazily on the first watched child and stop it when no watched child remains or on session shutdown or abort.

#### Scenario: Lazy start
- **WHEN** a pi process starts and watches no child yet
- **THEN** it runs no `luvus uhp events` process, and the first watched child starts one

#### Scenario: One stream per process
- **WHEN** a pi process watches several child subagents
- **THEN** the process reads its events from one stream, not one stream per child

#### Scenario: No watchers left
- **WHEN** the last watched child finishes and no other child is watched
- **THEN** the extension stops the stream process

### Requirement: Stream restart and snapshot
The extension SHALL restart a stopped event stream with a bounded delay. It SHALL NOT require a resume cursor. After every stream start or restart, and on a resync-required frame, the extension SHALL run `luvus agent list` once before it treats stream events as authoritative.

#### Scenario: Restart after the stream stops
- **WHEN** the `luvus uhp events` process exits unexpectedly
- **THEN** the extension restarts it after a bounded delay and runs `luvus agent list` once before it acts on the new events

#### Scenario: Resync required
- **WHEN** the stream reports that a resync is required
- **THEN** the extension runs `luvus agent list` once before it processes further events

### Requirement: Only status and lifecycle events trigger checks
The extension SHALL treat only a small fixed list of event names as a trigger for a watched pane: agent status change, terminal exited, pane closed, and terminal closed. It SHALL match a frame to a pane through the `pane` or the `pane_id` field. It SHALL ignore malformed lines and unknown events. It SHALL track the last sequence number for diagnostics only.

#### Scenario: Output event is not a trigger
- **WHEN** the stream carries a high-volume output event for a watched pane
- **THEN** the extension does not start a completion check for that event

#### Scenario: Status event is a trigger
- **WHEN** the stream carries an agent status change or a pane close for a watched pane
- **THEN** the extension starts a completion check for that pane

#### Scenario: Malformed line
- **WHEN** a stream line is not valid JSON, or names an event the extension does not know
- **THEN** the extension ignores the line and keeps reading

### Requirement: Stream shutdown kills the child
The extension SHALL kill the `luvus uhp events` child on abort and on `session_shutdown`. It SHALL NOT rely on the child exiting by itself.

#### Scenario: Session shutdown
- **WHEN** the pi session shuts down while the stream runs
- **THEN** the extension kills the stream child

#### Scenario: Abort
- **WHEN** the watcher aborts
- **THEN** the extension kills the stream child
