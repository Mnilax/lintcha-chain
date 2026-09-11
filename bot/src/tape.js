// The feed, as one Durable Object on SQLite.
//
// The shape, and why it is this shape:
//
//   alarm()  first drains one pending room line; with no backlog it reads the token's Transfer log from the
//            last block it saw, queues the buys, keeps the sells as a count, and sets the next alarm. The
//            interval is a setting and starts at twelve seconds,
//            because a cron cannot go under a minute and a feed that lags a minute is not a feed.
//   cron     is only a watchdog. Once a minute it asks whether a round has happened recently, and when one has
//            not it wakes the object and says so in the room. A gap that nobody mentions is a gap that looks
//            like an absence of buys.
//
//   While the site carries no address, no alarm is set at all. Not a short one, not a retrying one: none. There
//   is nothing to read, so there is nothing to schedule, and the object stays asleep costing nothing.
//
// Sells: counted, shown in /stats, never posted. That is a choice about which facts reach the room, so /start
// says it out loud with the reason. Neither half of that arrangement is optional.
//
// Every storage call goes through the four small helpers below and every unit of work is tick(), so the whole
// object can be driven in a plain test with a fake context and no runtime at all.

import { readToken, hasToken, chainIsOurs, venueOf, blockNumber, transfersAround, gateStats, decimalsOf, DEFAULT_MAX_TRANSFER_LOGS, TRANSFER_LOGS_OVERFLOW } from "./chain.js";
import { sendMessage, code, link, TELEGRAM_TEXT_LIMIT } from "./telegram.js";
import { shortAddress, formatUnits, SITE } from "./texts.js";
import { requiredHttpsUrlOf } from "../../lib/config-contract.mjs";
import { integerSetting } from "./config.js";

export const DEFAULT_INTERVAL_MS = 12000;
export const DEFAULT_WATCHDOG_MS = 90000;
/** how many blocks one round will read at most, so a long sleep cannot ask for the whole chain at once */
export const DEFAULT_MAX_BLOCKS = 2000;
export const DEFAULT_MAX_LOGS = DEFAULT_MAX_TRANSFER_LOGS;
/** Product bound for Telegram work in one beat; deployment may tighten it but cannot raise the hard ceiling. */
export const DEFAULT_DELIVERY_BATCH = 1;
export const MAX_DELIVERY_BATCH = 1;
/** Conservative per-room attempt window, persisted so isolate restarts cannot create a burst. */
export const DELIVERY_WINDOW_LIMIT = 20;
export const DELIVERY_WINDOW_MS = 60000;

/** Whether there is anything at all to schedule. The one question the empty state turns on. */
export const shouldSchedule = token => hasToken(token);

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)",
  "CREATE TABLE IF NOT EXISTS buys (tx TEXT NOT NULL, log INTEGER NOT NULL, wallet TEXT NOT NULL, amount TEXT NOT NULL, block INTEGER NOT NULL, block_hash TEXT NOT NULL, PRIMARY KEY (tx, log))",
  "CREATE TABLE IF NOT EXISTS buy_delivery (tx TEXT NOT NULL, log INTEGER NOT NULL, block INTEGER NOT NULL, block_hash TEXT NOT NULL, wallet TEXT NOT NULL, amount TEXT NOT NULL, chat TEXT NOT NULL, body TEXT NOT NULL, sent INTEGER NOT NULL, last_attempt INTEGER NOT NULL, PRIMARY KEY (tx, log))",
  "CREATE TABLE IF NOT EXISTS wallets (wallet TEXT PRIMARY KEY, first_block INTEGER NOT NULL, buys INTEGER NOT NULL, total TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS buys_block ON buys (block)",
  "CREATE INDEX IF NOT EXISTS buy_delivery_block ON buy_delivery (block)"
];

export class Tape {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env || {};
    this.running = false;
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    const buyColumns = [...this.sql.exec("PRAGMA table_info(buys)")];
    if (!buyColumns.some(column => column && String(column.name).toLowerCase() === "block_hash")) {
      this.sql.exec("ALTER TABLE buys ADD COLUMN block_hash TEXT NOT NULL DEFAULT ''");
    }
    const deliveryColumns = [...this.sql.exec("PRAGMA table_info(buy_delivery)")];
    if (!deliveryColumns.some(column => column && String(column.name).toLowerCase() === "block_hash")) {
      this.sql.exec("ALTER TABLE buy_delivery ADD COLUMN block_hash TEXT NOT NULL DEFAULT ''");
    }
    if (!deliveryColumns.some(column => column && String(column.name).toLowerCase() === "last_attempt")) {
      this.sql.exec("ALTER TABLE buy_delivery ADD COLUMN last_attempt INTEGER NOT NULL DEFAULT 0");
    }
    this.sql.exec("CREATE INDEX IF NOT EXISTS buys_position ON buys (block, log)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS buy_delivery_position ON buy_delivery (block, log)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS buy_delivery_retry_position ON buy_delivery (sent, last_attempt, block, log, tx)");
  }

  // ---------------------------------------------------------------- the four helpers everything else uses
  get(k, dflt = null) {
    const rows = [...this.sql.exec("SELECT v FROM kv WHERE k = ?", k)];
    return rows.length ? rows[0].v : dflt;
  }
  set(k, v) { this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v)); }
  del(k) { this.sql.exec("DELETE FROM kv WHERE k = ?", k); }
  num(k, dflt = 0) { const v = this.get(k); return v === null ? dflt : Number(v); }
  bump(k, by = 1) { this.set(k, this.num(k) + by); }

  intervalMs() {
    const configured = integerSetting(this.env.FEED_INTERVAL_MS, DEFAULT_INTERVAL_MS, { min: 0, max: DEFAULT_WATCHDOG_MS });
    return Math.max(1000, configured);
  }
  watchdogMs() {
    const configured = integerSetting(this.env.FEED_WATCHDOG_MS, DEFAULT_WATCHDOG_MS, { min: 0, max: DEFAULT_WATCHDOG_MS * 3 });
    return Math.max(this.intervalMs() * 3, configured);
  }
  maxBlocks() {
    return integerSetting(this.env.FEED_MAX_BLOCKS, DEFAULT_MAX_BLOCKS, { min: 1, max: DEFAULT_MAX_BLOCKS, invalid: 1 });
  }
  maxLogs() {
    return integerSetting(this.env.FEED_MAX_LOGS, DEFAULT_MAX_LOGS, { min: 1, max: DEFAULT_MAX_LOGS, invalid: 1 });
  }
  deliveryBatch() {
    return integerSetting(this.env.FEED_DELIVERY_BATCH, DEFAULT_DELIVERY_BATCH, { min: 1, max: MAX_DELIVERY_BATCH });
  }
  takeDeliveryAttempt(now) {
    if (!Number.isSafeInteger(now) || now < 0) return null;
    const startRaw = this.get("delivery_window_start"), takenRaw = this.get("delivery_window_taken");
    if (startRaw === null && takenRaw === null) {
      this.set("delivery_window_start", now);
      this.set("delivery_window_taken", 1);
      return true;
    }
    if (startRaw === null || takenRaw === null || !/^(?:0|[1-9]\d*)$/.test(startRaw) || !/^(?:0|[1-9]\d*)$/.test(takenRaw)) return null;
    const start = Number(startRaw), taken = Number(takenRaw);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(taken) || start < 0 || taken < 1 || start > now) return null;
    if (now - start >= DELIVERY_WINDOW_MS) {
      this.set("delivery_window_start", now);
      this.set("delivery_window_taken", 1);
      return true;
    }
    if (taken >= DELIVERY_WINDOW_LIMIT) return false;
    this.set("delivery_window_taken", taken + 1);
    return true;
  }
  room() { return this.env.ROOM_CHAT_ID || null; }

  // ---------------------------------------------------------------- the object's http face
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");
    if (path === "tick") { const r = await this.tick(Date.now()); return json(r); }
    if (path === "watchdog") { const r = await this.watchdog(Date.now()); return json(r); }
    if (path === "stats") return json(this.statsRow());
    if (path === "state") return json({
      lastBlock: this.lastBlock(),
      lastChainReadAt: storedNonnegativeInteger(this.get("last_chain_read_at")),
      deliveryBacklog: this.deliveryBacklog(),
      interval: this.intervalMs(),
      alarm: await this.ctx.storage.getAlarm()
    });
    return new Response(null, { status: 404 });
  }

  lastBlock() { const v = this.get("last_block"); return v === null ? null : Number(v); }
  deliveryBacklog() {
    const rows = [...this.sql.exec("SELECT COUNT(*) AS n FROM buy_delivery WHERE sent = ?", 0)];
    const count = rows.length === 1 ? Number(rows[0].n) : NaN;
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  }

  statsRow() {
    const s = gateStats();
    return {
      buys: this.num("buys"),
      sells: this.num("sells"),
      wallets: [...this.sql.exec("SELECT COUNT(*) AS n FROM wallets")][0].n,
      newWallets: this.num("new_wallets"),
      lastBlock: this.lastBlock(),
      rounds: this.num("rounds"),
      gaps: this.num("gaps"),
      limited: s ? s.http429 + s.rpc429 : this.num("limited"),
      retries: s ? s.retries : this.num("retries"),
      deliveryBacklog: this.deliveryBacklog(),
      lastChainReadAt: storedNonnegativeInteger(this.get("last_chain_read_at"))
    };
  }

  // ---------------------------------------------------------------- one round
  /**
   * Drain pending delivery, then read what happened since the last block seen, queue buys, count sells and
   * schedule the next round.
   * Returns a small record of what it did, which is what the tests read.
   */
  async tick(now) {
    if (this.running) return { ran: false, why: "in flight", scheduled: true };
    this.running = true;
    try { return await this.tickOnce(now); }
    finally { this.running = false; }
  }

  async tickOnce(now) {
    // Pending room lines are self-contained. Retry them before the site or RPC so a token-file change or an
    // endpoint outage cannot strand a buy that was already observed and durably queued.
    const recovered = await this.flushDeliveries(now);
    if (!recovered.ok) return await this.retreat("telegram");
    let posted = recovered.posted;
    if (recovered.pending) {
      // Drain already-observed room lines before reading another range. This keeps a Telegram outage from
      // growing the durable backlog without bound, while last_attempt rotation prevents one bad row from
      // hiding later accepted lines.
      this.set("last_round_at", now);
      this.bump("rounds");
      await this.schedule(now);
      return { ran: false, why: "delivery backlog", posted, scheduled: true };
    }
    const token = await readToken(this.env, now);
    if (!token.ok) return await this.retreat("site");          // could not read the site: try again, say nothing
    if (!shouldSchedule(token)) {
      await this.ctx.storage.deleteAlarm();
      this.set("idle_reason", "no address on the site");
      return { ran: false, why: "no token", scheduled: false };
    }
    if (!await chainIsOurs(this.env)) return await this.retreat("chain");

    const venue = await venueOf(this.env, token.address);
    if (!venue) return await this.retreat("venue");

    const head = await blockNumber(this.env);
    if (head === null) return await this.retreat("head");

    const last = this.lastBlock();
    // the first round does not replay history: the feed starts where it wakes up, and /stats says "since the
    // feed went up" for exactly that reason
    if (last === null) {
      this.set("last_block", head);
      this.set("started_block", head);
      this.set("last_chain_read_at", now);
      this.bump("rounds");
      await this.schedule(now);
      return { ran: true, first: true, from: head, to: head, buys: 0, posted, sells: 0, scheduled: true };
    }

    const from = last + 1;
    let to = Math.min(head, from + this.maxBlocks() - 1);
    if (to < from) { this.set("last_chain_read_at", now); this.bump("rounds"); await this.schedule(now); return { ran: true, from, to: last, buys: 0, posted, sells: 0, scheduled: true }; }

    let split;
    while (true) {
      split = await transfersAround(this.env, token.address, venue, from, to, this.maxLogs());
      if (split !== TRANSFER_LOGS_OVERFLOW) break;
      if (to === from) {
        this.set("last_log_overflow_block", from);
        return await this.retreat("log overflow");
      }
      // Retry only the first block. Repeatedly bisecting a long sparse page plus one header proof per fact block
      // could spend more external calls than the page ceiling was meant to prevent.
      to = from;
    }
    if (split === null) return await this.retreat("logs");

    const decimals = await decimalsOf(this.env, token.address);
    if (this.lastBlock() !== last) return await this.retreat("cursor changed");
    for (const b of split.buys) {
      // Queue before changing the wallet table: that is the only moment when "first time" can be rendered
      // exactly. A crash before record() leaves a pending row and an unchanged cursor; replay records the buy
      // before attempting the already-rendered line. A confirmed line is remembered until the cursor commits.
      if (!this.queueDelivery(b, token, decimals)) return await this.retreat("delivery");
      if (this.record(b) === null) return await this.retreat("delivery");
    }
    if (split.sells.length) this.bump("sells", split.sells.length);
    // Dedupe rows protect an unfinished range across a crash. Once the finalized cursor is durable that range
    // is never read again, so its per-log rows no longer carry information and can be retired. If cleanup is
    // interrupted, the next successful range deletes the older rows too.
    this.set("last_block", to);
    this.set("last_chain_read_at", now);
    this.sql.exec("DELETE FROM buy_delivery WHERE block <= ? AND sent = ?", to, 1);
    this.sql.exec("DELETE FROM buys WHERE block <= ?", to);
    this.set("last_round_at", now);
    this.bump("rounds");
    await this.schedule(now);
    return { ran: true, from, to, buys: split.buys.length, posted, sells: split.sells.length, scheduled: true };
  }

  /** A read failed. Keep the block cursor where it is, count it, and try again on the usual beat. */
  async retreat(why) {
    this.bump("failed_reads");
    this.set("last_fail", why);
    await this.schedule(Date.now());
    return { ran: false, why, scheduled: true };
  }

  /** Remember a buy once. true is fresh, false is an exact replay, null is an unrepresentable conflict. */
  record(b) {
    const observed = canonicalBuyOf(b);
    if (!observed) return null;
    const atPosition = [...this.sql.exec("SELECT tx, log, block, block_hash, wallet, amount FROM buys WHERE block = ? AND log = ?", observed.block, observed.logIndex)];
    const atIdentity = [...this.sql.exec("SELECT tx, log, block, block_hash, wallet, amount FROM buys WHERE tx = ? AND log = ?", observed.tx, observed.logIndex)];
    const prior = [...atPosition, ...atIdentity];
    if (prior.length) return prior.every(row => sameBuy(row, observed)) ? false : null;
    this.sql.exec("INSERT INTO buys (tx, log, wallet, amount, block, block_hash) VALUES (?, ?, ?, ?, ?, ?)",
      observed.tx, observed.logIndex, observed.wallet, String(observed.amount), observed.block, observed.blockHash);
    const rows = [...this.sql.exec("SELECT buys, total FROM wallets WHERE wallet = ?", observed.wallet)];
    if (rows.length) {
      this.sql.exec("UPDATE wallets SET buys = ?, total = ? WHERE wallet = ?", Number(rows[0].buys) + 1, String(BigInt(rows[0].total) + observed.amount), observed.wallet);
      b.firstTime = false;
    } else {
      this.sql.exec("INSERT INTO wallets (wallet, first_block, buys, total) VALUES (?, ?, ?, ?)", observed.wallet, observed.block, 1, String(observed.amount));
      this.bump("new_wallets");
      b.firstTime = true;
    }
    this.bump("buys");
    return true;
  }

  /** Render and durably queue one room line before wallet state changes. No room means no delivery contract. */
  queueDelivery(b, token, decimals) {
    const observed = canonicalBuyOf(b);
    if (!observed) return false;
    const recordedAt = [...this.sql.exec("SELECT tx, log, block, block_hash, wallet, amount FROM buys WHERE block = ? AND log = ?", observed.block, observed.logIndex)];
    const recordedAs = [...this.sql.exec("SELECT tx, log, block, block_hash, wallet, amount FROM buys WHERE tx = ? AND log = ?", observed.tx, observed.logIndex)];
    if ([...recordedAt, ...recordedAs].some(row => !sameBuy(row, observed))) return false;
    const atPosition = [...this.sql.exec("SELECT tx, log, block, block_hash, wallet, amount, chat, body, sent FROM buy_delivery WHERE block = ? AND log = ?", observed.block, observed.logIndex)];
    const atIdentity = [...this.sql.exec("SELECT tx, log, block, block_hash, wallet, amount, chat, body, sent FROM buy_delivery WHERE tx = ? AND log = ?", observed.tx, observed.logIndex)];
    const deliveries = [...atPosition, ...atIdentity];
    if (deliveries.length) return deliveries.every(row => sameBuy(row, observed) && (Number(row.sent) === 0 || Number(row.sent) === 1));
    const room = this.room();
    if (!room) return true;
    // A recorded row without its room line means the crash boundary or room configuration changed. Inventing
    // first-time wording from the now-mutated wallet table would produce a different observation, so stop.
    if (recordedAt.length || recordedAs.length) return false;
    const firstTime = ![...this.sql.exec("SELECT buys, total FROM wallets WHERE wallet = ?", observed.wallet)].length;
    const body = this.postText({ ...observed, firstTime }, token, decimals);
    this.sql.exec(
      "INSERT INTO buy_delivery (tx, log, block, block_hash, wallet, amount, chat, body, sent, last_attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      observed.tx, observed.logIndex, observed.block, observed.blockHash, observed.wallet, String(observed.amount), String(room), body, 0, 0
    );
    return true;
  }

  /** One durable system line shares the room delivery window. A pending notice is never overwritten. */
  noticeDelivery() {
    const encoded = this.get("notice_delivery");
    if (encoded === null) return null;
    let raw;
    try { raw = JSON.parse(encoded); } catch { return false; }
    const made = raw && storedNonnegativeInteger(raw.made), lastAttempt = raw && storedNonnegativeInteger(raw.lastAttempt);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.chat !== "string" || !raw.chat ||
        typeof raw.body !== "string" || !raw.body || raw.body.length > TELEGRAM_TEXT_LIMIT || made === null || lastAttempt === null) return false;
    return { chat: raw.chat, body: raw.body, made, lastAttempt };
  }

  queueNotice(chat, body, made) {
    const existing = this.noticeDelivery();
    if (existing === false) return null;
    if (existing) return false;
    if (chat === null || chat === undefined || !String(chat) || typeof body !== "string" || !body ||
        body.length > TELEGRAM_TEXT_LIMIT || !Number.isSafeInteger(made) || made < 0) return null;
    this.set("notice_delivery", JSON.stringify({ chat: String(chat), body, made, lastAttempt: 0 }));
    return true;
  }

  clearNotice() {
    this.del("notice_delivery");
  }

  /** Deliver a queued line. A false answer leaves it pending; the durable row, not an RPC replay, owns retry. */
  async deliver(b) {
    const observed = canonicalBuyOf(b);
    if (!observed) return { ok: false, posted: false };
    const rows = [...this.sql.exec("SELECT tx, log, block, block_hash, wallet, amount, chat, body, sent FROM buy_delivery WHERE block = ? AND log = ?", observed.block, observed.logIndex)];
    if (!rows.length) return { ok: true, posted: false };
    if (rows.length !== 1 || !sameBuy(rows[0], observed)) return { ok: false, posted: false };
    if (Number(rows[0].sent) === 1) return { ok: true, posted: false };
    if (Number(rows[0].sent) !== 0) return { ok: false, posted: false };
    if (!await sendMessage(this.env, rows[0].chat, rows[0].body, { quiet: true })) return { ok: false, posted: false };
    this.sql.exec("UPDATE buy_delivery SET sent = ? WHERE tx = ? AND log = ?", 1, observed.tx, observed.logIndex);
    return { ok: true, posted: true };
  }

  /** Retry one bounded, fairly rotated batch; malformed durable state closes instead of guessing. */
  async flushDeliveries(now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0) return { ok: false, posted: 0, pending: true };
    const durableCursor = this.lastBlock();
    if (durableCursor !== null && (!Number.isSafeInteger(durableCursor) || durableCursor < 0)) return { ok: false, posted: 0, pending: true };
    const rows = [...this.sql.exec(
      "SELECT tx, log, block, block_hash, wallet, amount, last_attempt FROM buy_delivery WHERE sent = ? ORDER BY last_attempt, block, log, tx LIMIT ?",
      0, this.deliveryBatch()
    )];
    let posted = 0, ok = true;
    const notice = this.noticeDelivery();
    if (notice === false) return { ok: false, posted, pending: true };
    // The hard batch is one. Pick the least-recently-attempted kind so a refused system notice cannot starve
    // buys, and a refused buy cannot erase the promised gap notice.
    if (notice && (!rows.length || notice.lastAttempt <= Number(rows[0].last_attempt))) {
      const allowed = this.takeDeliveryAttempt(now);
      if (allowed === null) return { ok: false, posted, pending: true };
      if (allowed) {
        this.set("notice_delivery", JSON.stringify({ ...notice, lastAttempt: now }));
        if (await sendMessage(this.env, notice.chat, notice.body, { quiet: true })) this.clearNotice();
        else ok = false;
      }
      const buyPending = [...this.sql.exec("SELECT 1 AS one FROM buy_delivery WHERE sent = ? LIMIT 1", 0)].length > 0;
      return { ok, posted, pending: buyPending || this.noticeDelivery() !== null };
    }
    for (const row of rows) {
      const logIndex = Number(row.log), block = Number(row.block);
      const tx = typeof row.tx === "string" && /^0x[0-9a-f]{64}$/.test(row.tx) ? row.tx : null;
      const wallet = typeof row.wallet === "string" && /^0x[0-9a-f]{40}$/.test(row.wallet) ? row.wallet : null;
      const blockHash = typeof row.block_hash === "string" && /^0x[0-9a-f]{64}$/.test(row.block_hash) && !/^0x0{64}$/.test(row.block_hash) ? row.block_hash : null;
      const amountText = String(row.amount);
      const lastAttempt = Number(row.last_attempt);
      if (!tx || !wallet || !blockHash || !Number.isSafeInteger(logIndex) || logIndex < 0 || !Number.isSafeInteger(block) || block < 0 ||
          !Number.isSafeInteger(lastAttempt) || lastAttempt < 0 || !/^(?:0|[1-9]\d*)$/.test(amountText)) {
        return { ok: false, posted, pending: true };
      }
      const allowed = this.takeDeliveryAttempt(now);
      if (allowed === null) return { ok: false, posted, pending: true };
      if (!allowed) break;
      this.sql.exec("UPDATE buy_delivery SET last_attempt = ? WHERE tx = ? AND log = ?", now, tx, logIndex);
      const buy = { tx, blockHash, logIndex, block, wallet, amount: BigInt(amountText) };
      // If the durable cursor already covers this block, queue+wallet accounting committed before it and the
      // completed-range buy dedupe row may already be gone. Re-recording here would count the same buy twice.
      // A legacy/uncommitted pending row ahead of the cursor still goes through record(), whose dedupe protects it.
      if ((durableCursor === null || block > durableCursor) && this.record(buy) === null) return { ok: false, posted, pending: true };
      const delivery = await this.deliver(buy);
      if (!delivery.ok) ok = false;
      else if (delivery.posted) posted++;
    }
    if (durableCursor !== null) this.sql.exec("DELETE FROM buy_delivery WHERE block <= ? AND sent = ?", durableCursor, 1);
    const pending = [...this.sql.exec("SELECT 1 AS one FROM buy_delivery WHERE sent = ? LIMIT 1", 0)].length > 0 || this.noticeDelivery() !== null;
    return { ok, posted, pending };
  }

  /** One line in the room. Only the fields that were actually read appear in it. */
  postText(b, token, decimals) {
    const lines = [code(shortAddress(b.wallet)) + (b.firstTime ? " bought for the first time" : " bought again")];
    // the amount in whole tokens only when the chain gave the decimals; otherwise the line says what it read
    // and no more, rather than printing a number scaled by a guess
    if (decimals === null || decimals === undefined) lines.push("The amount is in the transaction; I could not read the token's decimals to state it in whole tokens.");
    else lines.push(code(formatUnits(b.amount, decimals)) + " $LINTCHA out of the pool");
    const tx = this.env.TX_URL_PREFIX ? requiredHttpsUrlOf(this.env.TX_URL_PREFIX + b.tx) : null;
    const tail = [];
    if (tx) tail.push(link("transaction", tx));
    if (token.pons) tail.push(link("chart", token.pons));
    tail.push(link("site", SITE));
    lines.push("", tail.join(" · "));
    return lines.join("\n");
  }

  /** The next round, on the beat, and only ever one alarm outstanding. */
  async schedule(now) {
    await this.ctx.storage.setAlarm(now + this.intervalMs());
    return true;
  }

  async alarm() { await this.tick(Date.now()); }

  /**
   * The watchdog, from cron. If a round has not happened inside the watchdog window, say so in the room and
   * start the feed again. A silent gap reads as an absence of buys, which would be a false statement.
   */
  async watchdog(now) {
    if (this.running) return { woke: false, why: "in flight" };
    this.running = true;
    try { return await this.watchdogOnce(now); }
    finally { this.running = false; }
  }

  async watchdogOnce(now) {
    const token = await readToken(this.env, now);
    if (!shouldSchedule(token)) return { woke: false, why: "no token" };
    if (!await chainIsOurs(this.env)) return { woke: false, why: "chain" };
    const lastAt = storedNonnegativeInteger(this.get("last_chain_read_at"));
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm !== null && alarm !== undefined && lastAt !== null && now - lastAt < this.watchdogMs()) return { woke: false, why: "on time" };
    if (lastAt !== null && this.get("gap_noticed_for") !== String(lastAt)) {
      const seconds = Math.round((now - lastAt) / 1000);
      this.bump("gaps");
      const room = this.room();
      if (room) {
        const backlog = this.deliveryBacklog();
        if (backlog === null) return { woke: false, why: "delivery state" };
        const body = backlog > 0
          ? "The feed has not read a new chain range for about " + seconds + " seconds because it is draining durable room lines. Buys in unread blocks will appear after that backlog; nothing already observed is dropped or guessed at."
          : "The feed stopped reading new chain ranges for about " + seconds + " seconds and is running again. Buys in that gap will appear as I read the blocks I missed; nothing is dropped and nothing is guessed at.";
        const queued = this.queueNotice(room, body, now);
        if (queued === null) return { woke: false, why: "notice state" };
      }
      this.set("gap_noticed_for", lastAt);
    }
    const delivery = await this.flushDeliveries(now);
    await this.schedule(now);
    return {
      woke: true,
      gapSeconds: lastAt === null ? null : Math.round((now - lastAt) / 1000),
      noticePending: !delivery.ok || this.noticeDelivery() !== null,
      deliveryBacklog: this.deliveryBacklog()
    };
  }
}

const canonicalBuyOf = buy => {
  if (!buy || typeof buy !== "object" || Array.isArray(buy) || typeof buy.amount !== "bigint" || buy.amount < 0n) return null;
  const tx = typeof buy.tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(buy.tx) && !/^0x0{64}$/i.test(buy.tx)
    ? buy.tx.toLowerCase() : null;
  const blockHash = typeof buy.blockHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(buy.blockHash) && !/^0x0{64}$/i.test(buy.blockHash)
    ? buy.blockHash.toLowerCase() : null;
  const wallet = typeof buy.wallet === "string" && /^0x[0-9a-fA-F]{40}$/.test(buy.wallet)
    && !/^0x0{40}$/i.test(buy.wallet) ? buy.wallet.toLowerCase() : null;
  const block = Number.isSafeInteger(buy.block) && buy.block >= 0 ? buy.block : null;
  const logIndex = Number.isSafeInteger(buy.logIndex) && buy.logIndex >= 0 ? buy.logIndex : null;
  return tx && blockHash && wallet && block !== null && logIndex !== null
    ? { tx, blockHash, wallet, block, logIndex, amount: buy.amount }
    : null;
};

const sameBuy = (row, buy) => row && Number(row.block) === buy.block && Number(row.log) === buy.logIndex &&
  String(row.tx).toLowerCase() === buy.tx && String(row.block_hash).toLowerCase() === buy.blockHash &&
  String(row.wallet).toLowerCase() === buy.wallet && String(row.amount) === String(buy.amount);

const storedNonnegativeInteger = value => {
  if (value === null || value === undefined || !/^(?:0|[1-9]\d*)$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

const json = v => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
