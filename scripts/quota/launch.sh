#!/bin/sh
# Fixed shell body for the viewer's enrolled-host launcher; only argv varies.
[ "$#" -eq 3 ] || exit 64
case "$1:$2" in
    read:codex|read:claude|read:copilot|read:agy|refresh:codex|refresh:claude|refresh:copilot|refresh:agy) ;;
    *) exit 64 ;;
esac
[ "${#3}" -eq 64 ] || exit 64
case "$3" in *[!0123456789abcdef]*) exit 64 ;; esac

case "$HOME" in /*) ;; *) exit 74 ;; esac
[ "$HOME" != / ] || exit 74
owner=$(/usr/bin/id -u 2>/dev/null) || exit 74
safe_owner_mode() {
    mode=$(/usr/bin/stat -c '%a' -- "$1" 2>/dev/null) || return 1
    case "$mode" in ''|*[!0-7]*) return 1 ;; esac
    [ "$(/usr/bin/stat -c '%u' -- "$1" 2>/dev/null)" = "$owner" ] &&
        [ "$((0$mode & 07022))" -eq 0 ]
}

[ -d "$HOME" ] && [ ! -L "$HOME" ] && [ -x "$HOME" ] && safe_owner_mode "$HOME" || exit 74
for dir in "$HOME/.local" "$HOME/.local/bin"; do
    [ ! -L "$dir" ] || exit 74
    [ -e "$dir" ] || exit 73
    [ -d "$dir" ] && [ -x "$dir" ] && safe_owner_mode "$dir" || exit 74
done

helper=$HOME/.local/bin/herdr-quota-v1
[ ! -L "$helper" ] || exit 74
[ -e "$helper" ] || exit 73
[ -f "$helper" ] && [ -x "$helper" ] && safe_owner_mode "$helper" || exit 74
"$helper" "$1" "$2" "$3" </dev/null 2>/dev/null &
child=$!
trap 'kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 75' HUP INT TERM
wait "$child"
result=$?
case "$result" in 126|127) exit 74 ;; *) exit "$result" ;; esac
