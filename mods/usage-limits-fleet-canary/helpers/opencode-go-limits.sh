#!/bin/sh
NOT_INSTALLED=127
NO_READING=1
# One budget for both commands: longer than OpenCode's own 15 s, under Herdr's 30 s exec default.
DEADLINE_S=${HERDR_USAGE_OPENCODE_GO_DEADLINE_S:-25}
TERM_GRACE_ROUNDS=5

OC=$(command -v "${HERDR_USAGE_OPENCODE_BIN:-opencode}" 2>/dev/null) || exit "$NOT_INSTALLED"

dir=$(mktemp -d "${TMPDIR:-/tmp}/herdr-opencode-go.XXXXXX") || exit "$NO_READING"
trap 'rm -rf "$dir"' EXIT
end=$(($(date +%s) + DEADLINE_S))

term_then_kill_after_grace() {
  kill "$pid" 2>/dev/null
  i=0
  while [ "$i" -lt "$TERM_GRACE_ROUNDS" ] && kill -0 "$pid" 2>/dev/null; do
    sleep 0.2
    i=$((i + 1))
  done
  kill -9 "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
}

run_before_deadline() {
  "$OC" "$@" </dev/null >"$dir/out" 2>"$dir/err" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$end" ]; then
      term_then_kill_after_grace
      exit "$NO_READING"
    fi
    sleep 0.2
  done
  wait "$pid"
}

# Releases before 2 have no `service status`, so they can never give a reading.
give_up_without_status() {
  run_before_deadline --version
  case $(cat "$dir/out") in
    0.* | 1.*) exit "$NOT_INSTALLED" ;;
  esac
  exit "$NO_READING"
}

run_before_deadline service status || give_up_without_status

# `api` starts a server when none runs, and reading limits must never do that.
case $(sed '/^[[:space:]]*$/d' "$dir/out" | tail -n 1) in
  stopped)
    printf '{"herdr":"server-stopped"}\n'
    exit 0
    ;;
  http://* | https://*) ;;
  *) give_up_without_status ;;
esac

if run_before_deadline api GET /api/experimental/usage/limits; then
  cat "$dir/out"
  exit 0
fi
if grep -q '^HTTP 503' "$dir/err"; then
  printf '{"herdr":"limits-unavailable"}\n'
  exit 0
fi
# A missing experimental route reads as an absent provider, not a recurring error.
# The route itself answers 404 with LocationNotFoundError when the server's directory is gone.
grep -q '^HTTP 404' "$dir/err" && ! grep -q 'LocationNotFoundError' "$dir/out" && exit "$NOT_INSTALLED"
exit "$NO_READING"
