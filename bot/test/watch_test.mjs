// The watcher, on a fake context with no runtime and no network.
//
// The three things this file exists to hold down, all of them from specification section sixteen:
//
//   no alarm while there is no endpoint. Not a short one, not a retrying one: none. There is nothing readable,
//   so there is nothing to schedule, and the cron is what tries again.
//   everything older than the tail's depth goes, because the snapshot already covers it and two copies of one
//   launch would be two answers to one question.
//   a rule fires for a holder with a live session and stays quiet for one whose session has lapsed.
//
// Plus the ones that would be quiet failures: a launch that will not read does not get written half read and
// does not get stepped over on the first try, and a launch already in the tail is not stored or announced
// twice.
//
//   node test/watch_test.mjs
import { Watch, SEL_TOKEN, forgetPublished, DEFAULT_INTERVAL_MS, DEFAULT_DEPTH_DAYS, READ_ATTEMPTS } from "../src/watch.js";
import { setGate } from "../src/chain.js";
import { rifleOf } from "../src/rules.js";
import { digest, normalize } from "../src/engine.js";
import { harness, fakeWatchCtx, fakeChain, fakePublished, OWNER_A, OWNER_B, STAND_BOT_TOKEN } from "./fakes.mjs";

const t = harness("watch");

const DEV_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEV_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOLDER = "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";
const DAY = 86400;
const NOW_SECONDS = 1780000000;
const NOW = NOW_SECONDS * 1000;

const SELECTORS = { name: SEL_TOKEN.name, symbol: SEL_TOKEN.symbol, info: SEL_TOKEN.info };

const launch = (n, extra) => ({
  token: "0x" + String(n).padStart(2, "0").repeat(20),
  curve: "0x" + "2".repeat(40),
  deployer: DEV_A,
  block: 600 + n,
  tx: "0x" + String(n).repeat(64),
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

// ---------------------------------------------------------------- with no endpoint: no alarm at all
forgetPublished();
let net = fakePublished({});
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

// ---------------------------------------------------------------- the first round starts where it wakes up
forgetPublished();
net = fakePublished({});
let stand = roundWith({ head: 700, launches: [launch(1, { block: 650 })] });
r = await stand.watch.tick(NOW);
t.ok(r.first === true && r.to === 700, "the first round takes the head and replays no history");
t.ok(r.launches === 0, "so a launch below the head is not read at all: the tail begins here and says so");
t.ok(stand.ctx.storage.peekAlarm() === NOW + DEFAULT_INTERVAL_MS, "and the next round is one interval away");
t.ok(DEFAULT_INTERVAL_MS === 12000, "the interval starts at twelve seconds");
t.ok(DEFAULT_DEPTH_DAYS === 7, "and the tail keeps seven days");
t.ok(new Watch(fakeWatchCtx(), envOf({ WATCH_INTERVAL_MS: "3000", WATCH_DEPTH_DAYS: "2" })).intervalMs() === 3000, "both are settings, not constants");
t.ok(new Watch(fakeWatchCtx(), envOf({ WATCH_DEPTH_DAYS: "2" })).depthDays() === 2, "the depth too");

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
net = fakePublished({});
const stubborn = launch(3, { block: 701 });
stand = roundWith({ head: 700, launches: [stubborn], timestamps: { 701: NOW_SECONDS }, broken: { ["token:" + stubborn.token]: new Error("no answer") } });
await stand.watch.tick(NOW);
stand.chain.head = 702;
const before = stand.watch.lastBlock();
r = await stand.watch.tick(NOW + 12000);
t.ok(r.ran === false && r.why === "fields", "a launch that will not read fails the round");
t.ok(stand.watch.lastBlock() === before, "the cursor does not step over it");
t.ok(r.scheduled === true, "and the next round is still scheduled, because the endpoint itself answered");
t.ok(stand.ctx.tail.length === 0, "nothing is written half read");
for (let i = 2; i <= READ_ATTEMPTS; i++) r = await stand.watch.tick(NOW + 12000 * i);
t.ok(r.ran === true && r.unreadable === 1, "after a few tries it is counted as unreadable and the tail moves on");
t.ok(stand.watch.lastBlock() === 702, "because a token that never answers cannot be allowed to stop the tail for good");
t.ok(READ_ATTEMPTS === 3, "and the number of tries is a named constant, not a magic three");

// ---------------------------------------------------------------- everything older than the depth is dropped
forgetPublished();
net = fakePublished({});
stand = roundWith({
  head: 700,
  launches: [launch(4, { block: 701 }), launch(5, { block: 702 })],
  timestamps: { 701: NOW_SECONDS - 8 * DAY, 702: NOW_SECONDS }
});
await stand.watch.tick(NOW);
stand.chain.head = 702;
r = await stand.watch.tick(NOW + 12000);
t.ok(r.stored === 2, "both launches are stored as they arrive");
t.ok(r.pruned === 1, "and the one whose block is older than the depth is dropped in the same round");
t.ok(stand.ctx.tail.length === 1, "leaving one row");
t.ok(stand.ctx.tail[0].token === launch(5).token, "the recent one");
t.ok(stand.ctx.tailHash.every(h => h.token === launch(5).token), "and its hashes go with it, so a count cannot outlive its launch");

// ---------------------------------------------------------------- a rule fires for a live session and not for a lapsed one
forgetPublished();
const index = {};
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
t.ok(r.fired === 1, "one rule fired: the holder's string rule");
t.ok(net.sent.length === 1, "one message went out");
t.ok(String(net.sent[0].chat_id) === OWNER_A, "to the person whose rule it is");
t.ok(/Rule: string SOLANA/.test(net.sent[0].text), "and it names the rule");
t.ok(/Matched: the ticker/.test(net.sent[0].text), "and what matched");
t.ok(/Launches carrying it/.test(net.sent[0].text), "and how many launches carry it");
t.ok(net.sent[0].text.includes(launch(6).token), "and names the launch");
t.ok(/example\.invalid\/tx\//.test(net.sent[0].text), "with a link to it when there is a prefix to build one from");
t.ok(!/good|bad|scam|safe|risk|score|likely/i.test(net.sent[0].text), "and says nothing about whether any of it is good or bad");
t.ok(stand.watch.rules.list(OWNER_A)[0].hits === 1, "the rule counts its hit");
t.ok(stand.watch.rules.list(OWNER_B)[0].hits === 0, "the other person's identical rule did not fire, because their session has lapsed");
t.ok(stand.watch.num("dormant_skips") === 1, "and that skip is counted rather than passed over in silence");

// the dev rule named the other deployer, so it stayed quiet
t.ok(stand.watch.rules.list(OWNER_A)[1].hits === 0, "a dev rule for another deployer did not fire");

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
