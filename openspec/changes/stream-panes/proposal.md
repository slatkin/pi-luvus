# Proposal

## Why

Issue #2 asks for thinking and tool usage to be watchable in their own panels instead of filling the main conversation window. Today the only controls are Ctrl+T (thinking marker, global) and tool rows that cannot be hidden at all, so a long turn buries the conversation under tool output. Luvus already owns panes, so the panels do not need to live inside pi's TUI.

## What Changes

- New `/stream` slash command in the pi TUI. `/stream thinking`, `/stream tools`, and `/stream both` open follower panes; `/stream` with no argument reports which streams are attached. `/stream close` detaches all panes.
- The command splits the calling Luvus pane: the first pane goes to the right of the pi pane, the second splits down from the first. Panes are named `thinking` and `tools`.
- Each follower pane runs a small Node tailer that connects to a per-session unix socket and prints what pi sends. The tailer writes plain lines; it is not a TUI.
- pi forwards streaming thinking text and tool lifecycle events (start, partial output, end, error) to attached streams. A bounded in-memory ring per stream replays the current turn, so a pane opened mid-turn is not blank.
- While a stream has at least one attached pane, pi's transcript omits that class of content: thinking blocks contribute no lines and no marker, and tool rows are absent along with their leading spacer. Everything else in the transcript renders unchanged.
- Detach is lazy and needs no cooperation from the pane: closing a follower pane closes the socket, pi notices, and the transcript is restored immediately after the last pane for that stream is gone.
- No disk spool, no startup hook, no Luvus module. A pane exists only because the command created it.

## Capabilities

### New Capabilities

- `stream-panes`: the `/stream` command, follower pane creation and placement, socket transport, replay of the current turn, transcript projection while attached, and restore on detach.

### Modified Capabilities

None. No existing spec covers transcript rendering or follower panes, and no existing requirement changes.

## Impact

- New modules under `pi-extension/luvus/`: stream state and socket server, the transcript projection view, event-to-line formatting, and the packaged `stream-tail.mjs` tailer. `index.ts` gains the command registration and event subscriptions.
- Reads pi internals for the projection: the chat `Container` reached through `tui.layoutRoot`, `AssistantMessageComponent.contentContainer`, and `ToolExecutionComponent`. This must fail open, so an unrecognised layout renders the untouched transcript and warns once.
- Uses the existing `splitPane`/`namePane`/`runInPane` helpers, `LUVUS_PANE_ID`, `ctx.sessionManager.getSessionId()`, and `ctx.ui.setWidget` (only to obtain the `tui` reference).
- No change to `luvus-done.ts`, the `PI_LUVUS_*` environment variables, or the `.exit` sidecar format, so `external-orchestration` is untouched.
