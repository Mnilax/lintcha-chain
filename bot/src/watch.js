// The watcher: the live tail of the launch log, and the rules read against it.
//
// Why there is a tail at all, rather than a live database. The index the page reads is a snapshot: collected
// up to a block, written to a file, hashed, and rebuildable by a command anyone can run. Two published things
// depend on that being true — the Reproduce it section prints the file's hash and the command, and the never
// list says that if the site computes something the repository cannot, the repository is decoration. A live
// database whose range moves cannot be rebuilt and compared, so replacing the snapshot with one would quietly
// break both. The snapshot therefore stays exactly as it is and gets a tail: everything after its last block
// lives here, is handed out with its own block range and its own hash, and a collector run over that range
// reproduces it. bot/tools/verify-tail.mjs is that comparison, in two commands.
//
// The shape is the feed's shape, from bot/src/tape.js, on purpose: one alarm, one unit of work called tick(),
// four storage helpers, and a cron that is only a watchdog. What differs, and why:
//
//   no token needed   the feed sleeps until the site carries an address, because it reads that token's
//                     transfers. The watcher reads the factory's own log, which exists whether $LINTCHA does
//                     or not, so it starts as soon as it is deployed.
//   no alarm with no   while the endpoint cannot be reached there is no alarm at all. Not a short one, not a
//   RPC               retrying one: none. There is nothing readable, so there is nothing to schedule, and the
//                     cron is what tries again a minute later.
//   nothing said in    a gap in the feed is announced in the room, because a silent gap there reads as an
//   the room          absence of buys. A gap here costs the people with rules, so it is counted and shown in
//                     /rules to exactly them, rather than broadcast to a room that did not ask.
//
// Every hash in here comes out of site/launch.js, loaded and not copied. See bot/src/engine.js.

import { rpcGate, FACTORY, SEL, chainId, CHAIN_ID } from "./chain.js";
import { selector, topic } from "./keccak.js";
import { decodeParams, TOKEN_INFO, LAUNCHED_TOKEN, T as ABI } from "../../tools/launch/abi.mjs";
import { check as engineCheck, engineSelfTest, LINKS, ENGINE_PATH } from "./engine.js";
import { Tally, rowOf, tallyHash, entryCounts } from "./tally.js";
import { Rules, match, rifleOf } from "./rules.js";
import { getSession } from "./verify.js";
import { sendMessage, link } from "./telegram.js";
import * as TEXT from "./texts.js";

export const DEFAULT_INTERVAL_MS = 12000;
export const DEFAULT_WATCHDOG_MS = 90000;
export const DEFAULT_MAX_BLOCKS = 2000;
/** how far back the tail keeps launches. Older than this is already covered by the snapshot. */
export const DEFAULT_DEPTH_DAYS = 7;
/** the tail's answer is built once and handed out for this long */
export const DEFAULT_TAIL_CACHE_MS = 5000;
/** the published index changes weekly, so a ten minute memory of it is fresh by a wide margin */
export const DEFAULT_INDEX_TTL_MS = 600000;
/** how many times one block range is retried when a launch in it will not read, before it is skipped */
export const READ_ATTEMPTS = 3;

export const INDEX_URL = "https://chain.lintcha.com/launch-index.json";
export const NUMBERS_URL = "https://chain.lintcha.com/launch-numbers.json";

// The factory's launch log, and the three reads per token the collector makes. The signatures are hashed at
// run time, exactly as tools/launch-collect.mjs hashes them, so a pinned selector cannot drift from a
// signature. getLaunchedToken comes from chain.js's SEL, because there is one of it in this worker.
export const TOPIC_TOKEN_LAUNCHED = topic("TokenLaunched(address,address,address,address,uint256,uint256)");
export const SEL_TOKEN = {
  name: selector("name()"),
  symbol: selector("symbol()"),
  info: selector("getTokenInfo()")
};

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)",
  "CREATE TABLE IF NOT EXISTS tail (token TEXT PRIMARY KEY, block INTEGER NOT NULL, ts INTEGER NOT NULL, date TEXT NOT NULL, deployer TEXT NOT NULL, tx TEXT NOT NULL, row TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS tail_hash (token TEXT NOT NULL, ns TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (token, ns, hash))",
  "CREATE INDEX IF NOT EXISTS tail_block ON tail (block)",
  "CREATE INDEX IF NOT EXISTS tail_hash_ns ON tail_hash (ns, hash)"
];

// the published index and the snapshot's own numbers, in this isolate's memory only
let indexCache = { at: 0, value: null };
let numbersCache = { at: 0, value: null };
/** Only for tests: drop what this isolate remembers of the two published files. */
export function forgetPublished() { indexCache = { at: 0, value: null }; numbersCache = { at: 0, value: null }; }

const hexNum = n => "0x" + BigInt(n).toString(16);
const asNumber = h => Number(BigInt(h));
const lower = a => String(a == null ? "" : a).toLowerCase();
const pad = a => String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const addressOfTopic = t => "0x" + String(t).slice(26).toLowerCase();
const dateOfSeconds = ts => new Date(Number(ts) * 1000).toISOString().slice(0, 10);

export class Watch {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env || {};
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    this.rules = new Rules(this.sql);
    this.cached = { at: 0, body: null };
  }

  // ---------------------------------------------------------------- the four helpers, as in tape.js
  get(k, dflt = null) {
    const rows = [...this.sql.exec("SELECT v FROM kv WHERE k = ?", k)];
    return rows.length ? rows[0].v : dflt;
  }
  set(k, v) { this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v)); }
  num(k, dflt = 0) { const v = this.get(k); return v === null ? dflt : Number(v); }
  bump(k, by = 1) { this.set(k, this.num(k) + by); }

  intervalMs() { return Math.max(1000, Number(this.env.WATCH_INTERVAL_MS || DEFAULT_INTERVAL_MS)); }
  watchdogMs() { return Math.max(this.intervalMs() * 3, Number(this.env.WATCH_WATCHDOG_MS || DEFAULT_WATCHDOG_MS)); }
  maxBlocks() { return Math.max(1, Number(this.env.WATCH_MAX_BLOCKS || DEFAULT_MAX_BLOCKS)); }
  depthDays() { return Math.max(1, Number(this.env.WATCH_DEPTH_DAYS || DEFAULT_DEPTH_DAYS)); }
  depthMs() { return this.depthDays() * 86400000; }
  tailCacheMs() { return Math.max(0, Number(this.env.TAIL_CACHE_MS || DEFAULT_TAIL_CACHE_MS)); }
  indexTtlMs() { return Math.max(0, Number(this.env.INDEX_TTL_MS || DEFAULT_INDEX_TTL_MS)); }
  lastBlock() { const v = this.get("last_block"); return v === null ? null : Number(v); }

  // ---------------------------------------------------------------- the object's http face
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");
    if (path === "tick") return json(await this.tick(Date.now()));
    if (path === "watchdog") return json(await this.watchdog(Date.now()));
    if (path === "tail") return json(await this.tail(Date.now()));
    if (path === "state") return json(await this.state());
    if (path === "rules") {
      const body = await request.json().catch(() => ({}));
      return json(await this.ruleCommand(body || {}));
    }
    return new Response(null, { status: 404 });
  }

  async state() {
    return {
      engine: ENGINE_PATH,
      engineOk: engineSelfTest().ok,
      lastBlock: this.lastBlock(),
      startedBlock: this.get("started_block") === null ? null : Number(this.get("started_block")),
      launches: this.count("SELECT COUNT(*) AS n FROM tail"),
      depthDays: this.depthDays(),
      rounds: this.num("rounds"),
      gaps: this.num("gaps"),
      unreadable: this.num("unreadable"),
      firedRules: this.num("rules_fired"),
      indexUnread: this.num("index_unread"),
      alarm: await this.ctx.storage.getAlarm()
    };
  }

  count(stmt, ...args) {
    const rows = [...this.sql.exec(stmt, ...args)];
    return rows.length ? Number(rows[0].n) : 0;
  }

  // ---------------------------------------------------------------- the network, all of it through the one Gate
  call(method, params) { return rpcGate(this.env).call(method, params); }

  async head() {
    try { return asNumber(await this.call("eth_blockNumber", [])); } catch { return null; }
  }

  async ethCall(to, data) {
    try {
      const r = await this.call("eth_call", [{ to, data }, "latest"]);
      return typeof r === "string" && r.length > 2 ? r : null;
    } catch { return null; }
  }

  /** The launches in a block range, from the factory's own log. null when the range could not be read. */
  async launchesIn(from, to) {
    let logs;
    try {
      logs = await this.call("eth_getLogs", [{ address: FACTORY, topics: [TOPIC_TOKEN_LAUNCHED], fromBlock: hexNum(from), toBlock: hexNum(to) }]);
    } catch { return null; }
    if (!Array.isArray(logs)) return null;
    const out = [];
    for (const l of logs) {
      if (!l || !Array.isArray(l.topics) || l.topics.length < 4) continue;
      out.push({
        token: addressOfTopic(l.topics[1]),
        curve: addressOfTopic(l.topics[2]),
        deployer: addressOfTopic(l.topics[3]),
        block: asNumber(l.blockNumber),
        tx: String(l.transactionHash || "")
      });
    }
    return out;
  }

  /**
   * What a launch calls itself: the same four reads tools/launch-collect.mjs makes, decoded with the same
   * codec. tools/launch/abi.mjs is imported rather than copied, for the same reason the engine is: a second
   * decoder in this repository could disagree with the first one about a string.
   *
   * null when any of the four did not answer, exactly as the collector treats an unreadable token.
   */
  async readLaunch(token) {
    const [name, symbol, info, launched] = await Promise.all([
      this.ethCall(token, SEL_TOKEN.name),
      this.ethCall(token, SEL_TOKEN.symbol),
      this.ethCall(token, SEL_TOKEN.info),
      this.ethCall(FACTORY, SEL.launched + pad(token))
    ]);
    if (!name || !symbol || !info || !launched) return null;
    try {
      const i = decodeParams(TOKEN_INFO, info);
      const l = decodeParams([LAUNCHED_TOKEN], launched)[0];
      return {
        name: decodeParams([ABI.string], name)[0],
        symbol: decodeParams([ABI.string], symbol)[0],
        logo: i[1],
        description: i[2],
        socials: i[3],
        recipient: lower(l[3]),
        exists: l[14] === true
      };
    } catch {
      return null;
    }
  }

  /**
   * A block's utc date, which is what the index's `first` field holds.
   *
   * The collector finds these without a call per block, by bisecting for midnights across a fixed window. The
   * watcher cannot: it sees blocks as they arrive and has no window to bisect. So it reads the block that
   * carried a launch, once, and remembers it. Launches are rare enough per round for that to be one extra
   * call on the rounds that have any and none at all on the rounds that do not.
   */
  async timeOf(block) {
    const key = "ts:" + block;
    const known = this.get(key);
    if (known !== null) return Number(known);
    try {
      const b = await this.call("eth_getBlockByNumber", [hexNum(block), false]);
      const ts = asNumber(b.timestamp);
      this.set(key, ts);
      return ts;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- the two published files
  /** The index the page reads, or null. Never an empty table standing in for one: see checkRules. */
  async index(now = Date.now()) {
    if (indexCache.value && now - indexCache.at < this.indexTtlMs()) return indexCache.value;
    try {
      const r = await fetch(this.env.LAUNCH_INDEX_URL || INDEX_URL, { headers: { "user-agent": "lintcha-chain-api", accept: "application/json" } });
      if (!r.ok) return null;
      const value = await r.json();
      if (!value || typeof value !== "object") return null;
      indexCache = { at: now, value };
      return value;
    } catch {
      return null;
    }
  }

  /** The snapshot's own numbers, for the one figure the tail has to state: where the snapshot ended. */
  async numbers(now = Date.now()) {
    if (numbersCache.value && now - numbersCache.at < this.indexTtlMs()) return numbersCache.value;
    try {
      const r = await fetch(this.env.LAUNCH_NUMBERS_URL || NUMBERS_URL, { headers: { "user-agent": "lintcha-chain-api", accept: "application/json" } });
      if (!r.ok) return null;
      const value = await r.json();
      if (!value || typeof value !== "object") return null;
      numbersCache = { at: now, value };
      return value;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- one round
  /**
   * Read the launch log from where it left off, store what is new, check the rules, prune what the snapshot
   * already covers, and set the next alarm.
   *
   * Returns a small record of what it did, which is what the tests read.
   */
  async tick(now) {
    const ready = engineSelfTest();
    if (!ready.ok) {
      await this.ctx.storage.deleteAlarm();
      this.set("idle_reason", "engine: " + ready.why);
      return { ran: false, why: "engine", detail: ready.why, scheduled: false };
    }

    // The chain id is confirmed once, the way the collector confirms it, and then remembered in the object's
    // own storage rather than asked again every twelve seconds. Changing the endpoint to a different chain
    // means clearing that key, which is the right amount of friction for changing which chain this reads.
    if (this.get("chain_ok") === null) {
      const id = await chainId(this.env);
      if (id === null) return await this.stand("rpc");
      if (id !== CHAIN_ID) {
        await this.ctx.storage.deleteAlarm();
        this.set("idle_reason", "chain id " + id);
        return { ran: false, why: "chain", scheduled: false };
      }
      this.set("chain_ok", "yes");
    }

    const head = await this.head();
    if (head === null) return await this.stand("rpc");

    const last = this.lastBlock();
    if (last === null) {
      // the tail starts where the watcher wakes up and replays nothing. The gap between the snapshot's last
      // block and this one is a hole, and /api/tail states it rather than implying there is none
      this.set("last_block", head);
      this.set("started_block", head);
      this.set("started_at", now);
      this.set("last_round_at", now);
      this.bump("rounds");
      await this.schedule(now);
      return { ran: true, first: true, from: head, to: head, launches: 0, scheduled: true };
    }

    const from = last + 1;
    const to = Math.min(head, from + this.maxBlocks() - 1);
    if (to < from) {
      this.set("last_round_at", now);
      this.bump("rounds");
      await this.schedule(now);
      return { ran: true, from, to: last, launches: 0, scheduled: true };
    }

    const list = await this.launchesIn(from, to);
    if (list === null) return await this.retreat("logs");

    let stored = 0, unreadable = 0, fired = 0;
    const attempts = this.num("attempts:" + from, 0) + 1;
    for (const l of list) {
      const fields = await this.readLaunch(l.token);
      const ts = await this.timeOf(l.block);
      if (!fields || ts === null) {
        // A launch that will not read is not written half read, and the cursor does not step over it on the
        // first try: the whole range is retried. After READ_ATTEMPTS it is skipped and counted, because a
        // token that never answers would otherwise stop the tail for good.
        if (attempts < READ_ATTEMPTS) {
          this.set("attempts:" + from, attempts);
          return await this.retreat("fields");
        }
        unreadable++;
        this.bump("unreadable");
        continue;
      }
      const launch = { ...l, ...fields, ts, date: dateOfSeconds(ts) };
      if (await this.record(launch)) {
        stored++;
        fired += await this.checkRules(launch, now);
      }
    }
    this.set("attempts:" + from, 0);

    const pruned = this.prune(now);
    this.set("last_block", to);
    this.set("last_round_at", now);
    this.bump("rounds");
    if (stored) this.bump("launches_seen", stored);
    this.cached = { at: 0, body: null };
    await this.schedule(now);
    return { ran: true, from, to, launches: list.length, stored, unreadable, fired, pruned, scheduled: true };
  }

  /**
   * The endpoint could not be reached at all. No alarm is set: there is nothing readable, so there is nothing
   * to schedule, and the cron tries again a minute later.
   */
  async stand(why) {
    await this.ctx.storage.deleteAlarm();
    this.bump("failed_reads");
    this.set("last_fail", why);
    this.set("idle_reason", why);
    return { ran: false, why, scheduled: false };
  }

  /** One read failed inside a round that otherwise reached the endpoint. Keep the cursor, try again on the beat. */
  async retreat(why) {
    this.bump("failed_reads");
    this.set("last_fail", why);
    await this.schedule(Date.now());
    return { ran: false, why, scheduled: true };
  }

  /**
   * Remember one launch once, as counted hashes plus the three things only this object keeps.
   *
   * What is stored here and never handed out: the token address, the deployer address and the transaction.
   * They are needed to name a launch in a direct message and to answer a dev rule, and they are exactly what
   * the published index refuses to carry, so they stay on this side of /api/tail.
   */
  async record(launch) {
    const already = [...this.sql.exec("SELECT 1 AS one FROM tail WHERE token = ?", launch.token)];
    if (already.length) return false;
    const row = await rowOf(launch);
    this.sql.exec(
      "INSERT INTO tail (token, block, ts, date, deployer, tx, row) VALUES (?, ?, ?, ?, ?, ?, ?)",
      launch.token, Number(launch.block), Number(launch.ts), launch.date, lower(launch.deployer), String(launch.tx || ""), JSON.stringify(row)
    );
    for (const [ns, value] of Object.entries(row.hashes)) {
      const list = (Array.isArray(value) ? value : [value]).filter(Boolean);
      for (const h of list) this.sql.exec("INSERT INTO tail_hash (token, ns, hash) VALUES (?, ?, ?)", launch.token, ns, h);
    }
    return true;
  }

  /** How many launches in the tail carry one hash in one namespace, this one included. */
  tailCount(ns, hash) {
    if (!hash) return 0;
    return this.count("SELECT COUNT(*) AS n FROM tail_hash WHERE ns = ? AND hash = ?", ns, hash);
  }

  /** How many launches in the tail came from one deployer. */
  deployerCount(deployer) {
    return this.count("SELECT COUNT(*) AS n FROM tail WHERE deployer = ?", lower(deployer));
  }

  /**
   * Every rule, against one launch, with the counting done by the engine's own check().
   *
   * check(input, index) is the function the page calls when somebody pastes a launch into it. Calling it here,
   * with the index published on the site, is what makes the page's new promise true: the check a rule runs is
   * the check on the page, and the index it reads is the one published there. Nothing is recomputed and
   * nothing is approximated.
   *
   * When the index cannot be read, the counts are null rather than zero, and a shared rule stays quiet: a
   * threshold compared against half a count is a threshold compared against nothing.
   */
  async checkRules(launch, now) {
    const rules = this.rules.all();
    if (!rules.length) return 0;

    const row = await rowOf(launch);
    const idx = await this.index(now);
    if (!idx) this.bump("index_unread");
    const checked = idx ? await engineCheck(engineInput(launch), idx).catch(() => null) : null;
    if (idx && !checked) this.bump("index_unread");

    const indexOf = ns => {
      if (!checked) return { state: null, n: null };
      if (ns === "ticker") return readState(checked.N1);
      if (ns === "name") return readState(checked.N2);
      return { state: null, n: null };
    };
    const linkState = field => {
      if (!checked || !checked.I1 || !checked.I1.links) return { state: null, n: null };
      return readState(checked.I1.links[field]);
    };

    const ticker = indexOf("ticker");
    const subject = {
      deployer: launch.deployer,
      hashes: { ticker: row.hashes.ticker, name: row.hashes.name, link: row.hashes.link },
      indexCount: ticker.n,
      tailCount: this.tailCount("ticker", row.hashes.ticker)
    };

    let fired = 0;
    for (const rule of rules) {
      const hit = match(rule, subject);
      if (!hit) continue;
      const owner = rule.owner;
      // access is a live session, checked at delivery and not only at the moment the rule was made: a person
      // whose session has lapsed may no longer hold, and a holder's rule is a holder's rule
      const session = this.env.SESSIONS ? await getSession(this.env.SESSIONS, owner).catch(() => null) : null;
      if (!session) { this.bump("dormant_skips"); continue; }

      const state = hit.where === "the name" ? indexOf("name") : hit.where === "a link" ? linkState(hit.field) : ticker;
      const counts = hit.where === "the deployer"
        ? { indexState: null, indexCount: null, tailCount: this.deployerCount(launch.deployer) }
        : { indexState: state.state, indexCount: state.n, tailCount: this.tailCount(nsOf(hit.where), hashOf(row, hit)) };

      const text = TEXT.ruleHitText({
        kind: rule.kind,
        arg: rule.arg,
        where: hit.where + (hit.field ? " (" + hit.field + ")" : ""),
        indexState: counts.indexState,
        indexCount: counts.indexCount,
        tailCount: counts.tailCount,
        block: launch.block,
        address: launch.token,
        txUrl: this.env.TX_URL_PREFIX && launch.tx ? link("the launch transaction", this.env.TX_URL_PREFIX + launch.tx) : null
      });
      const sent = await sendMessage(this.env, owner, text, { quiet: true, preview: false });
      if (sent) { this.rules.bumpHit(rule.id); this.bump("rules_fired"); fired++; }
    }
    return fired;
  }

  /** Everything older than the tail's depth, which the snapshot already covers, is dropped. */
  prune(now) {
    const cutoff = Math.floor((now - this.depthMs()) / 1000);
    const doomed = [...this.sql.exec("SELECT token FROM tail WHERE ts < ?", cutoff)].map(r => r.token);
    for (const token of doomed) {
      this.sql.exec("DELETE FROM tail WHERE token = ?", token);
      this.sql.exec("DELETE FROM tail_hash WHERE token = ?", token);
    }
    if (doomed.length) { this.bump("pruned", doomed.length); this.cached = { at: 0, body: null }; }
    return doomed.length;
  }

  // ---------------------------------------------------------------- the tail, as it is handed out
  /**
   * What GET /api/tail answers.
   *
   * Counted hashes, a block range and a hash of the whole table. No address, no raw string, no name — the
   * same rule the index writer enforces on the file the page reads, kept here by the same reasoning and
   * checked by bot/test/tail_test.mjs with the index writer's own pattern.
   *
   * from_block is the first block this object actually covers, not the block after the snapshot's last one.
   * When those differ there is a hole, and gap_blocks says how wide it is rather than letting a reader assume
   * the two ranges meet.
   */
  async tail(now = Date.now()) {
    if (this.cached.body && now - this.cached.at < this.tailCacheMs()) return this.cached.body;

    const rows = [...this.sql.exec("SELECT token, block, ts, date, deployer, row FROM tail ORDER BY block, token")];
    const tally = new Tally();
    const launches = [];
    for (const r of rows) {
      const row = parseRow(r.row);
      if (!row) continue;
      launches.push(row);
      addRowToTally(tally, row, r.date, r.deployer);
    }
    const frozen = tally.frozen();
    const numbers = await this.numbers(now);
    const snapshotTo = numbers && numbers.window && Number.isInteger(numbers.window.to_block) ? numbers.window.to_block : null;
    const started = this.get("started_block") === null ? null : Number(this.get("started_block"));
    // The range is what the tail covers, not where its first launch happens to be. The first round takes the
    // head and replays nothing, so the first block it could have seen a launch in is the one after it — and
    // the blocks between the snapshot's last and that one are covered by neither, which gap_blocks names.
    const from = started === null ? null : started + 1;
    const to = this.lastBlock();

    const body = {
      engine: ENGINE_PATH,
      from_block: from,
      to_block: to,
      collected_at: new Date(now).toISOString(),
      depth_days: this.depthDays(),
      snapshot_to_block: snapshotTo,
      gap_blocks: snapshotTo === null || from === null ? null : Math.max(0, from - 1 - snapshotTo),
      launches_in_tail: launches.length,
      entries: entryCounts(frozen),
      hash: await tallyHash(frozen),
      tables: frozen,
      launches
    };
    this.cached = { at: now, body };
    return body;
  }

  // ---------------------------------------------------------------- rules, from the router
  /**
   * The three rule commands, answered here because the rules live here.
   *
   * The router has already established that the sender is a holder with a live session; this object stores,
   * lists and removes. The owner is the telegram id: a rule is a standing arrangement with a person, and it
   * outlives the session that was needed to make it, but it only ever fires while a session is live.
   */
  async ruleCommand(body) {
    const owner = String(body.owner || "");
    if (!owner) return { ok: false, why: "owner" };

    if (body.what === "list") {
      return { ok: true, rules: this.rules.list(owner).map(strip), state: await this.state() };
    }

    if (body.what === "add") {
      if (this.rules.countFor(owner) >= this.rules.limit(this.env)) return { ok: false, why: "limit" };
      // the hashes a rule is compared by are made here, by the engine this object already holds, so nothing
      // that decides what counts as the same string travels over a request boundary
      const rifle = await rifleOf(body.kind, body.arg);
      const stored = this.rules.add(owner, body.kind, body.arg, rifle, Date.now());
      const mine = this.rules.list(owner);
      return { ok: true, rule: strip(stored), number: mine.findIndex(r => r.id === stored.id) + 1, count: mine.length, limit: this.rules.limit(this.env) };
    }

    if (body.what === "remove") {
      const mine = this.rules.list(owner);
      const n = Number(body.number);
      if (!Number.isInteger(n) || n < 1 || n > mine.length) return { ok: false, why: "number" };
      const target = mine[n - 1];
      const removed = this.rules.removeById(owner, target.id);
      return removed ? { ok: true, rule: strip(target) } : { ok: false, why: "number" };
    }

    return { ok: false, why: "what" };
  }

  // ---------------------------------------------------------------- the beat
  async schedule(now) {
    await this.ctx.storage.setAlarm(now + this.intervalMs());
    return true;
  }

  async alarm() { await this.tick(Date.now()); }

  /**
   * The cron, once a minute.
   *
   * It does two jobs the alarm cannot. It starts the object again after a stand — while the endpoint was
   * unreachable there was no alarm to fire, so nothing else would. And it notices a round that should have
   * happened and did not, counts it, and runs one immediately rather than waiting out an interval.
   *
   * Nothing is said in the room about either. The people a gap costs are the ones with rules, and /rules
   * tells them.
   */
  async watchdog(now) {
    const alarm = await this.ctx.storage.getAlarm();
    const lastAt = this.num("last_round_at", 0);
    const late = !lastAt || now - lastAt >= this.watchdogMs();
    if (alarm !== null && alarm !== undefined && !late) return { woke: false, why: "on time" };
    if (lastAt && late) this.bump("gaps");
    const r = await this.tick(now);
    return { woke: true, gapSeconds: lastAt ? Math.round((now - lastAt) / 1000) : null, ran: r.ran, why: r.why };
  }
}

// ---------------------------------------------------------------- small pure helpers
const json = v => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

/** what the page's check() takes, from what the watcher read */
export function engineInput(launch) {
  const links = {};
  LINKS.forEach((k, i) => { links[k] = (Array.isArray(launch.socials) && launch.socials[i]) || ""; });
  return { name: launch.name, ticker: launch.symbol, description: launch.description, logo: launch.logo, recipient: launch.recipient, links };
}

const readState = r => (r && r.state === "shared" ? { state: "shared", n: Number(r.n) } : r ? { state: r.state, n: 0 } : { state: null, n: null });
const nsOf = where => (where === "the name" ? "name" : where === "a link" ? "link" : "ticker");
const hashOf = (row, hit) => {
  if (hit.where === "the name") return row.hashes.name;
  if (hit.where === "a link") return hit.hash || null;
  return row.hashes.ticker;
};
const parseRow = s => { try { const r = JSON.parse(s); return r && r.hashes ? r : null; } catch { return null; } };

/**
 * Put one stored row into a tally.
 *
 * The two skeleton namespaces count distinct spellings inside a group, and this object does not keep the raw
 * strings a spelling is made of — deliberately, because the tail hands out hashes. It does not need them: two
 * launches spell a ticker the same way exactly when their exact ticker hashes are equal, so the exact hash
 * stands in for the spelling and the count comes out identical to the collector's.
 */
export function addRowToTally(tally, row, date, deployer) {
  const h = row.hashes;
  for (const one of h.link) tally.addHash("link", one, date, deployer);
  tally.addHash("logo", h.logo, date, deployer);
  tally.addHash("recipient", h.recipient, date, deployer);
  tally.addHash("description", h.description, date, deployer);
  tally.addHash("ticker", h.ticker, date, deployer);
  tally.addHash("name", h.name, date, deployer);
  tally.addHash("ticker_skeleton", h.ticker_skeleton, date, deployer, h.ticker);
  tally.addHash("name_skeleton", h.name_skeleton, date, deployer, h.name);
}

/** a rule as its owner may see it: no hashes, no owner, nothing about anyone else */
const strip = r => ({ id: r.id, kind: r.kind, arg: r.arg, made: r.made, hits: r.hits });
