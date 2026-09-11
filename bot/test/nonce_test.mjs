// The production one-time mark store: strongly consistent SQLite inside the existing Watch Durable Object.
//
//   node test/nonce_test.mjs
import { Watch, TELEGRAM_UPDATE_TTL_MS, TELEGRAM_RENDER_LEASE_MS, DEFAULT_TELEGRAM_COMMANDS_PER_WINDOW, DEFAULT_TELEGRAM_COMMAND_WINDOW_MS } from "../src/watch.js";
import { NONCE_TTL_SECONDS } from "../src/verify.js";
import { harness, fakeWatchCtx, FIXTURE } from "./fakes.mjs";

const t = harness("nonce");
const ctx = fakeWatchCtx();
const watch = new Watch(ctx, {});
const now = Date.parse("2026-09-11T00:00:00.000Z");
const other = FIXTURE.nonce.slice(0, -1) + (FIXTURE.nonce.endsWith("0") ? "1" : "0");

let answer = watch.nonceCommand({ what: "put", mark: FIXTURE.nonce, owner: "4242" }, now);
t.ok(answer.ok === true, "a canonical mark is stored");
t.ok(ctx.nonces.get(FIXTURE.nonce).expires === now + NONCE_TTL_SECONDS * 1000, "its expiry comes from the executable holder TTL");
t.ok(watch.nonceCommand({ what: "put", mark: FIXTURE.nonce, owner: "somebody else" }, now).ok === false, "a random collision cannot overwrite the first owner");
answer = watch.nonceCommand({ what: "take", mark: FIXTURE.nonce }, now + 1);
t.ok(answer.ok === true && answer.owner === "4242", "the first take returns the owner");
t.ok(watch.nonceCommand({ what: "take", mark: FIXTURE.nonce }, now + 1).ok === false, "the second take is refused");

t.ok(watch.nonceCommand({ what: "put", mark: other.toUpperCase(), owner: "4242" }, now).ok === false, "a non-canonical mark is not stored");
t.ok(watch.nonceCommand({ what: "put", mark: other, owner: "" }, now).ok === false, "an empty owner is not stored");
watch.nonceCommand({ what: "put", mark: other, owner: "4242" }, now);
t.ok(watch.nonceCommand({ what: "take", mark: other }, now + NONCE_TTL_SECONDS * 1000).ok === false, "the expiry boundary is already expired");
t.ok(!ctx.nonces.has(other), "an expired mark is deleted when it is seen");

const orphan = FIXTURE.nonce.slice(0, -2) + (FIXTURE.nonce.endsWith("11") ? "22" : "11");
watch.nonceCommand({ what: "put", mark: orphan, owner: "4242" }, now);
await ctx.storage.setAlarm(now + NONCE_TTL_SECONDS * 2000);
watch.set("last_round_at", now + NONCE_TTL_SECONDS * 1000);
const swept = await watch.watchdog(now + NONCE_TTL_SECONDS * 1000);
t.ok(swept.woke === false && !ctx.nonces.has(orphan), "the minute watchdog physically removes an expired unused mark even while the watcher is on time");

const post = body => new Request("https://watch/nonce", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});
const liveMark = FIXTURE.nonce.slice(0, -2) + (FIXTURE.nonce.endsWith("00") ? "11" : "00");
let response = await watch.fetch(post({ what: "put", mark: liveMark, owner: "4242" }));
t.ok(response.status === 200 && (await response.json()).ok === true, "the internal endpoint stores a mark");
const raced = await Promise.all([
  watch.fetch(post({ what: "take", mark: liveMark })),
  watch.fetch(post({ what: "take", mark: liveMark }))
]);
const racedBodies = await Promise.all(raced.map(r => r.json()));
t.ok(racedBodies.filter(r => r.ok === true && r.owner === "4242").length === 1, "two concurrent takes produce exactly one owner");
t.ok(racedBodies.filter(r => r.ok === false).length === 1, "the other concurrent take is refused");

response = await watch.fetch(new Request("https://watch/nonce"));
t.ok(response.status === 405, "the internal store refuses GET");
response = await watch.fetch(new Request("https://watch/nonce", { method: "POST", body: "{" }));
t.ok(response.status === 400, "the internal store refuses malformed JSON");

// Telegram update ids are claimed in the same strongly consistent object before handler side effects.
const updatesCtx = fakeWatchCtx();
const updatesWatch = new Watch(updatesCtx, {});
t.ok(updatesWatch.claimTelegramUpdate(4242, null, now).fresh === true, "a positive safe update id is fresh once");
t.ok(updatesWatch.claimTelegramUpdate(4242, null, now + 1).fresh === false, "the same update id cannot be claimed twice");
t.ok(updatesWatch.claimTelegramUpdate(4241, null, now + 1).fresh === true, "a lower out-of-order id is independently accepted");
const beforeInvalid = updatesCtx.telegramUpdates.size;
t.ok([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4243"].every(id => updatesWatch.claimTelegramUpdate(id, null, now).ok === false),
  "zero, negative, fractional, unsafe and string update ids fail closed");
t.ok(updatesCtx.telegramUpdates.size === beforeInvalid, "invalid update ids write no dedupe state");
t.ok(updatesWatch.claimTelegramUpdate(4242, null, now + TELEGRAM_UPDATE_TTL_MS).fresh === true,
  "an id becomes fresh only at the documented webhook-retention boundary");

// A known command is claimed and rate-decided in the same transaction. Duplicates never spend twice, a
// limited fresh update remains claimed, and the fixed window resets exactly at its durable expiry.
const bucketCtx = fakeWatchCtx();
const bucketWatch = new Watch(bucketCtx, { TELEGRAM_COMMANDS_PER_WINDOW: "2", TELEGRAM_COMMAND_WINDOW_MS: "1000" });
let claim = bucketWatch.claimTelegramUpdate(6001, "77", now);
t.ok(claim.fresh === true && claim.allowed === true && claim.render === true && bucketCtx.telegramCommandBuckets.get("77").taken === 1, "the first known command takes one durable per-user place and owns its render lease");
claim = bucketWatch.claimTelegramUpdate(6001, "77", now + 1);
t.ok(claim.fresh === false && claim.allowed === true && claim.pending === true && claim.render === false && bucketCtx.telegramCommandBuckets.get("77").taken === 1,
  "a concurrent duplicate consumes no second bucket place and cannot run the handler behind the active render lease");
const leaseWatch = new Watch(fakeWatchCtx(), {});
leaseWatch.claimTelegramUpdate(6999, "77", now);
t.ok(leaseWatch.claimTelegramUpdate(6999, "77", now + TELEGRAM_RENDER_LEASE_MS - 1).render === false &&
  leaseWatch.claimTelegramUpdate(6999, "77", now + TELEGRAM_RENDER_LEASE_MS).render === true,
  "an unrendered response can be recovered only at the exact durable lease boundary");
t.ok(bucketWatch.claimTelegramUpdate(6002, "77", now + 2).allowed === true, "the configured second distinct command is allowed");
claim = bucketWatch.claimTelegramUpdate(6003, "77", now + 3);
t.ok(claim.fresh === true && claim.allowed === false && bucketCtx.telegramUpdates.has(6003), "a command beyond the window is refused but durably claimed against Telegram retry");
t.ok(bucketWatch.claimTelegramUpdate(6003, "77", now + 4).fresh === false && bucketCtx.telegramCommandBuckets.get("77").taken === 2, "retrying that limited update cannot consume or run it later");
t.ok(bucketWatch.claimTelegramUpdate(6004, "78", now + 4).allowed === true, "another Telegram user has an independent durable window");
const bucketOwnersBefore = bucketCtx.telegramCommandBuckets.size;
t.ok(bucketWatch.claimTelegramUpdate(6005, null, now + 4, false, false).allowed === false && bucketCtx.telegramCommandBuckets.size === bucketOwnersBefore,
  "a non-command update is deduped and completed without spending any user's bucket");
claim = bucketWatch.claimTelegramUpdate(6007, null, now + 5, true, false);
t.ok(claim.fresh === true && claim.allowed === false && bucketCtx.telegramUpdates.has(6007), "a known command without a canonical user is durably claimed and dropped fail-closed");
t.ok(bucketWatch.claimTelegramUpdate(6007, null, now + 6, true, false).fresh === false, "its Telegram retry is acknowledged as a duplicate instead of becoming a retry storm");
claim = bucketWatch.claimTelegramUpdate(6006, "77", now + 1000);
t.ok(claim.allowed === true && bucketCtx.telegramCommandBuckets.get("77").taken === 1 && bucketCtx.telegramCommandBuckets.get("77").expires === now + 2000,
  "the user's fixed window expires and resets at the exact TTL boundary");
const beforeBadOwner = bucketCtx.telegramUpdates.size;
t.ok(["", "077", "-1", "1.5", String(Number.MAX_SAFE_INTEGER + 1)].every(owner => bucketWatch.claimTelegramUpdate(7000, owner, now).ok === false),
  "noncanonical or unsafe Telegram user ids fail closed");
t.ok(bucketCtx.telegramUpdates.size === beforeBadOwner, "an invalid command owner cannot leave a claimed update behind");
t.ok(DEFAULT_TELEGRAM_COMMANDS_PER_WINDOW === 20 && DEFAULT_TELEGRAM_COMMAND_WINDOW_MS === 60000, "the named command-window defaults stay explicit");

const responseClaim = bucketWatch.claimTelegramUpdate(6010, "79", now + 10);
const responseActions = [
  { kind: "send", chat: 79, text: "first" },
  { kind: "send", chat: 79, text: "second", quiet: true }
];
let responseState = bucketWatch.storeTelegramResponse(6010, responseActions);
t.ok(responseClaim.pending === true && responseState.ok === true && responseState.nextAction === 0 &&
  bucketWatch.claimTelegramUpdate(6010, "79", now + 11).actions[0].text === "first",
  "a claimed command stores its exact response actions before delivery and exposes them on retry");
let sendState = bucketWatch.claimTelegramAction(6010, 0, now + 11);
const firstSendLease = sendState.leaseUntil;
t.ok(sendState.send === true && bucketWatch.claimTelegramAction(6010, 0, now + 12).send === false,
  "one worker owns the pending action while a concurrent sender is refused locally");
responseState = bucketWatch.advanceTelegramResponse(6010, 0, firstSendLease);
t.ok(responseState.pending === true && responseState.nextAction === 1 && responseState.actions[1].text === "second",
  "one accepted response advances a durable per-action cursor");
sendState = bucketWatch.claimTelegramAction(6010, 1, now + 13);
responseState = bucketWatch.advanceTelegramResponse(6010, 1, sendState.leaseUntil);
t.ok(responseState.pending === false && bucketWatch.claimTelegramUpdate(6010, "79", now + 12).pending === false,
  "the final accepted action completes the response while retaining the update-id dedupe mark");

const effectClaim = bucketWatch.claimTelegramUpdate(6011, "80", now + 20);
const effectMarkA = other.slice(0, -2) + "aa";
const effectMarkB = other.slice(0, -2) + "bb";
const firstEffect = bucketWatch.nonceCommand({ what: "put", mark: effectMarkA, owner: "80", updateId: 6011 }, now + 20);
const replayEffect = bucketWatch.nonceCommand({ what: "put", mark: effectMarkB, owner: "80", updateId: 6011 }, now + TELEGRAM_RENDER_LEASE_MS + 20);
t.ok(effectClaim.render === true && firstEffect.mark === effectMarkA && replayEffect.mark === effectMarkA &&
  bucketCtx.nonces.has(effectMarkA) && !bucketCtx.nonces.has(effectMarkB),
  "a retried verification mutation returns its first durable mark instead of issuing a second one");

const updatePost = updateId => new Request("https://watch/telegram-update", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ updateId, owner: null, metered: false, runnable: false })
});
const updateRace = await Promise.all([
  updatesWatch.fetch(updatePost(5151)),
  updatesWatch.fetch(updatePost(5151))
]);
const updateRaceBodies = await Promise.all(updateRace.map(r => r.json()));
t.ok(updateRaceBodies.filter(body => body.ok === true && body.fresh === true).length === 1,
  "two concurrent webhook claims produce exactly one fresh delivery");
t.ok(updateRaceBodies.filter(body => body.ok === true && body.fresh === false).length === 1,
  "the other concurrent webhook claim is a successful duplicate");
response = await updatesWatch.fetch(new Request("https://watch/telegram-update"));
t.ok(response.status === 405, "the update claim endpoint refuses GET");
response = await updatesWatch.fetch(new Request("https://watch/telegram-update", { method: "POST", body: "{" }));
t.ok(response.status === 400, "the update claim endpoint refuses malformed JSON");
response = await updatesWatch.fetch(updatePost(0));
t.ok(response.status === 400 && (await response.json()).ok === false, "the update claim endpoint refuses an invalid id");

t.done();
