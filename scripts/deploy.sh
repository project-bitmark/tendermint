#!/bin/bash
# Deploy wBTMK + Marking to the local sidechain and write evm/deployment.json,
# which the server, watchers, and demo-up.sh read (env > deployment.json > default).
# Re-run after a fresh chain (start-chain.sh). Idempotent-ish: each run redeploys.
set -e
export PATH="$HOME/.local/bin:$HOME/.foundry/bin:$PATH"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO/evm"

RPC="${RPC:-http://localhost:8545}"
# well-known evmos local-test deployer key (public, test-only)
PK="${DEPLOYER_PK:-0xE9B1D63E8ACD7FE676ACB43AFB390D4B0202DAB61ABEC9CF2A561E4BECB147DE}"
RESERVE="${RESERVE_ADDR:-bV7H8TVVfvcstcoftiZ9cJuDYkaG9FSVwG}"

[ -d node_modules ] || npm install
forge build >/dev/null

echo "deploying wBTMK…"
WBTMK=$(forge create src/wBTMK.sol:wBTMK --rpc-url "$RPC" --private-key "$PK" --broadcast --json | jq -r .deployedTo)
echo "  wBTMK   $WBTMK"
echo "deploying Marking…"
MARKING=$(forge create src/Marking.sol:Marking --rpc-url "$RPC" --private-key "$PK" --broadcast --json --constructor-args "$WBTMK" | jq -r .deployedTo)
echo "  Marking $MARKING"

CHAINID=$(cast chain-id --rpc-url "$RPC" 2>/dev/null || echo 9000)
jq -n --arg rpc "$RPC" --argjson cid "${CHAINID:-9000}" --arg w "$WBTMK" --arg m "$MARKING" --arg r "$RESERVE" \
  '{rpc:$rpc, chainId:$cid, wBTMK:$w, marking:$m, reserve:$r}' > deployment.json

echo "wrote evm/deployment.json:"; cat deployment.json
echo "now: ./scripts/demo-up.sh"
