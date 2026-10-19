# pi-luvus

pi integration for [Luvus](https://luvus.dev).

- Reports live status to Luvus. Each pane reports `working` or `idle` (and `done` or `blocked` at exit) through a status lease, pi sessions bind to their pane so closed sessions stay resumable from Luvus, and an unfocused pane pushes a Luvus notification when its turn ends.

- Adopts the subagent system from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) — with the completion nudge from [maplezzk's port](https://github.com/maplezzk) — and implements it for Luvus panes. On top of it, this package adds: messages between running agents (`luvus_message`), a skill and launcher that let a non-pi orchestrator such as Claude Code drive pi children, context alert with handoff to a fresh agent, pane placement (right, down, or tab), live pane titles, spawn-time role records so a resume restores the role as it was at spawn, event-driven watching, and a parent-side watchdog that finishes a stuck child instead of waiting forever.

## Install

```bash
pi install npm:pi-luvus
pi install git:github.com/slatkin/pi-luvus
# or from a local checkout:
pi install /path/to/pi-luvus
```

## External orchestrators (Claude Code)

If the orchestrator is not a pi session (for example Claude Code), drive pi subagents through the packaged `pi-luvus` skill. Install it from GitHub or from a local checkout:

```bash
npx skills add slatkin/pi-luvus -g -a claude-code
# or from a local checkout:
npx skills add /path/to/pi-luvus -g -a claude-code
```

The skill launches each child in its own pane and waits for a terminal Luvus status. For the launcher commands, the completion signal, and close-on-done behavior, read [External orchestrators](docs/guide.md#external-orchestrators-claude-code).

## Configuration

The extension reads `config.json` from `~/.pi/agent/extensions/pi-luvus/` (under `$PI_CODING_AGENT_DIR` when that variable is set). Seed it from `config.json.example`.

## Bundled Agents

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
- [Resuming a subagent](docs/guide.md#resuming-a-subagent): the launch record, the `luvus_resume` parameters, and the fallback without a record.
- [Interrupting](docs/guide.md#interrupting-a-running-subagent), [messaging](docs/guide.md#messaging-other-agents), and [`caller_ping`](docs/guide.md#caller_ping-child-to-parent-help-request).
- [Custom agents](docs/guide.md#custom-agents): frontmatter, `session-mode`, `auto-exit`, the completion nudge, and `interactive`.
- [Tool access control](docs/guide.md#tool-access-control), [role folders](docs/guide.md#role-folders), and the [tools widget](docs/guide.md#tools-widget).

---

## License

Released under the [MIT License](LICENSE). The LICENSE file carries HazAT's copyright from the upstream code this package descends from.
