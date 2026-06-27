#!/bin/bash
# Stop everything started by demo-up.sh (chain, watchers, UI).
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PIDS="$REPO/.demo-pids"
[ -f "$PIDS" ] || { echo "nothing to stop (no .demo-pids)"; exit 0; }
while read -r pid name; do
  if kill "$pid" 2>/dev/null; then echo "stopped $name ($pid)"; else echo "$name ($pid) not running"; fi
done < "$PIDS"
rm -f "$PIDS"
echo "demo down."
