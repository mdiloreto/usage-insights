#!/bin/sh
# Headless usage-insights collector installer for a measured Linux host.
#
# The default run (and --check) is a read-only report. --install copies the
# collector and its core modules under ~/.local/share/herdr-insights and writes
# two systemd user units. --enable additionally enables the timer.
# This installer never deletes anything and never touches the real Herdr app.
set -eu
umask 022

src=$(cd "$(dirname "$0")/.." && pwd)
mods=$src/mods/insights
collector=$mods/collector.mjs
# The collector hands a source too large for one pass (a multi-GB opencode.db)
# to indexer.mjs as a detached process; without it that source never finishes.
indexer=$mods/indexer.mjs
share=$HOME/.local/share/herdr-insights
unitdir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
apphome=${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app
store=$apphome/data/insights/insights.json
svc=herdr-insights-collect.service
tim=herdr-insights-collect.timer
timeout=300
REFRESH_MINUTES=5
REFRESH_SECONDS=$((REFRESH_MINUTES * 60))

usage='usage: install-headless.sh [--check | --install [--enable]]

  (no flags)  read-only report: what was found, what would be installed,
              and which prerequisites are missing; changes nothing
  --check     same as no flags
  --install   copy collector.mjs, indexer.mjs and core/*.mjs to $HOME/.local/share/herdr-insights
              and write the user units for $HOME
  --enable    with --install, run systemctl --user daemon-reload and then
              enable --now the timer
  -h, --help  show this help

The collector reads local coding-agent session files only. It never reads
credentials and never uploads anything.'

do_install=0
do_enable=0
do_check=0
while [ $# -gt 0 ]; do
  case "$1" in
    --install) do_install=1 ;;
    --enable) do_enable=1 ;;
    --check) do_check=1 ;;
    -h|--help) printf '%s\n' "$usage"; exit 0 ;;
    *) printf '%s\n' "$usage" >&2; exit 2 ;;
  esac
  shift
done
if [ "$do_check" -eq 1 ] && [ $((do_install + do_enable)) -gt 0 ]; then
  printf '%s\n' "--check cannot be combined with --install or --enable" >&2
  exit 2
fi
if [ "$do_enable" -eq 1 ] && [ "$do_install" -eq 0 ]; then
  printf '%s\n' "--enable requires --install" >&2
  exit 2
fi

for f in "$collector" "$indexer" "$mods"/core/*.mjs; do
  [ -f "$f" ] || { printf 'missing source: %s\n' "$f" >&2; exit 2; }
done

node_bin=$(command -v node 2>/dev/null || true)
if [ -n "$node_bin" ]; then
  node_note=$node_bin
  node_version=$("$node_bin" --version 2>/dev/null || true)
  [ -z "$node_version" ] || node_note="$node_bin ($node_version)"
else
  node_bin=node
  node_note="node (not found on PATH; the unit will use node from systemd's PATH)"
fi

tmp=$(mktemp -d) || exit 1
cleanup() { [ -z "${tmp:-}" ] || rm -rf "$tmp"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

cat > "$tmp/$svc" <<EOF
[Unit]
Description=herdr-insights headless collector

[Service]
Type=oneshot
# The detached indexer outlives the pass that started it; the default
# control-group mode would kill it when the collector exits.
KillMode=process
WorkingDirectory=%h
UMask=0077
TimeoutStartSec=$timeout
ExecStart=$node_bin @COLLECTOR@ snapshot --store $store --home $HOME
EOF

cat > "$tmp/$tim" <<EOF
[Unit]
Description=Collect herdr-insights usage every $REFRESH_MINUTES minutes

[Timer]
OnBootSec=2min
OnUnitInactiveSec=${REFRESH_MINUTES}min
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF

# The store's own refresh interval is what a fleet reader compares a cache's
# age against. A headless host collects every $REFRESH_MINUTES minutes, so the
# store must say the same, or every remote reads as stale. Written once, on a
# fresh store only: an existing store keeps the person's own configuration.
#
# oh-my-pi writes Pi-format sessions under its own root, which no default source
# covers, so a host that has it gets one more source read by the Pi adapter.
configure_store() {
  [ -e "$store" ] && return 0
  config="{\"refreshSeconds\":$REFRESH_SECONDS}"
  if [ -d "$HOME/.omp/agent/sessions" ]; then
    config=$("$node_bin" --input-type=module -e '
      const { pathToFileURL } = await import("node:url");
      const { DEFAULT_CONFIG } = await import(pathToFileURL(process.argv[1]).href);
      const sources = DEFAULT_CONFIG.sources.map((source) => ({ ...source, roots: [...source.roots] }));
      sources.push({ id: "omp", label: "oh-my-pi", adapter: "pi", enabled: true, roots: ["~/.omp/agent/sessions"] });
      process.stdout.write(JSON.stringify({ refreshSeconds: Number(process.argv[2]), sources }));
    ' "$share/core/config.mjs" "$REFRESH_SECONDS" 2>/dev/null) \
      || config="{\"refreshSeconds\":$REFRESH_SECONDS}"
  fi
  "$node_bin" "$share/collector.mjs" configure --store "$store" --home "$HOME" \
    --config "$config" >/dev/null 2>&1 \
    || printf 'note: the store could not be configured; set refreshSeconds to %s\n' "$REFRESH_SECONDS" >&2
}

mkdir -p "$tmp/units"
sed "s|@COLLECTOR@|$share/collector.mjs|" "$tmp/$svc" > "$tmp/units/$svc"
cp "$tmp/$tim" "$tmp/units/$tim"

refused=0
todo=0

check_managed_dir() {
  if [ -L "$1" ]; then
    printf 'refuse: %s is a symlink\n' "$1" >&2
    refused=$((refused + 1))
  elif [ -e "$1" ] && [ ! -d "$1" ]; then
    printf 'refuse: %s is not a directory\n' "$1" >&2
    refused=$((refused + 1))
  fi
}

preflight() {
  from=$1
  to=$2
  mode=$3
  if [ -L "$to" ]; then
    printf 'refuse: %s is a symlink\n' "$to" >&2
    refused=$((refused + 1))
  elif [ -e "$to" ]; then
    if [ ! -f "$to" ]; then
      printf 'refuse: %s is not a regular file\n' "$to" >&2
      refused=$((refused + 1))
    elif cmp -s "$from" "$to"; then
      printf 'ok (identical): %s\n' "$to"
    else
      printf 'refuse: %s exists and differs (upgrade manually)\n' "$to" >&2
      refused=$((refused + 1))
    fi
  else
    printf 'would install: %s (mode %s)\n' "$to" "$mode"
    todo=$((todo + 1))
  fi
}

install_one() {
  from=$1
  to=$2
  mode=$3
  if [ -L "$to" ]; then
    printf 'refuse: %s is a symlink\n' "$to" >&2
    exit 1
  fi
  if [ -e "$to" ]; then
    if cmp -s "$from" "$to"; then
      printf 'ok (identical): %s\n' "$to"
      return 0
    fi
    printf 'refuse: %s changed during installation\n' "$to" >&2
    exit 1
  fi
  install -m "$mode" "$from" "$to"
  printf 'installed: %s\n' "$to"
}

printf 'herdr-insights headless collector\n'
printf 'source: %s\n' "$mods"
printf 'install target: %s\n' "$share"
printf 'units: %s\n' "$unitdir"
printf 'node: %s\n' "$node_note"
if [ -e "$store" ]; then
  printf 'store: %s (exists)\n' "$store"
else
  printf 'store: %s (not created yet)\n' "$store"
fi
printf 'session roots found:'
found_any=0
for rel in \
  .claude/projects \
  .codex/sessions \
  .codex/archived_sessions \
  .local/share/opencode \
  .pi/agent/sessions \
  .omp/agent/sessions \
  .gemini/antigravity-cli
do
  if [ -d "$HOME/$rel" ]; then
    printf ' %s' "$rel"
    found_any=1
  fi
done
[ "$found_any" -eq 1 ] || printf ' none'
printf '\n'

check_managed_dir "$share"
check_managed_dir "$share/core"
check_managed_dir "$unitdir"

preflight "$collector" "$share/collector.mjs" 0755
preflight "$indexer" "$share/indexer.mjs" 0644
for f in "$mods"/core/*.mjs; do
  name=${f##*/}
  preflight "$f" "$share/core/$name" 0644
done
preflight "$tmp/units/$svc" "$unitdir/$svc" 0644
preflight "$tmp/units/$tim" "$unitdir/$tim" 0644

if [ "$refused" -ne 0 ]; then
  printf 'refusing to install; no target files were changed\n' >&2
  exit 1
fi

# Verify the generated units before any copy. ExecStart names the installed
# collector, which does not exist yet, so verify a copy that names the source
# collector instead.
if command -v systemd-analyze >/dev/null 2>&1; then
  mkdir -p "$tmp/verify"
  sed "s|@COLLECTOR@|$collector|" "$tmp/$svc" > "$tmp/verify/$svc"
  cp "$tmp/$tim" "$tmp/verify/$tim"
  if systemd-analyze --user verify "$tmp/verify/$svc" "$tmp/verify/$tim" >&2; then
    printf 'units verified (ExecStart uses the source collector)\n'
  else
    printf 'unit verification failed; nothing installed\n' >&2
    exit 1
  fi
else
  printf 'note: systemd-analyze not found; units were NOT verified\n' >&2
fi

if [ "$do_install" -eq 1 ]; then
  if [ "$todo" -eq 0 ]; then
    printf 'already installed; nothing to write\n'
  else
    mkdir -p "$share/core" "$unitdir"
    install_one "$collector" "$share/collector.mjs" 0755
    install_one "$indexer" "$share/indexer.mjs" 0644
    for f in "$mods"/core/*.mjs; do
      name=${f##*/}
      install_one "$f" "$share/core/$name" 0644
    done
    install_one "$tmp/units/$svc" "$unitdir/$svc" 0644
    install_one "$tmp/units/$tim" "$unitdir/$tim" 0644
    configure_store
  fi
  if [ "$do_enable" -eq 1 ]; then
    if ! command -v systemctl >/dev/null 2>&1; then
      printf 'refuse: systemctl not found; files are installed but the timer is not enabled\n' >&2
      exit 1
    fi
    systemctl --user daemon-reload
    systemctl --user enable --now "$tim"
    printf 'enabled: %s\n' "$tim"
  fi
else
  if [ "$todo" -eq 0 ]; then
    printf 'already installed; nothing to do\n'
  else
    printf 'dry run; pass --install to install\n'
  fi
fi

printf '\nto enable:\n'
printf '  systemctl --user daemon-reload\n'
printf '  systemctl --user enable --now %s\n' "$tim"
printf 'to uninstall:\n'
printf '  systemctl --user disable --now %s\n' "$tim"
printf '  rm -f %s %s\n' "$share/collector.mjs" "$share/indexer.mjs"
printf '  rm -f %s/core/*.mjs\n' "$share"
printf '  rm -f %s %s\n' "$unitdir/$svc" "$unitdir/$tim"
printf '  systemctl --user daemon-reload\n'
printf 'privacy: the collector reads local session files only; it never reads credentials and never uploads anything.\n'
