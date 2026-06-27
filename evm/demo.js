// Bitmark-EVM PoC demo.
// Drives the wBTMK peg contract on the local Tendermint/EVM (evmos) sidechain
// purely from JS (ethers v6), and times finality to contrast with Bitmark L1.
import { ethers } from "ethers";
import { readFileSync } from "node:fs";

const RPC = process.env.RPC || "http://localhost:8545";
// Well-known evmos local test key (mykey) — peg operator / deployer. PoC only.
const OWNER_PK =
  "0xE9B1D63E8ACD7FE676ACB43AFB390D4B0202DAB61ABEC9CF2A561E4BECB147DE";
const WBTMK = process.env.WBTMK; // deployed address, passed via env

const ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function pegMint(address to, uint256 value, string btmkTxid)",
  "function pegBurn(uint256 value, string btmkAddress)",
  "function transfer(address to, uint256 value) returns (bool)",
  "event PegMint(address indexed to, uint256 value, string btmkTxid)",
  "event PegBurn(address indexed from, uint256 value, string btmkAddress)",
];

const fmt = (v) => ethers.formatEther(v);
const line = () => console.log("─".repeat(64));

// Send a tx, wait for 1 block, and report how long until it was FINAL.
// On Tendermint, 1 confirmation == irreversible finality (no reorg possible).
async function timed(label, txPromise) {
  const t0 = Date.now();
  const tx = await txPromise;
  const rcpt = await tx.wait(1);
  const ms = Date.now() - t0;
  console.log(
    `  ${label}\n    tx ${rcpt.hash}\n    block #${rcpt.blockNumber} · gas ${rcpt.gasUsed} · FINAL in ${ms} ms (1 block, irreversible)`,
  );
  return rcpt;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  const head = await provider.getBlockNumber();

  line();
  console.log("Bitmark-EVM sidechain — Tendermint (CometBFT) + EVM");
  console.log(`  RPC        ${RPC}`);
  console.log(`  chainId    ${net.chainId}`);
  console.log(`  head block ${head}`);
  console.log(`  wBTMK      ${WBTMK}`);
  line();

  const owner = new ethers.Wallet(OWNER_PK, provider);
  // A user receiving bridged coins, and a second recipient for a transfer.
  const user = ethers.Wallet.createRandom().connect(provider);
  const merchant = ethers.Wallet.createRandom().connect(provider);

  const tokenOwner = new ethers.Contract(WBTMK, ABI, owner);
  console.log(`token: ${await tokenOwner.name()} (${await tokenOwner.symbol()}), peg operator ${await tokenOwner.owner()}`);
  console.log(`user     ${user.address}`);
  console.log(`merchant ${merchant.address}`);
  line();

  // Fund the user with a little native coin for gas (they'll send txs).
  console.log("Funding user with gas...");
  await timed(
    "fund user (native)",
    owner.sendTransaction({ to: user.address, value: ethers.parseEther("1") }),
  );

  // 1) PEG IN: operator credits wBTMK for BTMK "locked" on Bitmark L1.
  line();
  console.log("PEG IN  — operator mints wBTMK for a locked L1 deposit");
  await timed(
    "pegMint 1000 wBTMK -> user",
    tokenOwner.pegMint(user.address, ethers.parseEther("1000"), "btmk-l1-txid:demo-deposit-0001"),
  );
  console.log(`  user wBTMK balance: ${fmt(await tokenOwner.balanceOf(user.address))}`);

  // 2) TRANSFER: user pays a merchant on the sidechain.
  line();
  console.log("TRANSFER — user pays merchant 250 wBTMK on the sidechain");
  const tokenUser = tokenOwner.connect(user);
  await timed(
    "transfer 250 wBTMK user -> merchant",
    tokenUser.transfer(merchant.address, ethers.parseEther("250")),
  );
  console.log(`  user     ${fmt(await tokenOwner.balanceOf(user.address))} wBTMK`);
  console.log(`  merchant ${fmt(await tokenOwner.balanceOf(merchant.address))} wBTMK`);

  // 3) PEG OUT: user burns wBTMK to redeem BTMK on L1.
  line();
  console.log("PEG OUT — user burns 100 wBTMK to redeem on Bitmark L1");
  await timed(
    "pegBurn 100 wBTMK (redeem)",
    tokenUser.pegBurn(ethers.parseEther("100"), "btmk1qexampleredeemaddressxxxxxxxxxxxxx"),
  );
  console.log(`  user wBTMK balance: ${fmt(await tokenOwner.balanceOf(user.address))}`);
  console.log(`  total supply:       ${fmt(await tokenOwner.totalSupply())} wBTMK`);

  line();
  console.log("Contrast: Bitmark L1 = 120s blocks, PROBABILISTIC finality (wait N confirmations).");
  console.log("This sidechain = ~3s blocks, DETERMINISTIC finality at 1 block. Same JS/Solidity tooling.");
  line();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
