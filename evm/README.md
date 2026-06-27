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

**Per-deposit recipient (`OP_RETURN`).** A depositor can encode their EVM address
in an `OP_RETURN` output; the watcher reads it and mints to *that* address, so
anyone bridges to their own address rather than a fixed one. `deposit.js` builds
such a deposit: `SENDER_PK=<btmk-hex> node deposit.js <amount-BTMK> <0xEvm>`. The
watcher also skips the reserve's own peg-out change (not a real inbound deposit).

**Resilient watcher.** `peg-watcher.js` runs as a daemon: it polls on an interval
(keepalive + safety-net rescan) and auto-reconnects to ElectrumX on drop, keeping
the subscription for low latency. It no longer dies when the relay closes an idle
connection.

**Deposit flow in the UI.** The "Bridge in" island shows the reserve (with a QR)
and your connected EVM address as the `OP_RETURN` to include. For demos, a
**"Deposit to me"** button hits `POST /deposit`, which sends a *real* L1 deposit
from a configured `DEPOSITOR_PK` to the reserve with your address in `OP_RETURN` —
you then watch your wBTMK arrive. (Operator convenience; the real path is a user
sending the OP_RETURN deposit from their own Bitmark wallet.)

**Bridge out from the UI.** The "Bridge out" island redeems wBTMK → BTMK: enter an
amount + your Bitmark L1 address → the connected key signs `pegBurn` → the
redeem-watcher releases BTMK on L1, and the UI shows the release txid. The whole
round-trip (in → use/give → out) is now doable in the browser, no scripts.

## Peg-out: release BTMK back to L1 (working — full round-trip)

`redeem-watcher.js` closes the loop. It watches wBTMK `PegBurn` events and, for
each, builds + broadcasts a **real Bitmark transaction** from the reserve back to
the burner's L1 address:

- `btmk-tx.js` — legacy P2PKH tx builder/signer (pure JS, `@noble`): sighash,
  DER, low-S. Normalizes the signing key to **even-Y** because nostr/x-only
  (BIP340) addresses imply even-Y — the x-only-derived reserve is spent by `d` if
  its pubkey is even, else `n-d`.
- `redeem-watcher.js` — `PegBurn` → `listunspent` → build → `transaction.broadcast`.
  Idempotent via `redeem-state.json`.
- `burn.js` — initiate a peg-out: `BURNER_PK=0x.. node burn.js <amount> <btmk-addr>`.

Proven live, full round-trip: 0.8 BTMK in → 0.8 wBTMK → burn 0.5 →
**0.5 BTMK released** on L1 (`a4308960…d3145c`), 0.299 change back to the reserve.
The UI feed shows both directions, each linking its Bitmark L1 txid.

Still TODO: multi-burn UTXO chaining before the first release confirms.

## Identity resolution in Marks (read-only)

Marks tagged with a `did:nostr` identity are rendered with a deterministic avatar
(dicebear, seeded by the pubkey) and, where the pubkey has a published kind:0
profile, its **name + picture** — resolved client-side from public Nostr relays
(`relay.nostr.band`, `relay.damus.io`, `nos.lol`) over WebSocket, cached. The
validator's Agent DID resolves the same way. Read-only: the UI never publishes.

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

## Marks — a smart contract demo ("a currency for giving")

`src/Marking.sol` is a tiny contract that turns Bitmark's "marking" ethos into
something programmable: **mark** someone by sending wBTMK *with a reason*, recorded
on-chain as a structured, queryable gift — the social graph L1's plain payments
can't express. It also carries an `identity` tag so you can mark a `did:nostr` /
npub / name, not just an address.

```bash
MARKER_PK=0x.. MARKING=<addr> npm run mark -- <to> <amount> "<identity>" "<reason>"
```

The UI's **Marks** island shows a live feed (from → to, amount, reason, identity)
and a "most marked" leaderboard, all aggregated from `Marked` events in the same
`/bridge-state.jsonld`. This is what the EVM sidechain buys you over L1: events you
can index, per-recipient aggregates, instant finality — in ~40 lines of Solidity.

### Give a mark from the browser (wallet connect)

The **"Give a mark"** form lets you sign a mark client-side. You log in with
[xlogin](https://github.com/melvincarvalho/xlogin) (Nostr); because nostr keys are
secp256k1, the **same key is used as the evmos/EVM signer** (`ethers.Wallet`), and
the mark is tagged with your `did:nostr`. One identity, nostr + EVM.

Two small operator conveniences in `server.js` make it work with no CORS and no
pre-funded account:
- `POST /rpc` — same-origin JSON-RPC proxy (browser signs + sends without CORS).
- `POST /faucet` — drips native gas + a little wBTMK to your derived address.

NIP-07 *extension* logins can't sign EVM (schnorr ≠ ECDSA). Instead of blocking
them, the UI gives extension users an **EVM session key** (generated + stored
locally) for signing, while the **identity stays their real `did:nostr`** from the
extension. Guest/key logins sign with the nostr key directly. The signing key
never leaves the browser.

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
