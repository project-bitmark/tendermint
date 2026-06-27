#!/bin/bash
# Stop the local Bitmark-EVM (evmos) devnet.
pkill -f "evmosd start" && echo "stopped evmosd" || echo "no evmosd running"
