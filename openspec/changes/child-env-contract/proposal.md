# Proposal

## Why

The parent/child env contract (`PI_LUVUS_*` and `PI_DENY_TOOLS`) is written by hand in two producers (the supervisor and `cli.ts start`) and parsed by hand in five readers. The two producers already differ: a skill-launched child does not get `PI_DENY_TOOLS`. The readers use two different "is this a child" rules (`PI_LUVUS_SESSION` and `PI_LUVUS_NAME`). The subagent phase vocabulary is also defined twice (`SubagentActivityPhase`, `StatusActivityPhase`) and joined by a hand copy in the supervisor. Issue #4 lists these as candidates 3 and 4. PR #5 gave the lifecycle one owner, so the contract and the observation join can now get one owner each.

## What Changes

- Add one child-env module. It encodes the child env for both producers and decodes it for all child-side readers. `resolveDenyTools` moves into it.
- `cli.ts start` resolves the role's `spawning` and `deny-tools` fields and writes `PI_DENY_TOOLS`, the same as a pi-parent launch. This is the only change to the launch contract.
- Every reader marks a child by `PI_LUVUS_SESSION`. `live-title.ts` and `turn-notify.ts` change from `PI_LUVUS_NAME` to this rule. Both producers always set both vars, so production behavior does not change.
- Delete `StatusActivityPhase`. `status.ts` uses `SubagentActivityPhase` from `activity.ts`.
- Add one adapter from an activity-file read to a `StatusObservation`. It replaces the field-by-field copy in `observeRunningSubagent`. The `label ?? scope` display fallback gets one shared function, which replaces the copy in `formatWidgetRightLabel`.
- Add unit tests that use fakes: an encode/decode round trip, a parent and child pair through the one module, the skill-path deny env, and the adapter for each read result.

No change to the `.exit` sidecar, the `luvus-done.ts` entry point, the Claude Code backend env, or the activity-file JSON.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `external-orchestration`: the "Role resolution" requirement adds the `spawning` and `deny-tools` frontmatter fields to the fields `start` uses. A skill-launched child gets the same denied tools as a pi-parent launch of the same role.

## Impact

- Code: new `pi-extension/luvus/child-env.ts`; edits to `supervisor.ts`, `cli.ts`, `index.ts`, `luvus-done.ts`, `live-title.ts`, `turn-notify.ts`, `status.ts`.
- Tests: `test/test.ts`, `test/supervisor.test.ts`, `test/cli.test.ts`, `test/live-title.test.ts`, `test/turn-notify.test.ts`, plus a new `test/child-env.test.ts`.
- Visible effect for skill users: the child's tool widget shows `N denied` for roles with `spawning: false` or `deny-tools`. A user role that lists a spawning tool in `tools` and also sets `spawning: false` no longer registers that tool.
- No new dependency. No config or Luvus change.
