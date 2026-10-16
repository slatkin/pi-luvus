# Tasks

## 1. Config

- [ ] 1.1 Add `parseContextAlertConfig` to new `pi-extension/luvus/context-alert.ts` (D1), call it from `parseStatusConfig` so that `StatusConfig` gets `contextAlert`, and add `test/context-alert.test.ts` to `scripts.test` in `package.json`. Verify with `test/context-alert.test.ts`: no block → off, `{"enabled":true}` → 200000 tokens, `150000`, `"80%"`, `"80.5%"`, unknown key error, and one table test where each invalid threshold (`0`, `-5`, `1.5`, `"0%"`, `"120%"`, `"80"`, `"abc%"`, `true`) is an error that names `contextAlert.threshold`. Confirm that `npm test` runs the new file.
- [ ] 1.2 Add `contextAlert` to `config.json.example` and the README configuration table, with the compaction-point note and the note that a bad block stops the extension from loading in the parent (D7). Verify that the existing config tests still pass and `loadStatusConfig` loads the updated example.

## 2. Alert in the child

- [ ] 2.1 Add `shouldAlert`, `alertText`, and `handoffNudgeText` to `context-alert.ts`. Verify with unit tests: the boundary (below, at, above) for both threshold kinds, `undefined` usage, and `null` `tokens`/`percent`. The alert text contains the token count, the threshold, and `luvus_done` with `handoff`. The nudge text names `handoff` and does not say "already delivered".
- [ ] 2.2 In `luvus-done.ts`, load the config in a try/catch at module load (D2) and register the `turn_end` handler (D3). When the latch is set, the nudge uses `handoffNudgeText()`. Verify with a fake `pi` whose `sendUserMessage` fires the registered `input` handlers: one steer over the threshold, none on a second turn, none when off, none without `PI_LUVUS_SESSION`, none on an error turn, an invalid config still registers `luvus_done`, and an auto-exit child that ends a turn after the alert writes no sidecar and gets the handoff nudge text.

## 3. Handoff exit

- [ ] 3.1 Add the optional `handoff` parameter to `luvus_done` (D4): whitespace-only text throws with no state change, text writes `{"type":"handoff","message":...}` after the `done` status report, and no `handoff` keeps `{"type":"done"}`. Update the tool description. Verify with fake-`pi` tests on a temp session file.
- [ ] 3.2 Map `type: "handoff"` in `interpretExitSidecar` to reason `handoff` with the message, or the `(handoff text missing)` placeholder (D5). Verify with cases next to the existing `interpretExitSidecar` tests in `test/test.ts`.
- [ ] 3.3 Add `handoff` to `SubagentResult`, copy it from the `PollResult`, add the `handoff` branch and the `luvus_handoff` renderer in `index.ts`, and add `deliverSubagentCompletion` to `__test__` (D5). Verify with one unit test that a `handoff` result sends one `luvus_handoff` message with `triggerTurn: true` whose content holds the handoff text.
- [ ] 3.4 Let `run.ts` close the pane on `handoff` as on `done`, still from the raw sidecar. Verify with one new `handoff` case next to the existing close-on-done tests in `test/cli.test.ts` (the pane closes after the grace). The existing unknown-type test covers the case where the pane stays open.
- [ ] 3.5 Update `skills/pi-luvus/SKILL.md` (D7): the `handoff` kind in "Waiting for a child", including the "Exit 2 after the close grace" line, and a bullet that says to start a new child with the handoff text in its brief and that the pane closes itself. Verify that the `external-orchestration` tests still pass and the text says nothing about Luvus behavior.

## 4. Handoff log

- [ ] 4.1 Add `listLuvusSessionsAsync` to `luvus.ts` (D6), and `handoffLogPath`, `matchLuvusSession`, and `appendHandoffLog` to `context-alert.ts`. Verify with unit tests: `listLuvusSessionsAsync` through `__setLuvusExecForTests__` returns the parsed `{ "sessions": [...] }` object, and `null` on failure. `matchLuvusSession`: a matching `socket_path` → name, no match → socket path, no list → socket path, no socket path → `null`. `appendHandoffLog` writes one line with the row fields and does not throw when the write fails.
- [ ] 4.2 Write the `alert` row from the `turn_end` handler and the `handoff` row from `luvus_done`, without waiting for them, and cache the server session for the process. Verify with one fake-`pi` test: an alert followed by a handoff gives two rows with the same `session`.
- [ ] 4.3 Document `handoffs.jsonl` and the `jq` count query in the README. Verify that the documented query runs on a sample file with `jq`.

## 5. Integration checks

- [ ] 5.1 Run `npm test` and `npx tsc --noEmit`, and verify that both pass, with `external-orchestration` tests unchanged except for the new handoff cases.
- [ ] 5.2 Run `openspec validate context-alert-handoff --strict` and verify that it passes.

## Workflow follow-up

- The user does the live acceptance: enable `contextAlert` with a low threshold, start one child from a pi parent and one from Claude Code, and check the handoff message, the pane close, the nudge after an ignored alert, and the `handoffs.jsonl` rows.
- Archive the change after review and acceptance.
