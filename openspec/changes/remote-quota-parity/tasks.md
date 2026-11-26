## 1. Reproduce and evidence

- [ ] 1.1 Reproduce the gap on the Mac canary twice: in a Linux space the bar shows Claude `—`, no Copilot and no Antigravity. Record the date and the exact bar and details text. Verify: two dated captures with the same text, and the host records read on the same day.
- [ ] 1.2 Run the installed helper read for `claude` over the existing exec path and record its safe status and whether it returns windows. Verify: the status is recorded and no credential, raw output or path is in the capture.
- [ ] 1.3 Freeze sanitized fixtures from the four Omarchy records (`claude`, `copilot`, `agy`, `codex`), including the stale `agy` record and the `limitsStale` Codex record, plus malformed, symlink, oversize, unknown-schema and email-in-label variants. Verify: a scan of the fixtures finds no email, account id, token or home path.
- [ ] 1.4 Record how the Mac's native `usage-limits` labels and icons Copilot and Antigravity locally, as the parity target. Verify: the notes list icon, window labels and tooltip text for each, with the date.

## 2. Helper

- [ ] 2.1 Implement the host-native adapter in `scripts/quota` with fixture tests for a fresh record, symlink, oversize, unknown schema, out-of-range percent, `accounts[]` records and an email in a label. Verify: the new tests fail before the adapter and pass after, and no test touches the real `~/.local/state`.
- [ ] 2.2 Allow `claude`, `copilot` and `agy` in `main.mjs` and `state.mjs` and add per-provider source selection (host-native, then CLI, then unavailable). Verify: tests cover Claude CLI with no windows plus a fresh record, no record plus a usable CLI, and neither source usable; no mixed-source reading exists.
- [ ] 2.3 Implement the freshness rules: `limitsFetchedAt` as observation time, `limitsStale` and past-reset handling, future-time rejection. Verify: fixtures for the 15-day-old `agy` record and the stale Codex record show dated history and never a current 0%.
- [ ] 2.4 Implement targeted refresh for host-native sources as decided for D5. Do not start until the user chooses. Verify: refresh honors the per-provider lock, cooldown and backoff, and reports "no newer reading" when `limitsFetchedAt` does not advance.
- [ ] 2.5 Bump the protocol version and add the viewer mismatch behavior. Verify: a test shows an old viewer and a new helper, and the reverse, both yield quota unavailable with no coordinator write.

## 3. Viewer and bar

- [ ] 3.1 Add Copilot and Antigravity icons and labels for remote machines, matching the 1.4 parity notes. Verify: a fixture render of a remote space shows the same icons and labels as This Computer.
- [ ] 3.2 Show the source ("Omarchy collector" or "CLI") and observation age in details for every remote reading. Verify: a fixture test checks both strings and an age computed from `limitsFetchedAt`.
- [ ] 3.3 Remove the policy gates from `fleet-provider-visibility` 5.3 and the section 7 follow-up for Claude, Copilot and Antigravity only, keeping every unqualified provider unavailable. Verify: a test shows a host with no qualified source still renders unavailable, and Codex behavior is unchanged.
- [ ] 3.4 Show the Fable optional window on remote Claude only when the record reports it. Verify: with and without a Fable window, the optional-window setting offers it only in the first case.

## 4. Host changes (explicit user approval required)

- [ ] 4.1 Add `agy` to `herdr-fleet-quota-refresh` through the installer in the `herdr-fleet-quota` repo. Verify: after the next timer runs, the `agy` record's `limitsFetchedAt` advances; if the sign-in is expired, record that and stop.
- [ ] 4.2 Upgrade the Linux helper with the enrollment digest unchanged, after saving a rollback copy of the installed helper. Verify: the digest before and after is identical and the old copy still runs a Codex read.

## 5. Canary verification

- [ ] 5.1 Run the candidate in a disposable app home with fixtures. Verify: Follow Space in a fixture Linux space shows each provider's expected windows and the fixture's stale `agy` as dated history.
- [ ] 5.2 Update the Mac canary with a backup. Verify: in a Linux space Follow Space shows Claude 5h and weekly (and Fable when reported), Copilot monthly, `agy` session and weekly, and Codex, matching the Linux host's records within the same minute.
- [ ] 5.3 Demonstrate rollback. Verify: restoring the saved canary and helper returns the previous display, the enrollment digest is unchanged, and the Local bar is unaffected.

## 6. Finish

- [ ] 6.1 Run `npm test` and `npm run check`. Verify: both pass with the output recorded.
- [ ] 6.2 Simplify the diff. Verify: tests still pass after the pass.
- [ ] 6.3 Verify in a fresh subagent that did not write the code, given only this spec and the branch. Verify: each requirement and scenario is checked with a pass or a named gap.
- [ ] 6.4 Archive `fleet-provider-visibility` before this change so the deltas apply to its spec. Verify: `fleet-provider-quotas` exists in the main specs before this change is archived.

## 7. Follow-ups

- **Portable adapters:** Copilot and Antigravity readings for hosts without Omarchy.
- **Claude `get_usage` root cause:** why the CLI control request returns no windows on Linux.
- **Upstream #164 comparison:** compare its remote runner with the token-history path; it is not a quota source.
