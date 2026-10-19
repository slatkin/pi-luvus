# Design

## Context

See proposal.md. The constraints that shape this design:

- Pi's transcript is a `Container` of components (`AssistantMessageComponent`, `ToolExecutionComponent`, user rows, `Spacer`s) owned by the interactive mode. Pi clears and repopulates it on resume, branch, and compaction.
- No public API hides a tool row. The public seams are `registerMarkdownTransformer` (assistant thinking markdown only), `registerToolRenderer` (new rows only), and `ctx.ui.setWidget`, whose factory receives the live `tui` object.
- `AssistantMessageComponent.contentContainer` holds one child per visible text block or thinking run, plus `Spacer`s: a `Markdown` for text, a `MouseRegion` around a thinking `Markdown` (or a `Text` marker when thinking is hidden).
- Pi's `ScrollView.render` renders every child before clipping; `Container.render` records `mouseLayout`, which `Container.handleMouse` uses to route mouse events to children.
- The extension already owns `splitPane`, `namePane`, `runInPane` (`luvus.ts`), reads `LUVUS_PANE_ID`, and can read `ctx.sessionManager.getSessionId()`.

## Goals / Non-Goals

**Goals:**

- One command, no module, no startup hook, no configuration.
- The main transcript is projected, never mutated: pi keeps writing to the same container, and detach restores the exact original component tree.
- Detach is inferred from the socket, not from a pane-existence query or a preference.
- Unknown pi layout fails open with one warning.

**Non-Goals:**

- A Luvus module or right-click entry; `/stream` is the only trigger for now.
- Streaming panes for subagents, or panes that survive a pi restart.
- Search, filtering, copying, or scrolling controls inside a follower pane.
- Persisting stream content; there is no log file and no resume replay.

## Decisions

**Projection view instead of hiding rows in place.** A `StreamFilterView` replaces the chat container in its parent's child slot while any stream is attached. It holds the real container as `source`, never mutates it, and each render builds the visible child list from `source.children`, then delegates to `Container.render`. Alternatives considered: removing rows from the real container and keeping references (needs an O(history) reconcile on the token path, must re-run after every session rebuild); `registerToolRenderer` with an empty self-render (only affects rows created after the toggle, so history stays visible).

**The filter is a wrapper, not a copy of the tree.** Projected children are the same component objects. The transcript's scroll view, input, and dock are untouched, so scroll position, history, and session rebuilds behave exactly as before; a `chatContainer.clear()` followed by re-adds is reflected because the wrapper reads `source.children` each render.

**Thinking is projected per assistant message.** For each `AssistantMessageComponent`, the view derives runs from `lastMessage.content` (consecutive non-empty thinking collapsed into one run, non-empty text blocks), matches them to `contentContainer` children (skipping `Spacer`s, which travel with the child that follows), and builds a cached shell via `Object.create(source)` with its own `children` and `contentContainer`. Only kept children are in the shell, so a thinking-only message renders zero lines and leaves no blank run. Alternatives: `registerMarkdownTransformer` returning `""` (zero lines, but pi's spacers around the thinking block remain, so each hidden run leaves a blank line and old blocks cannot be repaired cleanly), and pi's own hidden mode (leaves a visible marker, which the spec forbids). The shell is re-synced every render, so it cannot drift from the real component.

**Tool rows are dropped whole.** A `ToolExecutionComponent` child is omitted while the tools stream is attached. It carries its own internal spacing, so no separate spacer needs repair; the render hook still drops a preceding `Spacer` if one sits directly before a tool row.

**Attach state is the only input.** The view has a tiny state value (`none`, `thinking`, `tools`, `both`) plus the render-time cache keyed by that state, `source.children` identity and length, and each assistant's `lastMessage` identity. Nothing else triggers a rebuild, so the per-frame cost is a cache hit until pi appends or streams.

**One unix socket per session, one client per pane.** The server is created on first attach under `$XDG_RUNTIME_DIR/pi-luvus/` (fallback `os.tmpdir()`), mode 0700, with a short hashed filename to stay under the socket path limit. A client sends one hello record naming its stream; the server answers with that stream's ring replay, then live records only for that stream. Records are newline-delimited JSON. A client counts as attached while its connection is open, so a closed pane detaches by closing the socket; no liveness polling and no pane-list query.

**Deltas are coalesced.** Thinking deltas are buffered and flushed at most every 50 ms or on a newline; tool output likewise. Nothing is written when a stream has no client, so an unused socket costs nothing on the token path.

**Replay is bounded per stream, in memory.** Each stream keeps the current turn's formatted lines in a ring capped by characters and line count. `turn_start` resets it. This is what makes a pane opened mid-turn useful without a disk spool.

**The tailer is plain Node.** `stream-tail.mjs` takes `--socket` and `--stream` as argv, prints a one-line header, writes what it receives, and exits when the socket closes. It is not a TUI, so any terminal can host it. `process.execPath` supplies the runtime, and the command line is built the way `paneCommandLine` builds one: bare `node`, then double-quoted tokens, rejecting any token a shell would expand.

**The `tui` reference comes from a zero-height widget.** `ctx.ui.setWidget("luvus-streams", (tui) => emptyComponent)` is the public way to receive the live `tui`; the widget renders nothing. Every other seam that hands out `tui` would replace the header, footer, or editor. The chat container is found by walking `tui.layoutRoot` for a scroll view whose child container holds message components; the view is installed by replacing that child's slot in its parent. Any deviation from that shape is a layout mismatch.

**Placement is recorded, not recomputed.** The thinking pane splits right of the pi pane; the tools pane splits below the thinking pane. If tools is the only pane, it splits right. When only tools is open and thinking is opened later, thinking still splits right of the pi pane and the tools pane stays where it is.

## Risks / Trade-offs

- Pi's assistant content layout changes between versions → the run-to-child match is strict; a mismatch installs nothing, warns once, and the transcript renders untouched.
- A malformed projection could hide the wrong row → only two component classes are ever dropped, both matched structurally; anything unrecognised aborts the whole projection rather than partially applying it.
- Socket path length or permissions → hashed short name, private directory, and a clear warning with no attach if listen fails.
- Worse frame cost on very long sessions → the visible list is cached by identity; if it ever shows, the fallback is pi-stereo-view's render cache keyed on the same signature.
- A tailer started by hand also attaches, and `/stream close` will not close that pane → only pane ids this session started are closed; a hand-started pane detaches when its process ends.
- A stale socket path from a crashed process → the server unlinks the path before listening and again at session shutdown.
- Mouse routing inside the projected region → the view renders through `Container.render`, so `mouseLayout` matches exactly what was drawn.

## Migration Plan

No migration. The command is additive and off until run. Rollback is removing the modules and the command registration; no persisted state exists, so nothing to clean up beyond a stale socket, which is unlinked at session shutdown and on the next start.

## Open Questions

None.
