#!/usr/bin/env node
// lintcha-chain, `npm run verify`: refuses before network when the published numbers file predates an exact
// finalized identity state. For a state-pinned replacement, it does what the page conditionally promises:
// read site/launch-numbers.json for the block window and recorded identity-state number/hash; run
// tools/launch-collect.mjs over exactly that window and state into a temporary directory; run the owned collection guard, whose
// strict second chain read must rebuild the exact identity tables and summary; run tools/launch-index.mjs on what it wrote,
// into that same temporary directory (the tree's site/ is never written); sha256 both indexes; print the shipped
// hash, the rebuilt hash, and whether they match. The numbers file is not compared and the output says so: it records
// the run itself, so it differs by design. Exit 0 on a match, 1 on a mismatch, 2 when a step could not run.
// The network use is the collector plus the guard's independent read of the same range. Nothing in the tree changes.
//   node tools/verify-index.mjs [--rpc URL] [--keep]      credential-bearing endpoints belong in LINTCHA_CHAIN_RPC_URL
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RPC_ENV, exactIdentityState, rpcOverrideAllowed } from "./collection-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt; };
const flag = name => argv.includes("--" + name);
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
class VerifyFailure extends Error {}
const fail = m => { throw new VerifyFailure(m); };
let tmp = null;
let exitCode = 2;

try {
const allowed = new Set(["--rpc", "--keep"]), seen = new Set();
for (let i = 0; i < argv.length; i++) {
  if (!allowed.has(argv[i])) fail("unknown argument " + argv[i]);
  if (seen.has(argv[i])) fail("duplicate argument " + argv[i]);
  seen.add(argv[i]);
  if (argv[i] === "--rpc") {
    if (!argv[i + 1] || argv[i + 1].startsWith("--")) fail("--rpc needs a value");
    i++;
  }
}

const shippedIndex = path.join(root, "site", "launch-index.json"), shippedNumbers = path.join(root, "site", "launch-numbers.json");
if (!fs.existsSync(shippedIndex) || !fs.existsSync(shippedNumbers)) fail("site/launch-index.json or site/launch-numbers.json is missing; nothing to verify against");
const numbers = JSON.parse(fs.readFileSync(shippedNumbers, "utf8"));
const w = numbers.window;
if (!(w && typeof w === "object" && !Array.isArray(w) && Number.isInteger(w.from_block) && Number.isInteger(w.to_block) && w.to_block > w.from_block)) fail("the numbers file has no usable block window");
let identityState;
try { identityState = exactIdentityState(numbers, "published numbers artifact"); }
catch (error) { fail(error.message); }
if (identityState.number < w.to_block) fail("the published identity_state is behind the recorded block window; run a new guarded refresh");
const rpcOverride = opt("rpc");
const rpcFromEnvironment = typeof process.env[RPC_ENV] === "string" && process.env[RPC_ENV] ? process.env[RPC_ENV] : null;
if (rpcOverride && rpcFromEnvironment) fail("choose either --rpc or " + RPC_ENV + ", not both");
if ((rpcOverride || rpcFromEnvironment) && !rpcOverrideAllowed(rpcOverride || rpcFromEnvironment)) fail("RPC endpoint must be HTTPS with no userinfo, query or fragment (plain HTTP is accepted only on loopback)");
if (rpcOverride) console.error("verify: warning: --rpc is visible in the process argument list; use " + RPC_ENV + " for a credential-bearing endpoint");
const shippedHash = sha(shippedIndex);
console.log(`window recorded in the numbers file: blocks ${w.from_block} to ${w.to_block} (${w.blocks} blocks), ${w.from_time} to ${w.to_time}`);
console.log(`shipped index: ${shippedIndex.replace(root + path.sep, "")}, ${fs.statSync(shippedIndex).size} bytes, sha256 ${shippedHash}`);

tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lintcha-verify-"));
const collected = path.join(tmp, "launch-window.json");
const run = (label, args) => {
  const shown = args.map((value, index) => index > 0 && args[index - 1] === "--rpc" ? "<redacted-rpc>" : value);
  console.log(`\n${label}:\n  node ${shown.join(" ")}`);
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (r.error) fail(`${label} could not start; nothing compared`);
  if (r.status !== 0) fail(`${label} exited ${r.status}; nothing compared`);
};
const collectArgs = [path.join("tools", "launch-collect.mjs"), "--from", String(w.from_block), "--to", String(w.to_block), "--identity-state-number", String(identityState.number), "--identity-state-hash", identityState.hash, "--out", collected];
if (rpcOverride) collectArgs.push("--rpc", rpcOverride);
run("re-running the collector over that exact window and recorded identity state (RPC URL not printed)", collectArgs);
const collectedReport = JSON.parse(fs.readFileSync(collected, "utf8"));
let collectedState;
try { collectedState = exactIdentityState(collectedReport, "re-collected artifact"); }
catch (error) { fail(error.message); }
if (collectedState.number !== identityState.number || collectedState.hash !== identityState.hash) fail("the collector did not preserve the published identity_state; nothing compared");
if (!collectedReport.window || collectedReport.window.from !== w.from_block || collectedReport.window.to !== w.to_block) fail("the collector did not preserve the published block window; nothing compared");
const guardArgs = [path.join("tools", "collection-guard.mjs"), "--in", collected, "--published", shippedNumbers, "--audit-logs"];
if (rpcOverride) guardArgs.push("--rpc", rpcOverride);
run("strictly re-reading and guarding the collection before the writer sees it", guardArgs);
run("rebuilding the index from what it wrote", [path.join("tools", "launch-index.mjs"), "--in", collected, "--site", tmp]);

const rebuiltIndex = path.join(tmp, "launch-index.json");
if (!fs.existsSync(rebuiltIndex)) fail("the writer produced no index");
const rebuiltHash = sha(rebuiltIndex);
const rebuiltNumbers = path.join(tmp, "launch-numbers.json");
if (!fs.existsSync(rebuiltNumbers)) fail("the writer produced no numbers artifact");
const rebuilt = JSON.parse(fs.readFileSync(rebuiltNumbers, "utf8"));
let rebuiltState;
try { rebuiltState = exactIdentityState(rebuilt, "rebuilt numbers artifact"); }
catch (error) { fail(error.message); }
if (rebuiltState.number !== identityState.number || rebuiltState.hash !== identityState.hash) fail("the writer did not preserve the published identity_state; nothing compared");
if (!rebuilt.window || rebuilt.window.from_block !== w.from_block || rebuilt.window.to_block !== w.to_block) fail("the writer did not preserve the published block window; nothing compared");
const match = rebuiltHash === shippedHash;
console.log(`\nshipped index hash  ${shippedHash}`);
console.log(`rebuilt index hash  ${rebuiltHash}`);
console.log(`match: ${match ? "yes" : "no"}  (launches scanned: shipped ${numbers.launches_scanned}, rebuilt ${rebuilt.launches_scanned}; entries: shipped ${numbers.index.entries_total}, rebuilt ${rebuilt.index.entries_total})`);
console.log("launch-numbers.json is not compared: it records the run itself (the collection date, the calls, the seconds), so it differs by design");
if (!match) console.log("a rerun can differ if the endpoint returns differently under load; the shipped index is the one whose hash is printed on the page");
exitCode = match ? 0 : 1;
} catch (error) {
  if (error instanceof VerifyFailure) console.error("verify: " + error.message);
  else console.error(`verify: unexpected ${error && typeof error.name === "string" ? error.name : "error"}; nothing compared`);
  exitCode = 2;
} finally {
  if (tmp && flag("keep")) {
    console.log(`kept: ${tmp}`);
  } else if (tmp) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); }
    catch { console.error("verify: could not remove temporary data"); exitCode = 2; }
  }
}
process.exitCode = exitCode;
