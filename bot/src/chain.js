// Everything the bot reads, and the one file that talks to the network.
//
// Three rules this file exists to keep:
//
//   The address is not stored here. It is fetched from the site, https://chain.lintcha.com/token.json, and held
//   in this isolate's memory for at most a minute. The day the token exists, the same one file edit that lights
//   the band on the page turns the bot on. There is no second place for the address to disagree.
//
//   There is one RPC client and it was not written here: bot/src/rpc.js is tools/launch/rpc.mjs copied byte for
//   byte, limiter and user agent included. Every call goes through that Gate.
//
//   Nothing is invented when a read fails. A caller gets null and says so in words. No zero stands in for a
//   price, no dash stands in for a balance, and a stale address is never reused after a failed fetch.
//
// The site's own promise, published in the round B page and repeated verbatim in /start, is that everything the
// bot says is read from the chain. So there is no price API here and there will not be one: a dollar figure from
// a third party would break that sentence. Prices are quoted in whatever token the launch paired against, named
// by its address, and when that cannot be read the bot says it cannot.

import { Gate } from "./rpc.js";
import { selector, topic, hex, bytesOf } from "./keccak.js";
import { TOKEN_JSON } from "./texts.js";

// ---------------------------------------------------------------- the facts the collector already confirmed
// tools/launch-collect.mjs lines thirty and thirty-one, and the round D read me: a POST of eth_chainId from a
// worker answered 0x1237, which is this number.
export const CHAIN_ID = 4663n;
export const FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";      // pons v2 launch factory
export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

// computed, not pinned: the same signatures the collector hashes at run time
export const SEL = {
  balanceOf: selector("balanceOf(address)"),
  decimals: selector("decimals()"),
  totalSupply: selector("totalSupply()"),
  launched: selector("getLaunchedToken(address)"),
  slot0: selector("slot0()")
};
export const TOPIC_TRANSFER = topic("Transfer(address,address,uint256)");

// ---------------------------------------------------------------- tiny word reader
// Not a second ABI codec: every value below is a fixed thirty-two byte word. tools/launch/abi.mjs was not
// vendored because vendoring it would mean editing its import line, and "as is" would stop being true.
const word = (data, i) => {
  const b = bytesOf(data);
  let v = 0n;
  for (let k = 0; k < 32; k++) v = (v << 8n) | BigInt(b[i * 32 + k] ?? 0);
  return v;
};
const wordCount = data => Math.floor(bytesOf(data).length / 32);
const addressWord = (data, i) => "0x" + word(data, i).toString(16).padStart(64, "0").slice(24);
const pad = a => String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const hexNum = n => "0x" + BigInt(n).toString(16);
const asNumber = h => Number(BigInt(h));

// ---------------------------------------------------------------- the address, from the site, for at most a minute
const TOKEN_TTL_MS = 60000;
let tokenCache = { at: 0, value: null };

/**
 * The site's token.json.
 *   { ok: true, address, pons, uniswap }   read, address may be null
 *   { ok: false }                          could not be read; the caller says so and answers nothing else
 * The cache is memory only and never outlives a minute, so a launch is visible within a minute of the edit.
 */
export async function readToken(env = {}, now = Date.now()) {
  if (tokenCache.value && now - tokenCache.at < TOKEN_TTL_MS) return tokenCache.value;
  const url = env.TOKEN_JSON_URL || TOKEN_JSON;
  try {
    const r = await fetch(url, { headers: { "user-agent": "lintcha-chain-api", accept: "application/json" }, cf: { cacheTtl: 0 } });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    const value = {
      ok: true,
      address: normal(j.address),
      pons: str(j.pons),
      uniswap: str(j.uniswap)
    };
    tokenCache = { at: now, value };
    return value;
  } catch {
    return { ok: false };                        // a failed read is not a token that does not exist
  }
}

/** Only for tests: drop the memory cache so a case can set up its own answer. */
export function forgetToken() { tokenCache = { at: 0, value: null }; }

// lower first, then check: an address written 0X is still an address, and the other normaliser in
// secp256k1.js already worked that way. A test caught the two disagreeing.
const normal = a => { if (typeof a !== "string") return null; const s = a.trim().toLowerCase(); return /^0x[0-9a-f]{40}$/.test(s) ? s : null; };
const str = s => (typeof s === "string" && s.trim() ? s.trim() : null);

/** true when the bot has an address to work with at all */
export const hasToken = token => !!(token && token.ok && token.address);

// ---------------------------------------------------------------- the gate, one per isolate
let gate = null;
export function rpcGate(env = {}) {
  if (!gate) {
    gate = new Gate({
      url: env.RPC_URL || DEFAULT_RPC,
      inFlight: num(env.RPC_IN_FLIGHT, 2),
      spacingMs: num(env.RPC_SPACING_MS, 600),
      logsSpacingMs: num(env.RPC_LOGS_SPACING_MS, 1500),
      log: () => {}
    });
  }
  return gate;
}
/** Only for tests: replace the gate with a stub, or drop it. */
export function setGate(g) { gate = g; }
const num = (v, d) => (v === undefined || v === null || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

const call = (env, method, params) => rpcGate(env).call(method, params);

// ---------------------------------------------------------------- reads
export async function chainId(env) {
  try { return BigInt(await call(env, "eth_chainId", [])); } catch { return null; }
}

/** The chain the collector reads, or null when the endpoint says something else. Guards every other read. */
export async function chainIsOurs(env) {
  const id = await chainId(env);
  return id !== null && id === CHAIN_ID;
}

export async function blockNumber(env) {
  try { return asNumber(await call(env, "eth_blockNumber", [])); } catch { return null; }
}

async function ethCall(env, to, data) {
  try {
    const r = await call(env, "eth_call", [{ to, data }, "latest"]);
    return typeof r === "string" && r.length > 2 ? r : null;
  } catch { return null; }
}

/** balanceOf, in the token's own base units, or null when the read failed. */
export async function balanceOf(env, token, holder) {
  const r = await ethCall(env, token, SEL.balanceOf + pad(holder));
  return r === null ? null : word(r, 0);
}

const decimalsCache = new Map();   // a token's decimals never change, so this one may outlive the minute
export async function decimalsOf(env, token) {
  if (decimalsCache.has(token)) return decimalsCache.get(token);
  const r = await ethCall(env, token, SEL.decimals);
  if (r === null) return null;
  const d = Number(word(r, 0));
  if (!Number.isInteger(d) || d < 0 || d > 36) return null;
  decimalsCache.set(token, d);
  return d;
}
/** Only for tests. */
export function forgetDecimals() { decimalsCache.clear(); }

export async function totalSupply(env, token) {
  const r = await ethCall(env, token, SEL.totalSupply);
  return r === null ? null : word(r, 0);
}

/**
 * The factory's own record for a token. Fifteen static words, the layout written out in tools/launch/abi.mjs
 * as LAUNCHED_TOKEN. Only the four fields the bot uses are named here.
 */
export async function launchRecord(env, token) {
  const r = await ethCall(env, FACTORY, SEL.launched + pad(token));
  if (r === null || wordCount(r) < 15) return null;
  return {
    curve: addressWord(r, 1),
    deployer: addressWord(r, 2),
    pairToken: addressWord(r, 4),
    phase: word(r, 10),
    exists: word(r, 14) !== 0n
  };
}

/**
 * Where buys and sells happen, as an address, or null.
 * A launch trades against its curve first. After graduation it trades in a pool whose address cannot be derived
 * from anything in this repository, so it comes from a setting; until that setting is filled the curve is used.
 * Both paths are readable and neither is guessed at.
 */
export async function venueOf(env, token) {
  const configured = normal(env.FEED_VENUE || "");
  if (configured) return configured;
  const rec = await launchRecord(env, token);
  return rec && rec.exists ? rec.curve : null;
}

/**
 * Transfer logs of the token between two blocks, split into buys and sells by which side the venue is on.
 * A buy is the venue sending tokens to a wallet; a sell is a wallet sending them back. Nothing else counts,
 * so an ordinary wallet to wallet transfer is neither.
 */
export async function transfersAround(env, token, venue, fromBlock, toBlock) {
  const range = { address: token, fromBlock: hexNum(fromBlock), toBlock: hexNum(toBlock) };
  let logs;
  try {
    logs = await call(env, "eth_getLogs", [{ ...range, topics: [TOPIC_TRANSFER] }]);
  } catch { return null; }
  if (!Array.isArray(logs)) return null;
  const buys = [], sells = [];
  for (const l of logs) {
    if (!l || !Array.isArray(l.topics) || l.topics.length < 3) continue;
    const from = "0x" + String(l.topics[1]).slice(26).toLowerCase();
    const to = "0x" + String(l.topics[2]).slice(26).toLowerCase();
    const amount = word(l.data || "0x", 0);
    const entry = {
      wallet: from === venue ? to : from,
      amount,
      block: asNumber(l.blockNumber),
      tx: String(l.transactionHash || ""),
      logIndex: asNumber(l.logIndex || "0x0")
    };
    if (from === venue && to !== venue) buys.push(entry);
    else if (to === venue && from !== venue) sells.push(entry);
  }
  return { buys, sells };
}

/**
 * The price of one whole token in whole units of the pair token, as a Number, or null.
 * Read from a Uniswap-v3-shaped venue's slot0. VENUE_KIND says which shape the venue is; there is exactly one
 * shape implemented, and any other value means the price is not readable and the bot says so.
 */
export async function priceInPair(env, venue, tokenDecimals, pairDecimals, tokenIsFirst) {
  if ((env.VENUE_KIND || "") !== "v3") return null;
  const r = await ethCall(env, venue, SEL.slot0);
  if (r === null) return null;
  const sqrtPriceX96 = word(r, 0);
  if (sqrtPriceX96 === 0n) return null;
  // price of token0 in token1 is (sqrtPriceX96 / 2^96)^2, then shifted by the two token's decimals
  const q = Number(sqrtPriceX96) / 2 ** 96;
  const raw = q * q;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const shift = 10 ** (Number(tokenDecimals) - Number(pairDecimals));
  const priceOfFirstInSecond = raw * shift;
  const price = tokenIsFirst ? priceOfFirstInSecond : 1 / priceOfFirstInSecond;
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** The limiter's own counters, for /stats. Never invented: straight off the Gate. */
export function gateStats() {
  return gate ? { ...gate.stats } : null;
}

export { hex };
