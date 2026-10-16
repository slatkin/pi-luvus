# Design

## Context

See proposal.md for the reasons. These facts about the current code shape the design:

- `luvus-done.ts` is the child-side module. Both orchestrator paths load it in every subagent child: the pi parent through the extension, and the skill launcher with `-e`. It already owns the `.exit` writes (`luvus_done`, `caller_ping`, error and auto-exit paths) and the completion nudge.
- `status.ts` parses `config.json` (`status`, `notify`) with strict key checks (`rejectUnsupportedKeys`, `requireBoolean`). Children read the same file as the parent.
- pi gives `ctx.getContextUsage()` with `{ tokens, contextWindow, percent }`. `tokens` and `percent` are `null` when the size is unknown.
- In pi 1.3.0, the agent loop reads queued steer messages immediately after it emits `turn_end`. A steer queued in a `turn_end` handler therefore starts the next turn, also when the turn had no tool calls, and `agent_end` does not fire first. Error and aborted turns end the run without this read.
- `interpretExitSidecar` (`luvus.ts`) maps an unknown `type` to `done`. `run.ts` reads the raw `type` for the close rule, so that malformed sidecars do not close panes.
- `run.ts` already wakes an external parent with `<child> <sidecar type> without sending a report` when the child did not send a report. A `handoff` child that forgets `luvus agent send` therefore still wakes the parent as `<child> handoff without sending a report`. No new code is necessary for this.

## Goals / Non-Goals

**Goals:**
- Keep all new logic that has no side effects in one new module with unit tests, and keep the edits to `luvus-done.ts`, `luvus.ts`, `run.ts`, and `index.ts` small.
- Do not change the existing sidecar kinds or how they are handled.

**Non-Goals:**
- An alert in the orchestrator, or one that does not use pi's context usage.
- A guarantee that the model obeys the alert. A child that ignores it continues as it does today.

## Decisions

### D1. New module `context-alert.ts`

It holds:
- `parseContextAlertConfig(raw, source)`: returns `{ enabled, threshold }`, where `threshold` is `{ kind: "tokens", value }` or `{ kind: "percent", value }`. `parseStatusConfig` calls it and adds the result to `StatusConfig` as `contextAlert`. The error messages follow the style of `requireBoolean`.
- `shouldAlert(usage, threshold)`: returns `true` when the usage is known and at or above the threshold. The "fire once" latch stays in `luvus-done.ts`, next to the other child state (`doneCalled`).
- `alertText(tokens, threshold)`: the steer message.
- `handoffLogPath()`: `handoffs.jsonl` in the directory of `getDefaultConfigPath()`.
- `appendHandoffLog(row, deps)` and `resolveLuvusSession(env, deps)`: deps that can be replaced, so the tests use no Luvus and no real home directory.

Alternative: put everything in `luvus-done.ts`. That file is already 450 lines and has no seam for unit tests, so it is not a good place.

### D2. Check at `turn_end`, deliver as `steer`

In `luvus-done.ts`, a `turn_end` handler runs only when `PI_LUVUS_SESSION` is set, the alert is on, it has not fired yet, and `luvus_done` has not been called. It skips turns whose message has `stopReason` `error` or `aborted`. The handler sets the latch, then calls `pi.sendUserMessage(alertText(...), { deliverAs: "steer" })` synchronously, before it returns. Then it starts the `alert` log row and does not wait for it.

The handler sends the steer before it returns, so pi reads the message in the same run (see Context). `followUp` is wrong here, because pi delivers it only when the agent has no more work. That is too late for an alert, and it can come after an auto-exit `done`.

Alternative: check at `agent_end`. That is too late for a long run with many tool calls, and it occurs at the same time as the auto-exit write.

### D3. The latch is set before the send

The latch is set first. Thus, if the send fails, no second alert follows on the next turn. The alert is guidance, so one try is sufficient.

### D4. `luvus_done({ handoff })`

The schema gets `handoff: Type.Optional(Type.String())`. If the value is whitespace only, the tool throws before it changes any state, so the session stays open and the model can retry. When the value has text, the tool reports status `done`, writes `{"type":"handoff","message":handoff}`, starts the `handoff` log row without waiting for it, and calls `ctx.shutdown()`. The tool description tells the model to use `handoff` only after a context alert.

The status is `done` and not `blocked`, because `luvus wait agent-status --status done,blocked` wakes on both, and `done` is correct: the child ended cleanly. The orchestrator learns that the task is not complete from the sidecar.

Alternative: a separate `luvus_handoff` tool. That adds a fourth control tool to every role and changes the default tool list. A parameter costs less.

### D5. Parent side

- `PollResult.reason` gets `"handoff"` and an optional `handoff: { message }`. `interpretExitSidecar` maps `type: "handoff"` to it. If `message` is not a non-empty string, it uses the placeholder `(handoff text missing)`.
- `index.ts`: the delivery function gets a `handoff` branch next to the `ping` branch. It sends `customType: "luvus_handoff"`, with the content `Sub-agent "<name>" handed off at the context alert (<elapsed>). The task is not complete. Start a successor with this handoff:` followed by the text and `sessionRef`, and `{ triggerTurn: true, deliverAs: "steer" }`.
- `run.ts`: the close rule accepts `type` `done` or `handoff`. It still reads the raw sidecar.

### D6. Log rows and server session

`resolveLuvusSession` runs `$LUVUS_BIN_PATH session list --json` asynchronously with a short timeout. It returns the `name` of the entry whose `socket_path` equals `LUVUS_SOCKET_PATH`. If no entry matches, or the call or parse fails, it returns the socket path. If `LUVUS_SOCKET_PATH` is not set, it returns `null`. The child caches the result after the first row, because the value does not change during a session. Each row is written with one `appendFileSync` call, which is the same as one line. All failures are caught and ignored.

Row fields: `at`, `event`, `luvusSession`, `child` (`PI_LUVUS_NAME`), `session` (`PI_LUVUS_SESSION`), `tokens`, and `threshold` on `alert` rows (`200000` or `"80%"`, as configured). There is no `parent` field, because a child does not get its parent's name in a reliable env var on both launch paths, and the count is for each server session.

For a `handoff` row, `tokens` is the last known context token count, from `ctx.getContextUsage()` in the tool's `execute`.

### D7. Documentation

`config.json.example` gets `"contextAlert": { "enabled": false, "threshold": 200000 }`. The README configuration table gets the two keys and the `handoffs.jsonl` count query. `SKILL.md` gets one bullet in "While it runs / after" and one line in "Waiting for a child". These describe only what this package does.

## Risks / Trade-offs

- [The model ignores the alert or finishes the task] → The child exits as it does today, and the `alert` row with no `handoff` row shows this in the log.
- [An auto-exit child ends a turn with no tool call after the alert, but does not call `luvus_done({ handoff })`] → Auto-exit writes `done`, and the handoff is lost as a signal. The alert text tells the child to call `luvus_done` with `handoff` as its last step. The log shows the gap.
- [The alert arrives while work is not committed] → The alert text tells the child to commit, or to list the uncommitted changes in the handoff.
- [A threshold above the compaction point never fires] → This is the user's decision. The README states it.
- [pi changes when steer messages are read] → The unit tests use a fake `pi` and check only that a steer is queued in `turn_end`. The user's live acceptance checks the real pi behavior.
- [`handoffs.jsonl` grows with no limit] → One short line for each event. Rotation is out of scope.

## Migration Plan

No migration. The alert is off by default, and the new sidecar kind appears only when a child calls `luvus_done` with `handoff`. Rollback: revert the change. Existing `handoff` sidecars then read as `done` in a pi parent, and the pane stays open in the skill path.
