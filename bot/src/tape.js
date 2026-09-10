// The feed, as one Durable Object on SQLite.
//
// The shape, and why it is this shape:
//
//   alarm()  reads the token's Transfer log from the last block it saw, posts the buys to the room, keeps the
//            sells as a count, and sets the next alarm. The interval is a setting and starts at twelve seconds,
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

import { readToken, hasToken, venueOf, blockNumber, transfersAround, gateStats, decimalsOf } from "./chain.js";
import { sendMessage, code, link } from "./telegram.js";
import { shortAddress, formatUnits, SITE } from "./texts.js";

export const DEFAULT_INTERVAL_MS = 12000;
export const DEFAULT_WATCHDOG_MS = 90000;
/** how many blocks one round will read at most, so a long sleep cannot ask for the whole chain at once */
export const DEFAULT_MAX_BLOCKS = 2000;

/** Whether there is anything at all to schedule. The one question the empty state turns on. */
export const shouldSchedule = token => hasToken(token);

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)",
  "CREATE TABLE IF NOT EXISTS buys (tx TEXT NOT NULL, log INTEGER NOT NULL, wallet TEXT NOT NULL, amount TEXT NOT NULL, block INTEGER NOT NULL, PRIMARY KEY (tx, log))",
  "CREATE TABLE IF NOT EXISTS wallets (wallet TEXT PRIMARY KEY, first_block INTEGER NOT NULL, buys INTEGER NOT NULL, total TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS buys_block ON buys (block)"
];

export class Tape {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env || {};
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
  }

  // ---------------------------------------------------------------- the four helpers everything else uses
  get(k, dflt = null) {
    const rows = [...this.sql.exec("SELECT v FROM kv WHERE k = ?", k)];
    return rows.length ? rows[0].v : dflt;
  }
  set(k, v) { this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v)); }
  num(k, dflt = 0) { const v = this.get(k); return v === null ? dflt : Number(v); }
  bump(k, by = 1) { this.set(k, this.num(k) + by); }

  intervalMs() { return Math.max(1000, Number(this.env.FEED_INTERVAL_MS || DEFAULT_INTERVAL_MS)); }
  watchdogMs() { return Math.max(this.intervalMs() * 3, Number(this.env.FEED_WATCHDOG_MS || DEFAULT_WATCHDOG_MS)); }
  maxBlocks() { return Math.max(1, Number(this.env.FEED_MAX_BLOCKS || DEFAULT_MAX_BLOCKS)); }
  room() { return this.env.ROOM_CHAT_ID || null; }

  // ---------------------------------------------------------------- the object's http face
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");
    if (path === "tick") { const r = await this.tick(Date.now()); return json(r); }
    if (path === "watchdog") { const r = await this.watchdog(Date.now()); return json(r); }
    if (path === "stats") return json(this.statsRow());
    if (path === "top") return json(this.topRows());
    if (path === "state") return json({ lastBlock: this.lastBlock(), interval: this.intervalMs(), alarm: await this.ctx.storage.getAlarm() });
    return new Response(null, { status: 404 });
  }

  lastBlock() { const v = this.get("last_block"); return v === null ? null : Number(v); }

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
      retries: s ? s.retries : this.num("retries")
    };
  }

  topRows(limit = 10) {
    return [...this.sql.exec("SELECT wallet, buys, total FROM wallets ORDER BY CAST(total AS REAL) DESC LIMIT ?", limit)]
      .map(r => ({ wallet: r.wallet, buys: Number(r.buys), total: r.total }));
  }

  // ---------------------------------------------------------------- one round
  /**
   * Read what happened since the last block seen, post the buys, count the sells, schedule the next round.
   * Returns a small record of what it did, which is what the tests read.
   */
  async tick(now) {
    const token = await readToken(this.env, now);
    if (!token.ok) return await this.retreat("site");          // could not read the site: try again, say nothing
    if (!shouldSchedule(token)) {
      await this.ctx.storage.deleteAlarm();
      this.set("idle_reason", "no address on the site");
      return { ran: false, why: "no token", scheduled: false };
    }

    const venue = await venueOf(this.env, token.address);
    if (!venue) return await this.retreat("venue");

    const head = await blockNumber(this.env);
    if (head === null) return await this.retreat("head");

    const last = this.lastBlock();
    // the first round does not replay history: the feed starts where it wakes up, and /top says "since the
    // feed went up" for exactly that reason
    if (last === null) {
      this.set("last_block", head);
      this.set("started_block", head);
      this.bump("rounds");
      await this.schedule(now);
      return { ran: true, first: true, from: head, to: head, buys: 0, sells: 0, scheduled: true };
    }

    const from = last + 1;
    const to = Math.min(head, from + this.maxBlocks() - 1);
    if (to < from) { this.bump("rounds"); await this.schedule(now); return { ran: true, from, to: last, buys: 0, sells: 0, scheduled: true }; }

    const split = await transfersAround(this.env, token.address, venue, from, to);
    if (split === null) return await this.retreat("logs");

    const decimals = await decimalsOf(this.env, token.address);
    let posted = 0;
    for (const b of split.buys) if (this.record(b)) { if (await this.post(b, token, decimals)) posted++; }
    if (split.sells.length) this.bump("sells", split.sells.length);
    this.set("last_block", to);
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

  /** Remember a buy once. Returns false when it was already recorded, so a repeated range cannot post twice. */
  record(b) {
    const already = [...this.sql.exec("SELECT 1 AS one FROM buys WHERE tx = ? AND log = ?", b.tx, b.logIndex)];
    if (already.length) return false;
    this.sql.exec("INSERT INTO buys (tx, log, wallet, amount, block) VALUES (?, ?, ?, ?, ?)", b.tx, b.logIndex, b.wallet, String(b.amount), b.block);
    const rows = [...this.sql.exec("SELECT buys, total FROM wallets WHERE wallet = ?", b.wallet)];
    if (rows.length) {
      this.sql.exec("UPDATE wallets SET buys = ?, total = ? WHERE wallet = ?", Number(rows[0].buys) + 1, String(BigInt(rows[0].total) + b.amount), b.wallet);
      b.firstTime = false;
    } else {
      this.sql.exec("INSERT INTO wallets (wallet, first_block, buys, total) VALUES (?, ?, ?, ?)", b.wallet, b.block, 1, String(b.amount));
      this.bump("new_wallets");
      b.firstTime = true;
    }
    this.bump("buys");
    return true;
  }

  /** One line in the room. Only the fields that were actually read appear in it. */
  async post(b, token, decimals) {
    const room = this.room();
    if (!room) return false;
    const lines = [code(shortAddress(b.wallet)) + (b.firstTime ? " bought for the first time" : " bought again")];
    // the amount in whole tokens only when the chain gave the decimals; otherwise the line says what it read
    // and no more, rather than printing a number scaled by a guess
    if (decimals === null || decimals === undefined) lines.push("The amount is in the transaction; I could not read the token's decimals to state it in whole tokens.");
    else lines.push(code(formatUnits(b.amount, decimals)) + " $LINTCHA out of the pool");
    const tx = this.env.TX_URL_PREFIX ? this.env.TX_URL_PREFIX + b.tx : null;
    const tail = [];
    if (tx) tail.push(link("transaction", tx));
    if (token.pons) tail.push(link("chart", token.pons));
    tail.push(link("site", SITE));
    lines.push("", tail.join(" · "));
    return await sendMessage(this.env, room, lines.join("\n"), { quiet: true });
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
    const token = await readToken(this.env, now);
    if (!shouldSchedule(token)) return { woke: false, why: "no token" };
    const lastAt = this.num("last_round_at", 0);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm !== null && alarm !== undefined && lastAt && now - lastAt < this.watchdogMs()) return { woke: false, why: "on time" };
    if (lastAt) {
      const seconds = Math.round((now - lastAt) / 1000);
      this.bump("gaps");
      const room = this.room();
      if (room) await sendMessage(this.env, room, "The feed stopped for about " + seconds + " seconds and is running again. Buys in that gap will appear as I read the blocks I missed; nothing is dropped and nothing is guessed at.", { quiet: true });
    }
    await this.schedule(now);
    return { woke: true, gapSeconds: lastAt ? Math.round((now - lastAt) / 1000) : null };
  }
}

const json = v => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
