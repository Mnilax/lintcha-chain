#!/usr/bin/env node
// lintcha launch collector (LINTCHA_12 section 6). Offline from the site's point of view: run by whoever has network,
// never part of the site build. Reads the launch log of the pons v2 factory on Robinhood Chain over a block window,
// captures one exact finalized identity-state block and hash, then reads name(), symbol() and getTokenInfo() per
// token at that numeric block (through Multicall3 when it has code there, else one call each), the
// creator fee recipient from each launch transaction's TokenParams, and the block dates; normalizes every field with
// the site's own engine (site/launch.js, imported, never copied), hashes it, counts it per namespace with the first
// date and the number of distinct deployers, and prints the six-line report. Addresses and raw strings live in this
// process's memory only: what it writes (build/launch-collect.json) holds counted hashes and the report, nothing
// that names a person, a project or a wallet. Step 3 (site/launch-index.json and its schema) reads that file.
//
//   node tools/launch-collect.mjs --smoke                 the last ~1000 finalised blocks, limiter proof
//   node tools/launch-collect.mjs --day                   the 24 hours ending at the latest finalised block
//   node tools/launch-collect.mjs --from N --to M         an explicit window
//   options: --chunk N (blocks per eth_getLogs, default 50000)  --spacing MS  --logs-spacing MS  --in-flight N
//            --rpc URL  --out FILE (default build/launch-collect.json)  --no-multicall
//            --identity-state-number N --identity-state-hash 0x... (explicit windows only; both required)
//   Credential-bearing endpoints belong in LINTCHA_CHAIN_RPC_URL. An explicit --rpc remains available for a
//   deliberate local override, but command-line arguments can be visible to other processes and the URL is never
//   printed by this program.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Gate } from "./launch/rpc.mjs";
import { selector, topic } from "./launch/keccak.mjs";
import { T, calldata, decodeParams, encode, TOKEN_INFO, TOKEN_PARAMS, LAUNCHED_TOKEN, AGGREGATE3_CALL, AGGREGATE3_RESULT } from "./launch/abi.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const L = require(path.join(root, "site", "launch.js"));

// ---------------------------------------------------------------- facts to confirm live (section 10: leads, not constants)
const CHAIN_ID = 4663n;
const FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";      // pons v2 launch factory, confirmed below by its log
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const TOKEN_LAUNCHED = topic("TokenLaunched(address,address,address,address,uint256,uint256)");
//   TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)
const SEL = { name: selector("name()"), symbol: selector("symbol()"), info: selector("getTokenInfo()"), launched: selector("getLaunchedToken(address)"), aggregate3: selector("aggregate3((address,bool,bytes)[])") };
const launchedCall = token => SEL.launched + hex32(encode(T.address, token));
const hex32 = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt; };
const flag = name => argv.includes("--" + name);
const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
const RPC_ENV = "LINTCHA_CHAIN_RPC_URL";
const cliRpc = opt("rpc"), envRpc = process.env[RPC_ENV];
if (cliRpc && envRpc) throw new Error("choose either --rpc or " + RPC_ENV + ", not both");
const RPC = cliRpc || envRpc || DEFAULT_RPC;
const rpcUrlAllowed = value => {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
};
if (!rpcUrlAllowed(RPC)) throw new Error("RPC URL must be HTTPS with no userinfo, query or fragment (plain HTTP is accepted only on loopback)");
if (cliRpc) console.error("warning: --rpc is visible in the process argument list; use " + RPC_ENV + " for a credential-bearing endpoint");
const hasIdentityStateNumber = argv.includes("--identity-state-number");
const hasIdentityStateHash = argv.includes("--identity-state-hash");
const identityStateNumberText = opt("identity-state-number");
const identityStateHash = opt("identity-state-hash");
if (hasIdentityStateNumber !== hasIdentityStateHash || (hasIdentityStateNumber && (!identityStateNumberText || !identityStateHash))) {
  throw new Error("--identity-state-number and --identity-state-hash must be supplied together with values");
}
const CHUNK = Number(opt("chunk", 50000));
const SAMPLE = Number(opt("sample", flag("smoke") ? 1 : 50));   // every Nth launch also has its transaction read, to check the factory record against the calldata
const OUT = opt("out", path.join("build", "launch-collect.json"));
const gate = new Gate({ url: RPC, inFlight: Number(opt("in-flight", 2)), spacingMs: Number(opt("spacing", 600)), logsSpacingMs: Number(opt("logs-spacing", 1500)), log: m => console.error("  gate: " + m) });
const rpc = (m, p) => gate.call(m, p);
const hexN = n => "0x" + BigInt(n).toString(16);
const num = h => Number(BigInt(h));
const dateOf = ts => new Date(Number(ts) * 1000).toISOString().slice(0, 10);
const lower = a => String(a).toLowerCase();
const canonicalHash = value => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value) && !/^0x0{64}$/.test(value);
const pinnedIdentityNumber = hasIdentityStateNumber && /^(?:0|[1-9][0-9]*)$/.test(identityStateNumberText) ? Number(identityStateNumberText) : null;
if (hasIdentityStateNumber && (!Number.isSafeInteger(pinnedIdentityNumber) || pinnedIdentityNumber < 0 || !canonicalHash(identityStateHash))) {
  throw new Error("explicit identity state needs a safe nonnegative decimal block number and canonical nonzero lowercase block hash");
}
if (hasIdentityStateNumber && (!opt("from") || !opt("to") || flag("day") || flag("smoke"))) {
  throw new Error("an explicit identity state is accepted only with --from N --to M");
}

// ---------------------------------------------------------------- the window
async function blockAt(n) {
  const tag = typeof n === "string" ? n : hexN(n), b = await rpc("eth_getBlockByNumber", [tag, false]);
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("block " + tag + " is not an object");
  const number = num(b.number), timestamp = num(b.timestamp);
  if (!Number.isSafeInteger(number) || number < 0 || !Number.isSafeInteger(timestamp) || timestamp < 0 || (typeof n !== "string" && number !== n)) throw new Error("block " + tag + " has an invalid number or timestamp");
  return { number, timestamp, hash: b.hash };
}
async function captureIdentityState() {
  const currentFinalized = await blockAt("finalized");
  if (!canonicalHash(currentFinalized.hash)) throw new Error("current finalized block has no canonical nonzero hash");
  if (!hasIdentityStateNumber) return currentFinalized;
  if (currentFinalized.number < pinnedIdentityNumber) throw new Error("explicit identity-state block is above the current finalized head");
  if (currentFinalized.number === pinnedIdentityNumber && currentFinalized.hash !== identityStateHash) throw new Error("current finalized head contradicts the explicit identity-state hash at the same height");
  const pinned = await blockAt(pinnedIdentityNumber);
  if (!canonicalHash(pinned.hash) || pinned.hash !== identityStateHash) throw new Error("explicit identity-state block is not canonical at the supplied hash");
  return pinned;
}
async function firstBlockAtOrAfter(ts, lo, hi) {   // bisection on timestamps, blocks are monotone
  while (lo < hi) { const mid = Math.floor((lo + hi) / 2); const b = await blockAt(mid); if (b.timestamp < ts) lo = mid + 1; else hi = mid; }
  return lo;
}
async function resolveWindow(fin) {
  if (flag("smoke")) return { from: fin.number - 999, to: fin.number, finalized: fin, kind: "smoke" };
  if (opt("from") && opt("to")) return { from: Number(opt("from")), to: Number(opt("to")), finalized: fin, kind: "explicit" };
  if (flag("day")) {
    const target = fin.timestamp - 86400;
    const guess = await blockAt(fin.number - 200000);   // rough seconds per block, then bisect on the real timestamps
    const spb = (fin.timestamp - guess.timestamp) / 200000;
    const est = fin.number - Math.round(86400 / spb);
    const from = await firstBlockAtOrAfter(target, Math.max(1, est - 20000), Math.min(fin.number, est + 20000));
    return { from, to: fin.number, finalized: fin, kind: "day", target };
  }
  throw new Error("give --smoke, --day or --from N --to M");
}

// ---------------------------------------------------------------- the launch log
async function launches(from, to) {
  const out = [];
  for (let a = from; a <= to; a += CHUNK) {
    const b = Math.min(to, a + CHUNK - 1);
    const logs = await rpc("eth_getLogs", [{ address: FACTORY, topics: [TOKEN_LAUNCHED], fromBlock: hexN(a), toBlock: hexN(b) }]);
    for (const l of logs) out.push({ token: "0x" + l.topics[1].slice(26), curve: "0x" + l.topics[2].slice(26), deployer: "0x" + l.topics[3].slice(26), block: num(l.blockNumber), tx: l.transactionHash });
    console.error(`  logs ${a}..${b}: ${logs.length} launches`);
  }
  return out;
}

// ---------------------------------------------------------------- per token: name, symbol, getTokenInfo
const decodeToken = (name, symbol, info, launched) => {
  const r = { name: "", symbol: "", deployer: "", logo: "", description: "", socials: ["", "", "", "", ""], recipient: "", recordDeployer: "", exists: false, readable: true };
  try {
    r.name = decodeParams([T.string], name)[0]; r.symbol = decodeParams([T.string], symbol)[0];
    const i = decodeParams(TOKEN_INFO, info); r.deployer = lower(i[0]); r.logo = i[1]; r.description = i[2]; r.socials = i[3];
    const l = decodeParams([LAUNCHED_TOKEN], launched)[0]; r.recordDeployer = lower(l[2]); r.recipient = lower(l[3]); r.exists = l[14] === true;
  } catch { r.readable = false; }
  return r;
};
// four reads per token: name(), symbol(), getTokenInfo() on the token, getLaunchedToken(token) on the factory
const readsOf = t => [[t.token, true, SEL.name], [t.token, true, SEL.symbol], [t.token, true, SEL.info], [FACTORY, true, launchedCall(t.token)]];
async function readTokens(list, useMulticall, stateTag) {
  const out = new Map();
  if (useMulticall) {
    const per = 15;   // tokens per aggregate3: sixty view calls
    for (let i = 0; i < list.length; i += per) {
      const batch = list.slice(i, i + per);
      const data = calldata(SEL.aggregate3, [T.array(AGGREGATE3_CALL)], [batch.flatMap(readsOf)]);
      const raw = await rpc("eth_call", [{ to: MULTICALL3, data }, stateTag]);
      const res = decodeParams([AGGREGATE3_RESULT], raw)[0];
      batch.forEach((t, k) => { const r = res.slice(4 * k, 4 * k + 4); out.set(t.token, r.every(x => x[0]) ? decodeToken(r[0][1], r[1][1], r[2][1], r[3][1]) : { readable: false }); });
      if ((i / per) % 20 === 0) console.error(`  tokens ${i + batch.length}/${list.length}`);
    }
  } else {
    for (const t of list) {
      const one = ([to, , data]) => rpc("eth_call", [{ to, data }, stateTag]).catch(() => null);
      const r = await Promise.all(readsOf(t).map(one));
      out.set(t.token, r.every(Boolean) ? decodeToken(...r) : { readable: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------- per launch transaction: TokenParams -> creator fee recipient
async function readParams(list) {
  const out = new Map();
  await Promise.all(list.filter((l, i) => i % SAMPLE === 0).map(async l => {
    try {
      const tx = await rpc("eth_getTransactionByHash", [l.tx]);
      const p = decodeParams([TOKEN_PARAMS], "0x" + String(tx.input).slice(10))[0];
      out.set(l.tx, { name: p[0], symbol: p[1], socials: p[4], recipient: lower(p[5]), from: lower(tx.from), to: lower(tx.to || "") });
    } catch { out.set(l.tx, null); }
  }));
  return out;
}

// ---------------------------------------------------------------- counting
class Counter {
  constructor() { this.tables = {}; for (const ns of L.NAMESPACES) this.tables[ns] = new Map(); }
  // For the two skeleton namespaces the value is the skeleton and `spelling` the exact string it came from; the
  // entry also counts the distinct spellings in the group (v), so the page reads a lookalike without arithmetic.
  async add(ns, value, date, deployer, spelling) {
    if (!value) return;
    const h = await L.digest(value), t = this.tables[ns], e = t.get(h) || { n: 0, first: date, deployers: new Set(), spellings: ns.endsWith("_skeleton") ? new Set() : null };
    e.n++; if (date < e.first) e.first = date; e.deployers.add(deployer); if (e.spellings) e.spellings.add(spelling); t.set(h, e);
  }
  frozen() {   // counted hashes only: n, first, d, and v on the skeleton namespaces
    const out = {};
    for (const ns of L.NAMESPACES) { out[ns] = {}; for (const [h, e] of [...this.tables[ns]].sort()) out[ns][h] = e.spellings ? { n: e.n, first: e.first, d: e.deployers.size, v: e.spellings.size } : { n: e.n, first: e.first, d: e.deployers.size }; }
    return out;
  }
}

(async () => {
  const t0 = Date.now();
  const chainId = BigInt(await rpc("eth_chainId", []));
  if (chainId !== CHAIN_ID) throw new Error("chain id " + chainId + ", expected " + CHAIN_ID);
  const identityState = await captureIdentityState();
  const identityTag = hexN(identityState.number);
  const code = await rpc("eth_getCode", [MULTICALL3, identityTag]);
  const useMulticall = code && code.length > 2 && !flag("no-multicall");
  const w = await resolveWindow(identityState);
  if (w.to > identityState.number) throw new Error("window ends after the captured finalized identity state");
  const toBlock = await blockAt(w.to), fromBlock = await blockAt(w.from);
  console.error(`window ${w.kind}: blocks ${w.from}..${w.to} (${w.to - w.from + 1} blocks), ${new Date(fromBlock.timestamp * 1000).toISOString()} .. ${new Date(toBlock.timestamp * 1000).toISOString()}; finalized ${w.finalized.number}; multicall3 code: ${useMulticall ? "yes" : "no"}`);

  const list = await launches(w.from, w.to);
  const tokens = await readTokens(list, useMulticall, identityTag);
  const params = await readParams(list);
  const identityAfter = await blockAt(identityState.number);
  if (identityAfter.hash !== identityState.hash) throw new Error("finalized identity-state block hash changed during identity reads");
  // Dates without a call per block: blocks are monotone in time, so the utc date changes at one block per midnight;
  // each boundary is found by bisection on real timestamps, and a block's date follows from which side it is on.
  const midnights = []; for (let m = Math.ceil(fromBlock.timestamp / 86400) * 86400; m <= toBlock.timestamp; m += 86400) midnights.push(m);
  const boundaries = []; let lo = w.from;
  for (const m of midnights) { const b = await firstBlockAtOrAfter(m, lo, w.to); boundaries.push({ block: b, date: dateOf(m) }); lo = b; }
  const dateOfBlock = b => { let d = dateOf(fromBlock.timestamp); for (const x of boundaries) if (b >= x.block) d = x.date; return d; };
  const blocks = new Map(); for (const l of list) blocks.set(l.block, dateOfBlock(l.block));

  // ---------------------------------------------------------------- verification facts (booleans and counts only)
  const v = { launches: list.length, readable: 0, deployerMatchesEvent: 0, recordDeployerMatchesEvent: 0, recordExists: 0, recipientSet: 0, sampled: 0, calldataDecoded: 0, calldataNameSymbolMatch: 0, calldataSocialsMatch: 0, calldataRecipientMatchesRecord: 0, txFromIsDeployer: 0, txTo: {} };
  const counter = new Counter(), raw = new Map(), rawDeployers = new Map();
  let withLink = 0;
  const skeletonGroups = new Map();   // ticker skeleton -> set of distinct normalized tickers
  const rawLinkOf = (value, field) => L.normalize.linkRaw(value);
  for (const l of list) {
    const t = tokens.get(l.token), p = params.get(l.tx), date = blocks.get(l.block);
    if (!t || !t.readable) continue;
    v.readable++;
    if (t.deployer === l.deployer) v.deployerMatchesEvent++;
    if (t.recordDeployer === l.deployer) v.recordDeployerMatchesEvent++;
    if (t.exists) v.recordExists++;
    if (params.has(l.tx)) v.sampled++;
    if (p) {
      v.calldataDecoded++; v.txTo[p.to] = (v.txTo[p.to] || 0) + 1; if (p.from === l.deployer) v.txFromIsDeployer++;
      const consistent = p.name === t.name && p.symbol === t.symbol;
      if (consistent) { v.calldataNameSymbolMatch++; if (p.recipient === t.recipient) v.calldataRecipientMatchesRecord++; }
      if (JSON.stringify(p.socials) === JSON.stringify(t.socials)) v.calldataSocialsMatch++;
    }
    const socials = {}; L.LINKS.forEach((k, i) => socials[k] = t.socials[i] || "");
    if (L.LINKS.some(k => socials[k].trim())) withLink++;
    for (const k of L.LINKS) {
      await counter.add("link", L.normalize.link(socials[k], k), date, l.deployer);
      const r = rawLinkOf(socials[k], k); if (r) { const e = raw.get(r) || { n: 0, deployers: new Set() }; e.n++; e.deployers.add(l.deployer); raw.set(r, e); }
    }
    await counter.add("logo", L.normalize.logo(t.logo), date, l.deployer);
    const rec = L.normalize.recipient(t.recipient);   // from the factory's own record, never from calldata
    if (rec.state === "ok") { v.recipientSet++; await counter.add("recipient", rec.value, date, l.deployer); }
    const desc = L.normalize.description(t.description);
    if (desc && L.words(desc) >= L.MIN_WORDS) await counter.add("description", desc, date, l.deployer);
    const tick = L.normalize.ticker(t.symbol), name = L.normalize.name(t.name);
    await counter.add("ticker", tick, date, l.deployer); await counter.add("name", name, date, l.deployer);
    await counter.add("ticker_skeleton", L.normalize.skeleton(tick), date, l.deployer, tick); await counter.add("name_skeleton", L.normalize.skeleton(name), date, l.deployer, name);
    if (tick) { const sk = L.normalize.skeleton(tick); if (!skeletonGroups.has(sk)) skeletonGroups.set(sk, new Set()); skeletonGroups.get(sk).add(tick); }
  }
  const frozen = counter.frozen();
  const multi = ns => Object.values(frozen[ns]).filter(e => e.d > 1).length;
  let pairs = 0, groups = 0; for (const s of skeletonGroups.values()) if (s.size > 1) { groups++; pairs += s.size * (s.size - 1) / 2; }
  const rawMulti = [...raw.values()].filter(e => e.deployers.size > 1).length;

  const report = {
    identity_state: { number: identityState.number, hash: identityState.hash },
    window: { kind: w.kind, from: w.from, to: w.to, blocks: w.to - w.from + 1, from_time: new Date(fromBlock.timestamp * 1000).toISOString(), to_time: new Date(toBlock.timestamp * 1000).toISOString(), finalized: w.finalized.number, chain_id: Number(chainId) },
    six: {
      launches_scanned: v.readable,
      launches_with_a_link: { count: withLink, share: v.readable ? Math.round(1000 * withLink / v.readable) / 10 : 0 },
      distinct_link_values: { folded: Object.keys(frozen.link).length, raw: raw.size },
      link_values_by_more_than_one_deployer: { folded: multi("link"), raw: rawMulti },
      tickers_by_more_than_one_deployer: multi("ticker"),
      lookalike_ticker_pairs: { pairs, skeleton_groups: groups }
    },
    also: { names_by_more_than_one_deployer: multi("name"), logos_by_more_than_one_deployer: multi("logo"), recipients_by_more_than_one_deployer: multi("recipient"), descriptions_compared: Object.keys(frozen.description).length, descriptions_by_more_than_one_deployer: multi("description"), lookalike_name_groups: Object.values(frozen.name_skeleton).filter(e => e.v >= 2).length, lookalike_ticker_groups_v: Object.values(frozen.ticker_skeleton).filter(e => e.v >= 2).length },
    verified: { multicall3_has_code: !!useMulticall, launches_in_log: v.launches, tokens_readable: v.readable, getTokenInfo_deployer_equals_event_deployer: v.deployerMatchesEvent, factory_record_exists: v.recordExists, factory_record_deployer_equals_event_deployer: v.recordDeployerMatchesEvent, fee_recipient_set: v.recipientSet, sampled_transactions: v.sampled, calldata_decoded_as_TokenParams: v.calldataDecoded, calldata_name_symbol_equal_onchain: v.calldataNameSymbolMatch, calldata_recipient_equals_factory_record_when_consistent: v.calldataRecipientMatchesRecord, calldata_socials_equal_onchain: v.calldataSocialsMatch, tx_from_equals_deployer: v.txFromIsDeployer, tx_to_distinct: Object.keys(v.txTo).length, day_boundaries: boundaries.map(b => b.block), chunk_blocks: CHUNK },
    limiter: { ...gate.stats, in_flight: gate.inFlight, spacing_ms: gate.spacingMs, logs_spacing_ms: gate.logsSpacingMs, seconds: Math.round((Date.now() - t0) / 1000) },
    tables: frozen
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
  const s = report.six;
  console.log(`launches scanned                                  ${s.launches_scanned}`);
  console.log(`launches with at least one link filled            ${s.launches_with_a_link.count}  (${s.launches_with_a_link.share}%)`);
  console.log(`distinct link values                              ${s.distinct_link_values.folded}  (raw ${s.distinct_link_values.raw})`);
  console.log(`link values carried by more than one deployer     ${s.link_values_by_more_than_one_deployer.folded}  (raw ${s.link_values_by_more_than_one_deployer.raw})`);
  console.log(`tickers carried by more than one deployer         ${s.tickers_by_more_than_one_deployer}`);
  console.log(`lookalike ticker pairs                            ${s.lookalike_ticker_pairs.pairs}  (${s.lookalike_ticker_pairs.skeleton_groups} skeleton groups)`);
  console.log(`\nwindow ${report.window.from}..${report.window.to} (${report.window.blocks} blocks) ${report.window.from_time} .. ${report.window.to_time}`);
  console.log(`verified ${JSON.stringify(report.verified)}`);
  console.log(`limiter  calls ${gate.stats.calls}, http 429 ${gate.stats.http429}, rpc 429 ${gate.stats.rpc429}, retries ${gate.stats.retries}, other errors ${gate.stats.otherErrors}, ${report.limiter.seconds} s, by method ${JSON.stringify(gate.stats.byMethod)}`);
  console.log(`wrote ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });
