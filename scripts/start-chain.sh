#!/bin/bash
# Bitmark-EVM PoC — single-validator evmos (CometBFT + EVM) local devnet.
# Wraps evmos' official local_node.sh, using the prebuilt evmosd in ~/.local/bin.
# Chain kept as default evmos_9000-1 for reliability; rebrand later.
export PATH="$HOME/.local/bin:$PATH"
exec bash "$(dirname "$0")/local_node.sh" --no-install -y "$@"
