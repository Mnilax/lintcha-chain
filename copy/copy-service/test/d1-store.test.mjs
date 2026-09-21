import test from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./fake-d1.mjs";
import { D1AuditSink, D1DelegationStore, D1IntentStore, D1KillSwitchStore, D1OutboxStore, D1ReplayStore, D1SpendLedger, D1UserStore } from "../src/cloudflare/d1-store.mjs";
import { HashChainedAuditLog } from "../src/audit.mjs";
import { KillSwitches } from "../src/policy.mjs";
import { HASH, ROUTER, WALLET, fixture, input, openAndSubmit } from "./helpers.mjs";

test("D1 intent store claims replay keys atomically, supersedes retryable rows and round-trips the full record", async () => {
  const db = fakeD1();
  const store = new D1IntentStore(db);
  const row = { id: "a".repeat(64), replayKey: "rk", userId: "42", direction: "BUY", operation: "TRADE", state: "CREATING", revision: 1, transactionHash: null, expiresAt: 10, createdAt: 1, updatedAt: 1, history: [], quote: { amountIn: "500" } };
  assert.equal((await store.claim(row)).duplicate, false);
  const again = await store.claim({ ...row, id: "b".repeat(64) });
  assert.equal(again.duplicate, true);
  assert.equal(again.row.id, row.id);
  row.state = "REJECTED"; row.revision = 2; row.updatedAt = 2;
  await store.save(row);
  const fresh = { ...row, id: "c".repeat(64), state: "CREATING", revision: 1, replayKey: "rk" };
  await store.supersede(row, fresh);
  assert.equal((await store.get(row.id)).replayKey.includes("#superseded#"), true);
  assert.equal((await store.claim({ ...fresh, id: "d".repeat(64) })).row.id, fresh.id);
  assert.equal((await store.listByStates(new Set(["CREATING"]))).length, 1);
  assert.equal((await store.listByUser("42")).length, 2);
  assert.deepEqual((await store.get(row.id)).quote, { amountIn: "500" });
});

test("D1 spend ledger reserves against the day, commits and releases; BigInt-safe above int64", async () => {
  const db = fakeD1();
  const ledger = new D1SpendLedger(db);
  const big = (10n ** 19n).toString();
  const first = await ledger.reserve({ intentId: "i1", userId: "42", utcDay: "2026-09-20", amountWei: big, maxDailySpendWei: (2n * 10n ** 19n).toString() });
  assert.equal(first.state, "RESERVED");
  assert.deepEqual(await ledger.reserve({ intentId: "i1", userId: "42", utcDay: "2026-09-20", amountWei: big, maxDailySpendWei: big }), first);
  await assert.rejects(ledger.reserve({ intentId: "i2", userId: "42", utcDay: "2026-09-20", amountWei: (10n ** 19n + 1n).toString(), maxDailySpendWei: (2n * 10n ** 19n).toString() }), /DAILY_SPEND_CAP_EXCEEDED/);
  await ledger.release("i1");
  assert.equal((await ledger.get("i1")).state, "RELEASED");
  await ledger.reserve({ intentId: "i2", userId: "42", utcDay: "2026-09-20", amountWei: big, maxDailySpendWei: big });
  await ledger.commit("i2");
  await ledger.release("i2");
  assert.equal((await ledger.get("i2")).state, "COMMITTED");
});

test("D1 audit sink resumes the hash chain; replay store is single-use until expiry; users, wallets, outbox and kill switches persist", async () => {
  const db = fakeD1();
  const sink = new D1AuditSink(db);
  const first = await HashChainedAuditLog.resume({ sink, clock: () => 1 });
  const a = await first.append("A", { x: 1 });
  const second = await HashChainedAuditLog.resume({ sink, clock: () => 2 });
  const b = await second.append("B", { y: 2 });
  assert.equal(b.previousHash, a.hash);
  assert.equal(b.sequence, 2);
  await assert.rejects(second.append("C", { privateKey: "x" }), /SENSITIVE/);

  const replays = new D1ReplayStore(db);
  assert.equal(await replays.claim("u1", 100, 50), true);
  assert.equal(await replays.claim("u1", 100, 50), false);
  assert.equal(await replays.claim("u1", 200, 150), true);

  const users = new D1UserStore(db, () => 7);
  assert.equal((await users.upsert({ telegramUserId: "42", privateChatId: "99" })).paused, 1);
  assert.equal((await users.upsert({ telegramUserId: "42", mode: "CONFIRM_EACH", paused: false })).mode, "CONFIRM_EACH");
  assert.equal((await users.get("42")).privateChatId, "99");
  await users.recordReferral({ telegramUserId: "42", source: "SITE" });
  await users.recordReferral({ telegramUserId: "42", source: "SITE" });
  await users.upsert({ telegramUserId: "43" });
  await users.recordReferral({ telegramUserId: "43", source: "SITE" });
  assert.deepEqual(await users.referralStats("SITE"), { source: "SITE", uniqueUsers: 2, starts: 3 });
  await assert.rejects(users.recordReferral({ telegramUserId: "42", source: "AD" }), /INVALID_REFERRAL_SOURCE/);
  await assert.rejects(users.upsert({ telegramUserId: "42", mode: "AUTO" }), /INVALID_USER_MODE/);
  assert.equal((await users.addWallet({ telegramUserId: "42", publicAddress: WALLET })).length, 1);
  assert.equal((await users.addWallet({ telegramUserId: "42", publicAddress: WALLET })).length, 1);
  await assert.rejects(users.addWallet({ telegramUserId: "42", publicAddress: "0xabc" }), /INVALID_PUBLIC_ADDRESS/);
  assert.equal((await users.upsert({ telegramUserId: "42", mode: "AUTO_BUY" })).mode, "AUTO_BUY");

  const delegations = new D1DelegationStore(db, () => 7);
  const delegation = await delegations.put({ userId: "42", walletAddress: WALLET, architecture: "EIP7702_SESSION", authorizationRef: "auth:d1:test:42", chainId: 4663, routers: [ROUTER], selectors: ["0x12345678"], maxTransactionWei: "500", maxDailySpendWei: "900", maxSlippageBps: 50, expiresAt: 100 });
  assert.equal(delegation.walletAddress, WALLET);
  assert.equal((await delegations.getActive("42", WALLET)).authorizationRef, "auth:d1:test:42");
  await delegations.revoke("42", WALLET);
  assert.equal(await delegations.getActive("42", WALLET), null);

  const outbox = new D1OutboxStore(db, () => 7);
  assert.equal((await outbox.enqueue({ telegramUserId: "42", privateChatId: "99", text: "hi", dedupeKey: "k" })).id, "1");
  assert.equal(await outbox.enqueue({ telegramUserId: "42", privateChatId: "99", text: "hi", dedupeKey: "k" }), null);
  const leased = await outbox.lease(5, 10);
  assert.equal(leased.length, 1);
  assert.equal((await outbox.lease(5, 10)).length, 0);
  assert.equal((await outbox.lease(5, 100)).length, 1);
  await outbox.ack("1");
  assert.equal((await outbox.lease(5, 1000)).length, 0);

  const switches = new D1KillSwitchStore(db);
  assert.equal(KillSwitches.load(await switches.rows()).globallyPaused, true);
  const live = new KillSwitches({ globallyPaused: true });
  live.resumeGlobal(); live.pauseUser("7"); live.pauseWallet(WALLET);
  await switches.persist(live.snapshot(), { actorId: "owner", reason: "beta" });
  const reloaded = KillSwitches.load(await switches.rows());
  assert.equal(reloaded.globallyPaused, false);
  assert.equal(reloaded.isPaused("7"), true);
  assert.equal(reloaded.isPaused("42", WALLET), true);
  live.resumeUser("7"); live.resumeWallet(WALLET);
  await switches.persist(live.snapshot(), { actorId: "owner", reason: "ok" });
  assert.equal(KillSwitches.load(await switches.rows()).isPaused("7"), false);
  assert.equal(KillSwitches.load(await switches.rows()).isPaused("42", WALLET), false);
});

test("the whole service runs on the D1 adapters end to end", async () => {
  const db = fakeD1();
  const current = fixture();
  current.service.intentStore = new D1IntentStore(db);
  current.policyGate.spendLedger = new D1SpendLedger(db);
  current.service.auditLog = await HashChainedAuditLog.resume({ sink: new D1AuditSink(db), clock: () => 1 });
  const created = await current.service.createConfirmEachIntent(input());
  assert.equal(created.state, "AWAITING_USER_CONFIRMATION");
  assert.equal((await current.service.createConfirmEachIntent(input())).duplicate, true);
  await openAndSubmit(current, created);
  const reconciled = await current.service.reconcile(created.intentId);
  assert.equal(reconciled.state, "CONFIRMED");
  assert.equal((await current.policyGate.spendLedger.get(created.intentId)).state, "COMMITTED");
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM copy_audit_log").first()).n, 3);
  assert.equal(JSON.stringify((await db.prepare("SELECT row_json FROM copy_confirmation_intents").all()).results).includes(HASH), true);
});
