/**
 * D1 adapters for every store contract the service uses. They speak the D1 prepared-statement API only
 * (`prepare().bind().run()/first()/all()`), so the same code runs against the node:sqlite shim in tests.
 *
 * Concurrency note (owner decision recorded in ТЗ §7): D1 alone gives no compare-and-set across statements.
 * Every mutating call for one user is therefore serialized through that user's Durable Object
 * (cloudflare/coordinator.mjs). These adapters assume that ordering and add only what SQL can guarantee:
 * unique replay keys, unique dedupe keys, primary-key idempotence.
 */
const now = () => Math.floor(Date.now() / 1000);

function rowToIntent(row) { return row ? JSON.parse(row.row_json) : null; }

export class D1IntentStore {
  constructor(db) { this.db = db; }
  async claim(row) {
    const inserted = await this.db.prepare("INSERT OR IGNORE INTO copy_confirmation_intents (id, replay_key, user_id, direction, operation, state, revision, transaction_hash, expires_at, created_at, updated_at, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.replayKey, row.userId, row.direction, row.operation, row.state, row.revision, row.transactionHash, row.expiresAt, row.createdAt, row.updatedAt, JSON.stringify(row)).run();
    if (inserted.meta.changes === 1) return { row, duplicate: false };
    const existing = await this.db.prepare("SELECT row_json FROM copy_confirmation_intents WHERE replay_key = ?").bind(row.replayKey).first();
    return { row: rowToIntent(existing), duplicate: true };
  }
  async supersede(oldRow, row) {
    oldRow.replayKey = `${oldRow.replayKey}#superseded#${row.id}`;
    await this.db.batch([
      this.db.prepare("UPDATE copy_confirmation_intents SET replay_key = ?, row_json = ?, updated_at = ? WHERE id = ?").bind(oldRow.replayKey, JSON.stringify(oldRow), now(), oldRow.id),
      this.db.prepare("INSERT INTO copy_confirmation_intents (id, replay_key, user_id, direction, operation, state, revision, transaction_hash, expires_at, created_at, updated_at, row_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(row.id, row.replayKey, row.userId, row.direction, row.operation, row.state, row.revision, row.transactionHash, row.expiresAt, row.createdAt, row.updatedAt, JSON.stringify(row)),
    ]);
    return row;
  }
  async get(id) { return rowToIntent(await this.db.prepare("SELECT row_json FROM copy_confirmation_intents WHERE id = ?").bind(id).first()); }
  async save(row) {
    await this.db.prepare("UPDATE copy_confirmation_intents SET state = ?, revision = ?, transaction_hash = ?, updated_at = ?, row_json = ? WHERE id = ?")
      .bind(row.state, row.revision, row.transactionHash, row.updatedAt, JSON.stringify(row), row.id).run();
    return row;
  }
  async listByStates(states, limit = 100) {
    const list = [...states];
    const result = await this.db.prepare(`SELECT row_json FROM copy_confirmation_intents WHERE state IN (${list.map(() => "?").join(",")}) ORDER BY updated_at ASC LIMIT ?`).bind(...list, limit).all();
    return result.results.map(rowToIntent);
  }
  async listByUser(userId, limit = 20) {
    const result = await this.db.prepare("SELECT row_json FROM copy_confirmation_intents WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").bind(String(userId), limit).all();
    return result.results.map(rowToIntent);
  }
}

export class D1SpendLedger {
  constructor(db) { this.db = db; }
  async reserve({ intentId, userId, utcDay, amountWei, maxDailySpendWei }) {
    const existing = await this.get(intentId);
    if (existing) return existing;
    const amount = BigInt(amountWei);
    if (amount < 0n) throw new Error("INVALID_SPEND");
    const rows = await this.db.prepare("SELECT amount_wei FROM copy_daily_spend_reservations WHERE user_id = ? AND utc_day = ? AND state != 'RELEASED'").bind(String(userId), utcDay).all();
    const used = rows.results.reduce((sum, row) => sum + BigInt(row.amount_wei), 0n);
    if (used + amount > BigInt(maxDailySpendWei)) throw new Error("DAILY_SPEND_CAP_EXCEEDED");
    const at = now();
    await this.db.prepare("INSERT INTO copy_daily_spend_reservations (intent_id, user_id, utc_day, amount_wei, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'RESERVED', ?, ?)").bind(intentId, String(userId), utcDay, amount.toString(), at, at).run();
    return { intentId, userId: String(userId), utcDay, amountWei: amount.toString(), state: "RESERVED" };
  }
  async commit(intentId) { await this.db.prepare("UPDATE copy_daily_spend_reservations SET state = 'COMMITTED', updated_at = ? WHERE intent_id = ?").bind(now(), intentId).run(); }
  async release(intentId) { await this.db.prepare("UPDATE copy_daily_spend_reservations SET state = 'RELEASED', updated_at = ? WHERE intent_id = ? AND state != 'COMMITTED'").bind(now(), intentId).run(); }
  async get(intentId) {
    const row = await this.db.prepare("SELECT intent_id, user_id, utc_day, amount_wei, state FROM copy_daily_spend_reservations WHERE intent_id = ?").bind(intentId).first();
    return row ? { intentId: row.intent_id, userId: row.user_id, utcDay: row.utc_day, amountWei: row.amount_wei, state: row.state } : null;
  }
}

export class D1AuditSink {
  constructor(db) { this.db = db; }
  async append(record) {
    await this.db.prepare("INSERT INTO copy_audit_log (sequence, event_hash, previous_hash, event_type, public_payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(record.sequence, record.hash, record.previousHash, record.type, JSON.stringify(record.payload), record.at).run();
  }
  /** The hash chain continues from the last stored record rather than restarting per isolate. */
  async head() {
    const row = await this.db.prepare("SELECT sequence, event_hash FROM copy_audit_log ORDER BY sequence DESC LIMIT 1").first();
    return row ? { sequence: row.sequence, hash: row.event_hash } : { sequence: 0, hash: "0".repeat(64) };
  }
}

export class D1ReplayStore {
  constructor(db) { this.db = db; }
  async claim(key, expiresAt, nowSeconds) {
    await this.db.prepare("DELETE FROM copy_gateway_replays WHERE expires_at <= ?").bind(nowSeconds).run();
    const result = await this.db.prepare("INSERT OR IGNORE INTO copy_gateway_replays (replay_key, expires_at) VALUES (?, ?)").bind(String(key), expiresAt).run();
    return result.meta.changes === 1;
  }
}

export class D1UserStore {
  constructor(db, clock = now) { this.db = db; this.clock = clock; }
  #map(row) { return row ? { telegramUserId: row.telegram_user_id, privateChatId: row.private_chat_id, mode: row.mode, paused: row.paused, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
  async get(telegramUserId) { return this.#map(await this.db.prepare("SELECT * FROM copy_users WHERE telegram_user_id = ?").bind(String(telegramUserId)).first()); }
  async upsert({ telegramUserId, privateChatId, mode, paused }) {
    const id = String(telegramUserId);
    const at = this.clock();
    if (mode !== undefined && !["NOTIFY_ONLY", "CONFIRM_EACH"].includes(mode)) throw new Error("INVALID_USER_MODE");
    await this.db.prepare("INSERT OR IGNORE INTO copy_users (telegram_user_id, private_chat_id, mode, paused, created_at, updated_at) VALUES (?, ?, 'NOTIFY_ONLY', 1, ?, ?)").bind(id, privateChatId === undefined ? null : String(privateChatId), at, at).run();
    await this.db.prepare("UPDATE copy_users SET mode = COALESCE(?, mode), paused = COALESCE(?, paused), private_chat_id = COALESCE(?, private_chat_id), updated_at = ? WHERE telegram_user_id = ?")
      .bind(mode ?? null, paused === undefined ? null : (paused ? 1 : 0), privateChatId === undefined ? null : String(privateChatId), at, id).run();
    return this.get(id);
  }
  async wallets(telegramUserId) {
    const result = await this.db.prepare("SELECT public_address, wallet_kind, public_label, created_at FROM copy_wallets WHERE telegram_user_id = ? ORDER BY created_at ASC").bind(String(telegramUserId)).all();
    return result.results.map((row) => ({ publicAddress: row.public_address, walletKind: row.wallet_kind, publicLabel: row.public_label, createdAt: row.created_at }));
  }
  async addWallet({ telegramUserId, publicAddress, walletKind = "EXTERNAL", publicLabel = null }) {
    if (!/^0x[0-9a-f]{40}$/.test(publicAddress)) throw new Error("INVALID_PUBLIC_ADDRESS");
    if (!["EXTERNAL", "LOCAL_SECURE_SHEET"].includes(walletKind)) throw new Error("INVALID_WALLET_KIND");
    const existing = await this.wallets(telegramUserId);
    if (existing.length >= 5 && !existing.some((row) => row.publicAddress === publicAddress)) throw new Error("WALLET_LIMIT_REACHED");
    await this.db.prepare("INSERT OR IGNORE INTO copy_wallets (telegram_user_id, public_address, wallet_kind, public_label, created_at) VALUES (?, ?, ?, ?, ?)").bind(String(telegramUserId), publicAddress, walletKind, publicLabel, this.clock()).run();
    return this.wallets(telegramUserId);
  }
}

export class D1OutboxStore {
  constructor(db, clock = now) { this.db = db; this.clock = clock; }
  async enqueue({ telegramUserId, privateChatId, text, inlineKeyboard = [], dedupeKey = null }) {
    const result = await this.db.prepare("INSERT OR IGNORE INTO copy_outbox (telegram_user_id, private_chat_id, text, inline_keyboard_json, dedupe_key, state, attempts, lease_until, created_at) VALUES (?, ?, ?, ?, ?, 'PENDING', 0, 0, ?)")
      .bind(String(telegramUserId), String(privateChatId), text, JSON.stringify(inlineKeyboard), dedupeKey, this.clock()).run();
    return result.meta.changes === 1 ? { id: String(result.meta.last_row_id), telegramUserId: String(telegramUserId), privateChatId: String(privateChatId), text, inlineKeyboard, dedupeKey, state: "PENDING" } : null;
  }
  async lease(limit, nowSeconds, leaseSeconds = 60) {
    const rows = await this.db.prepare("SELECT id, telegram_user_id, private_chat_id, text, inline_keyboard_json, attempts FROM copy_outbox WHERE state = 'PENDING' AND lease_until <= ? ORDER BY id ASC LIMIT ?").bind(nowSeconds, limit).all();
    const leased = [];
    for (const row of rows.results) {
      const claimed = await this.db.prepare("UPDATE copy_outbox SET lease_until = ?, attempts = attempts + 1 WHERE id = ? AND lease_until <= ?").bind(nowSeconds + leaseSeconds, row.id, nowSeconds).run();
      if (claimed.meta.changes !== 1) continue;
      leased.push({ id: String(row.id), telegramUserId: row.telegram_user_id, privateChatId: row.private_chat_id, text: row.text, inlineKeyboard: JSON.parse(row.inline_keyboard_json), attempts: row.attempts + 1 });
    }
    return leased;
  }
  async ack(id) { await this.db.prepare("UPDATE copy_outbox SET state = 'SENT' WHERE id = ?").bind(Number(id)).run(); }
  async fail(id, reason) {
    await this.db.prepare("UPDATE copy_outbox SET last_error = ?, state = CASE WHEN attempts >= 10 THEN 'DEAD' ELSE state END WHERE id = ?").bind(String(reason).slice(0, 64), Number(id)).run();
  }
}

export class D1KillSwitchStore {
  constructor(db) { this.db = db; }
  async rows() {
    const result = await this.db.prepare("SELECT scope, subject_id, paused, revision FROM copy_kill_switches").all();
    return result.results.map((row) => ({ scope: row.scope, subjectId: row.subject_id, paused: row.paused, revision: row.revision }));
  }
  async persist(snapshot, { actorId, reason }) {
    const at = now();
    const statements = [
      this.db.prepare("INSERT INTO copy_kill_switches (scope, subject_id, paused, revision, reason, actor_id, updated_at) VALUES ('GLOBAL', 'global', ?, ?, ?, ?, ?) ON CONFLICT(scope, subject_id) DO UPDATE SET paused = excluded.paused, revision = excluded.revision, reason = excluded.reason, actor_id = excluded.actor_id, updated_at = excluded.updated_at").bind(snapshot.global.paused, snapshot.revision, reason || "", actorId || "owner", at),
      this.db.prepare("UPDATE copy_kill_switches SET paused = 0, revision = ?, reason = ?, actor_id = ?, updated_at = ? WHERE scope = 'USER'").bind(snapshot.revision, reason || "", actorId || "owner", at),
      ...snapshot.users.map((row) => this.db.prepare("INSERT INTO copy_kill_switches (scope, subject_id, paused, revision, reason, actor_id, updated_at) VALUES ('USER', ?, 1, ?, ?, ?, ?) ON CONFLICT(scope, subject_id) DO UPDATE SET paused = 1, revision = excluded.revision, reason = excluded.reason, actor_id = excluded.actor_id, updated_at = excluded.updated_at").bind(row.subjectId, snapshot.revision, reason || "", actorId || "owner", at)),
    ];
    await this.db.batch(statements);
  }
}
