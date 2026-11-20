# Handoff

Where this fork stands, what works, and what is left. Written for whoever picks
it up next.

## What this is

A fork of **Insights** (`herdr-insights` by Gagan Devagiri, MIT) that adds
**fleet-wide usage**: the dashboard reads the usage cache of every other
machine connected to Herdr and shows what each of them used, next to the local
dashboard.

Upstream is credited in the README and kept mergeable on purpose: the diff is
additive (`core/fleet.mjs`, `core/fleet-view.mjs`, one presenter command, the
fleet card in `main.js`, `scripts/install-headless.sh`).

## The shape of the design, and why

The collector reads **local session files**, so it has to run on the machine
that owns those sessions. That is the constraint the whole design follows:

- Every measured host runs the collector itself. A host with Herdr gets it from
  the mod; a host without (`scripts/install-headless.sh`) gets it plus a timer.
- The viewer only **reads** what those hosts collected. No writes to another
  machine, no code pushed onto it, no shared filesystem.

The transport is `exec("sh", ["-c", CACHE_SCRIPT], { on: machine })`, the same
call fleet-quota uses: the machine name only ever travels as Herdr's `on`
option, so it never reaches a shell. What is read is the **presentation cache**
beside the store (`<store>.cache.json`): a small file, roughly 36 KB on a busy
host, versus 1.6 MB for the store itself.

The aggregation stays in **Node**, like the rest of the analytics. The repo has
a contract test — "no derivation runs in a render frame" — and the fleet obeys
it: the UI fetches, `presenter.mjs fleet` computes with the same
`analytics.js` functions the local dashboard uses, and the UI renders the
compact result. That is also why the fleet numbers obey the same period, the
same facets and the same `includeCache` rule for free.

## What is verified

- The whole suite passes: `npm test` → 294 tests, 291 pass, 3 skipped (the ones
  that need a running Herdr), and `npm run check` is clean.
- End to end on real data: the headless collector on a Linux host collected 100
  rows of Codex sessions; the presenter aggregated them to **1,563,144,848**
  tokens, with the machine reported as fresh.
- The headless installer was exercised in a disposable `HOME`: it installs the
  collector and both units, verifies the units before copying anything, and
  writes a store whose `refreshSeconds` matches its timer, so a headless host is
  not permanently labelled stale.
- Live on a Mac: the dashboard shows a **Fleet usage** card with
  `192.168.88.251 · 1m old · 1.56B`.

## What is left

1. **A second measured host.** The fleet card has only ever had one remote.
   Two remotes would exercise the interesting case: one readable, one not.
2. **The machine dimension inside the charts.** Right now the fleet is its own
   card with per-machine totals. Putting a machine facet *inside* the heatmap
   and the model chart means adding a machine to the row key, the dedup keys and
   the analytics — invasive, and it will conflict with upstream merges. Decide
   whether it is worth it before starting.
3. **The `update` path.** The collector's own indexer keeps a host's data
   fresh; the fleet view shows age, but nothing yet says *why* a machine is
   behind.
4. **Windows.** The headless installer is POSIX `sh` and the fleet read uses
   `sh -c`, so the remote read assumes a POSIX host. Nothing has been tried on
   Windows.

## Things that will bite you

- **The collector's identity assumptions.** Locks, worker claims and `dev:ino`
  change detection all assume one host, and a foreign owner is never reclaimed.
  That is the reason the collector stays local instead of being driven remotely.
- **A stale remote must never look like an idle one.** A machine that cannot be
  read keeps its own reason and is left out of the fleet total. Keep it that way:
  it is the difference between "this box used nothing" and "we could not ask".
- **`refreshSeconds` has to match reality.** The fleet compares a cache's age
  against the interval the store itself reports. The headless installer writes
  it once, on a fresh store only, so a person's own configuration is never
  overwritten.
- **The aggregator moved.** `fleetTotals` and `fleetUsageSnapshot` used to live
  in `core/fleet.mjs` and are now in `core/fleet-view.mjs`, on the Node side,
  with the UI only fetching.

## Where it runs

- Linux host (measured): `~/.local/share/herdr-insights` (collector),
  `~/.config/systemd/user/herdr-insights-collect.{service,timer}`,
  `~/.config/herdr-app/data/insights/insights.json` (store + cache).
- Mac (viewer): `~/.config/herdr-app/mods/insights`, with the fleet card in
  the dashboard.

## Commands

```sh
npm test                      # 294 tests
npm run check                 # package checks
bash scripts/install-headless.sh --check    # what a measured host would get
bash scripts/install-headless.sh --install --enable
```

## Related

- `mdiloreto/herdr-fleet-quota` — the same problem for **quota** rather than
  usage: the percent of each provider's subscription that is used, across
  machines. MIT, published, and it is the one that shows a percentage in the
  status bar.
