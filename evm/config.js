// Shared deployment config. Precedence: env var > evm/deployment.json > default.
// `deployment.json` is written by scripts/deploy.sh and gitignored (per-chain).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
let file = {};
const fp = join(dir, "deployment.json");
if (existsSync(fp)) { try { file = JSON.parse(readFileSync(fp, "utf8")); } catch {} }

const pick = (envKey, fileKey, def) => process.env[envKey] || file[fileKey] || def;

export const RPC = pick("RPC", "rpc", "http://localhost:8545");
export const WBTMK = pick("WBTMK", "wBTMK", "0x816644F8bc4633D268842628EB10ffC0AdcB6099");
export const MARKING = pick("MARKING", "marking", "0x0F5575BC344f6F0b595A7B3a0bDEdE9a90859c6f");
export const RESERVE = pick("RESERVE_ADDR", "reserve", "bV7H8TVVfvcstcoftiZ9cJuDYkaG9FSVwG");
