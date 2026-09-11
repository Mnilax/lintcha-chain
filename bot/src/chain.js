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
import { tokenConfigBytesOf, requiredHttpsUrlOf, TOKEN_CONFIG_BODY_LIMIT } from "../../lib/config-contract.mjs";
import { integerSetting } from "./config.js";

// ---------------------------------------------------------------- the facts the collector already confirmed
// tools/launch-collect.mjs lines thirty and thirty-one, and the round D read me: a POST of eth_chainId from a
// worker answered 0x1237, which is this number.
export const CHAIN_ID = 4663n;
export const FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";      // pons v2 launch factory
export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const DEFAULT_RPC_IN_FLIGHT = 2;
export const DEFAULT_RPC_SPACING_MS = 600;
export const DEFAULT_RPC_LOGS_SPACING_MS = 1500;
/** Durable rounds own retries; one logical RPC call spends at most one external subrequest. */
export const BOT_RPC_MAX_RETRIES = 0;
/** The static build and this network reader share one exact authored activation-document ceiling. */
export const TOKEN_JSON_BODY_LIMIT = TOKEN_CONFIG_BODY_LIMIT;
/** A site activation read never occupies more than the existing five-second public-cache window. */
export const TOKEN_JSON_TIMEOUT_MS = 5000;
/** The vendored gate's own longest backoff is one minute; a larger start-spacing is a malformed setting. */
export const MAX_RPC_SPACING_MS = 60000;
export const MAX_TOKEN_DECIMALS = 36;
/** A log page above this product bound is unreadable as a unit; callers never consume a prefix. */
export const DEFAULT_MAX_TRANSFER_LOGS = 2000;
/** Distinct numbered headers proved per Transfer page; callers split a wider page before any fact is returned. */
export const MAX_TRANSFER_HEADER_BLOCKS = 40;
export const TRANSFER_LOGS_OVERFLOW = Object.freeze({ overflow: true });

// computed, not pinned: the same signatures the collector hashes at run time
export const SEL = {
  balanceOf: selector("balanceOf(address)"),
  decimals: selector("decimals()"),
  totalSupply: selector("totalSupply()"),
  launched: selector("getLaunchedToken(address)"),
  token0: selector("token0()"),
  token1: selector("token1()"),
  slot0: selector("slot0()")
};
export const TOPIC_TRANSFER = topic("Transfer(address,address,uint256)");

// ---------------------------------------------------------------- tiny word reader
// Not a second ABI codec: every value below is a fixed thirty-two byte word. tools/launch/abi.mjs was not
// vendored because vendoring it would mean editing its import line, and "as is" would stop being true.
const wordBytes = data => {
  if (typeof data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) return null;
  try {
    const bytes = bytesOf(data);
    return bytes.length % 32 === 0 ? bytes : null;
  } catch { return null; }
};
const word = (data, i) => {
  const b = wordBytes(data);
  if (!b || !Number.isSafeInteger(i) || i < 0 || (i + 1) * 32 > b.length) return null;
  let v = 0n;
  for (let k = 0; k < 32; k++) v = (v << 8n) | BigInt(b[i * 32 + k]);
  return v;
};
const wordCount = data => {
  const bytes = wordBytes(data);
  return bytes ? bytes.length / 32 : null;
};
const addressWord = (data, i) => {
  const value = word(data, i);
  return value !== null && (value >> 160n) === 0n ? "0x" + value.toString(16).padStart(40, "0") : null;
};
const pad = a => String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const hexNum = n => "0x" + BigInt(n).toString(16);
const rpcQuantityNumber = value => {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) return null;
  try {
    const number = Number(BigInt(value));
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  } catch { return null; }
};
const topicAddress = value => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  const body = value.slice(2).toLowerCase();
  return /^0{24}/.test(body) ? "0x" + body.slice(24) : null;
};
const rpcAddress = value => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
const rpcHash = value => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/i.test(value)
  ? value.toLowerCase()
  : null;

// ---------------------------------------------------------------- the address, from the site, for at most a minute
const TOKEN_TTL_MS = 60000;
let tokenCache = { at: 0, value: null, url: null };

const cancelBestEffort = target => {
  try {
    const pending = target && typeof target.cancel === "function" ? target.cancel() : null;
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {}
};

const cancelBody = response => {
  if (response && response.body) cancelBestEffort(response.body);
};

const boundedTokenJson = async (response, signal) => {
  if (!response || !response.body || typeof response.body.getReader !== "function") return null;
  const declaredRaw = response.headers && response.headers.get("content-length");
  let declared = null;
  if (declaredRaw !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declaredRaw)) { cancelBody(response); return null; }
    declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared > TOKEN_JSON_BODY_LIMIT) { cancelBody(response); return null; }
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(TOKEN_JSON_BODY_LIMIT);
  let size = 0;
  let aborted = !!(signal && signal.aborted);
  const onAbort = () => {
    aborted = true;
    cancelBestEffort(reader);
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (aborted) { cancelBestEffort(reader); return null; }
    while (true) {
      const part = await reader.read();
      if (!part || part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > TOKEN_JSON_BODY_LIMIT - size) {
        cancelBestEffort(reader);
        return null;
      }
      bytes.set(part.value, size);
      size += part.value.byteLength;
    }
    if (aborted || (declared !== null && declared !== size)) return null;
    return bytes.subarray(0, size);
  } catch {
    cancelBestEffort(reader);
    return null;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
};

/**
 * The site's token.json.
 *   { ok: true, address, pons, uniswap }   read, address may be null
 *   { ok: false }                          could not be read; the caller says so and answers nothing else
 * The cache is memory only and never outlives a minute, so a launch is visible within a minute of the edit.
 */
export async function readToken(env = {}, now = Date.now()) {
  const url = configuredHttps(env, "TOKEN_JSON_URL", TOKEN_JSON);
  if (!url) return { ok: false };
  if (tokenCache.value && tokenCache.url === url && now - tokenCache.at < TOKEN_TTL_MS) return tokenCache.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_JSON_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": "lintcha-chain-api", accept: "application/json" },
      cf: { cacheTtl: 0 },
      signal: controller.signal
    });
    if (controller.signal.aborted) { cancelBody(r); return { ok: false }; }
    if (!r.ok) { cancelBody(r); return { ok: false }; }
    const bytes = await boundedTokenJson(r, controller.signal);
    if (controller.signal.aborted) return { ok: false };
    const config = tokenConfigBytesOf(bytes);
    if (!config) return { ok: false };
    const value = { ok: true, ...config };
    tokenCache = { at: now, value, url };
    return value;
  } catch {
    return { ok: false };                        // a failed read is not a token that does not exist
  } finally {
    clearTimeout(timer);
  }
}

/** Only for tests: drop the memory cache so a case can set up its own answer. */
export function forgetToken() { tokenCache = { at: 0, value: null, url: null }; }

/** true when the bot has an address to work with at all */
export const hasToken = token => !!(token && token.ok && token.address);

// Deployment-only venue override. Unlike token.json it is one address rather than an activation document.
const ZERO_ADDRESS = "0x" + "0".repeat(40);
const configuredHttps = (env, key, fallback) => Object.prototype.hasOwnProperty.call(env || {}, key)
  ? requiredHttpsUrlOf(env[key])
  : requiredHttpsUrlOf(fallback);
const normal = value => {
  if (typeof value !== "string") return null;
  const address = value.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(address) && address !== ZERO_ADDRESS ? address : null;
};

// ---------------------------------------------------------------- the gate, one per isolate
let gate = null;
let gateUrl = null;
let gateOverride = false;
export const CHAIN_TTL_MS = TOKEN_TTL_MS;
let chainCache = { at: 0, value: null, rpc: null };
let chainFlight = null;
let chainEpoch = 0;
let blockHashCache = new Map();
export function rpcGate(env = {}) {
  const url = configuredHttps(env, "RPC_URL", DEFAULT_RPC);
  if (!url) return null;
  if (!gate || (!gateOverride && gateUrl !== url)) {
    gate = new Gate({
      url,
      // More than the collector's proven concurrency is not a tuning value for this worker. An invalid
      // explicit value tightens to one request rather than opening the gate or wedging it on NaN.
      inFlight: integerSetting(env.RPC_IN_FLIGHT, DEFAULT_RPC_IN_FLIGHT, { min: 1, max: DEFAULT_RPC_IN_FLIGHT, invalid: 1 }),
      spacingMs: integerSetting(env.RPC_SPACING_MS, DEFAULT_RPC_SPACING_MS, { min: 0, max: MAX_RPC_SPACING_MS }),
      logsSpacingMs: integerSetting(env.RPC_LOGS_SPACING_MS, DEFAULT_RPC_LOGS_SPACING_MS, { min: 0, max: MAX_RPC_SPACING_MS }),
      maxRetries: BOT_RPC_MAX_RETRIES,
      log: () => {}
    });
    gateUrl = url;
    gateOverride = false;
  }
  return gate;
}
/** Only for tests: replace the gate with a stub, or drop it. */
export function setGate(g) { gate = g; gateUrl = null; gateOverride = !!g; forgetChain(); }
/** Only for tests: make the next protected read prove the endpoint's chain again. */
export function forgetChain() {
  chainCache = { at: 0, value: null, rpc: null };
  chainFlight = null;
  blockHashCache = new Map();
  chainEpoch++;
}
const call = (env, method, params) => {
  const client = rpcGate(env);
  return client ? client.call(method, params) : Promise.reject(new Error("invalid rpc url"));
};

/** A finalized log is a fact only when the header at its numbered block carries the same hash. */
async function blockHashOf(env, block, expectedHash) {
  if (!Number.isSafeInteger(block) || block < 0 || !rpcHash(expectedHash)) return null;
  const rpc = configuredHttps(env || {}, "RPC_URL", DEFAULT_RPC);
  if (!rpc) return null;
  const key = rpc + ":" + block;
  if (blockHashCache.has(key)) return blockHashCache.get(key) === expectedHash ? expectedHash : null;
  let header;
  try { header = await call(env, "eth_getBlockByNumber", [hexNum(block), false]); }
  catch { return null; }
  if (!header || typeof header !== "object" || Array.isArray(header) ||
      rpcQuantityNumber(header.number) !== block) return null;
  const hash = rpcHash(header.hash);
  // A mismatching response is not a proof and must not poison the cache after the endpoint recovers.
  if (!hash || hash !== expectedHash) return null;
  if (blockHashCache.size >= DEFAULT_MAX_TRANSFER_LOGS) {
    const oldest = blockHashCache.keys().next().value;
    blockHashCache.delete(oldest);
  }
  blockHashCache.set(key, hash);
  return hash;
}

// ---------------------------------------------------------------- reads
export async function chainId(env) {
  try {
    const value = await call(env, "eth_chainId", []);
    return typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) ? BigInt(value) : null;
  } catch { return null; }
}

/** The chain the collector reads, or null when the endpoint says something else. Guards every other read. */
export async function chainIsOurs(env, now = Date.now()) {
  const rpc = configuredHttps(env || {}, "RPC_URL", DEFAULT_RPC);
  if (!rpc) return false;
  if (chainCache.value !== null && chainCache.rpc === rpc && now - chainCache.at < CHAIN_TTL_MS) return chainCache.value;
  if (chainFlight && chainFlight.rpc === rpc) return chainFlight.promise;
  const epoch = chainEpoch;
  const flight = { rpc, promise: null };
  flight.promise = (async () => {
    const id = await chainId(env);
    const value = id !== null && id === CHAIN_ID;
    if (epoch === chainEpoch) chainCache = { at: now, value, rpc };
    return value;
  })();
  chainFlight = flight;
  try {
    return await flight.promise;
  } finally {
    if (epoch === chainEpoch && chainFlight === flight) chainFlight = null;
  }
}

export async function blockNumber(env) {
  if (!await chainIsOurs(env)) return null;
  try {
    const block = await call(env, "eth_getBlockByNumber", ["finalized", false]);
    return block && typeof block === "object" && !Array.isArray(block) ? rpcQuantityNumber(block.number) : null;
  } catch { return null; }
}

async function ethCall(env, to, data) {
  const address = normal(to);
  if (!address) return null;
  if (!await chainIsOurs(env)) return null;
  try {
    const r = await call(env, "eth_call", [{ to: address, data }, "latest"]);
    return typeof r === "string" && r.length > 2 ? r : null;
  } catch { return null; }
}

/** balanceOf, in the token's own base units, or null when the read failed. */
export async function balanceOf(env, token, holder) {
  const tokenAddress = normal(token), holderAddress = normal(holder);
  if (!tokenAddress || !holderAddress) return null;
  const r = await ethCall(env, tokenAddress, SEL.balanceOf + pad(holderAddress));
  return r === null || wordCount(r) !== 1 ? null : word(r, 0);
}

const decimalsCache = new Map();   // a token's decimals never change, so this one may outlive the minute
export async function decimalsOf(env, token) {
  const tokenAddress = normal(token);
  if (!tokenAddress) return null;
  if (decimalsCache.has(tokenAddress)) return decimalsCache.get(tokenAddress);
  const r = await ethCall(env, tokenAddress, SEL.decimals);
  if (r === null || wordCount(r) !== 1) return null;
  const value = word(r, 0);
  if (value === null) return null;
  const d = Number(value);
  if (!Number.isInteger(d) || d < 0 || d > MAX_TOKEN_DECIMALS) return null;
  decimalsCache.set(tokenAddress, d);
  return d;
}
/** Only for tests. */
export function forgetDecimals() { decimalsCache.clear(); }

export async function totalSupply(env, token) {
  const tokenAddress = normal(token);
  if (!tokenAddress) return null;
  const r = await ethCall(env, tokenAddress, SEL.totalSupply);
  return r === null || wordCount(r) !== 1 ? null : word(r, 0);
}

/** A base-unit chain value as whole units for six-significant-figure derived display, or null. */
export function unitsNumber(value, decimals) {
  if (typeof value !== "bigint" || value < 0n || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) return null;
  const base = Number(value);
  const scale = 10 ** decimals;
  const whole = base / scale;
  return Number.isFinite(base) && Number.isFinite(scale) && Number.isFinite(whole) ? whole : null;
}

/**
 * The factory's own record for a token. Fifteen static words, the layout written out in tools/launch/abi.mjs
 * as LAUNCHED_TOKEN. Only the four fields the bot uses are named here.
 */
export async function launchRecord(env, token) {
  const requested = normal(token);
  if (!requested) return null;
  const r = await ethCall(env, FACTORY, SEL.launched + pad(requested));
  if (r === null || wordCount(r) !== 15) return null;
  const recordToken = addressWord(r, 0);
  const curve = addressWord(r, 1);
  const deployer = addressWord(r, 2);
  const creatorFeeRecipient = addressWord(r, 3);
  const pairToken = addressWord(r, 4);
  const buybackEnabled = word(r, 9);
  const phase = word(r, 10);
  const exists = word(r, 14);
  if (!recordToken || recordToken !== requested || !curve || curve === ZERO_ADDRESS || !deployer || deployer === ZERO_ADDRESS ||
      !creatorFeeRecipient || !pairToken || phase === null ||
      (buybackEnabled !== 0n && buybackEnabled !== 1n) || (exists !== 0n && exists !== 1n)) return null;
  return {
    curve,
    deployer,
    pairToken,
    phase,
    exists: exists === 1n
  };
}

/**
 * Where buys and sells happen, as an address, or null.
 * A launch trades against its curve first. After graduation it trades in a pool whose address cannot be derived
 * from anything in this repository, so it comes from a setting; until that setting is filled the curve is used.
 * Both paths are readable and neither is guessed at.
 */
export async function venueOf(env, token) {
  if (!await chainIsOurs(env)) return null;
  const configuredValue = env && env.FEED_VENUE;
  if (configuredValue !== undefined && configuredValue !== null && configuredValue !== "") {
    // An explicit malformed override is a deployment error, not permission to silently read another venue.
    return normal(configuredValue);
  }
  const rec = await launchRecord(env, token);
  return rec && rec.exists ? rec.curve : null;
}

/**
 * Transfer logs of the token between two blocks, split into buys and sells by which side the venue is on.
 * A buy is the venue sending tokens to a wallet; a sell is a wallet sending them back. Nothing else counts,
 * so an ordinary wallet to wallet transfer is neither.
 */
export async function transfersAround(env, token, venue, fromBlock, toBlock, maxLogs = DEFAULT_MAX_TRANSFER_LOGS) {
  const tokenAddress = normal(token), venueAddress = normal(venue);
  if (!tokenAddress || !venueAddress || !Number.isSafeInteger(fromBlock) || fromBlock < 0 ||
      !Number.isSafeInteger(toBlock) || toBlock < fromBlock || !Number.isSafeInteger(maxLogs) || maxLogs < 1 ||
      maxLogs > DEFAULT_MAX_TRANSFER_LOGS || !await chainIsOurs(env)) return null;
  const range = { address: tokenAddress, fromBlock: hexNum(fromBlock), toBlock: hexNum(toBlock) };
  let logs;
  try {
    logs = await call(env, "eth_getLogs", [{ ...range, topics: [TOPIC_TRANSFER] }]);
  } catch { return null; }
  if (!Array.isArray(logs)) return null;
  if (logs.length > maxLogs) return TRANSFER_LOGS_OVERFLOW;
  const buys = [], sells = [];
  const positions = new Set();
  const pageBlockHashes = new Map();
  const factBlockHashes = new Map();
  let previousBlock = null, previousLogIndex = null;
  for (const l of logs) {
    if (!l || typeof l !== "object" || Array.isArray(l) || rpcAddress(l.address) !== tokenAddress || l.removed !== false ||
        !Array.isArray(l.topics) || l.topics.length !== 3 || typeof l.topics[0] !== "string" ||
        l.topics[0].toLowerCase() !== TOPIC_TRANSFER.toLowerCase()) return null;
    const from = topicAddress(l.topics[1]);
    const to = topicAddress(l.topics[2]);
    const amount = wordCount(l.data) === 1 ? word(l.data, 0) : null;
    const block = rpcQuantityNumber(l.blockNumber);
    const logIndex = rpcQuantityNumber(l.logIndex);
    const tx = rpcHash(l.transactionHash);
    const blockHash = rpcHash(l.blockHash);
    if (!from || !to || amount === null || block === null || block < fromBlock || block > toBlock || logIndex === null || !tx || !blockHash) return null;
    if (previousBlock !== null && (block < previousBlock || (block === previousBlock && logIndex <= previousLogIndex))) return null;
    previousBlock = block;
    previousLogIndex = logIndex;
    const position = block + ":" + logIndex;
    if (positions.has(position)) return null;
    positions.add(position);
    const knownBlockHash = pageBlockHashes.get(block);
    if (knownBlockHash && knownBlockHash !== blockHash) return null;
    pageBlockHashes.set(block, blockHash);
    // ERC-20 mint and burn logs are structurally valid Transfers but have no buyer or seller wallet.
    if (from === ZERO_ADDRESS || to === ZERO_ADDRESS) continue;
    const entry = {
      wallet: from === venueAddress ? to : from,
      amount,
      block,
      tx,
      blockHash,
      logIndex
    };
    if (from === venueAddress && to !== venueAddress) {
      buys.push(entry);
      factBlockHashes.set(block, blockHash);
    } else if (to === venueAddress && from !== venueAddress) {
      sells.push(entry);
      factBlockHashes.set(block, blockHash);
    }
  }
  if (factBlockHashes.size > MAX_TRANSFER_HEADER_BLOCKS) return TRANSFER_LOGS_OVERFLOW;
  for (const [block, expectedHash] of factBlockHashes) {
    if (await blockHashOf(env, block, expectedHash) !== expectedHash) return null;
  }
  return { buys, sells };
}

/**
 * The price of one whole token in whole units of the pair token, with the pair token that names those units,
 * or null.
 * Read from a Uniswap-v3-shaped venue's slot0. VENUE_KIND says which shape the venue is; there is exactly one
 * shape implemented, and any other value means the price is not readable and the bot says so.
 */
export async function priceInPair(env, venue, token) {
  if ((env.VENUE_KIND || "") !== "v3") return null;
  const venueAddress = normal(venue), tokenAddress = normal(token);
  if (!venueAddress || !tokenAddress) return null;

  // Orientation and both decimal scales are chain facts. Deployment values cannot stand in for any of them:
  // a pool must name the launch token on exactly one side, and the other side names the unit in the reply.
  const token0Word = await ethCall(env, venueAddress, SEL.token0);
  const token1Word = await ethCall(env, venueAddress, SEL.token1);
  const token0 = token0Word !== null && wordCount(token0Word) === 1 ? addressWord(token0Word, 0) : null;
  const token1 = token1Word !== null && wordCount(token1Word) === 1 ? addressWord(token1Word, 0) : null;
  const zero = "0x" + "0".repeat(40);
  if (!token0 || !token1 || token0 === zero || token1 === zero || token0 === token1) return null;
  const tokenIsFirst = token0 === tokenAddress ? true : token1 === tokenAddress ? false : null;
  if (tokenIsFirst === null) return null;
  const pairToken = tokenIsFirst ? token1 : token0;
  const tokenDecimals = await decimalsOf(env, tokenAddress);
  const pairDecimals = await decimalsOf(env, pairToken);
  if (tokenDecimals === null || pairDecimals === null) return null;

  const r = await ethCall(env, venueAddress, SEL.slot0);
  const words = r === null ? null : wordCount(r);
  // v3 slot0 is exactly seven static words. Validate every word's ABI width even though only sqrtPriceX96 is
  // used, so a plausible prefix from another contract cannot be interpreted as this pool shape.
  if (words !== 7) return null;
  const sqrtPriceX96 = word(r, 0);
  const tick = word(r, 1);
  const observationIndex = word(r, 2);
  const observationCardinality = word(r, 3);
  const observationCardinalityNext = word(r, 4);
  const feeProtocol = word(r, 5);
  const unlocked = word(r, 6);
  const two256 = 1n << 256n;
  const signed24 = tick !== null && (tick < (1n << 23n) || tick >= two256 - (1n << 23n));
  if (sqrtPriceX96 === null || sqrtPriceX96 === 0n || sqrtPriceX96 >= (1n << 160n) || !signed24 ||
      observationIndex === null || observationIndex >= (1n << 16n) ||
      observationCardinality === null || observationCardinality >= (1n << 16n) ||
      observationCardinalityNext === null || observationCardinalityNext >= (1n << 16n) ||
      feeProtocol === null || feeProtocol >= (1n << 8n) ||
      (unlocked !== 0n && unlocked !== 1n)) return null;
  // price of token0 in token1 is (sqrtPriceX96 / 2^96)^2, then shifted by the two token's decimals
  const q = Number(sqrtPriceX96) / 2 ** 96;
  const raw = q * q;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const shift = 10 ** (tokenDecimals - pairDecimals);
  // raw is token1 base units per token0 base unit. Whichever side the launch token occupies, converting one
  // whole launch token into whole pair tokens uses 10^(launch decimals - pair decimals). Only the raw pool
  // ratio is inverted when the launch token is token1; inverting the decimal shift as well changes the unit.
  const price = (tokenIsFirst ? raw : 1 / raw) * shift;
  return Number.isFinite(price) && price > 0 ? { value: price, pairToken } : null;
}

/** The limiter's own counters, for /stats. Never invented: straight off the Gate. */
export function gateStats() {
  return gate ? { ...gate.stats } : null;
}

export { hex };
