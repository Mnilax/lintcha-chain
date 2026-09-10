// The fakes every test here shares. There is no network in any of them: the site, the endpoint and Telegram
// are all objects in this file, and the one global that gets replaced is fetch.
//
// No value in this file is a secret. The strings that stand in for a bot token and a webhook secret are named
// so that nobody can mistake them for real ones, and the private key that produced the signature fixture is
// not here at all: only the signature, the address and the sentence it was made over.

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
export function fakeCtx() {
  const rows = new Map();
  let alarm = null;
  const sql = {
    statements: [],
    exec(stmt, ...args) {
      sql.statements.push(stmt);
      const s = stmt.trim().toUpperCase();
      if (s.startsWith("CREATE")) return [];
      if (s.startsWith("SELECT V FROM KV")) { const v = rows.get("kv:" + args[0]); return v === undefined ? [] : [{ v }]; }
      if (s.startsWith("INSERT INTO KV")) { rows.set("kv:" + args[0], String(args[1])); return []; }
      if (s.startsWith("SELECT 1 AS ONE FROM BUYS")) return rows.has("buy:" + args[0] + ":" + args[1]) ? [{ one: 1 }] : [];
      if (s.startsWith("INSERT INTO BUYS")) { rows.set("buy:" + args[0] + ":" + args[1], true); return []; }
      if (s.startsWith("SELECT BUYS, TOTAL FROM WALLETS WHERE")) { const v = rows.get("wal:" + args[0]); return v ? [v] : []; }
      if (s.startsWith("INSERT INTO WALLETS")) { rows.set("wal:" + args[0], { buys: args[2], total: args[3] }); return []; }
      if (s.startsWith("UPDATE WALLETS")) { rows.set("wal:" + args[2], { buys: args[0], total: args[1] }); return []; }
      if (s.startsWith("SELECT COUNT(*) AS N FROM WALLETS")) return [{ n: [...rows.keys()].filter(k => k.startsWith("wal:")).length }];
      if (s.startsWith("SELECT WALLET, BUYS, TOTAL FROM WALLETS")) {
        return [...rows.entries()].filter(([k]) => k.startsWith("wal:")).map(([k, v]) => ({ wallet: k.slice(4), buys: v.buys, total: v.total }));
      }
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
  const state = { site: { address: null, pons: null, uniswap: null }, siteOk: true, sent: [] };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      state.sent.push(opts && opts.body ? JSON.parse(opts.body) : {});
      return { ok: true, status: 200, async json() { return { ok: true }; } };
    }
    if (!state.siteOk) return { ok: false, status: 500, async json() { throw new Error("unreadable"); } };
    return { ok: true, status: 200, async json() { return state.site; } };
  };
  return state;
}

// ---------------------------------------------------------------- fixtures
/** a thirty-two byte word as 0x hex, for stubbing an eth_call return */
export const wordHex = v => "0x" + BigInt(v).toString(16).padStart(64, "0");
/** an address as a log topic */
export const topicAddr = a => "0x" + a.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** the factory's fifteen word record, with only the fields the bot reads filled in */
export function launchRecordHex({ curve, exists = true }) {
  const words = new Array(15).fill("".padStart(64, "0"));
  words[1] = curve.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  words[14] = exists ? "1".padStart(64, "0") : "".padStart(64, "0");
  return "0x" + words.join("");
}

/**
 * The signature fixture. Made over the exact sentence in bot/src/texts.js by the private key from the worked
 * example in EIP-155, whose address is quoted in that EIP and in every library's test suite. The key itself is
 * deliberately not in this repository: a fixture needs the signature and the address, not the key.
 */
export const FIXTURE = {
  address: "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f",
  signature: "0x6191e5503ea45a982cd3a4b98d40ae3d651a6baf1080bed4dfe885c0f53a22141dd9e99eacfc67a4536e7424e1dfac92d4ba088f314d961ef1d674d9f6f9a5a91b"
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
export const launchedReturn = ({ token = ZERO, curve = ZERO, deployer = ZERO, recipient = ZERO, exists = true }) =>
  "0x" + hexOf(encode(ABI.tuple(LAUNCHED_TOKEN), [[token, curve, deployer, recipient, ZERO, 0n, 0n, 0n, 0n, false, 0n, 0n, 0n, 0n, exists]]));

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
    broken: config.broken || {},
    selectors: config.selectors,
    reads: 0
  };
  const byArgument = data => state.launches.find(l => String(data).toLowerCase().includes(l.token.replace(/^0x/, "").toLowerCase()));
  state.gate = fakeGateFn(async (method, params) => {
    if (state.broken[method]) return state.broken[method];
    if (method === "eth_chainId") return state.chainId;
    if (method === "eth_blockNumber") return "0x" + Number(state.head).toString(16);
    if (method === "eth_getBlockByNumber") {
      const n = Number(BigInt(params[0]));
      const ts = state.timestamps[n];
      return { number: params[0], timestamp: "0x" + Number(ts === undefined ? 1700000000 : ts).toString(16) };
    }
    if (method === "eth_getLogs") {
      const from = Number(BigInt(params[0].fromBlock)), to = Number(BigInt(params[0].toBlock));
      return state.launches.filter(l => l.block >= from && l.block <= to).map(l => ({
        topics: [params[0].topics[0], asTopic(l.token), asTopic(l.curve || "0x" + "2".repeat(40)), asTopic(l.deployer)],
        data: "0x",
        blockNumber: "0x" + l.block.toString(16),
        transactionHash: l.tx || "0x" + "a".repeat(64),
        logIndex: "0x0"
      }));
    }
    if (method === "eth_call") {
      state.reads++;
      const data = params[0].data, sel = data.slice(0, 10);
      const withArgument = data.length > 10;
      const l = withArgument ? byArgument(data.slice(10)) : state.launches.find(x => x.token.toLowerCase() === String(params[0].to).toLowerCase());
      if (!l) return new Error("the test gave no launch for " + params[0].to);
      if (state.broken["token:" + l.token]) return state.broken["token:" + l.token];
      if (withArgument) return launchedReturn({ token: l.token, curve: l.curve, deployer: l.deployer, recipient: l.recipient || ZERO });
      if (sel === state.selectors.name) return stringReturn(l.name || "");
      if (sel === state.selectors.symbol) return stringReturn(l.symbol || "");
      if (sel === state.selectors.info) return tokenInfoReturn({ deployer: l.deployer, logo: l.logo || "", description: l.description || "", socials: l.socials || ["", "", "", "", ""] });
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
export function fakeWatchCtx() {
  const kv = new Map();
  const tail = [];
  const tailHash = [];
  const rules = [];
  let alarm = null;
  const NUM = "SELECT COUNT(*) AS N FROM ";
  const sql = {
    statements: [],
    exec(stmt, ...a) {
      sql.statements.push(stmt);
      const s = stmt.trim().replace(/\s+/g, " ").toUpperCase();
      if (s.startsWith("CREATE")) return [];

      if (s.startsWith("SELECT V FROM KV")) { const v = kv.get(a[0]); return v === undefined ? [] : [{ v }]; }
      if (s.startsWith("INSERT INTO KV")) { kv.set(a[0], String(a[1])); return []; }

      if (s.startsWith("SELECT 1 AS ONE FROM TAIL WHERE TOKEN")) return tail.some(r => r.token === a[0]) ? [{ one: 1 }] : [];
      if (s.startsWith("INSERT INTO TAIL (")) { tail.push({ token: a[0], block: a[1], ts: a[2], date: a[3], deployer: a[4], tx: a[5], row: a[6] }); return []; }
      if (s.startsWith("INSERT INTO TAIL_HASH")) { tailHash.push({ token: a[0], ns: a[1], hash: a[2] }); return []; }
      if (s.startsWith(NUM + "TAIL_HASH WHERE NS")) return [{ n: tailHash.filter(r => r.ns === a[0] && r.hash === a[1]).length }];
      if (s.startsWith(NUM + "TAIL WHERE DEPLOYER")) return [{ n: tail.filter(r => r.deployer === a[0]).length }];
      if (s.startsWith(NUM + "TAIL")) return [{ n: tail.length }];
      if (s.startsWith("SELECT TOKEN FROM TAIL WHERE TS <")) return tail.filter(r => Number(r.ts) < Number(a[0])).map(r => ({ token: r.token }));
      if (s.startsWith("DELETE FROM TAIL WHERE TOKEN")) { const i = tail.findIndex(r => r.token === a[0]); if (i >= 0) tail.splice(i, 1); return []; }
      if (s.startsWith("DELETE FROM TAIL_HASH WHERE TOKEN")) { for (let i = tailHash.length - 1; i >= 0; i--) if (tailHash[i].token === a[0]) tailHash.splice(i, 1); return []; }
      if (s.startsWith("SELECT TOKEN, BLOCK, TS, DATE, DEPLOYER, ROW FROM TAIL")) {
        return tail.slice().sort((x, y) => x.block - y.block || (x.token < y.token ? -1 : 1)).map(r => ({ ...r }));
      }

      if (s.startsWith(NUM + "RULES WHERE OWNER")) return [{ n: rules.filter(r => r.owner === a[0]).length }];
      if (s.startsWith("SELECT MAX(ID) AS M FROM RULES")) return [{ m: rules.reduce((n, r) => Math.max(n, r.id), 0) }];
      if (s.startsWith("INSERT INTO RULES")) { rules.push({ id: a[0], owner: a[1], kind: a[2], arg: a[3], hashes: a[4], made: a[5], hits: a[6] }); return []; }
      if (s.startsWith("SELECT ID, OWNER, KIND, ARG, HASHES, MADE, HITS FROM RULES WHERE OWNER")) {
        return rules.filter(r => r.owner === a[0]).sort((x, y) => x.id - y.id).map(r => ({ ...r }));
      }
      if (s.startsWith("SELECT ID, OWNER, KIND, ARG, HASHES, MADE, HITS FROM RULES")) return rules.slice().sort((x, y) => x.id - y.id).map(r => ({ ...r }));
      if (s.startsWith("DELETE FROM RULES WHERE ID = ? AND OWNER")) {
        const i = rules.findIndex(r => r.id === Number(a[0]) && r.owner === String(a[1]));
        if (i >= 0) rules.splice(i, 1);
        return [];
      }
      if (s.startsWith("UPDATE RULES SET HITS")) { const r = rules.find(x => x.id === Number(a[1])); if (r) r.hits = Number(r.hits) + Number(a[0]); return []; }

      return [];
    }
  };
  return {
    kv, tail, tailHash, rules,
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
 * Replace the global fetch with one that tells the site's three published files apart.
 *
 * fakeNetwork above answers token.json for everything, which is all round D1 needed. The watcher reads two
 * files round D1 never asked for, and a rule that read the wrong one would still look as though it worked.
 */
export function fakePublished(state) {
  const s = { token: { address: null, pons: null, uniswap: null }, index: {}, numbers: null, indexOk: true, numbersOk: true, sent: [], asked: [], ...state };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    s.asked.push(u);
    if (u.includes("api.telegram.org")) {
      s.sent.push(opts && opts.body ? JSON.parse(opts.body) : {});
      return { ok: true, status: 200, async json() { return { ok: true }; } };
    }
    if (u.includes("launch-index.json")) return s.indexOk ? answer(s.index) : refuse();
    if (u.includes("launch-numbers.json")) return s.numbersOk ? answer(s.numbers) : refuse();
    return answer(s.token);
  };
  return s;
}
const answer = v => ({ ok: true, status: 200, async json() { return v; } });
const refuse = () => ({ ok: false, status: 500, async json() { throw new Error("unreadable"); } });

/** two telegram ids, so a test can hand one person's rule to another and watch it refuse */
export const OWNER_A = "111111111";
export const OWNER_B = "222222222";
