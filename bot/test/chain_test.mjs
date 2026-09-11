// Reading the site and reading the chain, with no network. Specification section two: the address comes from
// the site, is cached in memory for no longer than a minute, and an unreadable site is not an absent token.
//
//   node test/chain_test.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readToken, forgetToken, forgetDecimals, hasToken, setGate, rpcGate, balanceOf, decimalsOf, symbolOf, totalSupply, unitsNumber, launchRecord, venueOf, transfersAround, priceInPair, SEL, TOPIC_TRANSFER, CHAIN_ID, FACTORY, chainIsOurs, blockNumber, DEFAULT_RPC_IN_FLIGHT, DEFAULT_RPC_SPACING_MS, DEFAULT_RPC_LOGS_SPACING_MS, BOT_RPC_MAX_RETRIES, BOT_RPC_RESPONSE_BODY_LIMIT, MAX_RPC_SPACING_MS, DEFAULT_MAX_TRANSFER_LOGS, MAX_TRANSFER_HEADER_BLOCKS, TRANSFER_LOGS_OVERFLOW, TOKEN_JSON_BODY_LIMIT, TOKEN_JSON_TIMEOUT_MS } from "../src/chain.js";
import { harness, fakeGate, fakeGateFn, fakeNetwork, wordHex, stringReturn, topicAddr, launchRecordHex, TOKEN_ADDRESS, VENUE_ADDRESS, WALLET_ADDRESS, FIXTURE } from "./fakes.mjs";

const t = harness("chain");
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, "..", "..");
const botRpcBytes = fs.readFileSync(path.join(repository, "bot", "src", "rpc.js"));
const sourceRpcBytes = fs.readFileSync(path.join(repository, "tools", "launch", "rpc.mjs"));
const vendorText = fs.readFileSync(path.join(repository, "VENDOR.md"), "utf8");
const vendorRpc = /^\| `tools\/launch\/rpc\.mjs` \| [^|]+ \| `([0-9a-f]{64})` \|/m.exec(vendorText);
t.ok(botRpcBytes.equals(sourceRpcBytes), "the worker RPC gate is byte-identical to its checked-in source copy");
t.ok(vendorRpc && vendorRpc[1] === crypto.createHash("sha256").update(sourceRpcBytes).digest("hex"), "the shared RPC gate bytes match their exact VENDOR digest");
const net = fakeNetwork();
const OUR_CHAIN = "0x" + CHAIN_ID.toString(16);
const onOurs = table => fakeGate({ eth_chainId: OUR_CHAIN, ...table });
const txHash = digit => "0x" + String(digit).repeat(64);
const addressHex = address => wordHex(BigInt(address));
const recordWord = (record, index, value) => {
  const body = record.slice(2);
  const replacement = BigInt(value).toString(16).padStart(64, "0");
  return "0x" + body.slice(0, index * 64) + replacement + body.slice((index + 1) * 64);
};
const slot0Hex = (sqrtPriceX96, words = {}) => [
  sqrtPriceX96,
  words.tick === undefined ? 0n : words.tick,
  words.observationIndex === undefined ? 0n : words.observationIndex,
  words.observationCardinality === undefined ? 1n : words.observationCardinality,
  words.observationCardinalityNext === undefined ? 1n : words.observationCardinalityNext,
  words.feeProtocol === undefined ? 0n : words.feeProtocol,
  words.unlocked === undefined ? 1n : words.unlocked
].map(value => wordHex(value).slice(2)).join("");
const v3Gate = ({
  token0 = TOKEN_ADDRESS,
  token1 = WALLET_ADDRESS,
  tokenDecimals = 18,
  pairDecimals = 18,
  slot0 = "0x" + slot0Hex(2n ** 96n)
} = {}) => fakeGateFn(async (method, params) => {
  if (method === "eth_chainId") return OUR_CHAIN;
  if (method !== "eth_call") return new Error("unexpected " + method);
  const call = params[0];
  if (call.to === VENUE_ADDRESS && call.data === SEL.token0) return token0 instanceof Error ? token0 : addressHex(token0);
  if (call.to === VENUE_ADDRESS && call.data === SEL.token1) return token1 instanceof Error ? token1 : addressHex(token1);
  if (call.to === TOKEN_ADDRESS && call.data === SEL.decimals) return tokenDecimals instanceof Error ? tokenDecimals : wordHex(tokenDecimals);
  const pair = token0 === TOKEN_ADDRESS ? token1 : token0;
  if (call.to === pair && call.data === SEL.decimals) return pairDecimals instanceof Error ? pairDecimals : wordHex(pairDecimals);
  if (call.to === VENUE_ADDRESS && call.data === SEL.slot0) return slot0;
  return new Error("unexpected eth_call");
});
const transferLog = ({ from, to, amount, block, tx, logIndex, address = TOKEN_ADDRESS, signature = TOPIC_TRANSFER, blockHash = txHash("d") }) => ({
  address,
  removed: false,
  topics: [signature, topicAddr(from), topicAddr(to)],
  data: wordHex(amount),
  blockNumber: "0x" + Number(block).toString(16),
  transactionHash: tx,
  blockHash,
  logIndex: "0x" + Number(logIndex).toString(16)
});
const transferGate = (logs, headerFor = null) => fakeGateFn(async (method, params) => {
  if (method === "eth_chainId") return OUR_CHAIN;
  if (method === "eth_getLogs") return logs;
  if (method === "eth_getBlockByNumber") {
    const block = Number(BigInt(params[0]));
    const source = Array.isArray(logs) ? logs.find(log => log && Number(BigInt(log.blockNumber)) === block) : null;
    if (!source) return new Error("the test gave no header for " + params[0]);
    return headerFor ? headerFor(block, source) : { number: params[0], hash: source.blockHash };
  }
  return new Error("unexpected " + method);
});

// ---------------------------------------------------------------- the address is the site's, not the bot's
forgetToken();
net.site = { address: null, pons: null, uniswap: null };
let tok = await readToken({});
t.ok(tok.ok === true && tok.address === null, "three null read as a file that exists with no address");
t.ok(hasToken(tok) === false, "and nothing depending on an address may run");

forgetToken();
net.site = { address: TOKEN_ADDRESS.toUpperCase(), pons: "https://example.invalid/pons", uniswap: null };
tok = await readToken({});
t.ok(tok.address === TOKEN_ADDRESS, "an address is lowered");
t.ok(tok.pons === "https://example.invalid/pons", "the primary HTTPS link survives the shared config contract");
t.ok(tok.uniswap === null, "an explicit null secondary link reads as none at all");
t.ok(hasToken(tok) === true, "and now the address commands may run");

forgetToken();
let unsafeFetches = 0;
const networkBeforeUnsafeUrl = globalThis.fetch;
globalThis.fetch = async () => { unsafeFetches++; return new Response("{}", { status: 200 }); };
try { tok = await readToken({ TOKEN_JSON_URL: "http://config.invalid/token.json" }); }
finally { globalThis.fetch = networkBeforeUnsafeUrl; }
t.ok(tok.ok === false && unsafeFetches === 0, "an explicit non-HTTPS activation URL fails before any request and never falls back to the default");

const normalTokenFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const settlesInMicrotasks = async promise => {
  const outcome = { settled: false, value: null };
  promise.then(value => { outcome.settled = true; outcome.value = value; }, () => { outcome.settled = true; });
  for (let i = 0; i < 12 && !outcome.settled; i++) await Promise.resolve();
  return outcome;
};
let declaredCancelled = false;
globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode("{}")); },
  cancel() { declaredCancelled = true; return new Promise(() => {}); }
}), { status: 200, headers: { "content-length": String(TOKEN_JSON_BODY_LIMIT + 1) } });
globalThis.setTimeout = () => 1;
globalThis.clearTimeout = () => {};
forgetToken();
const declaredOutcome = await settlesInMicrotasks(readToken({}));
globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
t.ok(declaredOutcome.settled && declaredOutcome.value.ok === false && declaredCancelled,
  "a declared oversized token document returns without awaiting body cancellation");

let streamedCancelled = false;
globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(TOKEN_JSON_BODY_LIMIT + 1)); },
  cancel() { streamedCancelled = true; return new Promise(() => {}); }
}), { status: 200 });
globalThis.setTimeout = () => 2;
globalThis.clearTimeout = () => {};
forgetToken();
const streamedOutcome = await settlesInMicrotasks(readToken({}));
globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
t.ok(streamedOutcome.settled && streamedOutcome.value.ok === false && streamedCancelled,
  "a chunked token document returns fail-closed even when reader cancellation never settles");

const validTokenBytes = new TextEncoder().encode(JSON.stringify({ address: TOKEN_ADDRESS, pons: null, uniswap: null }));
globalThis.fetch = async () => new Response(validTokenBytes, {
  status: 200,
  headers: { "content-length": String(validTokenBytes.byteLength + 1), "content-type": "application/json" }
});
forgetToken();
tok = await readToken({});
t.ok(tok.ok === false, "a truncated body cannot pass by being valid JSON shorter than its declared response");

let refusedCancelled = false;
globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new TextEncoder().encode("unavailable")); },
  cancel() { refusedCancelled = true; return new Promise(() => {}); }
}), { status: 503 });
globalThis.setTimeout = () => 3;
globalThis.clearTimeout = () => {};
forgetToken();
const refusedOutcome = await settlesInMicrotasks(readToken({}));
globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;
t.ok(refusedOutcome.settled && refusedOutcome.value.ok === false && refusedCancelled,
  "a non-success response returns fail-closed without awaiting body cancellation");

let bodyDeadline = null;
let bodyTimedOutAfter = null;
let bodyReadStarted = false;
let hangingBodyCancelled = false;
globalThis.setTimeout = (fn, ms) => { bodyDeadline = fn; bodyTimedOutAfter = ms; return 4; };
globalThis.clearTimeout = () => {};
globalThis.fetch = async () => new Response(new ReadableStream({
  pull() { bodyReadStarted = true; return new Promise(() => {}); },
  cancel() { hangingBodyCancelled = true; return new Promise(() => {}); }
}));
let hangingBodyToken;
try {
  forgetToken();
  const pending = readToken({});
  for (let i = 0; i < 12 && !bodyReadStarted; i++) await Promise.resolve();
  bodyDeadline();
  hangingBodyToken = await pending;
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.fetch = normalTokenFetch;
}
t.ok(hangingBodyToken.ok === false && bodyReadStarted && hangingBodyCancelled && bodyTimedOutAfter === TOKEN_JSON_TIMEOUT_MS,
  "a hanging activation response body is cancelled at the authored deadline without awaiting its cancel promise");

let timedOutAfter = null;
let fetchAborted = false;
globalThis.setTimeout = (fn, ms) => { timedOutAfter = ms; queueMicrotask(fn); return 1; };
globalThis.clearTimeout = () => {};
globalThis.fetch = async (_url, options) => await new Promise((_resolve, reject) => {
  options.signal.addEventListener("abort", () => { fetchAborted = true; reject(new Error("aborted")); }, { once: true });
});
try {
  forgetToken();
  tok = await readToken({});
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.fetch = normalTokenFetch;
}
t.ok(tok.ok === false && fetchAborted && timedOutAfter === TOKEN_JSON_TIMEOUT_MS,
  "a hanging activation fetch is aborted at the authored timeout and cannot occupy a beat forever");

const unsafeRpcGate = onOurs({});
setGate(unsafeRpcGate);
t.ok(await chainIsOurs({ RPC_URL: "http://rpc.invalid" }) === false && unsafeRpcGate.stats.calls === 0,
  "an explicit non-HTTPS RPC URL proves no chain and is never contacted");

forgetToken();
net.site = { address: "not an address", pons: null, uniswap: null };
tok = await readToken({});
t.ok(tok.ok === false && tok.address === undefined, "a malformed activation document is unreadable rather than an absent token");
for (const site of [
  { address: TOKEN_ADDRESS, pons: null, uniswap: null },
  { address: TOKEN_ADDRESS, pons: "javascript:alert(1)", uniswap: null },
  { address: TOKEN_ADDRESS, pons: " https://example.invalid/pons", uniswap: null },
  { address: "0x" + "0".repeat(40), pons: "https://example.invalid/pons", uniswap: null },
  { address: null, pons: "https://example.invalid/pons", uniswap: null }
]) {
  forgetToken(); net.site = site;
  t.ok((await readToken({})).ok === false, "an ambiguous or unsafe token state closes the bot's activation read");
}

forgetToken();
net.siteOk = false;
tok = await readToken({});
t.ok(tok.ok === false, "an unreadable site says so");
t.ok(tok.address === undefined || tok.address === null, "and offers no address at all");
net.siteOk = true;

// ---------------------------------------------------------------- the memory cache, and its ceiling
forgetToken();
net.site = { address: TOKEN_ADDRESS, pons: "https://example.invalid/pons", uniswap: null };
await readToken({}, 1000);
net.site = { address: null, pons: null, uniswap: null };
t.ok((await readToken({}, 1000 + 59000)).address === TOKEN_ADDRESS, "the answer is still cached at fifty-nine seconds");
t.ok((await readToken({}, 1000 + 60001)).address === null, "and read again once a minute has gone by");

// a failed read does not poison the cache with a stale address
forgetToken();
net.site = { address: TOKEN_ADDRESS, pons: "https://example.invalid/pons", uniswap: null };
await readToken({}, 5000);
net.siteOk = false;
t.ok((await readToken({}, 5000 + 90000)).ok === false, "after the cache expires a failed read reports the failure");
net.siteOk = true;

// ---------------------------------------------------------------- the chain the collector reads
const rightChain = fakeGate({ eth_chainId: "0x1237" });
setGate(rightChain);
t.ok(CHAIN_ID === 4663n, "the chain id is the one the collector has");
t.ok((await chainIsOurs({})) === true, "and 0x1237 is that chain");
t.ok((await chainIsOurs({})) === true && rightChain.stats.byMethod.eth_chainId === 1, "that proof is reused briefly rather than fetched before every word");
const endpointBound = fakeGate({ eth_chainId: "0x1237" });
setGate(endpointBound);
t.ok(await chainIsOurs({ RPC_URL: "https://rpc-a.example.invalid" }, 1000) === true, "an endpoint-specific proof is accepted");
t.ok(await chainIsOurs({ RPC_URL: "https://rpc-a.example.invalid" }, 2000) === true && endpointBound.stats.byMethod.eth_chainId === 1, "the same endpoint reuses its brief proof");
t.ok(await chainIsOurs({ RPC_URL: "https://rpc-b.example.invalid" }, 2001) === true && endpointBound.stats.byMethod.eth_chainId === 2, "another RPC URL must establish its own proof even inside that lifetime");
setGate(fakeGate({ eth_chainId: "0x1" }));
t.ok((await chainIsOurs({})) === false, "another chain is refused");

// A deployment typo cannot turn the vendored limiter into unbounded concurrency or poison its timers.
setGate(null);
let configuredGate = rpcGate({ RPC_IN_FLIGHT: "2", RPC_SPACING_MS: "600", RPC_LOGS_SPACING_MS: "1500" });
t.ok(configuredGate.inFlight === DEFAULT_RPC_IN_FLIGHT && configuredGate.spacingMs === DEFAULT_RPC_SPACING_MS && configuredGate.logsSpacingMs === DEFAULT_RPC_LOGS_SPACING_MS,
  "the collector's exact limiter settings survive strict parsing");
const sizingHash = "f".repeat(64), sizingQuantity = "0x" + "f".repeat(16);
const standardTransferLog = {
  address: "0x" + "f".repeat(40), blockHash: "0x" + sizingHash, blockNumber: sizingQuantity,
  data: "0x" + sizingHash, logIndex: sizingQuantity, removed: false,
  topics: ["0x" + sizingHash, "0x" + sizingHash, "0x" + sizingHash],
  transactionHash: "0x" + sizingHash, transactionIndex: sizingQuantity
};
const standardMaxPageBytes = new TextEncoder().encode(JSON.stringify({
  jsonrpc: "2.0", id: 1, result: Array.from({ length: DEFAULT_MAX_TRANSFER_LOGS }, () => standardTransferLog)
})).length;
t.ok(configuredGate.maxResponseBytes === BOT_RPC_RESPONSE_BODY_LIMIT &&
  (BOT_RPC_RESPONSE_BODY_LIMIT & (BOT_RPC_RESPONSE_BODY_LIMIT - 1)) === 0 &&
  standardMaxPageBytes * 2 <= BOT_RPC_RESPONSE_BODY_LIMIT && standardMaxPageBytes * 4 > BOT_RPC_RESPONSE_BODY_LIMIT,
  "the Worker gives the vendored reader the first power-of-two ceiling above twice one standard maximum-count Transfer page");
setGate(null);
configuredGate = rpcGate({ RPC_IN_FLIGHT: "Infinity", RPC_SPACING_MS: "NaN", RPC_LOGS_SPACING_MS: "-1" });
t.ok(configuredGate.inFlight === 1, "invalid explicit concurrency tightens to one request");
t.ok(configuredGate.spacingMs === DEFAULT_RPC_SPACING_MS && configuredGate.logsSpacingMs === DEFAULT_RPC_LOGS_SPACING_MS,
  "non-finite and negative spacing settings return to the finite collector defaults");
setGate(null);
configuredGate = rpcGate({ RPC_IN_FLIGHT: String(DEFAULT_RPC_IN_FLIGHT + 1) });
t.ok(configuredGate.inFlight === 1, "concurrency above the collector's named cap tightens instead of opening the gate");
setGate(null);
configuredGate = rpcGate({ RPC_SPACING_MS: String(MAX_RPC_SPACING_MS + 1), RPC_LOGS_SPACING_MS: String(MAX_RPC_SPACING_MS + 1) });
t.ok(configuredGate.spacingMs === DEFAULT_RPC_SPACING_MS && configuredGate.logsSpacingMs === DEFAULT_RPC_LOGS_SPACING_MS,
  "spacing beyond the vendored gate's longest bounded wait closes to the collector defaults");
const priorFetch = globalThis.fetch;
let limitedPhysicalFetches = 0;
globalThis.fetch = async () => {
  limitedPhysicalFetches++;
  return new Response(JSON.stringify({ error: { code: 429, message: "limited" } }), { status: 429 });
};
setGate(null);
configuredGate = rpcGate({ RPC_URL: "https://limited.example.invalid", RPC_SPACING_MS: "0", RPC_LOGS_SPACING_MS: "0" });
let limitedRejected = false;
try { await configuredGate.call("eth_chainId", []); } catch { limitedRejected = true; }
t.ok(BOT_RPC_MAX_RETRIES === 0 && configuredGate.maxRetries === 0 && limitedRejected && limitedPhysicalFetches === 1 && configuredGate.stats.retries === 0,
  "one logical bot RPC call spends one physical request even when the endpoint answers 429; the next durable beat owns the retry");
globalThis.fetch = priorFetch;

// ---------------------------------------------------------------- reads, and what a failed read gives back
forgetDecimals();
const invalidTargetGate = onOurs({});
setGate(invalidTargetGate);
const zeroAddress = "0x" + "0".repeat(40);
t.ok(await balanceOf({}, zeroAddress, FIXTURE.address) === null && await decimalsOf({}, zeroAddress) === null && await totalSupply({}, zeroAddress) === null,
  "a zero token address is refused before any chain read");
t.ok(await balanceOf({}, TOKEN_ADDRESS, zeroAddress) === null && invalidTargetGate.stats.calls === 0,
  "a zero holder is refused before any chain read");

forgetDecimals();
const defaultTags = [];
setGate(fakeGateFn(async (method, params) => {
  if (method === "eth_chainId") return OUR_CHAIN;
  if (method !== "eth_call") return new Error("unexpected " + method);
  defaultTags.push(params[1]);
  const data = params[0].data.slice(0, 10);
  if (data === SEL.decimals) return wordHex(18);
  if (data === SEL.symbol) return stringReturn("LINTCHA");
  if (data === SEL.totalSupply) return wordHex(1000000000n * 10n ** 18n);
  if (data === SEL.launched) return launchRecordHex({ curve: VENUE_ADDRESS });
  return new Error("unexpected eth_call");
}));
const defaultDecimals = await decimalsOf({}, TOKEN_ADDRESS);
const defaultSymbol = await symbolOf({}, TOKEN_ADDRESS);
const defaultSupply = await totalSupply({}, TOKEN_ADDRESS);
const defaultRecord = await launchRecord({}, TOKEN_ADDRESS);
t.ok(defaultDecimals === 18 && defaultSymbol === "LINTCHA" && defaultSupply === 1000000000n * 10n ** 18n && defaultRecord?.exists === true &&
  defaultTags.length === 4 && defaultTags.every(tag => tag === "latest"),
"the optional-state token and factory helpers retain latest as their exact default tag");

const invalidStateGate = onOurs({});
forgetDecimals();
setGate(invalidStateGate);
t.ok(await decimalsOf({}, TOKEN_ADDRESS, "finalized") === null && await symbolOf({}, TOKEN_ADDRESS, "finalized") === null &&
  await totalSupply({}, TOKEN_ADDRESS, "finalized") === null && await launchRecord({}, TOKEN_ADDRESS, "finalized") === null && invalidStateGate.stats.calls === 0,
  "the optional state accepts a canonical numeric tag or the existing latest default, never a moving alias");

setGate(onOurs({ ["eth_call:" + SEL.symbol]: stringReturn("LINTCHA") + "00".repeat(32) }));
t.ok(await symbolOf({}, TOKEN_ADDRESS) === null, "symbol refuses a decodable string with non-canonical trailing return words");

forgetDecimals();
setGate(onOurs({
  ["eth_call:" + SEL.balanceOf]: wordHex(7n * 10n ** 18n),
  ["eth_call:" + SEL.decimals]: wordHex(18),
  ["eth_call:" + SEL.totalSupply]: wordHex(1000000000n * 10n ** 18n),
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  eth_getBlockByNumber: { number: "0x1a" }
}));
t.ok((await balanceOf({}, TOKEN_ADDRESS, FIXTURE.address)) === 7n * 10n ** 18n, "a balance comes back as base units");
t.ok((await decimalsOf({}, TOKEN_ADDRESS)) === 18, "decimals come back as a number");
t.ok((await totalSupply({}, TOKEN_ADDRESS)) === 1000000000n * 10n ** 18n, "so does the supply");
t.ok(unitsNumber(12345n, 6) === 0.012345, "derived display keeps base units beyond formatUnits' four displayed fraction digits");
t.ok(unitsNumber(-1n, 18) === null && unitsNumber(1n, 37) === null, "invalid base units or decimal scales cannot enter a derived figure");
t.ok((await blockNumber({})) === 26, "and the finalized head block");
const rec = await launchRecord({}, TOKEN_ADDRESS);
t.ok(rec && rec.curve === VENUE_ADDRESS && rec.deployer === WALLET_ADDRESS && rec.pairToken === WALLET_ADDRESS && rec.exists === true,
  "the factory record gives the token-bound curve, deployer, pair and exists flag");
t.ok((await venueOf({}, TOKEN_ADDRESS)) === VENUE_ADDRESS, "so the venue is the curve when nothing is configured");
t.ok((await venueOf({ FEED_VENUE: VENUE_ADDRESS.replace("2", "5") }, TOKEN_ADDRESS)) === VENUE_ADDRESS.replace("2", "5"), "and a configured venue wins");
const validFactoryRecord = launchRecordHex({ curve: VENUE_ADDRESS });
const invalidVenueGate = onOurs({ ["eth_call:" + SEL.launched]: validFactoryRecord });
setGate(invalidVenueGate);
let invalidVenuesClose = true;
for (const value of ["not-an-address", " " + VENUE_ADDRESS, "0x" + "0".repeat(40), 1]) {
  if (await venueOf({ FEED_VENUE: value }, TOKEN_ADDRESS) !== null) invalidVenuesClose = false;
}
t.ok(invalidVenuesClose,
  "an explicit malformed, padded, zero or non-string venue cannot silently fall back to the factory curve");

setGate(onOurs({ ["eth_call:" + SEL.launched]: launchRecordHex({ token: FIXTURE.address, curve: VENUE_ADDRESS }) }));
t.ok(await launchRecord({}, TOKEN_ADDRESS) === null && await venueOf({}, TOKEN_ADDRESS) === null,
  "a canonical record for a different token cannot supply this token's venue");

let allMalformedRecordsClose = true;
const addressValues = [TOKEN_ADDRESS, VENUE_ADDRESS, WALLET_ADDRESS, "0x" + "0".repeat(40), WALLET_ADDRESS];
for (let i = 0; i < addressValues.length; i++) {
  setGate(onOurs({ ["eth_call:" + SEL.launched]: recordWord(validFactoryRecord, i, (1n << 160n) | BigInt(addressValues[i])) }));
  if (await launchRecord({}, TOKEN_ADDRESS) !== null) allMalformedRecordsClose = false;
}
t.ok(allMalformedRecordsClose, "high bits in any address word make the static factory record unreadable");

allMalformedRecordsClose = true;
for (const i of [1, 2]) {
  setGate(onOurs({ ["eth_call:" + SEL.launched]: recordWord(validFactoryRecord, i, 0n) }));
  if (await launchRecord({}, TOKEN_ADDRESS) !== null) allMalformedRecordsClose = false;
}
t.ok(allMalformedRecordsClose, "zero curve or deployer cannot manufacture a launch record");

setGate(onOurs({ ["eth_call:" + SEL.launched]: recordWord(validFactoryRecord, 4, 0n) }));
const nativeQuoteRecord = await launchRecord({}, TOKEN_ADDRESS);
t.ok(nativeQuoteRecord && nativeQuoteRecord.pairToken === zeroAddress && nativeQuoteRecord.curve === VENUE_ADDRESS && await venueOf({}, TOKEN_ADDRESS) === VENUE_ADDRESS,
  "a canonical zero pair token is retained as the native-quote marker while the readable curve remains the venue");
t.ok(await priceInPair({ VENUE_KIND: "v3" }, zeroAddress, TOKEN_ADDRESS) === null,
  "a native-quote marker is never treated as an ERC-20 pool address for price reads");

allMalformedRecordsClose = true;
for (const i of [9, 14]) {
  setGate(onOurs({ ["eth_call:" + SEL.launched]: recordWord(validFactoryRecord, i, 2n) }));
  if (await launchRecord({}, TOKEN_ADDRESS) !== null) allMalformedRecordsClose = false;
}
t.ok(allMalformedRecordsClose, "both factory boolean words must be canonical zero or one");

const invalidRequestedGate = onOurs({ ["eth_call:" + SEL.launched]: validFactoryRecord });
setGate(invalidRequestedGate);
t.ok(await launchRecord({}, "not-an-address") === null && !invalidRequestedGate.stats.byMethod.eth_call,
  "an invalid requested token is refused before a factory call");

forgetDecimals();
setGate(onOurs({
  ["eth_call:" + SEL.balanceOf]: new Error("down"),
  ["eth_call:" + SEL.decimals]: new Error("down"),
  ["eth_call:" + SEL.totalSupply]: new Error("down"),
  ["eth_call:" + SEL.launched]: new Error("down"),
  eth_getBlockByNumber: new Error("down")
}));
t.ok((await balanceOf({}, TOKEN_ADDRESS, FIXTURE.address)) === null, "a failed balance read is null, never zero");
t.ok((await decimalsOf({}, TOKEN_ADDRESS)) === null, "a failed decimals read is null");
t.ok((await totalSupply({}, TOKEN_ADDRESS)) === null, "a failed supply read is null");
t.ok((await launchRecord({}, TOKEN_ADDRESS)) === null, "a failed record read is null");
t.ok((await blockNumber({})) === null, "a failed head read is null");
t.ok((await venueOf({}, TOKEN_ADDRESS)) === null, "and then there is no venue rather than a guessed one");

// ---------------------------------------------------------------- buys and sells, by which side the venue is on
const validLogs = [
  transferLog({ from: VENUE_ADDRESS, to: WALLET_ADDRESS, amount: 5n, block: 16, tx: txHash("a"), logIndex: 0 }),
  transferLog({ from: WALLET_ADDRESS, to: VENUE_ADDRESS, amount: 2n, block: 17, tx: txHash("b"), logIndex: 1 }),
  transferLog({ from: WALLET_ADDRESS, to: FIXTURE.address, amount: 1n, block: 18, tx: txHash("c"), logIndex: 2 }),
  transferLog({ from: "0x" + "0".repeat(40), to: VENUE_ADDRESS, amount: 7n, block: 18, tx: txHash("d"), logIndex: 3 }),
  transferLog({ from: VENUE_ADDRESS, to: "0x" + "0".repeat(40), amount: 8n, block: 18, tx: txHash("e"), logIndex: 4 })
];
const validTransferGate = transferGate(validLogs);
setGate(validTransferGate);
const split = await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 16, 19);
t.ok(split.buys.length === 1, "the venue sending tokens out is one buy");
t.ok(split.buys[0].wallet === WALLET_ADDRESS && split.buys[0].amount === 5n, "with the wallet and the amount off the log");
t.ok(split.buys[0].tx === txHash("a") && split.buys[0].block === 16, "and the canonical transaction and block");
t.ok(split.sells.length === 1 && split.sells[0].amount === 2n, "the venue receiving is one sell");
t.ok(split.buys.length + split.sells.length === 2, "a structurally valid wallet to wallet transfer is neither");
t.ok(!split.buys.some(entry => /^0x0{40}$/.test(entry.wallet)) && !split.sells.some(entry => /^0x0{40}$/.test(entry.wallet)),
  "mint and burn Transfers are neither buys nor sells and never create a zero wallet");
t.ok(validTransferGate.stats.byMethod.eth_getBlockByNumber === 2,
  "each buy/sell block hash is bound to its numbered header while ignored transfers spend no header read");
const headerCallsBeforeCache = validTransferGate.stats.byMethod.eth_getBlockByNumber;
const cachedSplit = await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 16, 19);
t.ok(cachedSplit && validTransferGate.stats.byMethod.eth_getBlockByNumber === headerCallsBeforeCache,
  "finalized numbered-header proofs are cached only inside the current RPC epoch");

setGate(onOurs({ eth_getLogs: new Error("down") }));
t.ok((await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 1, 2)) === null, "a failed log read is null, not an empty round");

const malformedLogs = [
  { ...validLogs[0], topics: [TOPIC_TRANSFER] },
  { ...validLogs[0], blockNumber: "0x20" },
  { ...validLogs[0], address: VENUE_ADDRESS },
  { ...validLogs[0], topics: ["0x" + "f".repeat(64), ...validLogs[0].topics.slice(1)] },
  { ...validLogs[0], logIndex: "0x00" },
  { ...validLogs[0], transactionHash: txHash("0") },
  { ...validLogs[0], blockHash: undefined },
  { ...validLogs[0], blockHash: txHash("0") },
  { ...validLogs[0], blockHash: "0x01" }
];
const malformedReasons = [
  "malformed topics",
  "a block outside the requested range",
  "another contract address",
  "another event topic",
  "a noncanonical log quantity",
  "an all-zero transaction hash",
  "a missing block hash",
  "an all-zero block hash",
  "a short block hash"
];
for (let i = 0; i < malformedLogs.length; i++) {
  setGate(transferGate([validLogs[1], malformedLogs[i]]));
  t.ok(await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 16, 19) === null, malformedReasons[i] + " makes the whole log page unreadable");
}
setGate(transferGate([validLogs[1], validLogs[0]]));
t.ok(await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 16, 19) === null,
  "an out-of-order but otherwise canonical log page fails closed instead of changing event order");
const mixedForkLogs = [
  validLogs[0],
  { ...validLogs[0], transactionHash: txHash("f"), blockHash: txHash("e"), logIndex: "0x1" }
];
setGate(transferGate(mixedForkLogs));
t.ok(await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 16, 19) === null,
  "two canonical logs cannot mix different fork hashes for the same block");
setGate(transferGate([validLogs[0]], (block, source) => ({ number: "0x" + block.toString(16), hash: txHash("e") })));
t.ok(await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 16, 19) === null,
  "a log hash that disagrees with its numbered block header makes the whole page unreadable");
let repairingHeaderCalls = 0;
const repairingGate = transferGate([validLogs[0]], (block, source) => ({
  number: "0x" + block.toString(16),
  hash: ++repairingHeaderCalls === 1 ? txHash("e") : source.blockHash
}));
setGate(repairingGate);
const mismatchingRead = await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 16, 19);
const repairedRead = await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 16, 19);
t.ok(mismatchingRead === null && repairedRead && repairedRead.buys.length === 1 && repairingHeaderCalls === 2,
  "a transient mismatching header is not cached and a repaired endpoint can prove the same log on retry");
setGate(transferGate([validLogs[0]], () => new Error("header down")));
t.ok(await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 16, 19) === null,
  "an unreadable numbered header returns no transfer facts or prefix");
setGate(onOurs({ eth_getLogs: new Array(DEFAULT_MAX_TRANSFER_LOGS + 1).fill(validLogs[0]) }));
t.ok(await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 16, 19) === TRANSFER_LOGS_OVERFLOW,
  "a page above the exact transfer-log ceiling is rejected before any plausible prefix is parsed");
const sparseForkPage = Array.from({ length: MAX_TRANSFER_HEADER_BLOCKS + 1 }, (_, index) => transferLog({
  from: VENUE_ADDRESS,
  to: WALLET_ADDRESS,
  amount: 1n,
  block: 100 + index,
  tx: "0x" + BigInt(index + 1).toString(16).padStart(64, "0"),
  blockHash: "0x" + BigInt(index + 1000).toString(16).padStart(64, "0"),
  logIndex: 0
}));
const sparseForkGate = transferGate(sparseForkPage);
setGate(sparseForkGate);
t.ok(await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 100, 100 + MAX_TRANSFER_HEADER_BLOCKS) === TRANSFER_LOGS_OVERFLOW &&
  !sparseForkGate.stats.byMethod.eth_getBlockByNumber,
  "a sparse page above the numbered-header budget is split before any sequential header proof starts");

// A plausible answer from another chain is still no answer for this product.
forgetDecimals();
const wrongChain = fakeGate({
  eth_chainId: "0x1",
  ["eth_call:" + SEL.balanceOf]: wordHex(7n * 10n ** 18n),
  ["eth_call:" + SEL.decimals]: wordHex(18),
  ["eth_call:" + SEL.totalSupply]: wordHex(1000000000n * 10n ** 18n),
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  ["eth_call:" + SEL.token0]: addressHex(TOKEN_ADDRESS),
  ["eth_call:" + SEL.token1]: addressHex(WALLET_ADDRESS),
  ["eth_call:" + SEL.slot0]: wordHex(2n ** 96n),
  eth_getBlockByNumber: { number: "0x64" },
  eth_getLogs: validLogs
});
setGate(wrongChain);
t.ok(await balanceOf({}, TOKEN_ADDRESS, FIXTURE.address) === null, "a plausible balance from the wrong chain is refused");
t.ok(await priceInPair({ VENUE_KIND: "v3" }, VENUE_ADDRESS, TOKEN_ADDRESS) === null, "a plausible pool from the wrong chain is refused");
t.ok(await blockNumber({}) === null && await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 16, 19) === null, "head and logs are also closed by the same chain proof");
t.ok(!wrongChain.stats.byMethod.eth_call && !wrongChain.stats.byMethod.eth_getLogs, "no fact call is made after the chain id mismatch");

// A fixed ABI value is one complete word. Short data is not padded with invented zero bytes.
forgetDecimals();
setGate(onOurs({
  ["eth_call:" + SEL.balanceOf]: "0x01",
  ["eth_call:" + SEL.decimals]: "0x12",
  ["eth_call:" + SEL.totalSupply]: "0x01",
  ["eth_call:" + SEL.launched]: "0x" + "00".repeat(14 * 32 + 1),
  ["eth_call:" + SEL.token0]: "0x01",
  ["eth_call:" + SEL.token1]: addressHex(WALLET_ADDRESS),
  ["eth_call:" + SEL.slot0]: "0x01"
}));
t.ok(await balanceOf({}, TOKEN_ADDRESS, FIXTURE.address) === null, "a short balance word is unreadable instead of zero-filled");
t.ok(await decimalsOf({}, TOKEN_ADDRESS) === null && await totalSupply({}, TOKEN_ADDRESS) === null, "short decimals and supply words are unreadable");
t.ok(await launchRecord({}, TOKEN_ADDRESS) === null, "a short fixed factory record is unreadable");
t.ok(await priceInPair({ VENUE_KIND: "v3" }, VENUE_ADDRESS, TOKEN_ADDRESS) === null, "a short pool address word cannot become a plausible price");

// ---------------------------------------------------------------- the price, which is only read from a shape it knows
setGate(v3Gate());
t.ok((await priceInPair({}, VENUE_ADDRESS, TOKEN_ADDRESS)) === null, "with no venue kind set there is no price");
forgetDecimals();
setGate(v3Gate());
let quote = await priceInPair({ VENUE_KIND: "v3" }, VENUE_ADDRESS, TOKEN_ADDRESS);
t.ok(quote && quote.value === 1 && quote.pairToken === WALLET_ADDRESS,
  "a square root price of one becomes one only with both pool sides and decimals read from the chain");

forgetDecimals();
setGate(v3Gate({ tokenDecimals: 18, pairDecimals: 6, slot0: "0x" + slot0Hex(2n ** 97n) }));
quote = await priceInPair({ VENUE_KIND: "v3", PAIR_DECIMALS: "NaN", TOKEN_IS_FIRST: "wrong" }, VENUE_ADDRESS, TOKEN_ADDRESS);
t.ok(quote && quote.value === 4000000000000 && quote.pairToken === WALLET_ADDRESS,
  "when the launch token is token0, four pair base units per token base unit scale to whole 18-to-6 units");
forgetDecimals();
setGate(v3Gate({ token0: WALLET_ADDRESS, token1: TOKEN_ADDRESS, tokenDecimals: 18, pairDecimals: 6, slot0: "0x" + slot0Hex(2n ** 97n) }));
quote = await priceInPair({ VENUE_KIND: "v3", PAIR_DECIMALS: "0", TOKEN_IS_FIRST: "true" }, VENUE_ADDRESS, TOKEN_ADDRESS);
t.ok(quote && quote.value === 250000000000 && quote.pairToken === WALLET_ADDRESS,
  "when the launch token is token1, only the raw ratio is inverted and the same 18-to-6 unit shift remains");
t.ok(quote && quote.value !== 1 / 4000000000000, "manual orientation and decimal settings cannot invert or rescale that chain-derived quote");

for (const topology of [
  { token0: WALLET_ADDRESS, token1: FIXTURE.address },
  { token0: TOKEN_ADDRESS, token1: TOKEN_ADDRESS },
  { token0: new Error("down"), token1: WALLET_ADDRESS }
]) {
  forgetDecimals(); setGate(v3Gate(topology));
  t.ok(await priceInPair({ VENUE_KIND: "v3" }, VENUE_ADDRESS, TOKEN_ADDRESS) === null,
    "an unreadable, duplicate or launch-token-free pool topology fails closed");
}

forgetDecimals(); setGate(v3Gate({ pairDecimals: new Error("down") }));
t.ok(await priceInPair({ VENUE_KIND: "v3" }, VENUE_ADDRESS, TOKEN_ADDRESS) === null,
  "unreadable paired-token decimals cannot be replaced by a deployment value");

const malformedSlots = [
  "0x" + slot0Hex(2n ** 96n).slice(0, 64),
  "0x" + slot0Hex(2n ** 96n) + wordHex(0).slice(2),
  "0x" + slot0Hex(1n << 160n),
  "0x" + slot0Hex(2n ** 96n, { tick: 1n << 23n }),
  "0x" + slot0Hex(2n ** 96n, { observationIndex: 1n << 16n }),
  "0x" + slot0Hex(2n ** 96n, { unlocked: 2n })
];
for (const slot0 of malformedSlots) {
  forgetDecimals(); setGate(v3Gate({ slot0 }));
  t.ok(await priceInPair({ VENUE_KIND: "v3" }, VENUE_ADDRESS, TOKEN_ADDRESS) === null,
    "a non-v3 slot0 length or field width cannot become a plausible price");
}
forgetDecimals(); setGate(v3Gate({ slot0: "0x" + slot0Hex(0n) }));
t.ok(await priceInPair({ VENUE_KIND: "v3" }, VENUE_ADDRESS, TOKEN_ADDRESS) === null, "a zero from the pool is not a price of zero");
forgetDecimals(); setGate(v3Gate({ slot0: new Error("down") }));
t.ok(await priceInPair({ VENUE_KIND: "v3" }, VENUE_ADDRESS, TOKEN_ADDRESS) === null, "and a failed slot0 read is not a price either");

// ---------------------------------------------------------------- the factory is the one the collector names
t.ok(FACTORY === "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", "the factory address is the collector's");

t.done();
