# portable-launch Specification

## Purpose
Launch pi children in Luvus panes through a shell-free, platform-independent Node CLI (`cli.ts`) and launch-spec JSON, so the pi-parent extension and external orchestrators start, resume and close children the same way on Linux, macOS and Windows.

## Requirements

### Requirement: No shell or Unix tools required
Launching, resuming, running and completing subagents, from a pi parent or through the skill, together with the Claude Code stop hook, SHALL need only `node`, the child CLI (`pi` or `claude`) and the Luvus binary at `$LUVUS_BIN_PATH`. None of these paths SHALL execute `bash`, `sh`, `cmd`, `powershell`, `awk`, `grep`, `sed`, `openssl` or `python3`. Git-Bash, WSL or another Unix compatibility layer SHALL NOT be required on Windows. The package SHALL ship no shell scripts outside documentation.

#### Scenario: No bash installed
- **WHEN** `start`, `run`, `resume` and the stop hook run with a `PATH` that holds no `bash`, `sh`, `awk`, `grep`, `sed`, `openssl` or `python3`
- **THEN** each completes with the same results as on a machine that has them

#### Scenario: No shell scripts shipped
- **WHEN** the tracked files are listed
- **THEN** no `.sh` file and no file with a shell shebang exists outside `openspec/` and Markdown code blocks

### Requirement: Processes are spawned with argument arrays
Every child process (Luvus, pi, claude) SHALL be started with an executable and an argument array, without a shell. No argument SHALL be built by interpolating values into a command string.

#### Scenario: Metacharacters stay literal
- **WHEN** a child name, task path or working directory contains spaces, quotes, `;`, `&` or `$(...)`
- **THEN** the child receives each value as one argument, unchanged, and no other command runs

### Requirement: Pane command line is shell-neutral
The one command line sent to a pane with `luvus pane run` SHALL parse the same in bash, zsh, fish, PowerShell and cmd.exe. Its first token SHALL be the bare word `node`. Every later token SHALL be double-quoted, and SHALL NOT contain a double quote, a backtick, `$`, `%`, `!`, a backslash pair or a control character. Otherwise the launch MUST fail before any pane is split, with an error naming the offending path.

#### Scenario: Path with spaces
- **WHEN** the scratch directory is `C:\Users\Jo Smith\scratch` or `/tmp/sc ratch`
- **THEN** the pane command line double-quotes that path, and the launch succeeds

#### Scenario: Unsafe path
- **WHEN** the launch-spec path would contain `$` or `%`
- **THEN** the launch fails before `pane split` with an error naming the path

### Requirement: Run wrapper reports every exit
The pane-side run wrapper SHALL print `__SUBAGENT_DONE_<code>__` on its own line whenever the child ends, and exit with that code. `<code>` is the child's exit code, 128 plus the signal number when a signal ended it, or 127 (after printing the error) when it could not start. While the child runs, the wrapper SHALL ignore interrupt signals, so that Ctrl-C reaches the child.

#### Scenario: Child not found
- **WHEN** the child executable cannot be resolved
- **THEN** the pane shows an error naming it, followed by `__SUBAGENT_DONE_127__`

#### Scenario: Ctrl-C in the pane
- **WHEN** the user presses Ctrl-C while the child runs and the child keeps running
- **THEN** the wrapper is still alive and prints the sentinel only when the child exits

### Requirement: pi is resolved without a shell
The run wrapper SHALL resolve the pi executable in the pane, in this order: `PI_LUVUS_PI_ENTRY` (a pi JavaScript entry file, run with the current `node`); on Windows, the pi package entry next to an npm `pi.cmd` shim found on `PATH`, run with the current `node`; otherwise `pi` found on `PATH`. A Windows `.cmd` or `.bat` shim SHALL NOT be executed directly.

#### Scenario: Windows npm install
- **WHEN** the wrapper runs on Windows and `PATH` holds an npm `pi.cmd` shim next to `node_modules/@earendil-works/pi-coding-agent`
- **THEN** pi starts as `node <package bin entry> ...`, with no shell

#### Scenario: Explicit entry
- **WHEN** `PI_LUVUS_PI_ENTRY` names an existing file
- **THEN** pi starts as `node <that file> ...` on any platform

### Requirement: Portable paths
Launch code SHALL build file paths with the platform's path functions. It SHALL decide whether a path is absolute with the platform's rule, put temporary files under the platform temp directory, and take file names from paths with the platform's basename. Role files SHALL parse the same with LF and CRLF line endings.

#### Scenario: Claude sentinel location
- **WHEN** a Claude Code subagent is launched
- **THEN** its sentinel file is under the platform temp directory, not a hard-coded `/tmp`

#### Scenario: Platform-absolute cwd
- **WHEN** a role's `cwd` is absolute by the host platform's rules (for example `C:\work` on Windows)
- **THEN** it is used as-is, not joined onto the agent config directory

### Requirement: Claude stop hook runs under node
The Claude Code `Stop` hook SHALL run as `node "<plugin root>/hooks/on-stop.ts"`. It SHALL exit 0 without writing when `stop_hook_active` is true, `PI_CLAUDE_SENTINEL` is unset, or input is malformed. Otherwise it SHALL write the transcript path to `<sentinel>.transcript`, and write `last_assistant_message` to the sentinel only when the transcript holds exactly one user entry with string content.

#### Scenario: Autonomous completion
- **WHEN** the hook receives a transcript with one string-content user message and `PI_CLAUDE_SENTINEL` is set
- **THEN** the sentinel holds `last_assistant_message` and `<sentinel>.transcript` holds the transcript path

#### Scenario: User interjected
- **WHEN** the transcript holds two string-content user messages
- **THEN** only `<sentinel>.transcript` is written

#### Scenario: Loop guard
- **WHEN** the input has `stop_hook_active: true`
- **THEN** the hook exits 0 and writes nothing

### Requirement: Unit tests need no shell
`npm test` SHALL run the launch, run-wrapper, Luvus-backend and hook tests without spawning a shell and without writing a shell stub. Luvus calls SHALL be replaced in-process. Stub children SHALL be Node scripts run with the current `node`.

#### Scenario: Test suite on a machine without bash
- **WHEN** `npm test` runs where no `bash` or `sh` is on `PATH`
- **THEN** the launch, run-wrapper, Luvus-backend and hook tests run and pass
