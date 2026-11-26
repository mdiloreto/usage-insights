## Context

This change builds on `fleet-provider-visibility` (not archived yet). It closes the gap the Mac canary showed in a Linux space: `mateod-arch | Claude — | Codex wk 100%`, with no Copilot and no Antigravity, while a local space showed Claude, Codex and OpenCode from the Mac's native `usage-limits`. The rest of this section is observed fact from the Linux host on 2026-11-26.

| Evidence | What it establishes |
| --- | --- |
| `/usr/bin/omarchy-agent-usage-{claude,copilot,agy,codex}` write `~/.local/state/omarchy/agents/usage/<id>.json` | Omarchy's collectors already hold a quota record per provider on the host. `schemaVersion` is 1. The fields this change uses are `id`, `ready`, `tierLabel`, `limits[]` (`label`, `title`, `percent`, `resetsAt`), `limitsFetchedAt` (epoch ms), `limitsStale` (bool), `updatedAt` and `balance`. `percent` is a 0–1 fraction; the Codex record value 1.0 is what the Mac canary shows as `wk 100%`. |
| Collector sources, using the host's own existing sign-in | Claude reads `api.anthropic.com/api/oauth/usage`; Copilot reads `api.github.com/copilot_internal/user`; Antigravity (`agy`) reads `daily-cloudcode-pa.googleapis.com`. These are host-local calls made by Omarchy, not by this repo. |
| Readings on 2026-11-26 | Claude Max 5x: Session (5-hour) 0.04, Weekly (7-day) 0.08, Fable Weekly 0.0, fresh. Copilot Enterprise: Monthly allowance 1.0, fresh. `agy` Pro: Session and Weekly 0.0 with `limitsFetchedAt` 2026-11-11 and resets in the past, so stale for 15 days. Codex Pro 100: Weekly 1.0, `limitsStale` true at that moment. |
| `herdr-fleet-quota-refresh.timer` (separate `herdr-fleet-quota` repo) | Runs every minute as `herdr-fleet-quota-refresh claude copilot codex`. `agy` is not in the list, which is why its record never refreshes. |
| Installed helper `herdr-quota-v1` (`scripts/quota/`) | `main.mjs` (line 6) and `state.mjs` (line 169) allow only `codex` and `claude`. Claude is probed with the CLI `get_usage` control request, which has never returned usable windows on Linux (`fleet-provider-visibility` design: Claude quota and monetary evidence, Runtime qualification and Live Mac canary sections). |
| Older host script in `mods/insights/core/quota.mjs` (`QUOTA_SCRIPT`, on the `fleet-provider-quota` worktree branch, not in this branch's tree) | An earlier Omarchy-record fallback already projects these records with a `jq` sanitizer: id charset `^[a-z0-9][a-z0-9_-]{0,63}$`, labels dropped when they contain `@`, control characters replaced, 80-character labels, bounded record, window and byte counts, regular-file-only reads that refuse symlinks, and `accounts[]` multi-account records handled separately from single records. This change reuses those rules inside the Node helper. |
| Upstream [GaganSD/coding-agent-toolkit PR #164](https://github.com/GaganSD/coding-agent-toolkit/pull/164) (open) | Adds a remote runner for token usage (installs a worker bundle through Herdr, TZ-keyed snapshots). Reference only for the usage side; it is not a quota source. |

The old `QUOTA_SCRIPT` path and the installed trial are not the baseline. This change adds a source inside the existing v1 helper instead.

## Goals / Non-Goals

**Goals:** Show Claude 5h, weekly and Fable, Copilot monthly allowance, Antigravity session and weekly, and Codex in a remote space with the same icons and labels as This Computer; keep every number attributable to one machine and provider; keep stale readings dated; keep the helper read-only toward Omarchy's files and free of credentials.

**Non-goals:** Cross-host sums or maxima; new credentials, sign-in flows or account switching; any new network call from the helper or the viewer; calling provider endpoints from the Mac; Console API credits; same-account comparison of plan and Frontier; Windows; portable Copilot or Antigravity adapters for hosts without Omarchy (follow-up); changes to the normal layout or the upstream GaganSD work.

## Decisions

### D1. A host-native adapter inside `scripts/quota`, file-only

Add one adapter next to the CLI probes in `scripts/quota/providers.mjs`. It reads only `~/.local/state/omarchy/agents/usage/<id>.json` for an allowlisted `<id>`, never lists the directory, and makes no network call. It opens a regular file, refuses symlinks, enforces a byte bound before parsing, and parses with a strict schema. The helper's existing fixed argv, binding check, per-provider lock and private state stay as they are. The provider allowlist in `main.mjs` and `state.mjs` becomes `codex`, `claude`, `copilot`, `agy`.

### D2. Source selection order

Per provider and host: a fresh host-native record, else the existing CLI probe (Codex, Claude `get_usage`), else unavailable with a safe reason. Copilot and `agy` have no CLI probe, so they are host-native only. One source per reading; windows are never merged across sources, because their observation times and account binding differ. The reading carries `source` ("Omarchy collector" or "CLI") and its observation time so the details can show both.

### D3. Scale conversion and sanitization

`percent` in the record is a fraction in 0–1. The adapter multiplies it by 100 without rounding, so the exact value survives to the formatter and a window with capacity left never reads as fully used, and it rejects non-finite values, values outside 0–1, and records that mix scales. A true 1.0 becomes 100 and stays numeric; 0.0 becomes a genuine 0 only when the record is fresh. Sanitization reuses the `quota.mjs` rules: id charset, labels containing `@` dropped, control characters replaced, labels cut to 80 characters, bounded counts of windows, accounts and bytes, ISO-like `resetsAt` validated, `balance` kept only as an observed amount with a three-letter currency. Window names map to the projection's existing ids (`Session` to 5h, `Weekly` to weekly, `Fable Weekly` to the Fable window, `Monthly allowance` to the Copilot monthly plan window); an unmapped label is dropped, not displayed raw. `tierLabel` maps to the projection's plan list; an unknown plan becomes no plan. Records with `accounts[]` (multi-account) are unavailable in this change rather than guessed.

### D4. Freshness rules

The observation time is `limitsFetchedAt` converted to seconds; `updatedAt`, file mtime and read time never count. A record with `limitsStale` true, a `limitsFetchedAt` older than the helper's stale bound, a missing `limitsFetchedAt`, or `ready` false is not a current reading: it can appear only as dated history within the helper's history bound. A window past `resetsAt` with no newer fetch is expired or waiting, never 0%. A future `limitsFetchedAt` is rejected. These are intended to match the helper's existing `evidence()` rules in `state.mjs`, so the host-native source should reuse that path rather than add a second one; task 2.3 confirms this against the full `state.mjs`. Because a record has no verified account, the stored reading carries no account digest, and the comparison gate from `fleet-provider-visibility` keeps plan against Frontier withheld.

### D5. Targeted refresh for host-native sources (recommended, needs a user decision)

The named detail refresh (`Refresh Linux · Claude`) cannot make the helper call a provider, because the helper makes no network call. Recommended: for a host-native source, refresh runs the host's existing bounded refresh for that one provider (`herdr-fleet-quota-refresh <provider>`) under the helper's per-provider lock, deadline, cooldown and backoff, then rereads the record and reports whether `limitsFetchedAt` advanced. If the command is absent or the fetch time did not advance, refresh reports "no newer reading" with retry timing, never a cached read as new. The alternative is a refresh that only rereads the file. It is simpler and adds no execution, but it cannot bring a stale `agy` record forward. This changes what the helper executes on the host, so it is not implemented until the user decides.

### D6. Protocol version bump

The reading gains a `source` value and a record without an account digest. The wire version bumps from 1 to 2 for the new allowlist and shape. The viewer accepts only the version it knows and shows quota unavailable for a mismatch, without writing coordinator state. An old viewer against the new helper, and the reverse, fail closed.

### D7. Add `agy` to the host refresh unit

In the `herdr-fleet-quota` repo, change the refresh service's provider list to include `agy` through its installer, not by editing the installed unit by hand. This is a host change and needs explicit approval. Until then, `agy` shows dated history for as long as its record is stale.

## Alternatives

- **Call provider endpoints from the Mac:** rejected. It would move the host's sign-in across the auth boundary the helper exists to keep.
- **Port Omarchy's HTTP calls into the helper:** deferred. It would duplicate Omarchy, require credential reads in the helper, and add network calls this change avoids. A portable adapter for non-Omarchy hosts is a follow-up.
- **Keep the helper CLI-only:** rejected. Claude `get_usage` has produced no windows on Linux and Copilot and Antigravity have no CLI probe, so the remote space would keep the gap.
- **Reuse the old `QUOTA_SCRIPT` shell path:** rejected. It is a second, shell-based projection with its own wire shape; the helper already owns locking, state and the binding check.

## Risks / Trade-offs

- **Omarchy private format drift:** the record format is not a public contract. Mitigation: pin `schemaVersion` 1, strict field validation, fail closed with "unsupported source version", and fixtures from real records.
- **Omarchy absent on other hosts:** the host-native source does not exist there, so those hosts keep the CLI path and show Claude, Copilot and Antigravity as unavailable until a portable adapter exists.
- **Refresh timer dependency:** fresh readings depend on `herdr-fleet-quota-refresh.timer` running. If it stops, records age into dated history and the bar says so; the helper never presents them as current.
- **Agy sign-in expiry:** even with `agy` in the timer, expired Antigravity sign-in leaves the record stale. The reading stays dated history, and the helper does not trigger sign-in.
- **No account binding:** a host-native reading cannot prove which account it belongs to. It is attributed to machine and provider only, and no cross-reading comparison is allowed.
- **Scale mistakes:** a 0–1 fraction read as 0–100 would show 1% for a full quota. Mitigation: explicit conversion with fixtures for 0.0, 0.04, 1.0 and out-of-range values.

## Migration Plan

1. Implement and test the adapter, allowlist, source selection and freshness against sanitized fixtures only.
2. Keep a copy of the installed Linux helper (the `~/.local/bin/herdr-quota-v1` entrypoint and the files it loads) before the upgrade, with its enrollment digest recorded.
3. After explicit approval, upgrade the Linux helper in place with the same entrypoint and binding, then add `agy` to the refresh unit through the `herdr-fleet-quota` installer.
4. Update only the isolated Mac canary, with a backup as in `fleet-provider-visibility` section 6, and verify in a Linux space.
5. Roll back by restoring the saved helper copy and the saved canary mods. The enrollment and the Linux grant stay unchanged. The old helper still serves Codex and Claude through the CLI.

## Open Questions

- The request said "AGI". This design assumes it means Antigravity (`agy` CLI, Omarchy id `agy`). Confirm before implementation.
- D5: should named refresh run the host's refresh command for that provider, or only reread the record?
- Do hosts without Omarchy need portable Copilot and Antigravity adapters now, or can they stay unavailable?
- Archive order: `fleet-provider-visibility` must be archived first so these deltas apply to its spec. Is that change ready to archive, given its open tasks 1.3, 2.2, 4.5 and 5.2?
- Should the helper ever accept an `accounts[]` multi-account record, and if so, how is the account shown without an identifier?
