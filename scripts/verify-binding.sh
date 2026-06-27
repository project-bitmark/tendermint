#!/bin/bash
# Verify the full did:nostr <-> validator binding from PUBLIC data only.
# 1. DID -> validator : DID doc asserts the consensus key
# 2. validator -> DID : on-chain staking description points back at the DID
# 3. signed attestation: the DID key (schnorr) signed off on this consensus key
set -e
export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOMEDIR="$HOME/.tmp-evmosd"
DID="$(jq -r '.id' "$REPO/agent.did.json")"
SUBJECT="${DID#did:nostr:}"

pass=1
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1"; echo "      a=$2"; echo "      b=$3"; pass=0; fi; }

echo "DID: $DID"
echo

LIVE="$(curl -s http://localhost:26657/validators | jq -r '.result.validators[0].pub_key.value' \
  | node -e 'process.stdin.on("data",d=>console.log(Buffer.from(d.toString().trim(),"base64").toString("hex")))')"

echo "[1] DID -> validator (DID doc asserts consensus key)"
chk "doc service key == live validator key" \
  "$(jq -r '.service[0].serviceEndpoint.consensusPubkeyHex' "$REPO/agent.did.json")" "$LIVE"

echo "[2] validator -> DID (on-chain description points back)"
chk "on-chain description.details == DID" \
  "$(evmosd q staking validators --home "$HOMEDIR" -o json 2>/dev/null | jq -r '.validators[0].description.details')" "$DID"

echo "[3] signed attestation (DID key signed this consensus key)"
ATT="$REPO/evm/validator-attestation.json"
if nak verify < "$ATT" 2>/dev/null; then echo "  ✓ schnorr signature valid"; else echo "  ✗ signature invalid"; pass=0; fi
chk "attestation signer == DID subject" "$(jq -r '.pubkey' "$ATT")" "$SUBJECT"
chk "attested key == live validator key" "$(jq -r '.content|fromjson|.consensus_pubkey_hex' "$ATT")" "$LIVE"

echo
[ "$pass" = 1 ] && echo "ALL CHECKS PASSED — binding is bidirectional and signed." || { echo "SOME CHECKS FAILED"; exit 1; }
