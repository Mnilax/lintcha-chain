// The feed, on a fake context, with no runtime and no network. Specification section nine, the last line:
// no alarm is set while the address is empty. Plus the two halves of variant B: a buy reaches the room, a
// sell is counted and does not.
//
//   node test/tape_test.mjs
import { Tape, shouldSchedule, DEFAULT_INTERVAL_MS } from "../src/tape.js";
import { forgetToken, forgetDecimals, setGate, SEL, TOPIC_TRANSFER } from "../src/chain.js";
import { harness, fakeCtx, fakeGate, fakeNetwork, wordHex, topicAddr, launchRecordHex, STAND_BOT_TOKEN, TOKEN_ADDRESS, VENUE_ADDRESS, WALLET_ADDRESS, FIXTURE } from "./fakes.mjs";

const t = harness("tape");
const net = fakeNetwork();

const ROOM = -1001234567890;
const envOf = extra => ({ ROOM_CHAT_ID: ROOM, TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN, TX_URL_PREFIX: "https://example.invalid/tx/", ...extra });

const chainAt = (head, logs) => fakeGate({
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  ["eth_call:" + SEL.decimals]: wordHex(18),
  eth_blockNumber: "0x" + head.toString(16),
  eth_getLogs: logs
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

// ---------------------------------------------------------------- a buy is posted, a sell is only counted
forgetToken(); forgetDecimals();
net.sent.length = 0;
setGate(chainAt(102, [
  { topics: [TOPIC_TRANSFER, topicAddr(VENUE_ADDRESS), topicAddr(WALLET_ADDRESS)], data: wordHex(7n * 10n ** 18n), blockNumber: "0x65", transactionHash: "0xaa", logIndex: "0x0" },
  { topics: [TOPIC_TRANSFER, topicAddr(WALLET_ADDRESS), topicAddr(VENUE_ADDRESS)], data: wordHex(3n * 10n ** 18n), blockNumber: "0x66", transactionHash: "0xbb", logIndex: "0x1" }
]));
r = await tape.tick(3000);
t.ok(r.buys === 1 && r.sells === 1, "one buy and one sell were read");
t.ok(r.posted === 1, "the buy was posted");
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
  { topics: [TOPIC_TRANSFER, topicAddr(VENUE_ADDRESS), topicAddr(WALLET_ADDRESS)], data: wordHex(2n * 10n ** 18n), blockNumber: "0x67", transactionHash: "0xcc", logIndex: "0x0" }
]));
r = await tape.tick(4000);
t.ok(r.posted === 1 && /bought again/.test(net.sent[0].text), "a returning wallet is named as returning");
t.ok(tape.statsRow().newWallets === 1, "and is not counted as new twice");
t.ok(tape.topRows()[0].wallet === WALLET_ADDRESS, "the wallet is in the top list");
t.ok(tape.topRows()[0].buys === 2, "with both of its buys");

// the same log offered twice is not posted twice
net.sent.length = 0;
t.ok(tape.record({ wallet: WALLET_ADDRESS, amount: 2n * 10n ** 18n, block: 103, tx: "0xcc", logIndex: 0 }) === false, "a buy already recorded is refused");
tape.set("last_block", 102);
r = await tape.tick(5000);
t.ok(r.buys === 1 && r.posted === 0, "re-reading a range it has seen posts nothing");
t.ok(net.sent.length === 0, "and sends nothing");

// ---------------------------------------------------------------- a read that fails keeps the cursor and says nothing
forgetToken(); forgetDecimals();
net.sent.length = 0;
const before = tape.lastBlock();
setGate(fakeGate({
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  ["eth_call:" + SEL.decimals]: wordHex(18),
  eth_blockNumber: new Error("endpoint down")
}));
r = await tape.tick(6000);
t.ok(r.ran === false && r.why === "head", "a failed head read is a failed round");
t.ok(tape.lastBlock() === before, "the cursor does not move");
t.ok(r.scheduled === true, "the next round is still scheduled");
t.ok(net.sent.length === 0, "and the room is told nothing about one missed read");

// ---------------------------------------------------------------- the watchdog says a gap out loud
forgetToken();
net.site = { address: TOKEN_ADDRESS, pons: null, uniswap: null };
net.sent.length = 0;
tape.set("last_round_at", 1000);
const woke = await tape.watchdog(1000 + 600000);
t.ok(woke.woke === true, "a long silence wakes the feed");
t.ok(net.sent.length === 1, "and one line goes to the room");
t.ok(/stopped for about/.test(net.sent[0].text), "saying the feed stopped");
t.ok(/nothing is dropped/.test(net.sent[0].text), "and that nothing is dropped or guessed at");
t.ok(tape.statsRow().gaps === 1, "the gap is counted");

net.sent.length = 0;
tape.set("last_round_at", 1000);
const fine = await tape.watchdog(1030);
t.ok(fine.woke === false && fine.why === "on time", "a recent round is left alone");
t.ok(net.sent.length === 0, "and nothing is said about it");

// ---------------------------------------------------------------- with no room bound, buys are recorded and not posted
forgetToken(); forgetDecimals();
net.sent.length = 0;
const quietCtx = fakeCtx();
const quiet = new Tape(quietCtx, { TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN });
setGate(chainAt(200, []));
await quiet.tick(1000);
setGate(chainAt(202, [
  { topics: [TOPIC_TRANSFER, topicAddr(VENUE_ADDRESS), topicAddr(FIXTURE.address)], data: wordHex(1n * 10n ** 18n), blockNumber: "0xc9", transactionHash: "0xee", logIndex: "0x0" }
]));
r = await quiet.tick(2000);
t.ok(r.buys === 1 && r.posted === 0, "the buy is read and recorded");
t.ok(net.sent.length === 0, "and nothing is sent, because there is no room to send it to");
t.ok(quiet.statsRow().buys === 1, "the count is kept either way");

t.done();
