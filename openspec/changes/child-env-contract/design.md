# Design

## Context

See proposal.md (Why). The current state that shapes the approach:

- **Producers.** `buildSpawnEnvParts` (`supervisor.ts`) and the `specEnv` literal in `cli.ts startCommand` each write the child env by hand. Both go through `runSpec` (`run.ts`), which merges `spec.env` over the pane env and sets `PI_LUVUS_SURFACE` from `LUVUS_PANE_ID`. The skill spec must not hold `PI_LUVUS_SURFACE`, because `cli.test.ts` pins pane independence. The supervisor writes it, and `runSpec` replaces it at runtime.
- **Producer differences today.** `cli.ts` does not write `PI_DENY_TOOLS`: this is the gap that the spec delta closes. `cli.ts` does not write `PI_LUVUS_PARENT_ROSTER`, because a skill parent has no pi roster. `cli.ts` does not write `PI_CODING_AGENT_DIR`, because that is process config and not contract.
- **Readers.** `index.ts` reads `isSubagentChild` (SESSION), the deny `Set`, AGENT (self-spawn block), PARENT_ROSTER, and SESSION/ID/NAME (`luvus_message`). `luvus-done.ts` reads NAME, AGENT, the deny array, AUTO_EXIT, ID, ACTIVITY_FILE at registration, and it reads SESSION and NAME again inside handlers. `live-title.ts` and `turn-notify.ts` check NAME. `supervisor.ts` reads NAME as its own name in the roster (`parentName`).
- **Two meanings of NAME.** NAME is the child marker in title/notify, but it is also "my own name" (roster `parentName`, `luvus_message` `senderName`, both default `"parent"`). Test fixtures set `PI_LUVUS_NAME=parent` on a parent for this reason.
- **Marker equivalence.** Both producers always write NAME and SESSION together. Every resume replays a spec from the same builder. So SESSION and NAME give the same child answer in production. The `context-alert` spec already defines a child as "a session with `PI_LUVUS_SESSION` set".
- **Deny tools against `--tools`.** In pi 0.87.1, `--tools` removes a tool from the registry. Every child gets an allowlist (`buildSubagentToolAllowlist`). So `PI_DENY_TOOLS` changes registration only for a tool that the role's `tools` line also allows. It always drives the widget's denied line.
- **Claude Code backend.** Its env is only `PI_CLAUDE_SENTINEL`, and it does not load `luvus-done.ts`. This change does not touch it.
- **Phases.** `SubagentActivityPhase` (`activity.ts`) and `StatusActivityPhase` (`status.ts`) are the same four literals. `activity.ts` imports only Node built-ins, so `status.ts` can import its types with no cycle. `observeStatus` is called only by `observeRunningSubagent` and by tests. No spec pins the activity-file JSON.
- **Two `activityLabel` functions.** `supervisor.ts activityLabel(activity)` *builds* the label from an activity record. `status.ts activityLabel(snapshot)` is the *display fallback* `label ?? scope`, and `formatWidgetRightLabel` repeats it inline.

## Goals / Non-Goals

**Goals:**
- One module defines the child env names, their encoding and their decoding. Each producer and each reader calls it.
- One phase type. One function maps an activity read to a status observation. One display-fallback function.
- All existing tests keep passing with only the edits listed in tasks.md.

**Non-Goals:**
- Process settings stay where they are: `PI_LUVUS_NUDGE_*`, `PI_LUVUS_SHELL_READY_DELAY_MS`, `PI_LUVUS_PI_ENTRY`, `PI_LUVUS_SENTINEL_DIR`, `PI_LUVUS_DIR`, `PI_CODING_AGENT_DIR`, `PI_CLAUDE_SENTINEL`.
- No change to the `.exit` sidecar, the activity-file format, the `luvus-done.ts` entry path, or `runSpec` env merging.
- The env-leak risk below is not fixed here.
- No change to the `--tools` allowlist logic.

## Decisions

### D1. Module `child-env.ts` with a total decode

`pi-extension/luvus/child-env.ts` exports:

- `interface ChildEnv`: `name?`, `agent?`, `sessionFile?`, `id?`, `activityFile?`, `surface?`, `parentRosterFile?`, `autoExit: boolean`, `denyTools: string[]`.
- `encodeChildEnv(env: ChildEnv): Record<string, string>`. It writes only fields that are set. It writes `PI_LUVUS_AUTO_EXIT=1` only when `autoExit` is true. It writes `PI_DENY_TOOLS` (joined with `,`) only when `denyTools` is not empty.
- `decodeChildEnv(env: NodeJS.ProcessEnv): ChildEnv`. It reads every field. It treats an empty string as not set. It trims and drops empty deny entries (the current `parseDeniedTools` rule).
- `isSubagentChild(env)`: `decodeChildEnv(env).sessionFile !== undefined`. It moves here from `index.ts`, and `index.ts` re-exports it so the existing test import keeps working.
- `resolveDenyTools(agentDefs)` and `SPAWNING_TOOLS`, moved from `supervisor.ts`. `supervisor.ts` re-exports `resolveDenyTools` for the existing `testApi` use.

*Why a total decode, not `ChildEnv | null`:* `luvus-done.ts` reads NAME, AGENT, the deny list and AUTO_EXIT today even when SESSION is not set (the widget label, and tests with "no PI_LUVUS_SESSION"). A decode that returns null for a non-child would change that. The child test is a separate predicate.

*Why move `resolveDenyTools`:* `cli.ts` needs it. If it stays in `supervisor.ts`, `cli.ts` must load the whole supervisor (pi APIs, timers) to get one pure function.

*Alternative rejected:* one name constant per var, with no encode/decode. That removes the typos but leaves two hand-built env objects and five hand parsers, which is the drift this change removes.

### D2. Producers

- `buildSpawnEnvParts` keeps its signature and tests. Its body becomes `PI_CODING_AGENT_DIR` (when set) plus `encodeChildEnv({...})`. The supervisor still writes `surface` and `parentRosterFile`.
- `cli.ts startCommand` builds `specEnv` with `encodeChildEnv`. It passes `denyTools: [...resolveDenyTools(definition)]` and leaves out `surface` and `parentRosterFile`. This is the B1 behavior change in the spec delta.

### D3. Readers decode once, at registration

- `index.ts` registration decodes `process.env` once. It uses the result for the deny set, the self-spawn AGENT check, and `luvus_message` (`hasParent`, `selfId`, `senderName ?? "parent"`, message file). `readParentRoster` takes the roster path from the decoded env.
- `luvus-done.ts` decodes once at registration. Handlers that read `process.env.PI_LUVUS_SESSION` or `PI_LUVUS_NAME` today read the decoded value instead. `parseDeniedTools` is removed, because the decode now does that job. `luvus-done.ts` imports `child-env.ts`. That module imports only `agent-defs.ts` types, so the `-e` entry stays light.
- `live-title.ts` and `turn-notify.ts` keep their `env` parameter and call `isSubagentChild(env)` instead of checking NAME.
- `supervisor.ts` `parentName` uses `decodeChildEnv(process.env).name ?? "parent"`.

*Why decoding once is safe:* a pi process does not change its own `PI_LUVUS_*` env. The child-extension test helper (`loadChildExtension`) and `withStatusEnv` set env before they register.

### D4. Child marker is `PI_LUVUS_SESSION`

All readers use `isSubagentChild`. This matches the `context-alert` spec and `index.ts` today. Production does not change (see Context, "Marker equivalence"). NAME stays as the process's own name only.

### D5. Phase vocabulary and the observation adapter

- `status.ts`: delete `StatusActivityPhase`. Import `type SubagentActivityPhase` from `activity.ts` and use it in `StatusObservation` and in the status state.
- `status.ts` gets `toStatusObservation(read: ActivityReadResult): StatusObservation`. For `ok`, it builds the present observation (the 9 fields copied today, with `active = phase === "active"`). Otherwise it builds `{ snapshot: read.reason, snapshotError: read.error }`. The label builder moves with it as `buildActivityLabel(activity)`, with the same rules as `supervisor.ts activityLabel` today.
- `observeRunningSubagent` keeps its own bookkeeping (`running.activityRead`, `running.activity`) and calls `observeStatus(state, toStatusObservation(read), observedAt)` one time.
- The display fallback is exported as `displayActivityLabel(snapshot)` (`label ?? scope`). `formatWidgetRightLabel` calls it. The two functions then have different names for their different jobs.

*Why put the adapter in `status.ts` and not in a new observation module:* the adapter is about 20 lines, and `status.ts` already owns `StatusObservation`. A third module would add a file and give nothing back. `activity.ts` must not import `status.ts`, because `status.ts` pulls in config loading.

## Risks / Trade-offs

- [The title/notify marker change makes a parent with NAME set but no SESSION behave as a parent. Only test fixtures do this.] → `live-title.test.ts:124` and `turn-notify.test.ts:164` change to set `PI_LUVUS_SESSION`. Registration tests that set `PI_LUVUS_NAME=parent` keep it, because it is the sender name, and they emit no `agent_end` or prompt events.
- [B1 changes what a skill-launched child registers for a user role that lists a spawning tool in `tools` with `spawning: false`.] → This is the intended parity with pi-parent launches. The spec delta states it.
- [`runSpec` merges the pane env under `spec.env`. If a pane ever inherits a child's env, optional vars (`PI_DENY_TOOLS`, `PI_LUVUS_AGENT`, `PI_LUVUS_AUTO_EXIT`, `PI_LUVUS_PARENT_ROSTER`) could leak into a grandchild.] → Nothing shows that this happens, and fixing it would change env behavior. It is out of scope. Record it on issue #4 if the user wants it tracked.
- [`luvus-done.ts` gets one more import.] → `child-env.ts` imports types only. The `-e` cost does not change in practice.

## Migration Plan

None. No stored format changes. Rollback is a revert of the commit.
