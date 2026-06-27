#!/bin/bash
# Start the already-initialised Bitmark-EVM devnet (see setup-nostr-validator.sh).
set -e
export PATH="$HOME/.local/bin:$PATH"
HOMEDIR="$HOME/.tmp-evmosd"
exec evmosd start \
  --metrics \
  --log_level info \
  --minimum-gas-prices=0.0001aevmos \
  --json-rpc.api eth,txpool,personal,net,debug,web3 \
  --home "$HOMEDIR" \
  --chain-id "${CHAIN_ID:-evmos_9000-1}"
