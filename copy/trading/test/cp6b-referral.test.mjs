import assert from "node:assert/strict";
import { test } from "node:test";
import { FeeSchedule, FREE_PERIOD_SECONDS } from "../src/fee/fee-policy.mjs";
import { TradingStore } from "../src/persistence/store.mjs";
import { AdminAuthorizer, ReferralLedger } from "../src/referral/referral.mjs";

const asset = "0x9999999999999999999999999999999999999999";
const tx = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function setup() {
  const store = new TradingStore();
  store.createUser({ id: "owner", telegramUserId: "1", now: 0 });
  store.createUser({ id: "referrer", telegramUserId: "2", now: 0 });
  store.createUser({ id: "invited", telegramUserId: "3", now: 0 });
  const ledger = new ReferralLedger({ store, codeSecret: "TEST_REFERRAL_CODE_SECRET_NOT_REAL", adminAuthorizer: new AdminAuthorizer("owner") });
  const code = ledger.createCode({ ownerUserId: "referrer", nonce: "fixture", nowSeconds: 0 });
  ledger.bind({ invitedUserId: "invited", code, nowSeconds: 1 });
  store.db.prepare("INSERT INTO fee_schedule(version,activation_at,free_until,fee_bps,created_at) VALUES(1,?,?,100,?)")
    .run(new Date(0).toISOString(), new Date(FREE_PERIOD_SECONDS * 1000).toISOString(), new Date(0).toISOString());
  return { store, ledger, code };
}

test("CP6B: first binding is immutable and self-referral is rejected", () => {
  const { store, ledger, code } = setup();
  assert.throws(() => ledger.bind({ invitedUserId: "invited", code, nowSeconds: 2 }), /REFERRAL_ALREADY_BOUND/);
  const own = ledger.createCode({ ownerUserId: "owner", nonce: "self", nowSeconds: 0 });
  assert.throws(() => ledger.bind({ invitedUserId: "owner", code: own, nowSeconds: 2 }), /SELF_REFERRAL/);
  assert.doesNotMatch(code, /referrer|2/);
  store.close();
});

test("CP6B: free period creates zero fee and no referral accrual", () => {
  const { store, ledger } = setup();
  const schedule = new FeeSchedule({ version: 1, activationAtSeconds: 0 });
  const preview = schedule.preview({ timestampSeconds: FREE_PERIOD_SECONDS - 1, feeBaseAmount: "100000", feeAsset: asset });
  const result = ledger.recordFinalizedFee({ orderId: "free-order", userId: "invited", transactionHash: tx, receiptBlock: 1, feeAsset: asset, feeBase: preview.feeBase, feeAmount: preview.feeAmount, scheduleVersion: 1, tradeAtSeconds: FREE_PERIOD_SECONDS - 1, nowSeconds: FREE_PERIOD_SECONDS });
  assert.equal(result.accrual, null);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM fee_events").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM referral_accruals").get().n, 0);
  store.close();
});

test("CP6B: finalized active-fee trade creates one fee event and one 20% accrual", () => {
  const { store, ledger } = setup();
  const schedule = new FeeSchedule({ version: 1, activationAtSeconds: 0 });
  const preview = schedule.preview({ timestampSeconds: FREE_PERIOD_SECONDS, feeBaseAmount: "100000", feeAsset: asset });
  const input = { orderId: "paid-order", userId: "invited", transactionHash: tx, receiptBlock: 2, feeAsset: asset, feeBase: preview.feeBase, feeAmount: preview.feeAmount, scheduleVersion: 1, tradeAtSeconds: FREE_PERIOD_SECONDS, nowSeconds: FREE_PERIOD_SECONDS + 1 };
  const result = ledger.recordFinalizedFee(input);
  assert.equal(result.accrual.shareBps, 2000);
  assert.equal(result.accrual.amount, "200");
  assert.equal(ledger.recordFinalizedFee(input).duplicate, true);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM fee_events").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM referral_accruals").get().n, 1);
  store.close();
});

test("CP6B: audited override is capped at 60% and applies only forward", () => {
  const { store, ledger } = setup();
  const admin = { actorId: "owner", strongAuth: true, stepUp: true, reason: "fixture promotion" };
  ledger.setOverride({ referrerUserId: "referrer", shareBps: 6000, effectiveFromSeconds: 100, nowSeconds: 50, admin });
  assert.equal(ledger.rateAt("referrer", 99), 2000);
  assert.equal(ledger.rateAt("referrer", 100), 6000);
  assert.throws(() => ledger.setOverride({ referrerUserId: "referrer", shareBps: 6001, effectiveFromSeconds: 101, nowSeconds: 50, admin }), /OUT_OF_RANGE/);
  assert.throws(() => ledger.setOverride({ referrerUserId: "referrer", shareBps: 5000, effectiveFromSeconds: 101, nowSeconds: 50, admin: { ...admin, stepUp: false } }), /STEP_UP/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM admin_audit").get().n, 1);
  store.close();
});

test("CP6B: payout remains disabled while asset/minimum/cadence are unresolved", () => {
  const { store, ledger } = setup();
  const admin = { actorId: "owner", strongAuth: true, stepUp: true, reason: "fixture payout" };
  assert.throws(() => ledger.preparePayout({ referrerUserId: "referrer", asset, amount: "1", payoutPolicy: null, nowSeconds: 1, admin }), /PAYOUT_POLICY_UNRESOLVED/);
  store.close();
});
