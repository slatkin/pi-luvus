# Spec Delta

## Purpose

Lets a user watch an agent's thinking and tool usage in dedicated Luvus panes, while the main transcript shows only the conversation.

## ADDED Requirements

### Requirement: Stream command

The extension SHALL register a `/stream` command with arguments `thinking`, `tools`, `both`, and `close`. With no argument it SHALL report which streams are attached. An unrecognised argument SHALL report the accepted arguments and change nothing.

#### Scenario: Open a stream
- **WHEN** the user runs `/stream thinking`
- **THEN** the thinking stream is attached to a follower pane and the command confirms the attachment

#### Scenario: Report state
- **WHEN** the user runs `/stream` with no argument
- **THEN** the command reports each stream as attached or not attached, without opening or closing anything

#### Scenario: Reject an unknown argument
- **WHEN** the user runs `/stream alles`
- **THEN** the command lists `thinking`, `tools`, `both`, and `close`, and no pane or stream state changes

#### Scenario: Close all streams
- **WHEN** the user runs `/stream close`
- **THEN** every attached stream is detached and the follower panes it opened are closed

### Requirement: Follower pane placement

Opening two streams from one command SHALL place the first pane to the right of the calling pane and the second pane below the first. The panes SHALL be named `thinking` and `tools`. Opening a stream SHALL NOT move focus away from the pi pane.

#### Scenario: Both streams at once
- **WHEN** the user runs `/stream both` from a pi pane
- **THEN** a pane named `thinking` appears to the right and a pane named `tools` appears below the `thinking` pane, and the pi pane keeps focus

#### Scenario: Second stream opened later
- **WHEN** the thinking stream is already attached and the user runs `/stream tools`
- **THEN** the tools pane is split below the existing thinking pane

#### Scenario: Repeat request is idempotent
- **WHEN** the thinking stream is attached and the user runs `/stream thinking` again
- **THEN** no second thinking pane is created and the command reports that it is already attached

### Requirement: Streams require a Luvus pane

The command SHALL refuse to open a stream when the pi process does not know the id of a Luvus pane. It SHALL report that a Luvus pane is required and SHALL leave stream state unchanged.

#### Scenario: pi running outside Luvus
- **WHEN** the user runs `/stream thinking` in a pi process with no pane id in its environment
- **THEN** the command reports that a Luvus pane is required and nothing is opened or attached

### Requirement: Stream content

An attached thinking stream SHALL receive assistant thinking text as it streams. An attached tools stream SHALL receive one line when a tool call starts, its streamed output as it arrives, and one line when it ends, including whether it failed. Content for a stream that is not attached SHALL NOT be sent.

#### Scenario: Thinking is mirrored
- **WHEN** the model streams thinking text while the thinking stream is attached
- **THEN** the same text appears in the thinking pane as it is produced

#### Scenario: Tool lifecycle is mirrored
- **WHEN** a tool call starts, produces output, and finishes successfully while the tools stream is attached
- **THEN** the tools pane shows the call starting, the output, and a completion line

#### Scenario: Failed tool call
- **WHEN** a tool call finishes with an error while the tools stream is attached
- **THEN** the tools pane's completion line marks the call as failed

#### Scenario: Detached stream stays silent
- **WHEN** the tools stream is not attached and a tool call runs
- **THEN** no tool content is written to any socket

### Requirement: Replay of the current turn

On attach, a stream SHALL replay the current turn's content for that stream, so a pane opened mid-turn is not blank. Replay SHALL be bounded and held in memory only; the extension SHALL NOT write stream content to disk.

#### Scenario: Attach mid-turn
- **WHEN** the user opens the tools stream while a long tool call is already running
- **THEN** the tools pane shows that call's start and the output produced so far, then continues live

#### Scenario: Bounded replay
- **WHEN** a turn produces more content for a stream than the replay bound allows
- **THEN** the pane receives only the most recent portion and streaming continues from there

#### Scenario: No disk residue
- **WHEN** the user opens and closes a stream
- **THEN** no file containing stream content is created

### Requirement: Transcript omits attached content

While a stream is attached, the main transcript SHALL omit that stream's content: thinking blocks SHALL contribute no lines and no placeholder, and tool rows SHALL be absent together with their leading blank line. All other transcript content SHALL render as it does without a stream attached.

#### Scenario: Thinking hidden while attached
- **WHEN** the thinking stream is attached and the model emits thinking followed by text
- **THEN** the transcript shows only the text, with no thinking block, no marker, and no extra blank line where the thinking was

#### Scenario: Tool rows hidden while attached
- **WHEN** the tools stream is attached and a tool call runs
- **THEN** the transcript shows the surrounding conversation with no tool row and no blank line left in its place

#### Scenario: Each stream hides only its own content
- **WHEN** only the tools stream is attached
- **THEN** tool rows are absent and thinking blocks still render as they normally do

#### Scenario: Existing history is affected too
- **WHEN** a stream is attached in a session that already shows prior thinking blocks or tool rows
- **THEN** those earlier rows are also absent from the transcript while the stream stays attached

### Requirement: Detach restores the transcript

When a follower pane closes, the stream SHALL detach without any action in pi. The transcript SHALL be restored to its normal rendering immediately after the last pane for that stream is gone. Restoring SHALL NOT lose session history, scroll position, or pending input.

#### Scenario: Closing the pane
- **WHEN** the user closes the thinking pane while a turn is streaming
- **THEN** the thinking stream detaches and thinking content returns to the transcript from that point on, with prior blocks visible again

#### Scenario: One of two panes of a stream
- **WHEN** two panes are attached to the same stream and one closes
- **THEN** that stream stays attached and its content stays out of the transcript

#### Scenario: Detach during streaming
- **WHEN** a stream detaches while the model is still streaming
- **THEN** the following thinking or tool content appears in the transcript instead of being dropped

### Requirement: Unrecognised transcript layout fails open

If the transcript cannot be projected because pi's rendered layout differs from the expected one, the extension SHALL render the transcript unchanged and report one warning for the session. It SHALL NOT render a partial or incorrect transcript.

#### Scenario: Layout mismatch
- **WHEN** a stream is attached and pi's transcript layout does not match what the projection expects
- **THEN** the transcript renders exactly as it would without a stream attached, one warning is shown, and further attaches do not repeat the warning
