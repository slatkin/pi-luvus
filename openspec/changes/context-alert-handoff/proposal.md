# Proposal

## Why

A subagent that runs for a long time fills its context window. Its work then becomes worse, or pi compacts the context and the agent loses detail. At this time, nothing tells the child to stop and pass its work to a fresh child. An opt-in context alert lets the child write a handoff while it still has room, and lets the orchestrator (a pi parent or Claude Code) start a successor.

## What Changes

- New `config.json` block `contextAlert` with `enabled` (default `false`) and `threshold` (default `200000`). `threshold` is a token count (a number) or a percentage of the model's context window (a string such as `"80%"`). There is no automatic limit: the configured value is used as it is.
- A subagent child with the alert enabled checks its current context size after each turn. The first time the size is at or above the threshold, the child gets one steer message. The message tells it to save or describe its work, write a handoff, send it to the parent, and end the session with the handoff.
- `luvus_done` gets an optional `handoff` parameter. With it, the tool writes a new `.exit` kind: `{"type":"handoff","message":"<text>"}`.
- A pi parent that reads a `handoff` sidecar gets a handoff message with the text and the session reference, so it can start a successor.
- The skill-path run wrapper closes the pane on a `handoff` sidecar after the grace period, the same as on `done`.
- `skills/pi-luvus/SKILL.md` tells an external orchestrator about the `handoff` kind and what to do with it.
- The child appends one JSON line for each alert and each handoff to `handoffs.jsonl` in the extension config directory. Each line names the Luvus server session, so the user can count handoffs for each server session with `jq`.

### Assumptions and non-goals

- The measure is the current context size, not the total tokens the session used. A compaction makes the size smaller.
- The user selects a threshold that is less than the compaction point of their model. With the default 200000 on a model that has a 200k window, pi compacts first and the alert never fires.
- Only the child gets the alert. The orchestrator learns about it from the handoff.
- No per-launch env var, no log rotation, no Luvus Bar widget.

## Capabilities

### New Capabilities

- `context-alert`: the opt-in context threshold, the alert that a subagent child gets, and the handoff log.

### Modified Capabilities

- `luvus-completion`: `luvus_done` can end a session with a handoff, which writes the `handoff` sidecar, and a pi parent receives it as a handoff.
- `external-orchestration`: the run wrapper closes the pane on `handoff` too, and `SKILL.md` documents the `handoff` sidecar.

## Impact

- New `pi-extension/luvus/context-alert.ts` and `test/context-alert.test.ts`.
- `pi-extension/luvus/luvus-done.ts`: the turn-end check, the `handoff` parameter on `luvus_done`, and the log rows.
- `pi-extension/luvus/status.ts`: parse `contextAlert`.
- `pi-extension/luvus/luvus.ts`: `interpretExitSidecar` returns reason `handoff`.
- `pi-extension/luvus/index.ts`: the pi parent delivers a handoff message.
- `pi-extension/luvus/run.ts`: close the pane on `handoff`.
- `skills/pi-luvus/SKILL.md`, `README.md`, `config.json.example`.
- The `.exit` sidecar format gets one new kind. The existing kinds do not change, and `external-orchestration` must still pass.
