# Subagent Surface

## Purpose

Defines how the subagent surface placement choice (pane or tab) is resolved and persisted: a user-set default in `config.json`, a live `/luvus-surface` slash command in the TUI, and a per-call `surface` tool override.

## Requirements

### Requirement: Surface placement default in config
The extension SHALL read an optional `surface` key from its package `config.json` (the same file that holds `status.enabled`). The value SHALL be either `"pane"` or `"tab"`. When the key is absent or invalid, the default SHALL be `"pane"`. When the value is `"tab"`, spawning or resuming a subagent SHALL place the new pane in its own workspace tab; otherwise it SHALL split the caller's pane as before.

#### Scenario: Default set to tab
- **WHEN** `config.json` contains `"surface": "tab"` and a subagent is spawned without a `surface` parameter
- **THEN** the subagent's pane is placed in its own workspace tab and the caller's tab regains focus

#### Scenario: Default unset
- **WHEN** `config.json` has no `surface` key or an invalid value and a subagent is spawned
- **THEN** the subagent opens as a split of the caller's pane, as before

### Requirement: Slash command to show and change the default
The extension SHALL register a `/luvus-surface` command. With no argument it SHALL report the current default. With `tab` or `pane` as argument it SHALL set the default, confirm the new value to the user, and persist it to `config.json` so it survives restart. With any other argument it SHALL show the current default and the accepted arguments without changing anything.

#### Scenario: Show current default
- **WHEN** the user runs `/luvus-surface` with no argument
- **THEN** the current default surface is reported

#### Scenario: Change the default
- **WHEN** the user runs `/luvus-surface tab`
- **THEN** the default becomes `tab`, the user sees a confirmation naming the new value, and the value is persisted so it survives a restart

#### Scenario: Invalid argument
- **WHEN** the user runs `/luvus-surface window`
- **THEN** the current default is reported unchanged, along with the accepted arguments `pane` and `tab`

### Requirement: Per-call tool override
The `luvus_spawn` and `luvus_resume` tools SHALL accept an optional `surface` parameter with values `"pane"` and `"tab"`. When present, it SHALL override the configured default for that spawn. When absent, the configured default applies. An invalid `surface` value SHALL be treated as absent.

#### Scenario: Override the default for one spawn
- **WHEN** the default surface is `pane` and `luvus_spawn` is called with `surface: "tab"`
- **THEN** that one subagent opens in its own tab and the default stays `pane` for later spawns

#### Scenario: Invalid override value
- **WHEN** `luvus_spawn` is called with `surface: "window"`
- **THEN** the value is ignored and the configured default applies
