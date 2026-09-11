// One guarded Hour-X switch. The command accepts only the public contract address and its primary pons HTTPS URL:
//
//   node tools/activate-token.mjs <CA> <PONS_HTTPS_URL>
//
// The bot deliberately has no second token-address setting. This command proves the address against the configured
// chain, builds and checks a complete temporary repository copy, and only then replaces the authored activation
// document and README line together. The real build is the final step; any failure restores every touched tree file.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tokenConfigBytesOf, tokenConfigOf } from "../lib/config-contract.mjs";
import {
  DEFAULT_RPC,
  chainIsOurs,
  decimalsOf,
  forgetChain,
  forgetDecimals,
  launchRecord,
  rpcGate,
  symbolOf,
  totalSupply
} from "../bot/src/chain.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TOKEN_REL = path.join("site", "token.json");
const README_REL = "README.md";
const BUILD_OUTPUTS = [
  path.join("site", "index.html"),
  path.join("site", "404.html"),
  path.join("site", "sitemap.xml"),
  path.join("site", "launch-manifest.json"),
  path.join("src", "i18n", "en.json"),
  path.join("src", "i18n", "es.json"),
  path.join("src", "i18n", "pt.json")
];
const PREFLIGHT_DIRS = ["site", "src", "tools", "lib", "tests"];
const TOKEN_LINE = address => `<p align="center"><b>$LINTCHA</b> · <code>${address}</code></p>`;
const PLACEHOLDER = /<!-- the token line, when there is a token: uncomment and paste the contract\r?\n<p align="center"><b>\$LINTCHA<\/b> · <code>0x\.\.\.<\/code><\/p>\r?\n-->/g;
const ACTIVE_LINE = /<p align="center"><b>\$LINTCHA<\/b> · <code>(0x[0-9a-fA-F]{40})<\/code><\/p>/g;

export class ActivationFailure extends Error {
  constructor(message) { super(message); this.name = "ActivationFailure"; }
}
const fail = message => { throw new ActivationFailure(message); };
const bytes = file => fs.readFileSync(file);
const sameBytes = (a, b) => Buffer.compare(a, b) === 0;
const snapshotOf = file => fs.existsSync(file) ? { existed: true, value: bytes(file) } : { existed: false, value: null };
const differs = (file, before) => before.existed !== fs.existsSync(file) ||
  (before.existed && !sameBytes(before.value, bytes(file)));
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeAttribute = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const count = (text, pattern) => (text.match(pattern) || []).length;

function readActivation(root) {
  const file = path.join(root, TOKEN_REL);
  const raw = bytes(file);
  const value = tokenConfigBytesOf(raw);
  if (!value) fail("the current token.json does not match the shared activation contract");
  return { file, raw, value };
}

function nextReadme(raw, address) {
  const text = raw.toString("utf8");
  const placeholders = [...text.matchAll(PLACEHOLDER)];
  const active = [...text.matchAll(ACTIVE_LINE)];
  if (placeholders.length === 1 && active.length === 0) {
    return Buffer.from(text.replace(PLACEHOLDER, TOKEN_LINE(address)), "utf8");
  }
  if (placeholders.length === 0 && active.length === 1 && active[0][1] === address) return raw;
  fail("the README token line is missing, duplicated or names another address");
}

function activationInput(address, pons) {
  const config = tokenConfigOf({ address, pons, uniswap: null });
  if (!config || !config.address || !config.pons || config.uniswap !== null) {
    fail("expected one nonzero contract address and one canonical HTTPS pons URL");
  }
  const boundAddress = new RegExp(`(?<![0-9a-f])${escapePattern(config.address)}(?![0-9a-f])`, "i");
  if (!boundAddress.test(config.pons)) fail("the canonical pons URL does not contain the exact contract address");
  return config;
}

function runNode(entry, args, cwd) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
  if (result.error || result.status !== 0) fail("a temporary build or its activation contract failed");
  return result.stdout || "";
}

async function proveFinalizedState(config, rpcUrl) {
  const env = { RPC_URL: rpcUrl || DEFAULT_RPC };
  forgetChain();
  forgetDecimals();
  if (!await chainIsOurs(env)) fail("the configured endpoint did not prove the expected chain");
  const gate = rpcGate(env);
  if (!gate) fail("the configured endpoint is not a canonical HTTPS URL");
  let finalized;
  try { finalized = await gate.call("eth_getBlockByNumber", ["finalized", false]); }
  catch { fail("the configured endpoint did not return a canonical finalized head"); }
  if (!finalized || typeof finalized !== "object" || Array.isArray(finalized) ||
      typeof finalized.number !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(finalized.number) ||
      typeof finalized.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(finalized.hash) || /^0x0{64}$/i.test(finalized.hash)) {
    fail("the configured endpoint did not return a canonical finalized head");
  }
  const stateTag = finalized.number;

  let code;
  try { code = await gate.call("eth_getCode", [config.address, stateTag]); }
  catch { fail("the configured endpoint could not read token code at the finalized state"); }
  if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || /^0x(?:00)+$/i.test(code)) {
    fail("the address has no nonzero contract code at the finalized state");
  }

  const record = await launchRecord(env, config.address, stateTag);
  if (!record || record.exists !== true) fail("the factory does not return a complete record for this token at the finalized state");
  const symbol = await symbolOf(env, config.address, stateTag);
  if (symbol !== "LINTCHA") fail("the token symbol at the finalized state is not exactly LINTCHA");
  const decimals = await decimalsOf(env, config.address, stateTag);
  if (decimals === null) fail("the token decimals are unreadable at the finalized state");
  const supply = await totalSupply(env, config.address, stateTag);
  if (supply === null) fail("the token total supply is unreadable at the finalized state");
  return { stateTag, record, symbol, decimals, supply };
}

function verifyRendered(root, config, readmeBytes) {
  const token = tokenConfigBytesOf(bytes(path.join(root, TOKEN_REL)));
  if (!token || JSON.stringify(token) !== JSON.stringify(config)) fail("the built token document does not equal the requested activation");

  const index = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
  const notFound = fs.readFileSync(path.join(root, "site", "404.html"), "utf8");
  const address = escapePattern(config.address);
  const href = escapePattern(escapeAttribute(config.pons));
  if (count(index, new RegExp(`data-token-address>${address}<`, "g")) !== 3 ||
      count(index, /data-copy-address/g) !== 2 ||
      count(index, new RegExp(`class="buy" href="${href}"`, "g")) !== 1 ||
      count(index, new RegExp(`class="token-btn token-btn-pons" href="${href}"`, "g")) !== 1 ||
      /token-btn-uni/.test(index)) {
    fail("the front page did not render the exact pons-only activation state");
  }
  if (count(notFound, new RegExp(`data-token-address>${address}<`, "g")) !== 1 ||
      count(notFound, /data-copy-address/g) !== 1 ||
      count(notFound, new RegExp(`class="buy" href="${href}"`, "g")) !== 1 ||
      /token-btn-uni/.test(notFound)) {
    fail("the not-found page did not render the exact activation header");
  }

  const readme = readmeBytes.toString("utf8");
  const active = [...readme.matchAll(ACTIVE_LINE)];
  if (active.length !== 1 || active[0][1] !== config.address || [...readme.matchAll(PLACEHOLDER)].length !== 0) {
    fail("the README does not carry exactly the requested public contract line");
  }
}

function copyPreflightTree(root, destination) {
  for (const relative of PREFLIGHT_DIRS) {
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) fail("the repository is missing a preflight directory");
    fs.cpSync(source, path.join(destination, relative), { recursive: true, force: false });
  }
}

function tempPreflight(root, config, readmeBytes) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lintcha-hour-x-"));
  try {
    copyPreflightTree(root, temp);
    fs.writeFileSync(path.join(temp, README_REL), readmeBytes);
    fs.writeFileSync(path.join(temp, TOKEN_REL), JSON.stringify(config, null, 2) + "\n");
    runNode(path.join(temp, "tools", "build.mjs"), [], temp);
    verifyRendered(temp, config, readmeBytes);
    // This state-aware test also pins all eight never lines in all three source languages by digest.
    runNode(path.join(temp, "tests", "chain_token_states.mjs"), [], temp);
    return new Map(BUILD_OUTPUTS.map(relative => [relative, bytes(path.join(temp, relative))]));
  } finally {
    const resolved = path.resolve(temp);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("lintcha-hour-x-")) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

function atomicReplace(file, value) {
  const id = crypto.randomBytes(8).toString("hex");
  const pending = file + ".activate-" + id + ".tmp";
  const backup = file + ".activate-" + id + ".bak";
  fs.writeFileSync(pending, value, { flag: "wx" });
  let moved = false;
  try {
    fs.renameSync(file, backup);
    moved = true;
    fs.renameSync(pending, file);
    fs.rmSync(backup, { force: true });
  } catch (error) {
    try { if (fs.existsSync(pending)) fs.rmSync(pending, { force: true }); } catch {}
    try {
      if (moved && fs.existsSync(backup)) {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
        fs.renameSync(backup, file);
      }
    } catch {}
    throw error;
  }
}

function atomicCreate(file, value) {
  const pending = file + ".activate-" + crypto.randomBytes(8).toString("hex") + ".tmp";
  fs.writeFileSync(pending, value, { flag: "wx" });
  try { fs.renameSync(pending, file); }
  catch (error) {
    try { if (fs.existsSync(pending)) fs.rmSync(pending, { force: true }); } catch {}
    throw error;
  }
}

function restore(snapshot) {
  const failed = [];
  for (const [file, before] of snapshot) {
    try {
      if (!before.existed) {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      } else if (fs.existsSync(file)) atomicReplace(file, before.value);
      else atomicCreate(file, before.value);
    } catch { failed.push(file); }
  }
  if (failed.length) fail("activation failed and its local rollback could not restore every touched file");
}

export async function activateToken(address, pons, options = {}) {
  const root = path.resolve(options.root || ROOT);
  const config = activationInput(address, pons);
  const current = readActivation(root);
  if (current.value.address !== null && JSON.stringify(current.value) !== JSON.stringify(config)) {
    fail("token.json already carries another activation");
  }
  const readmeFile = path.join(root, README_REL);
  const readmeRaw = bytes(readmeFile);
  const readmeNext = nextReadme(readmeRaw, config.address);

  // Network and build proof complete before the first write to the repository tree.
  await proveFinalizedState(config, options.rpcUrl || process.env.LINTCHA_CHAIN_RPC_URL || DEFAULT_RPC);
  const proposed = tempPreflight(root, config, readmeNext);

  const files = [current.file, readmeFile, ...BUILD_OUTPUTS.map(relative => path.join(root, relative))];
  const snapshot = new Map(files.map(file => [file, snapshotOf(file)]));
  // Refuse a concurrent edit between the in-memory read and the completed preflight.
  if (differs(current.file, { existed: true, value: current.raw }) || differs(readmeFile, { existed: true, value: readmeRaw })) {
    fail("an activation input changed during preflight");
  }

  const tokenNext = Buffer.from(JSON.stringify(config, null, 2) + "\n", "utf8");
  try {
    atomicReplace(current.file, tokenNext);
    atomicReplace(readmeFile, readmeNext);
    runNode(path.join(root, "tools", "build.mjs"), [], root);
    verifyRendered(root, config, readmeNext);
    if (BUILD_OUTPUTS.some(relative => !sameBytes(bytes(path.join(root, relative)), proposed.get(relative)))) {
      fail("the real build does not reproduce the completed temporary preflight");
    }
  } catch (error) {
    try { restore(snapshot); }
    catch (rollbackError) { throw rollbackError; }
    throw error;
  }

  const changed = !sameBytes(current.raw, tokenNext) || !sameBytes(readmeRaw, readmeNext) ||
    BUILD_OUTPUTS.some(relative => differs(path.join(root, relative), snapshot.get(path.join(root, relative))));
  return { address: config.address, pons: config.pons, changed };
}

export async function runCli(argv = process.argv.slice(2), io = {}) {
  const output = io.output || process.stdout;
  const errorOutput = io.errorOutput || process.stderr;
  if (!Array.isArray(argv) || argv.length !== 2) {
    errorOutput.write("usage: activate-token <CA> <PONS_HTTPS_URL>\n");
    return 1;
  }
  try {
    const result = await activateToken(argv[0], argv[1]);
    output.write(`activate-token: ${result.changed ? "prepared" : "already prepared"} ${result.address}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof ActivationFailure ? error.message : "unexpected local failure";
    errorOutput.write("activate-token: failed: " + message + "\n");
    return 1;
  }
}

const main = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (main) process.exitCode = await runCli();
