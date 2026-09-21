import { createHmac } from "node:crypto";
import { asBigInt, deterministicId, normalizeAddress, redactForAudit } from "../utils.mjs";

export const DEFAULT_REFERRAL_SHARE_BPS = 2000;
export const REFERRAL_SHARE_HARD_CAP_BPS = 6000;

function iso(seconds) {
  return new Date(seconds * 1000).toISOString();
}

export class AdminAuthorizer {
  constructor(ownerActorId) {
    this.ownerActorId = String(ownerActorId);
  }

  require(context) {
    if (String(context.actorId) !== this.ownerActorId) throw new Error("ADMIN_OWNER_REQUIRED");
    if (context.strongAuth !== true || context.stepUp !== true) throw new Error("ADMIN_STEP_UP_REQUIRED");
    if (!String(context.reason ?? "").trim()) throw new Error("ADMIN_REASON_REQUIRED");
    return true;
  }
}

export class ReferralLedger {
  constructor({ store, codeSecret, adminAuthorizer }) {
    this.store = store;
    this.db = store.db;
    this.codeSecret = codeSecret;
    this.adminAuthorizer = adminAuthorizer;
  }

  createCode({ ownerUserId, nonce, nowSeconds }) {
    const code = createHmac("sha256", this.codeSecret).update(`${ownerUserId}\n${nonce}`).digest("base64url").slice(0, 20);
    this.db.prepare("INSERT INTO referral_codes(code,owner_user_id,status,created_at) VALUES(?,?,'active',?)").run(code, ownerUserId, iso(nowSeconds));
    return code;
  }

  bind({ invitedUserId, code, nowSeconds }) {
    const ref = this.db.prepare("SELECT * FROM referral_codes WHERE code=? AND status='active'").get(code);
    if (!ref) throw new Error("REFERRAL_CODE_INVALID");
    if (ref.owner_user_id === invitedUserId) throw new Error("SELF_REFERRAL");
    const result = this.db.prepare("INSERT OR IGNORE INTO referral_bindings(invited_user_id,referrer_user_id,code,created_at) VALUES(?,?,?,?)")
      .run(invitedUserId, ref.owner_user_id, code, iso(nowSeconds));
    if (result.changes !== 1) throw new Error("REFERRAL_ALREADY_BOUND");
    return { invitedUserId, referrerUserId: ref.owner_user_id, code };
  }

  setOverride({ referrerUserId, shareBps, effectiveFromSeconds, nowSeconds, admin }) {
    this.adminAuthorizer.require(admin);
    if (!Number.isSafeInteger(shareBps) || shareBps < 0 || shareBps > REFERRAL_SHARE_HARD_CAP_BPS) throw new Error("REFERRAL_SHARE_OUT_OF_RANGE");
    if (!Number.isSafeInteger(effectiveFromSeconds) || effectiveFromSeconds < nowSeconds) throw new Error("OVERRIDE_MUST_BE_FUTURE_ONLY");
    const id = deterministicId(referrerUserId, shareBps, effectiveFromSeconds, admin.actorId, admin.reason);
    this.db.prepare("INSERT INTO referral_rates(id,referrer_user_id,share_bps,effective_from,actor_id,reason,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, referrerUserId, shareBps, iso(effectiveFromSeconds), admin.actorId, admin.reason, iso(nowSeconds));
    this.#adminAudit(admin, "referral.override", { referrerUserId, shareBps, effectiveFromSeconds });
    return id;
  }

  rateAt(referrerUserId, tradeAtSeconds) {
    const row = this.db.prepare("SELECT share_bps FROM referral_rates WHERE (referrer_user_id=? OR referrer_user_id IS NULL) AND effective_from<=? ORDER BY (referrer_user_id IS NOT NULL) DESC,effective_from DESC LIMIT 1")
      .get(referrerUserId, iso(tradeAtSeconds));
    return row?.share_bps ?? DEFAULT_REFERRAL_SHARE_BPS;
  }

  recordFinalizedFee({ orderId, userId, transactionHash, receiptBlock, feeAsset, feeBase, feeAmount, scheduleVersion, tradeAtSeconds, nowSeconds }) {
    const amount = asBigInt(feeAmount, "feeAmount");
    const feeId = deterministicId("fee", orderId);
    const insert = this.db.prepare("INSERT OR IGNORE INTO fee_events(id,order_id,transaction_hash,receipt_block,fee_asset,fee_base,fee_amount,schedule_version,state,created_at) VALUES(?,?,?,?,?,?,?,?,'FINALIZED',?)")
      .run(feeId, orderId, transactionHash, receiptBlock, normalizeAddress(feeAsset), asBigInt(feeBase).toString(), amount.toString(), scheduleVersion, iso(nowSeconds));
    if (insert.changes !== 1) return { duplicate: true, feeEventId: feeId, accrual: null };
    if (amount === 0n) return { duplicate: false, feeEventId: feeId, accrual: null };
    const binding = this.db.prepare("SELECT b.referrer_user_id,c.status FROM referral_bindings b JOIN referral_codes c ON c.code=b.code WHERE b.invited_user_id=?").get(userId);
    if (!binding || binding.status !== "active") return { duplicate: false, feeEventId: feeId, accrual: null };
    const shareBps = this.rateAt(binding.referrer_user_id, tradeAtSeconds);
    const reward = amount * BigInt(shareBps) / 10000n;
    const accrual = {
      id: deterministicId("accrual", feeId), feeEventId: feeId, referrerUserId: binding.referrer_user_id,
      shareBps, asset: normalizeAddress(feeAsset), amount: reward.toString(), state: "pending",
    };
    this.db.prepare("INSERT INTO referral_accruals(id,fee_event_id,referrer_user_id,share_bps,asset,amount,state,created_at) VALUES(?,?,?,?,?,?,'pending',?)")
      .run(accrual.id, feeId, accrual.referrerUserId, shareBps, accrual.asset, accrual.amount, iso(nowSeconds));
    return { duplicate: false, feeEventId: feeId, accrual };
  }

  preparePayout({ referrerUserId, asset, amount, payoutPolicy, nowSeconds, admin }) {
    this.adminAuthorizer.require(admin);
    if (!payoutPolicy?.asset || payoutPolicy.minimumAmount === undefined || !payoutPolicy.cadence) throw new Error("PAYOUT_POLICY_UNRESOLVED");
    const normalizedAsset = normalizeAddress(asset);
    if (normalizeAddress(payoutPolicy.asset) !== normalizedAsset) throw new Error("PAYOUT_ASSET_NOT_ALLOWED");
    const requested = asBigInt(amount);
    if (requested < asBigInt(payoutPolicy.minimumAmount)) throw new Error("PAYOUT_BELOW_MINIMUM");
    const rows = this.db.prepare("SELECT amount FROM referral_accruals WHERE referrer_user_id=? AND asset=? AND state='pending'").all(referrerUserId, normalizedAsset);
    const pending = rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    if (requested > pending) throw new Error("PAYOUT_EXCEEDS_PENDING");
    const id = deterministicId("payout", referrerUserId, normalizedAsset, requested, nowSeconds);
    this.db.prepare("INSERT INTO referral_payouts(id,asset,amount,state,created_by,reason,created_at,updated_at) VALUES(?,?,?,'prepared',?,?,?,?)")
      .run(id, normalizedAsset, requested.toString(), admin.actorId, admin.reason, iso(nowSeconds), iso(nowSeconds));
    this.#adminAudit(admin, "payout.prepared", { id, referrerUserId, asset: normalizedAsset, amount: requested.toString() });
    return { id, state: "prepared", amount: requested.toString(), asset: normalizedAsset };
  }

  #adminAudit(admin, action, data) {
    this.db.prepare("INSERT INTO admin_audit(actor_id,action,reason,data_json,created_at) VALUES(?,?,?,?,?)")
      .run(admin.actorId, action, admin.reason, JSON.stringify(redactForAudit(data)), new Date().toISOString());
  }
}
