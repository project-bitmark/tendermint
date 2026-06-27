// Initiate a peg-out: burn wBTMK and name a Bitmark L1 return address.
// The redeem-watcher then releases that BTMK from the reserve.
//   usage: BURNER_PK=0x.. node burn.js <amount-wBTMK> <btmk-return-address>
import { ethers } from "ethers";

const RPC = process.env.RPC || "http://localhost:8545";
const WBTMK = process.env.WBTMK || "0x816644F8bc4633D268842628EB10ffC0AdcB6099";
const PK = process.env.BURNER_PK;
const [amountStr, btmkAddr] = process.argv.slice(2);

if (!PK || !amountStr || !btmkAddr) {
  console.error("usage: BURNER_PK=0x.. node burn.js <amount-wBTMK> <btmk-return-address>");
  process.exit(1);
}

const ABI = [
  "function pegBurn(uint256 value, string btmkAddress)",
  "function balanceOf(address) view returns (uint256)",
];

const wallet = new ethers.Wallet(PK, new ethers.JsonRpcProvider(RPC));
const wbtmk = new ethers.Contract(WBTMK, ABI, wallet);
const value = ethers.parseEther(amountStr);

console.log(`burning ${amountStr} wBTMK from ${wallet.address}, return to ${btmkAddr}`);
const before = await wbtmk.balanceOf(wallet.address);
const rcpt = await (await wbtmk.pegBurn(value, btmkAddr)).wait(1);
const after = await wbtmk.balanceOf(wallet.address);
console.log(`burned in block #${rcpt.blockNumber} (final). tx ${rcpt.hash}`);
console.log(`wBTMK balance: ${ethers.formatEther(before)} -> ${ethers.formatEther(after)}`);
console.log("redeem-watcher will now release BTMK on L1.");
