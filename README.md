# pi-luvus

pi integration for [Luvus](https://luvus.dev). It runs async subagents in Luvus panes, reports live agent status, and adds Luvus bar and notification modules, and subagent management and orchestration skills that try to leverage Luvus features.

The subagent code descends from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents). The completion-nudge design comes from [maplezzk's port](https://github.com/maplezzk). Luvus is the only supported terminal host.

## How It Works

`luvus_spawn()` returns at once. The child runs in its own Luvus pane. The pane splits from your pane and keeps your focus. A live widget above the input shows the state of each child: `starting`, `active`, `waiting`, `stalled`, or `running`. When a child finishes, its result arrives as a steer message. A steer message is a notification that starts a new turn. You then process the result with new context.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)        active · bash 7m │
│ 00:45  Scout: DB (scout)                waiting 2m │
╰────────────────────────────────────────────────────╯
```

For parallel work, call `luvus_spawn` multiple times. The children run concurrently:

```typescript
luvus_spawn({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
luvus_spawn({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Pane status

The extension reports the live state of every pi pane to Luvus, including panes that never spawn a subagent. Without it, Luvus shows each pi pane as `idle`, even during a turn.

The extension sets `working` while a turn runs and `idle` while the session waits for input. A `working` report names the running tool. Read it with `luvus agent explain <pane>` as `authority.message` (`luvus agent list` has no message field). The extension also binds the pi session id to the pane.

Each report is a Luvus status lease with a 300-second TTL. The extension renews the lease at half the TTL, also while pi is idle, so an idle pane keeps its status. Renewal stops after `done` or `blocked`, or on shutdown. Non-terminal reports run in the background and do not block pi. Terminal reports (`done`, `blocked`) and the release stay synchronous.

A subagent publishes `done` or `blocked` when it finishes. External orchestrators wait on that status (see [External orchestrators](docs/guide.md#external-orchestrators-claude-code)). For the full details, read [Live pi status in Luvus](docs/guide.md#live-pi-status-in-luvus).

### Resumable session titles

A resumable pi session has no live pane and no OSC title. Luvus then shows only the project folder on the AGENTS history row. The optional [`luvus-module/`](luvus-module/) gives the row a title from the session name, or the first prompt when the session has no name (the same 48-character rule as the live pane title). Read [Resumable session titles (Luvus module)](docs/guide.md#resumable-session-titles-luvus-module).

### Luvus Bar usage widget

The same module publishes the Luvus Bar widget `pi-luvus.pane-titles:pi-usage`. It shows three totals for the live pi panes: the pane count, the sum of the session costs, and the largest context token count in the group. The cost shows in dollars with two decimals. The context shows as tokens (`31k`, `1.3M`), not as a percentage: a session file has no context window size. The widget clears when the last pi pane closes.

After you upgrade the package, unlink and link the module again to load the new manifest. Read [Usage widget (Luvus module)](docs/guide.md#usage-widget).

### Resume pi sessions

Luvus binds each pi session id to its pane. After the pane closes, the session stays resumable: `luvus agent sessions` lists it, and `luvus agent resume <session id>` reopens it in a new pane. Read [Resume pi sessions](docs/guide.md#resume-pi-sessions).

### Turn-end notification

When a turn ends in a parent pi pane that does not have focus, the extension pushes one Luvus notification. A normal turn sends `pi turn ended: <label>` at level `success`. A turn whose last assistant message failed sends `pi turn failed: <label>` at level `error`. An aborted turn sends nothing. The label is the session name, or the basename of the session cwd when the session has no name. Subagent children send no notification — their completion already reaches the parent through the status lease and `luvus_done`. The focus check and the push run in the background and never delay the next turn.

## Configuration

The extension reads `config.json` from `~/.pi/agent/extensions/pi-luvus/` (under `$PI_CODING_AGENT_DIR` when that variable is set). Seed it from `config.json.example`.

| Key              | Type    | Default | Description                                                                                                                    |
| ---------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `notify.enabled` | boolean | `true`  | Turns the turn-end notification off. Set it to `false` if Luvus already cues your pi panes for status changes.                  |
| `contextAlert.enabled` | boolean | `false` | Turns the subagent context alert on. When it is on, a subagent child whose context usage reaches the threshold gets one steer message that tells it to stop and hand off with `luvus_done` and its `handoff` parameter. |
| `contextAlert.threshold` | number \| string | `200000` | The alert threshold: a context token count, or a percentage of the model's context window as a string (`"80%"`). Select a value below the compaction point — a threshold at or above it never fires. |

Like a bad `status` block, a bad `contextAlert` block stops the extension from loading in the parent pi session.

### Handoff log

When the context alert is on, each subagent child appends one JSON line to `handoffs.jsonl` in the same directory as `config.json` when the alert fires (`"event": "alert"`) and when it ends the session with `luvus_done` and a `handoff` text (`"event": "handoff"`). Each line holds `at` (ISO time), `event`, `luvusSession` (the Luvus server session name, or the socket path when it cannot be resolved, or `null` outside Luvus), `child` (the subagent name), `session` (the child's session file), and `tokens` (the context token count, `null` when unknown); an `alert` line also holds `threshold` as configured (`200000` or `"80%"`). Log writes are best effort: a failed write never blocks the alert, the sidecar, or the shutdown.

Count the completed handoffs:

```bash
jq -s '[.[] | select(.event == "handoff")] | length' ~/.pi/agent/extensions/pi-luvus/handoffs.jsonl
```

The `status` and `surface` keys are documented in [Configuration](docs/guide.md#configuration).

## Install

```bash
pi install git:github.com/slatkin/pi-luvus
# or from a local checkout:
pi install /path/to/pi-luvus
```

Luvus is required. Run pi inside a Luvus pane. Outside Luvus the extension spawns nothing. For environment variables and focus behavior, read [Environment](docs/guide.md#environment).

## External orchestrators (Claude Code)

If the orchestrator is not a pi session (for example Claude Code), drive pi subagents through the packaged `pi-luvus` skill. Install it from GitHub or from a local checkout:

```bash
npx skills add slatkin/pi-luvus -g -a claude-code
# or from a local checkout:
npx skills add /path/to/pi-luvus -g -a claude-code
```

The skill launches each child in its own pane and waits for a terminal Luvus status. For the launcher commands, the completion signal, and close-on-done behavior, read [External orchestrators](docs/guide.md#external-orchestrators-claude-code).

## What's Included

### Extensions

The package provides 5 main-session tools and 2 commands, plus 2 tools that run only in the child (`caller_ping`, `luvus_done`):

| Tool                 | Description                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `luvus_spawn`           | Spawn a sub-agent in a dedicated Luvus pane (async — returns immediately)                    |
| `luvus_interrupt` | Interrupt a running Pi-backed subagent's current turn                                        |
| `luvus_message`   | Message the parent, a running child, or a running sibling without ending the session (async) |
| `luvus_list`     | List available agent definitions                                                             |
| `luvus_resume`    | Resume a previous sub-agent session (async)                                                  |

| Command                        | Description                              |
| -------------------------------------- | ---------------------------------------- |
| `/luvus-spawn <agent> <task>`             | Spawn a named agent directly             |
| `/luvus-surface [right\|down\|tab]` | Show or set the default subagent surface |

### Bundled Agents

| Agent           | Default model                             | Role                                                                              |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `claude-code`   | Claude Code CLI, model `opus`             | Self-driving Claude Code session for deep investigation and hands-on experiments. |
| `scout`         | `openrouter/qwen/qwen3.8-flash`           | Fast codebase reconnaissance. Maps files, patterns, and conventions.              |
| `worker`        | `openrouter/z-ai/glm-5.3-flash`           | Implements tasks from todos. Writes code, runs tests, makes commits.              |
| `reviewer`      | `openrouter/deepseek/deepseek-v4.1-flash` | Reviews code for bugs, security issues, and correctness.                          |
| `visual-tester` | `openrouter/deepseek/deepseek-v4.1-flash` | Visual QA through Chrome CDP. Screenshots, responsive checks, interaction tests.  |

Agent discovery uses this order: project-local (`.pi/agents/`), global (`~/.pi/agent/agents/`), package-bundled. To override a bundled agent, place a file with the same name in a higher-priority location. These models are defaults from each agent frontmatter. Pi resolves the name through its provider configuration. Override one spawn with the `model` parameter on the `luvus_spawn` tool, or permanently in frontmatter.

## Documentation

The [guide](docs/guide.md) holds the full reference:

- [Async subagent flow](docs/guide.md#async-subagent-flow): the decision model, status labels, and configuration.
- [Spawning subagents](docs/guide.md#spawning-subagents): the `luvus_spawn` tool parameters.
- [Interrupting](docs/guide.md#interrupting-a-running-subagent), [messaging](docs/guide.md#messaging-other-agents), and [`caller_ping`](docs/guide.md#caller_ping-child-to-parent-help-request).
- [Custom agents](docs/guide.md#custom-agents): frontmatter, `session-mode`, `auto-exit`, the completion nudge, and `interactive`.
- [Tool access control](docs/guide.md#tool-access-control), [role folders](docs/guide.md#role-folders), and the [tools widget](docs/guide.md#tools-widget).

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono): the coding agent.
- [Luvus](https://luvus.dev): run pi inside a Luvus pane. There is no headless fallback.
- [Node.js](https://nodejs.org) >= 22.18: the version that runs the TypeScript files of the package with no flag. The pane-side run wrapper, the skill launcher, and the Claude stop hook are Node programs.

---

## Migrating from pi-luvus-subagents

This package replaces `pi-luvus-subagents`. The old names do not work. Change them as follows:

| Old | New |
|---|---|
| `git:github.com/slatkin/pi-luvus-subagents` | `git:github.com/slatkin/pi-luvus` |
| `~/.pi/agent/extensions/pi-luvus-subagents/config.json` | `~/.pi/agent/extensions/pi-luvus/config.json` |
| tools `subagent`, `subagent_interrupt`, `subagent_message`, `subagent_resume`, `subagents_list`, `subagent_done` | `luvus_spawn`, `luvus_interrupt`, `luvus_message`, `luvus_resume`, `luvus_list`, `luvus_done` |
| commands `/subagent`, `/subagent-surface` | `/luvus-spawn`, `/luvus-surface` |
| env vars `PI_SUBAGENT_*`, `PI_LUVUS_SUBAGENTS_DIR` | `PI_LUVUS_*`, `PI_LUVUS_DIR` |
| skill `pi-subagents` | skill `pi-luvus` |
| module `pi-luvus-subagents.pane-titles` | module `pi-luvus.pane-titles` (run `luvus module unlink` for the old id, then `luvus module link`) |

## Acknowledgements

- [HazAT](https://github.com/HazAT): original pi-interactive-subagents.
- [maplezzk](https://github.com/maplezzk): the completion-nudge design ported here.
- [RepoPrompt](https://repoprompt.com/): its child snapshot polling and run cancellation inspired the status supervision and turn-only interruption here.

---

## License

MIT
