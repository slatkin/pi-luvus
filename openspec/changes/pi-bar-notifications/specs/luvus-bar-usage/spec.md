# Spec Delta

## Purpose

Shows totals for all live pi panes in one Luvus Bar widget, so you can see pi cost and context use without focusing each pane.

## ADDED Requirements

### Requirement: Module declares the pi usage widget
The packaged Luvus module SHALL declare one Luvus Bar widget with the id `pi-usage` and the title `pi usage`. The module id SHALL be `pi-luvus.pane-titles`.

#### Scenario: Module is linked
- **WHEN** you link `luvus-module/` and run `luvus bar list`
- **THEN** the list contains the widget `pi-luvus.pane-titles:pi-usage`

### Requirement: Widget shows totals for live pi panes
The widget SHALL show three values for the live pi panes: the pane count, the sum of session costs, and the largest context token count. A pane's session cost is the sum of `usage.cost.total` over its assistant messages. A pane's context token count is `usage.totalTokens` of its last assistant message.

#### Scenario: Two live pi panes
- **WHEN** two pi panes are live, one with session cost 0.40 and last `totalTokens` 31385, the other with session cost 0.85 and last `totalTokens` 142000
- **THEN** the widget content is `π 2 · $1.25 · ctx 142k`
- **AND** the compact content is `π2 $1.25`

#### Scenario: Session with no assistant message
- **WHEN** a live pi pane has no assistant message yet
- **THEN** that pane counts in the pane total and adds 0 to cost and context

#### Scenario: Session file is missing or unreadable
- **WHEN** the session file of a live pi pane cannot be found or read
- **THEN** that pane counts in the pane total, adds nothing else, and the other panes still show

### Requirement: Value formats
Cost SHALL show as `$` and two decimals. A token count below 1000 SHALL show as the number. A count from 1000 to below 1,000,000 SHALL show as thousands rounded to a whole number with `k`. A count of 1,000,000 or more SHALL show as millions with one decimal and `M`.

#### Scenario: Token formats
- **WHEN** the largest context token counts are 950, 31385, and 1250000
- **THEN** they show as `950`, `31k`, and `1.3M`

#### Scenario: Small cost
- **WHEN** the total cost is 0.004
- **THEN** it shows as `$0.00`

### Requirement: Widget clears when no pi pane is live
When no live pi pane exists, the module SHALL clear the widget content.

#### Scenario: Last pi pane closes
- **WHEN** the last live pi pane closes
- **THEN** the widget has no live content in `luvus bar list`

### Requirement: Widget refreshes on module triggers
The module SHALL refresh the widget when Luvus runs its startup hook, when an agent status changes, and when a pane closes. A refresh SHALL read only session files whose modification time or size changed since the last refresh.

#### Scenario: Turn ends in a pi pane
- **WHEN** a pi turn ends and the pane status changes to `idle`
- **THEN** the widget shows the cost and context of that turn

#### Scenario: Unchanged session file
- **WHEN** a refresh runs and a session file has the same modification time and size as at the last refresh
- **THEN** the module uses the cached values for that file and does not read it

### Requirement: Widget failures do not affect titles
A failure to compute or publish the widget SHALL NOT stop the module from publishing AGENTS titles, and a title failure SHALL NOT stop the widget.

#### Scenario: Bar push fails
- **WHEN** `luvus bar push` fails
- **THEN** the module logs the error and the title push still runs
