# Bitmark-EVM PoC — Tendermint (CometBFT) + EVM sidechain

A proof-of-concept showing that a **Tendermint/EVM sidechain can give Bitmark
fast deterministic finality and EVM smart contracts**, with a stubbed `wBTMK`
peg — driven entirely from JS/Solidity tooling.

This is the under-explored cell: Tendermint+Bitcoin exists (Nomic, Babylon) and
EVM+Bitcoin exists (Rootstock, Botanix), but **Tendermint + EVM + a Bitcoin-family
peg** together has never shipped as a flagship. Bitmark is a good host because the
usual blockers don't apply: it's not Bitcoin (no tribal politics) and we control
the chain.

## What's here

| Layer | Tech | Notes |
|---|---|---|
| Consensus | CometBFT (Tendermint) | ~3s blocks, **instant finality**, single validator (PoC) |
| Chain + EVM | evmos `evmosd` v20 (Go binary) | run as a black-box; chainId **9000** |
| Contracts | Solidity `wBTMK.sol` | minimal ERC-20, owner-mint = **peg stub** |
| Tooling | Foundry (`forge`) + ethers.js v6 | all JS/Solidity, no Go written |

The node binary is the only Go in the stack and we never touch it — everything
we build is JS and Solidity.

## Run it

```bash
# 1. Start the single-validator Tendermint/EVM chain (background it yourself):
./../scripts/start-chain.sh        # wraps evmos local_node.sh, JSON-RPC on :8545

# 2. Build + deploy the peg token:
cd evm
forge build
forge create src/wBTMK.sol:wBTMK \
  --rpc-url http://localhost:8545 \
  --private-key 0xE9B1D63E8ACD7FE676ACB43AFB390D4B0202DAB61ABEC9CF2A561E4BECB147DE \
  --broadcast

# 3. Run the demo (peg-in / transfer / peg-out, with finality timing):
npm install
WBTMK=<deployed-address> npm run demo

# stop:
./../scripts/stop-chain.sh
```

The deployer key above is the well-known evmos **local test** key (`mykey`).
Test-only — never use on a real network.

## Real peg-in from Bitmark L1 (working)

`peg-watcher.js` turns the stub into a real (single-operator) peg-in against the
**live Bitmark network**, via the public ElectrumX server `electrum.bitmark.rocks:50002`:

- `electrum.js` — tiny TLS ElectrumX client + address→scripthash (Bitmark = standard
  base58check P2PKH, version byte `0x55`).
- `btmk.js` — Bitmark address helpers (hash160, base58check, P2PKH).
- `peg-watcher.js` — watches a reserve address; on each new deposit it converts
  sats→wBTMK (8dp→18dp, ×10¹⁰) and calls `pegMint(recipient, amount, btmkTxid)`,
  committing the real L1 txid on-chain. Idempotent via `peg-state.json`.

The reserve address is derived from the agent's **public** key (so the same
`did:nostr` agent controls it):

```bash
RESERVE_ADDR=bV7H8TVVfvcstcoftiZ9cJuDYkaG9FSVwG \
USER_ADDR=0xC6Fe5D33615a1C52c08018c47E8Bc53646A0E101 \
WBTMK=<wBTMK address> MIN_CONF=0 npm run watch
```

Proven live: a real **0.8 BTMK** deposit (`7613b651…54268e12`) was detected
0-conf and minted **0.8 wBTMK** to the recipient, final in one ~3s block, with the
L1 txid recorded in the `PegMint` event. `MIN_CONF=0` mints on first-seen (snappy
demo); raise it for real value.

Still TODO for a full loop: peg-out watcher (burn → release BTMK from the reserve)
and per-deposit recipient mapping (e.g. `OP_RETURN`-encoded EVM address).

## Bridge UI (no build)

`npm run ui` starts a zero-dependency Node server (`server.js`) that serves the
static `../ui/` dashboard and a live **`/bridge-state.jsonld`** endpoint
aggregating the sidechain, the Bitmark L1 reserve (via ElectrumX), and the DID
document. Open http://localhost:8080.

The client is browser-native ESM with **no build step**: semantic HTML with
`data-bind` islands hydrated by one small module (`ui/app.js`) that polls the
JSON-LD every 4s. Same-origin, so no CORS. Shows the reserve + locked balance,
wBTMK supply/balances, the attested did:nostr validator identity, and a live feed
of peg-in deposits (each linking its Bitmark L1 txid).

## The peg is a STUB

`wBTMK.pegMint` is gated by a single `owner` (the "peg operator"). In production
that owner is replaced by the **validator-set threshold signer / a peg module**
that mints only against BTMK genuinely locked on Bitmark L1. The security ceiling
of any such sidechain is the **peg custody + validator set**, not Bitmark's MPoW6
hashpower — same as every L2. Covenants (CTV/APO) are what would make the peg
trust-minimised; that's out of scope here.

## Validator ↔ did:nostr binding (done)

`../agent.did.json` (`did:nostr:309b30c6…`) is wired to the validator using
**public keys only** — the private key (nsec) is never needed, and nsec/npub
(bech32 display forms) are avoided in favour of raw hex:

- `#cometbft-consensus` verificationMethod — the validator's Ed25519 consensus
  key, multicodec-wrapped (`f` base16 + `ed01` ed25519-pub + 32-byte key).
- a `TendermintValidator` service entry — chainId, consensus pubkey/address (hex),
  and RPC endpoints.

Verify the binding against the running node:

```bash
LIVE=$(curl -s localhost:26657/validators | jq -r '.result.validators[0].pub_key.value' \
  | node -e 'process.stdin.on("data",d=>console.log(Buffer.from(d.toString().trim(),"base64").toString("hex")))')
jq -r '.service[0].serviceEndpoint.consensusPubkeyHex' ../agent.did.json
echo "$LIVE"   # same 9d25bf97…860f267f
```

Wiring a key to a DID is a **public-key assertion** (the DID controller lists the
validator's public key in the DID doc), not a key substitution.

### Signed attestation (hardened)

The assertion is hardened by a one-time **Nostr-signed attestation**: the DID's
own key (`309b30c6…`, from `git config nostr.privkey`) produced a BIP340 schnorr
signature over a statement committing to the validator's Ed25519 consensus key
(`evm/validator-attestation.json`, a kind-30100 Nostr event). This makes the
DID→validator direction *provable* — a third party can check that the DID key
itself signed off on this exact consensus key, not merely that someone wrote it
into a file. It is referenced from the DID doc's validator service
(`serviceEndpoint.attestation`).

Verify the whole binding (both directions + the signature) from public data:

```bash
./scripts/verify-binding.sh
```

The binding is **bidirectional** — the validator also points back at the DID
on-chain. Its staking `description.details` (and `security_contact`) were set to
the DID with a normal `edit-validator` tx on the live chain (no re-genesis, no
state loss):

```bash
evmosd tx staking edit-validator \
  --details "did:nostr:309b30c6…" --security-contact "did:nostr:309b30c6…" \
  --from mykey --keyring-backend test --home "$HOME/.tmp-evmosd" \
  --chain-id evmos_9000-1 --gas 400000 --gas-prices 1000000000aevmos --yes
# verify:
evmosd q staking validators --home "$HOME/.tmp-evmosd" -o json | jq '.validators[0].description.details'
```

## Next steps (not done)

- Replace the trusted `owner` with a real (or simulated) Bitmark lock watcher.
- Periodically checkpoint the sidechain head into Bitmark L1 (Babylon-style)
  for long-range / equivocation defence.
- Grow the validator set 1 → 4 (BFT needs n ≥ 3f+1) when decentralisation matters.
