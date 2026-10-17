# Proposal

## Why

No module owns the parent-side subagent lifecycle. `index.ts` holds a 17-field `RunningSubagent` record, a launch → watch → deliver pipeline of about 600 lines, and four `globalThis` registry keys. Tests reach all of this only through a ~40-function `__test__` export (issue #4, candidate 1). `luvus_resume` also has a second copy of the launch bookkeeping, and that copy drops the role configuration. A resumed child loses its deny list, agent name, working directory, tool allowlist, role prompt and messaging hint. For example, a resumed scout with `spawning: false` gets `luvus_spawn` back. Claude Code children use a different resume API (`luvus_spawn` with `resumeSessionId`), so the orchestrator must remember the backend, the agent and the Claude session id.

## What Changes

- Add a subagent supervisor module. `createSupervisor()` runs inside the extension registration function and owns the running-subagent map, the widget and status intervals, the poll abort signal, the UHP event stream and the roster. Its interface is small: spawn, resume, interrupt, a read-only list of running children, and shutdown. One `globalThis` key stays. It holds the previous supervisor, so a reloaded module load can shut it down.
- Spawn writes a **launch record** beside the child session: `<session>.launch.json`. The record holds the reusable part of the launch (backend, agent, cwd, model, tools, role prompt, deny list, auto-exit, interactive). It does not hold the task prompt or per-run values.
- `luvus_resume` reads the launch record and starts the child with the same role configuration. Only `message`, `surface` and `autoExit` are overrides. The resumed child's name comes from the record. **BREAKING**: `luvus_resume` loses the `name` parameter. When no record exists (a session from before this change, or a skill-launched session), resume works as it does today, and the result says that the role configuration was not restored.
- `luvus_resume` resumes Claude Code children too. The Claude session id is stored in the launch record when the run ends. Claude results now also return the session file.
- **BREAKING**: `luvus_spawn` loses the `resumeSessionId` parameter. Use `luvus_resume` with the session file.
- A resumed pi child gets the same messaging hint (parent and running siblings) as a spawned child.
- The result message points at `luvus_resume` and the session file. It no longer shows `pi --session <file>`.
- The supervisor delivers result, ping, handoff and error messages itself through an injected send function. Spawn and resume use the same delivery path.
- Tests use the supervisor's interface with fakes. The `__test__` entries for the lifecycle, the manual `runningSubagents.clear()` and `setRosterContext(null)` resets, and the related `(mod as any)` casts are removed.

## Non-goals

- No change to `cli.ts`, `run.ts`, `luvus-done.ts`, the `PI_LUVUS_*` variables that `luvus-done.ts` reads, or the `.exit` sidecar format. `external-orchestration` must keep passing.
- Skill-path launches (`cli.ts start`) do not write a launch record.
- Issue #4 candidates 3, 4 and 5 (pane role, one phase vocabulary, luvus-backend grouping).

## Capabilities

### New Capabilities
- `subagent-supervision`: the pi parent's lifecycle for its subagents: the launch record, resume from the record for both backends, result delivery, and the per-session runtime that a reload shuts down.

### Modified Capabilities
- None. `luvus-backend`, `luvus-surface`, `luvus-messaging` and `luvus-completion` requirements stay true as written. The handoff message in `luvus-completion` already tells the parent not to resume.

## Impact

- Code: new `pi-extension/luvus/supervisor.ts`. `index.ts` keeps tool registration and delegates to the supervisor. `luvus_resume` and `luvus_spawn` parameter schemas change.
- Files: a new `<session>.launch.json` beside each child session that a pi parent spawns.
- Tests: `test/test.ts` lifecycle tests move to the supervisor interface, and new tests cover the launch record and resume.
- Docs: `README.md` tool table and any text that names `resumeSessionId`.
