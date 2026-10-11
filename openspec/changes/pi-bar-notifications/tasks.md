# Tasks

## 1. Usage bar module script

- [x] 1.1 Add `luvus-module/usage-bar.ts` with pure exports `parseSessionUsage(text)` (cost sum and last `totalTokens` over assistant messages, bad lines skipped), `formatCost`, `formatTokens`, and `buildBarArgs(totals)` / `buildBarRemoveArgs()` (D3, D4). Verify: `test/luvus-module-usage-bar.test.ts` covers every scenario in the `luvus-bar-usage` spec for values and formats (two panes → `π 2 · $1.25 · ctx 142k`, compact `π2 $1.25`; 950/31385/1250000 → `950`/`31k`/`1.3M`; 0.004 → `$0.00`; no assistant message → 0).
- [x] 1.2 Add `collectUsage(panes, cache, index, read)` and `main(env)` to `usage-bar.ts`: `agent list` → pi panes with a session → session files via `indexSessionFiles`; reuse cache entries with equal mtime and size; drop cache entries for sessions not in this run; push the widget, or remove it when no pi pane is live; log and exit 1 on a failed Luvus call. Reuse `runLuvus` and `sessionsRoot` from `titles.ts`. Verify: tests with fixture session files in a temp root show an unchanged file is not read again, a missing file still counts the pane, and zero pi panes produce `bar remove`.
- [x] 1.3 Add the test file to the `test` script in `package.json`. Verify: `npm test` runs it and passes.

## 2. Module manifest

- [x] 2.1 In `luvus-module/luvus-module.toml`, add a `[[bars]]` entry (`id = "pi-usage"`, `title = "pi usage"`) and a `node usage-bar.ts` command for `[[startup]]`, `pane.agent_status_changed`, and `pane.closed`. Keep the module id; update `name` and `description` to cover titles and usage. Verify: the manifest has one bar and both commands per trigger, and `npm test` still passes.
- [x] 2.2 Document the widget in README (what it shows, re-link the module after upgrade, no context percentage). Verify: README section names the widget id `pi-luvus.pane-titles:pi-usage` and the three values.

## 3. Notify config

- [x] 3.1 In `status.ts`, parse optional `notify` (`enabled` only, boolean, default `true`) into `StatusConfig.notifyEnabled` (D6). Add `"notify": { "enabled": true }` to `config.json.example`. Verify: unit tests in `test/test.ts` cover default `true`, explicit `false`, non-boolean → error naming `notify.enabled`, and unknown key → error.
- [x] 3.2 Document `notify.enabled` in README, including the advice to set it to `false` if Luvus already cues pi panes. Verify: README config section lists the key and its default.

## 4. Turn-end notification

- [x] 4.1 Add `isPaneFocusedAsync(pane)` and `pushNotificationAsync(text, level)` to `luvus.ts`, both through `luvusAsync` and the test seam (D5). Verify: unit tests with `__setLuvusExecForTests__` show the `agent list` focus lookup and the exact `ui notification push --text <t> --level <l>` args.
- [x] 4.2 Add `pi-extension/luvus/turn-notify.ts` with `createTurnNotifier(env, enabled, deps)` and a pure `turnOutcome(messages)` (`aborted` → none, `error` → failed/error, else ended/success) and label rule (session name, else cwd basename). The `agent_end` listener does not await the Luvus chain and swallows its failures. Verify: `test/turn-notify.test.ts` covers every `luvus-turn-notifications` scenario with fake deps: unfocused → push, focused → none, named session label, error level, aborted → none, `PI_LUVUS_NAME` set → no call, no `LUVUS_PANE_ID` → no call, disabled → no call, focus lookup rejects → no push and no throw.
- [x] 4.3 Register the notifier in `index.ts` next to the status reporter, passing `statusConfig.notifyEnabled`, and add the test file to the `test` script. Verify: `npm test` and `npx tsc --noEmit` pass.
- [x] 4.4 Document the notification in README (when it fires, text, levels, children excluded). Verify: README section matches the spec texts `pi turn ended: <label>` and `pi turn failed: <label>`.

## 5. Integration checks

- [x] 5.1 Run `npm test` and `npx tsc --noEmit` on the full change. Verify: both pass with no new warnings.
- [ ] 5.2 Write live acceptance steps for the user in the PR description: link the module (`luvus module link luvus-module`; re-link if it is already linked), check `luvus bar list` for the widget with two pi panes, end a turn in an unfocused pane, and note whether Luvus also cues it. Verify: the steps are in the PR description; agents do not run them.

## Workflow follow-up

- The user runs the live acceptance steps from 5.2.
- Archive the change after review and acceptance, then close issue #8.
