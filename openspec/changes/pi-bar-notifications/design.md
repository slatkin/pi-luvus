# Design

## Context

- `luvus-module/` is a packaged Luvus module (`pi-luvus.pane-titles`). It runs `titles.ts` one time on startup, on `pane.agent_status_changed`, and on `pane.closed`. `titles.ts` already has `indexSessionFiles`, `sessionsRoot`, `runLuvus`, and an mtime cache in `$LUVUS_MODULE_STATE_DIR`.
- The extension reports `working` and `idle` for each pi pane (`luvus-status.ts`). So a status change event occurs at each turn start and turn end.
- Each assistant message in a pi session file has `usage.totalTokens` and `usage.cost.total`. The file has no context window size.
- `luvus agent list` gives `agent`, `session`, `pane`, and `focused` for each live pane. `luvus.ts` has a private `luvusAsync` that parses this envelope.
- Bar widgets are declared in a module manifest. A process outside the module has no declared widget to push to.

## Goals / Non-Goals

**Goals:**
- Compute the bar totals in the module, so the extension sends no bar calls and needs no shared state across pi processes.
- Keep the notification path async, like the non-terminal status reports.

**Non-Goals:**
- Live updates during a turn. The widget changes at status changes, which is enough for cost and context.
- A context percentage. It needs the model context window, which only the extension knows.

## Decisions

### D1. The module computes the bar, not the extension
A new one-shot script `luvus-module/usage-bar.ts` runs on the same three triggers as `titles.ts`. It lists live panes with `agent list`, keeps entries with `agent` `pi` and a `session`, finds each session file with `indexSessionFiles`, and pushes one `bar push --id pi-usage` with `--content` and `--compact-content`. With no pi pane it runs `bar remove --id pi-usage`.

Alternative: each pi process writes its stats to a shared file and pushes the aggregate. Rejected: it needs a shared directory, file locks, and stale-entry cleanup for killed processes, and a non-module process cannot push to the module's widget.

### D2. A separate script, not an addition to `titles.ts`
Each trigger gets a second `[[events]]` / `[[startup]]` entry that runs `node usage-bar.ts`. Two processes keep the title and bar failures apart (spec: Widget failures do not affect titles) with no shared error handling. `usage-bar.ts` imports `indexSessionFiles`, `sessionsRoot`, and `runLuvus` from `titles.ts`; no copy.

Alternative: one `main` that does both. Rejected: one failure path would need care to not skip the other, and `titles.ts` grows past one concern.

### D3. Per-file cache keyed by mtime and size
`usage-bar.ts` stores `{ path: { mtimeMs, size, cost, contextTokens } }` in `$LUVUS_MODULE_STATE_DIR/usage-cache.json`. It parses a file only when mtime or size changed. It keeps entries only for the sessions of the current run, so the cache does not grow. Concurrent runs can overwrite each other's cache; the cache only saves reads, so the cost is one extra parse.

Parsing is a line scan: for each JSON line with `type: "message"` and `message.role: "assistant"`, add `usage.cost.total` to the cost and keep `usage.totalTokens` as the context count. A line that does not parse is skipped.

### D4. Pure formatting functions
`formatCost`, `formatTokens`, and `buildBarArgs(totals)` are pure exports, tested directly against the spec examples. Content segments are `text` segments with a `separator` between values; compact content is one `text` segment `π<n> $<cost>`.

### D5. Notification in a new extension module `turn-notify.ts`
`createTurnNotifier(env, deps)` registers one `agent_end` listener. On `agent_end` it returns at once when `PI_LUVUS_NAME` is set, when `isMuxAvailable()` is false, or when `notify.enabled` is false. It reads the last assistant message: `aborted` → nothing; `error` → `failed`/`error`; else `ended`/`success`. Then, without `await` in the listener, it runs `agent list` async, finds the entry with `pane === LUVUS_PANE_ID`, and when `focused` is not `true` pushes `ui notification push --text ... --level ...`. Any failure ends the chain quietly.

The label is `ctx.sessionManager.getSessionName()` when not empty, else `basename(ctx.cwd)`, read at `agent_end`.

Two small async helpers go into `luvus.ts` (Luvus calls stay there): `isPaneFocusedAsync(pane)` (uses `luvusAsync(["agent","list"])`) and `pushNotificationAsync(text, level)`. Both honor `__setLuvusExecForTests__`.

Alternative: add the listener to `luvus-status.ts`. Rejected: that module owns the status lease and its ordering rules; a notifier has none of them.

Alternative: check focus with `agent get`. Rejected: its output has no `focused` field.

### D6. `notify.enabled` parsed with the status config
`parseStatusConfig` accepts an optional `notify` object with only `enabled` (boolean, default `true`), using the existing `requireObject` / `rejectUnsupportedKeys` / `requireBoolean` helpers. `StatusConfig` gets `notifyEnabled: boolean`. `index.ts` already loads `statusConfig` at module load and passes `statusConfig.notifyEnabled` to the notifier.

## Risks / Trade-offs

- [Luvus also cues pi panes on state changes, so you get two cues] → `notify.enabled: false`. The user checks this in live acceptance.
- [`pane.agent_status_changed` may not fire for every status report] → the widget lags until the next trigger. Same dependency as the titles module today; checked in live acceptance.
- [Large session files make the first refresh slow] → the mtime cache makes later refreshes read only changed files. The script is a separate process, so a slow refresh does not block Luvus or pi.
- [Focus can change between `agent_end` and the focus check] → at most one extra or one missing notification; acceptable.

## Migration Plan

Users who already linked the module must unlink and link it again so Luvus reloads the manifest with the `[[bars]]` entry. README states this. Rollback: revert the manifest; the extension notification turns off with `notify.enabled: false`.
