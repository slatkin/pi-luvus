# Spec Delta

## Purpose

Tells you when a parent pi session in a Luvus pane that you are not looking at ends a turn and waits for input.

## ADDED Requirements

### Requirement: Notify when a turn ends without focus
When a turn ends in a parent pi pane inside Luvus and that pane does not have focus, the extension SHALL push one Luvus notification with level `success` and the text `pi turn ended: <label>`. `<label>` is the session name when the session has one, else the basename of the session cwd.

#### Scenario: Turn ends in an unfocused pane
- **WHEN** a turn ends in an unnamed parent pi session in `/work/app` and its pane does not have focus
- **THEN** Luvus shows the notification `pi turn ended: app` with level `success`

#### Scenario: Turn ends in the focused pane
- **WHEN** a turn ends in a parent pi pane that has focus
- **THEN** the extension pushes no notification

#### Scenario: Named session
- **WHEN** a turn ends without focus in a session named `auth refactor`
- **THEN** the notification text is `pi turn ended: auth refactor`

### Requirement: Failed turns notify as errors
When the last assistant message of the ended turn stopped with an error, the notification SHALL have level `error` and the text `pi turn failed: <label>`. When the turn was aborted, the extension SHALL push no notification.

#### Scenario: Provider error
- **WHEN** a turn ends without focus and its last assistant message has stop reason `error`
- **THEN** Luvus shows `pi turn failed: <label>` with level `error`

#### Scenario: Aborted turn
- **WHEN** a turn ends because you aborted it
- **THEN** the extension pushes no notification

### Requirement: No notification from subagent children or outside Luvus
A subagent child (`PI_LUVUS_NAME` is set) SHALL push no turn notification. A pi process without `LUVUS_ENV`, `LUVUS_BIN_PATH`, or `LUVUS_PANE_ID` SHALL make no notification calls.

#### Scenario: Subagent child turn ends
- **WHEN** a turn ends in a subagent child pane without focus
- **THEN** the extension pushes no notification

#### Scenario: Outside Luvus
- **WHEN** pi runs without `LUVUS_PANE_ID`
- **THEN** the extension makes no Luvus call for notifications

### Requirement: Notification can be turned off
The extension SHALL read `notify.enabled` from its `config.json`. The default is `true`. When it is `false`, the extension SHALL push no turn notification. A value that is not a boolean SHALL be a config error, the same as other invalid keys.

#### Scenario: Disabled in config
- **WHEN** `config.json` has `"notify": { "enabled": false }` and a turn ends without focus
- **THEN** the extension pushes no notification

#### Scenario: Invalid value
- **WHEN** `config.json` has `"notify": { "enabled": "yes" }`
- **THEN** config loading reports `notify.enabled` as invalid

### Requirement: Notification does not block pi
The focus check and the notification push SHALL NOT block the pi event loop. A failed or slow focus check SHALL result in no notification, and SHALL NOT delay the next turn.

#### Scenario: Focus check fails
- **WHEN** the Luvus call that reads pane focus fails or times out
- **THEN** the extension pushes no notification and pi stays responsive
