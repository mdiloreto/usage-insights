// Fleet reads: ask every other machine Herdr knows for the presentation cache
// Insights already writes next to its store. A machine name only ever travels
// as `exec`'s `on` option, so it never reaches a shell. Every failure becomes a
// fixed reason: stderr can carry paths and credentials, so it is never echoed.
//
// The aggregation of those rows lives in ./fleet-view.mjs, which runs in the Node
// helper: this module only fetches, so it stays free of analytics and safe to
// load in the presentation runtime.

// Keep in sync with CACHE_VERSION in ./cache.mjs. A different version is not an
// Insights cache for this reader.
const CACHE_VERSION = 2;
export const MAX_CACHE_BYTES = 8 * 1024 * 1024;

// The script exits 0 only when it printed a cache, so a distinct non-zero code
// separates "nothing to read" from "the machine could not be reached".
export const NO_CACHE_EXIT_CODE = 3;
export const UNREADABLE_EXIT_CODE = 4;

// Fixed reasons, exactly as the dashboard reports them.
const REASON_NO_CACHE = "no cache on that machine";
const REASON_UNREADABLE = "cache unreadable";
const REASON_INVALID_JSON = "cache is not valid JSON";
export const REASON_NOT_INSIGHTS = "cache is not an insights cache";
export const REASON_UNREACHABLE = "could not reach that machine";

// Only the three internal constants below are interpolated. No caller input is
// ever placed in this string; all paths come from the target machine's env.
export const CACHE_SCRIPT = `
app_home_cache="\${HERDR_APP_HOME:+$HERDR_APP_HOME/data/insights/insights.json.cache.json}"
config_home_cache="\${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app/data/insights/insights.json.cache.json"
home_cache="$HOME/.config/herdr-app/data/insights/insights.json.cache.json"
cache=""
for candidate in "$app_home_cache" "$config_home_cache" "$home_cache"; do
  [ -n "$candidate" ] || continue
  if [ -e "$candidate" ] || [ -L "$candidate" ]; then
    cache=$candidate
    break
  fi
done
[ -n "$cache" ] || exit ${NO_CACHE_EXIT_CODE}
if [ -L "$cache" ] || [ ! -f "$cache" ]; then exit ${UNREADABLE_EXIT_CODE}; fi
raw=$(wc -c < "$cache" 2>/dev/null) || exit ${UNREADABLE_EXIT_CODE}
bytes=$(printf '%s' "$raw" | tr -d '[:space:]')
case "$bytes" in ''|*[!0-9]*) exit ${UNREADABLE_EXIT_CODE} ;; esac
[ "$bytes" -gt 0 ] || exit ${UNREADABLE_EXIT_CODE}
[ "$bytes" -le ${MAX_CACHE_BYTES} ] || exit ${UNREADABLE_EXIT_CODE}
cat < "$cache" 2>/dev/null || exit ${UNREADABLE_EXIT_CODE}
`;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function machineLabel(machine, name) {
  return typeof machine?.label === "string" && machine.label.length > 0
    ? machine.label
    : name ?? "This computer";
}

/**
 * Normalize `machines()` into `{ name, label }`: this computer first, then the
 * rest in a stable case-insensitive order. The layout state is read by
 * readFleetMachine's caller; a machine that is still loading is listed too.
 */
export function fleetMachines(machines) {
  const local = [];
  const remote = [];
  for (const machine of Array.isArray(machines) ? machines : []) {
    const raw = machine?.name;
    const name = typeof raw === "string" && raw.length > 0 ? raw : null;
    const entry = { name, label: machineLabel(machine, name) };
    (name === null ? local : remote).push(entry);
  }
  remote.sort((left, right) => {
    const a = left.name.toLowerCase();
    const b = right.name.toLowerCase();
    if (a !== b) return a < b ? -1 : 1;
    // Equal ignoring case: the exact name keeps the order stable.
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  return [...local, ...remote];
}

function parseCache(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { reason: REASON_INVALID_JSON };
  }
  if (
    !isPlainObject(payload)
    || payload.version !== CACHE_VERSION
    || !Array.isArray(payload.rows)
  ) {
    return { reason: REASON_NOT_INSIGHTS };
  }
  return { payload };
}

function successful(machine, payload) {
  return {
    name: machine?.name ?? null,
    label: machineLabel(machine, machine?.name ?? null),
    ok: true,
    rows: payload.rows,
    scan: payload.scan ?? null,
    savedAt: payload.savedAt ?? null,
    lastScanAt: payload.lastScanAt ?? null,
    config: payload.config ?? null,
    reason: null,
  };
}

function failed(machine, reason) {
  return {
    name: machine?.name ?? null,
    label: machineLabel(machine, machine?.name ?? null),
    ok: false,
    rows: [],
    scan: null,
    savedAt: null,
    lastScanAt: null,
    config: null,
    reason,
  };
}

/**
 * Read one machine's cache through Herdr's `exec`. Never throws: the result
 * always carries `ok` and, when false, one of the fixed reasons above.
 * A non-zero exit whose stdout is a valid cache is still honoured, because a
 * partial scan may report one; the bundled script itself only exits non-zero
 * when it printed nothing.
 */
export async function readFleetMachine(machine, { exec, timeout } = {}) {
  const name = machine?.name ?? null;
  let result;
  try {
    result = await exec("sh", ["-c", CACHE_SCRIPT], { on: name, timeout });
  } catch {
    return failed(machine, REASON_UNREACHABLE);
  }

  const stdout = typeof result?.stdout === "string"
    ? result.stdout
    : result?.stdout === undefined || result?.stdout === null
      ? ""
      : String(result.stdout);
  const code = Number(result?.code);

  if (stdout.length > 0) {
    const parsed = parseCache(stdout);
    if (parsed.payload) return successful(machine, parsed.payload);
    // A successful exit with unexpected bytes is reported as what they are.
    if (code === 0) return failed(machine, parsed.reason);
  }

  if (code === NO_CACHE_EXIT_CODE) return failed(machine, REASON_NO_CACHE);
  if (code === UNREADABLE_EXIT_CODE) return failed(machine, REASON_UNREADABLE);
  return failed(machine, REASON_UNREACHABLE);
}
