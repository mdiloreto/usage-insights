## ADDED Requirements

### Requirement: Read host-native provider records

For an allowlisted provider, the helper MAY read the owning host's Omarchy usage record (`~/.local/state/omarchy/agents/usage/<id>.json`) as a quota source. The read SHALL be read-only, open only a regular file that is not a symbolic link, enforce a size bound, and accept only `schemaVersion` 1. A record with any other or missing schema version SHALL yield unavailable with the reason "unsupported source version". The helper SHALL sanitize provider ids and window labels, strip labels that contain `@`, bound the number and size of windows, and convert the record's 0–1 `percent` fraction to the projection's integer 0–100 scale, rounding down below 100 so a window with capacity left never reads as 100%. No account id, email, path, token or raw record SHALL cross the helper boundary. Host-native records carry no verifiable account binding for this purpose, so their readings SHALL be attributed to the machine and provider only, and same-account comparisons (plan against Frontier) SHALL stay withheld.

#### Scenario: Read a fresh host-native record

- **WHEN** the host's `claude.json` record has `schemaVersion` 1, `ready` true, `limitsStale` false and a `limitsFetchedAt` within the freshness bound, with a Session window at 0.04 and a Weekly window at 0.08
- **THEN** the helper returns those windows as 4% and 8% with their reset times, source "Omarchy collector", and the record's fetch time as the observation time

#### Scenario: Refuse an unknown schema version

- **WHEN** a record reports `schemaVersion` 2 or has no `schemaVersion`
- **THEN** the provider is unavailable with the reason "unsupported source version", no window is returned, and the CLI fallback rules still apply

#### Scenario: Refuse a symlink or oversize record

- **WHEN** the record path is a symbolic link, is not a regular file, or exceeds the size bound
- **THEN** the helper does not follow or parse it and reports the provider's host-native source as unavailable with a safe reason

#### Scenario: Sanitize a label that contains an email

- **WHEN** a window label or title in the record contains an `@` or control characters
- **THEN** that label is dropped or replaced by the provider's standard window name, the email never reaches the projection, and the numeric window is kept only if its identity is otherwise valid

#### Scenario: Do not claim an account binding

- **WHEN** a Claude host-native record and a Frontier credit reading are both present for one machine
- **THEN** each is shown under that machine and provider without an account claim, and no comparison, difference, ratio or total is produced

### Requirement: Select one source per provider and host

For each provider and host, the helper SHALL select exactly one source for a reading. It SHALL use a fresh host-native record first, otherwise the existing CLI probe (Codex, and Claude `get_usage`), otherwise report unavailable with a safe reason. The details SHALL name the source ("Omarchy collector" or "CLI") and the observation age. Windows from two sources SHALL NOT be mixed into one reading.

#### Scenario: Claude CLI returns no windows but the record is fresh

- **WHEN** Claude's `get_usage` returns no usable window and the host's Claude record is fresh
- **THEN** the Omarchy windows are shown with source "Omarchy collector", and no window from the CLI attempt is merged into them

#### Scenario: No host-native record exists

- **WHEN** the host has no Omarchy record for Codex and the Codex CLI returns a usable reading
- **THEN** the CLI reading is shown with source "CLI"

#### Scenario: Neither source is usable

- **WHEN** the host-native record is stale or unreadable and the CLI probe is unsupported or fails
- **THEN** the provider is unavailable with a safe reason, and any eligible earlier reading appears only as dated history

### Requirement: Show remote Claude, Copilot and Antigravity like This Computer

In a remote space, Follow Space SHALL show the providers the host has qualified, with the same native icons and window labels as This Computer. Claude SHALL show its 5h and weekly windows, and a Fable window only when the record reports one. Copilot SHALL show its monthly allowance as a plan window and SHALL keep a true 100% numeric. Antigravity SHALL show its session and weekly windows. A provider the host has not qualified SHALL stay unavailable.

#### Scenario: Linux space shows Claude windows

- **WHEN** a Linux space is active and the host-native Claude record is fresh with Session, Weekly and Fable Weekly windows
- **THEN** the bar shows Claude 5h and weekly, details show the Fable window under the optional-window setting, and no Fable value appears when the record has none

#### Scenario: Copilot at 100% stays numeric

- **WHEN** the Copilot record reports a Monthly allowance of 1.0
- **THEN** the remote bar and details show the Copilot monthly window at 100%, not as unavailable or capped at a placeholder

#### Scenario: Show Antigravity session and weekly

- **WHEN** the Antigravity record is fresh with Session and Weekly windows
- **THEN** details show both under the Antigravity icon and label for that machine, and a refresh control named for the machine and provider

#### Scenario: Match the Linux host's own records

- **WHEN** the host's records are unchanged between two reads in the same minute
- **THEN** the remote bar and details show the same percentages the host's records contain

### Requirement: Collapse and expand each machine in the details

The expanded details SHALL group quotas under one header per machine (This Computer and each remote), in the same format as today's details. Each header SHALL toggle between expanded and collapsed. A collapsed header SHALL still show a one-line summary of each provider's tightest current window for that machine. Collapsed state SHALL persist per machine route, and all machines SHALL start expanded.

#### Scenario: Collapse the Linux machine

- **WHEN** the user clicks the Linux header in the details
- **THEN** its provider rows hide, the header keeps a one-line summary such as `Claude wk 8% · Codex wk 100% · Copilot mo 100%`, and This Computer stays expanded

#### Scenario: Reopen the details later

- **WHEN** the details are closed and opened again
- **THEN** each machine keeps the collapsed or expanded state it had

### Requirement: Date stale host-native readings

The observation time of a host-native reading SHALL be the record's `limitsFetchedAt`, not the record's file time, `updatedAt` or the read time. A record with `limitsStale` true SHALL be shown only as dated history. A window whose reset time has passed with no newer fetch SHALL show expired or waiting for a fresh window, never 0%.

#### Scenario: Show an old Antigravity record

- **WHEN** the Antigravity record has resets in the past and zeros for Session and Weekly, and a `limitsFetchedAt` within the shared 14-day history bound
- **THEN** the provider shows no current reading, details show the windows as expired dated history with their original age, and no current 0% is shown

#### Scenario: Drop a record past the history bound

- **WHEN** the Antigravity record's `limitsFetchedAt` is 14 days old or older (for example 2026-11-11 read on 2026-11-26)
- **THEN** the provider shows unavailable with no windows, no age and no 0%

#### Scenario: Show a record the collector marks stale

- **WHEN** the Codex record has `limitsStale` true
- **THEN** its windows appear only as dated history with the original observation time, and the CLI source is used instead if it returns a fresh reading

#### Scenario: Use the fetch time as the age

- **WHEN** a record's file was rewritten recently but its `limitsFetchedAt` is old
- **THEN** the reading's age is computed from `limitsFetchedAt`

## MODIFIED Requirements

### Requirement: Use the owning host's CLI authentication for quota only

The helper SHALL use the owning host's existing sign-in, through that host's own CLI or its own host-native collector, and emit bounded, validated, sanitized results. It SHALL NOT move credentials to the viewer, trigger sign-in, change accounts or start model turns. Only providers with verified fixtures and a qualified source on that host SHALL be advertised for plan-window collection; Codex, Claude, GitHub Copilot and Antigravity are each qualifiable per host. An unqualified provider's plan windows SHALL remain unavailable, and an observed Frontier or spend record SHALL NOT qualify them.

#### Scenario: Run the enrolled Linux helper

- **WHEN** an opted-in Linux Core machine has a qualified provider CLI or host-native record available in the paired user's noninteractive environment
- **THEN** the helper uses that host's existing sign-in for a bounded quota-only read, normalizes supported plan and credit shapes, and returns no credentials, raw output, transcript, or paths to the viewer

#### Scenario: Keep an unqualified provider unavailable

- **WHEN** a provider on a host has no qualified source, whether Claude plan, GitHub Copilot or Antigravity
- **THEN** its plan windows are unavailable; any observed Frontier or monthly spend remains separate and does not imply plan support

#### Scenario: Qualify a provider on one host only

- **WHEN** one host has a qualified Copilot source and another host has none
- **THEN** Copilot is shown for the first host and unavailable for the second, and neither host's state changes the other's
