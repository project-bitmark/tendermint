# tendermint — a Bitmark L2 proof-of-concept

A working PoC of a **Tendermint (CometBFT) + EVM sidechain for [Bitmark](https://project-bitmark.github.io/)**,
with a **real two-way BTMK ⇄ wBTMK bridge**, a validator bound to a **`did:nostr`**
identity, and an on-chain **"Marks"** gifting contract — all driven from a
**no-build, browser-native ESM / JSON-LD** dashboard.

> Status: proof-of-concept, run against the live Bitmark network with real (and
> largely worthless 🙂) BTMK. Not production. The peg is a single-operator
> federation; see caveats below.

## Why

The pieces exist separately — Tendermint+Bitcoin (Nomic, Babylon) and EVM+Bitcoin
(Rootstock, Botanix) — but **Tendermint + EVM + a Bitcoin-family peg together** is
an under-explored cell. Bitmark is a good host: it isn't Bitcoin (no tribal
politics), it already hardened L1 with multi-algo PoW (MPoW6), and we control the
chain. The sidechain adds what L1 can't do: **~3s deterministic finality** and
**smart contracts**.

## Architecture

```
  Bitmark L1  (MPoW6 PoW · ElectrumX: electrum.bitmark.rocks:50002)
     │  deposit BTMK ──▶ peg-watcher.js  ──▶  wBTMK.pegMint        (mint)
     │  release BTMK ◀── redeem-watcher.js ◀── wBTMK PegBurn       (burn)
     ▼
  Tendermint / EVM sidechain   (CometBFT + evmos · chainId 9000 · ~3s final)
     ├─ wBTMK            bridged Bitmark, ERC-20
     ├─ Marking.sol      "a currency for giving" — gift wBTMK with a reason
     └─ validator  ⇄  did:nostr   (consensus key in the DID doc + on-chain
                                    description + a BIP340-signed attestation)
              ▲
  ui/  — no-build ESM dashboard polling  /bridge-state.jsonld  (JSON-LD)
```

## Proven live (real coins)

- **Peg-in:** 0.8 BTMK deposited (`7613b651…268e12`) → 0.8 wBTMK minted, the L1
  txid recorded in the `PegMint` event.
- **Peg-out:** burned 0.5 wBTMK → **0.5 BTMK released on L1** (`a4308960…d3145c`),
  change returned to the reserve.
- **Identity:** the running validator's Ed25519 consensus key is asserted in the
  DID doc, the chain points back via `description.details`, and the DID key signed
  an attestation over it — all verifiable with `scripts/verify-binding.sh`.
- **Marks:** four real on-chain gifts between accounts, with reasons + identity
  tags and a "most marked" leaderboard.

## Quickstart

Needs `evmosd` (evmos v20 prebuilt binary), Node 20+, and [Foundry](https://getfoundry.sh).

```bash
# 1. start the single-validator Tendermint/EVM devnet (JSON-RPC :8545)
./scripts/start-chain.sh

# 2. deploy + exercise (see evm/README.md for the full sequence)
cd evm && npm install
forge create src/wBTMK.sol:wBTMK   --rpc-url http://localhost:8545 --private-key <test-key> --broadcast
forge create src/Marking.sol:Marking --rpc-url http://localhost:8545 --private-key <test-key> --broadcast --constructor-args <wBTMK>

# 3. bridge + UI
npm run watch    # peg-in:  Bitmark deposits  -> wBTMK
npm run redeem   # peg-out: wBTMK burns       -> Bitmark releases
npm run ui       # dashboard at http://localhost:8080
```

Or, once the contracts are deployed, bring up the whole stack (chain + both
watchers + UI) with one command and tear it down with another:

```bash
./scripts/demo-up.sh      # http://localhost:8080
./scripts/demo-down.sh
```

In the UI you can connect a Nostr identity (xlogin), **bridge in** (deposit to
your address), **give marks** (gift wBTMK with a reason, tagged by did:nostr), and
**bridge out** (redeem to Bitmark L1) — the full round-trip, no scripts.

Full details, the exact peg/identity/Marks flows, and the honest trust model are
in **[`evm/README.md`](evm/README.md)**.

## Repo layout

| Path | What |
|---|---|
| `scripts/` | start/stop the single-validator chain; `verify-binding.sh` |
| `evm/*.sol` | `wBTMK` (bridged token) and `Marking` (gifting) contracts |
| `evm/electrum.js`, `btmk.js`, `btmk-tx.js` | Bitmark L1: ElectrumX client, addresses, tx signer (pure JS) |
| `evm/peg-watcher.js`, `redeem-watcher.js` | the two-way bridge |
| `evm/server.js` | zero-dep server: static UI + live `/bridge-state.jsonld` |
| `ui/` | no-build ESM dashboard (semantic HTML + data-island hydration) |
| `agent.did.json` | the agent's `did:nostr` identity, wired to the validator |

## Caveats (it's a PoC)

- **The peg is single-operator.** A sidechain's security ceiling is its peg
  custody + validator set, **not** Bitmark's hashpower — same as every L2. This is
  "Liquid's trust model, traded for programmability and speed."
- **Single validator** — fast and final, but not decentralised or BFT (BFT needs
  ≥ 4). It's a fast, trusted sequencer for the PoC.
- **Test keys** — the `0xE9B1…` deployer key in the code is the public, documented
  evmos local-test key. Don't use it anywhere real.
- Committed identity/attestation reflect the demo chain instance; a fresh
  `start-chain.sh` generates a new consensus key.

🤖 Built with [Claude Code](https://claude.com/claude-code).
