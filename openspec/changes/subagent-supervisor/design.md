# Design

## Context

See proposal.md for the motivation. The current shape:

```
luvus_spawn  --> launchSubagent()  (claude branch | pi branch) --+
luvus_resume --> ~150 inline lines: own surface, spec, env,      +--> watchSubagent() --> deliverSubagent*()
                 RunningSubagent, map, roster, intervals --------+
module state: runningSubagents, rosterContext, latestCtx, widget/status intervals,
              poll AbortController, UhpEventStream  (4 globalThis Symbol.for keys)
```

Constraints:

- `LaunchSpec` (launch.ts) is already "everything a pane needs except the pane and the prompt". `run.ts` sets `PI_LUVUS_SURFACE` from the running pane. The supervisor builds a `LaunchSpec` for each run and does not change its format.
- `cli.ts`, `run.ts`, `luvus-done.ts`, the env names that `luvus-done.ts` reads, and the `.exit` format stay as they are (`external-orchestration`).
- After `/reload`, closures from the old module load keep running. The new load must stop them. This code cannot prove that the old load's `session_shutdown` runs first.
- Tests must not need a real Luvus. The existing `__setLuvusExecForTests__` seam stays available.

## Goals / Non-Goals

**Goals:**
- One module owns the parent-side lifecycle, and both tool entry points use one launch path.
- One place decides each backend difference (pi or Claude Code).
- Each test creates its own supervisor, so tests need no global resets.

**Non-Goals:**
- No change to the widget's look, the status classification, or the idle watchdog rules. They move, but they do not change.
- Pure helpers that are not part of the lifecycle (widget border drawing, agent discovery, session-dir naming) stay where they are, with their current `__test__` entries.

## Decisions

### D1. `createSupervisor(deps)` in `supervisor.ts`

```
createSupervisor(deps) -> Supervisor
  spawn(params, ctx, { placement }) -> Promise<{ id, name }>
  resume({ sessionPath, message?, surface?, autoExit? }, ctx) -> Promise<ResumeAck | { error }>
  interrupt({ id?, name? }) -> InterruptResult
  running() -> ReadonlyArray<{ id, name, surface, ... }>   // widget, luvus_message
  shutdown()
deps: send(message, opts)          // pi.sendMessage, so tests need no pi object
      ui()                         // latest ctx.ui for the widget, or null
      luvus: { createSurface, runInPane, closeSurface, sendEscape, readScreen, pollForExit }
      events: () => UhpEventStream
      statusConfig, shellReadyDelayMs, now()
```

The supervisor owns the running map, the roster context and roster writes, the widget and status intervals, its own `AbortController`, and its event stream. Tool handlers do only the checks that come before a launch (self-spawn, Luvus availability, and for `luvus_spawn` the parent session file, which keeps its current error result). `resume` reads `<sessionPath>.launch.json` first and checks the session file and the record itself, so a Claude Code record without a session file still resumes.

Alternative: a module singleton. Rejected, because a later move of the runtime state would touch the same code a second time, and tests would still need global resets.

### D2. Supervisor lifetime and reload

- The registration function creates a supervisor and stores it in one `globalThis` key, `pi-luvus/supervisor#<module url>`. Before it does this, it calls `shutdown()` on the supervisor that the key already holds (from a previous load). This one key replaces the four current keys. The per-URL namespacing stays for the same reason as today.
- `session_shutdown` calls `shutdown()`. `session_start` replaces a supervisor that is already shut down with a new one. `shutdown()` is final for a supervisor, so no "re-arm" step remains.
- `shutdown()` aborts every watcher, clears both intervals, and stops the event stream. A watcher that is aborted still returns its `cancelled` result as today. This change does not add a rule about that delivery.

### D3. Launch record: role values, not argv

`<session>.launch.json`:

```json
{ version: 1, backend: "pi" | "claude", name, agent?, cwd, localAgentDir?,
  model?, thinking?, tools?, rolePrompt?, systemPromptMode?, denyTools: string[],
  autoExit: boolean, interactive: boolean, claudeSessionId? }
```

`cwd` is the working directory the spawn resolved: an explicit `cwd`, the
agent's `cwd`, or the parent's cwd. `localAgentDir` is the `.pi/agent`
directory the spawn adopted; it is absent when the spawn propagated the global
config dir, so a resume never adopts a local config the spawn did not use.

The spawn resolves the agent defaults once, writes the record, and then builds the run from the record. A resume reads the record and builds the run in the same way. So one builder per backend produces every `LaunchSpec`:

```
record + run binding + prompt  --buildLaunch(backend)-->  LaunchSpec  --> luvus-scripts/<name>-<id>.json
run binding = { id, activityFile, rosterFile, sentinelFile?, artifactDir, entryCountBefore }  (new for each run)
```

`entryCountBefore` is 0 for a spawn and the entry count of the session file for a pi resume. A Claude Code run has no pi-style session file, so its `entryCountBefore` is 0 and the pi summary path does not apply.

The record is written with a temp file and a rename, because a Claude Code completion updates it later with `claudeSessionId`. A record that is not valid is treated as missing (spec: Resume without a launch record).

Alternative: store the first run's `LaunchSpec` without the prompt, as the skill path does. Rejected. Its env holds per-run values (`PI_LUVUS_ID`, the activity file, the Claude Code sentinel) that a resume must find and replace. It holds the argv, but not the role values that a resume needs to build the messaging hint again or to report the agent in the result details.

Snapshot rule: the record keeps the role values from spawn time. A resume does not read the agent file again. A resume continues the same session, so the same role applies, even if the agent file changed after the spawn.

### D4. Backend table

```
              pi                                   claude
buildLaunch   --session, -e luvus-done.ts,         --dangerously-skip-permissions,
              --model[:thinking], --tools,         --plugin-dir, --model,
              system-prompt file, env parts        --append-system-prompt,
                                                   [--resume <id>], prompt text
observe       activity file                        none
interrupt     Escape                               unsupported (error, as today)
extractResult session .jsonl (after entry N)       sentinel, then screen read
afterExit     -                                    copy transcript, store claudeSessionId
```

`copyClaudeSession` today returns the transcript basename, `<uuid>.jsonl`. The record stores the Claude session id without the `.jsonl` extension, because `claude --resume` takes the session id, not a file name. A Claude Code spawn does not create the pi-style session file; the record sits beside the path that a later `luvus_resume` uses as its `sessionPath`.

`observeRunningSubagent`, `handleSubagentInterrupt`, and the two branches of `watchSubagent` each read the backend entry and no longer test `cli === "claude"` themselves.

### D5. Prompts for each kind of run

- Spawn, pi: the same as today: the task artifact or the direct task, plus skill prompts.
- Spawn, Claude Code: the same as today: the task as the last argument.
- Resume, pi: when a `message` is given, write `buildLaunchMessagingHint(running names)` and then the message to `luvus-resume/<name>-<ts>.md`, and pass it as `@file`. With no message, no prompt is sent (as today). The resume also writes the record's role prompt to a file and passes `--system-prompt` or `--append-system-prompt` as the record's `systemPromptMode` selects, because a pi session does not store those flags. When the record has no `systemPromptMode`, the spawn put the role prompt into the first task message, which the session keeps, so the resume passes no system-prompt flag.
- Resume, Claude Code: `resume` reads `<sessionPath>.launch.json` first. When the record backend is `claude`, the run does not require the pi-style session file to exist and `entryCountBefore` is 0. The run passes `--resume <claudeSessionId>`, and then the message text when one is given. When there is no record and no session file, the tool keeps its `session file not found` error.

### D6. Delivery inside the supervisor

`watchSubagent` and `deliverSubagentCompletion`/`deliverSubagentError` move into the supervisor and send through `deps.send`. A run carries `entryCountBefore` (0 for a spawn and for a Claude Code resume). The pi summary reads only the entries after it, which removes the resume-specific `present` closure. Details always hold `name`, `task` and `agent`, for result, ping, handoff and error messages alike. The session reference line changes from `Resume: pi --session <file>` to a line that names `luvus_resume` with the session file. The `luvus_result` expanded renderer shows the same line, so its `Resume:  pi --session` line changes with it. The handoff message keeps its text that says not to resume.

Claude Code results get `sessionFile` (the pi-style path that the record sits beside), so `luvus_resume` works with one input for both backends. `claudeSessionId` stays in the details for information. The record stores it without the `.jsonl` extension (D4).

### D7. Tests

New `test/supervisor.test.ts` creates a supervisor with fake `luvus`, `send` and `events` deps and a temporary artifact directory. The lifecycle tests in `test/test.ts` that use `__test__.launchSubagent`, `watchSubagent`, `deliverSubagentCompletion`, `runningSubagents`, `setRosterContext`, `getModuleAbortController` and the interrupt helpers move there. Pure builders (`buildSpawnEnvParts`, `buildSubagentTaskPrompt`, `resolveMessageTarget` and the others) become named exports of the module that holds them and are imported directly.

## Risks / Trade-offs

- [A large move in `index.ts` can hide a regression] → The tasks first move the code with no behavior change and keep the current tests passing, and only then change resume behavior.
- [The record's `cwd` was deleted after the spawn] → The child fails to start, and the run wrapper reports exit 127. The parent gets the normal failure result. No special handling.
- [The record snapshot misses a later fix to an agent file, for example a stricter deny list] → Accepted (D3). A fresh `luvus_spawn` uses the current file.
- [The Claude Code transcript copy fails, so no `claudeSessionId` is stored] → `luvus_resume` returns an error and starts nothing (spec). The orchestrator can spawn again.
- [A skill-launched session has no record] → It falls back to today's plain resume, and the result says so.
- [Removing `resumeSessionId` and resume `name` breaks a caller that uses them] → No packaged skill or agent uses them. The README notes the change.

## Migration Plan

No data migration. Sessions from before this change have no record and resume as they do today. Rollback is a revert. Any `<session>.launch.json` files that remain have no effect on older code.
