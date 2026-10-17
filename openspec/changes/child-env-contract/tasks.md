# Tasks

All tests use fakes and fake `LUVUS_*` values. No task runs a live Luvus or starts pi.

## 1. Child-env module

- [x] 1.1 Add `pi-extension/luvus/child-env.ts` with `ChildEnv`, `encodeChildEnv`, `decodeChildEnv` and `isSubagentChild` as in design D1. Move `SPAWNING_TOOLS` and `resolveDenyTools` from `supervisor.ts` into it, and re-export `resolveDenyTools` from `supervisor.ts`. Verify: `pnpm run typecheck` passes and the existing `resolveDenyTools` test in `test/test.ts` passes unchanged.
- [x] 1.2 Add `test/child-env.test.ts`. Cover: a round trip of a full `ChildEnv` and of a minimal one; `encodeChildEnv` leaves out `PI_DENY_TOOLS` for an empty list and `PI_LUVUS_AUTO_EXIT` when it is false; `decodeChildEnv` trims and drops empty deny entries and treats `""` as not set; `isSubagentChild` is true only when `PI_LUVUS_SESSION` is set. Verify: `pnpm test` passes.

## 2. Producers

- [ ] 2.1 Change `buildSpawnEnvParts` (`supervisor.ts`) to `PI_CODING_AGENT_DIR` plus `encodeChildEnv(...)`, and keep its signature. Verify: `supervisor.test.ts` (the deepEqual spawn-env test, the role and auto-exit env tests) and the `test.ts` roster env test pass unchanged.
- [ ] 2.2 Change `cli.ts startCommand` to build `specEnv` with `encodeChildEnv`, and pass `denyTools: [...resolveDenyTools(definition)]`. Do not write `surface` or `parentRosterFile`. Verify: the existing `cli.ts start` tests pass, including `PI_LUVUS_SURFACE` being `undefined` in the spec.
- [ ] 2.3 Add `cli.ts start` tests in `test/cli.test.ts` for the three new spec-delta scenarios: `spawning: false` gives `PI_DENY_TOOLS=luvus_spawn,luvus_interrupt,luvus_list,luvus_resume`; `deny-tools: claude` gives `PI_DENY_TOOLS=claude`; no field gives no `PI_DENY_TOOLS`. In the CRLF test in `test/test.ts`, add `spawning: false` and `deny-tools: a, b` to the role and assert that the LF and CRLF results match. Verify: `pnpm test` passes.

## 3. Readers

- [ ] 3.1 In `index.ts`, decode the env once in the registration function and use it for the deny set, the self-spawn check, `readParentRoster` and `luvus_message` (design D3). Replace the local `isSubagentChild` with a re-export from `child-env.ts`. Verify: the `isSubagentChild`, status-reporter-skip and `luvus_message` tests in `test/test.ts` pass unchanged.
- [ ] 3.2 In `luvus-done.ts`, decode the env once at registration, replace every `process.env.PI_LUVUS_*` and `PI_DENY_TOOLS` read with the decoded value, and remove `parseDeniedTools`. Keep the nudge settings as direct env reads. Verify: `grep -n 'process.env.PI_LUVUS_\(NAME\|AGENT\|SESSION\|ID\|ACTIVITY_FILE\|AUTO_EXIT\)\|PI_DENY_TOOLS' pi-extension/luvus/luvus-done.ts` finds nothing, and the luvus-done tests in `test/test.ts` and `test/context-alert.test.ts` pass unchanged.
- [ ] 3.3 In `live-title.ts` and `turn-notify.ts`, replace the `PI_LUVUS_NAME` check with `isSubagentChild(env)`, and update the comments that name NAME. Change `live-title.test.ts:124` and `turn-notify.test.ts:164` to set `PI_LUVUS_SESSION`. Add one case to each test: a pane with only `PI_LUVUS_NAME` set still gets the title or notification. Verify: `pnpm test` passes.
- [ ] 3.4 In `supervisor.ts`, take `parentName` from `decodeChildEnv(process.env).name ?? "parent"`. Verify: the roster tests in `test/supervisor.test.ts` pass unchanged.
- [ ] 3.5 Add one parent/child pair test in `test/child-env.test.ts`. Build a spawn env with `buildSpawnEnvParts` for a `spawning: false`, auto-exit role. Register `luvus-done.ts` and `index.ts` against a mock extension API with that env. Assert that the child is a child, that the spawning tools are not registered and are listed as denied, and that `luvus_message` has a parent. Verify: `pnpm test` passes.

## 4. Phase vocabulary and observation adapter

- [ ] 4.1 In `status.ts`, delete `StatusActivityPhase` and import `type SubagentActivityPhase` from `activity.ts`. Verify: `pnpm run typecheck` passes and `grep -rn StatusActivityPhase pi-extension test` finds nothing.
- [ ] 4.2 Add `toStatusObservation(read)` and `buildActivityLabel(activity)` to `status.ts` (design D5). Change `observeRunningSubagent` to call `observeStatus` one time with the adapter result, and remove `activityLabel` from `supervisor.ts`. Add tests in `test/test.ts`: an ok read maps every field (tool scope gives the tool name or `tool`; a non-active phase gives no label); each failure reason (`missing`, `invalid`, `wrong-id`) maps to that snapshot with its error. Verify: the observe and classify tests in `test/test.ts` and `test/supervisor.test.ts` pass unchanged, and the new tests pass.
- [ ] 4.3 Rename the `status.ts` display fallback to an exported `displayActivityLabel(snapshot)`, and use it in `formatWidgetRightLabel`. Verify: the widget right-label and status-line tests pass unchanged.

## 5. Gates

- [ ] 5.1 Run `pnpm test`, `pnpm run lint`, `pnpm run format:check` and `pnpm run typecheck`. All four pass.
- [ ] 5.2 Run `openspec validate child-env-contract --strict`. It passes.

## Workflow follow-up

- The user does live acceptance. Suggested check: launch a `scout` child with `node skills/pi-luvus/launch.ts start ...` and confirm that its tool widget shows `4 denied` (or `5 denied` with `claude`).
- Archive the change after review and acceptance.
