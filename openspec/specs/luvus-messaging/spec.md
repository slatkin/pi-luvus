# Subagent Messaging

## Purpose

Lets pi agents in one subagent tree (a parent, its running children, and siblings) exchange short text messages while they run. Luvus delivers each message into the target agent's pane.

## Requirements

### Requirement: Message tool
Every pi agent running this extension inside Luvus SHALL have a `luvus_message` tool with parameters `to` (target name) and `message` (non-empty text). The tool MUST validate both parameters and reject an empty `message` without sending anything.

#### Scenario: Empty message
- **WHEN** `luvus_message` is called with `to: "parent"` and `message: ""`
- **THEN** the tool returns an error and nothing is delivered

### Requirement: Reachable targets
A sender SHALL be able to address exactly these targets:
- `parent`: the agent that spawned the sender (only when the sender is a subagent);
- the name of one of the sender's own running children;
- the name of a running sibling (another running child of the sender's parent), excluding the sender itself.

No other agent SHALL be reachable, whether a grandchild, grandparent, finished subagent, or unrelated Luvus agent. When `to` matches no reachable target, the tool MUST return an error that lists the currently reachable target names. When a name matches more than one running agent, the tool MUST return an error listing the matches with their ids and send nothing. A target given as an exact subagent id MUST resolve without ambiguity.

#### Scenario: Parent redirects a running child
- **WHEN** a parent with a running child "Scout" calls `luvus_message({to: "Scout", message: "Skip the tests dir"})`
- **THEN** Scout's pane receives the message while Scout keeps running

#### Scenario: Child asks the parent without exiting
- **WHEN** subagent "Worker" calls `luvus_message({to: "parent", message: "Which DB driver?"})`
- **THEN** the parent's pane receives the message and Worker's session stays open

#### Scenario: Sibling handoff
- **WHEN** "Worker" and "Reviewer" are running children of the same parent and Worker sends to "Reviewer"
- **THEN** Reviewer's pane receives the message

#### Scenario: Unknown or finished target
- **WHEN** a child sends to "Scout" after Scout has finished
- **THEN** the tool returns an error listing the reachable targets (for example `parent, Reviewer`) and sends nothing

#### Scenario: Top-level agent addresses parent
- **WHEN** a pi agent that is not a subagent sends to `parent`
- **THEN** the tool returns an error saying this agent has no parent

### Requirement: Message delivery through Luvus
Messages to a child or sibling SHALL be delivered by resolving the target to its Luvus pane id and issuing Luvus `agent prompt` to that pane id, without a shell and without `--wait`. The extension MUST NOT address the target by Luvus name or agent kind. The tool SHALL return as soon as Luvus reports the message queued, and its result MUST state that delivery is asynchronous and any reply will arrive as a separate message.

#### Scenario: Queued
- **WHEN** Luvus answers `agent prompt` with `submitted: true`
- **THEN** the tool returns success with the target name and pane id, and does not wait for the target to act

### Requirement: Messages to the parent bypass the parent's composer
Messages to `parent` MUST NOT be typed into the parent's pane. The sender SHALL append each one to a message file tied to its own subagent session. The parent SHALL pick it up while it is watching that child and inject it into its own conversation as a steering message that triggers a turn, the way it already surfaces child completions. Before handling a child's completion, the parent SHALL deliver all of that child's pending messages. If the message file cannot be written, the tool MUST return an error.

#### Scenario: Parent has an unsent draft
- **WHEN** the user has typed an unsent draft in the parent's composer and a child sends to `parent`
- **THEN** the draft is left untouched and unsent, and the message appears in the parent's conversation with its sender header

#### Scenario: Message right before exit
- **WHEN** a child sends to `parent` and immediately calls `luvus_done`
- **THEN** the parent receives the message before the child's completion result

### Requirement: Delivery failures are reported, not retried
If Luvus returns an error, such as `agent_not_ready`, an unknown pane or a closed pane, the tool MUST return an error containing the Luvus error code or message. It MUST NOT resend automatically.

#### Scenario: Target is on an approval screen
- **WHEN** Luvus answers `agent prompt` with `agent_not_ready`
- **THEN** the tool returns an error naming the target and `agent_not_ready`, and sends nothing again

### Requirement: Sender header
Every delivered message SHALL begin with a single header line identifying the sender's name and relation to the receiver, for example `[subagent message from Worker (sibling)]` or `[subagent message from parent]`, followed by the message text unchanged.

#### Scenario: Header on sibling message
- **WHEN** Worker sends "API is in src/api" to sibling Reviewer
- **THEN** Reviewer receives `[subagent message from Worker (sibling)]` followed by `API is in src/api`

### Requirement: Agents are told about messaging
A pi subagent's launch prompt SHALL name the targets it can reach at spawn time (`parent` and the names of currently running siblings) and say that `luvus_message` is for talking without exiting, while `caller_ping` and `luvus_done` end the session. The tool descriptions of `luvus_message`, `caller_ping` and `luvus_done` SHALL state this distinction.

#### Scenario: Launch prompt lists peers
- **WHEN** a parent spawns "Reviewer" while "Worker" is running
- **THEN** Reviewer's launch prompt says it can message `parent` and `Worker` with `luvus_message`

### Requirement: Claude Code subagents are receive-only
Claude Code subagents SHALL be valid message targets, but the extension SHALL NOT provide them a sending tool.

#### Scenario: Message a Claude Code child
- **WHEN** a parent sends to its running Claude Code child "Claude"
- **THEN** the message is delivered to that child's pane with the sender header
