// The webhook. Specification section six: an update without the right header gets four hundred and one and
// nothing in the body. Also the two routes that exist, and the one thing every other path gets.
//
//   node test/webhook_test.mjs
import worker, { sameSecret, telegramUpdateIdOf, telegramCommandClaimOf, Tape, Watch, forgetHoldBucket, apiPerSecond, publicCacheSeconds, DEFAULT_API_PER_SECOND, MAX_API_PER_SECOND, TELEGRAM_UPDATE_BODY_LIMIT, HOLD_BODY_LIMIT, INBOUND_BODY_TIMEOUT_MS } from "../src/index.js";
import { DEFAULT_TAIL_CACHE_MS, DEFAULT_INDEX_TTL_MS, TELEGRAM_RENDER_LEASE_MS } from "../src/watch.js";
import { forgetToken, forgetDecimals, setGate, SEL } from "../src/chain.js";
import { putSession } from "../src/verify.js";
import * as T from "../src/texts.js";
import { harness, fakeKV, fakeWatchCtx, fakeNetwork, fakeGate, wordHex, STAND_BOT_TOKEN, STAND_WEBHOOK_SECRET, FIXTURE, TOKEN_ADDRESS } from "./fakes.mjs";

const t = harness("webhook");
const net = fakeNetwork();

const waited = [];
const ctx = { waitUntil: p => waited.push(p) };
const nonceCtx = fakeWatchCtx();
const nonceWatch = new Watch(nonceCtx, {});
let watchCalls = 0;
const watchBinding = {
  idFromName: () => "watch",
  get: () => ({ fetch: (input, init) => { watchCalls++; return nonceWatch.fetch(input instanceof Request ? input : new Request(input, init)); } })
};
const env = () => ({
  TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: STAND_WEBHOOK_SECRET,
  BOT_USERNAME: "lintcha_chain_bot",
  SESSIONS: fakeKV(),
  WATCH: watchBinding
});

const post = (path, body, headers = {}) => new Request("https://chain.lintcha.com" + path, {
  method: "POST",
  headers: { "content-type": "application/json", Origin: "https://chain.lintcha.com", ...headers },
  body: JSON.stringify(body)
});
const oversizedPost = (path, limit, headers = {}) => {
  const observed = { chunks: 0, cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      observed.chunks++;
      controller.enqueue(new Uint8Array(observed.chunks === 1 ? limit : 1));
    },
    cancel() { observed.cancelled = true; }
  });
  return {
    observed,
    request: new Request("https://chain.lintcha.com" + path, {
      method: "POST",
      headers,
      body,
      duplex: "half"
    })
  };
};
const settlesInMicrotasks = async promise => {
  const outcome = { settled: false, value: null };
  promise.then(value => { outcome.settled = true; outcome.value = value; }, () => { outcome.settled = true; });
  for (let i = 0; i < 40 && !outcome.settled; i++) await Promise.resolve();
  return outcome;
};

const update = { update_id: 1001, message: { chat: { id: 1, type: "private" }, from: { id: 1 }, text: "/start" } };

// ---------------------------------------------------------------- the comparison itself
t.ok(sameSecret("abc", "abc") === true, "equal strings match");
t.ok(sameSecret("abc", "abd") === false, "one byte off does not match");
t.ok(sameSecret("abc", "abcd") === false, "a different length does not match");
t.ok(sameSecret("", "") === false, "two empty strings do not match");
t.ok(sameSecret(null, "abc") === false, "a missing header does not match");
t.ok(sameSecret("abc", undefined) === false, "a missing secret does not match");

// ---------------------------------------------------------------- no header, wrong header, right header
let r = await worker.fetch(post("/api/telegram", update), env(), ctx);
t.ok(r.status === 401, "no header at all is four hundred and one");
t.ok((await r.text()) === "", "and the body is empty");

r = await worker.fetch(post("/api/telegram", update, { "X-Telegram-Bot-Api-Secret-Token": "not-it" }), env(), ctx);
t.ok(r.status === 401, "a wrong header is four hundred and one");
t.ok((await r.text()) === "", "and that body is empty too");

r = await worker.fetch(post("/api/telegram", update, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET + "x" }), env(), ctx);
t.ok(r.status === 401, "a header with the secret as a prefix is still refused");

t.ok(telegramUpdateIdOf(1) === 1 && telegramUpdateIdOf(0) === null && telegramUpdateIdOf("1") === null && telegramUpdateIdOf(Number.MAX_SAFE_INTEGER + 1) === null,
  "only positive exactly representable JSON numbers are valid update ids");
t.ok(JSON.stringify(telegramCommandClaimOf(update)) === JSON.stringify({ known: true, owner: "1", meteredOwner: "1", metered: true }),
  "a known command is attributed to one canonical Telegram user for durable metering");
t.ok(telegramCommandClaimOf({ ...update, message: { ...update.message, text: "/unknown" } }).metered === false,
  "an unknown command is deduped without spending a user bucket");
t.ok(telegramCommandClaimOf({ ...update, message: { ...update.message, from: undefined } }).owner === null,
  "an anonymous command carries no invented user identity");
t.ok(telegramCommandClaimOf({ ...update, message: { ...update.message, text: "/forget" } }).metered === false,
  "the privacy deletion command is claimed but exempt from the work bucket");
const ordinaryJoinedUpdate = { update_id: 1008, message: { chat: { id: -1005, type: "supergroup" }, from: { id: 5 }, new_chat_members: [{ id: 9, is_bot: false, username: "alice" }] } };
const joinedUpdate = { update_id: 1005, message: { chat: { id: -1005, type: "supergroup" }, from: { id: 5 }, new_chat_members: [{ id: 10, is_bot: true, username: "LINTCHA_CHAIN_BOT" }] } };
t.ok(telegramCommandClaimOf(ordinaryJoinedUpdate, "lintcha_chain_bot").known === false,
  "an ordinary member join is deduped as non-runnable service traffic");
t.ok(telegramCommandClaimOf(joinedUpdate, "lintcha_chain_bot").service === true && telegramCommandClaimOf(joinedUpdate, "lintcha_chain_bot").metered === false,
  "this configured bot joining is runnable but spends no user's command bucket");
waited.length = 0;
const beforeInvalidUpdates = watchCalls;
for (const invalid of [undefined, 0, -1, 1.5, "1001", Number.MAX_SAFE_INTEGER + 1]) {
  const invalidUpdate = { message: update.message };
  if (invalid !== undefined) invalidUpdate.update_id = invalid;
  r = await worker.fetch(post("/api/telegram", invalidUpdate, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
  t.ok(r.status === 400, "an invalid or missing update id is refused before the handler");
}
t.ok(watchCalls === beforeInvalidUpdates && waited.length === 0, "invalid update ids neither reach Watch nor schedule side effects");

const unavailableEnv = env();
delete unavailableEnv.WATCH;
r = await worker.fetch(post("/api/telegram", { ...update, update_id: 1004 }, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), unavailableEnv, ctx);
t.ok(r.status === 503 && waited.length === 0, "an unavailable durable claim returns retryable service-unavailable with no side effects");

const beforeRecoveredRetry = net.sent.length;
r = await worker.fetch(post("/api/telegram", { ...update, update_id: 1004 }, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
await Promise.all(waited);
t.ok(r.status === 200 && net.sent.length === beforeRecoveredRetry + 1, "the same update runs after retry once the durable atomic claim is available");
waited.length = 0;
net.sent.length = 0;

forgetToken();
net.site = { address: null, pons: null, uniswap: null };
waited.length = 0;
r = await worker.fetch(post("/api/telegram", update, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
t.ok(r.status === 200, "the right header is two hundred");
t.ok(waited.length === 0, "the response is durably completed before the webhook acknowledges it");
await Promise.all(waited);
t.ok(net.sent.length === 1, "one message went out");
t.ok(String(net.sent[0].text).startsWith("lintcha reads what a launch"), "and it is the /start text");

waited.length = 0;
const sentAfterFirst = net.sent.length;
r = await worker.fetch(post("/api/telegram", update, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
t.ok(r.status === 200 && waited.length === 0 && net.sent.length === sentAfterFirst,
  "a duplicate update is acknowledged without scheduling or repeating its command");

const joinedBefore = net.sent.length;
r = await worker.fetch(post("/api/telegram", ordinaryJoinedUpdate, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
t.ok(r.status === 200 && net.sent.length === joinedBefore,
  "an ordinary member joining is acknowledged and never greets the room");
r = await worker.fetch(post("/api/telegram", joinedUpdate, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
t.ok(r.status === 200 && net.sent.length === joinedBefore + 1 && net.sent.at(-1).chat_id === -1005 && net.sent.at(-1).text === T.GREETING,
  "the production webhook renders the one quiet room greeting through the durable response path");
r = await worker.fetch(post("/api/telegram", joinedUpdate, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
t.ok(r.status === 200 && net.sent.length === joinedBefore + 1, "a retried room-join update cannot greet twice after completion");

let enterTelegram;
const telegramEntered = new Promise(resolve => { enterTelegram = resolve; });
let releaseTelegram;
const telegramRelease = new Promise(resolve => { releaseTelegram = resolve; });
let pauseTelegram = true;
net.beforeTelegram = async () => {
  if (!pauseTelegram) return;
  pauseTelegram = false;
  enterTelegram();
  await telegramRelease;
};
const sendingRace = { ...update, update_id: 1006 };
const attemptsBeforeSendRace = net.attempted.length;
const firstSending = worker.fetch(post("/api/telegram", sendingRace, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
await telegramEntered;
const secondSending = await worker.fetch(post("/api/telegram", sendingRace, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
releaseTelegram();
const firstSendingResponse = await firstSending;
net.beforeTelegram = null;
t.ok(firstSendingResponse.status === 200 && secondSending.status === 503 && net.attempted.length === attemptsBeforeSendRace + 1,
  "two local workers cannot send the same durably rendered action concurrently");

const uncertainUpdate = { ...update, update_id: 1007 };
const attemptsBeforeUncertain = net.attempted.length;
const sentBeforeUncertain = net.sent.length;
net.telegramResponseLoss = true;
const uncertainFirst = await worker.fetch(post("/api/telegram", uncertainUpdate, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
const uncertainRetry = await worker.fetch(post("/api/telegram", uncertainUpdate, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
net.telegramResponseLoss = false;
t.ok(uncertainFirst.status === 503 && uncertainRetry.status === 503 && net.sent.length === sentBeforeUncertain + 1 &&
  net.attempted.length === attemptsBeforeUncertain + 1,
  "an accepted POST with a lost success body keeps its send lease, so an immediate local retry cannot duplicate it");

// HTTP success is not Bot API acceptance. A 200/{ok:false} keeps the rendered response durable and returns a
// retryable webhook status; the retry sends the same words without rerunning a mutating command handler.
forgetToken();
net.site = { address: TOKEN_ADDRESS, pons: "https://example.invalid/pons", uniswap: null };
const durableVerify = { update_id: 2010, message: { chat: { id: 2010, type: "private" }, from: { id: 2010 }, text: "/verify" } };
net.telegramBodyOk = false;
const attemptsBeforeDurable = net.attempted.length;
const noncesBeforeDurable = nonceCtx.nonces.size;
r = await worker.fetch(post("/api/telegram", durableVerify, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
const firstDurableText = net.attempted.at(-1).text;
t.ok(r.status === 503 && net.attempted.length === attemptsBeforeDurable + 1 && nonceCtx.nonces.size === noncesBeforeDurable + 1 &&
  nonceCtx.telegramResponses.has(2010),
  "a Bot API 200 with ok false leaves one exact command response pending and asks Telegram to retry");
net.telegramBodyOk = true;
r = await worker.fetch(post("/api/telegram", durableVerify, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
t.ok(r.status === 200 && net.attempted.length === attemptsBeforeDurable + 2 && net.attempted.at(-1).text === firstDurableText &&
  nonceCtx.nonces.size === noncesBeforeDurable + 1 && !nonceCtx.telegramResponses.has(2010),
  "the retry accepts the stored response, creates no second verification mark, and completes its durable cursor");

// A second delivery of the same update can arrive while the first handler is suspended after its claim.
// Only the render-lease owner may mutate; the duplicate stays retryable until the first response is durable.
forgetToken();
net.site = { address: TOKEN_ADDRESS, pons: "https://example.invalid/pons", uniswap: null };
const raceCtx = fakeWatchCtx();
const raceWatch = new Watch(raceCtx, {});
const raceSessions = fakeKV();
await putSession(raceSessions, 6100, FIXTURE.address);
let enterAdd;
const addEntered = new Promise(resolve => { enterAdd = resolve; });
let releaseAdd;
const addRelease = new Promise(resolve => { releaseAdd = resolve; });
let blockFirstAdd = true;
const raceBinding = {
  idFromName: () => "watch",
  get: () => ({
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      if (blockFirstAdd && new URL(request.url).pathname === "/rules") {
        const body = await request.clone().json();
        if (body.what === "add") {
          blockFirstAdd = false;
          enterAdd();
          await addRelease;
        }
      }
      return raceWatch.fetch(request);
    }
  })
};
const raceEnv = { ...env(), WATCH: raceBinding, SESSIONS: raceSessions };
const racedRule = { update_id: 6100, message: { chat: { id: 6100, type: "private" }, from: { id: 6100 }, text: "/rule string SOLANA" } };
const sentBeforeRace = net.sent.length;
const firstRace = worker.fetch(post("/api/telegram", racedRule, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), raceEnv, ctx);
await addEntered;
const duplicateRace = await worker.fetch(post("/api/telegram", racedRule, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), raceEnv, ctx);
releaseAdd();
const firstRaceResponse = await firstRace;
t.ok(firstRaceResponse.status === 200 && duplicateRace.status === 503 && raceWatch.rules.list("6100").length === 1,
  "concurrent copies of one mutating command produce one rule while the non-owner render stays retryable");
t.ok(net.sent.length === sentBeforeRace + 1, "only the render-lease owner sends the concurrent command response");

// If the handler mutation succeeds but the response-ledger call itself is transiently unavailable, a later
// lease owner repeats the handler safely: Watch returns the first mutation result and /verify returns its mark.
const recoveryStart = Date.parse("2026-09-11T03:00:00.000Z");
const realRecoveryNow = Date.now;
let recoveryNow = recoveryStart;
Date.now = () => recoveryNow;
try {
  const replayCtx = fakeWatchCtx();
  const replayWatch = new Watch(replayCtx, {});
  const replaySessions = fakeKV();
  await putSession(replaySessions, 6200, FIXTURE.address);
  let refuseRuleStore = true;
  const replayBinding = {
    idFromName: () => "watch",
    get: () => ({
      async fetch(input, init) {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname === "/telegram-update") {
          const body = await request.clone().json();
          if (body.what === "actions" && refuseRuleStore) {
            refuseRuleStore = false;
            return new Response(null, { status: 503 });
          }
        }
        return replayWatch.fetch(request);
      }
    })
  };
  const replayEnv = { ...env(), WATCH: replayBinding, SESSIONS: replaySessions };
  const replayRule = { update_id: 6200, message: { chat: { id: 6200, type: "private" }, from: { id: 6200 }, text: "/rule string SOLANA" } };
  const ruleFirst = await worker.fetch(post("/api/telegram", replayRule, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), replayEnv, ctx);
  const firstRuleId = replayWatch.rules.list("6200")[0].id;
  recoveryNow += TELEGRAM_RENDER_LEASE_MS;
  const ruleRetry = await worker.fetch(post("/api/telegram", replayRule, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), replayEnv, ctx);
  t.ok(ruleFirst.status === 503 && ruleRetry.status === 200 && replayWatch.rules.list("6200").length === 1 && replayWatch.rules.list("6200")[0].id === firstRuleId,
    "a response-store failure followed by lease recovery reuses the first durable rule result");

  const verifyReplayCtx = fakeWatchCtx();
  const verifyReplayWatch = new Watch(verifyReplayCtx, {});
  let refuseVerifyStore = true;
  const verifyReplayBinding = {
    idFromName: () => "watch",
    get: () => ({
      async fetch(input, init) {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname === "/telegram-update") {
          const body = await request.clone().json();
          if (body.what === "actions" && refuseVerifyStore) {
            refuseVerifyStore = false;
            return new Response(null, { status: 503 });
          }
        }
        return verifyReplayWatch.fetch(request);
      }
    })
  };
  const verifyReplayEnv = { ...env(), WATCH: verifyReplayBinding };
  const replayVerify = { update_id: 6300, message: { chat: { id: 6300, type: "private" }, from: { id: 6300 }, text: "/verify" } };
  const verifyFirst = await worker.fetch(post("/api/telegram", replayVerify, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), verifyReplayEnv, ctx);
  const firstMark = [...verifyReplayCtx.nonces.keys()][0];
  recoveryNow += TELEGRAM_RENDER_LEASE_MS;
  const verifyRetry = await worker.fetch(post("/api/telegram", replayVerify, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), verifyReplayEnv, ctx);
  t.ok(verifyFirst.status === 503 && verifyRetry.status === 200 && verifyReplayCtx.nonces.size === 1 &&
    typeof firstMark === "string" && String(net.sent.at(-1).text).includes(firstMark),
    "verification recovery reuses one durable nonce and sends the link containing that original mark");
} finally {
  Date.now = realRecoveryNow;
}

waited.length = 0;
const sentBeforeOutOfOrder = net.sent.length;
const laterUpdate = { ...update, update_id: 2002 };
const earlierUpdate = { ...update, update_id: 2001 };
const laterResponse = await worker.fetch(post("/api/telegram", laterUpdate, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
const earlierResponse = await worker.fetch(post("/api/telegram", earlierUpdate, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
await Promise.all(waited);
t.ok(laterResponse.status === 200 && earlierResponse.status === 200 && net.sent.length === sentBeforeOutOfOrder + 2,
  "two distinct out-of-order update ids both run exactly once");

// The production webhook and singleton Watch make one atomic dedupe/rate decision. A duplicate or limited
// update is acknowledged without a handler, unknown traffic spends nothing, and the exact TTL opens a window.
const rateCtx = fakeWatchCtx();
const rateWatch = new Watch(rateCtx, { TELEGRAM_COMMANDS_PER_WINDOW: "2", TELEGRAM_COMMAND_WINDOW_MS: "1000" });
const rateBinding = {
  idFromName: () => "watch",
  get: () => ({ fetch: (input, init) => rateWatch.fetch(input instanceof Request ? input : new Request(input, init)) })
};
const rateEnv = { ...env(), WATCH: rateBinding };
const rateUpdate = (updateId, text = "/start", withFrom = true) => ({
  update_id: updateId,
  message: { chat: { id: 9090, type: "private" }, ...(withFrom ? { from: { id: 9090 } } : {}), text }
});
const realCommandNow = Date.now;
const commandWindowStart = Date.parse("2026-09-11T01:00:00.000Z");
let commandNow = commandWindowStart;
Date.now = () => commandNow;
try {
  waited.length = 0;
  const sentBeforeRate = net.sent.length;
  const firstRate = await worker.fetch(post("/api/telegram", rateUpdate(3001), { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), rateEnv, ctx);
  const duplicateRate = await worker.fetch(post("/api/telegram", rateUpdate(3001), { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), rateEnv, ctx);
  const secondRate = await worker.fetch(post("/api/telegram", rateUpdate(3002), { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), rateEnv, ctx);
  const limitedRate = await worker.fetch(post("/api/telegram", rateUpdate(3003), { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), rateEnv, ctx);
  await Promise.all(waited);
  t.ok([firstRate, duplicateRate, secondRate, limitedRate].every(response => response.status === 200) && net.sent.length === sentBeforeRate + 2,
    "two commands run, while their duplicate and the fresh over-limit command are acknowledged without handlers");
  t.ok(rateCtx.telegramUpdates.has(3003) && rateCtx.telegramCommandBuckets.get("9090").taken === 2,
    "the limited update is durably claimed and does not grow the full user bucket");

  waited.length = 0;
  const retryLimited = await worker.fetch(post("/api/telegram", rateUpdate(3003), { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), rateEnv, ctx);
  t.ok(retryLimited.status === 200 && waited.length === 0 && rateCtx.telegramCommandBuckets.get("9090").taken === 2,
    "a Telegram retry of the limited update bypasses both bucket and handler");

  const bucketsBeforeUnknown = rateCtx.telegramCommandBuckets.size;
  const sentBeforeUnknown = net.sent.length;
  const unknownRate = await worker.fetch(post("/api/telegram", rateUpdate(3004, "/unknown"), { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), rateEnv, ctx);
  await Promise.all(waited);
  t.ok(unknownRate.status === 200 && rateCtx.telegramCommandBuckets.size === bucketsBeforeUnknown && net.sent.length === sentBeforeUnknown,
    "an unknown command is deduped but consumes no bucket and produces no answer");

  waited.length = 0;
  const anonymousRate = await worker.fetch(post("/api/telegram", rateUpdate(3005, "/start", false), { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), rateEnv, ctx);
  t.ok(anonymousRate.status === 200 && waited.length === 0 && rateCtx.telegramUpdates.has(3005),
    "a known command without a user is claimed and dropped instead of causing a retry storm or bypassing the bucket");

  const takenBeforeForget = rateCtx.telegramCommandBuckets.get("9090").taken;
  const forgetRate = await worker.fetch(post("/api/telegram", rateUpdate(3006, "/forget"), { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), rateEnv, ctx);
  await Promise.all(waited);
  t.ok(forgetRate.status === 200 && rateCtx.telegramCommandBuckets.get("9090").taken === takenBeforeForget,
    "privacy deletion remains runnable without spending or waiting for the full command bucket");

  waited.length = 0;
  commandNow = commandWindowStart + 1000;
  const afterExpiry = await worker.fetch(post("/api/telegram", rateUpdate(3007), { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), rateEnv, ctx);
  await Promise.all(waited);
  t.ok(afterExpiry.status === 200 && rateCtx.telegramCommandBuckets.get("9090").taken === 1 && rateCtx.telegramCommandBuckets.get("9090").expires === commandWindowStart + 2000,
    "a command runs again at the exact durable window expiry and starts a fresh TTL");
} finally {
  Date.now = realCommandNow;
  waited.length = 0;
}

// /verify in the production worker stores its mark through the Watch object, not eventual KV.
forgetToken();
net.site = { address: TOKEN_ADDRESS, pons: "https://example.invalid/pons", uniswap: null };
waited.length = 0;
const verifyUpdate = { update_id: 1002, message: { chat: { id: 4242, type: "private" }, from: { id: 4242 }, text: "/verify" } };
r = await worker.fetch(post("/api/telegram", verifyUpdate, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
await Promise.all(waited);
const verifyText = String(net.sent[net.sent.length - 1].text || "");
const issued = /hold\?t=([0-9a-f]{32})/.exec(verifyText);
t.ok(r.status === 200 && !!issued, "/verify answers with a canonical holder link through the real worker path");
const taken = issued ? nonceWatch.nonceCommand({ what: "take", mark: issued[1] }) : { ok: false };
t.ok(taken.ok === true && taken.owner === "4242", "the production path put that link in the strong nonce store");

// /forget travels through the production watch adapter as well as deleting KV; no public rules route exists.
const forgetEnv = env();
await putSession(forgetEnv.SESSIONS, 4343, FIXTURE.address);
nonceWatch.rules.add("4343", "string", "SOLANA", { ticker: "a", name: null, links: [] }, 1);
waited.length = 0;
const forgetUpdate = { update_id: 1003, message: { chat: { id: 4343, type: "private" }, from: { id: 4343 }, text: "/forget" } };
r = await worker.fetch(post("/api/telegram", forgetUpdate, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), forgetEnv, ctx);
await Promise.all(waited);
t.ok(r.status === 200 && await forgetEnv.SESSIONS.get("session:4343") === null, "production /forget asks the bound session store to delete");
t.ok(nonceWatch.rules.list("4343").length === 0, "and its internal Watch request removes every saved rule for that owner");
t.ok(String(net.sent[net.sent.length - 1].text || "") === T.FORGOTTEN, "the production path reports only the two acknowledgements it received");

// ---------------------------------------------------------------- the method and the other paths
r = await worker.fetch(new Request("https://chain.lintcha.com/api/telegram", { method: "GET" }), env(), ctx);
t.ok(r.status === 405, "a GET on the webhook is refused by method");

r = await worker.fetch(new Request("https://chain.lintcha.com/api/anything", { method: "GET" }), env(), ctx);
t.ok(r.status === 404, "an unknown path under the api is four hundred and four");
t.ok((await r.text()) === "", "with nothing in the body");

r = await worker.fetch(new Request("https://chain.lintcha.com/", { method: "GET" }), env(), ctx);
t.ok(r.status === 404, "the root is not this worker's business");

// a body that is not json, with the right header
r = await worker.fetch(new Request("https://chain.lintcha.com/api/telegram", {
  method: "POST",
  headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET },
  body: "not json at all"
}), env(), ctx);
t.ok(r.status === 400, "a body that will not parse is four hundred");
waited.length = 0;
const telegramBodyCalls = watchCalls;
const oversizedTelegram = oversizedPost("/api/telegram", TELEGRAM_UPDATE_BODY_LIMIT, {
  "content-type": "application/json",
  "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET
});
r = await worker.fetch(oversizedTelegram.request, env(), ctx);
t.ok(r.status === 400 && oversizedTelegram.observed.cancelled && watchCalls === telegramBodyCalls && waited.length === 0,
  "an oversized streaming webhook body is cancelled at its byte ceiling before durable or handler work");
const neverCancelObserved = { cancelled: 0 };
const neverCancelBody = new ReadableStream({
  cancel() { neverCancelObserved.cancelled++; return new Promise(() => {}); }
});
const neverCancelRequest = new Request("https://chain.lintcha.com/api/telegram", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "content-length": String(TELEGRAM_UPDATE_BODY_LIMIT + 1),
    "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET
  },
  body: neverCancelBody,
  duplex: "half"
});
const neverCancelOutcome = await settlesInMicrotasks(worker.fetch(neverCancelRequest, env(), ctx));
t.ok(neverCancelOutcome.settled && neverCancelOutcome.value.status === 400 && neverCancelObserved.cancelled === 1 &&
  watchCalls === telegramBodyCalls && waited.length === 0,
  "an oversized declared webhook is refused even when best-effort body cancellation never settles");

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const hangingObserved = { pulls: 0, cancelled: 0 };
let bodyDeadline = null;
let bodyDeadlineMs = null;
let bodyDeadlineCleared = 0;
globalThis.setTimeout = (fn, ms) => { bodyDeadline = fn; bodyDeadlineMs = ms; return 71; };
globalThis.clearTimeout = id => { if (id === 71) bodyDeadlineCleared++; };
let hangingOutcome;
forgetHoldBucket();
try {
  const hangingBody = new ReadableStream({
    pull() { hangingObserved.pulls++; return new Promise(() => {}); },
    cancel() { hangingObserved.cancelled++; return new Promise(() => {}); }
  });
  const hangingRequest = new Request("https://chain.lintcha.com/api/hold", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: "https://chain.lintcha.com"
    },
    body: hangingBody,
    duplex: "half"
  });
  const pendingHangingRequest = worker.fetch(hangingRequest, env(), ctx);
  for (let i = 0; i < 40 && (!bodyDeadline || hangingObserved.pulls === 0); i++) await Promise.resolve();
  if (bodyDeadline) bodyDeadline();
  hangingOutcome = await settlesInMicrotasks(pendingHangingRequest);
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
const hangingReply = hangingOutcome.settled ? await hangingOutcome.value.json() : null;
forgetHoldBucket();
t.ok(hangingOutcome.settled && hangingOutcome.value.status === 400 && bodyDeadlineMs === INBOUND_BODY_TIMEOUT_MS &&
  bodyDeadlineCleared === 1 && hangingObserved.pulls === 1 && hangingObserved.cancelled === 1 &&
  JSON.stringify(hangingReply) === JSON.stringify({ ok: false, why: "shape" }) && watchCalls === telegramBodyCalls && waited.length === 0,
  "a hanging holder body hits the exact deadline and keeps its shape error without awaiting stream cancellation");

// ---------------------------------------------------------------- /api/hold
forgetToken();
net.site = { address: null, pons: null, uniswap: null };
r = await worker.fetch(post("/api/hold", { t: FIXTURE.nonce, address: FIXTURE.address, signature: FIXTURE.signature }), env(), ctx);
let body = await r.json();
t.ok(r.status === 400 && body.ok === false && body.why === "nonce", "a mark that was never issued is refused by the hold route");

r = await worker.fetch(new Request("https://chain.lintcha.com/api/hold", { method: "GET" }), env(), ctx);
t.ok(r.status === 405, "a GET on the hold route is refused by method");

r = await worker.fetch(new Request("https://chain.lintcha.com/api/hold", {
  method: "POST", headers: { "content-type": "application/json", Origin: "https://chain.lintcha.com" }, body: "{"
}), env(), ctx);
t.ok(r.status === 400, "a hold body that will not parse is four hundred");
const holdBodyCalls = watchCalls;
const oversizedHold = oversizedPost("/api/hold", HOLD_BODY_LIMIT, {
  "content-type": "application/json",
  Origin: "https://chain.lintcha.com"
});
r = await worker.fetch(oversizedHold.request, env(), ctx);
t.ok(r.status === 400 && oversizedHold.observed.cancelled && watchCalls === holdBodyCalls,
  "an oversized streaming holder proof is cancelled before nonce or chain work");
const declaredOversizedHold = new Request("https://chain.lintcha.com/api/hold", {
  method: "POST",
  headers: { "content-type": "application/json", Origin: "https://chain.lintcha.com", "content-length": String(HOLD_BODY_LIMIT + 1) },
  body: "{}"
});
r = await worker.fetch(declaredOversizedHold, env(), ctx);
t.ok(r.status === 400 && watchCalls === holdBodyCalls, "an oversized declared holder body is refused before reading it");

const beforeGuards = watchCalls;
r = await worker.fetch(post("/api/hold", { t: FIXTURE.nonce, address: FIXTURE.address, signature: FIXTURE.signature }, { Origin: "https://other.example" }), env(), ctx);
t.ok(r.status === 403 && (await r.text()) === "" && watchCalls === beforeGuards, "a cross-origin hold post is refused before its body reaches the holder check");
r = await worker.fetch(new Request("https://chain.lintcha.com/api/hold", {
  method: "POST", headers: { "content-type": "text/plain", Origin: "https://chain.lintcha.com" }, body: "{}"
}), env(), ctx);
t.ok(r.status === 415 && (await r.text()) === "" && watchCalls === beforeGuards, "the hold route accepts only the page's JSON media type before Watch");

forgetHoldBucket();
const tightHold = env();
tightHold.HOLD_PER_SECOND = "1";
const beforeLimit = watchCalls;
r = await worker.fetch(post("/api/hold", { t: FIXTURE.nonce, address: FIXTURE.address, signature: FIXTURE.signature }), tightHold, ctx);
const limited = await worker.fetch(post("/api/hold", { t: FIXTURE.nonce, address: FIXTURE.address, signature: FIXTURE.signature }), tightHold, ctx);
t.ok(r.status === 400 && limited.status === 429 && watchCalls === beforeLimit + 1 && JSON.stringify(await limited.json()) === JSON.stringify({ ok: false, why: "rate_limited" }), "the holder check has its own bounded per-isolate bucket before Watch");
forgetHoldBucket();

t.ok(apiPerSecond("NaN") === DEFAULT_API_PER_SECOND && apiPerSecond("Infinity") === DEFAULT_API_PER_SECOND, "NaN and Infinity rate settings close to the safe default");
t.ok([" 1", "1 ", "1e2", "1.5", "-1", "0", "01", String(Number.MAX_SAFE_INTEGER + 1)].every(value => apiPerSecond(value) === DEFAULT_API_PER_SECOND),
  "whitespace, exponent, fraction, nonpositive, padded and unsafe rate settings also close to the default");
t.ok(apiPerSecond(String(MAX_API_PER_SECOND + 1)) === DEFAULT_API_PER_SECOND, "a finite setting beyond the named cap also closes to the default");
t.ok(publicCacheSeconds("NaN") === Math.round(DEFAULT_TAIL_CACHE_MS / 1000) && publicCacheSeconds("Infinity") === Math.round(DEFAULT_TAIL_CACHE_MS / 1000),
  "invalid public cache settings produce the same finite window as the watcher");
t.ok(publicCacheSeconds("0") === 1, "an explicit zero cache lifetime still emits a valid minimum max-age");
t.ok(publicCacheSeconds(String(DEFAULT_INDEX_TTL_MS + 1)) === Math.round(DEFAULT_TAIL_CACHE_MS / 1000),
  "a cache lifetime beyond the published-generation TTL closes to the tail default");
const invalidHoldLimit = env();
invalidHoldLimit.HOLD_PER_SECOND = "Infinity";
invalidHoldLimit.TAIL_PER_SECOND = "100";
const invalidLimitStatuses = [];
const realNow = Date.now;
const heldNow = Date.now();
Date.now = () => heldNow;
try {
  for (let i = 0; i < DEFAULT_API_PER_SECOND + 1; i++) {
    invalidLimitStatuses.push((await worker.fetch(post("/api/hold", { t: FIXTURE.nonce, address: FIXTURE.address, signature: FIXTURE.signature }), invalidHoldLimit, ctx)).status);
  }
} finally { Date.now = realNow; }
t.ok(invalidLimitStatuses.slice(0, DEFAULT_API_PER_SECOND).every(status => status === 400) && invalidLimitStatuses.at(-1) === 429, "an invalid explicit hold limit uses the safe default and then rate limits");
forgetHoldBucket();

const noKv = { TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: STAND_WEBHOOK_SECRET };
r = await worker.fetch(post("/api/hold", { t: FIXTURE.nonce, address: FIXTURE.address, signature: FIXTURE.signature }), noKv, ctx);
t.ok(r.status === 503, "with no store bound the hold route says so rather than pretending");

// A valid proof and a plausible balance from another chain cannot create a production holder session.
forgetHoldBucket(); forgetToken(); forgetDecimals();
net.site = { address: TOKEN_ADDRESS, pons: "https://example.invalid/pons", uniswap: null };
const wrongChainEnv = env();
nonceWatch.nonceCommand({ what: "put", mark: FIXTURE.nonce, owner: "5151" });
setGate(fakeGate({
  eth_chainId: "0x1",
  ["eth_call:" + SEL.decimals]: wordHex(18),
  ["eth_call:" + SEL.balanceOf]: wordHex(2500000n * 10n ** 18n)
}));
r = await worker.fetch(post("/api/hold", { t: FIXTURE.nonce, address: FIXTURE.address, signature: FIXTURE.signature }), wrongChainEnv, ctx);
body = await r.json();
t.ok(r.status === 503 && body.ok === false && body.why === "unreadable", "the production holder route fails closed on the wrong eth_chainId");
t.ok(await wrongChainEnv.SESSIONS.get("session:5151") === null, "and the wrong network writes no holder session");

// ---------------------------------------------------------------- the durable object is exported for the migration
t.ok(typeof Tape === "function", "the worker exports the Tape class, which the migration names");
t.ok(typeof worker.scheduled === "function", "and it has a scheduled handler for the cron");

// the cron with no binding must not throw
await worker.scheduled({}, { }, ctx);
t.ok(true, "the cron with no feed binding does nothing and does not throw");

t.done();
