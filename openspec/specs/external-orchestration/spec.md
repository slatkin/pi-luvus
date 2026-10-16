# external-orchestration Specification

## Purpose
Defines the contract that lets an orchestrator that is not a pi session, such as Claude Code, run pi subagents in Luvus panes. It covers the packaged skill, how it launches children, how they report and close, and how they resume.

## Requirements

### Requirement: Packaged orchestration skill
The package SHALL ship a `pi-luvus` skill at `skills/pi-luvus/` with its `SKILL.md` and a TypeScript launcher shim, `launch.ts`, which runs under `node`. The skill directory MUST NOT contain shell scripts. The skill MUST be installable with the `npx skills` CLI from the GitHub repository or a local checkout, and MUST work when the CLI copies the directory instead of linking it. It MUST be included in the published npm files. The pi manifest MUST NOT register the skill. `SKILL.md` SHALL tell the orchestrator that a `luvus wait agent-status` result is only a hint and must be confirmed against `<session>.exit`, because a pane with no status lease can read `done` at once.

#### Scenario: Install from GitHub
- **WHEN** a user runs `npx skills add slatkin/pi-luvus -g -a claude-code`
- **THEN** the `pi-luvus` skill, with `launch.ts`, is installed for Claude Code

#### Scenario: Copied install still launches
- **WHEN** the skill directory is a copy outside any checkout and the extension is installed through pi's git install
- **THEN** `node <skill-dir>/launch.ts start ...` finds the extension and launches the child

#### Scenario: Pi does not load the skill
- **WHEN** the package is installed into pi with `pi install`
- **THEN** pi's skill list does not include `pi-luvus`

### Requirement: Child extension lookup
The skill launcher SHALL find the package root, meaning a directory that holds `pi-extension/luvus/cli.ts` and `luvus-done.ts`, in this order: the `PI_LUVUS_DIR` directory, then the checkout containing the launcher's resolved real path, then pi's git install of this package under the pi agent directory (`PI_CODING_AGENT_DIR`, or `~/.pi/agent`, followed by `git/github.com/slatkin/pi-luvus`). Paths SHALL be built with the platform's path rules. The child SHALL be launched with `-e` on that root's `luvus-done.ts`. When no candidate holds the files, the launcher MUST exit non-zero, print an error naming the `pi install` command and the candidates searched, and create no pane.

#### Scenario: Dev override
- **WHEN** `PI_LUVUS_DIR` points at a checkout containing `pi-extension/luvus/luvus-done.ts`
- **THEN** the child is launched with `-e` on that file

#### Scenario: Extension not installed
- **WHEN** no candidate location holds the extension
- **THEN** the launcher exits non-zero with an error naming `pi install`, and no Luvus pane is split

### Requirement: Luvus is required for launch
`start` and `resume` SHALL refuse to run unless `LUVUS_ENV`, `LUVUS_BIN_PATH` and `LUVUS_PANE_ID` are all set. They SHALL call Luvus only through `$LUVUS_BIN_PATH`.

#### Scenario: Run outside Luvus
- **WHEN** `start` runs with `LUVUS_PANE_ID` unset
- **THEN** it exits non-zero with an error saying it must run inside Luvus, and creates nothing

### Requirement: Role resolution
`start` SHALL resolve a role name with the same lookup the extension uses: the `.pi/agents/` directory of the child's working directory, then the global agents directory (`PI_CODING_AGENT_DIR`, or `~/.pi/agent`, followed by `agents/`), then the package's `agents/`. The first file that exists wins. It SHALL use the frontmatter `model`, `thinking` and `tools` fields, the `auto-exit` flag, and the body as the appended system prompt. Role files with LF or CRLF line endings SHALL parse the same way. An unknown role, or a role whose `model` is empty, MUST fail before a pane is split.

#### Scenario: Auto-exit role
- **WHEN** the resolved role's frontmatter has `auto-exit: true`
- **THEN** the child runs with `PI_LUVUS_AUTO_EXIT=1`

#### Scenario: Control tools always present
- **WHEN** the role's `tools` list omits `luvus_done`
- **THEN** the child's `--tools` still includes `caller_ping`, `luvus_done` and `luvus_message`

#### Scenario: Unknown role
- **WHEN** no role file matches the given role name
- **THEN** `start` exits non-zero naming the role and the paths searched, and splits no pane

#### Scenario: Empty model
- **WHEN** the role's frontmatter has `model:` with no value, followed by other fields
- **THEN** `start` exits non-zero saying the role has an empty model, and splits no pane

#### Scenario: CRLF role file
- **WHEN** the role file uses CRLF line endings
- **THEN** its model, tools, auto-exit flag and body resolve the same as the LF version

### Requirement: Launch contract
`start` SHALL split a new pane next to the caller's pane without taking focus and name it after the child. It SHALL write a launch spec that starts pi with `--session`, the env vars `luvus-done.ts` reads (with `PI_LUVUS_SESSION` equal to `--session`), and the brief as the prompt. It SHALL then run that spec in the pane. On success it SHALL print exactly one JSON document on stdout, giving the pane id, the session file and the launch-spec path. Everything else SHALL go to stderr.

#### Scenario: Successful launch
- **WHEN** `start` is given a child name, a role, a working directory, a brief file and the parent's name
- **THEN** a new named pane runs pi in that directory with that session, and stdout is JSON with `pane`, `session` and `launch`

#### Scenario: Hostile names and paths
- **WHEN** the child name contains `;`, `$(...)` and a single quote, and the scratch directory contains a space
- **THEN** the launch succeeds, pi receives the prompt path as one argument, and no injected command runs

### Requirement: Parent-contact footer
`start` SHALL append a footer to the brief that gives the parent's name and pane. The footer SHALL tell the child to send its final report or question with `luvus agent send <parent>` before it stops, and then call `luvus_done`. It SHALL tell the child not to use `caller_ping` or `luvus_message` to reach the parent.

#### Scenario: Footer names the parent
- **WHEN** `start` runs with parent name `orch` from pane `12`
- **THEN** the prompt the child receives ends with a footer containing `luvus agent send orch` and pane `12`

### Requirement: Close on done
After the child exits, the skill-path run wrapper SHALL print `__SUBAGENT_DONE_<exit code>__`. It SHALL then close its own pane through Luvus only when `<session>.exit` parses as JSON with `type` equal to `done` or `handoff`, and only after a grace period. The grace period SHALL default to 5000 ms, SHALL be set per launch with `start --close-grace-ms <n>`, and SHALL be stored in the launch spec so that a resume reuses it. A value of `0` closes at once. For any other `.exit` content, unparseable content, or no `.exit`, the pane MUST stay open with the sentinel visible. The wrapper MUST NOT delete the `.exit` file.

#### Scenario: Clean completion
- **WHEN** the child calls `luvus_done` and pi exits
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds `{"type":"done"}`

#### Scenario: Handoff completion
- **WHEN** the child calls `luvus_done` with a `handoff` and pi exits
- **THEN** after the grace period the child's pane closes, and `<session>.exit` still holds the `handoff` sidecar

#### Scenario: External wait observes done before close
- **WHEN** an orchestrator is blocked in `luvus wait agent-status <pane> --status done,blocked` and the child completes with `luvus_done` under the default grace period
- **THEN** the wait exits 0 before the pane closes

#### Scenario: Immediate close
- **WHEN** the child was started with `--close-grace-ms 0` and completes with `done`
- **THEN** the wrapper closes the pane immediately after printing the sentinel

#### Scenario: Provider error
- **WHEN** pi exits after writing an `error` `.exit`
- **THEN** the pane stays open showing `__SUBAGENT_DONE_<code>__`

#### Scenario: Crash
- **WHEN** pi exits without writing an `.exit` file
- **THEN** the pane stays open showing `__SUBAGENT_DONE_<code>__`

#### Scenario: Malformed sidecar
- **WHEN** `<session>.exit` holds text that is not JSON, or JSON whose `type` is not `done` or `handoff`
- **THEN** the pane stays open

### Requirement: Resume in a new pane
`resume --launch <spec> --prompt <file> [--name <child>]` SHALL split a new pane, name it (after `--name`, or the child name stored in the spec), and run the existing launch spec there with the new prompt, so that pi resumes the same session with its context. Resume MUST NOT need the child's previous pane to exist. On success it SHALL print JSON with `pane` and `launch`.

#### Scenario: Resume after close-on-done
- **WHEN** a child's pane closed on done and the orchestrator resumes it with a follow-up prompt
- **THEN** a new pane runs pi on the same session file, and the child keeps its earlier context

### Requirement: Per-child launch spec
`start` SHALL write a per-child launch spec under the scratch directory. It holds everything needed to start the child except its pane and prompt. The run wrapper SHALL set `PI_LUVUS_SURFACE` from `LUVUS_PANE_ID` at runtime, so that the spec can run in any later pane. An invalid spec SHALL make the wrapper exit non-zero, naming the file, without starting a child.

#### Scenario: Spec is pane-independent
- **WHEN** the launch spec runs in a pane other than the one it was written for
- **THEN** the child reports `PI_LUVUS_SURFACE` as that pane's id

#### Scenario: Corrupt spec
- **WHEN** `run` is given a spec file that is not valid JSON or lacks the child command
- **THEN** it exits non-zero naming the file, and no child starts

### Requirement: Default tool list
A role with no `tools` frontmatter line SHALL run with the default tools `read,bash,edit,write,grep,find,ls` plus `caller_ping`, `luvus_done` and `luvus_message`. This SHALL apply to skill launches and pi-parent launches alike, from a single shared definition. For pi-parent launches this is an intended narrowing: such roles previously received every pi tool.

#### Scenario: Role without tools
- **WHEN** the resolved role has no `tools` line
- **THEN** the child's `--tools` is `read,bash,edit,write,grep,find,ls,caller_ping,luvus_done,luvus_message`

#### Scenario: Pi parent spawns a role without tools
- **WHEN** a pi parent calls `luvus_spawn` with a role that has no `tools` line and no `tools` parameter
- **THEN** the child gets the same default list plus the control tools, not every pi tool

### Requirement: Last assistant message lookup
The CLI SHALL provide `last-message --session <file>`, which prints the text of the session's last assistant message, or `(no assistant message)` when there is none. It uses the extension's own session reader. `SKILL.md` SHALL use this command for the report cross-check instead of an inline script.

#### Scenario: Cross-check a report
- **WHEN** an orchestrator runs `last-message --session <file>` on a finished child's session
- **THEN** stdout is the text blocks of the last assistant message that has non-empty text

### Requirement: Skill documents the handoff sidecar
`SKILL.md` SHALL tell the orchestrator that a child can end with `{"type":"handoff","message":...}` in `<session>.exit`. It SHALL say that the task is not complete, that the handoff text is in the sidecar, that the pane closes itself after the close grace as for `done`, and that the orchestrator continues the task with a new child through `start`, with the handoff text in the brief.

#### Scenario: Orchestrator reads a handoff
- **WHEN** an orchestrator follows `SKILL.md` and finds a `handoff` sidecar
- **THEN** the skill tells it to start a new child with the handoff text in its brief, not to resume the old session

#### Scenario: Pane gone after the grace
- **WHEN** a `wait` on a child's pane finds no pane after the close grace
- **THEN** the skill tells the orchestrator to read `<session>.exit`, where `done` means finished and `handoff` means continue with a new child
