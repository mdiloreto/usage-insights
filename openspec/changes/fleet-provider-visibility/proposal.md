## Why

The original fleet trial reduced every machine and provider to one maximum percentage. The current canary follows one machine, but still needs a side-by-side mode, consistent quota details and distinguishable token history. Keep the native `usage-limits` experience without confusing measured tokens, plan entitlement, Frontier credit or spend.

## What Changes

- Add a native-style compact bottom bar with two modes: **Follow Space** (default, matching the canary; shows only the current space's machine) and **Local + Remote** (this computer plus one selected remote; choose when several, never substitute an unavailable selection). Preserve the original Local-only bar when there are no remotes. Do not add a separate badge or fleet maximum.
- Always open full details on click for every connected remote and this computer, with native provider icons, original meters and tooltips, the optional-window setting including Fable when observed, and refresh controls named for the machine and provider. Preserve local-only layout and native behavior.
- Read opt-in remote quotas through the existing explicitly installed, versioned single-shot helper over the Herdr connection. Keep the existing identity, binding, revocation, transport, sanitization and no-discovery-install constraints. Do not add credentials, prompts, raw provider output, or host installation on discovery.
- Show Anthropic-compatible readings only when observed: 5h/weekly and actual Fable entitlement as plan windows, Frontier credit as a distinct credit, and monthly usage credits/spend with observed amount, units and reset. Never estimate, manufacture zero, units or reset, or treat a sign-in as a quota. Unproven readings are unavailable or dated. Console API credits remain a separately scoped follow-up; monetary data fails closed when no source exists.
- Extend Insights with English **All**, **This Computer** and named remote scopes. **All** keeps the existing chart, heatmap and filters while adding a visible per-host breakdown alongside the aggregate. A selected host scopes history and quotas. Remove the routine technical coverage card; show a compact inline note naming the machine and freshness only when a machine is degraded. Keep export local-only.
- Use the Mac's existing local Insights store and visualize Linux through the existing host-local cache. No new collector, publisher, GitHub write, raw transcript transfer, or cross-host quota arithmetic.
- Implement and stage the prototype in the existing isolated Mac canary, with verification and rollback. Do not replace the normal layout or modify the Linux installation. GitHub Copilot, Console API credits, upstream GaganSD #130/#158 coordination and reusable chezmoi intent remain separate follow-ups.

## Capabilities

### New Capabilities

- `fleet-provider-quotas`: Native Local quotas plus separately identified, refreshable remote provider plan windows, credits and spend in the compact bar and click-through details, with one shared quota projection.
- `machine-usage-insights`: Per-machine token history, a visible All-host breakdown, independent quota status, inline degradation and local-only export.

### Modified Capabilities

None. There are no existing OpenSpec capability specs.

## Impact

- Future work affects the native `usage-limits` bar companion, the host-installed remote quota helper, and the Insights fleet read/presenter/dashboard. No new service, port, SSH connection, remote desktop, Omarchy dependency, new credential, GitHub write, or normal layout change is required.
- The first supported remote target is a Linux Herdr Core host with an already signed-in provider CLI. Codex has partial live plan-window evidence; Claude plan windows are not yet qualified. Claude Frontier credit and monthly spend may appear only as separately observed readings. Other hosts and providers require qualification.
- There is no account switching, remote focused-session collection, cross-machine quota arithmetic, estimate, or manufactured value. Reusable chezmoi layout/config intent requires separate approval.
