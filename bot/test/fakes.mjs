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
