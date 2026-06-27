// Mark someone: give wBTMK with a reason, recorded on-chain by Marking.sol.
//   MARKER_PK=0x.. MARKING=0x.. node mark.js <to> <amount> <identity> <reason>
import { ethers } from "ethers";

const RPC = process.env.RPC || "http://localhost:8545";
const WBTMK = process.env.WBTMK || "0x816644F8bc4633D268842628EB10ffC0AdcB6099";
const MARKING = process.env.MARKING;
const PK = process.env.MARKER_PK;
const [to, amountStr, identity = "", reason = ""] = process.argv.slice(2);

if (!PK || !MARKING || !to || !amountStr) {
  console.error("usage: MARKER_PK=0x.. MARKING=0x.. node mark.js <to> <amount> [identity] [reason]");
  process.exit(1);
}

const ERC20 = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const MARK = ["function mark(address to, uint256 amount, string identity, string reason)"];

const wallet = new ethers.Wallet(PK, new ethers.JsonRpcProvider(RPC));
const token = new ethers.Contract(WBTMK, ERC20, wallet);
const marking = new ethers.Contract(MARKING, MARK, wallet);
const amount = ethers.parseEther(amountStr);

if ((await token.allowance(wallet.address, MARKING)) < amount) {
  console.log("approving Marking to spend wBTMK...");
  await (await token.approve(MARKING, ethers.MaxUint256)).wait(1);
}
const rcpt = await (await marking.mark(to, amount, identity, reason)).wait(1);
console.log(`marked ${to} ${amountStr} wBTMK — "${reason}"${identity ? ` [${identity}]` : ""}`);
console.log(`  block #${rcpt.blockNumber} (final), tx ${rcpt.hash}`);
