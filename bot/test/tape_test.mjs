// The feed, on a fake context, with no runtime and no network. Specification section nine, the last line:
// no alarm is set while the address is empty. Plus the two halves of variant B: a buy reaches the room, a
// sell is counted and does not.
//
//   node test/tape_test.mjs
import { Tape, shouldSchedule, DEFAULT_INTERVAL_MS, DEFAULT_WATCHDOG_MS, DEFAULT_MAX_BLOCKS, DEFAULT_MAX_LOGS, DEFAULT_DELIVERY_BATCH, MAX_DELIVERY_BATCH, DELIVERY_WINDOW_LIMIT, DELIVERY_WINDOW_MS } from "../src/tape.js";
import { forgetToken, forgetDecimals, setGate, SEL, TOPIC_TRANSFER, CHAIN_ID, MAX_TRANSFER_HEADER_BLOCKS } from "../src/chain.js";
import { harness, fakeCtx, fakeGate, fakeGateFn, fakeNetwork, wordHex, topicAddr, launchRecordHex, STAND_BOT_TOKEN, TOKEN_ADDRESS, VENUE_ADDRESS, WALLET_ADDRESS, FIXTURE } from "./fakes.mjs";

const t = harness("tape");
const net = fakeNetwork();

const ROOM = -1001234567890;
const envOf = extra => ({ ROOM_CHAT_ID: ROOM, TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN, TX_URL_PREFIX: "https://example.invalid/tx/", ...extra });
const TX_A = "0x" + "a".repeat(64);
const TX_B = "0x" + "b".repeat(64);
const TX_C = "0x" + "c".repeat(64);
const TX_D = "0x" + "d".repeat(64);
const TX_E = "0x" + "e".repeat(64);
const transferLog = ({ from, to, amount, block, tx, logIndex, address = TOKEN_ADDRESS, signature = TOPIC_TRANSFER, blockHash = TX_E }) => ({
  address,
  removed: false,
  topics: [signature, topicAddr(from), topicAddr(to)],
  data: wordHex(amount),
  blockNumber: "0x" + Number(block).toString(16),
  transactionHash: tx,
  blockHash,
  logIndex: "0x" + Number(logIndex).toString(16)
});

const chainAt = (head, logs) => fakeGateFn(async (method, params) => {
  if (method === "eth_chainId") return "0x" + CHAIN_ID.toString(16);
  if (method === "eth_call" && params[0].data.startsWith(SEL.launched)) return launchRecordHex({ curve: VENUE_ADDRESS });
  if (method === "eth_call" && params[0].data === SEL.decimals) return wordHex(18);
  if (method === "eth_getBlockByNumber") {
    if (params[0] === "finalized") return { number: "0x" + head.toString(16) };
    const block = Number(BigInt(params[0]));
    const source = logs.find(log => log && Number(BigInt(log.blockNumber)) === block);
    return source ? { number: params[0], hash: source.blockHash } : new Error("the test gave no header for " + params[0]);
  }
  if (method === "eth_getLogs") {
    const from = Number(BigInt(params[0].fromBlock)), to = Number(BigInt(params[0].toBlock));
    return logs.filter(log => Number(BigInt(log.blockNumber)) >= from && Number(BigInt(log.blockNumber)) <= to);
  }
  return new Error("unexpected " + method);
});

// ---------------------------------------------------------------- the question the empty state turns on
t.ok(shouldSchedule({ ok: true, address: null }) === false, "nothing is due with a null address");
t.ok(shouldSchedule({ ok: false }) === false, "nothing is due when the site could not be read");
t.ok(shouldSchedule({ ok: true, address: TOKEN_ADDRESS }) === true, "a round is due once there is an address");
t.ok(shouldSchedule(null) === false, "and nothing is due with nothing at all");

// ---------------------------------------------------------------- with three null on the site: no alarm, none
forgetToken();
net.site = { address: null, pons: null, uniswap: null };
let ctx = fakeCtx();
let tape = new Tape(ctx, envOf());
let r = await tape.tick(1000);
t.ok(r.ran === false && r.why === "no token", "a round with no address does no work");
t.ok(r.scheduled === false, "and says it scheduled nothing");
t.ok(ctx.storage.peekAlarm() === null, "and no alarm is set at all");
t.ok(net.sent.length === 0, "and nothing is said in the room");

// even after an alarm existed, the empty state clears it rather than leaving it to fire forever
ctx = fakeCtx();
await ctx.storage.setAlarm(500);
tape = new Tape(ctx, envOf());
await tape.tick(1000);
t.ok(ctx.storage.peekAlarm() === null, "an alarm left over from before is cleared once the address is gone");

// the watchdog does not wake it either
const w = await tape.watchdog(2000);
t.ok(w.woke === false && w.why === "no token", "the watchdog leaves it alone while there is no address");

// ---------------------------------------------------------------- the first round starts where it wakes up
forgetToken(); forgetDecimals();
net.site = { address: TOKEN_ADDRESS, pons: "https://example.invalid/chart", uniswap: null };
setGate(chainAt(100, []));
ctx = fakeCtx();
tape = new Tape(ctx, envOf());
r = await tape.tick(2000);
t.ok(r.first === true && r.to === 100, "the first round takes the head and replays no history");
t.ok(ctx.storage.peekAlarm() === 2000 + DEFAULT_INTERVAL_MS, "and the next round is one interval away");
t.ok(DEFAULT_INTERVAL_MS === 12000, "the interval starts at twelve seconds");
t.ok(new Tape(fakeCtx(), envOf({ FEED_INTERVAL_MS: "3000" })).intervalMs() === 3000, "and it is a setting, not a constant");
const invalidSettingsTape = new Tape(fakeCtx(), envOf({ FEED_INTERVAL_MS: "Infinity", FEED_WATCHDOG_MS: "NaN", FEED_MAX_BLOCKS: "-1" }));
t.ok(invalidSettingsTape.intervalMs() === DEFAULT_INTERVAL_MS, "an infinite feed interval falls back to its finite default");
t.ok(invalidSettingsTape.watchdogMs() === DEFAULT_WATCHDOG_MS, "a NaN feed watchdog falls back without poisoning its comparison");
t.ok(invalidSettingsTape.maxBlocks() === 1, "a negative feed block cap tightens to one block rather than becoming an unbounded range");
t.ok(new Tape(fakeCtx(), envOf({ FEED_MAX_BLOCKS: String(DEFAULT_MAX_BLOCKS + 1) })).maxBlocks() === 1,
  "a feed range above the named maximum tightens to one block");
t.ok(new Tape(fakeCtx(), envOf({ FEED_MAX_LOGS: "NaN" })).maxLogs() === 1 &&
  new Tape(fakeCtx(), envOf({ FEED_MAX_LOGS: String(DEFAULT_MAX_LOGS + 1) })).maxLogs() === 1,
  "an invalid or above-ceiling transfer-log setting fails closed to one log");
t.ok(new Tape(fakeCtx(), envOf({ FEED_INTERVAL_MS: String(DEFAULT_WATCHDOG_MS + 1) })).intervalMs() === DEFAULT_INTERVAL_MS,
  "a feed interval beyond its watchdog bound closes to the operating default");
t.ok(tape.deliveryBatch() === DEFAULT_DELIVERY_BATCH && DEFAULT_DELIVERY_BATCH === 1,
  "room delivery starts with an explicit bounded batch");
t.ok(new Tape(fakeCtx(), envOf({ FEED_DELIVERY_BATCH: "Infinity" })).deliveryBatch() === DEFAULT_DELIVERY_BATCH &&
  new Tape(fakeCtx(), envOf({ FEED_DELIVERY_BATCH: String(MAX_DELIVERY_BATCH + 1) })).deliveryBatch() === DEFAULT_DELIVERY_BATCH,
  "non-finite or above-ceiling delivery settings fall back to the safe product default");
const windowTape = new Tape(fakeCtx(), envOf());
let windowExact = true;
for (let i = 0; i < DELIVERY_WINDOW_LIMIT; i++) if (windowTape.takeDeliveryAttempt(1000 + i) !== true) windowExact = false;
t.ok(windowExact && windowTape.takeDeliveryAttempt(1000 + DELIVERY_WINDOW_MS - 1) === false &&
  windowTape.takeDeliveryAttempt(1000 + DELIVERY_WINDOW_MS) === true,
  "the durable room-attempt window closes at its limit and resets only at the exact expiry");
const legacyDeliveryCtx = fakeCtx({ legacyBuyDelivery: true });
new Tape(legacyDeliveryCtx, envOf());
new Tape(legacyDeliveryCtx, envOf());
t.ok(legacyDeliveryCtx.storage.sql.statements.filter(stmt => /^ALTER TABLE buy_delivery ADD COLUMN last_attempt/i.test(stmt)).length === 1,
  "an existing Tape outbox gains its retry-order column exactly once across restarts");
t.ok(legacyDeliveryCtx.storage.sql.statements.filter(stmt => /^ALTER TABLE (?:buys|buy_delivery) ADD COLUMN block_hash/i.test(stmt)).length === 2,
  "legacy buy and outbox rows gain their chain-hash binding exactly once across restarts");

// A reorgable latest tip is not a cursor. Only the finalized tag bounds the log page and durable progress.
forgetToken(); forgetDecimals();
net.sent.length = 0;
const finalizedCtx = fakeCtx();
const finalizedTape = new Tape(finalizedCtx, envOf());
finalizedTape.set("last_block", 104);
const finalizedBuy = transferLog({ from: VENUE_ADDRESS, to: WALLET_ADDRESS, amount: 1n, block: 105, tx: TX_A, logIndex: 0 });
const latestOnly = { ...transferLog({ from: VENUE_ADDRESS, to: FIXTURE.address, amount: 1n, block: 107, tx: TX_B, logIndex: 0 }), removed: true };
let requestedLogs = null;
const finalizedGate = fakeGateFn(async (method, params) => {
  if (method === "eth_chainId") return "0x" + CHAIN_ID.toString(16);
  if (method === "eth_blockNumber") return "0x6c";
  if (method === "eth_getBlockByNumber") {
    if (params[0] === "finalized") return { number: "0x6a" };
    return params[0] === finalizedBuy.blockNumber
      ? { number: params[0], hash: finalizedBuy.blockHash }
      : new Error("only the finalized range is readable");
  }
  if (method === "eth_call" && params[0].data.startsWith(SEL.launched)) return launchRecordHex({ curve: VENUE_ADDRESS });
  if (method === "eth_call" && params[0].data === SEL.decimals) return wordHex(18);
  if (method === "eth_getLogs") {
    requestedLogs = params[0];
    const to = Number(BigInt(params[0].toBlock));
    return [finalizedBuy, latestOnly].filter(log => Number(BigInt(log.blockNumber)) <= to);
  }
  return new Error("unexpected " + method);
});
setGate(finalizedGate);
r = await finalizedTape.tick(2500);
t.ok(r.ran === true && r.to === 106 && finalizedTape.lastBlock() === 106, "Tape advances only to the finalized head while latest is ahead");
t.ok(requestedLogs && requestedLogs.toBlock === "0x6a", "the transfer page is capped at that finalized block");
t.ok(!finalizedGate.stats.byMethod.eth_blockNumber, "the reorgable latest-number method is never consulted");
t.ok(r.buys === 1 && r.posted === 0 && net.sent.length === 0, "a latest-only removed log is neither read nor posted, and the finalized buy is queued without an inline send");
r = await finalizedTape.tick(2600);
t.ok(r.posted === 1 && net.sent.length === 1, "the next bounded delivery pass posts the durable finalized buy");

// ---------------------------------------------------------------- a buy is posted, a sell is only counted
forgetToken(); forgetDecimals();
net.sent.length = 0;
setGate(chainAt(102, [
  transferLog({ from: VENUE_ADDRESS, to: WALLET_ADDRESS, amount: 7n * 10n ** 18n, block: 101, tx: TX_A, logIndex: 0 }),
  transferLog({ from: WALLET_ADDRESS, to: VENUE_ADDRESS, amount: 3n * 10n ** 18n, block: 102, tx: TX_B, logIndex: 1 })
]));
r = await tape.tick(3000);
t.ok(r.buys === 1 && r.sells === 1, "one buy and one sell were read");
t.ok(r.posted === 0 && net.sent.length === 0, "the fresh range queues its buy without bypassing the delivery bound");
r = await tape.tick(3500);
t.ok(r.posted === 1, "the next bounded pass posts the buy");
t.ok(net.sent.length === 1, "exactly one message went out");
t.ok(String(net.sent[0].chat_id) === String(ROOM), "to the room");
t.ok(/bought for the first time/.test(net.sent[0].text), "the line says the wallet is new");
t.ok(/<code>7<\/code> \$LINTCHA/.test(net.sent[0].text), "and states the amount in whole tokens");
t.ok(/0x3333/.test(net.sent[0].text), "and names the wallet in short form");
t.ok(!/sell/i.test(net.sent[0].text), "and says nothing about the sell");

const stats = tape.statsRow();
t.ok(stats.buys === 1, "the buy is counted");
t.ok(stats.sells === 1, "and so is the sell, which is the half of variant B that is not optional");
t.ok(stats.newWallets === 1, "the first time buyer is counted");
t.ok(stats.lastBlock === 102, "and the cursor moved to the head");

// a second buy from the same wallet is not a first time buyer
net.sent.length = 0;
setGate(chainAt(104, [
  transferLog({ from: VENUE_ADDRESS, to: WALLET_ADDRESS, amount: 2n * 10n ** 18n, block: 103, tx: TX_C, logIndex: 0 })
]));
r = await tape.tick(4000);
t.ok(r.posted === 0 && net.sent.length === 0, "a returning wallet's fresh buy is queued first");
r = await tape.tick(4250);
t.ok(r.posted === 1 && /bought again/.test(net.sent[0].text), "the bounded delivery pass names a returning wallet as returning");
t.ok(tape.statsRow().newWallets === 1, "and is not counted as new twice");
t.ok(tape.statsRow().buys === 2, "the non-ranking stats retain both of its buys");

// Per-log dedupe survives while a range is unfinished, then is retired only after its cursor is durable.
const cursorCall = ctx.storage.sql.calls.findIndex(call => call.stmt.startsWith("INSERT INTO kv") && call.args[0] === "last_block" && call.args[1] === "104");
const cleanupCall = ctx.storage.sql.calls.findIndex(call => call.stmt.startsWith("DELETE FROM buys WHERE block") && call.args[0] === 104);
t.ok(cursorCall >= 0 && cleanupCall > cursorCall, "completed-range dedupe cleanup is ordered after the durable cursor write");
t.ok(![...ctx.rows.keys()].some(key => key.startsWith("buy:")), "completed buy rows are bounded instead of growing forever");
t.ok([...ctx.rows.keys()].some(key => key.startsWith("wal:")), "wallet first-time and distinct state is retained");

const pendingCtx = fakeCtx();
const pendingTape = new Tape(pendingCtx, envOf());
const pendingBuy = { wallet: WALLET_ADDRESS, amount: 2n * 10n ** 18n, block: 103, blockHash: TX_E, tx: TX_C, logIndex: 0 };
t.ok(pendingTape.record({ ...pendingBuy }) === true && pendingTape.record({ ...pendingBuy }) === false, "an unfinished range still refuses the same log twice");
t.ok([...pendingCtx.rows.keys()].some(key => key.startsWith("buy:")), "that unfinished-range dedupe row remains until a cursor can cover it");

const identityCtx = fakeCtx();
const identityTape = new Tape(identityCtx, envOf());
const identityBuy = { wallet: WALLET_ADDRESS, amount: 3n, block: 399, blockHash: TX_E, tx: TX_C, logIndex: 7 };
t.ok(identityTape.queueDelivery({ ...identityBuy }, { pons: null }, 18) === true && identityTape.record({ ...identityBuy }) === true,
  "one unfinished position can be durably queued and recorded once");
const conflictingIdentity = { ...identityBuy, tx: TX_B, blockHash: TX_D, wallet: FIXTURE.address, amount: 4n };
t.ok(identityTape.queueDelivery({ ...conflictingIdentity }, { pons: null }, 18) === false && identityTape.record({ ...conflictingIdentity }) === null &&
  [...identityCtx.rows.keys()].filter(key => key.startsWith("buy:")).length === 1 &&
  [...identityCtx.rows.keys()].filter(key => key.startsWith("delivery:")).length === 1,
  "another payload at the same block and log position creates neither a second buy nor a second room line");

// A busy finalized range queues every observed buy atomically, then Telegram work drains in a strict fair
// batch. Failed rows rotate behind untouched rows, and no new chain range is read while that backlog remains.
forgetToken(); forgetDecimals();
net.telegramOk = true;
net.attempted.length = 0;
net.sent.length = 0;
const backlogCtx = fakeCtx();
const backlogTape = new Tape(backlogCtx, envOf({ FEED_DELIVERY_BATCH: "1" }));
backlogTape.set("last_block", 400);
const backlogLogs = ["3", "4", "5", "6", "7"].map((digit, logIndex) => transferLog({
  from: VENUE_ADDRESS,
  to: "0x" + digit.repeat(40),
  amount: BigInt(logIndex + 1) * 10n ** 18n,
  block: 401,
  tx: "0x" + digit.repeat(64),
  logIndex
}));
setGate(chainAt(401, backlogLogs));
r = await backlogTape.tick(4300);
t.ok(r.ran === true && r.buys === 5 && r.posted === 0 && backlogTape.lastBlock() === 401 && net.attempted.length === 0,
  "a busy range commits only after all five buys have durable rows, without an inline Telegram burst");
t.ok([...backlogCtx.rows.keys()].filter(key => key.startsWith("delivery:")).length === 5,
  "the outbox, not an unchanged RPC cursor, owns the queued backlog");
let tapeState = await (await backlogTape.fetch(new Request("https://object.invalid/state"))).json();
t.ok(tapeState.deliveryBacklog === 5 && tapeState.lastChainReadAt === 4300,
  "the object state exposes both durable delivery lag and the distinct last chain-read time");
net.telegramOk = false;
r = await backlogTape.tick(4400);
t.ok(r.ran === false && r.why === "telegram" && net.attempted.length === 1,
  "one failed delivery pass attempts no more than its configured batch");
tapeState = backlogTape.statsRow();
t.ok(tapeState.deliveryBacklog === 5 && tapeState.lastChainReadAt === 4300,
  "delivery activity does not masquerade as a fresh chain read while the cursor is paused for backlog");
r = await backlogTape.tick(4500);
const backlogRows = [...backlogCtx.rows.entries()].filter(([key]) => key.startsWith("delivery:")).map(([, value]) => value);
t.ok(net.attempted.length === 2 && backlogRows.filter(value => value.last_attempt === 4400).length === 1 &&
  backlogRows.filter(value => value.last_attempt === 4500).length === 1,
  "durable last-attempt rotation reaches untouched rows instead of retrying only the first failures");
net.telegramOk = true;
const recoveryDeltas = [];
for (const at of [4600, 4700, 4800, 4900, 5000]) {
  const beforeAttempts = net.attempted.length;
  await backlogTape.tick(at);
  recoveryDeltas.push(net.attempted.length - beforeAttempts);
}
t.ok(JSON.stringify(recoveryDeltas) === JSON.stringify([1, 1, 1, 1, 1]) && net.sent.length === 5,
  "recovery drains the finite backlog across bounded passes and accepts every queued buy");
t.ok(![...backlogCtx.rows.keys()].some(key => key.startsWith("delivery:")) &&
  backlogCtx.storage.sql.statements.some(stmt => /FROM buy_delivery[\s\S]*ORDER BY last_attempt, block, log, tx LIMIT \?/i.test(stmt)),
  "accepted rows are retired behind the cursor and the storage query itself carries the fair LIMIT");

// Delivery follows the chain position, not the lexical transaction hash. Otherwise the second same-wallet buy
// can appear as "again" before the first one says "first time".
forgetToken(); forgetDecimals();
net.telegramOk = true;
net.attempted.length = 0;
net.sent.length = 0;
const orderCtx = fakeCtx();
const orderTape = new Tape(orderCtx, envOf());
orderTape.set("last_block", 410);
setGate(chainAt(411, [
  transferLog({ from: VENUE_ADDRESS, to: WALLET_ADDRESS, amount: 1n, block: 411, tx: TX_E, logIndex: 0 }),
  transferLog({ from: VENUE_ADDRESS, to: WALLET_ADDRESS, amount: 2n, block: 411, tx: TX_A, logIndex: 1 })
]));
r = await orderTape.tick(5100);
t.ok(r.ran === true && r.buys === 2 && net.sent.length === 0, "same-block buys are both durable before delivery");
await orderTape.tick(5200);
await orderTape.tick(5300);
t.ok(net.sent.length === 2 && /bought for the first time/.test(net.sent[0].text) && /bought again/.test(net.sent[1].text),
  "same-block delivery uses log position even when transaction hashes sort in the opposite order");

// A transient Telegram refusal leaves both cursor and durable delivery in place, then recovers without
// recounting the buy. The external-send crash boundary is intentionally at-least-once, never at-most-once.
forgetToken(); forgetDecimals();
net.telegramOk = false;
net.attempted.length = 0;
net.sent.length = 0;
const retryCtx = fakeCtx();
const retryTape = new Tape(retryCtx, envOf());
retryTape.set("last_block", 300);
setGate(chainAt(301, [
  transferLog({ from: VENUE_ADDRESS, to: FIXTURE.address, amount: 4n * 10n ** 18n, block: 301, tx: TX_D, logIndex: 0 })
]));
r = await retryTape.tick(4500);
t.ok(r.ran === true && r.posted === 0, "a fresh range durably queues without making an inline Telegram request");
t.ok(retryTape.lastBlock() === 301, "the finalized cursor may advance once the durable outbox owns delivery retry");
t.ok(retryTape.statsRow().buys === 1 && net.sent.length === 0 && net.attempted.length === 0, "the buy is recorded once while its delivery remains unattempted");
t.ok([...retryCtx.rows.keys()].some(key => key.startsWith("delivery:") && retryCtx.rows.get(key).sent === 0), "the rendered line is durable and pending");
t.ok(retryCtx.storage.sql.calls.some(call => call.stmt.startsWith("DELETE FROM buy_delivery WHERE block") && call.args[0] === 301 && call.args[1] === 1),
  "post-cursor cleanup is explicitly restricted to accepted delivery rows");

net.telegramOk = false;
r = await retryTape.tick(4550);
t.ok(r.ran === false && r.why === "telegram" && net.attempted.length === 1 && retryTape.lastBlock() === 301,
  "a refused bounded delivery stops new chain work but keeps the outbox-owned cursor");
net.telegramOk = true;
r = await retryTape.tick(4600);
t.ok(r.ran === true && r.posted === 1 && retryTape.lastBlock() === 301, "the next bounded pass recovers without replaying the finalized range");
t.ok(retryTape.statsRow().buys === 1 && net.sent.length === 1 && net.attempted.length === 2, "recovery neither recounts the buy nor loses its one accepted line");
t.ok(/bought for the first time/.test(net.sent[0].text), "the durable retry preserves the original first-time wording");
const sentCall = retryCtx.storage.sql.calls.findIndex(call => call.stmt.startsWith("UPDATE buy_delivery SET sent") && call.args[1] === TX_D);
const retryCursorCall = retryCtx.storage.sql.calls.findIndex(call => call.stmt.startsWith("INSERT INTO kv") && call.args[0] === "last_block" && call.args[1] === "301");
const retryCleanupCall = retryCtx.storage.sql.calls.findIndex((call, index) => index > sentCall && call.stmt.startsWith("DELETE FROM buy_delivery WHERE block") && call.args[0] === 301 && call.args[1] === 1);
t.ok(retryCursorCall >= 0 && sentCall > retryCursorCall && retryCleanupCall > sentCall, "the outbox is durable before cursor commit, and accepted-row cleanup follows delivery");
t.ok(![...retryCtx.rows.keys()].some(key => key.startsWith("buy:") || key.startsWith("delivery:")), "completed retry rows are retired after commit");
net.attempted.length = 0;
net.sent.length = 0;

// A log-count ceiling shrinks a multi-block page instead of wedging forever. A single overflowing block cannot
// be split without dropping events, so it records an explicit boundary and leaves the cursor before it.
forgetToken(); forgetDecimals();
net.site = { address: TOKEN_ADDRESS, pons: "https://example.invalid/pons", uniswap: null };
const adaptiveLogs = [
  transferLog({ from: VENUE_ADDRESS, to: WALLET_ADDRESS, amount: 1n, block: 501, tx: TX_A, logIndex: 0 }),
  transferLog({ from: VENUE_ADDRESS, to: FIXTURE.address, amount: 2n, block: 502, tx: TX_B, logIndex: 0 })
];
let adaptiveLogCalls = 0;
const adaptiveGate = fakeGateFn(async (method, params) => {
  if (method === "eth_chainId") return "0x" + CHAIN_ID.toString(16);
  if (method === "eth_getBlockByNumber") {
    if (params[0] === "finalized") return { number: "0x1f6" };
    const source = adaptiveLogs.find(log => log.blockNumber === params[0]);
    return source ? { number: params[0], hash: source.blockHash } : new Error("missing adaptive header");
  }
  if (method === "eth_call" && params[0].data.startsWith(SEL.launched)) return launchRecordHex({ curve: VENUE_ADDRESS });
  if (method === "eth_call" && params[0].data === SEL.decimals) return wordHex(18);
  if (method === "eth_getLogs") {
    adaptiveLogCalls++;
    const from = Number(BigInt(params[0].fromBlock)), to = Number(BigInt(params[0].toBlock));
    return adaptiveLogs.filter(log => Number(BigInt(log.blockNumber)) >= from && Number(BigInt(log.blockNumber)) <= to);
  }
  return new Error("unexpected " + method);
});
setGate(adaptiveGate);
const adaptiveCtx = fakeCtx();
const adaptiveTape = new Tape(adaptiveCtx, envOf({ FEED_MAX_LOGS: "1" }));
adaptiveTape.set("last_block", 500);
r = await adaptiveTape.tick(5400);
t.ok(r.ran === true && r.from === 501 && r.to === 501 && adaptiveTape.lastBlock() === 501 && adaptiveLogCalls === 2,
  "an overflowing multi-block page is bisected to a complete bounded prefix");

const sparseHeaderLogs = Array.from({ length: MAX_TRANSFER_HEADER_BLOCKS + 1 }, (_, index) => transferLog({
  from: VENUE_ADDRESS,
  to: WALLET_ADDRESS,
  amount: 1n,
  block: 551 + index,
  tx: "0x" + BigInt(index + 1).toString(16).padStart(64, "0"),
  blockHash: "0x" + BigInt(index + 1000).toString(16).padStart(64, "0"),
  logIndex: 0
}));
const sparseHeaderGate = chainAt(550 + sparseHeaderLogs.length, sparseHeaderLogs);
setGate(sparseHeaderGate);
const sparseHeaderCtx = fakeCtx();
const sparseHeaderTape = new Tape(sparseHeaderCtx, envOf());
sparseHeaderTape.set("last_block", 550);
r = await sparseHeaderTape.tick(5425);
t.ok(r.ran === true && r.from === 551 && r.to === 551 && r.buys === 1 && sparseHeaderTape.lastBlock() === 551 &&
  sparseHeaderGate.stats.byMethod.eth_getLogs === 2,
  "a sparse page above the header-proof budget retries only its first complete block instead of starting a header storm");

const overflowCtx = fakeCtx();
const overflowTape = new Tape(overflowCtx, envOf({ FEED_MAX_LOGS: "1" }));
overflowTape.set("last_block", 500);
const sameBlockOverflow = adaptiveLogs.map((log, index) => ({ ...log, blockNumber: "0x1f5", logIndex: "0x" + index.toString(16) }));
setGate(fakeGate({
  eth_chainId: "0x" + CHAIN_ID.toString(16),
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  ["eth_call:" + SEL.decimals]: wordHex(18),
  eth_getBlockByNumber: { number: "0x1f5" },
  eth_getLogs: sameBlockOverflow
}));
r = await overflowTape.tick(5450);
t.ok(r.ran === false && r.why === "log overflow" && overflowTape.lastBlock() === 500 &&
  overflowTape.get("last_log_overflow_block") === "501" && overflowTape.statsRow().buys === 0,
  "a single-block overflow records its exact gap and consumes no prefix or cursor");

// One bad item poisons the whole RPC page; no prefix is recorded and the cursor stays put.
forgetToken(); forgetDecimals();
net.sent.length = 0;
const beforeMalformed = tape.lastBlock();
const nextBuy = transferLog({ from: VENUE_ADDRESS, to: FIXTURE.address, amount: 1n * 10n ** 18n, block: 105, tx: TX_E, logIndex: 0 });
setGate(fakeGateFn(async (method, params) => {
  if (method === "eth_chainId") return "0x" + CHAIN_ID.toString(16);
  if (method === "eth_getBlockByNumber") return params[0] === "finalized"
    ? { number: "0x6a" }
    : { number: params[0], hash: nextBuy.blockHash };
  if (method === "eth_call" && params[0].data.startsWith(SEL.launched)) return launchRecordHex({ curve: VENUE_ADDRESS });
  if (method === "eth_call" && params[0].data === SEL.decimals) return wordHex(18);
  if (method === "eth_getLogs") return [nextBuy, { ...nextBuy, blockNumber: "0x6b", logIndex: "0x1" }];
  return new Error("unexpected " + method);
}));
r = await tape.tick(5500);
t.ok(r.ran === false && r.why === "logs", "a malformed or out-of-range log fails the whole feed round");
t.ok(tape.lastBlock() === beforeMalformed, "the Tape cursor does not move past that malformed page");
t.ok(tape.statsRow().buys === 2 && net.sent.length === 0, "no valid-looking prefix from the malformed page is recorded or posted");

// Plausible venue/head/log answers cannot make Tape run on a different chain.
forgetToken(); forgetDecimals();
net.sent.length = 0;
const beforeWrongChain = tape.lastBlock();
const wrongChain = fakeGate({
  eth_chainId: "0x1",
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  ["eth_call:" + SEL.decimals]: wordHex(18),
  eth_getBlockByNumber: { number: "0x6a" },
  eth_getLogs: [nextBuy]
});
setGate(wrongChain);
r = await tape.tick(5750);
t.ok(r.ran === false && r.why === "chain", "Tape refuses a round when eth_chainId names another network");
t.ok(tape.lastBlock() === beforeWrongChain && net.sent.length === 0, "the wrong-chain round moves no cursor and posts nothing");
t.ok(!wrongChain.stats.byMethod.eth_call && !wrongChain.stats.byMethod.eth_getLogs, "plausible wrong-chain facts are never requested");

// Durable Objects can interleave events while one waits on RPC. The actor-local guard admits only one complete
// range pass, and the cursor check remains a second boundary before any buy mutation.
forgetToken(); forgetDecimals();
net.site = { address: TOKEN_ADDRESS, pons: "https://example.invalid/pons", uniswap: null };
net.telegramOk = true;
let enterConcurrentLogs, releaseConcurrentLogs;
const concurrentLogsEntered = new Promise(resolve => { enterConcurrentLogs = resolve; });
const concurrentLogsReleased = new Promise(resolve => { releaseConcurrentLogs = resolve; });
let concurrentLogCalls = 0;
const concurrentBuy = transferLog({ from: VENUE_ADDRESS, to: WALLET_ADDRESS, amount: 9n, block: 801, tx: TX_A, logIndex: 0 });
setGate(fakeGateFn(async (method, params) => {
  if (method === "eth_chainId") return "0x" + CHAIN_ID.toString(16);
  if (method === "eth_getBlockByNumber") return params[0] === "finalized"
    ? { number: "0x321" }
    : { number: params[0], hash: concurrentBuy.blockHash };
  if (method === "eth_call" && params[0].data.startsWith(SEL.launched)) return launchRecordHex({ curve: VENUE_ADDRESS });
  if (method === "eth_call" && params[0].data === SEL.decimals) return wordHex(18);
  if (method === "eth_getLogs") {
    concurrentLogCalls++;
    enterConcurrentLogs();
    await concurrentLogsReleased;
    return [concurrentBuy];
  }
  return new Error("unexpected " + method);
}));
const concurrentCtx = fakeCtx();
const concurrentTape = new Tape(concurrentCtx, envOf());
concurrentTape.set("last_block", 800);
const firstConcurrentTick = concurrentTape.tick(5800);
await concurrentLogsEntered;
const refusedConcurrentTick = await concurrentTape.tick(5801);
releaseConcurrentLogs();
const completedConcurrentTick = await firstConcurrentTick;
t.ok(refusedConcurrentTick.ran === false && refusedConcurrentTick.why === "in flight" && completedConcurrentTick.ran === true && concurrentLogCalls === 1,
  "a second interleaved tick starts no duplicate RPC range while the first is in flight");
t.ok(concurrentTape.lastBlock() === 801 && concurrentTape.statsRow().buys === 1 &&
  concurrentCtx.rows.get("wal:" + WALLET_ADDRESS).buys === 1,
  "the admitted concurrent range commits and counts its buy exactly once");

// ---------------------------------------------------------------- a read that fails keeps the cursor and says nothing
forgetToken(); forgetDecimals();
net.sent.length = 0;
const before = tape.lastBlock();
setGate(fakeGate({
  eth_chainId: "0x" + CHAIN_ID.toString(16),
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  ["eth_call:" + SEL.decimals]: wordHex(18),
  eth_getBlockByNumber: new Error("endpoint down")
}));
r = await tape.tick(6000);
t.ok(r.ran === false && r.why === "head", "a failed head read is a failed round");
t.ok(tape.lastBlock() === before, "the cursor does not move");
t.ok(r.scheduled === true, "the next round is still scheduled");
t.ok(net.sent.length === 0, "and the room is told nothing about one missed read");

// ---------------------------------------------------------------- the watchdog says a gap out loud
forgetToken();
net.site = { address: TOKEN_ADDRESS, pons: "https://example.invalid/pons", uniswap: null };
net.sent.length = 0;
tape.set("last_round_at", 1000);
tape.set("last_chain_read_at", 1000);
const woke = await tape.watchdog(1000 + 600000);
t.ok(woke.woke === true, "a long silence wakes the feed");
t.ok(net.sent.length === 1, "and one line goes to the room");
t.ok(/stopped reading new chain ranges for about/.test(net.sent[0].text), "saying the feed stopped");
t.ok(/nothing is dropped/.test(net.sent[0].text), "and that nothing is dropped or guessed at");
t.ok(tape.statsRow().gaps === 1, "the gap is counted");

net.sent.length = 0;
tape.set("last_round_at", 1000);
tape.set("last_chain_read_at", 1000);
const fine = await tape.watchdog(1030);
t.ok(fine.woke === false && fine.why === "on time", "a recent round is left alone");
t.ok(net.sent.length === 0, "and nothing is said about it");

// Gap notices use the same durable room outbox and pacing as buys. A Bot API refusal cannot erase the notice,
// and a current last_round_at cannot disguise a stale last_chain_read_at while delivery is backlogged.
forgetToken();
net.telegramOk = false;
net.attempted.length = 0;
net.sent.length = 0;
const noticeCtx = fakeCtx();
const noticeTape = new Tape(noticeCtx, envOf());
noticeTape.set("last_block", 600);
noticeTape.set("last_chain_read_at", 1000);
noticeTape.set("last_round_at", 700000);
setGate(fakeGate({ eth_chainId: "0x" + CHAIN_ID.toString(16) }));
let noticeResult = await noticeTape.watchdog(700000);
t.ok(noticeResult.woke === true && noticeResult.noticePending === true && noticeTape.noticeDelivery() &&
  noticeTape.statsRow().gaps === 1 && net.sent.length === 0,
  "a refused gap notice remains durable and the chain-stale watchdog does not call the object on time");
net.telegramOk = true;
noticeResult = await noticeTape.watchdog(710000);
t.ok(noticeResult.noticePending === false && noticeTape.noticeDelivery() === null && net.sent.length === 1 &&
  noticeTape.statsRow().gaps === 1,
  "the next watchdog pass delivers the exact pending notice once without recounting the gap");

// ---------------------------------------------------------------- with no room bound, buys are recorded and not posted
forgetToken(); forgetDecimals();
net.sent.length = 0;
const quietCtx = fakeCtx();
const quiet = new Tape(quietCtx, { TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN });
setGate(chainAt(200, []));
await quiet.tick(1000);
setGate(chainAt(202, [
  transferLog({ from: VENUE_ADDRESS, to: FIXTURE.address, amount: 1n * 10n ** 18n, block: 201, tx: "0x" + "f".repeat(64), logIndex: 0 })
]));
r = await quiet.tick(2000);
t.ok(r.buys === 1 && r.posted === 0, "the buy is read and recorded");
t.ok(net.sent.length === 0, "and nothing is sent, because there is no room to send it to");
t.ok(quiet.statsRow().buys === 1, "the count is kept either way");

t.done();
