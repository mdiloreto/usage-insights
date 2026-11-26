## Why

A Herdr session running on the Mac and attached to the Linux box over SSH shows This Computer's quotas for Claude, Codex, GitHub Copilot and Antigravity, but the Linux space shows only Codex. Remote Claude reads `— / Unavailable`, and Copilot and Antigravity are absent (`fleet-provider-visibility` design, canary verification). The Linux host already holds fresh readings for all of them: its Omarchy collectors write `~/.local/state/omarchy/agents/usage/{claude,copilot,agy,codex}.json`, and `herdr-fleet-quota-refresh.timer` refreshes Claude, Copilot and Codex every minute. On 2026-11-26 the Linux records held Claude 5h 4% / weekly 8% / Fable weekly 0% (Max 5x), Copilot monthly allowance 100% (Enterprise), and Antigravity session/weekly from 2026-11-11, which has been stale since then.

The gap has three causes:

1. The installed helper (`herdr-quota-v1`, `scripts/quota/`) allows only `codex` and `claude`, and probes Claude through the CLI `get_usage` control request, which has never returned usable windows on Linux. The Omarchy collector on the same host reads Claude's windows from Anthropic's OAuth usage endpoint with Claude Code's existing sign-in.
2. `fleet-provider-visibility` deliberately keeps Claude plan windows and GitHub Copilot unavailable until a qualified source exists (tasks 5.3 and §7). That source is the host's own Omarchy collector.
3. The host refresh unit omits `agy`, so the Antigravity record never refreshes.

## What Changes

- Give the remote helper a **host-native source**: on a host whose Omarchy agent collectors write usage records, the helper reads that provider's record read-only, bounded and sanitized, and returns the same typed projection the CLI probes return. No credential, account identifier, raw record or path crosses to the viewer.
- Extend the helper's provider allowlist to `claude`, `copilot` and `agy`, alongside `codex`. Each is advertised for a host only when that host's source for it is qualified.
- Choose the source for each provider and host: use a fresh host-native record when one exists, otherwise the existing CLI probe (Codex, Claude `get_usage`), otherwise unavailable with a reason. The details show the source.
- Qualify remote Claude plan windows (5h, weekly and Fable when reported), the Copilot monthly allowance and the Antigravity session and weekly windows from host-native records, which lifts the policy gates in `fleet-provider-visibility` 5.3 and §7 for these providers only.
- Keep freshness honest: observation time comes from the record's `limitsFetchedAt`, `limitsStale` makes a reading dated history, and a window past its reset with no newer fetch is expired, never a current 0%.
- Add `agy` to the host refresh unit through the herdr-fleet-quota installer, so Antigravity readings stay current. This is a host change and needs separate approval.
- Bar and details: native icons and labels for Copilot and Antigravity on remote machines, the Fable optional window on remote Claude, and named targeted refresh for every provider.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `fleet-provider-quotas` (introduced by `fleet-provider-visibility`, not archived yet): adds host-native sources, per-provider source selection, remote Claude, Copilot and Antigravity parity, and replaces the CLI-only authentication requirement. `fleet-provider-visibility` must be archived before this change so these deltas apply to its spec.

## Impact

- Code: `scripts/quota/` (new host-native adapter, provider allowlist, state, protocol version), the `usage-limits` bar companion and Insights quota sections (icons, labels, source and age), and the fixtures and tests for each.
- Host: the Linux helper upgrade (`herdr-quota-v1`) and the `agy` provider in `herdr-fleet-quota-refresh.service`. The Linux enrollment and binding stay unchanged.
- Mac: only the isolated canary, with a backup and rollback as before. The normal layout is not changed.
- Dependency: the host-native source relies on Omarchy's private record format (`schemaVersion: 1`). It is pinned, and an unknown version fails closed. Hosts without Omarchy keep the CLI path. Portable Copilot and Antigravity adapters are a follow-up.
- Out of scope: cross-host sums or maxima, new credentials or sign-in flows, Console API credits, Windows, changes to upstream GaganSD #164 (whose remote usage runner is a reference for the token-history side only).
