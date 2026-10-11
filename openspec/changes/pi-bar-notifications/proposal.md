# Proposal

## Why

Issue #8: you cannot see the model, context use, or cost of pi sessions without focusing each pane. Also, you are not told when a pi turn ends in a pane that you are not looking at.

## What Changes

- The packaged Luvus module (`luvus-module/`) declares a Luvus Bar widget, `pi-usage`. A new module script publishes totals across all live pi panes to it: the number of pi panes, the total session cost, and the largest context token count.
- The script runs from the module's existing triggers (startup, agent status change, pane close). It reads the pi session files of live pi panes. It caches per-file results by modification time and size.
- The extension sends a Luvus notification when a turn ends in a parent pi pane that does not have focus. A turn that ends with an error sends an `error` notification. Subagent children send no notification.
- New `config.json` key `notify.enabled` (default `true`) turns the turn-end notification off.

### Assumptions and non-goals

- Totals only. The widget does not follow the focused pane (user choice).
- The widget shows context as tokens, not as a percentage. The session file has no context window size.
- "Waits for input" in a parent pi is the same moment as "turn ended". pi has no approval prompt of its own, so this change sends no approval notification.
- Subagent `blocked` (ping) and `done` already reach the parent through the status lease and `luvus_done`. This change does not add notifications for them.
- Luvus has its own notify cues for agent states. If they duplicate this notification for pi panes, set `notify.enabled` to `false`. The user checks this in live acceptance.

## Capabilities

### New Capabilities
- `luvus-bar-usage`: the Luvus Bar widget that shows totals for live pi panes.
- `luvus-turn-notifications`: the notification that a parent pi pane sends when a turn ends without focus.

### Modified Capabilities

None.

## Impact

- `luvus-module/luvus-module.toml`: a `[[bars]]` entry and a second command for each existing trigger. The module id is `pi-luvus.pane-titles`; the name and description change.
- New `luvus-module/usage-bar.ts` and `test/luvus-module-usage-bar.test.ts`.
- New `pi-extension/luvus/turn-notify.ts`, registered in `index.ts`, with `test/turn-notify.test.ts`.
- `pi-extension/luvus/status.ts`: parse `notify.enabled`. `config.json.example` and README document the key and the widget.
- No change to `luvus-done.ts`, the `PI_LUVUS_*` env vars, or the `.exit` sidecar. `external-orchestration` is not affected.
