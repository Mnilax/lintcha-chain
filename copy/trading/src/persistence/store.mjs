import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { asBigInt, normalizeAddress, redactForAudit } from "../utils.mjs";
import { SIGNING_ARCHITECTURES, TRADING_MODES } from "../execution/authorization.mjs";

const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

function nowIso(now) {
  return new Date(now ?? Date.now()).toISOString();
}

function cleanLabel(value, label) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 64 || /[<>\u0000-\u001f]/.test(text)) throw new TypeError(`invalid ${label}`);
  return text;
}

export class TradingStore {
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(schema);
  }

  close() {
    this.db.close();
  }

  createUser({ id, telegramUserId, locale = null, now }) {
    this.db.prepare("INSERT INTO users(id,telegram_user_id,locale,created_at) VALUES(?,?,?,?)")
      .run(id, String(telegramUserId), locale, nowIso(now));
    return this.db.prepare("SELECT * FROM users WHERE id=?").get(id);
  }

  createWallet({ id, userId, publicAddress, mode, alias, verified = false, now }) {
    this.db.prepare("INSERT INTO wallets(id,user_id,public_address,wallet_mode,alias,verification_status,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(id, userId, normalizeAddress(publicAddress), mode, cleanLabel(alias, "wallet alias"), verified ? "verified" : "unverified", nowIso(now));
    this.appendAudit({ actorId: userId, action: "wallet.created", subjectType: "wallet", subjectId: id, reason: "user_action", data: { publicAddress: normalizeAddress(publicAddress), mode }, now });
    return this.db.prepare("SELECT * FROM wallets WHERE id=?").get(id);
  }

  upsertExecutionProfile({ userId, publicAddress, mode, authorizationStatus, authorizationId = null, signingArchitecture = null, authorizationExpiresAt = null, maxPerTrade, maxPerDay, allowedDirections = ["BUY"], allowedTargets = [], actorId = userId, reason = "user_action", now }) {
    if (!Object.values(TRADING_MODES).includes(mode)) throw new TypeError("invalid trading mode");
    if (!['missing','pending','active','revoked','expired'].includes(authorizationStatus)) throw new TypeError("invalid authorization status");
    if (mode === TRADING_MODES.COPY_TRADING && authorizationStatus !== "active") throw new Error("COPY_TRADING_REQUIRES_ACTIVE_AUTHORIZATION");
    if (signingArchitecture !== null && !Object.values(SIGNING_ARCHITECTURES).includes(signingArchitecture)) throw new TypeError("invalid signing architecture");
    if (authorizationStatus === "active") {
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(String(authorizationId ?? ""))) throw new TypeError("invalid authorization id");
      if (!Number.isSafeInteger(authorizationExpiresAt)) throw new TypeError("invalid authorization expiry");
    }
    const perTrade = asBigInt(maxPerTrade, "maxPerTrade");
    const perDay = asBigInt(maxPerDay, "maxPerDay");
    if (perTrade <= 0n || perDay < perTrade) throw new TypeError("invalid execution caps");
    const targets = [...new Set(allowedTargets.map(normalizeAddress))];
    const directions = [...new Set(allowedDirections.map(String))];
    if (directions.length === 0 || directions.some((direction) => !['BUY','SELL'].includes(direction))) throw new TypeError("invalid execution direction");
    if (mode === TRADING_MODES.COPY_TRADING && !directions.includes("BUY")) throw new TypeError("COPY_TRADING requires BUY authorization");
    const timestamp = nowIso(now);
    this.db.prepare(`INSERT INTO execution_profiles(
      user_id,public_address,mode,authorization_status,authorization_id,signing_architecture,
      authorization_expires_at,max_per_trade,max_per_day,allowed_directions_json,allowed_targets_json,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      public_address=excluded.public_address,mode=excluded.mode,authorization_status=excluded.authorization_status,
      authorization_id=excluded.authorization_id,signing_architecture=excluded.signing_architecture,
      authorization_expires_at=excluded.authorization_expires_at,max_per_trade=excluded.max_per_trade,
      max_per_day=excluded.max_per_day,allowed_directions_json=excluded.allowed_directions_json,allowed_targets_json=excluded.allowed_targets_json,
      revision=execution_profiles.revision+1,updated_at=excluded.updated_at`).run(
      userId, normalizeAddress(publicAddress), mode, authorizationStatus, authorizationId, signingArchitecture,
      authorizationExpiresAt, perTrade.toString(), perDay.toString(), JSON.stringify(directions), JSON.stringify(targets), timestamp, timestamp,
    );
    this.appendAudit({ actorId, action: "execution_profile.updated", subjectType: "execution_profile", subjectId: userId, reason, data: { mode, authorizationStatus, signingArchitecture, authorizationExpiresAt, maxPerTrade: perTrade.toString(), maxPerDay: perDay.toString(), allowedDirections: directions, allowedTargets: targets }, now });
    return this.getExecutionProfile(userId);
  }

  getExecutionProfile(userId) {
    const row = this.db.prepare("SELECT * FROM execution_profiles WHERE user_id=?").get(userId);
    if (!row) return null;
    return { ...row, allowed_directions: JSON.parse(row.allowed_directions_json), allowed_targets: JSON.parse(row.allowed_targets_json) };
  }

  reserveExecutionSpend({ id, userId, utcDay, amount, maxPerDay, now }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(utcDay))) throw new TypeError("invalid UTC day");
    const requested = asBigInt(amount, "amount");
    const cap = asBigInt(maxPerDay, "maxPerDay");
    if (requested <= 0n || cap <= 0n) throw new TypeError("invalid spend reservation");
    this.db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      const existing = this.db.prepare("SELECT * FROM execution_reservations WHERE id=?").get(id);
      if (existing) {
        this.db.exec("COMMIT");
        transactionOpen = false;
        return { reserved: false, duplicate: true, state: existing.state, transactionHash: existing.transaction_hash ?? null };
      }
      const active = this.db.prepare("SELECT amount FROM execution_reservations WHERE user_id=? AND utc_day=? AND state IN ('RESERVED','SIGNING','SUBMITTED','CONFIRMED')").all(userId, utcDay);
      const usedBefore = active.reduce((sum, row) => sum + asBigInt(row.amount), 0n);
      if (usedBefore + requested > cap) {
        this.db.exec("ROLLBACK");
        transactionOpen = false;
        throw new Error("EXECUTION_DAILY_CAP_EXCEEDED");
      }
      const timestamp = nowIso(now);
      this.db.prepare("INSERT INTO execution_reservations(id,user_id,utc_day,amount,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run(id, userId, utcDay, requested.toString(), "RESERVED", timestamp, timestamp);
      this.db.exec("COMMIT");
      transactionOpen = false;
      return { reserved: true, duplicate: false, state: "RESERVED", usedBefore: usedBefore.toString() };
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markExecutionReservationSigning(id, now) {
    const result = this.db.prepare("UPDATE execution_reservations SET state='SIGNING',updated_at=? WHERE id=? AND state='RESERVED'").run(nowIso(now), id);
    if (result.changes !== 1) throw new Error("EXECUTION_RESERVATION_STATE_CONFLICT");
  }

  markExecutionReservationSubmitted(id, transactionHash, now) {
    const result = this.db.prepare("UPDATE execution_reservations SET state='SUBMITTED',transaction_hash=?,updated_at=? WHERE id=? AND state='SIGNING'")
      .run(transactionHash, nowIso(now), id);
    if (result.changes !== 1) throw new Error("EXECUTION_RESERVATION_STATE_CONFLICT");
  }

  releaseExecutionReservation(id, now) {
    return this.db.prepare("UPDATE execution_reservations SET state='RELEASED',updated_at=? WHERE id=? AND state='RESERVED'").run(nowIso(now), id).changes === 1;
  }

  createManualSellIntent({ id, userId, token, amount, positionBalance, order, nowSeconds, now }) {
    const normalizedToken = normalizeAddress(token);
    const requested = asBigInt(amount, "amount");
    const balance = asBigInt(positionBalance, "positionBalance");
    if (requested <= 0n || requested > balance) throw new Error("MANUAL_SELL_BALANCE_EXCEEDED");
    if (order?.quote?.direction !== "SELL" || String(order.quote.targetToken).toLowerCase() !== normalizedToken) throw new Error("INVALID_MANUAL_SELL_ORDER");
    if (!Number.isSafeInteger(order.quote.expiresAt) || order.quote.expiresAt <= nowSeconds) throw new Error("QUOTE_EXPIRED");
    this.db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      this.db.prepare("UPDATE manual_sell_intents SET state='EXPIRED',revision=revision+1,updated_at=? WHERE state='AWAITING_CONFIRMATION' AND expires_at<=?")
        .run(nowIso(now), nowSeconds);
      const existing = this.db.prepare("SELECT * FROM manual_sell_intents WHERE id=?").get(id);
      if (existing) {
        this.db.exec("COMMIT");
        transactionOpen = false;
        return { created: false, duplicate: true, intent: existing };
      }
      const active = this.db.prepare("SELECT amount FROM manual_sell_intents WHERE user_id=? AND token=? AND state IN ('AWAITING_CONFIRMATION','SIGNING','SUBMITTED')").all(userId, normalizedToken);
      const reserved = active.reduce((sum, row) => sum + asBigInt(row.amount), 0n);
      if (reserved + requested > balance) {
        this.db.exec("ROLLBACK");
        transactionOpen = false;
        throw new Error("MANUAL_SELL_POSITION_RESERVED");
      }
      const timestamp = nowIso(now);
      this.db.prepare(`INSERT INTO manual_sell_intents(
        id,user_id,token,amount,quote_id,quote_fingerprint,order_json,state,expires_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,'AWAITING_CONFIRMATION',?,?,?)`).run(
        id, userId, normalizedToken, requested.toString(), order.quote.id, order.quoteFingerprint,
        JSON.stringify(redactForAudit(order)), order.quote.expiresAt, timestamp, timestamp,
      );
      this.db.exec("COMMIT");
      transactionOpen = false;
      return { created: true, duplicate: false, intent: this.getManualSellIntent(id) };
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getManualSellIntent(id) {
    return this.db.prepare("SELECT * FROM manual_sell_intents WHERE id=?").get(id) ?? null;
  }

  claimManualSellIntent({ id, userId, expectedRevision, now }) {
    const result = this.db.prepare("UPDATE manual_sell_intents SET state='SIGNING',revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=? AND state='AWAITING_CONFIRMATION'")
      .run(nowIso(now), id, userId, expectedRevision);
    if (result.changes !== 1) throw new Error("MANUAL_SELL_STATE_CONFLICT");
    return this.getManualSellIntent(id);
  }

  markManualSellSubmitted({ id, transactionHash, now }) {
    const result = this.db.prepare("UPDATE manual_sell_intents SET state='SUBMITTED',transaction_hash=?,revision=revision+1,updated_at=? WHERE id=? AND state='SIGNING'")
      .run(transactionHash, nowIso(now), id);
    if (result.changes !== 1) throw new Error("MANUAL_SELL_STATE_CONFLICT");
    return this.getManualSellIntent(id);
  }

  expireManualSellIntent(id, now) {
    return this.db.prepare("UPDATE manual_sell_intents SET state='EXPIRED',revision=revision+1,updated_at=? WHERE id=? AND state='AWAITING_CONFIRMATION'")
      .run(nowIso(now), id).changes === 1;
  }

  createTarget({ id, userId, sourceAddress, alias, chainId, now }) {
    const timestamp = nowIso(now);
    this.db.prepare("INSERT INTO copy_targets(id,user_id,source_address,alias,network_chain_id,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)")
      .run(id, userId, normalizeAddress(sourceAddress), cleanLabel(alias, "target alias"), chainId, timestamp, timestamp);
    this.appendAudit({ actorId: userId, action: "target.created", subjectType: "target", subjectId: id, reason: "user_action", data: { sourceAddress: normalizeAddress(sourceAddress), chainId }, now });
    return this.getTarget(id);
  }

  getTarget(id) {
    return this.db.prepare("SELECT * FROM copy_targets WHERE id=?").get(id) ?? null;
  }

  updateTarget({ id, actorId, alias, status, expectedRevision, reason, now }) {
    const current = this.getTarget(id);
    if (!current || current.revision !== expectedRevision) return null;
    const nextAlias = alias === undefined ? current.alias : cleanLabel(alias, "target alias");
    const nextStatus = status ?? current.status;
    if (!['active','paused','archived'].includes(nextStatus)) throw new TypeError("invalid target status");
    const result = this.db.prepare("UPDATE copy_targets SET alias=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
      .run(nextAlias, nextStatus, nowIso(now), id, expectedRevision);
    if (result.changes !== 1) return null;
    this.appendAudit({ actorId, action: "target.updated", subjectType: "target", subjectId: id, reason, data: { alias: nextAlias, status: nextStatus, previousRevision: expectedRevision }, now });
    return this.getTarget(id);
  }

  createRule(rule, now) {
    const timestamp = nowIso(now);
    this.db.prepare(`INSERT INTO copy_rules(
      id,target_id,direction,min_source_amount,sizing_policy,sizing_value,max_per_trade,max_per_day,
      max_slippage_bps,max_price_impact_bps,quote_ttl_seconds,cooldown_seconds,filters_json,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`).run(
      rule.id, rule.targetId, rule.direction, rule.minSourceAmount ?? null, rule.sizingPolicy, String(rule.sizingValue),
      String(rule.maxPerTrade), String(rule.maxPerDay), rule.maxSlippageBps, rule.maxPriceImpactBps,
      rule.quoteTtlSeconds, rule.cooldownSeconds, JSON.stringify(rule.filters ?? {}), timestamp, timestamp,
    );
    this.appendAudit({ actorId: rule.actorId, action: "rule.created", subjectType: "rule", subjectId: rule.id, reason: "user_action", data: rule, now });
    return this.db.prepare("SELECT * FROM copy_rules WHERE id=?").get(rule.id);
  }

  recordRuleMatch({ id, sourceEventId, ruleId, ruleRevision, matched, reason, receipt, now }) {
    const result = this.db.prepare("INSERT OR IGNORE INTO rule_matches(id,source_event_id,rule_id,rule_revision,matched,reason,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(id, sourceEventId, ruleId, ruleRevision, matched ? 1 : 0, reason, JSON.stringify(redactForAudit(receipt)), nowIso(now));
    return result.changes === 1;
  }

  claimIdempotency(scope, key, resultId, now) {
    return this.db.prepare("INSERT OR IGNORE INTO idempotency_keys(scope,key,result_id,created_at) VALUES(?,?,?,?)")
      .run(scope, key, resultId, nowIso(now)).changes === 1;
  }

  appendAudit({ actorId, action, subjectType, subjectId, reason, data = {}, now }) {
    if (!String(reason ?? "").trim()) throw new TypeError("audit reason required");
    this.db.prepare("INSERT INTO audit_events(actor_id,action,subject_type,subject_id,reason,data_json,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(actorId, action, subjectType, subjectId, reason, JSON.stringify(redactForAudit(data)), nowIso(now));
  }

  auditTrail() {
    return this.db.prepare("SELECT * FROM audit_events ORDER BY sequence").all();
  }

  safeSnapshot() {
    const tables = ["users","wallets","execution_profiles","execution_reservations","manual_sell_intents","copy_targets","copy_rules","source_events","rule_matches","daily_usage","audit_events","idempotency_keys","system_settings","referral_codes","referral_bindings","fee_schedule","referral_rates","fee_events","referral_accruals","referral_payouts","admin_audit"];
    return Object.fromEntries(tables.map((table) => [table, this.db.prepare(`SELECT * FROM ${table}`).all()]));
  }
}
