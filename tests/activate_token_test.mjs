// Hour-X activation is exercised only in disposable repository copies against the real chain adapter and a fake
// Gate. No case reaches the network, the working tree, Cloudflare, Telegram or git.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { activateToken, ActivationFailure, runCli } from "../tools/activate-token.mjs";
import { CHAIN_ID, SEL, forgetChain, forgetDecimals, setGate } from "../bot/src/chain.js";
import { fakeGate, launchRecordHex, stringReturn, wordHex } from "../bot/test/fakes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0, failures = 0;
const ok = (condition, what) => { checks++; if (!condition) { failures++; console.log("  FAIL " + what); } };
const ADDRESS_INPUT = "0x" + "Aa".repeat(20);
const ADDRESS = ADDRESS_INPUT.toLowerCase();
const CURVE = "0x" + "2".repeat(40);
const DEPLOYER = "0x" + "3".repeat(40);
const PAIR = "0x" + "4".repeat(40);
const PONS = "https://example.invalid/pons/" + ADDRESS + "?token=hour-x&view=buy";
const RPC = "https://rpc.example.invalid/fixture";
const COPY_DIRS = ["site", "src", "tools", "lib", "tests"];
const DORMANT_TOKEN = { address: null, pons: null, uniswap: null };
const README_PLACEHOLDER = `<!-- the token line, when there is a token: uncomment and paste the contract
<p align="center"><b>$LINTCHA</b> · <code>0x...</code></p>
-->`;
const README_ACTIVE = /<p align="center"><b>\$LINTCHA<\/b> · <code>0x[0-9a-fA-F]{40}<\/code><\/p>/g;
const WATCHED = [
  "README.md",
  "site/token.json",
  "site/index.html",
  "site/es/index.html",
  "site/pt/index.html",
  "site/404.html",
  "site/sitemap.xml",
  "site/launch-manifest.json",
  "src/i18n/en.json",
  "src/i18n/es.json",
  "src/i18n/pt.json"
];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lintcha-activate-test-"));
  for (const relative of COPY_DIRS) fs.cpSync(path.join(root, relative), path.join(dir, relative), { recursive: true });
  const readmeFile = path.join(dir, "README.md");
  fs.copyFileSync(path.join(root, "README.md"), readmeFile);
  const readme = fs.readFileSync(readmeFile, "utf8"), active = [...readme.matchAll(README_ACTIVE)];
  const placeholders = readme.split(README_PLACEHOLDER).length - 1;
  if (active.length === 1 && placeholders === 0) fs.writeFileSync(readmeFile, readme.replace(README_ACTIVE, README_PLACEHOLDER));
  else if (active.length !== 0 || placeholders !== 1) throw new Error("fixture could not derive one dormant README token line");
  fs.writeFileSync(path.join(dir, "site", "token.json"), JSON.stringify(DORMANT_TOKEN, null, 2) + "\n");
  const built = spawnSync(process.execPath, [path.join(dir, "tools", "build.mjs")], { cwd: dir, encoding: "utf8", windowsHide: true });
  if (built.error || built.status !== 0) throw new Error("fixture could not build a dormant repository copy");
  return dir;
}

function digest(dir) {
  const hash = crypto.createHash("sha256");
  for (const relative of WATCHED) {
    const file = path.join(dir, relative);
    hash.update(relative).update(fs.existsSync(file) ? fs.readFileSync(file) : "<absent>");
  }
  return hash.digest("hex");
}

function gate(overrides = {}) {
  const fake = fakeGate({
    eth_chainId: "0x" + CHAIN_ID.toString(16),
    eth_getBlockByNumber: { number: "0x1234", hash: "0x" + "5".repeat(64) },
    eth_getCode: "0x60006000",
    ["eth_call:" + SEL.launched]: launchRecordHex({ token: ADDRESS, curve: CURVE, deployer: DEPLOYER, pairToken: PAIR }),
    ["eth_call:" + SEL.symbol]: stringReturn("LINTCHA"),
    ["eth_call:" + SEL.decimals]: wordHex(18),
    ["eth_call:" + SEL.totalSupply]: wordHex(1000000n),
    ...overrides
  });
  fake.rawAsked = [];
  const call = fake.call.bind(fake);
  fake.call = async (method, params) => {
    fake.rawAsked.push({ method, params });
    return call(method, params);
  };
  return fake;
}

async function attemptValues(dir, address = ADDRESS_INPUT, pons = PONS, rpc = gate()) {
  setGate(rpc);
  forgetChain();
  forgetDecimals();
  try { return await activateToken(address, pons, { root: dir, rpcUrl: RPC }); }
  finally { setGate(null); forgetChain(); forgetDecimals(); }
}
const attempt = (dir, rpc = gate()) => attemptValues(dir, ADDRESS_INPUT, PONS, rpc);

async function rejects(fn) {
  try { await fn(); return false; }
  catch (error) { return error instanceof ActivationFailure; }
}

const made = [];
try {
  const live = fixture(); made.push(live);
  const liveGate = gate();
  const result = await attempt(live, liveGate);
  const token = JSON.parse(fs.readFileSync(path.join(live, "site", "token.json"), "utf8"));
  const readme = fs.readFileSync(path.join(live, "README.md"), "utf8");
  const indexes = [
    fs.readFileSync(path.join(live, "site", "index.html"), "utf8"),
    fs.readFileSync(path.join(live, "site", "es", "index.html"), "utf8"),
    fs.readFileSync(path.join(live, "site", "pt", "index.html"), "utf8")
  ];
  const notFound = fs.readFileSync(path.join(live, "site", "404.html"), "utf8");
  ok(result.changed === true && result.address === ADDRESS && result.pons === PONS, "a valid proof returns the canonical public activation");
  ok(JSON.stringify(token) === JSON.stringify({ address: ADDRESS, pons: PONS, uniswap: null }), "only address, pons and the required null uniswap field are written");
  ok(readme.includes(`<p align="center"><b>$LINTCHA</b> · <code>${ADDRESS}</code></p>`) && !readme.includes("<code>0x...</code>"), "the one README placeholder becomes the exact canonical address");
  ok(indexes.every(index => index.split("data-token-address>" + ADDRESS + "<").length - 1 === 3) && notFound.split("data-token-address>" + ADDRESS + "<").length - 1 === 1,
    "every generated comparison plus the root 404 carries the exact configured address in its designed slots");
  ok(indexes.every(index => (index.match(/hour-x&amp;view=buy/g) || []).length === 2) && (notFound.match(/hour-x&amp;view=buy/g) || []).length === 1, "every generated comparison plus the root 404 carries the exact escaped primary destination");
  ok(!/token-btn-uni/.test(indexes.join("") + notFound), "the pons-only command cannot create a secondary venue button");
  const proofReads = liveGate.rawAsked.filter(call => call.method === "eth_getCode" || call.method === "eth_call");
  ok(liveGate.rawAsked.filter(call => call.method === "eth_getBlockByNumber").length === 1 &&
    liveGate.rawAsked.some(call => call.method === "eth_getBlockByNumber" && JSON.stringify(call.params) === JSON.stringify(["finalized", false])) &&
    liveGate.rawAsked.some(call => call.method === "eth_getCode" && JSON.stringify(call.params) === JSON.stringify([ADDRESS, "0x1234"])) &&
    proofReads.length === 5 && proofReads.every(call => call.params[1] === "0x1234") &&
    !liveGate.rawAsked.some(call => JSON.stringify(call.params).includes('"latest"')),
  "one finalized header supplies the exact numeric tag for every code, token and factory read, with no latest read");

  const firstDigest = digest(live);
  const again = await attempt(live);
  ok(again.changed === false && digest(live) === firstDigest, "repeating the exact activation is content-idempotent");

  const fresh = fixture(); made.push(fresh);
  for (const lang of ["en", "es", "pt"]) fs.rmSync(path.join(fresh, "src", "i18n", lang + ".json"));
  const freshResult = await attempt(fresh);
  ok(freshResult.changed === true && ["en", "es", "pt"].every(lang => fs.existsSync(path.join(fresh, "src", "i18n", lang + ".json"))),
    "activation succeeds in a fresh checkout where ignored merged-language outputs do not exist yet");

  const invalid = fixture(); made.push(invalid);
  const invalidBefore = digest(invalid);
  ok(await rejects(() => attemptValues(invalid, ADDRESS_INPUT, "http://example.invalid/buy")) && digest(invalid) === invalidBefore,
    "a non-HTTPS destination is refused before any tree file changes");

  const unrelatedPons = fixture(); made.push(unrelatedPons);
  const unrelatedPonsBefore = digest(unrelatedPons);
  const otherAddress = "0x" + "b".repeat(40);
  const unrelatedPonsGate = gate();
  ok(await rejects(() => attemptValues(unrelatedPons, ADDRESS_INPUT, "https://example.invalid/pons/" + otherAddress, unrelatedPonsGate)) &&
    unrelatedPonsGate.rawAsked.length === 0 && digest(unrelatedPons) === unrelatedPonsBefore,
    "a pons URL carrying another address is refused before any chain or tree write");

  const wrongChain = fixture(); made.push(wrongChain);
  const wrongChainBefore = digest(wrongChain);
  ok(await rejects(() => attempt(wrongChain, gate({ eth_chainId: "0x1" }))) && digest(wrongChain) === wrongChainBefore,
    "an endpoint on another chain is refused before any tree file changes");

  const noFinalizedHead = fixture(); made.push(noFinalizedHead);
  const noFinalizedHeadBefore = digest(noFinalizedHead);
  ok(await rejects(() => attempt(noFinalizedHead, gate({ eth_getBlockByNumber: null }))) && digest(noFinalizedHead) === noFinalizedHeadBefore,
    "an endpoint without a canonical finalized head is refused before any tree file changes");

  const noFinalizedHash = fixture(); made.push(noFinalizedHash);
  const noFinalizedHashBefore = digest(noFinalizedHash);
  ok(await rejects(() => attempt(noFinalizedHash, gate({ eth_getBlockByNumber: { number: "0x1234" } }))) && digest(noFinalizedHash) === noFinalizedHashBefore,
    "a finalized response without a canonical block hash is refused before any tree file changes");

  const noCode = fixture(); made.push(noCode);
  const noCodeBefore = digest(noCode);
  ok(await rejects(() => attempt(noCode, gate({ eth_getCode: "0x" }))) && digest(noCode) === noCodeBefore,
    "an address without finalized-state code is refused before any tree file changes");

  const noRecord = fixture(); made.push(noRecord);
  const noRecordBefore = digest(noRecord);
  ok(await rejects(() => attempt(noRecord, gate({
    ["eth_call:" + SEL.launched]: launchRecordHex({ token: ADDRESS, curve: CURVE, deployer: DEPLOYER, pairToken: PAIR, exists: false })
  }))) && digest(noRecord) === noRecordBefore, "a token without the factory's complete live record is refused without a partial activation");

  const wrongSymbol = fixture(); made.push(wrongSymbol);
  const wrongSymbolBefore = digest(wrongSymbol);
  ok(await rejects(() => attempt(wrongSymbol, gate({ ["eth_call:" + SEL.symbol]: stringReturn("NOTLINTCHA") }))) && digest(wrongSymbol) === wrongSymbolBefore,
    "a canonically encoded but different symbol is refused before any tree file changes");

  const noDecimals = fixture(); made.push(noDecimals);
  const noDecimalsBefore = digest(noDecimals);
  ok(await rejects(() => attempt(noDecimals, gate({ ["eth_call:" + SEL.decimals]: "0x" }))) && digest(noDecimals) === noDecimalsBefore,
    "unreadable finalized-state decimals are refused before any tree file changes");

  const noSupply = fixture(); made.push(noSupply);
  const noSupplyBefore = digest(noSupply);
  ok(await rejects(() => attempt(noSupply, gate({ ["eth_call:" + SEL.totalSupply]: "0x" }))) && digest(noSupply) === noSupplyBefore,
    "an unreadable finalized-state total supply is refused before any tree file changes");

  const brokenBuild = fixture(); made.push(brokenBuild);
  fs.rmSync(path.join(brokenBuild, "src", "templates", "shell.html"));
  const brokenBefore = digest(brokenBuild);
  ok(await rejects(() => attempt(brokenBuild)) && digest(brokenBuild) === brokenBefore, "a failed temporary build cannot touch an authored or generated activation file");

  const failedRealBuild = fixture(); made.push(failedRealBuild);
  for (const lang of ["en", "es", "pt"]) fs.rmSync(path.join(failedRealBuild, "src", "i18n", lang + ".json"));
  const buildFile = path.join(failedRealBuild, "tools", "build.mjs");
  fs.writeFileSync(buildFile, `if (!path.basename(process.cwd()).startsWith("lintcha-hour-x-")) {
  fs.writeFileSync(path.join(process.cwd(), "site", "index.html"), "deliberately broken real build");
  fs.writeFileSync(path.join(process.cwd(), "site", "es", "index.html"), "deliberately broken localized real build");
  fs.rmSync(path.join(process.cwd(), "site", "pt", "index.html"));
  fs.writeFileSync(path.join(process.cwd(), "src", "i18n", "en.json"), "deliberately created real-build output");
  process.exit(86);
}
` + fs.readFileSync(buildFile, "utf8"));
  const failedRealBefore = digest(failedRealBuild);
  ok(await rejects(() => attempt(failedRealBuild)) && digest(failedRealBuild) === failedRealBefore,
    "a failed real build rolls back both authored files and every build output already touched");

  let usage = "";
  const status = await runCli([ADDRESS_INPUT], { output: { write() {} }, errorOutput: { write(value) { usage += value; } } });
  ok(status === 1 && usage === "usage: activate-token <CA> <PONS_HTTPS_URL>\n", "the public CLI accepts exactly two positional values");
} finally {
  setGate(null);
  for (const dir of made) {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("lintcha-activate-test-")) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

console.log(`activate token: ${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
