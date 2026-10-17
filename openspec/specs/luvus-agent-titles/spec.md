# luvus-agent-titles Specification

## Purpose
Defines the titles that live pi panes and resumable pi sessions show in the Luvus AGENTS sidebar, so you can tell pi sessions apart.

## Requirements

### Requirement: Unnamed pi panes show their first prompt
For a non-subagent pi session that has no session name, the extension SHALL set the pane OSC title to `π - <prompt> - <cwd basename>`. `<prompt>` is the first non-empty line of the first user prompt, cut to 48 characters. Before the first prompt, pi's own title stays.

#### Scenario: First prompt in an unnamed session
- **WHEN** you send the prompt "Fix the login redirect" in an unnamed pi session in `/work/app`
- **THEN** the AGENTS row title is `π - Fix the login redirect - app`

#### Scenario: Session reload
- **WHEN** the extension reloads in a session that already has a first prompt
- **THEN** the pane title is set again from that first prompt

### Requirement: Session names take precedence
When a pi session has a name, the extension SHALL NOT set the OSC title. pi's own title `π - <name> - <cwd basename>` shows instead.

#### Scenario: Name set after the first prompt
- **WHEN** you name a session after its first prompt
- **THEN** the AGENTS row title changes to pi's named title and the extension does not overwrite it

### Requirement: Subagent pane titles stay as they are
In a subagent child, the extension SHALL NOT set the first-prompt title. The child keeps its `<name> — <task>` title.

#### Scenario: Subagent child
- **WHEN** a subagent child starts with a task
- **THEN** its pane title is `<name> — <task>`, not a first-prompt title

### Requirement: Resumable pi sessions show the project folder
The package ships no Luvus module. A finished pi session has no live pane and no title, so its AGENTS history row shows only the project folder. The extension works normally.
