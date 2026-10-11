---
name: pi-luvus
description: Delegated subagents for build, review, recon, or doc work across the rust-worker, reviewer, scout, worker, and advisor roles, each running as a pi process in its own Luvus pane and reporting back via luvus agent send. Relevant to requests phrased as launching, spinning up, spawning, starting, or delegating to another agent — a review agent for a commit, a worker implementing a task, a scout mapping unfamiliar code, review-fix loops repeating until pass, or mbv-orchestrator campaign work.
---

# pi subagents via Luvus

You orchestrate; every subagent is a **pi** process in its own
Luvus pane. Don't use your harness's built-in subagent tool (e.g. Claude
Code's Agent tool) for these roles. Requires a Luvus session
(`LUVUS_ENV=1` with `$LUVUS_BIN_PATH` and `$LUVUS_PANE_ID` set); outside Luvus
this skill does not apply. If the user wants the orchestrator to do the work
itself rather than launching a separate agent — a direct review with no agent
requested — do it directly instead. The child runs pi with the
`luvus-done` extension, which gives it the `luvus_done` tool plus
auto-exit: an `auto-exit: true` child whose turn ends
normally closes itself (writing the `.exit` sidecar); any other child that ends
a turn without calling `luvus_done` gets a 5-second completion nudge reminding
it until it does.

All launching goes through `launch.ts`, which lives next to this file. Run it
with `node <skill-dir>/launch.ts <command>`. It finds the child extension,
resolves the role, appends the parent-contact footer to your brief, splits and
names the pane, and writes a JSON launch spec that the pane-side run wrapper
executes. Never retype its steps by hand — invoke the script.

Two channels with different jobs — do not confuse them:

- **Wake-up / report** = `luvus agent send <me> '<text>'`, run by the child.
  This delivers a message into your pane and starts a new turn. It is the
  ONLY way you learn anything, because you cannot poll after ending your
  turn. (A pi orchestrator with the pi-luvus parent extension
  loaded polls `.exit` itself — it should use its `luvus_spawn` tool, not this
  skill. Every other orchestrator has no such loop.)
- **Lifecycle** = the `<session>.exit` sidecar file, written by
  `luvus_done` (`{"type":"done"}`). The pane-side wrapper prints
  `__SUBAGENT_DONE_<exit code>__` when the child exits, and closes its own pane
  only on a `done` sidecar, after a grace period (5000 ms by default, set per
  launch with `--close-grace-ms`). Check `.exit` only while you are already
  awake in a turn: to confirm shutdown, or to detect a silent crash.

Role definitions resolve in this order: the project's `.pi/agents/`, then
the global `~/.pi/agent/agents/`, then the package's own `agents/`.
Current roles: `rust-worker` (code), `reviewer`
(bounded review), `scout` (recon), `worker` (docs / rote), `advisor` (only
with user consent).

## Launch

0. Name your own pane once so children can reach you:
   `luvus agent name <me>` (e.g. `qop-orchestrator`).
1. Write the brief to a file — the task, nothing else. The launcher
   appends the parent-contact footer (your name and pane, the report
   procedure) itself.
2. Start the child:
   ```bash
   node <skill-dir>/launch.ts start --name <child> --role <role> --cwd <dir> --brief <file> --parent <me> [--scratch <dir>] [--close-grace-ms <n>] [--surface right|down|tab]
   ```
   `<cwd>` is the child's working directory; `--scratch` (default
   `${TMPDIR:-/tmp}/pi-luvus`) holds the generated prompt, role prompt
   and launch spec. `--surface` places the new pane: `right` (default) splits
   yours side by side, `down` stacks it below, `tab` gives it its own
   workspace tab; when omitted, it comes from the
   extension's `config.json`. On success it prints JSON on stdout:
   `{"pane":..., "session":..., "launch":...}`. `launch` is the launch-spec
   path a resume needs; a `done` child closes its own pane after the close
   grace, so the pane id matters only while the child is alive.
3. End the turn. The report arrives as a new message in your prompt — that
   is the child running `luvus agent send`. Do NOT sit in a polling loop on
   `<session>.exit` instead of ending your turn; the wake-up is the message,
   not the file. While you are awake anyway, check:
   - `<session>.exit` holding `{"type":"done"}` → clean finish. The pane
     has closed itself after the close grace. `rm` the `.exit` after reading.
   - `<session>.exit` holding `{"type":"error",...}` → provider failure —
     auto-retry exhausted, no report was sent. The pane stays open showing
     `__SUBAGENT_DONE_<n>__`; read the last assistant message from the
     session file per step 4, then retry or resume. `rm` the `.exit` after
     reading, and close the pane once you are done with it.
   - `.exit` absent + `__SUBAGENT_DONE_<n>__` at the tail of
     `luvus agent read <child>` → the process died without phoning home
     (crash). The pane stays open. Read the last assistant message from the
     session file (step 4) and decide whether to relaunch, then close the
     pane once you are done with it.
4. Cross-check the report against the child's last assistant message in
   the session file from the start JSON:
   ```bash
   node <skill-dir>/launch.ts last-message --session <file>
   ```
   It prints the text of the session's last assistant message, or
   `(no assistant message)`.

### Waiting for a child

`luvus wait agent-status <pane> --status done,blocked --timeout <seconds>`
blocks until the child publishes a terminal status. Treat the result as a hint
and confirm it against `<session>.exit`:

- Exit 0: read `<session>.exit`. `{"type":"done"}` means the child finished
  cleanly; `{"type":"error",...}` means a provider failure.
- Exit 2 ("pane not found") after the close grace: the wrapper has already
  closed a done pane. Read `<session>.exit` — `done` means finished, absent
  means a crash whose pane was closed by hand.
- Exit 0 at once on a pane that has not registered a status lease yet is a
  false positive (Luvus's command fallback reads `done` on an empty pane).
  Never treat `wait` alone as completion.

## While it runs / after

- A follow-up (a recheck, or the answer to the child's question) always
  runs in a **new** pane: `rm` the child's `.exit`, write the follow-up to
  a prompt file, and run:
  ```bash
  node <skill-dir>/launch.ts resume --launch <spec> --prompt <file> [--name <child>] [--surface right|down|tab]
  ```
  `<spec>` is the `launch` field from the start JSON; `--name` defaults to
  the child name stored in the spec. `--surface` places the resumed pane the
  same way as `start`. The same session resumes with full
  context and the child re-reports the same way. The old pane is not needed.
  A fresh role or a correction lane → new child via `start`.
- Idle child (you expected a report long ago): `luvus agent send <child>`
  a nudge — "status? send your report with luvus agent send, then call
  luvus_done". The child extension's own 5-second nudge handles the
  common forgot-to-exit case; this one handles a silent stall.
- If you find `{"type":"ping",...}` in `.exit` (the child ignored the footer
  and used `caller_ping`): the question is in the file. `rm` it, write your
  answer to a prompt file, and run `resume` with that prompt. The
  pane stays open until you close it.
- `luvus pane read <id>` positional arg is unreliable — use `agent read`.
- Close the pane only for `error`, `ping` and crash panes once you are done
  with them: `luvus pane close <P>`. A `done` pane closes itself after the
  close grace — there is nothing to close. Never close panes you didn't create.
- One writer per worktree at a time; read-only roles may run in parallel.

## Review-fix loop

For "review this commit, fix the findings, repeat until pass": launch one
`reviewer` child with `node <skill-dir>/launch.ts start`. Each round: assess the
returned findings yourself, apply the fixes (or delegate them to a `worker`
child), commit, then write a `review <SHA>` follow-up prompt and run
`node <skill-dir>/launch.ts resume` with it. The resumed session keeps context
across rounds, so it can verify its earlier findings are actually addressed.
When it reports pass, ship.
