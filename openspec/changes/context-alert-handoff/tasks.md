# Tasks

## 1. Config

- [ ] 1.1 Add `parseContextAlertConfig` to new `pi-extension/luvus/context-alert.ts` (D1), and call it from `parseStatusConfig` so that `StatusConfig` gets `contextAlert`. Verify with new `test/context-alert.test.ts` cases: no block → off, `{"enabled":true}` → 200000 tokens, `150000`, `"80%"`, unknown key error, and each invalid threshold (`0`, `-5`, `"0%"`, `"120%"`, `"80"`, `true`) is an error that names `contextAlert.threshold`.
- [ ] 1.2 Add `contextAlert` to `config.json.example` and the README configuration table, with the note that the user must select a value below the model's compaction point. Verify that the existing config tests still pass and `loadStatusConfig` loads the updated example.

## 2. Alert in the child

- [ ] 2.1 Add `shouldAlert` and `alertText` to `context-alert.ts`. Verify with unit tests: at the threshold, above it, below it, `tokens`/`percent` `null`, and both threshold kinds. The text contains the token count, the threshold, and `luvus_done` with `handoff`.
- [ ] 2.2 Register the `turn_end` handler in `luvus-done.ts` (D2, D3): only with `PI_LUVUS_SESSION` set, the alert on, no earlier alert, `luvus_done` not called, and `stopReason` not `error`/`aborted`. Queue `sendUserMessage(..., { deliverAs: "steer" })` before the handler returns. Verify with a fake `pi` test: one steer when over the threshold, none on a second turn, none when off, none without `PI_LUVUS_SESSION`, none on an error turn.

## 3. Handoff exit

- [ ] 3.1 Add the optional `handoff` parameter to `luvus_done` (D4): whitespace-only text throws with no state change, text writes `{"type":"handoff","message":...}` after the `done` status report, and no `handoff` keeps `{"type":"done"}`. Update the tool description. Verify with fake-`pi` tests on a temp session file.
- [ ] 3.2 Map `type: "handoff"` in `interpretExitSidecar` to reason `handoff` with the message, or the `(handoff text missing)` placeholder (D5). Verify with cases next to the existing `interpretExitSidecar` tests in `test/test.ts`.
- [ ] 3.3 Add the `handoff` delivery branch in `index.ts` next to the `ping` branch (D5). Verify with a unit test that the parent sends one `luvus_handoff` message with the child name, the text, and the session file, and with `triggerTurn: true`.
- [ ] 3.4 Let `run.ts` close the pane on `handoff` as on `done`, still from the raw sidecar. Verify with the existing close-on-done tests plus a `handoff` case (pane closes after the grace) and a case where `type` is not `done`/`handoff` (pane stays open).
- [ ] 3.5 Update `skills/pi-luvus/SKILL.md` (D7): the `handoff` kind in "Waiting for a child", and a bullet that says to start a new child with the handoff text in its brief, and that the pane closes itself. Verify that the `external-orchestration` tests still pass and the text says nothing about Luvus behavior.

## 4. Handoff log

- [ ] 4.1 Add `handoffLogPath`, `resolveLuvusSession`, and `appendHandoffLog` to `context-alert.ts` (D6), with injected exec and file deps. Verify with unit tests: matching `socket_path` → name, no match → socket path, failed exec → socket path, no `LUVUS_SOCKET_PATH` → `null`, the row fields, and a write that fails does not throw.
- [ ] 4.2 Write the `alert` row from the `turn_end` handler and the `handoff` row from `luvus_done`, without waiting for them, and cache the server session for the child. Verify with fake-`pi` tests that one alert plus one handoff gives two rows with the same `session`, and that a failing log still sends the steer and writes the sidecar.
- [ ] 4.3 Document `handoffs.jsonl` and the `jq` count query in the README. Verify that the documented query runs on a sample file with `jq`.

## 5. Integration checks

- [ ] 5.1 Run `npm test` and `npx tsc --noEmit`, and verify that both pass, with `external-orchestration` tests unchanged except for the new handoff cases.
- [ ] 5.2 Run `openspec validate context-alert-handoff --strict` and verify that it passes.

## Workflow follow-up

- The user does the live acceptance: enable `contextAlert` with a low threshold, start one child from a pi parent and one from Claude Code, and check the handoff message, the pane close, and the `handoffs.jsonl` rows.
- Archive the change after review and acceptance.
