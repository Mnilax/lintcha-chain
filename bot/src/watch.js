// The watcher: the live tail of the launch log, and the rules read against it.
//
// Why there is a tail at all, rather than a live database. The index the page reads is a snapshot: collected
// up to a block, written to a file, hashed, and rebuildable by a command anyone can run. Two published things
// depend on that being true — the Reproduce it section prints the file's hash and the command, and the never
// list says that if the site computes something the repository cannot, the repository is decoration. A live
// database whose range moves cannot be rebuilt and compared, so replacing the snapshot with one would quietly
// break both. The snapshot therefore stays exactly as it is and gets a tail: everything after its last block
// lives here and is handed out as bounded, block-aligned committed pages. Each page has its own block range and
// hash, and a collector run over that range reproduces it. bot/tools/verify-tail.mjs is that comparison.
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

import { rpcGate, FACTORY, SEL, chainId, CHAIN_ID, CHAIN_TTL_MS, DEFAULT_RPC } from "./chain.js";
import { selector, topic } from "./keccak.js";
import { decodeParams, encode, TOKEN_INFO, LAUNCHED_TOKEN, T as ABI } from "../../tools/launch/abi.mjs";
import { check as engineCheck, engineSelfTest, LINKS, ENGINE_PATH } from "./engine.js";
import { Tally, rowOf, tallyHash, entryCounts } from "./tally.js";
import { Rules, match, rifleOf, MAX_ARG } from "./rules.js";
import { getSession, normalizeNonce, NONCE_TTL_SECONDS, SESSION_TTL_SECONDS } from "./verify.js";
import { sendMessage, link, TELEGRAM_TEXT_LIMIT } from "./telegram.js";
import * as TEXT from "./texts.js";
import { validLaunchIndex, publishedManifestOf } from "../../lib/published-contract.mjs";
import { requiredHttpsUrlOf } from "../../lib/config-contract.mjs";
import { integerSetting } from "./config.js";

export const DEFAULT_INTERVAL_MS = 12000;
export const DEFAULT_WATCHDOG_MS = 90000;
export const DEFAULT_MAX_BLOCKS = 2000;
/**
 * One accepted launch costs four eth_call reads plus one numbered-header read. Together with the maximum
 * private-delivery batch and the corpus/base reads, four keeps a cold beat inside the authored forty-seven
 * external-request budget. An overflowing range is retried as its first block without consuming a prefix.
 */
export const DEFAULT_MAX_LAUNCHES = 4;
/** Minimum age before a snapshot-covered launch becomes eligible for pruning. */
export const DEFAULT_DEPTH_DAYS = 7;
/** the tail's answer is built once and handed out for this long */
export const DEFAULT_TAIL_CACHE_MS = 5000;
/** Manifest/index/numbers fetches share the same bounded five-second I/O window. */
export const PUBLISHED_RESPONSE_TIMEOUT_MS = DEFAULT_TAIL_CACHE_MS;
/** the published index changes weekly, so a ten minute memory of it is fresh by a wide margin */
export const DEFAULT_INDEX_TTL_MS = 600000;
/** Owned response ceiling, kept well above the checked-in corpus while avoiding contract-level 64 MiB bodies. */
export const MAX_PUBLISHED_FILE_BYTES = 4 * 1024 * 1024;
/** A persisted endpoint proof is deliberately short-lived, just like the shared chain read cache. */
export const DEFAULT_CHAIN_PROOF_TTL_MS = CHAIN_TTL_MS;
/** A refused private line is useful only while the session that authorized its rule could still be live. */
export const RULE_DELIVERY_RETENTION_MS = SESSION_TTL_SECONDS * 1000;
/** Product caps: deployment settings may tighten them, but cannot turn one round into an unbounded scan. */
export const DEFAULT_RULES_TOTAL = 1000;
export const MAX_RULES_TOTAL = DEFAULT_RULES_TOTAL;
export const DEFAULT_RULE_DELIVERY_TOTAL = DEFAULT_RULES_TOTAL;
export const MAX_RULE_DELIVERY_TOTAL = DEFAULT_RULE_DELIVERY_TOTAL;
/** The public hash tail never materializes more rows than the existing authored durable-work cap. */
export const MAX_TAIL_ROWS = DEFAULT_RULE_DELIVERY_TOTAL;
/** Version one replaces the unsafe single-materialization response with block-aligned committed pages. */
export const TAIL_VERSION = 1;
export const DEFAULT_RULE_DELIVERY_BATCH = 20;
export const MAX_RULE_DELIVERY_BATCH = DEFAULT_RULE_DELIVERY_BATCH;
/** A durable fixed window protects command work per Telegram user across isolate restarts. */
export const DEFAULT_TELEGRAM_COMMANDS_PER_WINDOW = 20;
export const MAX_TELEGRAM_COMMANDS_PER_WINDOW = 100;
export const DEFAULT_TELEGRAM_COMMAND_WINDOW_MS = 60000;
export const MAX_TELEGRAM_COMMAND_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Telegram retains webhook updates for no longer than one day, so older dedupe marks cannot be retried. */
export const TELEGRAM_UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_TELEGRAM_RESPONSE_ACTIONS = 32;
/** A renderer that vanished can be replaced only after the existing verified nonce lifetime. */
export const TELEGRAM_RENDER_LEASE_MS = NONCE_TTL_SECONDS * 1000;
const MAX_TELEGRAM_EFFECT_BYTES = 16 * 1024;
/** Bounded public page. The value is a product limit, not a measured launch count. */
export const DEFAULT_WALL_PAGE_ROWS = 200;
/** Bounded public deployer-history page. The value is a product limit, not a measured launch count. */
export const DEFAULT_HISTORY_PAGE_ROWS = 200;
/** A restart-local courtesy limit at the singleton object, behind the worker isolate's own limit. */
export const DEFAULT_HISTORY_PER_SECOND = 2;
/** Successful address pages retained only for one watcher state, with bounded memory. */
export const DEFAULT_HISTORY_CACHE_ADDRESSES = 16;
/** how many times one block range is retried when a launch in it will not read, before it is skipped */
export const READ_ATTEMPTS = 3;
/** Raw on-chain labels kept for the wall. Longer or control-bearing declarations are not published. */
export const MAX_WALL_TEXT = MAX_ARG;

export const INDEX_URL = "https://chain.lintcha.com/launch-index.json";
export const NUMBERS_URL = "https://chain.lintcha.com/launch-numbers.json";
export const MANIFEST_URL = "https://chain.lintcha.com/launch-manifest.json";

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
  "CREATE TABLE IF NOT EXISTS holder_nonce (mark TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS telegram_update (update_id INTEGER PRIMARY KEY, seen_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS telegram_response (update_id INTEGER PRIMARY KEY, actions TEXT, next_action INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS telegram_render (update_id INTEGER PRIMARY KEY, lease_until INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS telegram_effect (update_id INTEGER NOT NULL, effect TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (update_id, effect))",
  "CREATE TABLE IF NOT EXISTS telegram_command_bucket (owner TEXT PRIMARY KEY, taken INTEGER NOT NULL, expires INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rule_delivery (rule_id INTEGER NOT NULL, token TEXT NOT NULL, owner TEXT NOT NULL, body TEXT NOT NULL, sent INTEGER NOT NULL, made INTEGER NOT NULL, last_attempt INTEGER NOT NULL, PRIMARY KEY (rule_id, token))",
  "CREATE TABLE IF NOT EXISTS wall_event (block INTEGER NOT NULL, log_index INTEGER NOT NULL, token TEXT NOT NULL, name TEXT, ticker TEXT, publishable INTEGER NOT NULL, PRIMARY KEY (block, log_index))",
  "CREATE INDEX IF NOT EXISTS tail_block ON tail (block)",
  "CREATE INDEX IF NOT EXISTS tail_deployer_block ON tail (deployer, block)",
  "CREATE INDEX IF NOT EXISTS tail_hash_ns ON tail_hash (ns, hash)",
  "CREATE INDEX IF NOT EXISTS telegram_command_bucket_expiry ON telegram_command_bucket (expires)",
  "CREATE INDEX IF NOT EXISTS rule_delivery_pending ON rule_delivery (sent, rule_id)",
  "CREATE INDEX IF NOT EXISTS wall_event_token ON wall_event (token)"
];

// The three published files are one versioned bundle. The manifest's exact-byte digest is the generation;
// index and numbers entries are reusable only while they name that same generation. Keeping one record here
// matters during a weekly upload: independently fresh caches could otherwise pair an old index with a new
// snapshot boundary (or the reverse).
const emptyPublishedCache = () => ({
  manifest: { at: 0, value: null, generation: null, url: null },
  index: { at: 0, value: null, generation: null, url: null },
  numbers: { at: 0, value: null, generation: null, url: null }
});
let publishedCache = emptyPublishedCache();
let manifestFlight = null;
let publishedEpoch = 0;
const LAUNCH_PAGE_OVERFLOW = Object.freeze({ overflow: true });
const RULE_DELIVERY_OVERFLOW = Object.freeze({ overflow: true });
/** Only for tests: drop what this isolate remembers of the published bundle. */
export function forgetPublished() {
  publishedCache = emptyPublishedCache();
  manifestFlight = null;
  publishedEpoch++;
}

const cancelBestEffort = target => {
  try {
    const pending = target && typeof target.cancel === "function" ? target.cancel() : null;
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {}
};

const cancelResponseBody = response => {
  if (response && response.body) cancelBestEffort(response.body);
};

const responseBytes = async (response, limit, signal) => {
  if (!response || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PUBLISHED_FILE_BYTES ||
      !response.body || typeof response.body.getReader !== "function") return null;
  const declared = response.headers && response.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > limit)) {
    cancelResponseBody(response);
    return null;
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  let aborted = !!(signal && signal.aborted);
  const onAbort = () => {
    aborted = true;
    cancelBestEffort(reader);
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (aborted) { cancelBestEffort(reader); return null; }
    while (true) {
      const part = await reader.read();
      if (!part || part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        cancelBestEffort(reader);
        return null;
      }
      if (part.value.byteLength > limit - size) {
        cancelBestEffort(reader);
        return null;
      }
      bytes.set(part.value, size);
      size += part.value.byteLength;
    }
    if (aborted || (declared !== null && Number(declared) !== size)) return null;
    return size === limit ? bytes : bytes.slice(0, size);
  } catch {
    cancelBestEffort(reader);
    return null;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
};

const publishedResponseBytes = async (url, limit) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLISHED_RESPONSE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "lintcha-chain-api", accept: "application/json" },
      signal: controller.signal
    });
    if (controller.signal.aborted) { cancelResponseBody(response); return null; }
    if (!response.ok) { cancelResponseBody(response); return null; }
    return await responseBytes(response, limit, controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
const jsonBytes = bytes => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
const bytesHash = async bytes => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
};

const hexNum = n => "0x" + BigInt(n).toString(16);
const rpcQuantityNumber = value => {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) return null;
  try {
    const n = Number(BigInt(value));
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch { return null; }
};
const lower = a => String(a == null ? "" : a).toLowerCase();
const pad = a => String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const addressOfTopic = value => {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  const body = value.slice(2).toLowerCase();
  return /^0{24}/.test(body) ? "0x" + body.slice(24) : null;
};
const canonicalParams = (types, data) => {
  if (typeof data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) return null;
  try {
    const values = decodeParams(types, data);
    const bytes = encode(ABI.tuple(...types), values);
    const canonical = "0x" + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return canonical.toLowerCase() === data.toLowerCase() ? values : null;
  } catch {
    return null;
  }
};
const dateOfSeconds = ts => {
  if (!Number.isSafeInteger(ts) || ts < 0) return null;
  const milliseconds = ts * 1000;
  if (!Number.isSafeInteger(milliseconds)) return null;
  try {
    const iso = new Date(milliseconds).toISOString();
    return /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) : null;
  } catch {
    return null;
  }
};
const storedTimestamp = value => {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && dateOfSeconds(timestamp) !== null ? timestamp : null;
};

export class Watch {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env || {};
    this.running = false;
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    // CREATE IF NOT EXISTS cannot add columns to an object that already saw an earlier outbox schema. Keep
    // constructor setup idempotent across those upgrades. A legacy pending row begins at zero: it is retired
    // immediately if its authorizing session is gone, and starts behind never-attempted current rows otherwise.
    const deliveryColumns = [...this.sql.exec("PRAGMA table_info(rule_delivery)")];
    if (!deliveryColumns.some(column => column && String(column.name).toLowerCase() === "made")) {
      this.sql.exec("ALTER TABLE rule_delivery ADD COLUMN made INTEGER NOT NULL DEFAULT 0");
    }
    if (!deliveryColumns.some(column => column && String(column.name).toLowerCase() === "last_attempt")) {
      this.sql.exec("ALTER TABLE rule_delivery ADD COLUMN last_attempt INTEGER NOT NULL DEFAULT 0");
    }
    this.sql.exec("CREATE INDEX IF NOT EXISTS rule_delivery_retry ON rule_delivery (sent, last_attempt, made, rule_id, token)");
    this.rules = new Rules(this.sql);
    this.cached = { at: 0, body: null };
    this.wallCached = { at: 0, key: null, body: null };
    this.historyCached = { epoch: null, bodies: new Map() };
    this.historyBucket = { second: null, taken: 0 };
  }

  // ---------------------------------------------------------------- the four helpers, as in tape.js
  get(k, dflt = null) {
    const rows = [...this.sql.exec("SELECT v FROM kv WHERE k = ?", k)];
    return rows.length ? rows[0].v : dflt;
  }
  set(k, v) { this.sql.exec("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v)); }
  del(k) { this.sql.exec("DELETE FROM kv WHERE k = ?", k); }
  num(k, dflt = 0) { const v = this.get(k); return v === null ? dflt : Number(v); }
  bump(k, by = 1) { this.set(k, this.num(k) + by); }

  intervalMs() {
    const configured = integerSetting(this.env.WATCH_INTERVAL_MS, DEFAULT_INTERVAL_MS, { min: 0, max: DEFAULT_WATCHDOG_MS });
    return Math.max(1000, configured);
  }
  watchdogMs() {
    const configured = integerSetting(this.env.WATCH_WATCHDOG_MS, DEFAULT_WATCHDOG_MS, { min: 0, max: DEFAULT_WATCHDOG_MS * 3 });
    return Math.max(this.intervalMs() * 3, configured);
  }
  maxBlocks() {
    return integerSetting(this.env.WATCH_MAX_BLOCKS, DEFAULT_MAX_BLOCKS, { min: 1, max: DEFAULT_MAX_BLOCKS, invalid: 1 });
  }
  maxLaunches() {
    return integerSetting(this.env.WATCH_MAX_LAUNCHES, DEFAULT_MAX_LAUNCHES, { min: 1, max: DEFAULT_MAX_LAUNCHES, invalid: 1 });
  }
  depthDays() {
    return integerSetting(this.env.WATCH_DEPTH_DAYS, DEFAULT_DEPTH_DAYS, { min: 1, max: Math.floor(Number.MAX_SAFE_INTEGER / 86400000) });
  }
  depthMs() { return this.depthDays() * 86400000; }
  tailCacheMs() {
    return integerSetting(this.env.TAIL_CACHE_MS, DEFAULT_TAIL_CACHE_MS, { min: 0, max: DEFAULT_INDEX_TTL_MS });
  }
  indexTtlMs() {
    return integerSetting(this.env.INDEX_TTL_MS, DEFAULT_INDEX_TTL_MS, { min: 0, max: DEFAULT_INDEX_TTL_MS });
  }
  rulesTotalLimit() {
    return integerSetting(this.env.RULES_TOTAL, DEFAULT_RULES_TOTAL, { min: 1, max: MAX_RULES_TOTAL, invalid: 0 });
  }
  ruleDeliveryTotalLimit() {
    return integerSetting(this.env.RULE_DELIVERY_TOTAL, DEFAULT_RULE_DELIVERY_TOTAL, {
      min: 1,
      max: MAX_RULE_DELIVERY_TOTAL,
      invalid: 0
    });
  }
  ruleDeliveryBatch() {
    return integerSetting(this.env.RULE_DELIVERY_BATCH, DEFAULT_RULE_DELIVERY_BATCH, { min: 1, max: MAX_RULE_DELIVERY_BATCH });
  }
  telegramCommandsPerWindow() {
    return integerSetting(this.env.TELEGRAM_COMMANDS_PER_WINDOW, DEFAULT_TELEGRAM_COMMANDS_PER_WINDOW, { min: 1, max: MAX_TELEGRAM_COMMANDS_PER_WINDOW });
  }
  telegramCommandWindowMs() {
    return integerSetting(this.env.TELEGRAM_COMMAND_WINDOW_MS, DEFAULT_TELEGRAM_COMMAND_WINDOW_MS, {
      min: 1000,
      max: MAX_TELEGRAM_COMMAND_WINDOW_MS
    });
  }
  wallPageRows() {
    const configured = integerSetting(this.env.WALL_PAGE_ROWS, DEFAULT_WALL_PAGE_ROWS, { min: 1 });
    return Math.min(configured, DEFAULT_WALL_PAGE_ROWS * 5);
  }
  historyPageRows() {
    const configured = integerSetting(this.env.HISTORY_PAGE_ROWS, DEFAULT_HISTORY_PAGE_ROWS, { min: 1 });
    return Math.min(configured, DEFAULT_HISTORY_PAGE_ROWS * 5);
  }
  historyPerSecond() {
    const configured = integerSetting(this.env.HISTORY_PER_SECOND, DEFAULT_HISTORY_PER_SECOND, { min: 1 });
    return Math.min(configured, 100);
  }
  historyAllowed(now) {
    const second = Math.floor(now / 1000);
    if (this.historyBucket.second !== second) { this.historyBucket.second = second; this.historyBucket.taken = 0; }
    if (this.historyBucket.taken >= this.historyPerSecond()) return false;
    this.historyBucket.taken++;
    return true;
  }
  tailCursorSecret() {
    const saved = this.get("tail_cursor_secret");
    if (saved !== null) return typeof saved === "string" && /^[0-9a-f]{64}$/.test(saved) ? saved : null;
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const secret = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
      this.set("tail_cursor_secret", secret);
      return secret;
    } catch {
      return null;
    }
  }
  tailStateStamp() {
    return JSON.stringify([
      this.get("started_block"), this.get("started_at"), this.get("last_block"), this.get("unreadable"),
      this.get("last_unreadable_block"), this.get("wall_pruned_through"), this.get("wall_index_error_block")
    ]);
  }
  wallStateStamp() {
    return JSON.stringify([
      this.get("last_block"), this.get("observed_finalized"), this.get("started_block"), this.get("started_at"),
      this.get("last_round_at"), this.get("idle_reason", ""), this.get("wall_pruned_through"), this.get("unreadable"),
      this.get("last_unreadable_block"), this.get("wall_index_error_block")
    ]);
  }
  historyStateStamp() {
    return JSON.stringify([
      this.get("last_block"), this.get("observed_finalized"), this.get("history_started_block"), this.get("history_started_at"),
      this.get("last_round_at"), this.get("idle_reason", ""), this.get("wall_pruned_through"), this.get("unreadable"),
      this.get("last_unreadable_block"), this.get("wall_index_error_block")
    ]);
  }
  lastBlock() { const v = this.get("last_block"); return v === null ? null : Number(v); }

  // ---------------------------------------------------------------- the object's http face
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");
    if (path === "tick") return json(await this.tick(Date.now()));
    if (path === "watchdog") return json(await this.watchdog(Date.now()));
  if (path === "tail") {
      const page = tailPageOf(url.searchParams);
      if (!page) return json({ ok: false, why: "query" }, 400);
      const body = await this.tail(Date.now(), page);
      const status = body && body.ok === false
        ? body.why === "query" || body.why === "cursor" ? 400 : body.why === "reset_required" ? 409 : 503
        : 200;
      return json(body, status);
    }
    if (path === "wall") {
      const page = wallPageOf(url.searchParams);
      if (!page) return json(wallFailure("query"), 400);
      const body = await this.wall(Date.now(), page);
      const status = body.ok ? 200 : body.why === "cursor" || body.why === "query" ? 400 : body.why === "reset_required" ? 409 : 503;
      return json(body, status);
    }
    if (path === "deployer") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const address = deployerAddressOf(url.searchParams);
      if (!address) return json(wallFailure("query"), 400);
      const now = Date.now();
      if (!this.historyAllowed(now)) return json(wallFailure("rate_limited"), 429);
      const body = await this.deployerHistory(address, now);
      return json(body, body.ok ? 200 : 503);
    }
    if (path === "state") return json(await this.state());
    if (path === "nonce") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.json().catch(() => null);
      if (!body) return json({ ok: false }, 400);
      return json(this.nonceCommand(body, Date.now()));
    }
    if (path === "telegram-update") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.json().catch(() => null);
      if (!body) return json({ ok: false }, 400);
      const what = body.what || "claim";
      if (what === "claim") {
        if (typeof body.metered !== "boolean" || typeof body.runnable !== "boolean") return json({ ok: false }, 400);
        const claimed = this.claimTelegramUpdate(body.updateId, body.owner, Date.now(), body.metered, body.runnable);
        return json(claimed, claimed.ok ? 200 : 400);
      }
      if (what === "actions") {
        const stored = this.storeTelegramResponse(body.updateId, body.actions);
        return json(stored, stored.ok ? 200 : 400);
      }
      if (what === "send") {
        const claimed = this.claimTelegramAction(body.updateId, body.index, Date.now());
        return json(claimed, claimed.ok ? 200 : 400);
      }
      if (what === "release") {
        const released = this.releaseTelegramAction(body.updateId, body.index, body.leaseUntil);
        return json(released, released.ok ? 200 : 400);
      }
      if (what === "advance") {
        const advanced = this.advanceTelegramResponse(body.updateId, body.index, body.leaseUntil);
        return json(advanced, advanced.ok ? 200 : 400);
      }
      return json({ ok: false }, 400);
    }
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
      ruleDeliveryBacklog: this.pendingRuleDeliveryCount(),
      ruleDeliveryCapacity: this.ruleDeliveryTotalLimit(),
      ruleDeliveryBlockedAt: storedNonnegativeInteger(this.get("rule_delivery_blocked_at")),
      launchOverflowBlock: storedNonnegativeInteger(this.get("launch_overflow_block")),
      indexUnread: this.num("index_unread"),
      snapshotUnread: this.num("snapshot_unread"),
      alarm: await this.ctx.storage.getAlarm()
    };
  }

  count(stmt, ...args) {
    const rows = [...this.sql.exec(stmt, ...args)];
    return rows.length ? Number(rows[0].n) : 0;
  }

  pendingRuleDeliveryCount() {
    const rows = [...this.sql.exec("SELECT COUNT(*) AS n FROM rule_delivery WHERE sent = ?", 0)];
    return exactCount(rows);
  }

  /**
   * The holder link's strongly consistent store. Every read/delete pair below is synchronous inside this one
   * Durable Object event, so two concurrent takes cannot both observe the same owner. This path is reachable
   * only through the worker's binding; no public /api route forwards it.
   */
  nonceCommand(body, now = Date.now()) {
    const at = safeNonnegativeInteger(now);
    const mark = normalizeNonce(body && body.mark);
    if (at === null || !mark) return { ok: false };

    if (body.what === "put") {
      const owner = typeof body.owner === "string" && body.owner ? body.owner : null;
      const expires = at + NONCE_TTL_SECONDS * 1000;
      if (!owner || !Number.isSafeInteger(expires)) return { ok: false };
      return this.telegramEffectOnce(body.updateId, "nonce", { owner }, () => {
        this.sql.exec("DELETE FROM holder_nonce WHERE expires <= ?", at);
        if ([...this.sql.exec("SELECT owner, expires FROM holder_nonce WHERE mark = ?", mark)].length) return { ok: false };
        this.sql.exec("INSERT INTO holder_nonce (mark, owner, expires) VALUES (?, ?, ?)", mark, owner, expires);
        return { ok: true, mark };
      });
    }

    if (body.what === "take") {
      const rows = [...this.sql.exec("SELECT owner, expires FROM holder_nonce WHERE mark = ?", mark)];
      if (!rows.length) return { ok: false };
      this.sql.exec("DELETE FROM holder_nonce WHERE mark = ?", mark);
      const expires = safeNonnegativeInteger(Number(rows[0].expires));
      const owner = typeof rows[0].owner === "string" && rows[0].owner ? rows[0].owner : null;
      return expires !== null && expires > at && owner ? { ok: true, owner } : { ok: false };
    }

    return { ok: false };
  }

  /** Physically remove expired holder identifiers even when nobody asks for another verification link. */
  pruneNonces(now = Date.now()) {
    const at = safeNonnegativeInteger(now);
    if (at === null) return false;
    this.sql.exec("DELETE FROM holder_nonce WHERE expires <= ?", at);
    return true;
  }

  /**
   * Atomically claim one Telegram delivery and, for a known command, take one place in that user's durable
   * fixed window. Keeping both writes in one transaction matters: a retry must never find a claimed update
   * after a separate rate-limit call failed. Duplicate updates consume neither a second place nor a handler.
   */
  claimTelegramUpdate(updateId, owner = null, now = Date.now(), metered = owner !== null && owner !== undefined,
    runnable = owner !== null && owner !== undefined) {
    const id = Number.isSafeInteger(updateId) && updateId > 0 ? updateId : null;
    const at = safeNonnegativeInteger(now);
    const initialLeaseUntil = at === null ? null : at + TELEGRAM_RENDER_LEASE_MS;
    const hasOwner = owner !== null && owner !== undefined;
    const commandOwner = hasOwner ? canonicalTelegramOwner(owner) : null;
    if (id === null || at === null || typeof metered !== "boolean" || typeof runnable !== "boolean" ||
        (hasOwner && commandOwner === null) || (runnable && metered && commandOwner === null) ||
        (runnable && !Number.isSafeInteger(initialLeaseUntil)) ||
        !this.ctx.storage || typeof this.ctx.storage.transactionSync !== "function") return { ok: false };
    try {
      return this.ctx.storage.transactionSync(() => {
        this.pruneTelegramUpdates(at);
        this.pruneTelegramCommandBuckets(at);
        if ([...this.sql.exec("SELECT seen_at FROM telegram_update WHERE update_id = ?", id)].length) {
          const pending = this.telegramResponse(id);
          if (pending && pending.invalid) return { ok: false };
          const renderLease = pending && pending.actions === null ? this.takeTelegramRenderLease(id, at) : null;
          return { ok: true, fresh: false, allowed: pending !== null, pending: pending !== null,
            render: renderLease !== null, actions: pending ? pending.actions : null, nextAction: pending ? pending.nextAction : 0 };
        }
        // A known command with no canonical Telegram user is claimed but dropped. Returning an error before
        // the claim would make Telegram retry the same unmeterable update indefinitely.
        const allowed = runnable && (!metered || this.takeTelegramCommand(commandOwner, at));
        this.sql.exec("INSERT INTO telegram_update (update_id, seen_at) VALUES (?, ?)", id, at);
        if (allowed) {
          this.sql.exec("INSERT INTO telegram_response (update_id, actions, next_action) VALUES (?, ?, ?)", id, null, 0);
          this.sql.exec("INSERT INTO telegram_render (update_id, lease_until) VALUES (?, ?)", id, initialLeaseUntil);
        }
        return { ok: true, fresh: true, allowed, pending: allowed, render: allowed, actions: null, nextAction: 0 };
      });
    } catch {
      return { ok: false };
    }
  }

  /** A claimed command remains pending until every rendered response action is accepted. */
  telegramResponse(updateId) {
    const id = Number.isSafeInteger(updateId) && updateId > 0 ? updateId : null;
    if (id === null) return { invalid: true };
    const rows = [...this.sql.exec("SELECT actions, next_action FROM telegram_response WHERE update_id = ?", id)];
    if (!rows.length) return null;
    if (rows.length !== 1) return { invalid: true };
    const nextAction = safeNonnegativeInteger(Number(rows[0].next_action));
    if (nextAction === null) return { invalid: true };
    if (rows[0].actions === null) return nextAction === 0 ? { actions: null, nextAction } : { invalid: true };
    let decoded;
    try { decoded = JSON.parse(rows[0].actions); } catch { return { invalid: true }; }
    const actions = telegramActionsOf(decoded);
    return actions && nextAction < actions.length ? { actions, nextAction } : { invalid: true };
  }

  /** Only one request may execute a handler while its response is not yet durable. */
  takeTelegramRenderLease(updateId, now) {
    const leaseUntil = now + TELEGRAM_RENDER_LEASE_MS;
    if (!Number.isSafeInteger(leaseUntil)) return null;
    const rows = [...this.sql.exec("SELECT lease_until FROM telegram_render WHERE update_id = ?", updateId)];
    if (rows.length !== 1) return null;
    const stored = safeNonnegativeInteger(Number(rows[0].lease_until));
    if (stored === null || stored > now) return null;
    this.sql.exec("UPDATE telegram_render SET lease_until = ? WHERE update_id = ?", leaseUntil, updateId);
    return leaseUntil;
  }

  /** Store the handler's exact response before its first Telegram attempt; retries reuse these same words. */
  storeTelegramResponse(updateId, actionsValue) {
    const id = Number.isSafeInteger(updateId) && updateId > 0 ? updateId : null;
    const actions = telegramActionsOf(actionsValue);
    if (id === null || !actions || !this.ctx.storage || typeof this.ctx.storage.transactionSync !== "function") return { ok: false };
    try {
      return this.ctx.storage.transactionSync(() => {
        if (![...this.sql.exec("SELECT seen_at FROM telegram_update WHERE update_id = ?", id)].length) return { ok: false };
        const pending = this.telegramResponse(id);
        if (!pending || pending.invalid) return { ok: false };
        if (!actions.length) {
          this.sql.exec("DELETE FROM telegram_response WHERE update_id = ?", id);
          this.sql.exec("DELETE FROM telegram_render WHERE update_id = ?", id);
          this.sql.exec("DELETE FROM telegram_effect WHERE update_id = ?", id);
          return { ok: true, pending: false, actions: [], nextAction: 0 };
        }
        const encoded = JSON.stringify(actions);
        if (pending.actions && JSON.stringify(pending.actions) !== encoded) return { ok: false };
        if (!pending.actions) this.sql.exec("UPDATE telegram_response SET actions = ? WHERE update_id = ?", encoded, id);
        this.sql.exec("UPDATE telegram_render SET lease_until = ? WHERE update_id = ?", 0, id);
        this.sql.exec("DELETE FROM telegram_effect WHERE update_id = ?", id);
        return { ok: true, pending: true, actions, nextAction: pending.nextAction };
      });
    } catch { return { ok: false }; }
  }

  /**
   * Make one command-side mutation replayable by update id. The request is bound as well as the result, so
   * a reused update id carrying different command input is refused rather than borrowing an earlier answer.
   */
  telegramEffectOnce(updateId, effect, requestValue, make) {
    if (updateId === undefined || updateId === null) return make();
    const id = Number.isSafeInteger(updateId) && updateId > 0 ? updateId : null;
    let request;
    try { request = JSON.stringify(requestValue); } catch { return { ok: false, why: "update" }; }
    if (id === null || typeof effect !== "string" || !/^[a-z]{1,16}$/.test(effect) ||
        typeof request !== "string" || new TextEncoder().encode(request).byteLength > MAX_TELEGRAM_EFFECT_BYTES || typeof make !== "function" ||
        !this.ctx.storage || typeof this.ctx.storage.transactionSync !== "function") return { ok: false, why: "update" };
    try {
      return this.ctx.storage.transactionSync(() => {
        const pending = this.telegramResponse(id);
        if (!pending || pending.invalid || pending.actions !== null) return { ok: false, why: "update" };
        const rows = [...this.sql.exec("SELECT request, result FROM telegram_effect WHERE update_id = ? AND effect = ?", id, effect)];
        if (rows.length) {
          if (rows.length !== 1 || rows[0].request !== request) return { ok: false, why: "update" };
          const stored = parseTelegramEffect(rows[0].result);
          return stored || { ok: false, why: "update" };
        }
        const result = make();
        const encoded = JSON.stringify(result);
        if (!result || typeof result !== "object" || Array.isArray(result) || typeof encoded !== "string" ||
            new TextEncoder().encode(encoded).byteLength > MAX_TELEGRAM_EFFECT_BYTES) {
          return { ok: false, why: "update" };
        }
        this.sql.exec("INSERT INTO telegram_effect (update_id, effect, request, result) VALUES (?, ?, ?, ?)", id, effect, request, encoded);
        return result;
      });
    } catch { return { ok: false, why: "update" }; }
  }

  /** Claim one already-rendered action before crossing the Telegram network boundary. */
  claimTelegramAction(updateId, index, now = Date.now()) {
    const id = Number.isSafeInteger(updateId) && updateId > 0 ? updateId : null;
    const expected = safeNonnegativeInteger(index);
    const at = safeNonnegativeInteger(now);
    if (id === null || expected === null || at === null || !this.ctx.storage ||
        typeof this.ctx.storage.transactionSync !== "function") return { ok: false };
    try {
      return this.ctx.storage.transactionSync(() => {
        const pending = this.telegramResponse(id);
        if (!pending || pending.invalid || !pending.actions || expected !== pending.nextAction) return { ok: false };
        const leaseUntil = this.takeTelegramRenderLease(id, at);
        return { ok: true, pending: true, actions: pending.actions, nextAction: pending.nextAction,
          send: leaseUntil !== null, leaseUntil };
      });
    } catch { return { ok: false }; }
  }

  /** A definite Telegram refusal gives the same action back immediately; uncertain sends keep the lease. */
  releaseTelegramAction(updateId, index, leaseValue) {
    const id = Number.isSafeInteger(updateId) && updateId > 0 ? updateId : null;
    const expected = safeNonnegativeInteger(index);
    const leaseUntil = safeNonnegativeInteger(leaseValue);
    if (id === null || expected === null || leaseUntil === null || !this.ctx.storage ||
        typeof this.ctx.storage.transactionSync !== "function") return { ok: false };
    try {
      return this.ctx.storage.transactionSync(() => {
        const pending = this.telegramResponse(id);
        const rows = [...this.sql.exec("SELECT lease_until FROM telegram_render WHERE update_id = ?", id)];
        if (!pending || pending.invalid || !pending.actions || expected !== pending.nextAction || rows.length !== 1 ||
            safeNonnegativeInteger(Number(rows[0].lease_until)) !== leaseUntil) return { ok: false };
        this.sql.exec("UPDATE telegram_render SET lease_until = ? WHERE update_id = ?", 0, id);
        return { ok: true, pending: true, actions: pending.actions, nextAction: pending.nextAction };
      });
    } catch { return { ok: false }; }
  }

  /** Advance one accepted action atomically. A lost acknowledgement can be read back without moving twice. */
  advanceTelegramResponse(updateId, index, leaseValue) {
    const id = Number.isSafeInteger(updateId) && updateId > 0 ? updateId : null;
    const expected = safeNonnegativeInteger(index);
    const leaseUntil = safeNonnegativeInteger(leaseValue);
    if (id === null || expected === null || leaseUntil === null || !this.ctx.storage || typeof this.ctx.storage.transactionSync !== "function") return { ok: false };
    try {
      return this.ctx.storage.transactionSync(() => {
        const pending = this.telegramResponse(id);
        const leases = [...this.sql.exec("SELECT lease_until FROM telegram_render WHERE update_id = ?", id)];
        if (!pending || pending.invalid || !pending.actions || expected !== pending.nextAction || leases.length !== 1 ||
            safeNonnegativeInteger(Number(leases[0].lease_until)) !== leaseUntil) return { ok: false };
        const nextAction = expected + 1;
        if (nextAction >= pending.actions.length) {
          this.sql.exec("DELETE FROM telegram_response WHERE update_id = ?", id);
          this.sql.exec("DELETE FROM telegram_render WHERE update_id = ?", id);
          return { ok: true, pending: false, actions: pending.actions, nextAction };
        }
        this.sql.exec("UPDATE telegram_response SET next_action = ? WHERE update_id = ?", nextAction, id);
        this.sql.exec("UPDATE telegram_render SET lease_until = ? WHERE update_id = ?", 0, id);
        return { ok: true, pending: true, actions: pending.actions, nextAction };
      });
    } catch { return { ok: false }; }
  }

  /** Synchronous and called only inside claimTelegramUpdate's transaction. */
  takeTelegramCommand(owner, now) {
    const limit = this.telegramCommandsPerWindow();
    const expires = now + this.telegramCommandWindowMs();
    if (!Number.isSafeInteger(expires)) return false;
    const rows = [...this.sql.exec("SELECT taken, expires FROM telegram_command_bucket WHERE owner = ?", owner)];
    if (!rows.length) {
      this.sql.exec("INSERT INTO telegram_command_bucket (owner, taken, expires) VALUES (?, ?, ?)", owner, 1, expires);
      return true;
    }
    if (rows.length !== 1) return false;
    const taken = safeNonnegativeInteger(Number(rows[0].taken));
    const storedExpiry = safeNonnegativeInteger(Number(rows[0].expires));
    if (taken === null || taken < 1 || storedExpiry === null || storedExpiry <= now || taken >= limit) return false;
    this.sql.exec("UPDATE telegram_command_bucket SET taken = ? WHERE owner = ?", taken + 1, owner);
    return true;
  }

  /** Keep the strong dedupe table bounded to Telegram's documented webhook retention window. */
  pruneTelegramUpdates(now = Date.now()) {
    const at = safeNonnegativeInteger(now);
    if (at === null) return false;
    const cutoff = Math.max(0, at - TELEGRAM_UPDATE_TTL_MS);
    this.sql.exec("DELETE FROM telegram_response WHERE update_id IN (SELECT update_id FROM telegram_update WHERE seen_at <= ?)", cutoff);
    this.sql.exec("DELETE FROM telegram_render WHERE update_id IN (SELECT update_id FROM telegram_update WHERE seen_at <= ?)", cutoff);
    this.sql.exec("DELETE FROM telegram_effect WHERE update_id IN (SELECT update_id FROM telegram_update WHERE seen_at <= ?)", cutoff);
    this.sql.exec("DELETE FROM telegram_update WHERE seen_at <= ?", cutoff);
    return true;
  }

  /** Physically remove expired per-user command windows even when that user sends nothing else. */
  pruneTelegramCommandBuckets(now = Date.now()) {
    const at = safeNonnegativeInteger(now);
    if (at === null) return false;
    this.sql.exec("DELETE FROM telegram_command_bucket WHERE expires <= ?", at);
    return true;
  }

  // ---------------------------------------------------------------- the network, all of it through the one Gate
  call(method, params) {
    const client = rpcGate(this.env);
    return client ? client.call(method, params) : Promise.reject(new Error("invalid rpc url"));
  }

  async head() {
    try {
      const block = await this.call("eth_getBlockByNumber", ["finalized", false]);
      return rpcQuantityNumber(block && block.number);
    } catch { return null; }
  }

  /**
   * Prove the endpoint briefly, and bind the durable proof to the exact effective RPC URL without storing a
   * possibly credential-bearing URL in the object. Old `chain_ok=yes` rows have neither timestamp nor digest,
   * so an object upgraded from the earlier shape re-proves before reading any chain fact.
   */
  async chainProof(now) {
    const at = safeNonnegativeInteger(now);
    const effectiveUrl = configuredHttps(this.env, "RPC_URL", DEFAULT_RPC);
    if (at === null || !effectiveUrl) return { ok: false, why: "rpc" };
    let rpc;
    try { rpc = await bytesHash(new TextEncoder().encode(effectiveUrl)); }
    catch { return { ok: false, why: "rpc" }; }
    const provedAt = storedNonnegativeInteger(this.get("chain_ok_at"));
    if (this.get("chain_ok") === "yes" && this.get("chain_ok_rpc") === rpc && provedAt !== null &&
        provedAt <= at && at - provedAt < DEFAULT_CHAIN_PROOF_TTL_MS) return { ok: true };

    const id = await chainId(this.env);
    this.set("chain_ok", id === CHAIN_ID ? "yes" : "no");
    this.set("chain_ok_at", at);
    this.set("chain_ok_rpc", rpc);
    if (id === null) return { ok: false, why: "rpc" };
    return id === CHAIN_ID ? { ok: true } : { ok: false, why: "chain", id };
  }

  async ethCall(to, data) {
    try {
      const r = await this.call("eth_call", [{ to, data }, "latest"]);
      return typeof r === "string" && r.length > 2 ? r : null;
    } catch { return null; }
  }

  /** The launches in a block range, from the factory's own log. null when the range could not be read. */
  async launchesIn(from, to, maxLaunches = this.maxLaunches()) {
    if (!Number.isSafeInteger(maxLaunches) || maxLaunches < 1 || maxLaunches > DEFAULT_MAX_LAUNCHES) return null;
    let logs;
    try {
      logs = await this.call("eth_getLogs", [{ address: FACTORY, topics: [TOPIC_TOKEN_LAUNCHED], fromBlock: hexNum(from), toBlock: hexNum(to) }]);
    } catch { return null; }
    if (!Array.isArray(logs)) return null;
    if (logs.length > maxLaunches) return LAUNCH_PAGE_OVERFLOW;
    const out = [];
    const positions = new Set();
    const tokens = new Set();
    const blockHashes = new Map();
    for (const l of logs) {
      const event = l && canonicalParams([ABI.address, ABI.uint, ABI.uint], l.data);
      const transactionHash = l && nonzeroHash(l.transactionHash);
      const blockHash = l && nonzeroHash(l.blockHash);
      if (!l || typeof l !== "object" || Array.isArray(l) || typeof l.address !== "string" ||
          l.address.toLowerCase() !== FACTORY.toLowerCase() || l.removed !== false ||
          !Array.isArray(l.topics) || l.topics.length !== 4 ||
          l.topics.some(topicValue => typeof topicValue !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topicValue)) ||
          l.topics[0].toLowerCase() !== TOPIC_TOKEN_LAUNCHED.toLowerCase() ||
          !event || !transactionHash || !blockHash) return null;
      const block = rpcQuantityNumber(l.blockNumber);
      const logIndex = rpcQuantityNumber(l.logIndex);
      const token = nonzeroAddress(addressOfTopic(l.topics[1]));
      const curve = nonzeroAddress(addressOfTopic(l.topics[2]));
      const deployer = nonzeroAddress(addressOfTopic(l.topics[3]));
      const pair = canonicalAddress(event[0]);
      if (!token || !curve || !deployer || !pair || block === null || logIndex === null || block < from || block > to) return null;
      const knownBlockHash = blockHashes.get(block);
      if (knownBlockHash && knownBlockHash !== blockHash) return null;
      blockHashes.set(block, blockHash);
      const position = block + ":" + logIndex;
      if (positions.has(position) || tokens.has(token)) return null;
      positions.add(position);
      tokens.add(token);
      out.push({
        token,
        curve,
        deployer,
        pair,
        block,
        tx: transactionHash,
        block_hash: blockHash,
        event_data: l.data.toLowerCase(),
        log_index: logIndex
      });
    }
    return out.sort((a, b) => a.block - b.block || a.log_index - b.log_index);
  }

  /**
   * What a launch calls itself: the same four reads tools/launch-collect.mjs makes, decoded with the same
   * codec. tools/launch/abi.mjs is imported rather than copied, for the same reason the engine is: a second
   * decoder in this repository could disagree with the first one about a string.
   *
   * null when any of the four did not answer, exactly as the collector treats an unreadable token.
   */
  async readLaunch(launch) {
    const token = launch && launch.token;
    if (!nonzeroAddress(token) || !nonzeroAddress(launch.curve) || !nonzeroAddress(launch.deployer) || !canonicalAddress(launch.pair)) return null;
    const [name, symbol, info, launched] = await Promise.all([
      this.ethCall(token, SEL_TOKEN.name),
      this.ethCall(token, SEL_TOKEN.symbol),
      this.ethCall(token, SEL_TOKEN.info),
      this.ethCall(FACTORY, SEL.launched + pad(token))
    ]);
    const names = canonicalParams([ABI.string], name);
    const symbols = canonicalParams([ABI.string], symbol);
    const i = canonicalParams(TOKEN_INFO, info);
    const record = canonicalParams([LAUNCHED_TOKEN], launched);
    const l = record && record[0];
    if (!names || !symbols || !i || !l || lower(i[0]) !== lower(launch.deployer) ||
        lower(l[0]) !== lower(token) || lower(l[1]) !== lower(launch.curve) || lower(l[2]) !== lower(launch.deployer) ||
        lower(l[4]) !== lower(launch.pair) || l[14] !== true) return null;
    return {
      name: names[0],
      symbol: symbols[0],
      logo: i[1],
      description: i[2],
      socials: i[3],
      recipient: lower(l[3]),
      exists: true
    };
  }

  /**
   * A block's utc date, which is what the index's `first` field holds.
   *
   * The collector finds these without a call per block, by bisecting for midnights across a fixed window. The
   * watcher cannot: it sees blocks as they arrive and has no window to bisect. So it reads the block that
   * carried a launch, once, and remembers it. Launches are rare enough per round for that to be one extra
   * call on the rounds that have any and none at all on the rounds that do not.
   */
  async timeOf(block, expectedHash) {
    const requested = Number.isSafeInteger(block) && block >= 0 ? block : null;
    const boundHash = nonzeroHash(expectedHash);
    if (requested === null || !boundHash) return null;
    const key = "ts:" + requested + ":" + boundHash;
    const known = this.get(key);
    if (known !== null) return storedTimestamp(known);
    try {
      const b = await this.call("eth_getBlockByNumber", [hexNum(requested), false]);
      if (!b || typeof b !== "object" || Array.isArray(b)) return null;
      const answered = rpcQuantityNumber(b.number);
      const ts = rpcQuantityNumber(b.timestamp);
      if (answered !== requested || nonzeroHash(b.hash) !== boundHash || ts === null || dateOfSeconds(ts) === null) return null;
      this.set(key, ts);
      return ts;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- the three published files
  /** Small build-written binding between the exact index/numbers bytes, plus its exact-byte generation. */
  async manifestState(now = Date.now()) {
    const url = configuredHttps(this.env, "LAUNCH_MANIFEST_URL", MANIFEST_URL);
    if (!url) return null;
    const cached = publishedCache.manifest;
    if (cached.value && cached.url === url && now - cached.at < this.indexTtlMs()) return cached;
    // index() and numbers() are normally called together. One in-flight read makes both bind to the exact
    // same manifest even if an upload replaces it between network requests.
    if (manifestFlight && manifestFlight.url === url) return manifestFlight.promise;
    const epoch = publishedEpoch;
    const flight = { url, promise: null };
    flight.promise = (async () => {
      try {
        const bytes = await publishedResponseBytes(url, 65536);
        if (!bytes) return null;
        const value = publishedManifestOf(jsonBytes(bytes));
        if (!value || value.index.bytes > MAX_PUBLISHED_FILE_BYTES || value.numbers.bytes > MAX_PUBLISHED_FILE_BYTES) return null;
        const generation = await bytesHash(bytes);
        const record = { at: now, value, generation, url };
        if (epoch === publishedEpoch) {
          if (publishedCache.manifest.generation !== generation) {
            publishedCache.index = { at: 0, value: null, generation: null, url: null };
            publishedCache.numbers = { at: 0, value: null, generation: null, url: null };
          }
          publishedCache.manifest = record;
        }
        return record;
      } catch { return null; }
    })();
    manifestFlight = flight;
    try {
      return await flight.promise;
    } finally {
      if (epoch === publishedEpoch && manifestFlight === flight) manifestFlight = null;
    }
  }

  async manifest(now = Date.now()) {
    const state = await this.manifestState(now);
    return state ? state.value : null;
  }

  /** The index the page reads, or null. Never an empty table standing in for one: see checkRules. */
  async index(now = Date.now()) {
    try {
      const url = configuredHttps(this.env, "LAUNCH_INDEX_URL", INDEX_URL);
      if (!url) return null;
      const state = await this.manifestState(now);
      if (!state) return null;
      const cached = publishedCache.index;
      if (cached.value && cached.url === url && cached.generation === state.generation && now - cached.at < this.indexTtlMs()) return cached.value;
      const bytes = await publishedResponseBytes(url, state.value.index.bytes);
      if (!bytes || bytes.length !== state.value.index.bytes || await bytesHash(bytes) !== state.value.index.sha256) return null;
      const value = jsonBytes(bytes);
      if (!validLaunchIndex(value, { entries: state.value.index.entries, entries_total: state.value.index.entries_total })) return null;
      if (publishedCache.manifest.generation === state.generation) publishedCache.index = { at: now, value, generation: state.generation, url };
      return value;
    } catch {
      return null;
    }
  }

  /** The snapshot's own numbers, for the one figure the tail has to state: where the snapshot ended. */
  async numbers(now = Date.now()) {
    try {
      const url = configuredHttps(this.env, "LAUNCH_NUMBERS_URL", NUMBERS_URL);
      if (!url) return null;
      const state = await this.manifestState(now);
      if (!state) return null;
      const cached = publishedCache.numbers;
      if (cached.value && cached.url === url && cached.generation === state.generation && now - cached.at < this.indexTtlMs()) return cached.value;
      const bytes = await publishedResponseBytes(url, state.value.numbers.bytes);
      if (!bytes || bytes.length !== state.value.numbers.bytes || await bytesHash(bytes) !== state.value.numbers.sha256) return null;
      const value = jsonBytes(bytes);
      if (!value || typeof value !== "object") return null;
      if (publishedCache.manifest.generation === state.generation) publishedCache.numbers = { at: now, value, generation: state.generation, url };
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
    if (this.running) return { ran: false, why: "in flight", scheduled: true };
    this.running = true;
    try { return await this.tickOnce(now); }
    finally { this.running = false; }
  }

  async tickOnce(now) {
    // A Telegram failure is independent of the RPC. Retry durable private notifications even if this round's
    // endpoint later proves unreadable. The delivery ledger prevents a replayed launch from sending twice
    // after Telegram already accepted it.
    const retriedFired = await this.flushRuleDeliveries(now);
    const pendingDeliveries = this.pendingRuleDeliveryCount();
    const deliveryCapacity = this.ruleDeliveryTotalLimit();
    if (pendingDeliveries === null || deliveryCapacity < 1 || pendingDeliveries >= deliveryCapacity) {
      const next = this.lastBlock();
      if (next !== null && Number.isSafeInteger(next) && next < Number.MAX_SAFE_INTEGER) this.set("rule_delivery_blocked_at", next + 1);
      await this.schedule(now);
      return { ran: false, why: "rule delivery backlog", pending: pendingDeliveries, scheduled: true };
    }
    this.del("rule_delivery_blocked_at");
    const ready = engineSelfTest();
    if (!ready.ok) {
      await this.ctx.storage.deleteAlarm();
      this.set("idle_reason", "engine: " + ready.why);
      return { ran: false, why: "engine", detail: ready.why, scheduled: false };
    }

    const proof = await this.chainProof(now);
    if (!proof.ok) {
      if (proof.why === "rpc") return await this.stand("rpc");
      await this.ctx.storage.deleteAlarm();
      this.set("idle_reason", "chain id " + proof.id);
      return { ran: false, why: "chain", scheduled: false };
    }

    const head = await this.head();
    if (head === null) return await this.stand("rpc");
    if (!Number.isSafeInteger(head) || head < 0) return await this.stand("rpc");
    this.set("observed_finalized", head);
    this.set("idle_reason", "");

    const last = this.lastBlock();
    // Public deployer history begins at a saved block boundary when this code first runs. Existing private tail
    // rows may predate the bounded cleartext metadata, so they are never retroactively presented as a complete
    // history. The first covered block is the one after this value.
    if (this.get("history_started_block") === null) {
      this.set("history_started_block", last === null ? head : last);
      this.set("history_started_at", now);
    }
    if (last === null) {
      // the tail starts where the watcher wakes up and replays nothing. The gap between the snapshot's last
      // block and this one is a hole, and /api/tail states it rather than implying there is none
      this.set("last_block", head);
      this.set("started_block", head);
      this.set("started_at", now);
      this.set("last_round_at", now);
      this.bump("rounds");
      this.wallCached = { at: 0, key: null, body: null };
      await this.schedule(now);
      return { ran: true, first: true, from: head, to: head, launches: 0, scheduled: true };
    }

    const from = last + 1;
    let to = Math.min(head, from + this.maxBlocks() - 1);
    if (to < from) {
      this.cleanupRuleDeliveriesThrough(last);
      this.set("last_round_at", now);
      this.bump("rounds");
      this.wallCached = { at: 0, key: null, body: null };
      await this.schedule(now);
      return { ran: true, from, to: last, launches: 0, fired: retriedFired, scheduled: true };
    }

    let list;
    while (true) {
      list = await this.launchesIn(from, to, this.maxLaunches());
      if (list !== LAUNCH_PAGE_OVERFLOW) break;
      if (to === from) {
        this.set("launch_overflow_block", from);
        return await this.retreat("launch overflow");
      }
      // One bounded retry keeps overflow handling inside the same request budget. The next complete beat can
      // continue after that first block; repeatedly bisecting a long range would make log-page calls unbounded.
      to = from;
    }
    if (list === null) return await this.retreat("logs");
    const priorOverflow = storedNonnegativeInteger(this.get("launch_overflow_block"));
    if (priorOverflow !== null && priorOverflow >= from && priorOverflow <= to) this.del("launch_overflow_block");

    let stored = 0, unreadable = 0, fired = retriedFired;
    const attempts = this.num("attempts:" + from, 0) + 1;
    const readable = [];
    for (const l of list) {
      const fields = await this.readLaunch(l);
      const ts = await this.timeOf(l.block, l.block_hash);
      const date = ts === null ? null : dateOfSeconds(ts);
      if (!fields || ts === null || date === null) {
        // A launch that will not read is not written half read, and the cursor does not step over it on the
        // first try: the whole range is retried. After READ_ATTEMPTS it is skipped and counted, because a
        // token that never answers would otherwise stop the tail for good.
        if (attempts < READ_ATTEMPTS) {
          this.set("attempts:" + from, attempts);
          return await this.retreat("fields");
        }
        unreadable++;
        this.bump("unreadable");
        this.set("last_unreadable_block", Math.max(this.num("last_unreadable_block", 0), Number(l.block)));
        this.cached = { at: 0, body: null };
        continue;
      }
      readable.push({ ...l, ...fields, ts, date });
    }
    if (this.lastBlock() !== last) return await this.retreat("cursor changed");
    // No rule observes a partial batch. In particular, the final retry records every skipped position before
    // a later readable launch can ask a shared rule to treat the post-snapshot suffix as complete.
    for (const launch of readable) {
      const fresh = await this.record(launch);
      if (fresh) stored++;
      // Cursor commit happens after this loop. If an event crashed after record() but before its outbox row,
      // the unchanged cursor replays it and this exact-position check completes the enqueue. Sent ledger rows
      // make the same path idempotent after a confirmed delivery.
      if (fresh || await this.recordedLaunchMatches(launch)) {
        const checkedRules = await this.checkRules(launch, now);
        if (checkedRules === RULE_DELIVERY_OVERFLOW) {
          this.set("rule_delivery_blocked_at", launch.block);
          return await this.retreat("rule delivery backlog");
        }
        fired += checkedRules;
      }
    }
    this.del("attempts:" + from);

    const pruned = await this.prune(now);
    this.set("last_block", to);
    this.cleanupRuleDeliveriesThrough(to);
    for (const launch of list) this.del("ts:" + launch.block + ":" + launch.block_hash);
    this.set("last_round_at", now);
    this.bump("rounds");
    if (stored) this.bump("launches_seen", stored);
    this.cached = { at: 0, body: null };
    this.wallCached = { at: 0, key: null, body: null };
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
   * Remember one launch once, as counted hashes plus the private fields this object needs.
   *
   * What is stored here and never handed out: the token address, the deployer address and the transaction.
   * They are needed to name a launch in a direct message and to answer a dev rule, and they are exactly what
   * the published index refuses to carry, so they stay on this side of /api/tail. The JSON row also carries a
   * digest of the exact event and decoded declarations. It never leaves through tailRow(), but makes a crash
   * replay idempotent only when the RPC repeats the same launch rather than a new payload at the same position.
   */
  async record(launch) {
    const already = [...this.sql.exec("SELECT block, row FROM tail WHERE token = ?", launch.token)];
    if (already.length) {
      const saved = already.length === 1 ? parseRow(already[0].row) : null;
      const savedBlock = already.length === 1 ? safeNonnegativeInteger(already[0].block) : null;
      const savedLogIndex = saved && saved.wall ? safeNonnegativeInteger(saved.wall.log_index) : null;
      const nextBlock = safeNonnegativeInteger(launch.block);
      const nextLogIndex = safeNonnegativeInteger(launch.log_index);
      // A token-address replay is idempotent only if its position and complete durable fingerprint match. A
      // conflict cannot be represented by token-keyed private storage, so close the wall rather than silently
      // keeping one payload while allowing the other to drive a rule.
      if (savedBlock === null || savedLogIndex === null || nextBlock === null || nextLogIndex === null ||
          savedBlock !== nextBlock || savedLogIndex !== nextLogIndex || !await this.recordedLaunchMatches(launch)) {
        this.set("wall_index_error_block", nextBlock === null ? Number.MAX_SAFE_INTEGER : nextBlock);
        this.cached = { at: 0, body: null };
      }
      return false;
    }
    const row = await durableRowOf(launch);
    if (!row) {
      const block = safeNonnegativeInteger(launch && launch.block);
      this.set("wall_index_error_block", block === null ? Number.MAX_SAFE_INTEGER : block);
      this.cached = { at: 0, body: null };
      return false;
    }
    const nextBlock = safeNonnegativeInteger(launch.block);
    const nextLogIndex = safeNonnegativeInteger(row.wall && row.wall.log_index);
    const atPosition = nextBlock === null || nextLogIndex === null ? [] :
      [...this.sql.exec("SELECT token FROM wall_event WHERE block = ? AND log_index = ?", nextBlock, nextLogIndex)];
    if (nextBlock === null || nextLogIndex === null || atPosition.length > 1 ||
        (atPosition.length === 1 && lower(atPosition[0].token) !== lower(launch.token))) {
      this.set("wall_index_error_block", nextBlock === null ? Number.MAX_SAFE_INTEGER : nextBlock);
      this.cached = { at: 0, body: null };
      return false;
    }
    this.sql.exec(
      "INSERT INTO tail (token, block, ts, date, deployer, tx, row) VALUES (?, ?, ?, ?, ?, ?, ?)",
      launch.token, Number(launch.block), Number(launch.ts), launch.date, lower(launch.deployer), String(launch.tx || ""), JSON.stringify(row)
    );
    // The public wall has its own positional table. It includes a row even when the two declarations are not
    // publishable, so pagination proves event coverage independently of what is safe to display.
    const wallStored = this.storeWallEvent(launch.token, Number(launch.block), row.wall);
    if (!wallStored) {
      this.set("wall_index_error_block", Number(launch.block));
      this.cached = { at: 0, body: null };
    }
    for (const [ns, value] of Object.entries(row.hashes)) {
      const list = (Array.isArray(value) ? value : [value]).filter(Boolean);
      for (const h of list) this.sql.exec("INSERT INTO tail_hash (token, ns, hash) VALUES (?, ?, ?)", launch.token, ns, h);
    }
    return true;
  }

  /** True only when every event/declaration field matches the durable row; conflicts never notify rules. */
  async recordedLaunchMatches(launch) {
    const rows = [...this.sql.exec("SELECT block, ts, date, deployer, tx, row FROM tail WHERE token = ?", launch.token)];
    if (rows.length !== 1) return false;
    const saved = parseRow(rows[0].row);
    const expected = await durableRowOf(launch);
    return expected !== null && saved !== null &&
      safeNonnegativeInteger(Number(rows[0].block)) === safeNonnegativeInteger(Number(launch.block)) &&
      safeNonnegativeInteger(Number(rows[0].ts)) === safeNonnegativeInteger(Number(launch.ts)) &&
      String(rows[0].date) === String(launch.date) &&
      lower(rows[0].deployer) === lower(launch.deployer) &&
      lower(rows[0].tx) === lower(launch.tx) &&
      JSON.stringify(saved) === JSON.stringify(expected);
  }

  /** Store one canonical factory position. A conflicting position closes the wall instead of picking a row. */
  storeWallEvent(token, blockValue, wall) {
    const block = safeNonnegativeInteger(blockValue);
    const logIndex = safeNonnegativeInteger(wall && wall.log_index);
    if (block === null || logIndex === null) return false;
    const at = [...this.sql.exec("SELECT token FROM wall_event WHERE block = ? AND log_index = ?", block, logIndex)];
    if (at.length) return at.length === 1 && String(at[0].token).toLowerCase() === String(token).toLowerCase();
    const name = wallText(wall && wall.name);
    const ticker = wallText(wall && wall.ticker);
    this.sql.exec(
      "INSERT INTO wall_event (block, log_index, token, name, ticker, publishable) VALUES (?, ?, ?, ?, ?, ?)",
      block, logIndex, String(token), name, ticker, name !== null && ticker !== null ? 1 : 0
    );
    return true;
  }

  /**
   * Bounded rollout for rows written before wall_event existed. Until every strict-suffix tail row has a
   * positional record, the public endpoint returns migrating/backfill and never a partial page.
   */
  backfillWallEvents(snapshotTo) {
    const batch = [...this.sql.exec(
      "SELECT t.token AS token, t.block AS block, t.row AS row FROM tail AS t LEFT JOIN wall_event AS w ON w.token = t.token WHERE t.block > ? AND w.token IS NULL ORDER BY t.block, t.token LIMIT ?",
      snapshotTo, this.wallPageRows()
    )];
    for (const record of batch) {
      const row = parseRow(record.row);
      if (!row || !row.wall || !this.storeWallEvent(record.token, Number(record.block), row.wall)) return { ok: false, why: "backfill" };
    }
    const missing = this.count("SELECT COUNT(*) AS n FROM tail AS t LEFT JOIN wall_event AS w ON w.token = t.token WHERE t.block > ? AND w.token IS NULL", snapshotTo);
    return missing ? { ok: false, why: "migrating" } : { ok: true };
  }

  /** How many launches in the tail carry one hash in one namespace, optionally strictly after one block. */
  tailCount(ns, hash, afterBlock = null) {
    if (!hash) return 0;
    if (afterBlock !== null && afterBlock !== undefined) {
      return this.count("SELECT COUNT(*) AS n FROM tail_hash AS h JOIN tail AS t ON t.token = h.token WHERE h.ns = ? AND h.hash = ? AND t.block > ?", ns, hash, Number(afterBlock));
    }
    return this.count("SELECT COUNT(*) AS n FROM tail_hash WHERE ns = ? AND hash = ?", ns, hash);
  }

  /** One rule/launch delivery row, retained through tail replay and removed with the rule or launch. */
  ruleDelivery(ruleId, token) {
    const rows = [...this.sql.exec("SELECT owner, body, sent, made, last_attempt FROM rule_delivery WHERE rule_id = ? AND token = ?", Number(ruleId), String(token))];
    if (rows.length !== 1) return rows.length ? { invalid: true } : null;
    const sent = Number(rows[0].sent);
    const made = safeNonnegativeInteger(Number(rows[0].made));
    const lastAttempt = safeNonnegativeInteger(Number(rows[0].last_attempt));
    if ((sent !== 0 && sent !== 1) || made === null || lastAttempt === null || typeof rows[0].owner !== "string" || typeof rows[0].body !== "string") return { invalid: true };
    return { ruleId: Number(ruleId), token: String(token), owner: rows[0].owner, body: rows[0].body, sent, made, lastAttempt };
  }

  queueRuleDelivery(rule, launch, body, now) {
    if (!sameRuleDefinition(this.rules.get(rule.id), rule)) return { invalid: true };
    const existing = this.ruleDelivery(rule.id, launch.token);
    if (existing) return existing;
    const pending = this.pendingRuleDeliveryCount();
    const capacity = this.ruleDeliveryTotalLimit();
    if (pending === null || capacity < 1) return { invalid: true };
    if (pending >= capacity) return { capacity: true, invalid: true };
    const made = safeNonnegativeInteger(now);
    if (made === null) return { invalid: true };
    this.sql.exec(
      "INSERT OR IGNORE INTO rule_delivery (rule_id, token, owner, body, sent, made, last_attempt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      Number(rule.id), String(launch.token), String(rule.owner), String(body), 0, made, 0
    );
    return this.ruleDelivery(rule.id, launch.token) || { invalid: true };
  }

  /** Mark first, then count: a crash may under-count hits, but cannot turn one accepted line into two hits. */
  acceptRuleDelivery(delivery) {
    this.sql.exec("UPDATE rule_delivery SET sent = ? WHERE rule_id = ? AND token = ?", 1, delivery.ruleId, delivery.token);
    this.rules.bumpHit(delivery.ruleId);
    this.bump("rules_fired");
    // Once the durable cursor covers the source launch, no future range can replay it and the sent ledger has
    // no remaining dedupe job. Ahead-of-cursor rows survive until that cursor commits.
    const source = [...this.sql.exec("SELECT block, row FROM tail WHERE token = ?", delivery.token)];
    const cursor = safeNonnegativeInteger(this.lastBlock());
    const sourceBlock = source.length === 1 ? safeNonnegativeInteger(Number(source[0].block)) : null;
    if (!source.length || (cursor !== null && sourceBlock !== null && sourceBlock <= cursor)) {
      this.sql.exec("DELETE FROM rule_delivery WHERE rule_id = ? AND token = ?", delivery.ruleId, delivery.token);
    }
  }

  /** Retire only accepted ledgers whose source range is already behind the durable watcher cursor. */
  cleanupRuleDeliveriesThrough(block) {
    const through = safeNonnegativeInteger(block);
    if (through === null) return false;
    this.sql.exec(
      "DELETE FROM rule_delivery WHERE sent = ? AND token IN (SELECT token FROM tail WHERE block <= ?)",
      1, through
    );
    return true;
  }

  async sendRuleDelivery(delivery, now = Date.now()) {
    const at = safeNonnegativeInteger(now);
    if (!delivery || delivery.invalid || delivery.sent === 1 || at === null) return false;
    // Every inspected row moves behind never-attempted work. Without this durable rotation, a full LIMIT of
    // dormant owners at the front could starve a later live holder forever.
    this.sql.exec("UPDATE rule_delivery SET last_attempt = ? WHERE rule_id = ? AND token = ?", at, delivery.ruleId, delivery.token);
    const session = this.env.SESSIONS ? await getSession(this.env.SESSIONS, delivery.owner).catch(() => null) : null;
    if (!session) {
      // KV expiry does not wake a Durable Object. Bound the private text here on the next retry, but retain a
      // young row in case the transient absence is repaired before the session's own maximum lifetime.
      if (at >= delivery.made && at - delivery.made >= RULE_DELIVERY_RETENTION_MS) {
        this.sql.exec("DELETE FROM rule_delivery WHERE rule_id = ? AND token = ?", delivery.ruleId, delivery.token);
        this.bump("expired_rule_deliveries");
      } else {
        this.bump("dormant_skips");
      }
      return false;
    }
    const active = this.rules.get(delivery.ruleId);
    if (!active || String(active.owner) !== String(delivery.owner)) {
      this.sql.exec("DELETE FROM rule_delivery WHERE rule_id = ? AND token = ?", delivery.ruleId, delivery.token);
      return false;
    }
    if (!await sendMessage(this.env, delivery.owner, delivery.body, { quiet: true, preview: false })) return false;
    this.acceptRuleDelivery(delivery);
    return true;
  }

  /** Retry one bounded, fairly rotated batch. Sent rows remain as the ledger until their launch is pruned. */
  async flushRuleDeliveries(now = Date.now()) {
    const pending = [...this.sql.exec(
      "SELECT rule_id, token, owner, body, sent, made, last_attempt FROM rule_delivery WHERE sent = ? ORDER BY last_attempt, made, rule_id, token LIMIT ?",
      0, this.ruleDeliveryBatch()
    )];
    if (!pending.length) return 0;
    const active = new Map(this.rules.all().map(rule => [Number(rule.id), rule]));
    let fired = 0;
    for (const row of pending) {
      const delivery = this.ruleDelivery(row.rule_id, row.token);
      const rule = active.get(Number(row.rule_id));
      if (!rule || !delivery || delivery.invalid || delivery.owner !== String(rule.owner)) {
        // A row that cannot be tied exactly to an active rule is neither safe to send nor useful as a ledger.
        this.sql.exec("DELETE FROM rule_delivery WHERE rule_id = ? AND token = ?", Number(row.rule_id), String(row.token));
        continue;
      }
      if (await this.sendRuleDelivery(delivery, now)) fired++;
    }
    return fired;
  }

  /** Whether the stored/live tail joins a published snapshot without a startup, skipped-read, or prune gap. */
  tailCompleteAfter(snapshotTo) {
    const boundary = safeNonnegativeInteger(snapshotTo);
    const started = storedNonnegativeInteger(this.get("started_block"));
    if (boundary === null || started === null || started > boundary) return false;

    const unreadable = storedNonnegativeInteger(this.get("unreadable"), 0);
    const unreadableRaw = this.get("last_unreadable_block");
    const unreadableBlock = storedNonnegativeInteger(unreadableRaw);
    if (unreadable === null || (unreadable === 0 && unreadableRaw !== null) ||
        (unreadable > 0 && (unreadableBlock === null || unreadableBlock > boundary))) return false;

    const prunedRaw = this.get("wall_pruned_through");
    const prunedThrough = storedNonnegativeInteger(prunedRaw);
    if (prunedRaw !== null && (prunedThrough === null || prunedThrough > boundary)) return false;

    const indexErrorRaw = this.get("wall_index_error_block");
    const indexErrorBlock = storedNonnegativeInteger(indexErrorRaw);
    return !(indexErrorRaw !== null && (indexErrorBlock === null || indexErrorBlock > boundary));
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
    const rules = this.rules.all().filter(rule => {
      const delivery = this.ruleDelivery(rule.id, launch.token);
      return !delivery || delivery.invalid || delivery.sent !== 1;
    });
    if (!rules.length) return 0;

    const row = await rowOf(launch);
    const hasSharedRule = rules.some(rule => rule.kind === "shared");
    const [idx, numbers] = await Promise.all([this.index(now), hasSharedRule ? this.numbers(now) : null]);
    if (!idx) this.bump("index_unread");
    const snapshotTo = snapshotBoundary(numbers);
    const completeSuffix = snapshotTo !== null && this.tailCompleteAfter(snapshotTo);
    if (hasSharedRule && !completeSuffix) this.bump("snapshot_unread");
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
      indexState: ticker.state,
      indexCount: ticker.n,
      tailCount: completeSuffix ? this.tailCount("ticker", row.hashes.ticker, snapshotTo) : null
    };

    for (const rule of rules) {
      const hit = match(rule, subject);
      if (!hit) continue;
      const owner = rule.owner;

      const state = hit.where === "the name" ? indexOf("name") : hit.where === "a link" ? linkState(hit.field) : ticker;
      const counts = rule.kind === "shared"
        ? { indexState: hit.indexState, indexCount: hit.indexCount, tailCount: hit.tailCount, tailScope: "after_snapshot" }
        : hit.where === "the deployer"
          ? { indexState: null, indexCount: null, tailCount: this.deployerCount(launch.deployer), tailScope: "retained_tail" }
          : { indexState: state.state, indexCount: state.n, tailCount: this.tailCount(nsOf(hit.where), hashOf(row, hit)), tailScope: "retained_tail" };

      const text = TEXT.ruleHitText({
        kind: rule.kind,
        arg: rule.arg,
        where: hit.where + (hit.field ? " (" + hit.field + ")" : ""),
        indexState: counts.indexState,
        indexCount: counts.indexCount,
        tailCount: counts.tailCount,
        tailScope: counts.tailScope,
        block: launch.block,
        address: launch.token,
        txUrl: this.env.TX_URL_PREFIX && launch.tx ? (() => {
          const url = requiredHttpsUrlOf(this.env.TX_URL_PREFIX + launch.tx);
          return url ? link("the launch transaction", url) : null;
        })() : null
      });
      const delivery = this.queueRuleDelivery(rule, launch, text, now);
      // Delivery happens only through the one bounded flush at the start of a beat. Sending inline here would
      // let a fresh launch bypass RULE_DELIVERY_BATCH with one Telegram request per matching active rule. The
      // live-session read stays in that flush too: matching a launch therefore performs no per-rule external I/O.
      if (delivery.capacity) return RULE_DELIVERY_OVERFLOW;
      if (delivery.invalid || delivery.owner !== String(owner)) continue;
    }
    return 0;
  }

  /** Drop an old row only after the published snapshot proves that it covers that block. */
  async prune(now) {
    const snapshotTo = snapshotBoundary(await this.numbers(now));
    // An unreadable boundary means "keep", never "assume covered". Storage growth is safer than silently
    // turning the public post-snapshot wall into a partial list.
    if (snapshotTo === null) return 0;
    const cutoff = Math.floor((now - this.depthMs()) / 1000);
    const doomed = [...this.sql.exec("SELECT token FROM tail WHERE ts < ? AND block <= ? ORDER BY block, token LIMIT ?", cutoff, snapshotTo, MAX_TAIL_ROWS)].map(r => r.token);
    for (const token of doomed) {
      this.sql.exec("DELETE FROM tail WHERE token = ?", token);
      this.sql.exec("DELETE FROM tail_hash WHERE token = ?", token);
      this.sql.exec("DELETE FROM rule_delivery WHERE token = ? AND sent = ?", token, 1);
      this.sql.exec("DELETE FROM wall_event WHERE token = ?", token);
    }
    if (doomed.length) {
      const prior = storedNonnegativeInteger(this.get("wall_pruned_through"), 0);
      this.set("wall_pruned_through", Math.max(prior === null ? 0 : prior, snapshotTo));
      this.bump("pruned", doomed.length);
      this.cached = { at: 0, body: null };
      this.wallCached = { at: 0, key: null, body: null };
    }
    return doomed.length;
  }

  // ---------------------------------------------------------------- the tail, as it is handed out
  /**
   * What GET /api/tail answers.
   *
   * Counted hashes, a block range and a hash of the complete table for one bounded page. No address, no raw
   * string, no name — the
   * same rule the index writer enforces on the file the page reads, kept here by the same reasoning and
   * checked by bot/test/tail_test.mjs with the index writer's own pattern.
   *
   * from_block is the first block this object actually covers, not the block after the snapshot's last one.
   * When those differ there is a hole, and gap_blocks says how wide it is rather than letting a reader assume
   * the two ranges meet.
   */
  async tail(now = Date.now(), page = { cursor: null }) {
    if (!page || typeof page !== "object" || Array.isArray(page) ||
        Object.keys(page).join(",") !== "cursor" || (page.cursor !== null && typeof page.cursor !== "string")) {
      return { ok: false, why: "query" };
    }
    const cacheKey = page.cursor === null ? "start" : page.cursor;
    const beforeNumbersStamp = this.tailStateStamp();
    if (this.cached.body && this.cached.key === cacheKey && this.cached.state === beforeNumbersStamp &&
        now - this.cached.at < this.tailCacheMs()) return this.cached.body;

    // Published files are an external fetch. Read them before capturing the SQLite/KV state so an alarm that
    // runs while that fetch is pending cannot leave the response bound to pre-prune markers and post-prune rows.
    const snapshotTo = snapshotBoundary(await this.numbers(now));
    const stateStamp = this.tailStateStamp();

    const started = storedNonnegativeInteger(this.get("started_block"));
    const startedAt = storedNonnegativeInteger(this.get("started_at"));
    const to = storedNonnegativeInteger(this.get("last_block"));
    const unreadable = storedNonnegativeInteger(this.get("unreadable"), 0);
    const unreadableRaw = this.get("last_unreadable_block");
    const unreadableBlock = storedNonnegativeInteger(unreadableRaw);
    const prunedRaw = this.get("wall_pruned_through");
    const prunedThrough = storedNonnegativeInteger(prunedRaw);
    const indexErrorRaw = this.get("wall_index_error_block");
    const indexErrorBlock = storedNonnegativeInteger(indexErrorRaw);
    if (started === null || startedAt === null || to === null || started > to || started === Number.MAX_SAFE_INTEGER || unreadable === null ||
        (unreadable === 0 && unreadableRaw !== null) || (unreadable > 0 && (unreadableBlock === null || unreadableBlock > to || unreadableBlock === Number.MAX_SAFE_INTEGER))) {
      return { ok: false, why: "unreadable" };
    }
    if ((prunedRaw !== null && (prunedThrough === null || prunedThrough > to || prunedThrough === Number.MAX_SAFE_INTEGER)) ||
        (indexErrorRaw !== null && (indexErrorBlock === null || indexErrorBlock > to || indexErrorBlock === Number.MAX_SAFE_INTEGER))) {
      return { ok: false, why: "unreadable" };
    }
    // A skipped, pruned, or structurally unrepresentable launch ends the old coverage claim. The range after
    // the latest such block is complete and reproducible; moving from_block exposes the hole through gap_blocks.
    const coverageFrom = Math.max(
      started + 1,
      unreadableBlock === null ? 0 : unreadableBlock + 1,
      prunedThrough === null ? 0 : prunedThrough + 1,
      indexErrorBlock === null ? 0 : indexErrorBlock + 1
    );
    const cursorSecret = this.tailCursorSecret();
    if (!cursorSecret) return { ok: false, why: "unreadable" };

    let from = coverageFrom;
    let upper = to;
    let pageNumber = 1;
    let previousCommitment = null;
    if (page.cursor !== null) {
      const cursor = await readTailCursor(page.cursor, cursorSecret);
      if (!cursor) return { ok: false, why: "cursor" };
      if (cursor.s !== snapshotTo || cursor.b !== started || cursor.e !== startedAt || cursor.c !== coverageFrom ||
          cursor.u > to || cursor.n < coverageFrom || cursor.n > cursor.u) {
        return { ok: false, why: "reset_required" };
      }
      from = cursor.n;
      upper = cursor.u;
      pageNumber = cursor.p;
      previousCommitment = cursor.h;
    }

    // coverageFrom can be exactly one past the current cursor after a durable gap. That is a successful empty
    // suffix, not an invitation to invent a block or a malformed cursor.
    const emptySuffix = coverageFrom > upper;
    if (page.cursor !== null && emptySuffix) return { ok: false, why: "reset_required" };
    const totalRows = [...this.sql.exec("SELECT COUNT(*) AS n FROM tail WHERE block >= ? AND block <= ?", coverageFrom, upper)];
    const launchesInTail = exactCount(totalRows);
    if (launchesInTail === null) return { ok: false, why: "unreadable" };
    let rows = emptySuffix ? [] : [...this.sql.exec(
      "SELECT token, block, ts, date, deployer, row FROM tail WHERE block >= ? AND block <= ? ORDER BY block, token LIMIT ?",
      from, upper, MAX_TAIL_ROWS + 1
    )];
    let pageTo = upper;
    if (rows.length > MAX_TAIL_ROWS) {
      const overflowBlock = safeNonnegativeInteger(Number(rows[MAX_TAIL_ROWS].block));
      if (overflowBlock === null) return { ok: false, why: "unreadable" };
      pageTo = overflowBlock - 1;
      rows = rows.filter(row => Number(row.block) <= pageTo);
      if (pageTo < from) return { ok: false, why: "capacity", block: from, page_limit: MAX_TAIL_ROWS };
    }
    const tally = new Tally();
    const launches = [];
    for (const r of rows) {
      const block = safeNonnegativeInteger(Number(r.block));
      if (block === null || block > pageTo) return { ok: false, why: "unreadable" };
      if (block < from) return { ok: false, why: "unreadable" };
      const row = parseRow(r.row);
      if (!row || safeNonnegativeInteger(Number(row.block)) !== block) return { ok: false, why: "unreadable" };
      // A stored row may carry private additive data for other endpoints. /api/tail remains the exact
      // hash-only contract it had before those additions.
      launches.push(tailRow(row));
      addRowToTally(tally, row, r.date, r.deployer);
    }
    const frozen = tally.frozen();
    const tableHash = await tallyHash(frozen);
    const rowsHash = await bytesHash(new TextEncoder().encode(JSON.stringify(launches)));
    const more = !emptySuffix && pageTo < upper;
    const pageCommitment = await tailPageCommitment({
      snapshot: snapshotTo,
      started,
      startedAt,
      coverageFrom,
      from,
      to: pageTo,
      upper,
      page: pageNumber,
      previous: previousCommitment,
      total: launchesInTail,
      count: launches.length,
      tableHash,
      rowsHash
    });
    if (!pageCommitment) return { ok: false, why: "unreadable" };
    const nextCursor = more ? await makeTailCursor({
      snapshot: snapshotTo,
      started,
      startedAt,
      coverageFrom,
      upper,
      next: pageTo + 1,
      page: pageNumber + 1,
      previous: pageCommitment
    }, cursorSecret) : null;
    if (more && !nextCursor) return { ok: false, why: "unreadable" };

    const body = {
      ok: true,
      tail_version: TAIL_VERSION,
      engine: ENGINE_PATH,
      watcher_started_block: started,
      watcher_started_at: startedAt,
      coverage_from_block: coverageFrom,
      from_block: from,
      to_block: pageTo,
      watcher_to_block: upper,
      current_watcher_to_block: to,
      page: pageNumber,
      page_limit: MAX_TAIL_ROWS,
      previous_page_commitment: previousCommitment,
      page_commitment: pageCommitment,
      more,
      next_cursor: nextCursor,
      collected_at: new Date(now).toISOString(),
      depth_days: this.depthDays(),
      snapshot_to_block: snapshotTo,
      gap_blocks: snapshotTo === null ? null : Math.max(0, coverageFrom - 1 - snapshotTo),
      launches_in_tail: launchesInTail,
      launches_in_page: launches.length,
      entries: entryCounts(frozen),
      hash: tableHash,
      rows_hash: rowsHash,
      tables: frozen,
      launches
    };
    // Hashing and cursor authentication are asynchronous Web Crypto operations. Fence their other side too:
    // no successful page may combine rows with a watcher state that changed while those operations yielded.
    if (this.tailStateStamp() !== stateStamp) return { ok: false, why: "state_changed" };
    this.cached = { at: now, key: cacheKey, state: stateStamp, body };
    return body;
  }

  /**
   * Public launch wall. Its rows contain only the two labels the token declared for itself. Block and log
  * index stay internal: they select the strict suffix and make ordering deterministic.
  */
  async wall(now = Date.now(), page = { mode: "latest", cursor: null }) {
    const numbers = await this.numbers(now);
    const snapshotTo = snapshotBoundary(numbers);
    if (snapshotTo === null) return wallFailure("snapshot");

    const watcherTo = storedNonnegativeInteger(this.get("last_block"));
    const observedFinalized = storedNonnegativeInteger(this.get("observed_finalized"));
    const started = storedNonnegativeInteger(this.get("started_block"));
    const startedAt = storedNonnegativeInteger(this.get("started_at"));
    const lastRoundAt = storedNonnegativeInteger(this.get("last_round_at"));
    if (watcherTo === null || observedFinalized === null || started === null || startedAt === null || lastRoundAt === null || started > watcherTo) {
      return wallFailure("watcher");
    }
    if (!Number.isFinite(new Date(lastRoundAt).getTime()) || this.get("idle_reason", "") !== "") return wallFailure("watcher");
    if (lastRoundAt > now) return wallFailure("watcher");
    if (now - lastRoundAt >= this.watchdogMs()) return wallFailure("stale");
    if (watcherTo < snapshotTo) return wallFailure("behind");
    if (watcherTo !== observedFinalized) return wallFailure("backlog");

    // Once a covered tail row has been pruned, a lower later snapshot would create a suffix the object no
    // longer has. Remember the highest boundary that justified an actual deletion and refuse that regression.
    const prunedRaw = this.get("wall_pruned_through");
    const prunedThrough = storedNonnegativeInteger(prunedRaw);
    if (prunedRaw !== null && prunedThrough === null) return wallFailure("watcher");
    if (prunedThrough !== null && snapshotTo < prunedThrough) return wallFailure("snapshot_regressed");

    const unreadableRaw = this.get("unreadable");
    const unreadable = storedNonnegativeInteger(unreadableRaw, 0);
    const unreadableBlockRaw = this.get("last_unreadable_block");
    const unreadableBlock = storedNonnegativeInteger(unreadableBlockRaw);
    if (unreadable === null || (unreadable === 0 && unreadableBlockRaw !== null) ||
        (unreadable > 0 && unreadableBlock === null) || (unreadableBlock !== null && unreadableBlock > snapshotTo)) {
      return wallFailure("unreadable");
    }
    const indexErrorRaw = this.get("wall_index_error_block");
    const indexError = storedNonnegativeInteger(indexErrorRaw);
    if (indexErrorRaw !== null && (indexError === null || indexError > snapshotTo)) return wallFailure("backfill");
    const migrated = this.backfillWallEvents(snapshotTo);
    if (!migrated.ok) return wallFailure(migrated.why);
    const stateStamp = this.wallStateStamp();

    const limit = this.wallPageRows();
    const base = {
      snapshot: snapshotTo,
      started,
      startedAt
    };
    let cursor = null;
    if (page.mode === "before" || page.mode === "after") {
      cursor = readWallCursor(page.cursor);
      const role = page.mode === "before" ? "history" : "live";
      if (!cursor || cursor.r !== role || cursor.s !== snapshotTo || cursor.b !== started || cursor.e !== startedAt || cursor.p > watcherTo) {
        return wallFailure(page.mode === "after" ? "reset_required" : "cursor");
      }
      if (cursor.p <= snapshotTo || (page.mode === "before" && cursor.l === null)) {
        return wallFailure(page.mode === "after" ? "reset_required" : "cursor");
      }
    }

    const common = {
      ok: true,
      snapshot_to_block: snapshotTo,
      gap_blocks: Math.max(0, started - snapshotTo),
      watcher_to_block: watcherTo,
      read_at: new Date(lastRoundAt).toISOString(),
      page_limit: limit
    };
    const coverageCursor = makeWallCursor({ ...base, position: watcherTo, logIndex: null, role: "live" });
    const latestEvents = () => readWallEvents([...this.sql.exec(
      "SELECT block, log_index, name, ticker FROM wall_event WHERE block > ? AND block <= ? AND publishable = 1 ORDER BY block DESC, log_index DESC LIMIT ?",
      snapshotTo, watcherTo, limit + 1
    )]);

    if (page.mode === "after") {
      const args = cursor.l === null
        ? [cursor.p, watcherTo, limit + 1]
        : [cursor.p, cursor.p, cursor.l, watcherTo, limit + 1];
      const statement = cursor.l === null
        ? "SELECT block, log_index, name, ticker FROM wall_event WHERE block > ? AND block <= ? AND publishable = 1 ORDER BY block, log_index LIMIT ?"
        : "SELECT block, log_index, name, ticker FROM wall_event WHERE (block > ? OR (block = ? AND log_index > ?)) AND block <= ? AND publishable = 1 ORDER BY block, log_index LIMIT ?";
      const delta = readWallEvents([...this.sql.exec(statement, ...args)]);
      if (!delta) return wallFailure("backfill");
      if (delta.length > limit) return wallFailure("reset_required");
      const latestDesc = latestEvents();
      if (!latestDesc) return wallFailure("backfill");
      const latest = latestDesc.slice(0, limit).reverse();
      const rows = publicWallRows(delta);
      const view = publicWallRows(latest);
      const body = {
        ...common,
        mode: "after",
        older_cursor: null,
        live_cursor: coverageCursor,
        rows_hash: await wallRowsHash(rows),
        view_hash: await wallRowsHash(view),
        rows
      };
      return this.wallStateStamp() === stateStamp ? body : wallFailure("state_changed");
    }

    let events;
    if (page.mode === "before") {
      events = readWallEvents([...this.sql.exec(
        "SELECT block, log_index, name, ticker FROM wall_event WHERE block > ? AND block <= ? AND (block < ? OR (block = ? AND log_index < ?)) AND publishable = 1 ORDER BY block DESC, log_index DESC LIMIT ?",
        snapshotTo, watcherTo, cursor.p, cursor.p, cursor.l, limit + 1
      )]);
    } else {
      const cacheKey = [snapshotTo, watcherTo, started, startedAt, limit].join(":");
      // Validate freshness and migration before this cache. A cache window must never extend a stale or
      // incomplete watcher into a successful page.
      if (this.wallCached.body && this.wallCached.key === cacheKey && this.wallCached.state === stateStamp &&
          now - this.wallCached.at < this.tailCacheMs()) return this.wallCached.body;
      events = latestEvents();
    }
    if (!events) return wallFailure("backfill");
    const hasOlder = events.length > limit;
    const visible = events.slice(0, limit).reverse();
    const rows = publicWallRows(visible);
    const olderCursor = hasOlder && visible.length
      ? makeWallCursor({ ...base, position: visible[0].block, logIndex: visible[0].log_index, role: "history" })
      : null;
    const body = {
      ...common,
      mode: page.mode === "before" ? "before" : "latest",
      older_cursor: olderCursor,
      live_cursor: page.mode === "before" ? null : coverageCursor,
      rows_hash: await wallRowsHash(rows),
      view_hash: await wallRowsHash(rows),
      rows
    };
    if (this.wallStateStamp() !== stateStamp) return wallFailure("state_changed");
    if (page.mode !== "before") this.wallCached = { at: now, key: [snapshotTo, watcherTo, started, startedAt, limit].join(":"), state: stateStamp, body };
    return body;
  }

  /**
   * Public, retained history for one deployer address. It exposes no token address or transaction and never
   * claims all-time coverage: from_block/to_block are the exact watcher range still represented in tail.
   */
  async deployerHistory(address, now = Date.now()) {
    const deployer = canonicalAddress(address);
    if (!deployer) return wallFailure("query");
    const watcherTo = storedNonnegativeInteger(this.get("last_block"));
    const observedFinalized = storedNonnegativeInteger(this.get("observed_finalized"));
    const started = storedNonnegativeInteger(this.get("history_started_block"));
    const startedAt = storedNonnegativeInteger(this.get("history_started_at"));
    const lastRoundAt = storedNonnegativeInteger(this.get("last_round_at"));
    if ([watcherTo, observedFinalized, started, startedAt, lastRoundAt].includes(null) || started > watcherTo) return wallFailure("not_started");
    if (lastRoundAt > now || now - lastRoundAt >= this.watchdogMs() || this.get("idle_reason", "") !== "") return wallFailure("stale");
    if (watcherTo !== observedFinalized) return wallFailure("backlog");

    const prunedRaw = this.get("wall_pruned_through");
    const prunedThrough = storedNonnegativeInteger(prunedRaw, 0);
    if (prunedRaw !== null && prunedThrough === null) return wallFailure("watcher");
    const boundary = Math.max(started, prunedThrough === null ? 0 : prunedThrough);
    if (boundary > watcherTo || boundary === Number.MAX_SAFE_INTEGER) return wallFailure("watcher");
    const unreadableRaw = this.get("unreadable");
    const unreadable = storedNonnegativeInteger(unreadableRaw, 0);
    const unreadableBlockRaw = this.get("last_unreadable_block");
    const unreadableBlock = storedNonnegativeInteger(unreadableBlockRaw);
    if (unreadable === null || (unreadable === 0 && unreadableBlockRaw !== null) ||
        (unreadable > 0 && unreadableBlock === null) || (unreadableBlock !== null && unreadableBlock > boundary)) return wallFailure("unreadable");
    const indexErrorRaw = this.get("wall_index_error_block");
    const indexError = storedNonnegativeInteger(indexErrorRaw);
    if (indexErrorRaw !== null && (indexError === null || indexError > boundary)) return wallFailure("backfill");
    const stateStamp = this.historyStateStamp();

    const cacheEpoch = [watcherTo, lastRoundAt, boundary, stateStamp].join(":");
    if (this.historyCached.epoch !== cacheEpoch) this.historyCached = { epoch: cacheEpoch, bodies: new Map() };
    const cached = this.historyCached.bodies.get(deployer);
    if (cached) return cached;

    const total = this.count("SELECT COUNT(*) AS n FROM tail WHERE deployer = ? AND block > ?", deployer, boundary);
    const indexed = this.count("SELECT COUNT(*) AS n FROM tail AS t JOIN wall_event AS w ON w.token = t.token WHERE t.deployer = ? AND t.block > ?", deployer, boundary);
    if (indexed !== total) return wallFailure("migrating");
    const limit = this.historyPageRows();
    const records = [...this.sql.exec(
      "SELECT t.block AS block, t.date AS date, w.log_index AS log_index, w.name AS name, w.ticker AS ticker FROM tail AS t JOIN wall_event AS w ON w.token = t.token WHERE t.deployer = ? AND t.block > ? ORDER BY t.block DESC, w.log_index DESC LIMIT ?",
      deployer, boundary, limit + 1
    )];
    const rows = readHistoryRows(records.slice(0, limit));
    if (!rows) return wallFailure("backfill");
    rows.reverse();
    const body = {
      ok: true,
      address: deployer,
      from_block: boundary + 1,
      to_block: watcherTo,
      read_at: new Date(lastRoundAt).toISOString(),
      launches_seen: total,
      page_limit: limit,
      truncated: total > limit,
      rows_hash: await wallRowsHash(rows),
      rows
    };
    if (this.historyStateStamp() !== stateStamp) return wallFailure("state_changed");
    if (this.historyCached.bodies.size >= DEFAULT_HISTORY_CACHE_ADDRESSES) {
      const oldest = this.historyCached.bodies.keys().next().value;
      this.historyCached.bodies.delete(oldest);
    }
    this.historyCached.bodies.set(deployer, body);
    return body;
  }

  // ---------------------------------------------------------------- rules, from the router
  /**
   * The three rule commands, answered here because the rules live here.
   *
   * The router has already established that the sender is a holder with a live session for add/list/remove;
   * forget is deliberately allowed without that gate. The owner is the telegram id: a rule is a standing
   * arrangement with a person, only fires while a session is live, and is removed with that person's /forget.
   */
  async ruleCommand(body) {
    const owner = String(body.owner || "");
    if (!owner) return { ok: false, why: "owner" };

    if (body.what === "list") {
      return { ok: true, rules: this.rules.list(owner).map(strip), state: await this.state() };
    }

    if (body.what === "add") {
      // the hashes a rule is compared by are made here, by the engine this object already holds, so nothing
      // that decides what counts as the same string travels over a request boundary
      const rifle = await rifleOf(body.kind, body.arg);
      return this.telegramEffectOnce(body.updateId, "rules", {
        what: "add", owner, kind: String(body.kind || ""), arg: String(body.arg || "")
      }, () => {
        // Hashing awaited above; counts, insert and replay result now share one synchronous transaction.
        const ownerRows = [...this.sql.exec("SELECT COUNT(*) AS n FROM rules WHERE owner = ?", owner)];
        const totalRows = [...this.sql.exec("SELECT COUNT(*) AS n FROM rules")];
        const ownerCount = exactCount(ownerRows), totalCount = exactCount(totalRows);
        const ownerLimit = this.rules.limit(this.env), totalLimit = this.rulesTotalLimit();
        if (ownerCount === null || ownerLimit < 1 || ownerCount >= ownerLimit) return { ok: false, why: "limit" };
        if (totalCount === null || totalLimit < 1 || totalCount >= totalLimit) return { ok: false, why: "capacity" };
        const stored = this.rules.add(owner, body.kind, body.arg, rifle, Date.now());
        if (!stored) return { ok: false, why: "capacity" };
        const mine = this.rules.list(owner);
        return { ok: true, rule: strip(stored), number: mine.findIndex(r => r.id === stored.id) + 1, count: mine.length, limit: ownerLimit };
      });
    }

    if (body.what === "remove") {
      const n = Number(body.number);
      return this.telegramEffectOnce(body.updateId, "rules", { what: "remove", owner, number: n }, () => {
        const mine = this.rules.list(owner);
        if (!Number.isInteger(n) || n < 1 || n > mine.length) return { ok: false, why: "number" };
        const target = mine[n - 1];
        const removed = this.rules.removeById(owner, target.id);
        if (removed) this.sql.exec("DELETE FROM rule_delivery WHERE rule_id = ?", Number(target.id));
        return removed ? { ok: true, rule: strip(target) } : { ok: false, why: "number" };
      });
    }

    if (body.what === "forget") {
      return this.telegramEffectOnce(body.updateId, "rules", { what: "forget", owner }, () => {
        this.rules.removeAll(owner);
        this.sql.exec("DELETE FROM rule_delivery WHERE owner = ?", owner);
        return { ok: true };
      });
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
   * It does three jobs the alarm cannot. It physically removes expired holder nonces even while the watcher is on
   * time. It starts the object again after a stand — while the endpoint was
   * unreachable there was no alarm to fire, so nothing else would. And it notices a round that should have
   * happened and did not, counts it, and runs one immediately rather than waiting out an interval.
   *
   * Nothing is said in the room about either. The people a gap costs are the ones with rules, and /rules
   * tells them.
   */
  async watchdog(now) {
    if (this.running) return { woke: false, why: "in flight" };
    this.running = true;
    try { return await this.watchdogOnce(now); }
    finally { this.running = false; }
  }

  async watchdogOnce(now) {
    this.pruneNonces(now);
    this.pruneTelegramUpdates(now);
    this.pruneTelegramCommandBuckets(now);
    const alarm = await this.ctx.storage.getAlarm();
    const lastAt = this.num("last_round_at", 0);
    const late = !lastAt || now - lastAt >= this.watchdogMs();
    if (alarm !== null && alarm !== undefined && !late) return { woke: false, why: "on time" };
    if (lastAt && late) this.bump("gaps");
    const r = await this.tickOnce(now);
    return { woke: true, gapSeconds: lastAt ? Math.round((now - lastAt) / 1000) : null, ran: r.ran, why: r.why };
  }
}

// ---------------------------------------------------------------- small pure helpers
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

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

const safeNonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const exactCount = rows => {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  return safeNonnegativeInteger(Number(rows[0].n));
};
const canonicalTelegramOwner = value => {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && String(n) === value ? value : null;
};
const parseTelegramEffect = value => {
  if (typeof value !== "string" || value.length > MAX_TELEGRAM_EFFECT_BYTES) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
};
const telegramActionsOf = value => {
  if (!Array.isArray(value) || value.length > MAX_TELEGRAM_RESPONSE_ACTIONS) return null;
  const out = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.kind !== "send" ||
        !Object.keys(raw).every(key => ["kind", "chat", "text", "quiet", "preview", "replyTo"].includes(key)) ||
        typeof raw.text !== "string" || !raw.text.length || raw.text.length > TELEGRAM_TEXT_LIMIT) return null;
    let chat = null;
    if (Number.isSafeInteger(raw.chat) && raw.chat !== 0) chat = raw.chat;
    else if (typeof raw.chat === "string" && /^-?[1-9][0-9]*$/.test(raw.chat)) {
      const numeric = Number(raw.chat);
      if (Number.isSafeInteger(numeric) && numeric !== 0 && String(numeric) === raw.chat) chat = raw.chat;
    }
    if (chat === null || (raw.quiet !== undefined && typeof raw.quiet !== "boolean") ||
        (raw.preview !== undefined && typeof raw.preview !== "boolean") ||
        (raw.replyTo !== undefined && (!Number.isSafeInteger(raw.replyTo) || raw.replyTo <= 0))) return null;
    const action = { kind: "send", chat, text: raw.text };
    if (raw.quiet !== undefined) action.quiet = raw.quiet;
    if (raw.preview !== undefined) action.preview = raw.preview;
    if (raw.replyTo !== undefined) action.replyTo = raw.replyTo;
    out.push(action);
  }
  return out;
};
const storedNonnegativeInteger = (value, missing = null) => {
  if (value === null || value === undefined) return missing;
  const n = Number(value);
  return safeNonnegativeInteger(n);
};

/** Exactly one optional opaque cursor; raw block offsets are deliberately not an alternate contract. */
export function tailPageOf(searchParams) {
  const entries = searchParams ? [...searchParams.entries()] : [];
  if (!entries.length) return { cursor: null };
  if (entries.length !== 1 || entries[0][0] !== "cursor" || !entries[0][1]) return null;
  return { cursor: entries[0][1] };
}

const tailSnapshot = value => value === null ? null : safeNonnegativeInteger(value);
const tailDigest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
const bytesOfHex = value => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};
const base64Url = text => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tailCursorMac = async (encoded, secret) => {
  const keyBytes = bytesOfHex(secret);
  if (!keyBytes) return null;
  try {
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded));
    return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
};

/**
 * Cursor transport is opaque and authenticated with a per-object durable secret. Besides catching damaged
 * links, that stops a caller from changing `next` to skip a page while retaining the server's completeness
 * wording. The prior page commitment makes the returned chunks one ordered chain.
 */
export async function makeTailCursor({ snapshot, started, startedAt, coverageFrom, upper, next, page, previous }, secret) {
  const s = tailSnapshot(snapshot), b = safeNonnegativeInteger(started), e = safeNonnegativeInteger(startedAt);
  const c = safeNonnegativeInteger(coverageFrom), u = safeNonnegativeInteger(upper), n = safeNonnegativeInteger(next);
  const p = safeNonnegativeInteger(page), h = tailDigest(previous);
  if ((snapshot !== null && s === null) || [b, e, c, u, n, p].includes(null) || b >= c || c > n || n > u ||
      p === null || p < 2 || !h || !bytesOfHex(secret)) return null;
  const encoded = base64Url(JSON.stringify({ v: TAIL_VERSION, s, b, e, c, u, n, p, h }));
  const mac = await tailCursorMac(encoded, secret);
  return mac ? encoded + "." + mac : null;
}

export async function readTailCursor(value, secret) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,448}\.[0-9a-f]{64}$/.test(value)) return null;
  try {
    const split = value.lastIndexOf(".");
    const encoded = value.slice(0, split);
    const padLength = (4 - encoded.length % 4) % 4;
    const jsonText = atob(encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLength));
    const raw = JSON.parse(jsonText);
    if (!raw || Object.keys(raw).join(",") !== "v,s,b,e,c,u,n,p,h" || raw.v !== TAIL_VERSION) return null;
    const cursor = {
      v: TAIL_VERSION,
      s: tailSnapshot(raw.s),
      b: safeNonnegativeInteger(raw.b),
      e: safeNonnegativeInteger(raw.e),
      c: safeNonnegativeInteger(raw.c),
      u: safeNonnegativeInteger(raw.u),
      n: safeNonnegativeInteger(raw.n),
      p: safeNonnegativeInteger(raw.p),
      h: tailDigest(raw.h)
    };
    if ((raw.s !== null && cursor.s === null) || [cursor.b, cursor.e, cursor.c, cursor.u, cursor.n, cursor.p, cursor.h].includes(null)) return null;
    const canonical = await makeTailCursor({
      snapshot: cursor.s,
      started: cursor.b,
      startedAt: cursor.e,
      coverageFrom: cursor.c,
      upper: cursor.u,
      next: cursor.n,
      page: cursor.p,
      previous: cursor.h
    }, secret);
    return canonical === value ? cursor : null;
  } catch {
    return null;
  }
}

export const tailPageCommitment = async ({ snapshot, started, startedAt, coverageFrom, from, to, upper, page, previous, total, count, tableHash, rowsHash }) => {
  const s = tailSnapshot(snapshot), b = safeNonnegativeInteger(started), e = safeNonnegativeInteger(startedAt);
  const c = safeNonnegativeInteger(coverageFrom), f = safeNonnegativeInteger(from), t = safeNonnegativeInteger(to);
  const u = safeNonnegativeInteger(upper), p = safeNonnegativeInteger(page), n = safeNonnegativeInteger(total);
  const z = safeNonnegativeInteger(count), h = tailDigest(tableHash), r = tailDigest(rowsHash);
  const q = previous === null ? null : tailDigest(previous);
  if ((snapshot !== null && s === null) || [b, e, c, f, t, u, p, n, z, h, r].includes(null) ||
      (previous !== null && q === null) || p < 1 || b >= c || t > u || f > t + 1) return null;
  return await bytesHash(new TextEncoder().encode(JSON.stringify({
    v: TAIL_VERSION, s, b, e, c, f, t, u, p, q, n, z, h, r
  })));
};

/** Exactly one optional cursor parameter; repeated, mixed or unknown parameters are refused. */
export function wallPageOf(searchParams) {
  const entries = searchParams ? [...searchParams.entries()] : [];
  if (!entries.length) return { mode: "latest", cursor: null };
  if (entries.length !== 1) return null;
  const [key, value] = entries[0];
  if ((key !== "before" && key !== "after") || !value) return null;
  return { mode: key, cursor: value };
}

const canonicalAddress = value => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
  ? value.toLowerCase()
  : null;
const configuredHttps = (env, key, fallback) => Object.prototype.hasOwnProperty.call(env || {}, key)
  ? requiredHttpsUrlOf(env[key])
  : requiredHttpsUrlOf(fallback);
const nonzeroAddress = value => {
  const address = canonicalAddress(value);
  return address && !/^0x0{40}$/.test(address) ? address : null;
};
const nonzeroHash = value => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/i.test(value)
  ? value.toLowerCase()
  : null;

/** A private exact digest: raw declarations stay inside the object and never enter /api/tail. */
const launchFingerprintOf = async launch => {
  if (!launch || typeof launch !== "object" || Array.isArray(launch)) return null;
  const token = nonzeroAddress(launch.token), curve = nonzeroAddress(launch.curve);
  const deployer = nonzeroAddress(launch.deployer), pair = canonicalAddress(launch.pair);
  const tx = nonzeroHash(launch.tx), blockHash = nonzeroHash(launch.block_hash);
  const block = safeNonnegativeInteger(launch.block), logIndex = safeNonnegativeInteger(launch.log_index);
  const ts = safeNonnegativeInteger(launch.ts), date = typeof launch.date === "string" ? launch.date : null;
  const eventData = typeof launch.event_data === "string" && /^0x[0-9a-fA-F]{192}$/.test(launch.event_data)
    ? launch.event_data.toLowerCase()
    : null;
  const recipient = canonicalAddress(launch.recipient);
  const socials = Array.isArray(launch.socials) && launch.socials.length === LINKS.length && launch.socials.every(value => typeof value === "string")
    ? [...launch.socials]
    : null;
  if (!token || !curve || !deployer || !pair || !tx || !blockHash || block === null || logIndex === null || ts === null ||
      date === null || dateOfSeconds(ts) !== date || !eventData || recipient === null || socials === null || launch.exists !== true ||
      typeof launch.name !== "string" || typeof launch.symbol !== "string" || typeof launch.logo !== "string" || typeof launch.description !== "string") return null;
  try {
    const payload = JSON.stringify({
      v: 1, token, curve, deployer, pair, block, tx, block_hash: blockHash, event_data: eventData,
      log_index: logIndex, ts, date, name: launch.name, symbol: launch.symbol, logo: launch.logo,
      description: launch.description, socials, recipient, exists: true
    });
    return await bytesHash(new TextEncoder().encode(payload));
  } catch {
    return null;
  }
};

const durableRowOf = async launch => {
  const fingerprint = await launchFingerprintOf(launch);
  if (!fingerprint) return null;
  try {
    const row = await rowOf(launch);
    const logIndex = safeNonnegativeInteger(launch.log_index);
    if (!row || logIndex === null) return null;
    row.wall = { name: wallText(launch.name), ticker: wallText(launch.symbol), log_index: logIndex };
    row.source = { v: 1, fingerprint };
    return row;
  } catch {
    return null;
  }
};

/** Exactly one address query, with no ignored or repeated parameters. */
export function deployerAddressOf(searchParams) {
  const entries = searchParams ? [...searchParams.entries()] : [];
  if (entries.length !== 1 || entries[0][0] !== "address") return null;
  return canonicalAddress(entries[0][1]);
}

/**
 * Cursor payloads are opaque transport, not secrets. Canonical encoding prevents two spellings of the same
 * position, while the snapshot and watcher epoch prevent a cursor from crossing incompatible histories.
 */
export function makeWallCursor({ snapshot, started, startedAt, position, logIndex, role }) {
  const s = safeNonnegativeInteger(snapshot), b = safeNonnegativeInteger(started);
  const e = safeNonnegativeInteger(startedAt), p = safeNonnegativeInteger(position);
  const l = logIndex === null ? null : safeNonnegativeInteger(logIndex);
  if (s === null || b === null || e === null || p === null || (logIndex !== null && l === null) || (role !== "history" && role !== "live")) return null;
  const jsonText = JSON.stringify({ v: 1, s, b, e, p, l, r: role });
  return btoa(jsonText).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function readWallCursor(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) return null;
  try {
    const padLength = (4 - value.length % 4) % 4;
    const jsonText = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLength));
    const p = JSON.parse(jsonText);
    if (!p || Object.keys(p).join(",") !== "v,s,b,e,p,l,r" || p.v !== 1) return null;
    const cursor = {
      v: 1,
      s: safeNonnegativeInteger(p.s),
      b: safeNonnegativeInteger(p.b),
      e: safeNonnegativeInteger(p.e),
      p: safeNonnegativeInteger(p.p),
      l: p.l === null ? null : safeNonnegativeInteger(p.l),
      r: p.r
    };
    if ([cursor.s, cursor.b, cursor.e, cursor.p].includes(null) || (p.l !== null && cursor.l === null) || (cursor.r !== "history" && cursor.r !== "live")) return null;
    const canonical = makeWallCursor({ snapshot: cursor.s, started: cursor.b, startedAt: cursor.e, position: cursor.p, logIndex: cursor.l, role: cursor.r });
    return canonical === value ? cursor : null;
  } catch { return null; }
}

/** Validate rows read from the positional table before any of them become a public response. */
const readWallEvents = records => {
  const out = [];
  for (const record of records) {
    const block = safeNonnegativeInteger(Number(record.block));
    const logIndex = safeNonnegativeInteger(Number(record.log_index));
    const name = wallText(record.name), ticker = wallText(record.ticker);
    if (block === null || logIndex === null || name === null || ticker === null) return null;
    out.push({ block, log_index: logIndex, name, ticker });
  }
  return out;
};
const publicWallRows = events => events.map(({ name, ticker }) => ({ name, ticker }));

const canonicalDate = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = Date.parse(value + "T00:00:00.000Z");
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? value : null;
};

/** Stored public labels may be absent, but a present label is preserved byte-for-byte or the page closes. */
const readHistoryRows = records => {
  const out = [];
  for (const record of records) {
    const block = safeNonnegativeInteger(Number(record.block));
    const logIndex = safeNonnegativeInteger(Number(record.log_index));
    const date = canonicalDate(record.date);
    const name = record.name === null ? null : wallText(record.name);
    const ticker = record.ticker === null ? null : wallText(record.ticker);
    if (block === null || logIndex === null || date === null || (record.name !== null && name === null) || (record.ticker !== null && ticker === null)) return null;
    out.push({ block, log_index: logIndex, date, name, ticker });
  }
  return out;
};

/** Preserve a bounded declaration byte-for-byte. Reject rather than trim, truncate, or replace it. */
export function wallText(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_WALL_TEXT) return null;
  if (!value.trim() || /\p{C}/u.test(value)) return null;
  return value;
}

/** The published numbers document is a boundary only when its integer window is internally consistent. */
export function snapshotBoundary(numbers) {
  if (!numbers || typeof numbers !== "object" || !numbers.window || typeof numbers.window !== "object") return null;
  const from = safeNonnegativeInteger(numbers.window.from_block);
  const to = safeNonnegativeInteger(numbers.window.to_block);
  const blocks = safeNonnegativeInteger(numbers.window.blocks);
  if (from === null || to === null || blocks === null || to < from || blocks !== to - from + 1) return null;
  return to;
}

const wallFailure = why => ({ ok: false, why });

/** SHA-256 of the exact ordered public rows, so a client can reproduce rows_hash without hidden data. */
export async function wallRowsHash(rows) {
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

const tailRow = row => ({ block: Number(row.block), date: String(row.date || ""), hashes: row.hashes });

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
const sameRuleDefinition = (left, right) => Boolean(left && right && Number(left.id) === Number(right.id) &&
  String(left.owner) === String(right.owner) && String(left.kind) === String(right.kind) &&
  String(left.arg) === String(right.arg) && Number(left.made) === Number(right.made) &&
  JSON.stringify(left.rifle) === JSON.stringify(right.rifle));
