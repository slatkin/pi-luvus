# Tasks

## 1. Stream state and transport

- [ ] 1.1 Add `pi-extension/luvus/stream-state.ts` with the per-stream replay ring: bounded by line count and characters, reset on `turn_start`, and append helpers for thinking text and tool start/update/end. Verify `test/stream-state.test.ts` covers the caps, the reset, and a failed tool line.
- [ ] 1.2 Add the socket server to the same module: private runtime directory, short hashed path, unlink before listen, hello record selecting a stream, ring replay on hello, live fan-out only to that stream's clients, and detach when a connection closes. Verify tests connect real clients to a temp socket (no Luvus) and assert replay, fan-out, and detach.
- [ ] 1.3 Coalesce thinking deltas and tool output: at most one flush per 50 ms or on a newline, and nothing written when a stream has no client. Verify a fake-timer test asserts one write per window and no write without a client.
- [ ] 1.4 Add event wiring in `index.ts` for `message_update` (`thinking_delta`), `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`, mapping each to formatted records. Verify a test feeding a fake event sequence asserts the exact records on the socket.

## 2. Transcript projection

- [ ] 2.1 Add `pi-extension/luvus/stream-projection.ts` with transcript lookup from a `tui`-shaped root: return the chat container, its parent, and its index; return a mismatch when the shape is not exactly one candidate. Verify `test/stream-projection.test.ts` covers a matching fake layout and three mismatches.
- [ ] 2.2 Add the filter view: while `tools` is attached drop tool components (and a directly preceding spacer), while `thinking` is attached replace each assistant component with a shell holding only its text slots, and cache the visible list by attach state, source child identities, and assistant message identities. Verify tests assert rendered lines for thinking-only, text+thinking, and tool-row cases.
- [ ] 2.3 Add install and uninstall: replace the chat container's slot in its parent, restore the identical object on detach, invalidate and request a render, and warn once per session on a layout mismatch while leaving the transcript untouched. Verify tests assert the parent's child is the original object after uninstall and that a repeated mismatch warns once.

## 3. Command and panes

- [ ] 3.1 Add the `/stream` command in `index.ts`: parse `thinking`, `tools`, `both`, `close`, and no argument; report attached state; report accepted arguments for anything else; make a repeat request idempotent. Verify `test/stream-command.test.ts` covers each argument with a fake `ctx.ui.notify`.
- [ ] 3.2 Add pane creation: thinking splits right of the pi pane, tools splits below the thinking pane (or right when it is the only pane), both panes are named, focus stays on the pi pane, and the recorded pane ids are closed by `/stream close`. Verify a test with `__setLuvusExecForTests__` asserts the split order, the `--right`/`--down` flags, the names, and the close calls.
- [ ] 3.3 Add the tailer command line builder, using bare `node`, double-quoted tokens, and rejection of tokens a shell would expand. Verify unit tests cover a normal path and a rejected path.
- [ ] 3.4 Refuse to open a stream when no Luvus pane id is known, leaving state unchanged. Verify a test with the pane id unset asserts the warning and an unchanged attach state.

## 4. Tailer and documentation

- [ ] 4.1 Add `pi-extension/luvus/stream-tail.mjs`: connect to `--socket`, select `--stream`, print a header, copy records to stdout, exit when the socket closes, and exit non-zero when the connection fails. Verify by spawning it against a temp socket in a test.
- [ ] 4.2 Document the command in `docs/guide.md` under a new `## Stream panes` section: arguments, placement, what each pane shows, and that closing a pane restores the transcript. Verify every documented argument matches the handler and the section renders as intended on read.

## 5. Integration checks

- [ ] 5.1 Run `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, and `pnpm run format:check`; all pass with the new modules and tests.
- [ ] 5.2 Confirm the change touches neither `luvus-done.ts`, the `PI_LUVUS_*` variables, nor the `.exit` sidecar: `git diff --name-only` lists none of them.

## Workflow follow-up

- The user performs live testing in Luvus: `/stream both`, close one pane, `/stream close`.
- Archive the change after review.
