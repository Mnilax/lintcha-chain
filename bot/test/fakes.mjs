// The fakes every test here shares. There is no network in any of them: the site, the endpoint and Telegram
// are all objects in this file, and the one global that gets replaced is fetch.
//
// No value in this file is a secret. The strings that stand in for a bot token and a webhook secret are named
// so that nobody can mistake them for real ones, and the private key that produced the signature fixture is
// not here at all: only the signature, the address and the sentence it was made over.

import crypto from "node:crypto";
import { INDEX_NAMESPACES, MANIFEST_SCHEMA } from "../../lib/published-contract.mjs";

export function harness(name) {
  let checks = 0, failures = 0;
  return {
    ok(cond, what) {
      checks++;
      if (!cond) { failures++; console.log("  FAIL " + what); }
    },
    done() {
      console.log(`${name}: ${checks} checks, ${failures} failure(s)`);
      process.exit(failures ? 1 : 0);
    }
  };
}

/** A store with the three things the worker uses: get, put with a ttl, delete. */
export function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k).v : null; },
    async put(k, v, o) { m.set(k, { v: String(v), ttl: o && o.expirationTtl }); },
    async delete(k) { m.delete(k); },
    ttlOf(k) { return m.has(k) ? m.get(k).ttl : null; }
  };
}

/**
 * A limiter shaped like the vendored Gate, answering from a table instead of the endpoint.
 * Keys are the method, or "eth_call:<selector>" for a call.
 */
export function fakeGate(table) {
  return {
    stats: { calls: 0, http429: 0, rpc429: 0, retries: 0, otherErrors: 0, byMethod: {}, firstAt: 0, lastAt: 0 },
    asked: [],
    async call(method, params) {
      this.stats.calls++;
      this.stats.byMethod[method] = (this.stats.byMethod[method] || 0) + 1;
      const key = method === "eth_call" ? method + ":" + params[0].data.slice(0, 10) : method;
      this.asked.push(key);
      if (!(key in table)) throw new Error("the test gave no answer for " + key);
      const v = table[key];
      if (v instanceof Error) throw v;
      return v;
    }
  };
}

/** A context for a Durable Object: sqlite enough for what Tape does, plus one alarm. */
export function fakeCtx({ legacyBuyDelivery = false } = {}) {
  const rows = new Map();
  let alarm = null;
  let buyDeliveryHasLastAttempt = !legacyBuyDelivery;
  let buysHaveBlockHash = !legacyBuyDelivery;
  let buyDeliveryHasBlockHash = !legacyBuyDelivery;
  const sql = {
    statements: [],
    calls: [],
    exec(stmt, ...args) {
      sql.statements.push(stmt);
      sql.calls.push({ stmt, args });
      const s = stmt.trim().toUpperCase();
      if (s.startsWith("CREATE")) return [];
      if (s.startsWith("PRAGMA TABLE_INFO(BUYS)")) {
        const names = ["tx", "log", "block", "wallet", "amount"];
        if (buysHaveBlockHash) names.push("block_hash");
        return names.map(name => ({ name }));
      }
      if (s.startsWith("ALTER TABLE BUYS ADD COLUMN BLOCK_HASH")) {
        if (buysHaveBlockHash) throw new Error("duplicate buys block_hash migration");
        buysHaveBlockHash = true;
        for (const [key, value] of rows) if (key.startsWith("buy:")) value.block_hash = "";
        return [];
      }
      if (s.startsWith("PRAGMA TABLE_INFO(BUY_DELIVERY)")) {
        const names = ["tx", "log", "block", "wallet", "amount", "chat", "body", "sent"];
        if (buyDeliveryHasBlockHash) names.push("block_hash");
        if (buyDeliveryHasLastAttempt) names.push("last_attempt");
        return names.map(name => ({ name }));
      }
      if (s.startsWith("ALTER TABLE BUY_DELIVERY ADD COLUMN BLOCK_HASH")) {
        if (buyDeliveryHasBlockHash) throw new Error("duplicate buy_delivery block_hash migration");
        buyDeliveryHasBlockHash = true;
        for (const [key, value] of rows) if (key.startsWith("delivery:")) value.block_hash = "";
        return [];
      }
      if (s.startsWith("ALTER TABLE BUY_DELIVERY ADD COLUMN LAST_ATTEMPT")) {
        if (buyDeliveryHasLastAttempt) throw new Error("duplicate buy_delivery last_attempt migration");
        buyDeliveryHasLastAttempt = true;
        for (const [key, value] of rows) if (key.startsWith("delivery:")) value.last_attempt = 0;
        return [];
      }
      if (s.startsWith("SELECT V FROM KV")) { const v = rows.get("kv:" + args[0]); return v === undefined ? [] : [{ v }]; }
      if (s.startsWith("INSERT INTO KV")) { rows.set("kv:" + args[0], String(args[1])); return []; }
      if (s.startsWith("DELETE FROM KV WHERE K")) { rows.delete("kv:" + args[0]); return []; }
      if (s.startsWith("SELECT COUNT(*) AS N FROM BUY_DELIVERY WHERE SENT")) {
        return [{ n: [...rows.values()].filter(value => value && value.sent === Number(args[0]) && Object.prototype.hasOwnProperty.call(value, "chat")).length }];
      }
      if (s.startsWith("SELECT 1 AS ONE FROM BUYS")) return rows.has("buy:" + args[0] + ":" + args[1]) ? [{ one: 1 }] : [];
      if (s.startsWith("SELECT TX, LOG, BLOCK, BLOCK_HASH, WALLET, AMOUNT FROM BUYS WHERE BLOCK")) {
        return [...rows.entries()].filter(([key, value]) => key.startsWith("buy:") && Number(value.block) === Number(args[0]) && Number(key.split(":")[2]) === Number(args[1]))
          .map(([key, value]) => ({ tx: key.split(":")[1], log: Number(key.split(":")[2]), ...value }));
      }
      if (s.startsWith("SELECT TX, LOG, BLOCK, BLOCK_HASH, WALLET, AMOUNT FROM BUYS WHERE TX")) {
        const v = rows.get("buy:" + args[0] + ":" + args[1]);
        return v ? [{ tx: args[0], log: Number(args[1]), ...v }] : [];
      }
      if (s.startsWith("INSERT INTO BUYS")) {
        rows.set("buy:" + args[0] + ":" + args[1], { wallet: String(args[2]), amount: String(args[3]), block: Number(args[4]), block_hash: String(args[5]) });
        return [];
      }
      if (s.startsWith("DELETE FROM BUYS WHERE BLOCK")) {
        for (const [key, value] of rows) if (key.startsWith("buy:") && Number(value.block) <= Number(args[0])) rows.delete(key);
        return [];
      }
      if (s.startsWith("SELECT TX, LOG, BLOCK, BLOCK_HASH, WALLET, AMOUNT, CHAT, BODY, SENT FROM BUY_DELIVERY WHERE BLOCK")) {
        return [...rows.entries()].filter(([key, value]) => key.startsWith("delivery:") && Number(value.block) === Number(args[0]) && Number(key.split(":")[2]) === Number(args[1]))
          .map(([key, value]) => ({ tx: key.split(":")[1], log: Number(key.split(":")[2]), ...value }));
      }
      if (s.startsWith("SELECT TX, LOG, BLOCK, BLOCK_HASH, WALLET, AMOUNT, CHAT, BODY, SENT FROM BUY_DELIVERY WHERE TX")) {
        const v = rows.get("delivery:" + args[0] + ":" + args[1]);
        return v ? [{ tx: args[0], log: Number(args[1]), ...v }] : [];
      }
      if (s.startsWith("SELECT TX, LOG, BLOCK, BLOCK_HASH, WALLET, AMOUNT, LAST_ATTEMPT FROM BUY_DELIVERY")) {
        return [...rows.entries()].filter(([key, value]) => key.startsWith("delivery:") && value.sent === Number(args[0]))
          .map(([key, value]) => {
            const parts = key.split(":");
            return { tx: parts[1], log: Number(parts[2]), block: value.block, block_hash: value.block_hash, wallet: value.wallet, amount: value.amount, last_attempt: value.last_attempt };
          }).sort((x, y) => Number(x.last_attempt) - Number(y.last_attempt) || x.block - y.block || x.log - y.log || x.tx.localeCompare(y.tx))
          .slice(0, Number(args[1]));
      }
      if (s.startsWith("SELECT 1 AS ONE FROM BUY_DELIVERY WHERE SENT")) {
        return [...rows.values()].some(value => value && value.sent === Number(args[0]) && Object.prototype.hasOwnProperty.call(value, "chat")) ? [{ one: 1 }] : [];
      }
      if (s.startsWith("INSERT INTO BUY_DELIVERY")) {
        rows.set("delivery:" + args[0] + ":" + args[1], { block: Number(args[2]), block_hash: String(args[3]), wallet: String(args[4]), amount: String(args[5]), chat: String(args[6]), body: String(args[7]), sent: Number(args[8]), last_attempt: Number(args[9]) });
        return [];
      }
      if (s.startsWith("UPDATE BUY_DELIVERY SET SENT")) {
        const key = "delivery:" + args[1] + ":" + args[2], v = rows.get(key);
        if (v) v.sent = Number(args[0]);
        return [];
      }
      if (s.startsWith("UPDATE BUY_DELIVERY SET LAST_ATTEMPT")) {
        const key = "delivery:" + args[1] + ":" + args[2], v = rows.get(key);
        if (v) v.last_attempt = Number(args[0]);
        return [];
      }
      if (s.startsWith("DELETE FROM BUY_DELIVERY WHERE BLOCK")) {
        for (const [key, value] of rows) {
          if (key.startsWith("delivery:") && Number(value.block) <= Number(args[0]) && (args.length < 2 || Number(value.sent) === Number(args[1]))) rows.delete(key);
        }
        return [];
      }
      if (s.startsWith("SELECT BUYS, TOTAL FROM WALLETS WHERE")) { const v = rows.get("wal:" + args[0]); return v ? [v] : []; }
      if (s.startsWith("INSERT INTO WALLETS")) { rows.set("wal:" + args[0], { buys: args[2], total: args[3] }); return []; }
      if (s.startsWith("UPDATE WALLETS")) { rows.set("wal:" + args[2], { buys: args[0], total: args[1] }); return []; }
      if (s.startsWith("SELECT COUNT(*) AS N FROM WALLETS")) return [{ n: [...rows.keys()].filter(k => k.startsWith("wal:")).length }];
      return [];
    }
  };
  return {
    rows,
    storage: {
      sql,
      async setAlarm(at) { alarm = at; },
      async getAlarm() { return alarm; },
      async deleteAlarm() { alarm = null; },
      peekAlarm() { return alarm; }
    }
  };
}

/**
 * Replace the global fetch. The site answers whatever `site` holds; Telegram accepts everything and every
 * call to it is recorded so a test can count what the bot said.
 */
export function fakeNetwork() {
  const state = { site: { address: null, pons: null, uniswap: null }, siteOk: true, telegramOk: true, telegramBodyOk: true, telegramResponseLoss: false, beforeTelegram: null, attempted: [], sent: [] };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      state.attempted.push(body);
      if (typeof state.beforeTelegram === "function") await state.beforeTelegram(body);
      if (!state.telegramOk) return new Response(JSON.stringify({ ok: false }), { status: 503, headers: { "content-type": "application/json" } });
      if (!state.telegramBodyOk) return new Response(JSON.stringify({ ok: false, error_code: 429 }), { status: 200, headers: { "content-type": "application/json" } });
      state.sent.push(body);
      if (state.telegramResponseLoss) return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (!state.siteOk) return new Response("unreadable", { status: 500, headers: { "content-type": "text/plain" } });
    return new Response(JSON.stringify(state.site), { status: 200, headers: { "content-type": "application/json" } });
  };
  return state;
}

// ---------------------------------------------------------------- fixtures
/** a thirty-two byte word as 0x hex, for stubbing an eth_call return */
export const wordHex = v => "0x" + BigInt(v).toString(16).padStart(64, "0");
/** an address as a log topic */
export const topicAddr = a => "0x" + a.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** the factory's canonical fifteen-word static record */
export function launchRecordHex({
  token = TOKEN_ADDRESS,
  curve = VENUE_ADDRESS,
  deployer = WALLET_ADDRESS,
  creatorFeeRecipient = "0x" + "0".repeat(40),
  pairToken = WALLET_ADDRESS,
  buybackEnabled = false,
  phase = 0n,
  exists = true
} = {}) {
  const words = new Array(15).fill("".padStart(64, "0"));
  const address = value => String(value).replace(/^0x/, "").toLowerCase().padStart(64, "0");
  words[0] = address(token);
  words[1] = address(curve);
  words[2] = address(deployer);
  words[3] = address(creatorFeeRecipient);
  words[4] = address(pairToken);
  words[9] = (buybackEnabled ? "1" : "0").padStart(64, "0");
  words[10] = BigInt(phase).toString(16).padStart(64, "0");
  words[14] = exists ? "1".padStart(64, "0") : "".padStart(64, "0");
  return "0x" + words.join("");
}

/**
 * The signature fixture. Made over sentenceFor(nonce) by a throwaway key generated only while creating this
 * fixture. The key itself is deliberately not in this repository: a recovery fixture needs the signature,
 * address and one-time mark, not the key.
 */
export const FIXTURE = {
  nonce: "5a17c9e32d4f60718293a4b5c6d7e8f9",
  address: "0x44ddefb6d59de6523cd7ff06821d48847e95c176",
  signature: "0x988a1973fb92b7091fc10cdde4cad524a001056561a59ad52f6a68140dd924ce34aeea607dabf021c59b00db750bdfaa167033a8d857d0fd1ab075dc0cadc8c71c"
};

export const STAND_BOT_TOKEN = "a-stand-value-that-is-not-a-bot-token";
export const STAND_WEBHOOK_SECRET = "a-stand-value-that-is-not-a-webhook-secret";

export const TOKEN_ADDRESS = "0x1111111111111111111111111111111111111111";
export const VENUE_ADDRESS = "0x2222222222222222222222222222222222222222";
export const WALLET_ADDRESS = "0x3333333333333333333333333333333333333333";

// ---------------------------------------------------------------- round D2: the watcher, the tail, the rules
//
// Everything below is an addition. Nothing above it changed, because the seven test files of round D1 import
// from here and a fake that shifted under them would turn a passing suite into a lie.
//
// Two things are new in kind. A gate that answers from a function rather than a table, because the watcher
// reads four fields per token and a table keyed by selector cannot give two tokens different names. And a
// context whose sql understands the watcher's statements: still a hand written stand and still not SQLite,
// which is worth repeating rather than forgetting — what these tests prove is the object's logic, not that
// its statements are valid SQL. The statements themselves are proved by a deploy.

import { T as ABI, encode, SOCIALS, LAUNCHED_TOKEN } from "../../tools/launch/abi.mjs";

const ZERO = "0x" + "0".repeat(40);
const hexOf = bytes => Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");

/** A gate that asks a function. Return an Error to make the call fail, as the real one would. */
export function fakeGateFn(handler) {
  return {
    stats: { calls: 0, http429: 0, rpc429: 0, retries: 0, otherErrors: 0, byMethod: {}, firstAt: 0, lastAt: 0 },
    asked: [],
    async call(method, params) {
      this.stats.calls++;
      this.stats.byMethod[method] = (this.stats.byMethod[method] || 0) + 1;
      this.asked.push(method);
      const v = await handler(method, params);
      if (v instanceof Error) throw v;
      return v;
    }
  };
}

/** name() and symbol() return one string each. */
export const stringReturn = s => "0x" + hexOf(encode(ABI.tuple(ABI.string), [String(s)]));

/** getTokenInfo() returns the deployer, the logo, the description and the five link strings. */
export const tokenInfoReturn = ({ deployer = ZERO, logo = "", description = "", socials = ["", "", "", "", ""] }) =>
  "0x" + hexOf(encode(ABI.tuple(ABI.address, ABI.string, ABI.string, SOCIALS), [deployer, logo, description, socials]));

/** The factory's fifteen word record, with the four fields the watcher and the feed read between them. */
export const launchedReturn = ({ token = ZERO, curve = ZERO, deployer = ZERO, recipient = ZERO, pairToken = WALLET_ADDRESS, exists = true }) =>
  "0x" + hexOf(encode(ABI.tuple(LAUNCHED_TOKEN), [[token, curve, deployer, recipient, pairToken, 0n, 0n, 0n, 0n, false, 0n, 0n, 0n, 0n, exists]]));

/** The three non-indexed words in TokenLaunched: pair token, config id and graduation threshold. */
export const tokenLaunchedData = ({ pairToken = ZERO, launchConfigId = 0n, graduationThreshold = 0n } = {}) =>
  "0x" + hexOf(encode(ABI.tuple(ABI.address, ABI.uint, ABI.uint), [pairToken, launchConfigId, graduationThreshold]));

/** an address as a log topic, for the factory's TokenLaunched */
export const asTopic = a => "0x" + String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");

/**
 * A whole fake chain for the watcher: a head block, a launch log, and per token answers.
 *
 * launches: [{ token, curve, deployer, block, tx, name, symbol, logo, description, socials, recipient }]
 * Anything a test does not set answers the way the collector sees an unfilled field: an empty string.
 * selectors: the three the watcher computes, passed in so this file pins none of them.
 */
export function fakeChain(config) {
  const state = {
    head: config.head,
    chainId: config.chainId === undefined ? "0x1237" : config.chainId,
    launches: config.launches || [],
    timestamps: config.timestamps || {},
    blockResponses: config.blockResponses || {},
    broken: config.broken || {},
    selectors: config.selectors,
    reads: 0,
    finalizedReads: 0
  };
  const byArgument = data => {
    const word = String(data).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(word) || !/^0{24}/.test(word)) return null;
    const address = "0x" + word.slice(24);
    return state.launches.find(l => String(l.token).toLowerCase() === address);
  };
  const blockHashAt = number => {
    const observed = state.launches.find(launch => Number(launch.block) === Number(number));
    return observed && observed.blockHash !== undefined ? observed.blockHash : "0x" + "b".repeat(64);
  };
  state.gate = fakeGateFn(async (method, params) => {
    if (state.broken[method]) return state.broken[method];
    if (method === "eth_chainId") return state.chainId;
    if (method === "eth_blockNumber") return "0x" + Number(state.head).toString(16);
    if (method === "eth_getBlockByNumber") {
      if (params[0] === "finalized") {
        state.finalizedReads++;
        return { number: "0x" + Number(state.head).toString(16), hash: blockHashAt(state.head), timestamp: "0x" + Number(state.timestamps[state.head] || 1700000000).toString(16) };
      }
      const n = Number(BigInt(params[0]));
      if (Object.prototype.hasOwnProperty.call(state.blockResponses, n)) return state.blockResponses[n];
      const ts = state.timestamps[n];
      return { number: params[0], hash: blockHashAt(n), timestamp: "0x" + Number(ts === undefined ? 1700000000 : ts).toString(16) };
    }
    if (method === "eth_getLogs") {
      const from = Number(BigInt(params[0].fromBlock)), to = Number(BigInt(params[0].toBlock));
      return state.launches.filter(l => l.block >= from && l.block <= to).map(l => ({
        address: l.eventAddress === undefined ? params[0].address : l.eventAddress,
        removed: l.removed === undefined ? false : l.removed,
        topics: l.eventTopics || [params[0].topics[0], l.tokenTopic || asTopic(l.token), l.curveTopic || asTopic(l.curve || "0x" + "2".repeat(40)), l.deployerTopic || asTopic(l.deployer)],
        data: l.eventData === undefined ? tokenLaunchedData({ pairToken: l.pairToken === undefined ? WALLET_ADDRESS : l.pairToken }) : l.eventData,
        blockNumber: "0x" + l.block.toString(16),
        transactionHash: l.tx || "0x" + "a".repeat(64),
        blockHash: l.blockHash === undefined ? "0x" + "b".repeat(64) : l.blockHash,
        logIndex: l.omitLogIndex ? undefined : "0x" + Number(l.logIndex === undefined ? state.launches.indexOf(l) : l.logIndex).toString(16)
      }));
    }
    if (method === "eth_call") {
      state.reads++;
      const data = params[0].data, sel = data.slice(0, 10);
      const withArgument = data.length > 10;
      const l = withArgument ? byArgument(data.slice(10)) : state.launches.find(x => x.token.toLowerCase() === String(params[0].to).toLowerCase());
      if (!l) return new Error("the test gave no launch for " + params[0].to);
      if (state.broken["token:" + l.token]) return state.broken["token:" + l.token];
      if (withArgument) return l.rawLaunched === undefined ? launchedReturn({ token: l.recordToken || l.token, curve: l.recordCurve || l.curve, deployer: l.recordDeployer || l.deployer, recipient: l.recipient || ZERO, pairToken: l.recordPairToken === undefined ? (l.pairToken === undefined ? WALLET_ADDRESS : l.pairToken) : l.recordPairToken, exists: l.recordExists === undefined ? true : l.recordExists }) : l.rawLaunched;
      if (sel === state.selectors.name) return l.rawName === undefined ? stringReturn(l.name || "") : l.rawName;
      if (sel === state.selectors.symbol) return l.rawSymbol === undefined ? stringReturn(l.symbol || "") : l.rawSymbol;
      if (sel === state.selectors.info) return l.rawInfo === undefined ? tokenInfoReturn({ deployer: l.infoDeployer || l.deployer, logo: l.logo || "", description: l.description || "", socials: l.socials || ["", "", "", "", ""] }) : l.rawInfo;
      return new Error("the test gave no answer for " + sel);
    }
    return new Error("the test gave no answer for " + method);
  });
  return state;
}

/**
 * A durable object context whose sql understands the watcher's statements.
 *
 * Deliberately literal: every statement the watcher and the rules table issue is matched by its opening
 * words, and anything else returns nothing at all rather than something plausible. A fake that guesses is a
 * fake that hides a typo in a real statement.
 */
export function fakeWatchCtx({ legacyRuleDelivery = false } = {}) {
  const kv = new Map();
  const nonces = new Map();
  const telegramUpdates = new Map();
  const telegramResponses = new Map();
  const telegramRenders = new Map();
  const telegramEffects = new Map();
  const telegramCommandBuckets = new Map();
  const tail = [];
  const tailHash = [];
  const wallEvents = [];
  const rules = [];
  let nextRuleId = null;
  const deliveries = [];
  let deliveryHasMade = !legacyRuleDelivery;
  let deliveryHasLastAttempt = !legacyRuleDelivery;
  let alarm = null;
  const NUM = "SELECT COUNT(*) AS N FROM ";
  const sql = {
    statements: [],
    calls: [],
    exec(stmt, ...a) {
      sql.statements.push(stmt);
      sql.calls.push({ stmt, args: [...a] });
      const s = stmt.trim().replace(/\s+/g, " ").toUpperCase();
      if (s === "PRAGMA TABLE_INFO(RULE_DELIVERY)") {
        const names = ["rule_id", "token", "owner", "body", "sent"];
        if (deliveryHasMade) names.push("made");
        if (deliveryHasLastAttempt) names.push("last_attempt");
        return names.map((name, cid) => ({ cid, name }));
      }
      if (s.startsWith("ALTER TABLE RULE_DELIVERY ADD COLUMN MADE")) {
        if (deliveryHasMade) throw new Error("duplicate made migration");
        deliveryHasMade = true;
        for (const delivery of deliveries) delivery.made = 0;
        return [];
      }
      if (s.startsWith("ALTER TABLE RULE_DELIVERY ADD COLUMN LAST_ATTEMPT")) {
        if (deliveryHasLastAttempt) throw new Error("duplicate last_attempt migration");
        deliveryHasLastAttempt = true;
        for (const delivery of deliveries) delivery.last_attempt = 0;
        return [];
      }
      if (s.startsWith("CREATE")) return [];

      if (s.startsWith("SELECT V FROM KV")) { const v = kv.get(a[0]); return v === undefined ? [] : [{ v }]; }
      if (s.startsWith("INSERT INTO KV")) { kv.set(a[0], String(a[1])); return []; }
      if (s.startsWith("DELETE FROM KV WHERE K")) { kv.delete(a[0]); return []; }

      if (s.startsWith("SELECT OWNER, EXPIRES FROM HOLDER_NONCE")) { const v = nonces.get(a[0]); return v ? [{ ...v }] : []; }
      if (s.startsWith("INSERT INTO HOLDER_NONCE")) { nonces.set(a[0], { owner: String(a[1]), expires: Number(a[2]) }); return []; }
      if (s.startsWith("DELETE FROM HOLDER_NONCE WHERE EXPIRES")) {
        for (const [mark, v] of nonces) if (Number(v.expires) <= Number(a[0])) nonces.delete(mark);
        return [];
      }
      if (s.startsWith("DELETE FROM HOLDER_NONCE WHERE MARK")) { nonces.delete(a[0]); return []; }

      if (s.startsWith("SELECT SEEN_AT FROM TELEGRAM_UPDATE")) {
        const seen_at = telegramUpdates.get(Number(a[0]));
        return seen_at === undefined ? [] : [{ seen_at }];
      }
      if (s.startsWith("INSERT INTO TELEGRAM_UPDATE")) { telegramUpdates.set(Number(a[0]), Number(a[1])); return []; }
      if (s.startsWith("SELECT ACTIONS, NEXT_ACTION FROM TELEGRAM_RESPONSE")) {
        const response = telegramResponses.get(Number(a[0]));
        return response ? [{ ...response }] : [];
      }
      if (s.startsWith("INSERT INTO TELEGRAM_RESPONSE")) {
        telegramResponses.set(Number(a[0]), { actions: a[1] === null ? null : String(a[1]), next_action: Number(a[2]) });
        return [];
      }
      if (s.startsWith("UPDATE TELEGRAM_RESPONSE SET ACTIONS")) {
        const response = telegramResponses.get(Number(a[1]));
        if (response) response.actions = String(a[0]);
        return [];
      }
      if (s.startsWith("UPDATE TELEGRAM_RESPONSE SET NEXT_ACTION")) {
        const response = telegramResponses.get(Number(a[1]));
        if (response) response.next_action = Number(a[0]);
        return [];
      }
      if (s.startsWith("DELETE FROM TELEGRAM_RESPONSE WHERE UPDATE_ID IN")) {
        const cutoff = Number(a[0]);
        for (const [updateId, seenAt] of telegramUpdates) if (seenAt <= cutoff) telegramResponses.delete(updateId);
        return [];
      }
      if (s.startsWith("DELETE FROM TELEGRAM_RESPONSE WHERE UPDATE_ID")) { telegramResponses.delete(Number(a[0])); return []; }
      if (s.startsWith("SELECT LEASE_UNTIL FROM TELEGRAM_RENDER")) {
        const lease_until = telegramRenders.get(Number(a[0]));
        return lease_until === undefined ? [] : [{ lease_until }];
      }
      if (s.startsWith("INSERT INTO TELEGRAM_RENDER")) { telegramRenders.set(Number(a[0]), Number(a[1])); return []; }
      if (s.startsWith("UPDATE TELEGRAM_RENDER SET LEASE_UNTIL")) { telegramRenders.set(Number(a[1]), Number(a[0])); return []; }
      if (s.startsWith("DELETE FROM TELEGRAM_RENDER WHERE UPDATE_ID IN")) {
        const cutoff = Number(a[0]);
        for (const [updateId, seenAt] of telegramUpdates) if (seenAt <= cutoff) telegramRenders.delete(updateId);
        return [];
      }
      if (s.startsWith("DELETE FROM TELEGRAM_RENDER WHERE UPDATE_ID")) { telegramRenders.delete(Number(a[0])); return []; }
      if (s.startsWith("SELECT REQUEST, RESULT FROM TELEGRAM_EFFECT")) {
        const row = telegramEffects.get(Number(a[0]) + ":" + String(a[1]));
        return row ? [{ ...row }] : [];
      }
      if (s.startsWith("INSERT INTO TELEGRAM_EFFECT")) {
        telegramEffects.set(Number(a[0]) + ":" + String(a[1]), { request: String(a[2]), result: String(a[3]) });
        return [];
      }
      if (s.startsWith("DELETE FROM TELEGRAM_EFFECT WHERE UPDATE_ID IN")) {
        const cutoff = Number(a[0]);
        for (const [key] of telegramEffects) {
          const updateId = Number(key.split(":", 1)[0]);
          const seenAt = telegramUpdates.get(updateId);
          if (seenAt !== undefined && seenAt <= cutoff) telegramEffects.delete(key);
        }
        return [];
      }
      if (s.startsWith("DELETE FROM TELEGRAM_EFFECT WHERE UPDATE_ID")) {
        const prefix = Number(a[0]) + ":";
        for (const [key] of telegramEffects) if (key.startsWith(prefix)) telegramEffects.delete(key);
        return [];
      }
      if (s.startsWith("DELETE FROM TELEGRAM_UPDATE WHERE SEEN_AT")) {
        for (const [updateId, seenAt] of telegramUpdates) if (seenAt <= Number(a[0])) telegramUpdates.delete(updateId);
        return [];
      }

      if (s.startsWith("SELECT TAKEN, EXPIRES FROM TELEGRAM_COMMAND_BUCKET")) {
        const bucket = telegramCommandBuckets.get(String(a[0]));
        return bucket ? [{ ...bucket }] : [];
      }
      if (s.startsWith("INSERT INTO TELEGRAM_COMMAND_BUCKET")) {
        telegramCommandBuckets.set(String(a[0]), { taken: Number(a[1]), expires: Number(a[2]) });
        return [];
      }
      if (s.startsWith("UPDATE TELEGRAM_COMMAND_BUCKET SET TAKEN")) {
        const bucket = telegramCommandBuckets.get(String(a[1]));
        if (bucket) bucket.taken = Number(a[0]);
        return [];
      }
      if (s.startsWith("DELETE FROM TELEGRAM_COMMAND_BUCKET WHERE EXPIRES")) {
        for (const [owner, bucket] of telegramCommandBuckets) if (bucket.expires <= Number(a[0])) telegramCommandBuckets.delete(owner);
        return [];
      }

      if (s.startsWith("SELECT BLOCK, TS, DATE, DEPLOYER, TX, ROW FROM TAIL WHERE TOKEN")) {
        return tail.filter(r => r.token === a[0]).map(r => ({ block: r.block, ts: r.ts, date: r.date, deployer: r.deployer, tx: r.tx, row: r.row }));
      }
      if (s.startsWith("SELECT BLOCK, ROW FROM TAIL WHERE TOKEN")) return tail.filter(r => r.token === a[0]).map(r => ({ block: r.block, row: r.row }));
      if (s.startsWith("INSERT INTO TAIL (")) { tail.push({ token: a[0], block: a[1], ts: a[2], date: a[3], deployer: a[4], tx: a[5], row: a[6] }); return []; }
      if (s.startsWith("INSERT INTO TAIL_HASH")) { tailHash.push({ token: a[0], ns: a[1], hash: a[2] }); return []; }
      if (s.startsWith(NUM + "TAIL_HASH AS H JOIN TAIL AS T")) return [{ n: tailHash.filter(r => r.ns === a[0] && r.hash === a[1] && tail.some(t => t.token === r.token && Number(t.block) > Number(a[2]))).length }];
      if (s.startsWith(NUM + "TAIL_HASH WHERE NS")) return [{ n: tailHash.filter(r => r.ns === a[0] && r.hash === a[1]).length }];
      if (s.startsWith(NUM + "TAIL WHERE BLOCK >=")) return [{ n: tail.filter(r => Number(r.block) >= Number(a[0]) && Number(r.block) <= Number(a[1])).length }];
      if (s.startsWith(NUM + "TAIL AS T JOIN WALL_EVENT")) return [{ n: tail.filter(r => r.deployer === a[0] && Number(r.block) > Number(a[1]) && wallEvents.some(w => w.token === r.token)).length }];
      if (s.startsWith(NUM + "TAIL WHERE DEPLOYER")) return [{ n: tail.filter(r => r.deployer === a[0] && (!s.includes("AND BLOCK >") || Number(r.block) > Number(a[1]))).length }];
      if (s.startsWith(NUM + "TAIL AS T LEFT JOIN WALL_EVENT")) return [{ n: tail.filter(r => Number(r.block) > Number(a[0]) && !wallEvents.some(w => w.token === r.token)).length }];
      if (s.startsWith(NUM + "TAIL")) return [{ n: tail.length }];
      if (s.startsWith("SELECT TOKEN FROM TAIL WHERE TS < ? AND BLOCK <= ?")) return tail
        .filter(r => Number(r.ts) < Number(a[0]) && Number(r.block) <= Number(a[1]))
        .sort((x, y) => Number(x.block) - Number(y.block) || String(x.token).localeCompare(String(y.token)))
        .slice(0, Number(a[2])).map(r => ({ token: r.token }));
      if (s.startsWith("DELETE FROM TAIL WHERE TOKEN")) { const i = tail.findIndex(r => r.token === a[0]); if (i >= 0) tail.splice(i, 1); return []; }
      if (s.startsWith("DELETE FROM TAIL_HASH WHERE TOKEN")) { for (let i = tailHash.length - 1; i >= 0; i--) if (tailHash[i].token === a[0]) tailHash.splice(i, 1); return []; }
      if (s.startsWith("SELECT TOKEN, BLOCK, TS, DATE, DEPLOYER, ROW FROM TAIL")) {
        const selected = s.includes("WHERE BLOCK >=")
          ? tail.filter(r => Number(r.block) >= Number(a[0]) && Number(r.block) <= Number(a[1]))
          : tail.slice();
        const ordered = selected.sort((x, y) => x.block - y.block || (x.token < y.token ? -1 : x.token > y.token ? 1 : 0));
        const bounded = s.includes("LIMIT ?") ? ordered.slice(0, Number(a[2])) : ordered;
        return bounded.map(r => ({ ...r }));
      }
      if (s.startsWith("SELECT BLOCK, ROW FROM TAIL")) return tail.slice().sort((x, y) => x.block - y.block).map(r => ({ block: r.block, row: r.row }));
      if (s.startsWith("SELECT T.TOKEN AS TOKEN, T.BLOCK AS BLOCK, T.ROW AS ROW FROM TAIL AS T LEFT JOIN WALL_EVENT")) {
        return tail.filter(r => Number(r.block) > Number(a[0]) && !wallEvents.some(w => w.token === r.token))
          .sort((x, y) => Number(x.block) - Number(y.block) || String(x.token).localeCompare(String(y.token)))
          .slice(0, Number(a[1])).map(r => ({ token: r.token, block: r.block, row: r.row }));
      }
      if (s.startsWith("SELECT T.BLOCK AS BLOCK, T.DATE AS DATE, W.LOG_INDEX AS LOG_INDEX")) {
        return tail.filter(r => r.deployer === a[0] && Number(r.block) > Number(a[1]))
          .map(r => ({ tail: r, wall: wallEvents.find(w => w.token === r.token) })).filter(r => r.wall)
          .sort((x, y) => Number(y.tail.block) - Number(x.tail.block) || Number(y.wall.log_index) - Number(x.wall.log_index))
          .slice(0, Number(a[2])).map(r => ({ block: r.tail.block, date: r.tail.date, log_index: r.wall.log_index, name: r.wall.name, ticker: r.wall.ticker }));
      }

      if (s.startsWith("SELECT TOKEN FROM WALL_EVENT WHERE BLOCK")) return wallEvents.filter(w => w.block === Number(a[0]) && w.log_index === Number(a[1])).map(w => ({ token: w.token }));
      if (s.startsWith("INSERT INTO WALL_EVENT")) { wallEvents.push({ block: Number(a[0]), log_index: Number(a[1]), token: String(a[2]), name: a[3], ticker: a[4], publishable: Number(a[5]) }); return []; }
      if (s.startsWith("DELETE FROM WALL_EVENT WHERE TOKEN")) { for (let i = wallEvents.length - 1; i >= 0; i--) if (wallEvents[i].token === a[0]) wallEvents.splice(i, 1); return []; }
      if (s.startsWith("SELECT BLOCK, LOG_INDEX, NAME, TICKER FROM WALL_EVENT")) {
        let rows = wallEvents.filter(w => w.publishable === 1);
        let limit;
        if (s.includes("WHERE (BLOCK > ?")) {
          rows = rows.filter(w => (w.block > Number(a[0]) || (w.block === Number(a[1]) && w.log_index > Number(a[2]))) && w.block <= Number(a[3]));
          limit = Number(a[4]);
        } else if (s.includes("AND (BLOCK < ?")) {
          rows = rows.filter(w => w.block > Number(a[0]) && w.block <= Number(a[1]) && (w.block < Number(a[2]) || (w.block === Number(a[3]) && w.log_index < Number(a[4]))));
          limit = Number(a[5]);
        } else {
          rows = rows.filter(w => w.block > Number(a[0]) && w.block <= Number(a[1]));
          limit = Number(a[2]);
        }
        rows.sort((x, y) => s.includes("ORDER BY BLOCK DESC")
          ? y.block - x.block || y.log_index - x.log_index
          : x.block - y.block || x.log_index - y.log_index);
        return rows.slice(0, limit).map(({ block, log_index, name, ticker }) => ({ block, log_index, name, ticker }));
      }

      if (s.startsWith(NUM + "RULES WHERE OWNER")) return [{ n: rules.filter(r => r.owner === a[0]).length }];
      if (s === NUM + "RULES") return [{ n: rules.length }];
      if (s.startsWith("SELECT NEXT_ID FROM RULE_SEQUENCE")) return nextRuleId === null ? [] : [{ next_id: nextRuleId }];
      if (s.startsWith("INSERT INTO RULE_SEQUENCE")) { nextRuleId = Number(a[1]); return []; }
      if (s.startsWith("UPDATE RULE_SEQUENCE SET NEXT_ID")) { nextRuleId = Number(a[0]); return []; }
      if (s.startsWith("SELECT MAX(ID) AS M FROM RULES")) return [{ m: rules.reduce((n, r) => Math.max(n, r.id), 0) }];
      if (s.startsWith("INSERT INTO RULES")) { rules.push({ id: a[0], owner: a[1], kind: a[2], arg: a[3], hashes: a[4], made: a[5], hits: a[6] }); return []; }
      if (s.startsWith("SELECT ID, OWNER, KIND, ARG, HASHES, MADE, HITS FROM RULES WHERE OWNER")) {
        return rules.filter(r => r.owner === a[0]).sort((x, y) => x.id - y.id).map(r => ({ ...r }));
      }
      if (s.startsWith("SELECT ID, OWNER, KIND, ARG, HASHES, MADE, HITS FROM RULES WHERE ID")) {
        return rules.filter(r => r.id === Number(a[0])).map(r => ({ ...r }));
      }
      if (s.startsWith("SELECT ID, OWNER, KIND, ARG, HASHES, MADE, HITS FROM RULES")) return rules.slice().sort((x, y) => x.id - y.id).map(r => ({ ...r }));
      if (s.startsWith("DELETE FROM RULES WHERE ID = ? AND OWNER")) {
        const i = rules.findIndex(r => r.id === Number(a[0]) && r.owner === String(a[1]));
        if (i >= 0) rules.splice(i, 1);
        return [];
      }
      if (s.startsWith("DELETE FROM RULES WHERE OWNER")) {
        for (let i = rules.length - 1; i >= 0; i--) if (rules[i].owner === String(a[0])) rules.splice(i, 1);
        return [];
      }
      if (s.startsWith("UPDATE RULES SET HITS")) { const r = rules.find(x => x.id === Number(a[1])); if (r) r.hits = Number(r.hits) + Number(a[0]); return []; }

      if (s.startsWith(NUM + "RULE_DELIVERY WHERE SENT")) return [{ n: deliveries.filter(d => d.sent === Number(a[0])).length }];
      if (s.startsWith("SELECT OWNER, BODY, SENT, MADE, LAST_ATTEMPT FROM RULE_DELIVERY")) {
        return deliveries.filter(d => d.rule_id === Number(a[0]) && d.token === String(a[1])).map(d => ({ owner: d.owner, body: d.body, sent: d.sent, made: d.made, last_attempt: d.last_attempt }));
      }
      if (s.startsWith("SELECT RULE_ID, TOKEN, OWNER, BODY, SENT, MADE, LAST_ATTEMPT FROM RULE_DELIVERY")) {
        return deliveries.filter(d => d.sent === Number(a[0]))
          .sort((x, y) => Number(x.last_attempt) - Number(y.last_attempt) || Number(x.made) - Number(y.made) || x.rule_id - y.rule_id || x.token.localeCompare(y.token))
          .slice(0, Number(a[1])).map(d => ({ ...d }));
      }
      if (s.startsWith("INSERT OR IGNORE INTO RULE_DELIVERY")) {
        if (!deliveries.some(d => d.rule_id === Number(a[0]) && d.token === String(a[1]))) {
          deliveries.push({ rule_id: Number(a[0]), token: String(a[1]), owner: String(a[2]), body: String(a[3]), sent: Number(a[4]), made: Number(a[5]), last_attempt: Number(a[6]) });
        }
        return [];
      }
      if (s.startsWith("UPDATE RULE_DELIVERY SET LAST_ATTEMPT")) {
        const d = deliveries.find(row => row.rule_id === Number(a[1]) && row.token === String(a[2]));
        if (d) d.last_attempt = Number(a[0]);
        return [];
      }
      if (s.startsWith("UPDATE RULE_DELIVERY SET SENT")) {
        const d = deliveries.find(row => row.rule_id === Number(a[1]) && row.token === String(a[2]));
        if (d) d.sent = Number(a[0]);
        return [];
      }
      if (s.startsWith("DELETE FROM RULE_DELIVERY WHERE RULE_ID = ? AND TOKEN")) {
        for (let i = deliveries.length - 1; i >= 0; i--) if (deliveries[i].rule_id === Number(a[0]) && deliveries[i].token === String(a[1])) deliveries.splice(i, 1);
        return [];
      }
      if (s.startsWith("DELETE FROM RULE_DELIVERY WHERE RULE_ID")) {
        for (let i = deliveries.length - 1; i >= 0; i--) if (deliveries[i].rule_id === Number(a[0])) deliveries.splice(i, 1);
        return [];
      }
      if (s.startsWith("DELETE FROM RULE_DELIVERY WHERE OWNER")) {
        for (let i = deliveries.length - 1; i >= 0; i--) if (deliveries[i].owner === String(a[0])) deliveries.splice(i, 1);
        return [];
      }
      if (s.startsWith("DELETE FROM RULE_DELIVERY WHERE SENT = ? AND TOKEN IN")) {
        const covered = new Set(tail.filter(row => Number(row.block) <= Number(a[1])).map(row => row.token));
        for (let i = deliveries.length - 1; i >= 0; i--) {
          if (deliveries[i].sent === Number(a[0]) && covered.has(deliveries[i].token)) deliveries.splice(i, 1);
        }
        return [];
      }
      if (s.startsWith("DELETE FROM RULE_DELIVERY WHERE TOKEN")) {
        for (let i = deliveries.length - 1; i >= 0; i--) {
          if (deliveries[i].token === String(a[0]) && (!s.includes("AND SENT") || deliveries[i].sent === Number(a[1]))) deliveries.splice(i, 1);
        }
        return [];
      }

      return [];
    }
  };
  return {
    kv, nonces, telegramUpdates, telegramResponses, telegramRenders, telegramEffects, telegramCommandBuckets, tail, tailHash, wallEvents, rules, deliveries,
    storage: {
      sql,
      transactionSync(callback) { return callback(); },
      async setAlarm(at) { alarm = at; },
      async getAlarm() { return alarm; },
      async deleteAlarm() { alarm = null; },
      peekAlarm() { return alarm; }
    }
  };
}

/**
 * Replace the global fetch with one that tells the site's three published files apart.
 *
 * fakeNetwork above answers token.json for everything, which is all round D1 needed. The watcher reads two
 * files round D1 never asked for, and a rule that read the wrong one would still look as though it worked.
 */
export function fakePublished(state) {
  const s = { token: { address: null, pons: null, uniswap: null }, index: emptyPublishedIndex(), numbers: null, indexOk: true, numbersOk: true, manifestOk: true, manifest: null, telegramOk: true, attempted: [], sent: [], asked: [], ...state };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    s.asked.push(u);
    if (u.includes("api.telegram.org")) {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      s.attempted.push(body);
      if (!s.telegramOk) return new Response(JSON.stringify({ ok: false }), { status: 503, headers: { "content-type": "application/json" } });
      s.sent.push(body);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("launch-manifest.json")) return s.manifestOk ? answer(s.manifest || manifestFor(s.index, s.numbers)) : refuse();
    if (u.includes("launch-index.json")) return s.indexOk ? answer(s.index) : refuse();
    if (u.includes("launch-numbers.json")) return s.numbersOk ? answer(s.numbers) : refuse();
    return answer(s.token);
  };
  return s;
}
export const emptyPublishedIndex = () => Object.fromEntries(INDEX_NAMESPACES.map(namespace => [namespace, {}]));
const textOf = value => JSON.stringify(value);
const sha = text => crypto.createHash("sha256").update(text).digest("hex");
export const manifestFor = (index, numbers) => {
  const indexText = textOf(index), numbersText = textOf(numbers);
  const entries = Object.fromEntries(INDEX_NAMESPACES.map(namespace => [namespace, index && typeof index[namespace] === "object" && index[namespace] ? Object.keys(index[namespace]).length : 0]));
  return { schema: MANIFEST_SCHEMA, index: { sha256: sha(indexText), bytes: Buffer.byteLength(indexText), entries, entries_total: Object.values(entries).reduce((sum, count) => sum + count, 0) }, numbers: { sha256: sha(numbersText), bytes: Buffer.byteLength(numbersText) } };
};
const answer = value => new Response(textOf(value), { status: 200, headers: { "content-type": "application/json" } });
const refuse = () => new Response("unreadable", { status: 500, headers: { "content-type": "text/plain" } });

/** two telegram ids, so a test can hand one person's rule to another and watch it refuse */
export const OWNER_A = "111111111";
export const OWNER_B = "222222222";
