#!/usr/bin/env node
// lintcha-chain, `npm run verify`: does what section 07 of the page says, and nothing the page does not say.
//   "The command re-runs the collector over the window recorded in the numbers file, rebuilds the index, and prints
//    both hashes and whether they match. A rerun can differ if the endpoint returns differently under load; the
//    shipped index is the one whose hash is printed here."
// So: read site/launch-numbers.json for the block window; run tools/launch-collect.mjs over exactly that window
// (--from N --to M, the public RPC, no key) into a temporary directory; run the owned collection guard, whose
// strict second chain read must rebuild the exact identity tables and summary; run tools/launch-index.mjs on what it wrote,
// into that same temporary directory (the tree's site/ is never written); sha256 both indexes; print the shipped
// hash, the rebuilt hash, and whether they match. The numbers file is not compared and the output says so: it records
// the run itself, so it differs by design. Exit 0 on a match, 1 on a mismatch, 2 when a step could not run.
// The network use is the collector plus the guard's independent read of the same range. Nothing in the tree changes.
//   node tools/verify-index.mjs [--rpc URL] [--keep]      --keep leaves the temporary directory for inspection
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rpcOverrideAllowed } from "./collection-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt; };
const flag = name => argv.includes("--" + name);
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const fail = (m, code) => { console.error("verify: " + m); process.exit(code === undefined ? 2 : code); };

const shippedIndex = path.join(root, "site", "launch-index.json"), shippedNumbers = path.join(root, "site", "launch-numbers.json");
if (!fs.existsSync(shippedIndex) || !fs.existsSync(shippedNumbers)) fail("site/launch-index.json or site/launch-numbers.json is missing; nothing to verify against");
const numbers = JSON.parse(fs.readFileSync(shippedNumbers, "utf8"));
const w = numbers.window;
if (!(Number.isInteger(w.from_block) && Number.isInteger(w.to_block) && w.to_block > w.from_block)) fail("the numbers file has no usable block window");
const rpcOverride = opt("rpc");
if (rpcOverride && !rpcOverrideAllowed(rpcOverride)) fail("--rpc must be HTTPS with no credentials, query or fragment (plain HTTP is accepted only on loopback for a local harness)");
const shippedHash = sha(shippedIndex);
console.log(`window recorded in the numbers file: blocks ${w.from_block} to ${w.to_block} (${w.blocks} blocks), ${w.from_time} to ${w.to_time}`);
console.log(`shipped index: ${shippedIndex.replace(root + path.sep, "")}, ${fs.statSync(shippedIndex).size} bytes, sha256 ${shippedHash}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lintcha-verify-"));
const collected = path.join(tmp, "launch-window.json");
const run = (label, args) => {
  const shown = args.map((value, index) => index > 0 && args[index - 1] === "--rpc" ? "<redacted-rpc>" : value);
  console.log(`\n${label}:\n  node ${shown.join(" ")}`);
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) fail(`${label} exited ${r.status}; nothing compared`);
};
const collectArgs = [path.join("tools", "launch-collect.mjs"), "--from", String(w.from_block), "--to", String(w.to_block), "--out", collected];
if (rpcOverride) collectArgs.push("--rpc", rpcOverride);
run("re-running the collector over that window, against the public RPC, no key", collectArgs);
const guardArgs = [path.join("tools", "collection-guard.mjs"), "--in", collected, "--published", shippedNumbers, "--audit-logs"];
if (rpcOverride) guardArgs.push("--rpc", rpcOverride);
run("strictly re-reading and guarding the collection before the writer sees it", guardArgs);
run("rebuilding the index from what it wrote", [path.join("tools", "launch-index.mjs"), "--in", collected, "--site", tmp]);

const rebuiltIndex = path.join(tmp, "launch-index.json");
if (!fs.existsSync(rebuiltIndex)) fail("the writer produced no index");
const rebuiltHash = sha(rebuiltIndex);
const rebuilt = JSON.parse(fs.readFileSync(path.join(tmp, "launch-numbers.json"), "utf8"));
const match = rebuiltHash === shippedHash;
console.log(`\nshipped index hash  ${shippedHash}`);
console.log(`rebuilt index hash  ${rebuiltHash}`);
console.log(`match: ${match ? "yes" : "no"}  (launches scanned: shipped ${numbers.launches_scanned}, rebuilt ${rebuilt.launches_scanned}; entries: shipped ${numbers.index.entries_total}, rebuilt ${rebuilt.index.entries_total})`);
console.log("launch-numbers.json is not compared: it records the run itself (the collection date, the calls, the seconds), so it differs by design");
if (!match) console.log("a rerun can differ if the endpoint returns differently under load; the shipped index is the one whose hash is printed on the page");
if (flag("keep")) console.log(`kept: ${tmp}`); else fs.rmSync(tmp, { recursive: true, force: true });
process.exit(match ? 0 : 1);
