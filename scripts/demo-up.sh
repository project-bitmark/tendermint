#!/bin/bash
# Launch the full Bitmark-EVM demo stack: chain node, peg-in + peg-out watchers,
# and the bridge UI. Logs go to /tmp/bitmark-demo/; PIDs are tracked in
# .demo-pids so demo-down.sh can stop everything.
#
# Override deployed addresses / ports via env if your deployment differs:
#   WBTMK, MARKING, RESERVE_ADDR, MIN_CONF, UI_PORT, DEPOSITOR_PK
set -e
export PATH="$HOME/.local/bin:$HOME/.foundry/bin:$PATH"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOMEDIR="$HOME/.tmp-evmosd"
LOGDIR="/tmp/bitmark-demo"; mkdir -p "$LOGDIR"
PIDS="$REPO/.demo-pids"; : > "$PIDS"

launch() { # launch <name> <cmd...>
  local name="$1"; shift
  nohup "$@" > "$LOGDIR/$name.log" 2>&1 &
  echo "$! $name" >> "$PIDS"
  echo "  started $name (pid $!)  -> $LOGDIR/$name.log"
}

# 1. chain (only if not already producing blocks)
if curl -s localhost:26657/status >/dev/null 2>&1; then
  echo "chain already running"
else
  launch chain "$REPO/scripts/start-node.sh"
  printf "  waiting for chain"; until curl -s localhost:26657/status >/dev/null 2>&1; do printf "."; sleep 1; done; echo " up"
fi

cd "$REPO/evm"
[ -d node_modules ] || npm install
export RESERVE_ADDR="${RESERVE_ADDR:-bV7H8TVVfvcstcoftiZ9cJuDYkaG9FSVwG}"
export WBTMK="${WBTMK:-0x816644F8bc4633D268842628EB10ffC0AdcB6099}"
export MARKING="${MARKING:-0x0F5575BC344f6F0b595A7B3a0bDEdE9a90859c6f}"
export MIN_CONF="${MIN_CONF:-0}"
# demo depositor for the UI "Deposit to me" button (a funded Bitmark L1 key)
if [ -z "$DEPOSITOR_PK" ]; then
  DEPOSITOR_PK="0x$(evmosd keys unsafe-export-eth-key dev0 --keyring-backend test --home "$HOMEDIR" 2>/dev/null)"
fi
export DEPOSITOR_PK

launch peg-watcher    node peg-watcher.js
launch redeem-watcher node redeem-watcher.js
launch ui             node server.js

echo
echo "demo up. UI -> http://localhost:${UI_PORT:-8080}"
echo "logs   -> $LOGDIR/   ·   stop -> $REPO/scripts/demo-down.sh"
