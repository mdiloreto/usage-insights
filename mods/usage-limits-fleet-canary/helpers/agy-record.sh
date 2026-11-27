#!/bin/sh
# Prints Omarchy's saved Antigravity record. Exit 127 tells the mod there is none to show.
record=${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/agents/usage/agy.json
[ -f "$record" ] && [ ! -L "$record" ] || exit 127
exec head -c 65536 "$record"
