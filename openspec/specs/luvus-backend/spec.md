# Luvus Backend

## Purpose

Defines how the subagents extension opens, drives, observes, interrupts and closes subagent panes through the Luvus CLI. Luvus is the only supported terminal host.

## Requirements

### Requirement: Luvus environment is required
The extension SHALL treat Luvus as available only when the `LUVUS_ENV`, `LUVUS_BIN_PATH` and `LUVUS_PANE_ID` environment variables are all set and non-empty. When any of them is missing, `luvus_spawn` and `luvus_resume` MUST NOT spawn anything. Each MUST instead return an error result telling the user to run pi inside Luvus. No other terminal backend and no headless fallback SHALL exist.

#### Scenario: Spawn outside Luvus
- **WHEN** `luvus_spawn` is called and `LUVUS_PANE_ID` is unset
- **THEN** the tool returns an error result whose text says subagents require running pi inside Luvus, and no pane or process is created

#### Scenario: Other multiplexer present
- **WHEN** pi runs inside tmux (the `TMUX` variable is set) but the `LUVUS_*` variables are unset
- **THEN** `luvus_spawn` returns the same "run pi inside Luvus" error

### Requirement: Luvus binary is invoked by exact path
Every Luvus CLI call SHALL execute the binary at `$LUVUS_BIN_PATH` directly, without a shell and without searching `PATH`.

#### Scenario: A different luvus is on PATH
- **WHEN** `PATH` contains a different `luvus` executable than `$LUVUS_BIN_PATH`
- **THEN** all pane operations run the `$LUVUS_BIN_PATH` binary

### Requirement: Subagent pane creation
Spawning or resuming a subagent SHALL split the caller's pane (`$LUVUS_PANE_ID`) without moving focus, take the new pane's id from the CLI's JSON result, and name the pane after the subagent. If the split returns an error or no pane id can be found, the tool MUST return an error result that includes the Luvus error message.

The extension SHALL also title the new pane: the run wrapper writes an OSC 2 title sequence to the pane's terminal after a delay, so that the emission lands after the child has initialized its terminal (a title emitted before the child boots is wiped when the child enters the alternate screen). The title text SHALL be `"<name> — <task>"`, where `<task>` is the first non-empty line of the task (or of the resume message), truncated to 48 characters. When no task text is available, the title SHALL be the name alone. Title text SHALL be sanitized: control characters, escape-sequence introducers and OSC terminators SHALL be removed from the derived title, so that untrusted task text cannot inject terminal control sequences. Title emission SHALL be best-effort: a failure to emit the title SHALL NOT fail the spawn, alter the tool result, or change the child's exit code. The caller's own pane SHALL NOT be titled by this extension.

When the resolved placement for the spawn is `tab`, the extension SHALL also move the new pane to its own workspace tab with `pane move <id> --new-tab`, and then restore focus to the caller's tab. The caller's tab SHALL be determined from the Luvus `agent list` result before the move, by finding the entry whose pane id equals `$LUVUS_PANE_ID`. When the caller's tab cannot be determined, the extension SHALL keep the pane placement instead of moving the pane. Focus restore SHALL be best-effort: if `tab focus` fails, the tool SHALL NOT fail.

#### Scenario: Successful spawn
- **WHEN** `luvus_spawn` is called with name "Scout" inside Luvus
- **THEN** a new pane appears next to the caller's pane, focus stays on the caller's pane, and the new pane is named "Scout"

#### Scenario: Pane carries an OSC title
- **WHEN** `luvus_spawn` is spawned with name "Scout" and a task whose first line is "Fix the login bug"
- **THEN** the pane's run wrapper emits an OSC 2 sequence whose title text is `Scout — Fix the login bug`, sanitized of control characters

#### Scenario: Task text is hostile
- **WHEN** the task's first line contains escape sequences or control characters (for example an embedded `ESC [2J`)
- **THEN** the emitted title contains the printable characters only, with the control sequences stripped

#### Scenario: No task text
- **WHEN** `luvus_spawn` is called with an empty task
- **THEN** the pane's OSC title is the subagent name alone

#### Scenario: Resume
- **WHEN** `luvus_resume` opens a session with name "Resume"
- **THEN** the resumed pane's run wrapper emits an OSC 2 title derived from the name and, when provided, the follow-up message

#### Scenario: Title emission is best-effort
- **WHEN** writing the title sequence fails (for any reason)
- **THEN** the subagent still launches and the tool result is unchanged

#### Scenario: Tab placement
- **WHEN** `luvus_spawn` is spawned with placement `tab` inside Luvus
- **THEN** the new pane is moved to its own workspace tab, named after the subagent, and focus returns to the caller's tab so the user's input stays with the caller

#### Scenario: Caller tab unknown
- **WHEN** `agent list` returns no entry whose pane id equals `$LUVUS_PANE_ID` and placement is `tab`
- **THEN** the subagent opens as a plain split of the caller's pane instead of being moved to a tab

#### Scenario: Focus restore fails
- **WHEN** the `tab focus` call after a `pane move` fails
- **THEN** the spawn still succeeds and the tool result does not report an error

#### Scenario: Split fails
- **WHEN** the Luvus CLI answers the split with an `error` object
- **THEN** the tool returns an error result containing that error's message, and nothing is run in a pane

### Requirement: Subagent launch runs in the pane
For every pi and Claude Code subagent launch and resume, the extension SHALL write a launch spec file and run one command line in the new pane through `luvus pane run`: `node "<cli.ts>" run "<spec>"`. No shell script SHALL be written, and the command line SHALL NOT depend on which interactive shell the pane runs. The pane-side wrapper SHALL print `__SUBAGENT_DONE_<code>__` after the child exits. For pi-parent launches it SHALL NOT close the pane, because the parent closes the pane after it reads the result.

#### Scenario: Fish user shell
- **WHEN** the user's `SHELL` is fish and a subagent is spawned
- **THEN** the pi child starts, and a crash still prints the `__SUBAGENT_DONE_<code>__` sentinel with the child's exit code

#### Scenario: No script file
- **WHEN** a subagent is spawned or resumed
- **THEN** no `.sh` file is written, and the only text sent with `pane run` is the single `node ... run ...` command line

#### Scenario: Parent owns the close
- **WHEN** a pi-parent child exits after writing a `done` sidecar
- **THEN** the wrapper leaves the pane open, and the parent's completion detection reads the sidecar and closes the pane

### Requirement: Completion detection
The extension SHALL detect completion from the `<session>.jsonl.exit` sidecar file first. It SHALL use the pane's recent output only as a fallback, matching the `__SUBAGENT_DONE_<code>__` sentinel to catch crashed children. While the Luvus event stream is running, an event for the child's pane SHALL start an immediate check of the sidecar, the sentinel file, and the pane output, and the extension SHALL NOT read the pane output on a fixed interval. The extension SHALL run `luvus agent list` once after each stream start or restart before it treats stream events as authoritative, and SHALL use that pane state to confirm a sentinel match instead of an `agent list` call per match. An event alone SHALL NOT end the wait. While the event stream is not running, the extension SHALL detect completion as it did before this change. When the poll ends for any reason (done, ping, sentinel, error or abort), the extension SHALL close the subagent's pane through the Luvus CLI, as upstream does. For Claude Code subagents without a sentinel summary, the extension SHALL read up to 200 lines of pane output as the summary before closing. A failure to close the pane MUST NOT change the result that the sidecar or sentinel produced.

#### Scenario: Normal completion
- **WHEN** the child calls `luvus_done` and the `.exit` file appears
- **THEN** the parent receives the result and the subagent's pane is closed

#### Scenario: Child crashes
- **WHEN** the child pi exits without writing an `.exit` file
- **THEN** the parent detects the sentinel in the pane output and reports the exit code

#### Scenario: Pane already closed
- **WHEN** the child writes a `done` `.exit` file and the pane is closed before the parent closes it
- **THEN** the parent reports the child's successful result with exit code 0, not a subagent error

#### Scenario: Event before the sidecar
- **WHEN** an event for the child's pane arrives and neither the `.exit` file nor the sentinel exists yet
- **THEN** the parent keeps waiting, and later reports the result from the sidecar or the sentinel

#### Scenario: Event stream not running
- **WHEN** the Luvus event stream is not running
- **THEN** the parent detects completion with its previous polling behavior

### Requirement: Interrupt sends Escape through Luvus
`luvus_interrupt` SHALL send Escape to the target subagent's pane with the Luvus agent-keys command. If the command fails, the tool MUST return an error that names the subagent and gives the Luvus error.

#### Scenario: Interrupt a running subagent
- **WHEN** `luvus_interrupt` is called for a running subagent
- **THEN** its pane receives Escape, the child's current turn is aborted, and the subagent keeps running

#### Scenario: Pane already gone
- **WHEN** the agent-keys command fails because the pane no longer exists
- **THEN** the tool returns an error of the form `Failed to send Escape to subagent "<name>" via Luvus: <message>`

### Requirement: Current pi packages
The extension SHALL import from `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` and load in the current pi release. No `@mariozechner/*` import SHALL remain.

#### Scenario: Load in current pi
- **WHEN** pi (the `@earendil-works` release) starts with the extension installed
- **THEN** it registers all subagent tools and commands without import or type errors
