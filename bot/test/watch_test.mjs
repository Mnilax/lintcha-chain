// The watcher, on a fake context with no runtime and no network.
//
// The three things this file exists to hold down, all of them from specification section sixteen:
//
//   no alarm while there is no endpoint. Not a short one, not a retrying one: none. There is nothing readable,
//   so there is nothing to schedule, and the cron is what tries again.
//   something older than the tail's depth goes only after the published snapshot covers its block. Age alone
//   cannot prove coverage, because a delayed snapshot must not let pruning make the public suffix partial.
//   a rule fires for a holder with a live session and stays quiet for one whose session has lapsed.
//
// Plus the ones that would be quiet failures: a launch that will not read does not get written half read and
// does not get stepped over on the first try, and a launch already in the tail is not stored or announced
// twice.
//
//   node test/watch_test.mjs
import { Watch, SEL_TOKEN, forgetPublished, DEFAULT_INTERVAL_MS, DEFAULT_WATCHDOG_MS, DEFAULT_MAX_BLOCKS, DEFAULT_MAX_LAUNCHES, DEFAULT_DEPTH_DAYS, DEFAULT_TAIL_CACHE_MS, DEFAULT_INDEX_TTL_MS, MAX_PUBLISHED_FILE_BYTES, PUBLISHED_RESPONSE_TIMEOUT_MS, DEFAULT_CHAIN_PROOF_TTL_MS, DEFAULT_RULES_TOTAL, MAX_RULES_TOTAL, DEFAULT_RULE_DELIVERY_TOTAL, MAX_RULE_DELIVERY_TOTAL, DEFAULT_RULE_DELIVERY_BATCH, MAX_RULE_DELIVERY_BATCH, DEFAULT_TELEGRAM_COMMANDS_PER_WINDOW, MAX_TELEGRAM_COMMANDS_PER_WINDOW, DEFAULT_TELEGRAM_COMMAND_WINDOW_MS, MAX_TELEGRAM_COMMAND_WINDOW_MS, RULE_DELIVERY_RETENTION_MS, READ_ATTEMPTS } from "../src/watch.js";
import { setGate } from "../src/chain.js";
import { rifleOf } from "../src/rules.js";
import { digest, normalize } from "../src/engine.js";
import { watcherStateText } from "../src/texts.js";
import { harness, fakeWatchCtx, fakeChain, fakePublished, emptyPublishedIndex, manifestFor, launchedReturn, OWNER_A, OWNER_B, WALLET_ADDRESS, STAND_BOT_TOKEN } from "./fakes.mjs";

const t = harness("watch");

const DEV_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEV_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOLDER = "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";
const DAY = 86400;
const NOW_SECONDS = 1780000000;
const NOW = NOW_SECONDS * 1000;
const BLOCK_HASH = "0x" + "b".repeat(64);
const OTHER_BLOCK_HASH = "0x" + "e".repeat(64);
const quantity = value => "0x" + BigInt(value).toString(16);
const abiWord = value => BigInt(value).toString(16).padStart(64, "0");

const SELECTORS = { name: SEL_TOKEN.name, symbol: SEL_TOKEN.symbol, info: SEL_TOKEN.info };

const launch = (n, extra) => ({
  token: "0x" + String(n).padStart(2, "0").repeat(20),
  curve: "0x" + "2".repeat(40),
  deployer: DEV_A,
  pair: WALLET_ADDRESS,
  block: 600 + n,
  tx: "0x" + BigInt(n).toString(16).padStart(64, "0"),
  name: "Launch " + n,
  symbol: "TICK" + n,
  logo: "",
  description: "",
  socials: ["", "", "", "", ""],
  ...extra
});

const envOf = extra => ({ TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN, ...extra });
const sessions = map => ({
  async get(k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
  async put(k, v) { map[k] = String(v); },
  async delete(k) { delete map[k]; }
});

const roundWith = (config, env) => {
  const chain = fakeChain({ selectors: SELECTORS, ...config });
  setGate(chain.gate);
  const ctx = fakeWatchCtx();
  return { chain, ctx, watch: new Watch(ctx, envOf(env)) };
};

// ---------------------------------------------------------------- published files stay in one manifest generation
forgetPublished();
const generationHash = await digest(normalize.ticker("GENERATION"));
const generationA = emptyPublishedIndex();
generationA.ticker[generationHash] = { n: 2, d: 2, first: "2026-09-01" };
const generationB = emptyPublishedIndex();
generationB.ticker[generationHash] = { n: 3, d: 3, first: "2026-09-02" };
const boundaryA = { window: { from_block: 1, to_block: 700, blocks: 700 } };
const boundaryB = { window: { from_block: 1, to_block: 701, blocks: 701 } };
let net = fakePublished({ index: generationA, numbers: boundaryA });
const bundleWatch = new Watch(fakeWatchCtx(), envOf({ INDEX_TTL_MS: "100" }));
t.ok((await bundleWatch.index(NOW)).ticker[generationHash].n === 2, "the first index is read under its manifest generation");
t.ok((await bundleWatch.numbers(NOW + 25)).window.to_block === 700, "the first boundary can have a younger cache age than its index");
net.index = generationB;
net.numbers = boundaryB;
t.ok((await bundleWatch.index(NOW + 101)).ticker[generationHash].n === 3, "an expired manifest moves the index to the new generation");
t.ok((await bundleWatch.numbers(NOW + 101)).window.to_block === 701, "that manifest change invalidates a separately fresh old boundary");
t.ok(net.asked.filter(url => url.includes("launch-numbers.json")).length === 2, "the old boundary is fetched again instead of being mixed with the new index");

forgetPublished();
net = fakePublished({ index: {} });
const incompleteCorpus = new Watch(fakeWatchCtx(), envOf({}));
t.ok(await incompleteCorpus.index(NOW) === null, "an object without all published namespaces is not an empty corpus");

forgetPublished();
const askedBeforeUnsafeUrls = net.asked.length;
const unsafePublished = new Watch(fakeWatchCtx(), envOf({
  LAUNCH_MANIFEST_URL: "http://config.invalid/manifest.json",
  LAUNCH_INDEX_URL: "http://config.invalid/index.json",
  LAUNCH_NUMBERS_URL: "http://config.invalid/numbers.json"
}));
t.ok((await Promise.all([unsafePublished.manifest(NOW), unsafePublished.index(NOW), unsafePublished.numbers(NOW)])).every(value => value === null) &&
  net.asked.length === askedBeforeUnsafeUrls,
  "explicit non-HTTPS corpus URLs fail closed before a request and never borrow a cached safe generation");

const oversizedResponse = (limit, observed) => {
  let emitted = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (emitted) return;
      emitted = true;
      observed.emitted += limit + 1;
      controller.enqueue(new Uint8Array(limit + 1));
    },
    cancel() { observed.cancelled = true; }
  }));
};
const fetchBeforeBoundedCorpus = globalThis.fetch;
try {
  forgetPublished();
  const manifestBody = { emitted: 0, cancelled: false };
  globalThis.fetch = async () => oversizedResponse(65536, manifestBody);
  t.ok(await new Watch(fakeWatchCtx(), envOf({})).manifest(NOW) === null && manifestBody.cancelled && manifestBody.emitted === 65537,
    "an oversized streaming manifest is cancelled at its byte ceiling instead of buffered in full");

  const boundedIndex = emptyPublishedIndex();
  const boundedNumbers = { window: { from_block: 1, to_block: 700, blocks: 700 } };
  const boundedManifest = manifestFor(boundedIndex, boundedNumbers);
  for (const kind of ["index", "numbers"]) {
    forgetPublished();
    const body = { emitted: 0, cancelled: false };
    globalThis.fetch = async url => {
      const address = String(url);
      if (address.includes("launch-manifest.json")) return new Response(JSON.stringify(boundedManifest));
      if (address.includes("launch-" + kind + ".json")) return oversizedResponse(boundedManifest[kind].bytes, body);
      return new Response("unreadable", { status: 500 });
    };
    const corpusWatch = new Watch(fakeWatchCtx(), envOf({}));
    t.ok(await corpusWatch[kind](NOW) === null && body.cancelled && body.emitted === boundedManifest[kind].bytes + 1,
      "an oversized streaming " + kind + " body is cancelled at the manifest's exact byte bound");
  }
  forgetPublished();
  const tooLargeManifest = {
    ...boundedManifest,
    index: { ...boundedManifest.index, bytes: MAX_PUBLISHED_FILE_BYTES + 1 }
  };
  let oversizedIndexAsked = false;
  globalThis.fetch = async url => {
    if (String(url).includes("launch-manifest.json")) return new Response(JSON.stringify(tooLargeManifest));
    oversizedIndexAsked = true;
    return new Response("{}");
  };
  t.ok(await new Watch(fakeWatchCtx(), envOf({})).index(NOW) === null && !oversizedIndexAsked,
    "a manifest-declared corpus beyond the owned memory ceiling is refused before its file is requested");
} finally {
  globalThis.fetch = fetchBeforeBoundedCorpus;
  forgetPublished();
}

const timeoutBeforePublished = globalThis.setTimeout;
const clearTimeoutBeforePublished = globalThis.clearTimeout;
let publishedDeadline = null;
let publishedDeadlineMs = null;
let publishedFetchAborted = false;
globalThis.setTimeout = (fn, ms) => {
  publishedDeadline = fn;
  publishedDeadlineMs = ms;
  return 1;
};
globalThis.clearTimeout = () => {};
globalThis.fetch = async (_url, options) => await new Promise((_resolve, reject) => {
  options.signal.addEventListener("abort", () => {
    publishedFetchAborted = true;
    reject(new Error("aborted"));
  }, { once: true });
});
let hangingManifest;
try {
  forgetPublished();
  const pending = new Watch(fakeWatchCtx(), envOf({})).manifest(NOW);
  await Promise.resolve();
  publishedDeadline();
  hangingManifest = await pending;
} finally {
  globalThis.fetch = fetchBeforeBoundedCorpus;
  globalThis.setTimeout = timeoutBeforePublished;
  globalThis.clearTimeout = clearTimeoutBeforePublished;
  forgetPublished();
}
t.ok(hangingManifest === null && publishedFetchAborted && publishedDeadlineMs === PUBLISHED_RESPONSE_TIMEOUT_MS,
  "a published fetch that never settles is aborted at the owned response deadline");

let publishedBodyCancelled = false;
publishedDeadline = null;
globalThis.setTimeout = fn => {
  publishedDeadline = fn;
  return 2;
};
globalThis.clearTimeout = () => {};
globalThis.fetch = async () => new Response(new ReadableStream({
  pull() { return new Promise(() => {}); },
  cancel() { publishedBodyCancelled = true; }
}));
let hangingManifestBody;
try {
  forgetPublished();
  const pending = new Watch(fakeWatchCtx(), envOf({})).manifest(NOW);
  await Promise.resolve();
  publishedDeadline();
  hangingManifestBody = await pending;
} finally {
  globalThis.fetch = fetchBeforeBoundedCorpus;
  globalThis.setTimeout = timeoutBeforePublished;
  globalThis.clearTimeout = clearTimeoutBeforePublished;
  forgetPublished();
}
t.ok(hangingManifestBody === null && publishedBodyCancelled,
  "a published response body that never settles is cancelled at the same deadline");

let refusedPublishedBodyCancelled = false;
let refusedPublishedSettled = false;
let refusedPublishedResult;
globalThis.setTimeout = () => 3;
globalThis.clearTimeout = () => {};
globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array([123])); },
  cancel() { refusedPublishedBodyCancelled = true; return new Promise(() => {}); }
}), { status: 503 });
try {
  forgetPublished();
  new Watch(fakeWatchCtx(), envOf({})).manifest(NOW).then(value => {
    refusedPublishedResult = value;
    refusedPublishedSettled = true;
  });
  for (let i = 0; i < 12 && !refusedPublishedSettled; i++) await Promise.resolve();
} finally {
  globalThis.fetch = fetchBeforeBoundedCorpus;
  globalThis.setTimeout = timeoutBeforePublished;
  globalThis.clearTimeout = clearTimeoutBeforePublished;
  forgetPublished();
}
t.ok(refusedPublishedSettled && refusedPublishedResult === null && refusedPublishedBodyCancelled,
  "a non-success published response returns without awaiting a cancellation promise that never settles");

let unboundedReaderCancelled = false;
let unboundedReaderSettled = false;
let unboundedReaderResult;
globalThis.setTimeout = () => 4;
globalThis.clearTimeout = () => {};
globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(65537)); },
  cancel() { unboundedReaderCancelled = true; return new Promise(() => {}); }
}));
try {
  forgetPublished();
  new Watch(fakeWatchCtx(), envOf({})).manifest(NOW).then(value => {
    unboundedReaderResult = value;
    unboundedReaderSettled = true;
  });
  for (let i = 0; i < 12 && !unboundedReaderSettled; i++) await Promise.resolve();
} finally {
  globalThis.fetch = fetchBeforeBoundedCorpus;
  globalThis.setTimeout = timeoutBeforePublished;
  globalThis.clearTimeout = clearTimeoutBeforePublished;
  forgetPublished();
}
t.ok(unboundedReaderSettled && unboundedReaderResult === null && unboundedReaderCancelled,
  "an oversized published stream returns fail-closed even when reader cancellation never settles");

const unsafeRpc = roundWith({ head: 700, launches: [] }, { RPC_URL: "http://rpc.invalid" });
t.ok((await unsafeRpc.watch.chainProof(NOW)).ok === false && unsafeRpc.chain.gate.stats.calls === 0,
  "an explicit non-HTTPS watcher RPC URL cannot reuse a proof or reach the endpoint");

// ---------------------------------------------------------------- block time is an exact, date-safe RPC fact
const afterDateRangeSeconds = Math.floor(8.64e15 / 1000) + 1;
let malformedTime = roundWith({
  head: 700,
  launches: [],
  blockResponses: {
    701: { number: quantity(700), hash: BLOCK_HASH, timestamp: quantity(NOW_SECONDS) },
    702: { number: quantity(702), hash: BLOCK_HASH, timestamp: "0x01" },
    703: { number: quantity(703), hash: BLOCK_HASH, timestamp: quantity(Number.MAX_SAFE_INTEGER) },
    704: { number: quantity(704), hash: BLOCK_HASH, timestamp: quantity(afterDateRangeSeconds) },
    705: null,
    707: { number: quantity(707), hash: OTHER_BLOCK_HASH, timestamp: quantity(NOW_SECONDS) },
    708: { number: quantity(708), hash: BLOCK_HASH, timestamp: quantity(NOW_SECONDS) }
  }
});
t.ok(await malformedTime.watch.timeOf(Number.MAX_SAFE_INTEGER + 1, BLOCK_HASH) === null, "an unsafe requested block is refused before BigInt conversion");
t.ok(await malformedTime.watch.timeOf(701, BLOCK_HASH) === null, "a response for another block is refused");
t.ok(await malformedTime.watch.timeOf(702, BLOCK_HASH) === null, "a non-canonical RPC timestamp quantity is refused");
t.ok(await malformedTime.watch.timeOf(703, BLOCK_HASH) === null, "an unsafe RPC timestamp quantity is refused");
t.ok(await malformedTime.watch.timeOf(704, BLOCK_HASH) === null, "a timestamp outside the Date range closes instead of throwing RangeError");
t.ok(await malformedTime.watch.timeOf(705, BLOCK_HASH) === null, "a missing block response is refused");
malformedTime.watch.set("ts:706:" + BLOCK_HASH, String(Number.MAX_SAFE_INTEGER));
t.ok(await malformedTime.watch.timeOf(706, BLOCK_HASH) === null, "an invalid remembered timestamp is not trusted or returned");
t.ok(await malformedTime.watch.timeOf(707, BLOCK_HASH) === null, "a header from another block hash cannot date the launch log");
t.ok(await malformedTime.watch.timeOf(708, BLOCK_HASH) === NOW_SECONDS && await malformedTime.watch.timeOf(708, OTHER_BLOCK_HASH) === null,
  "a remembered timestamp is bound to both its exact block number and hash");

const mismatchedHeader = roundWith({
  head: 700,
  launches: [launch(29, { block: 701, blockHash: BLOCK_HASH })],
  timestamps: { 701: NOW_SECONDS },
  blockResponses: { 701: { number: quantity(701), hash: OTHER_BLOCK_HASH, timestamp: quantity(NOW_SECONDS) } }
});
await mismatchedHeader.watch.tick(NOW);
mismatchedHeader.chain.head = 701;
const mismatchedHeaderRound = await mismatchedHeader.watch.tick(NOW + 12000);
t.ok(mismatchedHeaderRound.ran === false && mismatchedHeaderRound.why === "fields" && mismatchedHeader.ctx.tail.length === 0 && mismatchedHeader.watch.lastBlock() === 700,
  "a log and numbered header with different hashes store no launch and advance no cursor");

// ---------------------------------------------------------------- with no endpoint: no alarm at all
forgetPublished();
net = fakePublished({});
let { ctx, watch } = roundWith({ head: 700, launches: [], broken: { eth_chainId: new Error("endpoint down") } });
let r = await watch.tick(NOW);
t.ok(r.ran === false && r.why === "rpc", "a round with no endpoint is a round that did not run");
t.ok(r.scheduled === false, "and it says it scheduled nothing");
t.ok(ctx.storage.peekAlarm() === null, "and no alarm is set at all");

// an alarm left from a working round is cleared rather than left to fire into nothing
await ctx.storage.setAlarm(NOW + 1000);
await watch.tick(NOW);
t.ok(ctx.storage.peekAlarm() === null, "an alarm from before is cleared once the endpoint is gone");

// the cron is what tries again, and it runs a round itself rather than waiting out an interval
const woke = await watch.watchdog(NOW + 600000);
t.ok(woke.woke === true, "the cron wakes it");
t.ok(woke.ran === false && woke.why === "rpc", "and reports that the round still could not read");
t.ok(ctx.storage.peekAlarm() === null, "and still sets no alarm, because there is still nothing to read");

// a chain that answers with the wrong id is a different refusal, and also sets nothing
({ ctx, watch } = roundWith({ head: 700, launches: [], chainId: "0x1" }));
r = await watch.tick(NOW);
t.ok(r.why === "chain" && r.scheduled === false, "an endpoint on another chain is refused by name, and nothing is scheduled");

// A successful chain proof is brief and belongs only to the endpoint URL that produced it.
const proofStand = roundWith({ head: 700, launches: [] }, { RPC_URL: "https://rpc-a.example.invalid" });
r = await proofStand.watch.tick(NOW);
t.ok(r.ran === true && proofStand.chain.gate.stats.byMethod.eth_chainId === 1, "a working endpoint establishes one chain proof");
proofStand.chain.chainId = "0x1";
r = await proofStand.watch.tick(NOW + DEFAULT_CHAIN_PROOF_TTL_MS - 1);
t.ok(r.ran === true && proofStand.chain.gate.stats.byMethod.eth_chainId === 1, "the proof is reused only inside its bounded lifetime");
r = await proofStand.watch.tick(NOW + DEFAULT_CHAIN_PROOF_TTL_MS);
t.ok(r.ran === false && r.why === "chain" && proofStand.chain.gate.stats.byMethod.eth_chainId === 2, "at the boundary the endpoint is proved again and a changed chain fails closed");
proofStand.chain.chainId = "0x1237";
r = await proofStand.watch.tick(NOW + DEFAULT_CHAIN_PROOF_TTL_MS + 1);
t.ok(r.ran === true && proofStand.chain.gate.stats.byMethod.eth_chainId === 3, "a later correct proof can resume the watcher");
proofStand.chain.chainId = "0x1";
proofStand.watch.env.RPC_URL = "https://rpc-b.example.invalid";
r = await proofStand.watch.tick(NOW + DEFAULT_CHAIN_PROOF_TTL_MS + 2);
t.ok(r.ran === false && r.why === "chain" && proofStand.chain.gate.stats.byMethod.eth_chainId === 4, "changing the RPC URL invalidates even a fresh proof immediately");

// ---------------------------------------------------------------- the first round starts where it wakes up
forgetPublished();
net = fakePublished({});
let stand = roundWith({ head: 700, launches: [launch(1, { block: 650 })] });
r = await stand.watch.tick(NOW);
t.ok(r.first === true && r.to === 700, "the first round takes the head and replays no history");
t.ok(stand.chain.finalizedReads === 1, "the watcher follows the finalized block, not the reorgable tip");
t.ok(r.launches === 0, "so a launch below the head is not read at all: the tail begins here and says so");
t.ok(stand.ctx.storage.peekAlarm() === NOW + DEFAULT_INTERVAL_MS, "and the next round is one interval away");
t.ok(DEFAULT_INTERVAL_MS === 12000, "the interval starts at twelve seconds");
t.ok(DEFAULT_DEPTH_DAYS === 7, "and the pruning age floor starts at seven days");
t.ok(new Watch(fakeWatchCtx(), envOf({ WATCH_INTERVAL_MS: "3000", WATCH_DEPTH_DAYS: "2" })).intervalMs() === 3000, "both are settings, not constants");
t.ok(new Watch(fakeWatchCtx(), envOf({ WATCH_DEPTH_DAYS: "2" })).depthDays() === 2, "the depth too");
const invalidSettingsWatch = new Watch(fakeWatchCtx(), envOf({
  WATCH_INTERVAL_MS: "Infinity", WATCH_WATCHDOG_MS: "NaN", WATCH_MAX_BLOCKS: "-1",
  WATCH_DEPTH_DAYS: "1.5", TAIL_CACHE_MS: "Infinity", INDEX_TTL_MS: "-1"
}));
t.ok(invalidSettingsWatch.intervalMs() === DEFAULT_INTERVAL_MS && invalidSettingsWatch.watchdogMs() === DEFAULT_WATCHDOG_MS,
  "non-finite watcher timing settings return to finite defaults");
t.ok(invalidSettingsWatch.maxBlocks() === 1, "an invalid watcher range tightens to one block");
t.ok(invalidSettingsWatch.depthDays() === DEFAULT_DEPTH_DAYS, "a fractional retention age cannot leak into timestamp arithmetic");
t.ok(invalidSettingsWatch.tailCacheMs() === DEFAULT_TAIL_CACHE_MS && invalidSettingsWatch.indexTtlMs() === DEFAULT_INDEX_TTL_MS,
  "invalid cache lifetimes cannot disable caching or keep a published generation forever");
t.ok(new Watch(fakeWatchCtx(), envOf({ WATCH_MAX_BLOCKS: String(DEFAULT_MAX_BLOCKS + 1) })).maxBlocks() === 1,
  "a watcher range above the named maximum tightens to one block");
t.ok(new Watch(fakeWatchCtx(), envOf({ WATCH_INTERVAL_MS: String(DEFAULT_WATCHDOG_MS + 1), TAIL_CACHE_MS: String(DEFAULT_INDEX_TTL_MS + 1) })).intervalMs() === DEFAULT_INTERVAL_MS,
  "a watcher interval beyond its watchdog bound closes to the operating default");
t.ok(new Watch(fakeWatchCtx(), envOf({ TAIL_CACHE_MS: String(DEFAULT_INDEX_TTL_MS + 1) })).tailCacheMs() === DEFAULT_TAIL_CACHE_MS,
  "a tail cache window longer than the published-generation TTL closes to the short default");
const legacyDeliveryCtx = fakeWatchCtx({ legacyRuleDelivery: true });
new Watch(legacyDeliveryCtx, envOf());
new Watch(legacyDeliveryCtx, envOf());
t.ok(legacyDeliveryCtx.storage.sql.statements.filter(stmt => /^ALTER TABLE rule_delivery ADD COLUMN made/i.test(stmt)).length === 1,
  "an existing first-generation rule outbox gains its timestamp exactly once across object restarts");
t.ok(legacyDeliveryCtx.storage.sql.statements.filter(stmt => /^ALTER TABLE rule_delivery ADD COLUMN last_attempt/i.test(stmt)).length === 1,
  "the same outbox gains its fair-retry cursor exactly once across object restarts");
let releaseWatchFlight, enterWatchFlight;
const watchFlightEntered = new Promise(resolve => { enterWatchFlight = resolve; });
const watchFlightReleased = new Promise(resolve => { releaseWatchFlight = resolve; });
const singleFlightWatch = new Watch(fakeWatchCtx(), envOf({}));
let watchFlightCalls = 0;
singleFlightWatch.tickOnce = async () => {
  watchFlightCalls++;
  enterWatchFlight();
  await watchFlightReleased;
  return { ran: true, scheduled: true };
};
const admittedWatchFlight = singleFlightWatch.tick(NOW);
await watchFlightEntered;
const refusedWatchFlight = await singleFlightWatch.tick(NOW + 1);
releaseWatchFlight();
const completedWatchFlight = await admittedWatchFlight;
t.ok(completedWatchFlight.ran === true && refusedWatchFlight.ran === false && refusedWatchFlight.why === "in flight" && watchFlightCalls === 1,
  "interleaved watcher beats admit one complete range pass instead of duplicating it across an await");
const boundedWatch = new Watch(fakeWatchCtx(), envOf());
t.ok(boundedWatch.rulesTotalLimit() === DEFAULT_RULES_TOTAL && boundedWatch.ruleDeliveryBatch() === DEFAULT_RULE_DELIVERY_BATCH,
  "global rule storage and one retry scan both have finite named defaults");
t.ok(boundedWatch.maxLaunches() === DEFAULT_MAX_LAUNCHES && DEFAULT_MAX_LAUNCHES === 4 &&
  boundedWatch.ruleDeliveryTotalLimit() === DEFAULT_RULE_DELIVERY_TOTAL,
  "launch RPC work and pending private notifications have explicit finite product bounds");
t.ok(boundedWatch.telegramCommandsPerWindow() === DEFAULT_TELEGRAM_COMMANDS_PER_WINDOW && boundedWatch.telegramCommandWindowMs() === DEFAULT_TELEGRAM_COMMAND_WINDOW_MS,
  "the durable per-user command window has finite named defaults");
const invalidBoundedWatch = new Watch(fakeWatchCtx(), envOf({
  WATCH_MAX_LAUNCHES: "NaN", RULES_TOTAL: "NaN", RULE_DELIVERY_TOTAL: "NaN", RULE_DELIVERY_BATCH: "Infinity",
  TELEGRAM_COMMANDS_PER_WINDOW: "0", TELEGRAM_COMMAND_WINDOW_MS: "1e3"
}));
t.ok(invalidBoundedWatch.rulesTotalLimit() === 0, "an invalid explicit global rule cap fails new adds closed");
t.ok(invalidBoundedWatch.maxLaunches() === 1 && invalidBoundedWatch.ruleDeliveryTotalLimit() === 0,
  "invalid launch and delivery-cap settings tighten ingestion to one and stop new notification writes");
t.ok(invalidBoundedWatch.ruleDeliveryBatch() === DEFAULT_RULE_DELIVERY_BATCH && invalidBoundedWatch.telegramCommandsPerWindow() === DEFAULT_TELEGRAM_COMMANDS_PER_WINDOW && invalidBoundedWatch.telegramCommandWindowMs() === DEFAULT_TELEGRAM_COMMAND_WINDOW_MS,
  "invalid retry and command-window settings return to their bounded defaults");
const aboveBoundedWatch = new Watch(fakeWatchCtx(), envOf({
  WATCH_MAX_LAUNCHES: String(DEFAULT_MAX_LAUNCHES + 1), RULES_TOTAL: String(MAX_RULES_TOTAL + 1),
  RULE_DELIVERY_TOTAL: String(MAX_RULE_DELIVERY_TOTAL + 1), RULE_DELIVERY_BATCH: String(MAX_RULE_DELIVERY_BATCH + 1),
  TELEGRAM_COMMANDS_PER_WINDOW: String(MAX_TELEGRAM_COMMANDS_PER_WINDOW + 1), TELEGRAM_COMMAND_WINDOW_MS: String(MAX_TELEGRAM_COMMAND_WINDOW_MS + 1)
}));
t.ok(aboveBoundedWatch.rulesTotalLimit() === 0 && aboveBoundedWatch.ruleDeliveryBatch() === DEFAULT_RULE_DELIVERY_BATCH,
  "values above the hard global and retry caps cannot widen either boundary");
t.ok(aboveBoundedWatch.maxLaunches() === 1 && aboveBoundedWatch.ruleDeliveryTotalLimit() === 0,
  "values above the launch and pending-delivery ceilings fail ingestion closed");
t.ok(aboveBoundedWatch.telegramCommandsPerWindow() === DEFAULT_TELEGRAM_COMMANDS_PER_WINDOW && aboveBoundedWatch.telegramCommandWindowMs() === DEFAULT_TELEGRAM_COMMAND_WINDOW_MS,
  "values above the hard command count and TTL caps return to bounded defaults");

// ---------------------------------------------------------------- a launch is read, stored, and stored once
forgetPublished();
net = fakePublished({});
stand = roundWith({
  head: 700,
  launches: [launch(1, { block: 701, symbol: "SOLANA", name: "Solana Dog", socials: ["@bob", "", "", "", ""] })],
  timestamps: { 701: NOW_SECONDS }
});
await stand.watch.tick(NOW);
stand.chain.head = 702;
r = await stand.watch.tick(NOW + 12000);
t.ok(r.stored === 1, "the launch is stored");
t.ok(r.launches === 1 && r.unreadable === 0, "one launch, all of it readable");
t.ok(stand.ctx.tail.length === 1, "one row in the tail");
t.ok(stand.ctx.tail[0].deployer === DEV_A, "and the object keeps the deployer, which the tail never hands out");
t.ok(stand.ctx.tailHash.some(h => h.ns === "ticker"), "and a hash per namespace it could read");
t.ok(stand.ctx.tailHash.some(h => h.ns === "link"), "including the link it carried");
t.ok(!stand.ctx.tailHash.some(h => h.ns === "logo"), "and none for the fields it did not carry");
t.ok(stand.watch.get("attempts:701") === null && stand.watch.get("ts:701:" + BLOCK_HASH) === null,
  "a committed range retires its retry and per-block timestamp cache keys instead of leaking one row per range");

const storedRow = JSON.parse(stand.ctx.tail[0].row);
t.ok(storedRow.hashes.ticker === await digest(normalize.ticker("SOLANA")), "the stored ticker hash is the engine's hash of the engine's normalized ticker");
t.ok(!/0x[0-9a-fA-F]{40}/.test(stand.ctx.tail[0].row), "the row itself carries no address");

// the same block range read again stores nothing and says so
stand.watch.set("last_block", 700);
r = await stand.watch.tick(NOW + 24000);
t.ok(r.launches === 1 && r.stored === 0, "a launch already in the tail is read and not stored again");
t.ok(stand.ctx.tail.length === 1, "and there is still one row");

// ---------------------------------------------------------------- a launch that will not read
forgetPublished();
net = fakePublished({ numbers: { window: { from_block: 1, to_block: 700, blocks: 700 } } });
const stubborn = launch(3, { block: 701 });
stand = roundWith({ head: 700, launches: [stubborn], timestamps: { 701: NOW_SECONDS }, broken: { ["token:" + stubborn.token]: new Error("no answer") } });
await stand.watch.tick(NOW);
stand.chain.head = 702;
const before = stand.watch.lastBlock();
r = await stand.watch.tick(NOW + 12000);
t.ok(r.ran === false && r.why === "fields", "a launch that will not read fails the round");
t.ok(stand.watch.get("attempts:701") === "1" && stand.watch.get("ts:701:" + BLOCK_HASH) === String(NOW_SECONDS),
  "an uncommitted retry keeps exactly the attempt and timestamp proof it still needs");
t.ok(stand.watch.lastBlock() === before, "the cursor does not step over it");
t.ok(r.scheduled === true, "and the next round is still scheduled, because the endpoint itself answered");
t.ok(stand.ctx.tail.length === 0, "nothing is written half read");
for (let i = 2; i <= READ_ATTEMPTS; i++) r = await stand.watch.tick(NOW + 12000 * i);
t.ok(r.ran === true && r.unreadable === 1, "after a few tries it is counted as unreadable and the tail moves on");
t.ok(stand.watch.lastBlock() === 702, "because a token that never answers cannot be allowed to stop the tail for good");
t.ok(stand.watch.get("attempts:701") === null && stand.watch.get("ts:701:" + BLOCK_HASH) === null,
  "the final skipped-read commit also retires those range-local keys");
t.ok(READ_ATTEMPTS === 3, "and the number of tries is a named constant, not a magic three");
const tailAfterSkip = await stand.watch.tail(NOW + 12000 * (READ_ATTEMPTS + 1));
t.ok(tailAfterSkip.from_block === 702 && tailAfterSkip.to_block === 702, "the public tail starts only after the unreadable block instead of claiming to cover it");
t.ok(tailAfterSkip.launches_in_tail === 0 && tailAfterSkip.gap_blocks === 1, "an empty suffix exposes the skipped block as a gap rather than as a successful zero-launch range");

// A malformed log cannot be assigned an invented position: ordering is part of the public wall contract.
forgetPublished();
net = fakePublished({});
const unpositioned = launch(30, { block: 701, omitLogIndex: true });
stand = roundWith({ head: 700, launches: [unpositioned], timestamps: { 701: NOW_SECONDS } });
await stand.watch.tick(NOW);
stand.chain.head = 701;
const beforeMalformedLog = stand.watch.lastBlock();
r = await stand.watch.tick(NOW + 12000);
t.ok(r.ran === false && r.why === "logs", "a factory log without a log index fails the round instead of borrowing zero");
t.ok(stand.watch.lastBlock() === beforeMalformedLog && stand.ctx.tail.length === 0, "the cursor does not step over the malformed log");

// The RPC filter is not trusted as validation: one malformed event poisons a page even beside a valid prefix.
const validEvent = launch(31, { block: 701, logIndex: 0 });
const eventFailures = [
  ["another contract address", { eventAddress: "0x" + "9".repeat(40) }],
  ["a removed/reorg log", { removed: true }],
  ["a non-zero-padded indexed address", { tokenTopic: "0x" + "1".repeat(24) + launch(32).token.slice(2) }],
  ["a noncanonical event data tuple", { eventData: "0x" }],
  ["a zero token address", { tokenTopic: "0x" + "0".repeat(64) }],
  ["a zero curve address", { curveTopic: "0x" + "0".repeat(64) }],
  ["a zero deployer address", { deployerTopic: "0x" + "0".repeat(64) }],
  ["a zero transaction hash", { tx: "0x" + "0".repeat(64) }],
  ["a missing block hash", { blockHash: null }],
  ["a zero block hash", { blockHash: "0x" + "0".repeat(64) }],
  ["a short block hash", { blockHash: "0x01" }]
];
for (let i = 0; i < eventFailures.length; i++) {
  const [reason, bad] = eventFailures[i];
  const malformed = launch(32 + i, { block: 701, logIndex: 1, ...bad });
  const eventStand = roundWith({ head: 701, launches: [validEvent, malformed], timestamps: { 701: NOW_SECONDS } });
  t.ok(await eventStand.watch.launchesIn(701, 701) === null, reason + " makes the whole launch-log page unreadable");
}
const nativeQuote = launch(49, { block: 701, pairToken: "0x" + "0".repeat(40) });
const nativeStand = roundWith({ head: 700, launches: [nativeQuote], timestamps: { 701: NOW_SECONDS } });
await nativeStand.watch.tick(NOW);
nativeStand.chain.head = 701;
const nativeRound = await nativeStand.watch.tick(NOW + 12000);
t.ok(nativeRound.stored === 1 && nativeStand.ctx.tail.length === 1 && nativeStand.watch.get("wall_index_error_block") === null &&
  JSON.parse(nativeStand.ctx.tail[0].row).source.fingerprint.length === 64,
  "a canonical zero pair token is a valid native-quote launch and survives the strict durable identity path");
const repeatedToken = launch(50, { block: 701, logIndex: 0 });
const repeatedTokenStand = roundWith({
  head: 702,
  launches: [repeatedToken, { ...repeatedToken, block: 702, logIndex: 1 }],
  timestamps: { 701: NOW_SECONDS, 702: NOW_SECONDS }
});
t.ok(await repeatedTokenStand.watch.launchesIn(701, 702) === null,
  "one token at two factory positions poisons the whole range before any launch can be stored or notified");
const mixedBlockHashStand = roundWith({
  head: 701,
  launches: [launch(51, { block: 701, logIndex: 0, blockHash: BLOCK_HASH }), launch(52, { block: 701, logIndex: 1, blockHash: OTHER_BLOCK_HASH })],
  timestamps: { 701: NOW_SECONDS }
});
t.ok(await mixedBlockHashStand.watch.launchesIn(701, 701) === null,
  "one factory block cannot mix logs from two block hashes before header validation");

// A launch-log page is bounded by the cold-beat subrequest budget. Complete multi-block pages are bisected;
// a single block above the cap records the exact gap and consumes neither a launch nor the cursor.
const boundedLaunches = [launch(53, { block: 701, logIndex: 0 }), launch(54, { block: 702, logIndex: 0 })];
stand = roundWith({ head: 700, launches: boundedLaunches, timestamps: { 701: NOW_SECONDS, 702: NOW_SECONDS } }, { WATCH_MAX_LAUNCHES: "1" });
await stand.watch.tick(NOW);
stand.chain.head = 702;
const logReadsBeforeSplit = stand.chain.gate.stats.byMethod.eth_getLogs || 0;
r = await stand.watch.tick(NOW + 12000);
t.ok(r.ran === true && r.from === 701 && r.to === 701 && r.stored === 1 && stand.watch.lastBlock() === 701 &&
  stand.chain.gate.stats.byMethod.eth_getLogs - logReadsBeforeSplit === 2,
  "an overflowing multi-block launch page is bisected to one complete bounded prefix");
r = await stand.watch.tick(NOW + 24000);
t.ok(r.ran === true && r.to === 702 && r.stored === 1 && stand.watch.lastBlock() === 702,
  "the next beat resumes at the exact block after that bounded prefix");

const singleBlockOverflow = [launch(55, { block: 701, logIndex: 0 }), launch(56, { block: 701, logIndex: 1 })];
stand = roundWith({ head: 700, launches: singleBlockOverflow, timestamps: { 701: NOW_SECONDS } }, { WATCH_MAX_LAUNCHES: "1" });
await stand.watch.tick(NOW);
stand.chain.head = 701;
r = await stand.watch.tick(NOW + 12000);
t.ok(r.ran === false && r.why === "launch overflow" && stand.watch.lastBlock() === 700 &&
  stand.watch.get("launch_overflow_block") === "701" && stand.ctx.tail.length === 0 && stand.chain.reads === 0,
  "a one-block overflow leaves an explicit boundary and performs no per-launch reads or partial write");

// The vendored decoder is intentionally permissive; the owned layer accepts only an exact ABI round trip and
// then checks the token, curve, deployer and exists record against the event that selected it.
const strictBase = launch(40, { block: 701 });
const invalidUtf8 = "0x" + abiWord(32) + abiWord(1) + "c3" + "00".repeat(31);
const boolTwo = launchedReturn({ token: strictBase.token, curve: strictBase.curve, deployer: strictBase.deployer }).slice(0, -64) + abiWord(2);
const strictFailures = [
  ["truncated invalid UTF-8", { rawName: invalidUtf8 }],
  ["a truncated dynamic tuple", { rawInfo: "0x01" }],
  ["a noncanonical bool value of two", { rawLaunched: boolTwo }],
  ["a different factory-record token", { recordToken: "0x" + "8".repeat(40) }],
  ["a different factory-record curve", { recordCurve: "0x" + "7".repeat(40) }],
  ["a different factory-record deployer", { recordDeployer: "0x" + "6".repeat(40) }],
  ["a different factory-record pair token", { recordPairToken: "0x" + "4".repeat(40) }],
  ["a false factory-record exists flag", { recordExists: false }],
  ["a different token-info deployer", { infoDeployer: "0x" + "5".repeat(40) }]
];
for (const [reason, bad] of strictFailures) {
  const candidate = { ...strictBase, ...bad };
  const strictStand = roundWith({ head: 701, launches: [candidate], timestamps: { 701: NOW_SECONDS } });
  t.ok(await strictStand.watch.readLaunch(candidate) === null, reason + " is refused by the owned ABI boundary");
}

// ---------------------------------------------------------------- everything older than the depth is dropped
forgetPublished();
net = fakePublished({ numbers: { window: { from_block: 1, to_block: 701, blocks: 701 } } });
stand = roundWith({
  head: 700,
  launches: [launch(4, { block: 701 }), launch(5, { block: 702 })],
  timestamps: { 701: NOW_SECONDS - 8 * DAY, 702: NOW_SECONDS }
});
await stand.watch.tick(NOW);
stand.chain.head = 702;
r = await stand.watch.tick(NOW + 12000);
t.ok(r.stored === 2, "both launches are stored as they arrive");
t.ok(r.pruned === 1, "and the old launch already covered by the published snapshot is dropped in the same round");
t.ok(stand.ctx.tail.length === 1, "leaving one row");
t.ok(stand.ctx.tail[0].token === launch(5).token, "the recent one");
t.ok(stand.ctx.tailHash.every(h => h.token === launch(5).token), "and its hashes go with it, so a count cannot outlive its launch");

// ---------------------------------------------------------------- a rule fires for a live session and not for a lapsed one
forgetPublished();
const index = emptyPublishedIndex();
net = fakePublished({ index });
const store = { ["session:" + OWNER_A]: HOLDER };
stand = roundWith(
  { head: 700, launches: [launch(6, { block: 701, symbol: "SOLANA", deployer: DEV_B })], timestamps: { 701: NOW_SECONDS } },
  { SESSIONS: sessions(store), TX_URL_PREFIX: "https://example.invalid/tx/" }
);
stand.watch.rules.add(OWNER_A, "string", "SOLANA", await rifleOf("string", "SOLANA"), 1);
stand.watch.rules.add(OWNER_B, "string", "SOLANA", await rifleOf("string", "SOLANA"), 2);
stand.watch.rules.add(OWNER_A, "dev", DEV_A, await rifleOf("dev", DEV_A), 3);
await stand.watch.tick(NOW);
stand.chain.head = 702;
net.sent.length = 0;
r = await stand.watch.tick(NOW + 12000);
t.ok(r.fired === 0 && stand.ctx.deliveries.length === 2 && net.sent.length === 0, "fresh matches are durably queued without per-rule session I/O or bypassing the bounded delivery pass");
r = await stand.watch.tick(NOW + 24000);
t.ok(r.fired === 1, "one rule fired: the holder's string rule");
t.ok(net.sent.length === 1, "one message went out");
t.ok(String(net.sent[0].chat_id) === OWNER_A, "to the person whose rule it is");
t.ok(/Rule: string SOLANA/.test(net.sent[0].text), "and it names the rule");
t.ok(/Matched: the ticker/.test(net.sent[0].text), "and what matched");
t.ok(/Launches carrying it/.test(net.sent[0].text), "and how many launches carry it");
t.ok(/in the currently retained tail/.test(net.sent[0].text) && !/since I started reading/.test(net.sent[0].text), "the message names the scope the retained count actually covers");
t.ok(net.sent[0].text.includes(launch(6).token), "and names the launch");
t.ok(/example\.invalid\/tx\//.test(net.sent[0].text), "with a link to it when there is a prefix to build one from");
t.ok(!/good|bad|scam|safe|risk|score|likely/i.test(net.sent[0].text), "and says nothing about whether any of it is good or bad");
t.ok(stand.watch.rules.list(OWNER_A)[0].hits === 1, "the rule counts its hit");
t.ok(stand.watch.rules.list(OWNER_B)[0].hits === 0, "the other person's identical rule did not fire, because their session has lapsed");
t.ok(stand.watch.num("dormant_skips") === 1, "and that skip is counted rather than passed over in silence");

// the dev rule named the other deployer, so it stayed quiet
t.ok(stand.watch.rules.list(OWNER_A)[1].hits === 0, "a dev rule for another deployer did not fire");

// A rule id is a durable generation, not the current maximum plus one. An old check that resumes after
// /forget cannot bind its body or hit to a later rule, even when the wait happened inside the index read.
const abaCtx = fakeWatchCtx();
const abaWatch = new Watch(abaCtx, envOf({}));
const abaLaunch = launch(39, { block: 701, symbol: "OLDABA" });
const oldAbaRule = abaWatch.rules.add(OWNER_A, "string", "OLDABA", await rifleOf("string", "OLDABA"), 10);
let enterAbaIndex, releaseAbaIndex;
const abaIndexEntered = new Promise(resolve => { enterAbaIndex = resolve; });
const abaIndexReleased = new Promise(resolve => { releaseAbaIndex = resolve; });
abaWatch.index = async () => { enterAbaIndex(); await abaIndexReleased; return emptyPublishedIndex(); };
const oldAbaCheck = abaWatch.checkRules(abaLaunch, NOW);
await abaIndexEntered;
abaWatch.rules.removeAll(OWNER_A);
const newAbaRule = abaWatch.rules.add(OWNER_A, "dev", DEV_B, await rifleOf("dev", DEV_B), 11);
releaseAbaIndex();
await oldAbaCheck;
t.ok(newAbaRule.id > oldAbaRule.id && abaCtx.deliveries.length === 0 && abaWatch.rules.get(newAbaRule.id).hits === 0,
  "a forgotten in-flight rule never reuses its id, queues no stale body and cannot increment the replacement");

// A Telegram refusal leaves a durable private-rule line. The cursor may advance because the outbox, not an
// RPC replay, owns the retry; a sent ledger then makes an exact range replay idempotent.
forgetPublished();
net = fakePublished({ index: emptyPublishedIndex() });
stand = roundWith(
  { head: 700, launches: [launch(14, { block: 701, symbol: "RETRYME" })], timestamps: { 701: NOW_SECONDS } },
  { SESSIONS: sessions({ ["session:" + OWNER_A]: HOLDER }) }
);
stand.watch.rules.add(OWNER_A, "string", "RETRYME", await rifleOf("string", "RETRYME"), 1);
await stand.watch.tick(NOW);
stand.chain.head = 701;
net.telegramOk = false;
net.attempted.length = 0;
net.sent.length = 0;
r = await stand.watch.tick(NOW + 12000);
t.ok(r.ran === true && stand.watch.lastBlock() === 701, "a failed private notification is safe to move past only after its outbox row is durable");
t.ok(stand.ctx.deliveries.length === 1 && stand.ctx.deliveries[0].sent === 0, "the failed rule line remains pending");
t.ok(stand.watch.rules.list(OWNER_A)[0].hits === 0 && stand.watch.num("rules_fired") === 0, "a refused send is not counted as a rule hit");
t.ok(net.attempted.length === 0 && net.sent.length === 0, "the fresh path makes no Telegram attempt outside the bounded retry pass");
r = await stand.watch.tick(NOW + 24000);
t.ok(net.attempted.length === 1 && net.sent.length === 0 && stand.ctx.deliveries[0].sent === 0, "the next bounded pass records one refused Telegram attempt and keeps it pending");

net.telegramOk = true;
r = await stand.watch.tick(NOW + 36000);
t.ok(stand.ctx.deliveries.length === 0 && net.sent.length === 1 && net.attempted.length === 2,
  "the next beat accepts the line and retires its ledger once the durable cursor already covers the launch");
t.ok(stand.watch.rules.list(OWNER_A)[0].hits === 1 && stand.watch.num("rules_fired") === 1, "the rule hit is counted only after acceptance");
r = await stand.watch.tick(NOW + 48000);
t.ok(r.ran === true && net.sent.length === 1 && stand.watch.rules.list(OWNER_A)[0].hits === 1,
  "a later beat neither resends nor recounts an accepted rule line after its source cursor is committed");

// A full pending outbox pauses before any notification can be omitted. The first partial enqueue remains
// durable, the exact factory range replays after one drain, and the later matching rule is queued on replay.
forgetPublished();
net = fakePublished({ index: emptyPublishedIndex() });
stand = roundWith(
  { head: 700, launches: [launch(57, { block: 701, symbol: "CAPACITY" })], timestamps: { 701: NOW_SECONDS } },
  { SESSIONS: sessions({ ["session:" + OWNER_A]: HOLDER }), RULE_DELIVERY_TOTAL: "1", RULE_DELIVERY_BATCH: "1" }
);
stand.watch.rules.add(OWNER_A, "string", "CAPACITY", await rifleOf("string", "CAPACITY"), 1);
stand.watch.rules.add(OWNER_A, "string", "CAPACITY", await rifleOf("string", "CAPACITY"), 2);
await stand.watch.tick(NOW);
stand.chain.head = 701;
net.sent.length = 0;
r = await stand.watch.tick(NOW + 12000);
const cappedState = await stand.watch.state();
const cappedText = watcherStateText(cappedState);
t.ok(r.ran === false && r.why === "rule delivery backlog" && stand.watch.lastBlock() === 700 &&
  stand.ctx.deliveries.length === 1 && stand.ctx.deliveries[0].sent === 0,
  "capacity stops the uncommitted range with its first notification durable and no silent second drop");
t.ok(cappedState.ruleDeliveryBacklog === 1 && cappedState.ruleDeliveryCapacity === 1 && cappedState.ruleDeliveryBlockedAt === 701 &&
  /cursor is paused before block 701/.test(cappedText) && /uncommitted range will be read again/.test(cappedText),
  "/rules state exposes both the full backlog and the exact cursor boundary it is holding");
r = await stand.watch.tick(NOW + 24000);
t.ok(r.ran === true && stand.watch.lastBlock() === 701 && stand.ctx.deliveries.length === 1 &&
  stand.ctx.deliveries[0].sent === 0 && net.sent.length === 1 && stand.watch.get("rule_delivery_blocked_at") === null,
  "after one drain the exact replay skips the accepted rule, queues the remaining match, and commits its cursor");
r = await stand.watch.tick(NOW + 36000);
t.ok(net.sent.length === 2 && stand.ctx.deliveries.length === 0 &&
  stand.watch.rules.list(OWNER_A).every(rule => rule.hits === 1),
  "the second bounded drain accepts the replay-queued notification and leaves no lost match or stale ledger");

// A crash after the tail row but before rule enqueue leaves the cursor behind. That replay is safe only when
// every durable event/declaration field is identical; a provider cannot change metadata at the same position
// and make a rule observe a launch different from the one retained by the tail.
forgetPublished();
net = fakePublished({ index: emptyPublishedIndex() });
stand = roundWith(
  { head: 700, launches: [launch(30, { block: 701, symbol: "ORIGINAL" })], timestamps: { 701: NOW_SECONDS } },
  { SESSIONS: sessions({ ["session:" + OWNER_A]: HOLDER }) }
);
stand.watch.rules.add(OWNER_A, "string", "ALTERED", await rifleOf("string", "ALTERED"), 1);
await stand.watch.tick(NOW);
stand.chain.head = 701;
let recordedBeforeCrash = null;
const recordBeforeCrash = stand.watch.record.bind(stand.watch);
const checkBeforeCrash = stand.watch.checkRules.bind(stand.watch);
stand.watch.record = async observed => {
  recordedBeforeCrash = { ...observed, socials: [...observed.socials] };
  return await recordBeforeCrash(observed);
};
stand.watch.checkRules = async () => { throw new Error("stand-in crash after record"); };
let crashedAfterRecord = false;
try { await stand.watch.tick(NOW + 12000); } catch { crashedAfterRecord = true; }
stand.watch.record = recordBeforeCrash;
stand.watch.checkRules = checkBeforeCrash;
const durableBeforeReplay = stand.ctx.tail[0].row;
t.ok(crashedAfterRecord && stand.watch.lastBlock() === 700 && stand.ctx.deliveries.length === 0,
  "the crash fixture leaves one durable launch while its range and private outbox remain uncommitted");
const durableIdentity = JSON.parse(durableBeforeReplay).source;
t.ok(durableIdentity && durableIdentity.v === 1 && /^[0-9a-f]{64}$/.test(durableIdentity.fingerprint) && await stand.watch.recordedLaunchMatches(recordedBeforeCrash),
  "the retained row binds the exact full observation and accepts its literal replay");
const alteredReplays = [
  { ...recordedBeforeCrash, tx: "0x" + "f".repeat(64) },
  { ...recordedBeforeCrash, block_hash: "0x" + "e".repeat(64) },
  { ...recordedBeforeCrash, deployer: DEV_B },
  { ...recordedBeforeCrash, curve: "0x" + "3".repeat(40) },
  { ...recordedBeforeCrash, pair: "0x" + "4".repeat(40) },
  { ...recordedBeforeCrash, event_data: recordedBeforeCrash.event_data.slice(0, -1) + (recordedBeforeCrash.event_data.endsWith("0") ? "1" : "0") },
  { ...recordedBeforeCrash, symbol: "ALTERED" }
];
t.ok((await Promise.all(alteredReplays.map(observed => stand.watch.recordedLaunchMatches(observed)))).every(value => value === false),
  "tx, block hash, indexed addresses, event data, and decoded metadata are each part of replay identity");
stand.chain.launches[0].symbol = "ALTERED";
r = await stand.watch.tick(NOW + 24000);
t.ok(r.stored === 0 && stand.watch.lastBlock() === 701 && stand.watch.get("wall_index_error_block") === "701" &&
  stand.ctx.deliveries.length === 0 && stand.watch.rules.list(OWNER_A)[0].hits === 0 && stand.ctx.tail[0].row === durableBeforeReplay,
  "an altered same-position replay closes coverage and cannot notify from data that differs from the durable tail");

// A different token at an already durable factory position is also a conflict. It must be detected before the
// token-keyed tail insert, otherwise the second payload could drive a private rule despite an incomplete wall.
forgetPublished();
net = fakePublished({ index: emptyPublishedIndex() });
stand = roundWith(
  { head: 700, launches: [launch(31, { block: 701, symbol: "FIRSTPOSITION" })], timestamps: { 701: NOW_SECONDS } },
  { SESSIONS: sessions({ ["session:" + OWNER_A]: HOLDER }) }
);
await stand.watch.tick(NOW);
stand.chain.head = 701;
const firstPositionEvent = (await stand.watch.launchesIn(701, 701))[0];
const firstPositionFields = await stand.watch.readLaunch(firstPositionEvent);
const firstPositionTs = await stand.watch.timeOf(firstPositionEvent.block, firstPositionEvent.block_hash);
t.ok(await stand.watch.record({ ...firstPositionEvent, ...firstPositionFields, ts: firstPositionTs, date: new Date(firstPositionTs * 1000).toISOString().slice(0, 10) }) === true,
  "the position-conflict fixture leaves one complete durable launch before cursor commit");
stand.watch.rules.add(OWNER_A, "string", "SECONDPOSITION", await rifleOf("string", "SECONDPOSITION"), 1);
stand.chain.launches[0] = launch(32, { block: 701, symbol: "SECONDPOSITION", logIndex: 0 });
r = await stand.watch.tick(NOW + 12000);
t.ok(r.stored === 0 && stand.ctx.tail.length === 1 && stand.ctx.wallEvents.length === 1 &&
  stand.watch.get("wall_index_error_block") === "701" && stand.ctx.deliveries.length === 0 && stand.watch.rules.list(OWNER_A)[0].hits === 0,
  "a second token at the position adds no tail row and cannot enqueue or count a private notification");

// A refused line can outlive its pruned launch for retry safety, but not the maximum lifetime of the holder
// session that authorized it. Once that session is gone, the private message body is retired at the bound.
forgetPublished();
net = fakePublished({ index: emptyPublishedIndex(), numbers: { window: { from_block: 1, to_block: 701, blocks: 701 } } });
const expiryStore = { ["session:" + OWNER_A]: HOLDER };
const expiring = launch(15, { block: 701, symbol: "EXPIREME" });
stand = roundWith(
  { head: 700, launches: [expiring], timestamps: { 701: NOW_SECONDS - 8 * DAY } },
  { SESSIONS: sessions(expiryStore) }
);
stand.watch.rules.add(OWNER_A, "string", "EXPIREME", await rifleOf("string", "EXPIREME"), 1);
await stand.watch.tick(NOW);
stand.chain.head = 701;
net.telegramOk = false;
r = await stand.watch.tick(NOW + 12000);
t.ok(r.pruned === 1 && stand.ctx.tail.length === 0 && stand.ctx.deliveries.length === 1, "pruning a covered launch retains its pending private delivery for a retry");
t.ok(stand.ctx.deliveries[0].made === NOW + 12000, "the pending row durably records when its retention bound began");
await stand.watch.flushRuleDeliveries(NOW + 12001);
delete expiryStore["session:" + OWNER_A];
await stand.watch.flushRuleDeliveries(NOW + 12000 + RULE_DELIVERY_RETENTION_MS - 1);
t.ok(stand.ctx.deliveries.length === 1, "an absent session does not discard a still-young pending line");
await stand.watch.flushRuleDeliveries(NOW + 12000 + RULE_DELIVERY_RETENTION_MS);
t.ok(stand.ctx.deliveries.length === 0 && stand.watch.num("expired_rule_deliveries") === 1, "an expired session retires the private body at the bounded retention edge");
t.ok(net.attempted.length === 1 && stand.watch.rules.list(OWNER_A)[0].hits === 0, "expiry neither retries without access nor turns a refusal into a hit");

// A LIMIT bounds each retry scan, while last_attempt rotation keeps dormant rows at its front from starving
// later work for a live holder.
net = fakePublished({});
const fairCtx = fakeWatchCtx();
const fairWatch = new Watch(fairCtx, envOf({
  SESSIONS: sessions({ ["session:" + OWNER_A]: HOLDER }), RULE_DELIVERY_BATCH: "2"
}));
fairWatch.rules.add(OWNER_B, "string", "DORMANT1", await rifleOf("string", "DORMANT1"), 1);
fairWatch.rules.add(OWNER_B, "string", "DORMANT2", await rifleOf("string", "DORMANT2"), 2);
fairWatch.rules.add(OWNER_A, "string", "LIVE", await rifleOf("string", "LIVE"), 3);
for (const [i, owner] of [[1, OWNER_B], [2, OWNER_B], [3, OWNER_A]]) {
  fairCtx.deliveries.push({ rule_id: i, token: launch(20 + i).token, owner: String(owner), body: "delivery " + i, sent: 0, made: NOW, last_attempt: 0 });
}
let retried = await fairWatch.flushRuleDeliveries(NOW + 1);
t.ok(retried === 0 && fairCtx.deliveries.filter(delivery => delivery.last_attempt === NOW + 1).length === 2,
  "one retry pass inspects no more than its configured batch");
retried = await fairWatch.flushRuleDeliveries(NOW + 2);
t.ok(retried === 1 && net.sent.length === 1 && String(net.sent[0].chat_id) === OWNER_A,
  "the next bounded pass reaches a later live holder instead of rescanning only dormant rows");
t.ok(fairCtx.storage.sql.statements.some(stmt => /FROM rule_delivery[\s\S]*ORDER BY last_attempt[\s\S]*LIMIT \?/i.test(stmt)),
  "the storage query itself carries the LIMIT and fair retry order");

// ---------------------------------------------------------------- with no index to read, a shared rule stays quiet
forgetPublished();
net = fakePublished({ indexOk: false });
stand = roundWith(
  { head: 700, launches: [launch(7, { block: 701, symbol: "SOLANA" })], timestamps: { 701: NOW_SECONDS } },
  { SESSIONS: sessions({ ["session:" + OWNER_A]: HOLDER }) }
);
stand.watch.rules.add(OWNER_A, "shared", "2", await rifleOf("shared", "2"), 1);
await stand.watch.tick(NOW);
stand.chain.head = 702;
net.sent.length = 0;
r = await stand.watch.tick(NOW + 12000);
t.ok(r.fired === 0, "a shared rule does not fire on a count it could not read");
t.ok(net.sent.length === 0, "so nothing is sent");
t.ok(stand.watch.num("index_unread") >= 1, "and the unreadable index is counted");

// ---------------------------------------------------------------- a shared rule counts only the suffix after the published snapshot
forgetPublished();
const sharedHash = await digest(normalize.ticker("SOLANA"));
net = fakePublished({
  index: { ...emptyPublishedIndex(), ticker: { [sharedHash]: { n: 2, d: 2, first: "2026-09-01" } } },
  numbers: { window: { from_block: 1, to_block: 701, blocks: 701 } }
});
stand = roundWith(
  {
    head: 700,
    launches: [launch(8, { block: 701, symbol: "SOLANA" }), launch(9, { block: 702, symbol: "SOLANA" })],
    timestamps: { 701: NOW_SECONDS, 702: NOW_SECONDS, 703: NOW_SECONDS }
  },
  { SESSIONS: sessions({ ["session:" + OWNER_A]: HOLDER }) }
);
stand.watch.rules.add(OWNER_A, "shared", "4", await rifleOf("shared", "4"), 1);
await stand.watch.tick(NOW);
stand.chain.head = 702;
net.sent.length = 0;
r = await stand.watch.tick(NOW + 12000);
t.ok(stand.watch.tailCount("ticker", sharedHash) === 2, "the stored tail contains both the overlapping launch and the suffix launch");
t.ok(stand.watch.tailCount("ticker", sharedHash, 701) === 1, "the count used with the snapshot contains only the suffix launch");
t.ok(r.fired === 0 && net.sent.length === 0, "the overlap is not added twice to manufacture the threshold");
stand.chain.launches.push(launch(10, { block: 703, symbol: "SOLANA" }));
stand.chain.head = 703;
r = await stand.watch.tick(NOW + 24000);
t.ok(r.fired === 0 && net.sent.length === 0 && stand.ctx.deliveries.some(delivery => delivery.sent === 0), "the rule is durably queued when the disjoint suffix really reaches the threshold");
r = await stand.watch.tick(NOW + 36000);
t.ok(r.fired === 1 && net.sent.length === 1, "the next bounded pass delivers that queued threshold match");
t.ok(/2 after the published snapshot/.test(net.sent[0].text), "the message labels the suffix it counted instead of calling it the whole tail");

// A conflict marker retained from an earlier factory-position/index failure closes shared counting until a
// published snapshot covers that block. Current log pages reject duplicate tokens before reaching this path.
forgetPublished();
net = fakePublished({
  index: { ...emptyPublishedIndex(), ticker: { [sharedHash]: { n: 2, d: 2, first: "2026-09-01" } } },
  numbers: { window: { from_block: 1, to_block: 700, blocks: 700 } }
});
const indexedOnce = launch(16, { block: 701, logIndex: 0, symbol: "SOLANA" });
stand = roundWith(
  {
    head: 700,
    launches: [indexedOnce, launch(17, { block: 703, logIndex: 2, symbol: "SOLANA" })],
    timestamps: { 701: NOW_SECONDS, 702: NOW_SECONDS, 703: NOW_SECONDS }
  },
  { SESSIONS: sessions({ ["session:" + OWNER_A]: HOLDER }) }
);
stand.watch.rules.add(OWNER_A, "shared", "4", await rifleOf("shared", "4"), 1);
await stand.watch.tick(NOW);
stand.watch.set("wall_index_error_block", 702);
stand.chain.head = 703;
net.sent.length = 0;
r = await stand.watch.tick(NOW + 12000);
t.ok(stand.watch.num("wall_index_error_block") === 702 && stand.watch.tailCompleteAfter(700) === false, "a post-snapshot index conflict makes the token-keyed suffix incomplete");
t.ok(r.fired === 0 && net.sent.length === 0 && stand.watch.num("snapshot_unread") >= 1, "a later launch cannot make a shared rule count through that incomplete suffix");
stand.watch.set("wall_index_error_block", "invalid");
t.ok(stand.watch.tailCompleteAfter(700) === false, "an invalid conflict marker also fails shared counting closed");
stand.watch.set("wall_index_error_block", 700);
t.ok(stand.watch.tailCompleteAfter(700) === true, "a snapshot that reaches the valid conflict marker can start a complete suffix after it");

forgetPublished();
net = fakePublished({ index: { ...emptyPublishedIndex(), ticker: { [sharedHash]: { n: 2, d: 2, first: "2026-09-01" } } }, numbersOk: false });
stand = roundWith(
  { head: 700, launches: [launch(11, { block: 701, symbol: "SOLANA" })], timestamps: { 701: NOW_SECONDS } },
  { SESSIONS: sessions({ ["session:" + OWNER_A]: HOLDER }) }
);
stand.watch.rules.add(OWNER_A, "shared", "2", await rifleOf("shared", "2"), 1);
await stand.watch.tick(NOW);
stand.chain.head = 701;
net.sent.length = 0;
r = await stand.watch.tick(NOW + 12000);
t.ok(r.fired === 0 && net.sent.length === 0, "an unreadable snapshot boundary stays quiet even when the index count alone reaches the threshold");
t.ok(stand.watch.num("snapshot_unread") >= 1, "the missing boundary is counted instead of silently treated as disjoint");

// On the final read attempt, a skipped block is committed before a later readable launch checks shared rules.
forgetPublished();
net = fakePublished({
  index: { ...emptyPublishedIndex(), ticker: { [sharedHash]: { n: 2, d: 2, first: "2026-09-01" } } },
  numbers: { window: { from_block: 1, to_block: 700, blocks: 700 } }
});
const unreadable701 = launch(12, { block: 701, symbol: "SOLANA" });
stand = roundWith(
  {
    head: 700,
    launches: [unreadable701, launch(13, { block: 702, symbol: "SOLANA" })],
    timestamps: { 701: NOW_SECONDS, 702: NOW_SECONDS },
    broken: { ["token:" + unreadable701.token]: new Error("no answer") }
  },
  { SESSIONS: sessions({ ["session:" + OWNER_A]: HOLDER }) }
);
stand.watch.rules.add(OWNER_A, "shared", "3", await rifleOf("shared", "3"), 1);
await stand.watch.tick(NOW);
stand.chain.head = 702;
net.sent.length = 0;
for (let i = 1; i <= READ_ATTEMPTS; i++) r = await stand.watch.tick(NOW + 12000 * i);
t.ok(r.ran === true && r.unreadable === 1 && stand.watch.lastBlock() === 702, "the final attempt advances past block 701 with an explicit unreadable marker");
t.ok(stand.ctx.tail.length === 1 && Number(stand.ctx.tail[0].block) === 702, "the later readable launch is retained after the failed boundary");
t.ok(r.fired === 0 && net.sent.length === 0, "a shared rule cannot add that incomplete suffix to the published count");
t.ok(stand.watch.num("snapshot_unread") >= 1, "the incomplete shared-rule boundary is counted as unreadable");
const markedTail = await stand.watch.tail(NOW + 12000 * (READ_ATTEMPTS + 1));
t.ok(markedTail.from_block === 702 && markedTail.gap_blocks === 1 && markedTail.launches_in_tail === 1, "the same boundary is explicit in the public tail while the readable suffix remains reproducible");

// ---------------------------------------------------------------- the watchdog counts a gap and says nothing in any room
forgetPublished();
net = fakePublished({});
stand = roundWith({ head: 700, launches: [], timestamps: {} }, { ROOM_CHAT_ID: "-1001234567890" });
await stand.watch.tick(NOW);
net.sent.length = 0;
stand.watch.set("last_round_at", NOW);
const late = await stand.watch.watchdog(NOW + 600000);
t.ok(late.woke === true, "a long silence wakes it");
t.ok(stand.watch.num("gaps") === 1, "the gap is counted");
t.ok(net.sent.length === 0, "and nothing is said in the room: a gap here costs the people with rules, and /rules tells them");
stand.watch.set("last_round_at", NOW + 600000);
const fine = await stand.watch.watchdog(NOW + 600100);
t.ok(fine.woke === false && fine.why === "on time", "a recent round is left alone");

t.done();
