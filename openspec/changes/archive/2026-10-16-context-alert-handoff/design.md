# Design

## Context

See proposal.md for the reasons. These facts about the current code shape the design:

- `luvus-done.ts` is the child-side module. Both orchestrator paths load it in every subagent child: the pi parent through the extension, and the skill launcher with `-e`. It already owns the `.exit` writes (`luvus_done`, `caller_ping`, error and auto-exit paths) and the completion nudge. It reads no config at this time.
- `status.ts` parses `config.json` (`status`, `notify`) with strict key checks (`rejectUnsupportedKeys`, `requireBoolean`). `loadStatusConfig()` throws on invalid config. `index.ts` calls it at module load, so a bad block stops the extension from loading in the parent. Children read the same file as the parent.
- pi gives `ctx.getContextUsage()`, which returns `ContextUsage | undefined`. `ContextUsage` is `{ tokens, contextWindow, percent }`, where `tokens` and `percent` are `null` when the size is unknown.
- In pi 1.3.0, `pi.sendUserMessage` goes through `prompt()`. `prompt()` awaits all extension `input` handlers (with `source: "extension"`) and only then queues the steer. The agent loop reads queued steer messages after it emits `turn_end`. So a steer sent from a `turn_end` handler normally starts the next turn in the same run. But it can arrive after that read, and then `agent_end` fires first. Error and aborted turns end the run without the read.
- The `input` handler in `luvus-done.ts` marks the session as taken over for any input after the first agent run, as the main spec "Nudge cancellation" requires. The alert steer is such input.
- `interpretExitSidecar` (`luvus.ts`) maps an unknown `type` to `done`. `run.ts` reads the raw `type` for the close rule, so malformed sidecars do not close panes.
- `run.ts` already wakes an external parent with `<child> <sidecar type> without sending a report` when the child did not send a report. A `handoff` child that forgets `luvus agent send` therefore still wakes the parent as `<child> handoff without sending a report`. No new code is necessary for this.
- AGENTS.md: Luvus process operations stay in `luvus.ts`. Its `__setLuvusExecForTests__` seam replaces every Luvus call in tests.

## Goals / Non-Goals

**Goals:**
- Keep the new pure logic in one new module with unit tests, and keep the edits to `luvus-done.ts`, `luvus.ts`, `run.ts`, and `index.ts` small.
- Do not change the existing sidecar kinds, the takeover rule, or how they are handled.

**Non-Goals:**
- An alert in the orchestrator, or one that does not use pi's context usage.
- A guarantee that the model obeys the alert. A child that ignores it stays open (see D3), gets the nudge, and can still finish with or without a handoff.

## Decisions

### D1. New module `context-alert.ts` (pure)

It holds:
- `parseContextAlertConfig(raw, source)`: returns `{ enabled, threshold }`, where `threshold` is `{ kind: "tokens", value }` or `{ kind: "percent", value }`. A percentage matches `^\d+(\.\d+)?%$` and must be in `(0, 100]`. A token count must be a positive integer. `parseStatusConfig` calls it and adds the result to `StatusConfig` as `contextAlert`. The error messages follow the style of `requireBoolean`.
- `shouldAlert(usage, threshold)`: `usage` is `ContextUsage | undefined`. It returns `true` only when the needed field (`tokens` or `percent`) is a number at or above the threshold.
- `alertText(tokens, threshold)` and `handoffNudgeText()`: the steer message and the nudge text after an alert.
- `handoffLogPath()`: `handoffs.jsonl` in the directory of `getDefaultConfigPath()`.
- `matchLuvusSession(list, socketPath)`: pure. From the parsed `{ "sessions": [{ name, socket_path, ... }] }` object, it returns the `name` whose `socket_path` equals `socketPath`, else `socketPath`. With no `socketPath`, it returns `null`.
- `appendHandoffLog(row, path)`: one `appendFileSync` call, and every error is caught.

Alternative: put everything in `luvus-done.ts`. That file is already 450 lines and has no seam for unit tests, so it is not a good place.

### D2. Config load in the child

`luvus-done.ts` calls `loadStatusConfig()` one time at module load, in a try/catch. On an error the alert is off and the module still registers `luvus_done`, the status, and the sidecar writes. The parent, or the user's own pi session, already reports the config error. If the child stopped loading, it would lose its control tools, which is worse.

### D3. Check at `turn_end`, deliver as `steer`, the alert is a takeover

In `luvus-done.ts`, the alert check goes in the existing `turn_end` handler (the one that calls `recorder.turnEnd`), after the recorder call. A second `turn_end` handler also works. The check runs only when `PI_LUVUS_SESSION` is set, the alert is on, the latch is not set, and `luvus_done` has not been called. It skips turns whose message has `stopReason` `error` or `aborted`. It sets the latch, sets `userTookOver = true`, calls `pi.sendUserMessage(alertText(...), { deliverAs: "steer" })` without waiting for it, and starts the `alert` log row without waiting for it. The latch is per pi process, the same as `doneCalled`, so a resume in a new process can fire the alert again. The latch is set before the send, so a failed send gives no second alert.

The alert goes through the `input` handler, so the session is marked as taken over (see Context). This change accepts that and adds no exception:
- An auto-exit child does not auto-exit after the alert. If it ends a turn without calling `luvus_done`, it stays open and gets the completion nudge.
- The handler sets `userTookOver` itself, before the send. The `input` handler also sets it later, but the send is not awaited, so `agent_end` could run before that `input` handler when the steer is late. With the mark set first, a late steer cannot cause an auto-exit `done` before the handoff, whatever the order of the async steps.
- When the latch is set, `scheduleAgentEndNudge` sends `handoffNudgeText()` in place of `NUDGE_TEXT`. The generic text says "your last message was already delivered as your report", which is wrong after an alert.

`followUp` is wrong for the alert, because pi delivers it only when the agent has no more work.

Alternative: exclude the alert from the takeover mark. That needs a MODIFIED "Nudge cancellation", a check of the input text or source, and an `agent_end` guard while the steer is pending. It is more code for a worse result, because a child that ignores the alert then auto-exits with `done`.

Alternative: check at `agent_end`. That is too late for a long run with many tool calls.

### D4. `luvus_done({ handoff })`

The schema gets `handoff: Type.Optional(Type.String())`. If the value is whitespace only, the tool throws before it changes any state, so the session stays open and the model can retry. When the value has text, the tool reports status `done`, writes `{"type":"handoff","message":handoff}`, starts the `handoff` log row without waiting for it, and calls `ctx.shutdown()`. The tool description tells the model to use `handoff` only after a context alert.

The status is `done` and not `blocked`. `luvus wait agent-status --status done,blocked` wakes on both, and the child ended cleanly. The orchestrator learns that the task is not complete from the sidecar.

Alternative: a separate `luvus_handoff` tool. That adds a fourth control tool to every role and changes the default tool list. A parameter costs less.

### D5. Parent side

- `PollResult.reason` gets `"handoff"` and an optional `handoff: { message }`. `interpretExitSidecar` maps `type: "handoff"` to it with `exitCode: 0`, the same as `done` and `ping`. If `message` is not a non-empty string, it uses the placeholder `(handoff text missing)`.
- `SubagentResult` (`index.ts:506`) gets `handoff?: { message }`, which is copied from the `PollResult` where `ping` is copied (`index.ts:1865`).
- `deliverSubagentCompletion` gets a `handoff` branch next to the `ping` branch. It sends `customType: "luvus_handoff"`, with content that starts `Sub-agent "<name>" handed off at the context alert (<elapsed>). The task is not complete.`, followed by the handoff text, the line `Start a new subagent with this handoff in its task. Do not resume this session.`, and `Session: <file>`. It does not use `sessionRef`, because that holds a `Resume: pi --session` line, which tells the parent to do the opposite. The message uses `{ triggerTurn: true, deliverAs: "steer" }`. `luvus_handoff` gets a message renderer like the `luvus_ping` one. `deliverSubagentCompletion` is added to the existing `__test__` export.
- `run.ts`: the close rule accepts `type` `done` or `handoff`. It still reads the raw sidecar.

### D6. Log rows and server session

`luvus.ts` gets `listLuvusSessionsAsync()`. It runs `session list --json` through the existing async Luvus call path (and so through `__setLuvusExecForTests__`), and returns the parsed object or `null` on any failure. `luvus-done.ts` calls it once, at the first log row, passes the result and `LUVUS_SOCKET_PATH` to `matchLuvusSession`, and caches the value for the process. Outside Luvus (no `LUVUS_BIN_PATH`), it does not call Luvus, and the value is `null`.

Row fields: `at`, `event`, `luvusSession`, `child` (`PI_LUVUS_NAME`), `session` (`PI_LUVUS_SESSION`), `tokens`, and `threshold` on `alert` rows (`200000` or `"80%"`, as configured). `tokens` is `null` when the usage is unknown. For a `handoff` row it comes from `ctx.getContextUsage()` in the tool's `execute`. There is no `parent` field, because a child does not get its parent's name in a reliable env var on both launch paths, and the count is for each server session.

### D7. Documentation

`config.json.example` gets `"contextAlert": { "enabled": false, "threshold": 200000 }`. The README configuration table gets the two keys, the note to select a value below the compaction point, the note that a bad `contextAlert` block stops the extension from loading in the parent (as a bad `status` block does), and the `handoffs.jsonl` count query. `SKILL.md` gets the `handoff` kind in "Waiting for a child", including the "Exit 2 after the close grace" line, and one bullet in "While it runs / after". These describe only what this package does.

## Risks / Trade-offs

- [The model ignores the alert or finishes the task] → The session stays open and the nudge asks for `luvus_done` with `handoff`. If the child finishes with a plain `luvus_done`, the `alert` row with no `handoff` row shows this in the log.
- [The alert arrives while work is not committed] → The alert text tells the child to commit, or to list the uncommitted changes in the handoff.
- [A threshold above the compaction point never fires] → This is the user's decision. The README states it.
- [An async `input` handler from another extension delays the steer past the loop's read] → The `turn_end` handler already set the takeover mark, so the session stays open, and pi delivers the queued steer at the next prompt or with the nudge. The user's live acceptance covers this. There is no test.
- [pi changes how steer messages or `input` handlers work] → The unit tests use a fake `pi` whose `sendUserMessage` fires the `input` handlers. The user's live acceptance checks the real pi behavior.
- [`handoffs.jsonl` grows with no limit] → One short line for each event. Rotation is out of scope.

## Migration Plan

No migration. The alert is off by default, and the new sidecar kind appears only when a child calls `luvus_done` with `handoff`. Rollback: revert the change. Existing `handoff` sidecars then read as `done` in a pi parent, and the pane stays open in the skill path.
