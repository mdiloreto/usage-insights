## Purpose

Show measured token history and independently observed quota status for this computer and named remote machines without merging their identity or inventing coverage.

## ADDED Requirements

### Requirement: Provide All, This Computer and named machine scopes

Insights SHALL default to **All** and expose the English scopes **All**, **This Computer** and each named remote. The selected scope SHALL govern token history, totals, trends, drill-downs and quota sections. Existing filters, cache preferences, chart and heatmap SHALL remain available. A late result from a previous scope SHALL NOT appear under the new scope.

#### Scenario: Open Insights with local and remote data

- **WHEN** Insights opens with a readable local store and at least one named remote
- **THEN** it defaults to All and shows the English scope labels All, This Computer and each named remote

#### Scenario: Select Linux and change token filters

- **WHEN** the user switches from This Computer to a named Linux machine with a readable cache, then changes the period, provider/model facets or cached-token setting
- **THEN** the history, totals and supported detail are labeled for Linux and contain only its cache rows under the new selections

#### Scenario: Switch machine while refreshing

- **WHEN** Linux token history is being computed and the user selects another machine before it arrives
- **THEN** the previous scope's late detail is not shown under the new machine and unavailable detail has a scope-specific loading or error state

### Requirement: Show distinct per-machine history in All

In All, the existing chart SHALL visibly distinguish each contributing machine's measured tokens while retaining the aggregate history. Per-machine contributions SHALL NOT be available only as counters. The heatmap, filters, totals and drill-downs SHALL continue to work. Host session identities SHALL be namespaced so equal IDs cannot erase a machine's contribution.

#### Scenario: Compare the same model across machines

- **WHEN** the same model has measured usage on both this computer and Linux and Insights opens in All
- **THEN** the existing chart shows separate per-host contributions and the aggregate, without merging machine-local sessions

#### Scenario: Keep the existing views in All

- **WHEN** the user changes the period, facets or cached-token setting in All
- **THEN** the chart, heatmap, totals and drill-downs update under the existing filters while the per-host distinction remains visible

#### Scenario: Two hosts report the same session ID

- **WHEN** two machines report the same session identifier
- **THEN** both contributions remain visible and counted separately under their own machine

### Requirement: Use the existing local store and host-local cache

This Computer SHALL read the existing local Insights store; each remote scope SHALL read only that machine's existing host-local cache through the fleet path. The feature SHALL NOT add a Mac collector, publish or write to GitHub, copy raw transcripts, or combine host session identities. A host SHALL keep its own indexer, and derivation SHALL stay off the render path.

#### Scenario: Read This Computer locally

- **WHEN** the user selects This Computer
- **THEN** history comes only from the existing local store, with no remote fetch and no GitHub write

#### Scenario: Read a named Linux machine

- **WHEN** the user selects a named Linux machine with a readable cache
- **THEN** history comes only from that existing host-local cache, with no new collector or publication

#### Scenario: A machine cache is unreadable

- **WHEN** a selected machine's cache cannot be read
- **THEN** its data is unavailable rather than zero, and other machines are unaffected

### Requirement: Show quota status beside the selected machine's token history

Insights SHALL show existing-style quota meters from the shared projection. All SHALL stack sections by machine, local first; a single-machine scope SHALL show only that machine's quotas. Quota SHALL remain independent of token filters, refresh cadence and cache availability, and SHALL NOT be combined with tokens into a common total.

#### Scenario: Change period or cache inclusion

- **WHEN** the user changes the token period, facets or cached-token inclusion while viewing Linux
- **THEN** only token results are recomputed; the Linux quota status continues to show its independently observed windows and age without triggering a provider refresh

#### Scenario: One source fails

- **WHEN** Linux token cache access fails but its quota observation is available, or quota is unavailable while the token cache is readable
- **THEN** Insights shows the named failure only on the affected surface and continues to show valid data on the other

#### Scenario: Select a named remote

- **WHEN** the user selects a named remote scope
- **THEN** both token history and quota sections show only that machine, while All continues to stack each machine's quotas separately

### Requirement: Remove the routine coverage card

Insights SHALL NOT show a routine technical coverage card in normal operation. When a machine's cache is stale or unreadable, it SHALL show one compact inline notice naming that machine, its freshness and safe reason only when needed. Totals SHALL include readable measurements only and SHALL NOT treat a missing cache as zero or as an account ledger.

#### Scenario: All selected machines are readable

- **WHEN** all selected machines have readable caches
- **THEN** no coverage card or routine partial-coverage banner is shown

#### Scenario: One machine is stale and another unreadable

- **WHEN** one selected machine has a stale cache and another has no readable cache
- **THEN** each affected machine gets a compact inline notice with its name and freshness or reason, and totals count only readable measurements

#### Scenario: The selected machine is unavailable

- **WHEN** the selected machine's cache is unavailable
- **THEN** the scope shows an inline notice naming it instead of a coverage card or zero data

### Requirement: Make export scope explicit

Export SHALL remain local in v1. In All or a remote scope it SHALL be disabled with a reason and SHALL NOT export local data labeled combined or remote. This Computer SHALL preserve a clearly labeled local export.

#### Scenario: Try to export from a remote scope

- **WHEN** the user selects a remote in v1
- **THEN** remote export is unavailable with an explanation, and returning to This Computer preserves a clearly labeled local export
