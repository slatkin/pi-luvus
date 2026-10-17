# Tasks

## 1. Move the lifecycle into the supervisor (no behavior change)

- [ ] 1.1 Create `pi-extension/luvus/supervisor.ts` with `createSupervisor(deps)` (D1). Move `RunningSubagent`, the running map, the roster context and `writeRoster`, `observeRunningSubagent`, the interrupt helpers, the widget and status refresh, `launchSubagent`, `watchSubagent`, `deliverSubagentCompletion` and `deliverSubagentError` into it, and inject `send`, `ui`, the Luvus operations and the event stream. Verify with `pnpm run typecheck`.
- [ ] 1.2 Make `index.ts` create the supervisor and delegate `luvus_spawn`, `luvus_resume` (still with its current inline launch, now calling supervisor methods to register and watch), `luvus_interrupt`, `luvus_message` and the widget to it. Replace the four `Symbol.for` keys with one supervisor key, and implement the reload, `session_start` and `session_shutdown` rules (D2). Verify that `grep -n "Symbol.for" pi-extension/luvus/index.ts` shows one key and that `pnpm test` passes.
- [ ] 1.3 Add `test/supervisor.test.ts` with fake deps (D7). Move the lifecycle tests from `test/test.ts` (launch spec, Claude launch spec, watch with the pane already gone for both backends, handoff delivery, interrupt, roster add and remove, abort on shutdown) to the supervisor interface. Remove the matching `__test__` entries, the `runningSubagents.clear()` and `setRosterContext(null)` resets, and their `(mod as any)` casts. Add one test: shutting down a supervisor aborts its watchers and clears its intervals, and a second supervisor created after that starts with an empty map. Verify that `pnpm test` passes and that `grep -n "runningSubagents\|setRosterContext" test/` finds nothing.

## 2. Backend table

- [ ] 2.1 Add the pi and Claude Code backend entries (D4) with `buildLaunch`, `observes`, `interrupt`, `extractResult` and `afterExit`, and replace every `cli === "claude"` check in the supervisor with a lookup. Verify that `grep -n '=== "claude"' pi-extension/luvus/supervisor.ts` finds only the table, and that the moved tests from 1.3 pass unchanged.

## 3. Launch record at spawn

- [ ] 3.1 Add the launch record type, `writeLaunchRecord` (temp file and rename) and `readLaunchRecord` (returns `null` for a missing or invalid file) (D3). Verify with unit tests: a round trip, a missing file, invalid JSON, a wrong `version`, and a record with no per-run fields.
- [ ] 3.2 Make spawn resolve the agent defaults into a record, write `<session>.launch.json` before it runs the pane line, and build the `LaunchSpec` from the record and the run binding. Verify in `test/supervisor.test.ts` with fake Luvus: a pi spawn of an agent with `spawning: false` and a `cwd` writes a record with backend `pi`, the agent, the cwd and the denied spawning tools, and no task text and no subagent id. A Claude Code spawn writes backend `claude`. The written `LaunchSpec` argv and env match the values from before this change.

## 4. Resume from the record

- [ ] 4.1 Change the `luvus_resume` schema to `sessionPath`, `message`, `surface` and `autoExit`, and route it to `supervisor.resume`. Remove the inline launch code from `index.ts`. Verify that the existing schema registration test is updated for the new fields and passes.
- [ ] 4.2 Implement resume for pi from the record: the record's name, agent, cwd, model, tools, role prompt and denied tools, a new run binding, the `autoExit` and interactive rules, and the messaging hint followed by the message in the resume prompt file (D5). Verify in `test/supervisor.test.ts`: the resume `LaunchSpec` holds `PI_DENY_TOOLS` and `PI_LUVUS_AGENT` from the record and the record's `cwd`, and the pane is named after the record. `autoExit` absent uses the record, and `autoExit: false` makes the run interactive. With a running sibling `Reviewer`, the prompt file names `parent` and `Reviewer` and then holds the message.
- [ ] 4.3 Implement the fallback with no record (plain pi resume named `Resume`, auto-exit on unless `autoExit` is false) and the "role configuration was not restored" note in the tool result. Verify with one test that has no record and one that has an invalid record.
- [ ] 4.4 Use one delivery path for spawn and resume with `entryCountBefore` (D6). Details hold `name`, `task` and `agent`, and the session line names `luvus_resume` with the session file in place of `pi --session`. Verify with tests: a resumed child's summary is the assistant message written after the resume, a resumed child's ping carries `agent`, and a spawned child's result has no `pi --session` text. Update the existing result-presentation tests that check the old `Resume:` line.

## 5. Claude Code resume

- [ ] 5.1 In the Claude Code `afterExit`, store `claudeSessionId` in the record, and return `sessionFile` in Claude Code results. Verify with a test: after a fake Claude Code run with a transcript, the record holds the session id and the result holds the session file.
- [ ] 5.2 Implement Claude Code resume from the record (`--resume <id>`, then the message), and return an error with no pane when the record has no session id. Remove `resumeSessionId` from the `luvus_spawn` schema and launch code. Verify with tests: the resume `LaunchSpec` args end with `--resume <id>` and the message, a record with no id creates no surface, and the `luvus_spawn` schema has no `resumeSessionId`.

## 6. Documentation

- [ ] 6.1 Update `README.md`: say that `luvus_resume` resumes pi and Claude Code children with the role from the spawn, list its parameters, and note that `resumeSessionId` and the resume `name` parameter were removed. Check the text by hand, because Prettier does not format markdown, and verify that it says nothing about Luvus behavior.

## 7. Integration checks

- [ ] 7.1 Run `pnpm test`, `pnpm run lint`, `pnpm run format:check` and `pnpm run typecheck`, and verify that all pass, with the `external-orchestration` tests in `test/cli.test.ts` unchanged.
- [ ] 7.2 Run `openspec validate subagent-supervisor --strict` and verify that it passes.

## Workflow follow-up

- The user does the live acceptance: spawn a scout with `spawning: false`, let it finish, resume it with a message, and check that it has no `luvus_spawn` and runs in the spawn cwd. Then resume a Claude Code child by its session file.
- Archive the change after review.
