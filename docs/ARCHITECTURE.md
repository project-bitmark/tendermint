# Architecture & Design

This document is the *argument* behind the code: what this is, why it's shaped the
way it is, and — most importantly — an honest account of its trust model and limits.

## The question

It started as a plain one: **could Tendermint be a decent L2 on top of Bitmark?**

Short answer: **yes — as a fast-finality, programmable *sidechain* with a
Bitcoin-style peg.** This repo demonstrates that end-to-end against the live
Bitmark network with real coins. It is **not** "as secure as Bitmark L1", and this
document is careful to say why. Calling it honestly: it's a *fast, programmable
companion chain with a federated peg*, not a trustlessly-Bitmark-secured rollup.

## The shape

```
  Bitmark L1  (MPoW6 PoW · ElectrumX: electrum.bitmark.rocks:50002)
     │  deposit BTMK (EVM addr in OP_RETURN) ──▶ peg-watcher ──▶ wBTMK.pegMint
     │  release BTMK ◀── redeem-watcher ◀── wBTMK PegBurn
     ▼
  Tendermint / EVM sidechain   (CometBFT 0.38 + evmos v20 · chainId 9000 · ~3s final)
     ├─ wBTMK            bridged Bitmark, ERC-20
     ├─ Marking.sol      "a currency for giving" — gift wBTMK with a reason
     └─ validator  ⇄  did:nostr   (consensus key in the DID doc + on-chain
                                    description + a BIP340-signed attestation)
              ▲
  ui/  — no-build ESM dashboard polling  /bridge-state.jsonld  (JSON-LD)
```

The only always-on, key-holding component is the **operator** (the two watchers +
the peg keys). Everything else — reads, wallet signing, the whole UI — is or can be
client-side.

## Why this combination

The individual pieces are not new. The *combination* is the under-explored part:

| Project | Consensus | Smart contracts | BTC-family peg |
|---|---|---|---|
| Rootstock | merge-mined PoW | ✅ EVM | federated |
| Stacks | Proof-of-Transfer | ✅ Clarity | sBTC |
| Liquid | federated BFT | ❌ | federation |
| Nomic | ✅ **CometBFT** | ❌ | ✅ nBTC |
| Babylon | ✅ **CometBFT** | ~CosmWasm | BTC staking |
| **this** | ✅ **CometBFT** | ✅ **EVM** | ✅ **Bitmark peg** |

Tendermint+Bitcoin exists (Nomic, Babylon); EVM+Bitcoin exists (Rootstock,
Botanix). **Tendermint + EVM + a Bitcoin-family peg together** is essentially an
empty cell. The reasons it stayed empty are cultural and economic, not technical:
Cosmos tech read as "defection" to Bitcoiners, and the peg is federated regardless
of consensus, so nobody had a strong reason to build the polished combo.

**Bitmark is a good host precisely because those blockers don't apply.** It isn't
Bitcoin (no tribal politics), it already hardened L1 with multi-algo PoW (MPoW6,
so the small-chain 51% risk is addressed *its* way), and the chain is controllable.
The sidechain adds what L1 can't do: **~3s deterministic finality** and **smart
contracts**.

## The trust model (the crux)

This is the part most "Bitcoin L2" pitches gloss over, so it goes first.

1. **It's a sidechain, not a rollup.** Bitmark (like Bitcoin) can't verify
   Tendermint signatures or validity/fraud proofs, and can't cheaply store state
   roots. So L1 cannot *enforce* the sidechain's correctness. A "pure" trustless
   rollup is off the table without covenants the base chain doesn't have.

2. **The security ceiling is the peg custody + the validator set — _not_ Bitmark's
   hashpower.** `wBTMK` is only as safe as whoever holds the locked BTMK. This is
   true of *every* L2/sidechain. The honest one-liner: **"Liquid's trust model,
   traded for programmability and speed instead of privacy and conservatism."**

3. **In this PoC both of those are degenerate (n=1):**
   - **Single validator** → instant finality, but a *trusted sequencer*, not BFT.
     BFT needs ≥ 4 validators (`n ≥ 3f+1`).
   - **Single-operator peg** → the watcher holds the keys; it's a federation of one.

None of this is hidden in the UI — the "How it works" panel and the READMEs state
it plainly. A PoC's job is to make the mechanism real and the trust model legible,
not to pretend the trust away.

## Key design decisions

**Sidechain over rollup.** Forced by #1 above. Given that, optimise for what a
sidechain *is* good at: speed, programmability, sovereignty.

**CometBFT + evmos.** Instant deterministic finality (the headline upgrade over
L1's 120s probabilistic blocks) plus a mature EVM. Inherited, not built.

**`did:nostr` validator identity — a public-key binding, not key substitution.**
Wiring an identity to a DID is an *assertion*: the DID document lists the
validator's public consensus key; the chain points back via the staking
`description.details`; and — to harden it — the DID key produced a one-time BIP340
signature over the consensus key (`evm/validator-attestation.json`). The private
key is needed *only* for that one signature; resolution and the rest are read-only.
An earlier attempt to *make* the validator key literally be the DID key (importing
the secret, re-genesis) was the wrong model and was backed out.

**The reserve is derived from the DID's _public_ key.** One secp256k1 identity
therefore spans three roles: the `did:nostr` (x-only pubkey), the evmos operator
account (keccak of the pubkey), and the Bitmark L1 reserve (base58check P2PKH).
This surfaced a genuine subtlety: **nostr keys are BIP340 x-only, which implies
even-Y**, so the L1 address derived from the x-only key is spent by `d` if its
pubkey is even-Y, else by `n − d`. The L1 signer normalises to even-Y accordingly
(`evm/btmk-tx.js`); without it the node rejects the spend as `non-canonical`.

**OP_RETURN per-deposit recipient.** A depositor encodes their EVM address in an
`OP_RETURN`; the watcher mints to *that* address. This makes the peg-in multi-user
without an off-chain registry or indexer — the mapping rides in the deposit itself.

**`wBTMK` is a minimal ERC-20 with an owner-gated `pegMint`.** The `owner` is the
explicit placeholder for the future custodian; replacing it with a threshold
signer / peg module changes nothing else about the token.

**`Marking.sol` is the "why bother with EVM" demo.** Bitmark's ethos is "a currency
for giving"; the contract makes that programmable — gift wBTMK *with a reason*,
recorded as a structured, queryable event tagged by `did:nostr`, with per-recipient
totals. None of that is expressible in L1's plain payments. ~40 lines.

**Client-side signing with the nostr key.** Because nostr and evmos accounts are
both secp256k1, a guest/key login signs the EVM transactions *with the same key*
that is the `did:nostr` identity. NIP-07 *extension* logins can't (schnorr ≠
ECDSA), so they fall back to a locally-generated **EVM session key** while keeping
the real `did:nostr` as the identity tag.

**No-build UI + JSON-LD.** Semantic HTML with data-island hydration; the whole
bridge state is one `/bridge-state.jsonld` document the browser polls. The operator
*publishes* state; the client *reads* it. A small `/rpc` proxy + `/faucet` are the
only operator conveniences; with a `wss` Electrum and a CORS-enabled RPC the server
disappears entirely and the UI becomes pure static.

## What's deliberately not done

- **Decentralised consensus** — single validator (PoC). Path: grow to ≥ 4 (BFT).
- **Decentralised custody** — single-operator peg. Path: threshold/FROST signers,
  ideally with the signer set = the validator set, re-keyed per epoch.
- **Trust-minimised peg** — impossible today: it needs covenants
  (`OP_CAT`/CTV/APO) that Bitmark (being Bitcoin-derived) doesn't have. BitVM-style
  approaches buy a marginal improvement for outsized complexity; out of scope.
- **Confirmations** — peg-in mints at 0-conf for demo snappiness (`MIN_CONF=0`);
  raise it for real value.
- **L1-anchored ordering** — the sidechain doesn't yet checkpoint into Bitmark.

## The path to "more real"

In rough order of value:

1. **Validators 1 → 4+** — real BFT, not a trusted sequencer.
2. **Threshold/FROST peg** — replace the single operator with a slashing-backed
   signer set; this is the security upgrade that matters most.
3. **Babylon-style checkpointing** — periodically write the sidechain head into
   Bitmark L1, importing *some* of Bitmark's PoW for objective ordering and
   long-range defence (cheap: ~32 bytes per checkpoint).
4. **Server-less client** — `wss://` Electrum + CORS-enabled RPC ⇒ delete the
   server from the client path; the UI runs as pure static (e.g. gh-pages),
   leaving only the operator daemon.
5. **Covenants** — the only thing that would make the *peg itself* trust-minimised,
   and it's a base-chain capability, not something this layer can add.

## Verdict

A Tendermint/EVM sidechain is a genuinely good fit for Bitmark: it adds fast
finality and smart contracts, it's honest about being a federated-peg sidechain
(security = peg + validators, not hashpower), and it lands in a combination
—Tendermint + EVM + a Bitcoin-family peg— that almost nobody has built because the
usual blockers don't apply here. It won't ever be "as secure as holding BTMK on
L1", and it doesn't claim to be. As a *fast, programmable, identity-bound companion
chain*, it works — demonstrated, with real coins, end to end.
