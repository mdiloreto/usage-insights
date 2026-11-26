## Purpose

Keep the native Local quota experience while adding attributable opt-in remote plan, credit and spend readings in a compact bottom bar and click-through details.

## ADDED Requirements

### Requirement: Preserve the native Local quota experience

The `usage-limits` bottom bar SHALL keep the native Local provider icons, configured window meters (including 5h, weekly and provider-specific buckets), resets, pace, tooltips, filters, preferences, density, and refresh behavior. Pi/OpenCode spend or usage SHALL NOT be labeled subscription quota. Adding Remote SHALL NOT change which Local readings or focused-session counters are shown by existing preferences or rewrite the Local collectors in this increment.

#### Scenario: Compare the bar to the Mac baseline

- **WHEN** the same Local observations, focus and preferences are supplied with Remote disabled or enabled
- **THEN** Local shows the same provider windows, spent percentages, resets, pace and focused-session counters, and its settings and refresh controls still work

#### Scenario: Show non-quota providers

- **WHEN** Pi or OpenCode has spend or usage data with no subscription quota
- **THEN** the data is shown only as usage or spend under existing display rules, never converted to quota

### Requirement: Leave the Local-only bar unchanged

When there are no registered remotes, the bar and native tooltips SHALL remain exactly as in the native Local-only experience, with no new Local label, mode control, empty Remote group or detail control. Registered but unconfigured remotes MAY still be listed in details with a safe reason.

#### Scenario: Use the bar with no registered remotes

- **WHEN** Herdr has zero registered remotes
- **THEN** the original Local-only bar and native tooltips are unchanged, with neither a new Local label nor Remote controls

### Requirement: Offer Follow Space and Local + Remote modes

The compact bar SHALL offer two modes. **Follow Space** is the default and matches the canary: it shows only the current space's machine, local in a local space and that remote in a remote space. **Local + Remote** shows this computer plus one explicitly selected remote; if several are available and none is remembered it SHALL offer a chooser, and an unavailable or non-enrolled selection SHALL remain named and unavailable rather than being replaced.

#### Scenario: Default Follow Space in a remote space

- **WHEN** a remote space is active and the user has not changed the mode
- **THEN** the compact bar shows only that space's machine, not This Computer and not a second remote

#### Scenario: Choose among several remotes in Local + Remote

- **WHEN** the user selects Local + Remote, more than one remote is available, and no selection is remembered
- **THEN** the bar offers a chooser and does not pick a remote from quota readings

#### Scenario: Keep an unavailable selection

- **WHEN** the selected remote disconnects while another remote remains available
- **THEN** the bar keeps the selected machine named and unavailable and does not substitute another remote or local data

### Requirement: Keep the compact bar identifiable as it narrows

In Local + Remote, the bar SHALL keep both groups identifiable as it narrows. It SHALL remove meters while retaining labeled percentages first; if still too wide, show one labeled window per provider and machine (highest used; earliest reset breaks ties); at the physical minimum keep named controls for both machines. No percentage may appear without machine, provider and window labels. Follow Space uses the same order for its one group.

#### Scenario: Narrow or zoomed bar

- **WHEN** the bar lacks space for the native Local content and the selected remote's meters
- **THEN** both groups compact together, and the user can still identify the machine, provider and window for any number shown

#### Scenario: A visible provider has no current reading

- **WHEN** a provider in the combined bar has no current reading
- **THEN** the bar shows its icon and `—`, with the reason and any eligible dated history in details; a current true 100% remains numeric

### Requirement: Open full details for every connected machine on click

Activating the bar's detail control SHALL always open full details for every connected remote and this computer. Details SHALL list a selected unavailable or registered non-enrolled machine with its safe reason, use native provider icons and original meters and tooltips, offer Fable in the optional-window setting only when a verified Fable reading exists, and provide refresh controls named for the machine and provider.

#### Scenario: Show every connected machine

- **WHEN** two remotes and this computer are connected and the user activates details
- **THEN** all three are listed with their own provider, window, source, age and reset or pace when available

#### Scenario: Offer the Fable optional window

- **WHEN** Claude reports a Fable window and the optional-window setting is enabled
- **THEN** details offer and show the Fable window; if no verified Fable reading exists, no Fable value is shown

#### Scenario: Refresh one named target

- **WHEN** the user activates `Refresh Linux · Codex`
- **THEN** only the Linux Codex pair is requested and other machines and providers are unchanged

### Requirement: Keep quota observations separate and attributable

Quota displays SHALL distinguish hosts and provider identities, with no inferred equality, cross-host or cross-provider maximum or sum. Valid observations of 0% and 100% SHALL remain numeric. The details surface SHALL show all known remotes, including unavailable and non-enrolled machines with their reason, and identify machine, provider, supplied plan, source, age, window and reset when available.

#### Scenario: Show the same provider on this computer and Linux

- **WHEN** two hosts report Codex with the same displayed plan and one reports 0% while the other reports 100% for the same window
- **THEN** each value appears under its own machine and provider with source and window details, without combining the values or treating the accounts as equal

#### Scenario: Inspect a provider with multiple buckets

- **WHEN** a provider reports multiple quota buckets for one host
- **THEN** the full detail shows each valid bucket with its available window, reset and pace information instead of substituting the tightest bucket for all of them

### Requirement: Keep plan, credit and spend as distinct readings

A provider reading SHALL be typed as a plan entitlement window, a credit, or a spend record. Plan windows, Frontier credit and monthly usage credits SHALL NOT be summed, substituted, or presented as one quota. A current plan window SHALL require a verified provider reading; a credit or spend record SHALL NOT stand in for an unobserved plan window.

#### Scenario: Show plan windows and Frontier credit together

- **WHEN** Claude returns a usable plan window and a Frontier credit for one machine
- **THEN** both appear as distinct readings with separate labels, never a combined percentage or a substituted value

#### Scenario: Show a Frontier-only result

- **WHEN** the Frontier-only path returns Frontier credit and monthly spend but no plan windows
- **THEN** only those records appear; no 5h, weekly or Fable plan window is inferred

#### Scenario: Keep a monetary amount out of the quota percentage

- **WHEN** monthly usage credits show an amount, cap and reset
- **THEN** details show the observed amount, currency or unit and reset label, and no dollar amount becomes a quota percentage

### Requirement: Show Claude plan entitlement only when observed

Claude 5h, weekly and model-scoped windows, including Fable, SHALL appear only when the host's signed-in CLI returns a usable reading. A successful sign-in or an unavailable primary usage call SHALL NOT produce a plan window, a 0%, or a Fable entitlement. When the primary path yields no usable windows, plan entitlement SHALL be unavailable; any retained prior reading SHALL be dated history.

#### Scenario: The primary usage call returns no usable windows

- **WHEN** Claude's usage call succeeds but returns no usable window
- **THEN** plan windows show unavailable, with no 0% and no Fable entitlement

#### Scenario: Sign-in is verified without a quota reading

- **WHEN** CLI authentication is verified but no quota reading is obtained
- **THEN** no plan percentage or entitlement appears; sign-in status is not quota

#### Scenario: Fable is reported

- **WHEN** Claude reports a model-scoped Fable window
- **THEN** it appears as a plan window under its own label; otherwise Fable is absent

### Requirement: Show usage credits and monthly spend only as observed

Usage credits and monthly spend SHALL show only the amount, currency or unit, cap, percentage and reset information present in the verified provider reading. A missing or ambiguous amount, unit, percentage, cap or reset SHALL be unavailable, never estimated, defaulted to zero, or invented. A monetary reading SHALL NOT be converted to a quota percentage or plan entitlement, and no new source SHALL be added when the existing reading is absent.

#### Scenario: Display an observed monthly row

- **WHEN** the verified reading shows `$531.73 / $600.00 spent · Resets Dec 1`
- **THEN** details show that amount, unit and reset label with its observation age

#### Scenario: Reject an ambiguous monetary row

- **WHEN** the amount is absent, uncapped, noncanonical or the reset is ambiguous
- **THEN** the monetary reading is unavailable and no zero, unit or reset instant is manufactured

#### Scenario: Fail closed when no monetary source exists

- **WHEN** the qualified CLI exposes no monetary reading
- **THEN** the surface reports unavailable and does not fetch or estimate from another source

### Requirement: Require proven same-account binding for comparisons

Plan windows and Frontier credit MAY be presented as comparable only when both readings are bound to the same verified provider account generation. A successful sign-in alone SHALL NOT establish that binding. Otherwise each reading SHALL be shown separately as uncomparable or unavailable, and no difference, ratio, or combined total SHALL be inferred.

#### Scenario: Compare plan and Frontier for one verified account

- **WHEN** both plan and Frontier readings bind to the same verified account generation
- **THEN** they may appear side by side as distinct, comparable readings without a combined percentage

#### Scenario: Refuse comparison from sign-in alone

- **WHEN** only CLI sign-in is known and account binding is unproven
- **THEN** plan and Frontier remain separate or uncomparable and no arithmetic is shown

#### Scenario: Withhold a comparison after an account change

- **WHEN** the provider account changes or a late result cannot be bound
- **THEN** the old comparison is withheld or discarded and the new state is unavailable until verified

### Requirement: Keep focused-session counters on their owning host

Focused-session counters SHALL be separate from quota account observations. Local focus SHALL continue to use the native path and reject obsolete results after a focus change. This increment SHALL mark remote focused-session context unavailable; remote terminal IDs and PIDs SHALL NOT cross into local session lookup. Future support requires a proven owning-host binding.

#### Scenario: Move between Mac and Linux terminals

- **WHEN** focus leaves a Mac terminal for a Linux terminal, including one with a colliding PID, and later returns to the Mac
- **THEN** no local lookup is performed for the remote terminal, no old local session is shown as current, native local counters resume on return, and quota records are not relabeled by focus

### Requirement: Probe enrolled remote hosts only through the approved helper

The viewer SHALL invoke only a versioned, explicitly installed single-shot helper after operator enrollment, using the existing Herdr connection and the verified native target solely as `on`. The executable and argument shape SHALL be fixed. The feature SHALL NOT install on discovery or require a new daemon, port, transport, Omarchy or GUI. Check mode SHALL start no real quota probes or writes.

#### Scenario: A remote machine is discovered

- **WHEN** Herdr lists a remote without explicit telemetry enrollment
- **THEN** the machine can be listed as not enrolled, but the viewer does not install anything, launch the quota helper, or contact a provider on that host

#### Scenario: Validate the mod or use an unsafe label

- **WHEN** `herdr-app check` loads the mod, or an enrolled machine has a label containing shell syntax
- **THEN** check mode starts no real quota probes or writes, and in normal mode no label is interpolated into an executable command, argument list, or helper path

### Requirement: Verify the binding at the receiving helper

The viewer SHALL pass only allowlisted operation/provider IDs and one nonsecret binding digest of exactly 64 lowercase hex characters. Before returning cached evidence or probing a provider, the helper SHALL recompute and verify the digest using its own Core identity from a bounded metadata path and its current host opt-in marker. Neither the digest nor the route is an account selector or credential.

#### Scenario: A stale route reaches the wrong Core

- **WHEN** route reuse or an ID/name collision sends the request to a receiver with a different Core ID, even if it has a copy of the marker
- **THEN** the receiving helper's binding check rejects the request before returning cached evidence or contacting the provider, and no result is attributed to the enrolled host

### Requirement: Bind and revoke quota enrollment independently of Core registration

Each explicit quota grant SHALL have its own generation bound to the verified Core identity, exact registered route and host opt-in marker. Quota state SHALL NOT persist or log raw Core IDs or raw identity data. The viewer SHALL validate the returned binding against the still-current grant before publishing.

#### Scenario: Re-add the same Core out of band without an observable removal

- **WHEN** Core reports the same identity and route after an unobserved remove/re-add and the host marker is unchanged
- **THEN** the existing quota grant continues; the connection record neither revokes it nor creates a new grant

#### Scenario: Observe removal or a different binding

- **WHEN** the viewer observes that the enrolled registration was removed or verifies a different Core or route
- **THEN** it disables the old grant, withholds its quota, discards late results, and requires explicit re-enrollment rather than transferring the grant automatically

#### Scenario: Revoke or re-enroll while a read is in flight

- **WHEN** a managed revoke, new install, or new grant supersedes an enrollment while its response is pending
- **THEN** the old grant and projection are invalidated, the old response cannot update the projection, and a managed new install or grant rotates the host marker before a fresh grant can take effect

### Requirement: Use the owning host's CLI authentication for quota only

The helper SHALL use the paired remote user's host-local CLI and emit bounded, validated, sanitized results. It SHALL NOT move credentials, trigger sign-in, change accounts or start model turns. Only providers with verified fixtures and a signed-in canary SHALL be advertised for plan-window collection; an unqualified provider's plan windows SHALL remain unavailable, and an observed Frontier or spend record SHALL NOT qualify them.

#### Scenario: Run the enrolled Linux helper

- **WHEN** an opted-in Linux Core machine has a qualified provider CLI available in the paired user's noninteractive environment
- **THEN** the helper uses that host's existing sign-in for a bounded quota-only read, normalizes supported plan and credit shapes, and returns no credentials, raw output, transcript, or paths to the viewer

#### Scenario: Keep an unqualified provider unavailable

- **WHEN** Claude plan or GitHub Copilot lacks qualification
- **THEN** its plan windows are unavailable; any observed Frontier or monthly spend remains separate and does not imply plan support

### Requirement: Bound reads and target named refresh

Each `read` or `refresh` SHALL target one machine/provider pair. `read` SHALL return eligible cached evidence and attempt that provider only if enabled and due. The named detail refresh SHALL request fresh evidence for that pair and report its result, including retry timing when available. Attempts SHALL honor per-provider locks, deadlines, cooldown and backoff. A timeout or failure SHALL NOT block Local or unrelated pairs. Refresh SHALL NOT report a cached read as a new observation.

#### Scenario: Refresh one provider while another is failing

- **WHEN** the user refreshes Claude for Linux while another remote's Codex request hangs
- **THEN** the requested Linux Claude check runs or returns its own cooldown/in-flight result without probing other pairs, with its own result shown in details

#### Scenario: Repeated reads and refresh

- **WHEN** multiple reads or refreshes target the same pair while an attempt is in flight or in cooldown or backoff
- **THEN** they reuse the in-flight operation or show deferred status with retry timing when available, without starting duplicate provider calls

### Requirement: Keep quota helper state on the owning host

The helper SHALL keep cooldown, backoff and eligible last-good evidence across invocations in private, atomic host-owned state. Its per-provider lock and due check SHALL be authoritative across viewer processes, owner handoffs and restarts. The viewer SHALL NOT read or write that state file directly.

#### Scenario: Start a separate helper invocation during backoff

- **WHEN** a later invocation targets the same machine/provider while an earlier failure's backoff still applies
- **THEN** the helper honors the recorded backoff and returns eligible evidence and the outcome without requiring the viewer to access the state file

### Requirement: Preserve observation age and identity

Freshness SHALL use observation evidence, not file mtime, read or attempt time. Any last-good evidence SHALL retain its original age and be marked stale or expired as appropriate. It SHALL NOT become zero after expiry, persist across a machine/provider identity change, or appear under an unverified binding.

#### Scenario: Read a stale or expired window after a failed attempt

- **WHEN** a provider request fails or a known quota window reaches reset without a fresh observation
- **THEN** the current state shows failure or waiting for a new reading, shows matching last-good evidence only as dated history, and never synthesizes a new 0% reading

#### Scenario: Reject malformed or out-of-date identity evidence

- **WHEN** a payload is malformed, or a machine is replaced or its provider account changes while an older request is in flight
- **THEN** malformed data does not update last-good evidence, and data from the old or unverifiable identity is unavailable rather than attributed to the replacement

#### Scenario: Withhold an unproven reading

- **WHEN** a reading lacks a verified observation time, binding or provider identity
- **THEN** it is unavailable or shown only as dated history, never as a current measurement

### Requirement: Distinguish safe failure and source statuses

The projection SHALL distinguish paused, estimated, malformed, rate-limited, expired auth, unsupported/no subscription, missing CLI, verified missing helper, known offline, unknown transport, no usable plan windows, Frontier-only, and unavailable monetary readings. Transport status SHALL be independent of provider auth. Missing layout or ambiguous exec rejection SHALL NOT imply offline or missing helper. Raw stderr and rejection text SHALL NOT be exposed.

#### Scenario: Distinguish transport, installation and provider failures

- **WHEN** an opted-in host has no App layout, exec rejects without a trusted reason, or a constant trusted launcher verifies no helper
- **THEN** lack of layout is not reported as offline, an ambiguous rejection remains unknown transport, and only the verified last case reports helper missing

#### Scenario: Distinguish a fallback and provider auth

- **WHEN** Codex has only a dated snapshot or Claude reports expired authentication on a connected host
- **THEN** the snapshot retains its original age and source rather than being shown as fresh CLI data, and the Claude status is provider auth expired rather than transport offline

#### Scenario: Show a Frontier-only ceiling

- **WHEN** Claude's primary path has no usable windows and the Frontier-only path returns credit and spend
- **THEN** the projection shows plan unavailable, Frontier and monthly as separate observed records, and no fabricated plan window

### Requirement: Share one versioned quota projection

The bar and Insights SHALL consume one versioned projection with one active coordinator and keyed single-flight within a native App process/runtime. Only a compatible mounted consumer may hold the bounded owner lease. Consumers SHALL NOT poll independently, use commands or subprocesses to detect visibility, or import one another's installed files. With no compatible mounted consumer, no new quota work SHALL start.

#### Scenario: Open Insights without the bottom bar

- **WHEN** Insights is the only mounted quota surface on a healthy supported runtime, an enrolled helper is enabled, and a new observation becomes due and available
- **THEN** Insights receives the updated observation without mounting the bar or starting a second poller

#### Scenario: Show explicit unavailability on an unsupported lifecycle

- **WHEN** the viewer cannot establish an owner because its lifecycle support is broken or unsupported
- **THEN** Insights reports quota owner unavailable, marks any eligible older evidence stale, and does not start an independent poller

#### Scenario: Open a consumer with an incompatible protocol

- **WHEN** a mounted consumer cannot read the coordinator's protocol version
- **THEN** it leaves ownership and projection state unchanged, shows quota unavailable, and starts no quota work

#### Scenario: Hide a mounted owner

- **WHEN** the active quota owner is hidden but remains mounted with a valid lease
- **THEN** it can continue due reads for opted-in hosts, including when hidden standalone, and any shown consumers receive the shared updates without starting another poller

#### Scenario: Remove an owner or let its lease expire during a read

- **WHEN** a compatible successor is mounted and the active owner is removed or its lease expires while a read is in flight
- **THEN** ownership transfers with shared or explicit waiting, stale or unavailable status; a surviving operation remains fenced and late results from the old owner cannot update the current projection

#### Scenario: Restart with a persisted lease or surviving operation

- **WHEN** the App starts with ownership state from an older runtime
- **THEN** it establishes a fresh runtime incarnation, treats old ownership as non-live, and does not duplicate work still protected by the flight guard or the host lock
