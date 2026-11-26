# Insights

A native [Herdr](https://herdr.dev) dashboard for coding-agent token usage.
See which models you use, how usage changes over time, and your daily activity.
Reads local sessions from **Pi, Codex, Claude Code, OpenCode, and Antigravity**.

<img width="1204" height="538" alt="Tokens history" src="preview-history.png" />

![Insights](preview.png)

## Install

Ask your agent:
```
Read https://github.com/harshcurious/usage-insights/blob/main/INSTALL.md and install Insights following it.
```

Or install from a checkout:

```sh
git clone https://github.com/harshcurious/usage-insights.git
cd usage-insights
npm run install:local
```

With Herdr running, the installer checks the `insights` mod and adds an
**Insights** button beside the native tabs; clicking it reuses the current
space's dashboard tab, opening one only when absent. It installs `mods/insights/`
and records ownership in `data/insights/`. Shipped files, tabs, keys, terminals,
and usage data are unchanged. See [INSTALL.md](INSTALL.md) for the layout and
click-state rules. Set `HERDR_APP_HOME` to use a different app home.

## Use

- Compare models and providers with period filters and up/down trends.
- Explore a stacked usage chart, daily heatmap, lifetime totals, and streaks.
- Open **Settings** to choose sources, edit paths, toggle cached tokens, or
  change the palette and refresh interval.

## Fleet

The dashboard also shows what the **other machines** connected to Herdr used. A
**Fleet usage** card sits above the local sections: one row per machine with
the tokens it used in the selected period, the fleet total, and how fresh that
machine's data is.

```
Fleet usage        All time · 1.56B tokens across 1 machine
192.168.88.251     1m old                              1.56B
```

The numbers obey the same period, the same facets and the same
"include cached tokens" rule as this computer's, because they come out of the
same analytics.

### How a machine is measured

The collector runs **on the machine that owns the sessions**: it reads local
session files, so it has to be local. Each measured host therefore runs the
collector itself, and the viewer only reads what that host collected.

- A machine that runs Herdr already has the collector: the mod installs it and
  keeps it fresh.
- A measured host **without** Herdr (an Omarchy box, a server) installs the
  collector and a timer:

  ```sh
  git clone https://github.com/mdiloreto/usage-insights.git
  cd usage-insights
  bash scripts/install-headless.sh --install --enable
  ```

  It installs the collector under `~/.local/share/herdr-insights`, writes a
  user timer that collects every five minutes, and stores the result in
  `<app home>/data/insights/insights.json`. `--check` reports what it would do
  and changes nothing.

The viewer reads the **presentation cache** beside the store (a small file, a
few tens of kilobytes) over the same `exec` the mod already uses. The machine
name only ever travels as Herdr's `on` option, so it never reaches a shell.
Nothing is written to another machine, no code is pushed onto it, and no
filesystem is shared.

### When a machine cannot be read

A machine that cannot be reached keeps its own reason — *could not reach that
machine*, *no cache on that machine*, *cache unreadable*, *cache is not valid
JSON*, *cache is not an insights cache* — and is **never** counted as a
machine that used nothing. It is listed with the reason and left out of the
fleet total. A machine whose data is older than its own refresh interval is
marked stale.

## Privacy

Usage statistics need no request to any provider, and nothing is uploaded. The
mod runs a local Node helper, reads session files and OpenCode/Antigravity SQLite
databases, and writes usage metadata to
`~/.config/herdr-app/data/insights/insights.json`. It does not store prompt or
response text or modify source transcripts.

Reading another machine's usage cache is a local file read over Herdr's own
connection: nothing leaves the fleet, and the helper still never uploads
anything.

### Quotas

Quota readings are different: they come from the providers, asked with the
sign-in already on the machine being read.

- **This computer:** the bar in `mods/usage-limits-fleet-canary`, which
  `npm run install:local` does not install, asks Claude (`claude -p`,
  `get_usage`) and Codex (`codex app-server`) when it loads and every five
  minutes (hourly while a CLI is not installed). A manual refresh waits at least
  30 seconds. The dashboard only shows what a bar has read.
- **Another machine:** its providers are not asked until you install the quota
  helper there (Linux: `sh scripts/install-quota.sh`, then the same with
  `enroll`) and add that grant on the viewer. While the bar or the dashboard is
  loaded, the viewer then asks the helper only about the providers in the grant:
  - Codex through `codex app-server`.
  - Claude through `claude -p` `get_usage`, or `/usage` in a hidden terminal
    session if you set that up. It skips both while that machine's Omarchy
    collector record is current.
  - Copilot and Antigravity only from the Omarchy collector's record.
  - A manual refresh may also run `~/.local/bin/herdr-fleet-quota-refresh` on
    that machine, if present. That program is not part of this repository and may
    contact the provider.

  For each provider, the helper's own CLI quota requests are at least five
  minutes apart, or 30 seconds on a manual refresh, and further apart after
  repeated failures. In between, it may ask the CLI which account is signed in.

The helper returns only quota data, over Herdr's connection: percentages used,
window names and lengths, reset times, plan, Claude's credit amounts,
timestamps, a status and hashed identifiers. It returns no tokens, e-mail
addresses, prompts or responses, and this project uploads nothing anywhere else.

To turn quotas off on this computer, clear a provider in both the **Bar** and
**Panel** columns of the bar's settings, or remove the bar from your layout. For
another machine, run `sh scripts/install-quota.sh revoke` there: the helper then
refuses before asking anyone. A usage collector that machine runs on its own
schedule is separate and keeps running.

## Development

One native mod, `mods/insights`, provides both views. A pane whose content is
`{mod: "insights", props: {mode: "toolbar"}}` renders only the button; any other
pane shows the dashboard. Toolbar mode starts no Node helper, scans, tasks,
timers, or editors. No layouts or key bindings ship; the button lives in a
personal layout clone composed by the installer, which wraps the native tabs
without modifying them (see [INSTALL.md](INSTALL.md)).

[RECIPE.md](RECIPE.md) is the self-contained rebuild brief required by Herdr.

Tests and package checks run from the repository root (no dependencies):

```sh
npm test        # node --test tests/*.test.mjs
npm run check   # validates mods/insights and the installer
```

## About this fork

Usage Insights is a fork of **Insights** (`herdr-insights`) by
[Gagan Devagiri](https://github.com/GaganSD), from
[GaganSD/coding-agent-toolkit](https://github.com/GaganSD/coding-agent-toolkit/tree/main/herdr-insights),
MIT licensed (see [LICENSE](LICENSE)). It is imported at upstream `522dce2` and
flattened into its own repository. The mod ID stays `insights` and the install
ownership name stays `herdr-insights`, so an existing install upgrades in place.

Changes from upstream:

- The dashboard reads the usage cache of every other machine connected to Herdr
  and shows a **Fleet usage** card: each machine's tokens for the selected
  period, the fleet total, and how fresh that machine's data is. A machine that
  cannot be read keeps its own reason and is never counted as a machine that
  used nothing. `scripts/install-headless.sh` installs the collector and a
  timer on a measured host that has no Herdr app, so every machine collects its
  own sessions where they live.
- Toggling, re-rooting or remapping a source keeps collected history; only the
  files a change invalidates are dropped, and disabled sources are hidden.
- A corrupt store is replaced without losing settings; a store written by a
  newer version is left untouched instead of being reset.
- Locks and worker claims are recognised across hostname changes (macOS
  renames `.local` hosts) by machine ID, so a renamed Mac no longer stays locked.
- Refresh, prepare and save have explicit exec timeouts that cover their work.
- OpenCode reasoning tokens are counted as output (its `tokens.output`
  excludes them); OpenCode databases are read incrementally by `time_updated`,
  including the newer `session_message` schema.
- The selected day's detail follows the model/provider filters; the heatmap is
  scoped to the period and greys out days before it; leaderboard changes show
  one sign.
- Dashboard polling backs off while the background indexer runs.
- Leftover temp/lock files are swept; only three corrupt backups are kept.
- Settings sync can no longer stall; the selected day/year follow today across
  midnight and New Year; a prepare error shows once; unknown
  `insights.period.<x>` commands are ignored; a removed default source stays
  removed.
- Survives Node upgrades: the installer records a stable `node` path (such as
  Homebrew's `bin/node`) and the panel falls back to `node` on PATH when the
  recorded binary is gone.
