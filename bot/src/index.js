// The worker. Six routes and a cron, and nothing else answers.
//
//   POST /api/telegram   the webhook. Every update must carry X-Telegram-Bot-Api-Secret-Token matching the
//                        TELEGRAM_WEBHOOK_SECRET secret. A wrong or missing header gets four hundred and one
//                        with no body: no hint about what was wrong, no echo of what was sent. Its numeric
//                        update_id is claimed in the singleton Watch object before any command can run.
//   POST /api/hold       the holder check, from the /hold page on the site. Same origin, which is why the
//                        vendored connect-src 'self' needs no editing. The route requires that exact browser
//                        origin and JSON media type before it touches the one global Watch object.
//   POST /api/identity   an opt-in integration surface for the page's exact comparison. Unlike the browser
//                        tool, an API call sends its strings to this Worker. They are not stored or echoed.
//   GET  /api/tail       versioned, bounded pages of the live launch tail: counted hashes, an exact block range,
//                        ordered chunk commitments and an opaque continuation cursor. Public, cached for a few
//                        seconds, and rate limited per isolate. The page is
//                        not changed in this round and still reads the static snapshot; the tail is here
//                        because the rules read it, and because a range with a hash is a range a command can
//                        rebuild and compare.
//   GET  /api/wall       bounded pages and verified deltas of the strict post-snapshot suffix, as
//                        self-declared name/ticker pairs only.
//   GET  /api/deployer   bounded retained watcher history for one public deployer address: block, date and
//                        the safe-to-display name/ticker declarations, with its exact coverage range.
//   scheduled            once a minute, the watchdog for both objects. It reads nothing itself: it asks the
//                        feed whether a round happened recently, and it starts the watcher again after a
//                        stretch with no endpoint, when there was no alarm left to fire.
//
// Anything else under this worker's routes gets four hundred and four. The site's own pages are not touched:
// the route is /api/*, and the root stays with the assets worker.
//
// The webhook path is this worker's choice, not Telegram's. Vlad sets the webhook himself from a browser, and
// that command carries the bot token, so it is not written here, not in the README and not in the repository.

import { handleUpdate, commandOf, ourBotJoined, KNOWN_COMMANDS } from "./router.js";
import { sendMessage, sendMessageResult } from "./telegram.js";
import { checkHold } from "./verify.js";
import { readToken } from "./chain.js";
import * as T from "./texts.js";
import { Tape } from "./tape.js";
import { Watch, DEFAULT_TAIL_CACHE_MS, DEFAULT_INDEX_TTL_MS } from "./watch.js";
import { integerSetting } from "./config.js";
import { identityInputOf } from "./identity.js";

export { Tape, Watch };

/** A comparison that does not return early on the first wrong byte. */
export function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The one feed object, reached by a fixed name so every request finds the same one. */
function tapeStub(env) {
  if (!env.TAPE) return null;
  return env.TAPE.get(env.TAPE.idFromName("tape"));
}

/** What the router is given for /stats: the object, or null when there is no binding. */
function tapeDep(env) {
  const stub = tapeStub(env);
  if (!stub) return null;
  const ask = async path => {
    try {
      const r = await stub.fetch("https://tape/" + path);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  return { stats: () => ask("stats") };
}

/** The one watcher, reached the same way. */
function watchStub(env) {
  if (!env.WATCH) return null;
  return env.WATCH.get(env.WATCH.idFromName("watch"));
}

/** Telegram sends update_id as a positive JSON number; values JavaScript cannot represent exactly are refused. */
export function telegramUpdateIdOf(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Only an actual known command spends a user's durable bucket; unknown Telegram traffic is merely deduped. */
export function telegramCommandClaimOf(update, botUsername = null) {
  const msg = (update && (update.message || update.edited_message)) || null;
  if (!msg || !msg.chat) return { known: false, owner: null, meteredOwner: null, metered: false };
  if (Array.isArray(msg.new_chat_members) && msg.new_chat_members.length) {
    if (!ourBotJoined(update, botUsername)) return { known: false, owner: null, meteredOwner: null, metered: false };
    const id = msg.from ? telegramUpdateIdOf(msg.from.id) : null;
    const owner = id === null ? null : String(id);
    return { known: true, owner, meteredOwner: null, metered: false, service: true };
  }
  const command = commandOf(msg.text, botUsername);
  if (!command || !KNOWN_COMMANDS.includes(command)) return { known: false, owner: null, meteredOwner: null, metered: false };
  const id = msg.from ? telegramUpdateIdOf(msg.from.id) : null;
  const owner = id === null ? null : String(id);
  // /forget is the deletion path promised to work independently of the rest of the service. It is still
  // claimed exactly once, but cannot be held behind an earlier burst of read-only commands.
  const metered = command !== "forget";
  return { known: true, owner, meteredOwner: metered ? owner : null, metered };
}

/** Strongly consistent webhook dedupe, sharing the singleton Watch object's SQLite store. */
function telegramUpdateDep(env) {
  const stub = watchStub(env);
  if (!stub) return null;
  const ask = async body => {
    try {
      const r = await stub.fetch("https://watch/telegram-update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!r.ok) return null;
      const result = await r.json();
      const actions = result && result.actions;
      return result && result.ok === true && typeof result.pending === "boolean" &&
        (actions === null || Array.isArray(actions)) && Number.isSafeInteger(result.nextAction) && result.nextAction >= 0
        ? result
        : null;
    } catch { return null; }
  };
  return {
    claim: (updateId, owner, metered, runnable) => ask({ what: "claim", updateId, owner, metered, runnable }),
    store: (updateId, actions) => ask({ what: "actions", updateId, actions }),
    send: (updateId, index) => ask({ what: "send", updateId, index }),
    release: (updateId, index, leaseUntil) => ask({ what: "release", updateId, index, leaseUntil }),
    advance: (updateId, index, leaseUntil) => ask({ what: "advance", updateId, index, leaseUntil })
  };
}

/** Strongly consistent one-time marks, stored inside the existing Watch object rather than in eventual KV. */
function nonceDep(env, updateId = null) {
  const stub = watchStub(env);
  if (!stub) return null;
  const ask = async body => {
    try {
      const r = await stub.fetch("https://watch/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  return {
    async putNonce(mark, owner) {
      const result = await ask({ what: "put", mark, owner: String(owner), updateId });
      return result && result.ok === true && typeof result.mark === "string" ? result.mark : !!(result && result.ok === true);
    },
    async takeNonce(mark) {
      const result = await ask({ what: "take", mark });
      return result && result.ok === true && typeof result.owner === "string" ? result.owner : null;
    }
  };
}

/**
 * What the router is given for the three rule commands, or null when there is no binding — and then those
 * commands say the watcher is not up rather than pretending to have stored something.
 */
function watchDep(env, updateId = null) {
  const stub = watchStub(env);
  if (!stub) return null;
  const ask = async (what, extra) => {
    try {
      const r = await stub.fetch("https://watch/rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ what, ...extra })
      });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  return {
    list: owner => ask("list", { owner: String(owner) }),
    add: (owner, kind, arg) => ask("add", { owner: String(owner), kind, arg, updateId }),
    remove: (owner, number) => ask("remove", { owner: String(owner), number, updateId }),
    forget: owner => ask("forget", { owner: String(owner), updateId })
  };
}

/**
 * A courtesy limit on /api/tail: a few requests a second per isolate.
 *
 * Said plainly because it would be easy to read as more than it is: Cloudflare runs many isolates, so this
 * bounds what one of them will do and not what the endpoint as a whole will do. What actually keeps the cost
 * flat is the cache below it — the answer is built once per TAIL_CACHE_MS inside the object and handed out
 * unchanged — and the object's own single threading. A real global limit needs state, and state for that would
 * be a write per request, which is the thing being avoided.
 */
const tailBucket = { at: 0, taken: 0 };
const wallBucket = { at: 0, taken: 0 };
const historyBucket = { at: 0, taken: 0 };
const holdBucket = { at: 0, taken: 0 };
const identityBucket = { at: 0, taken: 0 };
export const DEFAULT_API_PER_SECOND = 4;
export const MAX_API_PER_SECOND = 100;
/** Public request bodies are tiny protocol messages; these bounds are byte ceilings, not hints. */
export const TELEGRAM_UPDATE_BODY_LIMIT = 64 * 1024;
export const HOLD_BODY_LIMIT = 1024;
export const IDENTITY_BODY_LIMIT = TELEGRAM_UPDATE_BODY_LIMIT;
/** Inbound body reads share the watcher's existing bounded I/O window. */
export const INBOUND_BODY_TIMEOUT_MS = DEFAULT_TAIL_CACHE_MS;
/** Only for tests: forget what this second has already served. */
export function forgetTailBucket() { tailBucket.at = 0; tailBucket.taken = 0; }
export function forgetWallBucket() { wallBucket.at = 0; wallBucket.taken = 0; }
export function forgetHistoryBucket() { historyBucket.at = 0; historyBucket.taken = 0; }
export function forgetHoldBucket() { holdBucket.at = 0; holdBucket.taken = 0; }
export function forgetIdentityBucket() { identityBucket.at = 0; identityBucket.taken = 0; }
function bucketAllowed(bucket, now, perSecond) {
  const second = Math.floor(now / 1000);
  if (bucket.at !== second) { bucket.at = second; bucket.taken = 0; }
  if (bucket.taken >= perSecond) return false;
  bucket.taken++;
  return true;
}
/** A malformed deployment setting must tighten to the documented default, never disable the bucket. */
export function apiPerSecond(value, fallback = DEFAULT_API_PER_SECOND) {
  const safeFallback = integerSetting(fallback, DEFAULT_API_PER_SECOND, {
    min: 1,
    max: MAX_API_PER_SECOND,
    invalid: DEFAULT_API_PER_SECOND
  });
  return integerSetting(value, safeFallback, { min: 1, max: MAX_API_PER_SECOND, invalid: safeFallback });
}
/** The route and its singleton object must derive the same finite cache window from one deployment value. */
export function publicCacheSeconds(value) {
  const milliseconds = integerSetting(value, DEFAULT_TAIL_CACHE_MS, { min: 0, max: DEFAULT_INDEX_TTL_MS });
  return Math.max(1, Math.round(milliseconds / 1000));
}
const configuredPerSecond = (primary, secondary) => {
  if (primary !== undefined && primary !== null && primary !== "") return apiPerSecond(primary);
  if (secondary !== undefined && secondary !== null && secondary !== "") return apiPerSecond(secondary);
  return DEFAULT_API_PER_SECOND;
};
const tailAllowed = (now, perSecond) => bucketAllowed(tailBucket, now, perSecond);
const wallAllowed = (now, perSecond) => bucketAllowed(wallBucket, now, perSecond);
const historyAllowed = (now, perSecond) => bucketAllowed(historyBucket, now, perSecond);
const holdAllowed = (now, perSecond) => bucketAllowed(holdBucket, now, perSecond);
const identityAllowed = (now, perSecond) => bucketAllowed(identityBucket, now, perSecond);

const identityHeaders = Object.freeze({
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "*"
});
const identityJson = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { ...identityHeaders, ...extra }
});

const BODY_READ_TIMEOUT = Symbol("body read timeout");
const cancelBestEffort = target => {
  try {
    const pending = target && typeof target.cancel === "function" ? target.cancel() : null;
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {}
};

/** Parse one JSON request without buffering an arbitrarily large inbound body first. */
export async function boundedJsonBody(request, limit) {
  if (!request || !Number.isSafeInteger(limit) || limit < 1 || !request.body || typeof request.body.getReader !== "function") return null;
  const declared = request.headers && request.headers.get("content-length");
  if (declared !== null && (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > limit)) {
    cancelBestEffort(request.body);
    return null;
  }
  let reader;
  try { reader = request.body.getReader(); }
  catch { cancelBestEffort(request.body); return null; }
  const bytes = new Uint8Array(limit);
  let size = 0;
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => {
      cancelBestEffort(reader);
      resolve(BODY_READ_TIMEOUT);
    }, INBOUND_BODY_TIMEOUT_MS);
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part === BODY_READ_TIMEOUT) return null;
      if (!part || part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > limit - size) {
        cancelBestEffort(reader);
        return null;
      }
      bytes.set(part.value, size);
      size += part.value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } catch {
    cancelBestEffort(reader);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (path === "/api/identity") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "cache-control": "no-store",
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "content-type"
          }
        });
      }
      if (request.method !== "POST") return identityJson({ ok: false, why: "method" }, 405, { allow: "POST, OPTIONS" });
      const mediaType = String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") return identityJson({ ok: false, why: "media_type" }, 415);
      if (!identityAllowed(Date.now(), configuredPerSecond(env.IDENTITY_PER_SECOND, env.TAIL_PER_SECOND))) {
        return identityJson({ ok: false, why: "rate_limited" }, 429);
      }
      const body = await boundedJsonBody(request, IDENTITY_BODY_LIMIT);
      const input = identityInputOf(body);
      if (!input) return identityJson({ ok: false, why: "shape" }, 400);
      const stub = watchStub(env);
      if (!stub) return identityJson({ ok: false, why: "corpus_unavailable" }, 503);
      try {
        const response = await stub.fetch("https://watch/identity", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input)
        });
        if (![200, 400, 503].includes(response.status)) return identityJson({ ok: false, why: "corpus_unavailable" }, 503);
        return new Response(response.body, { status: response.status, headers: identityHeaders });
      } catch {
        return identityJson({ ok: false, why: "corpus_unavailable" }, 503);
      }
    }

    if (path === "/api/telegram") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const given = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!sameSecret(given, env.TELEGRAM_WEBHOOK_SECRET)) return new Response(null, { status: 401 });
      const update = await boundedJsonBody(request, TELEGRAM_UPDATE_BODY_LIMIT);
      if (!update) return new Response(null, { status: 400 });
      const updateId = telegramUpdateIdOf(update && update.update_id);
      if (updateId === null) return new Response(null, { status: 400 });
      const command = telegramCommandClaimOf(update, env.BOT_USERNAME);
      const updates = telegramUpdateDep(env);
      if (!updates) return new Response(null, { status: 503 });
      const runnable = command.known && (command.owner !== null || command.service === true);
      const claim = await updates.claim(updateId, command.owner, command.metered, runnable);
      if (claim === null) return new Response(null, { status: 503 });
      if (!claim.pending) return new Response(null, { status: 200 });
      // Render once into the durable response ledger, then acknowledge only after every action is accepted.
      // A Bot API refusal returns 503; Telegram's retry resumes the stored words without spending the command
      // bucket or running the handler again. The external-send/ledger boundary remains intentionally at-least-once.
      return new Response(null, { status: await deliverTelegramUpdate(updateId, update, claim, updates, env) ? 200 : 503 });
    }

    if (path === "/api/hold") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (request.headers.get("Origin") !== T.HOLDER_ORIGIN) return new Response(null, { status: 403 });
      const mediaType = String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (mediaType !== "application/json") return new Response(null, { status: 415 });
      if (!holdAllowed(Date.now(), configuredPerSecond(env.HOLD_PER_SECOND, env.TAIL_PER_SECOND))) {
        return json({ ok: false, why: "rate_limited" }, 429);
      }
      return await hold(request, env, ctx);
    }

    if (path === "/api/tail") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const stub = watchStub(env);
      if (!stub) return json({ ok: false, why: "no watcher" }, 503);
      if (!tailAllowed(Date.now(), configuredPerSecond(env.TAIL_PER_SECOND))) return new Response(null, { status: 429 });
      try {
        // The object owns cursor validation and page consistency. Forward the one query intact and stream its
        // bounded page instead of duplicating the JSON in this isolate with r.text(). Machine-readable cursor,
        // reset and capacity failures stay visible to clients rather than collapsing to an opaque 503.
        const r = await stub.fetch("https://watch/tail" + url.search);
        const seconds = publicCacheSeconds(env.TAIL_CACHE_MS);
        return new Response(request.method === "HEAD" ? null : r.body, {
          status: r.status,
          headers: {
            "content-type": r.headers.get("content-type") || "application/json",
            // the same few seconds the object holds its answer for, so an edge cache and the object agree
            "cache-control": r.ok ? "public, max-age=" + seconds : "no-store",
            "access-control-allow-origin": "*"
          }
        });
      } catch {
        return json({ ok: false, why: "no tail" }, 503);
      }
    }

    if (path === "/api/wall") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const stub = watchStub(env);
      if (!stub) return json({ ok: false, why: "no_watcher" }, 503);
      if (!wallAllowed(Date.now(), configuredPerSecond(env.WALL_PER_SECOND, env.TAIL_PER_SECOND))) return json({ ok: false, why: "rate_limited" }, 429);
      try {
        const r = await stub.fetch("https://watch/wall" + url.search);
        if (!r.ok) {
          const failure = await r.json().catch(() => null);
          const why = failure && typeof failure.why === "string" && /^[a-z_]{1,32}$/.test(failure.why) ? failure.why : "no_wall";
          const status = r.status === 400 || r.status === 409 ? r.status : 503;
          return json({ ok: false, why }, status);
        }
        const body = await r.text();
        const seconds = publicCacheSeconds(env.TAIL_CACHE_MS);
        return new Response(body, {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=" + seconds,
            "access-control-allow-origin": "*"
          }
        });
      } catch {
        return json({ ok: false, why: "no_wall" }, 503);
      }
    }

    if (path === "/api/deployer") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const stub = watchStub(env);
      if (!stub) return json({ ok: false, why: "no_watcher" }, 503);
      if (!historyAllowed(Date.now(), configuredPerSecond(env.HISTORY_PER_SECOND, env.TAIL_PER_SECOND))) return json({ ok: false, why: "rate_limited" }, 429);
      try {
        const r = await stub.fetch("https://watch/deployer" + url.search);
        if (!r.ok) {
          const failure = await r.json().catch(() => null);
          const why = failure && typeof failure.why === "string" && /^[a-z_]{1,32}$/.test(failure.why) ? failure.why : "no_history";
          return json({ ok: false, why }, r.status === 400 ? 400 : r.status === 429 ? 429 : 503);
        }
        const body = await r.text();
        const seconds = publicCacheSeconds(env.TAIL_CACHE_MS);
        return new Response(body, {
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=" + seconds,
            "access-control-allow-origin": "*"
          }
        });
      } catch {
        return json({ ok: false, why: "no_history" }, 503);
      }
    }

    return new Response(null, { status: 404 });
  },

  /**
   * The cron. One minute is the shortest Cloudflare allows, which is why it is a watchdog and not either loop.
   *
   * Both objects get the same question, and both answer it themselves. The feed's watchdog says a gap out loud
   * in the room; the watcher's counts it and shows it in /rules, to the people it costs.
   */
  async scheduled(event, env, ctx) {
    const tape = tapeStub(env);
    if (tape) ctx.waitUntil(tape.fetch("https://tape/watchdog").catch(() => {}));
    const watch = watchStub(env);
    if (watch) ctx.waitUntil(watch.fetch("https://watch/watchdog").catch(() => {}));
  }
};

async function deliverTelegramUpdate(updateId, update, initial, updates, env) {
  let state = initial;
  if (state.actions === null) {
    if (state.render !== true) return false;
    let actions;
    try { actions = await handleUpdate(update, { env, kv: env.SESSIONS, nonces: nonceDep(env, updateId), tape: tapeDep(env), watch: watchDep(env, updateId) }); }
    catch { return false; }
    state = await updates.store(updateId, actions);
    if (!state) return false;
  }
  while (state.pending) {
    if (!Array.isArray(state.actions) || state.nextAction >= state.actions.length) return false;
    const sending = await updates.send(updateId, state.nextAction);
    if (!sending || sending.send !== true || !Number.isSafeInteger(sending.leaseUntil)) return false;
    const action = state.actions[state.nextAction];
    const delivery = await sendMessageResult(env, action.chat, action.text, action);
    if (delivery !== "accepted") {
      // An explicit Bot API refusal is safe to retry immediately. A lost/invalid success response is
      // ambiguous: keep the lease so another local request cannot duplicate a message Telegram may have sent.
      if (delivery === "refused") await updates.release(updateId, state.nextAction, sending.leaseUntil);
      return false;
    }
    state = await updates.advance(updateId, state.nextAction, sending.leaseUntil);
    if (!state) return false;
  }
  return true;
}

/**
 * The holder check. The page sends the mark, the address it connected and the signature over the sentence.
 * The worker recovers the address itself and only then reads a balance, so a wallet cannot be claimed by
 * anyone who did not sign for it.
 */
async function hold(request, env, ctx) {
  const body = await boundedJsonBody(request, HOLD_BODY_LIMIT);
  if (!body) return json({ ok: false, why: "shape" }, 400);
  const kv = env.SESSIONS;
  const nonces = nonceDep(env);
  if (!kv || !nonces) return json({ ok: false, why: "unreadable" }, 503);

  const token = await readToken(env);
  const result = await checkHold(env, kv, body, token, nonces);

  if (result.ok) {
    ctx.waitUntil(sendMessage(env, result.telegramId, T.SESSION_DONE));
    return json({ ok: true });
  }
  // the person is at the page, so the page is told which of its own inputs was refused, and the chat is told
  // only when there is a chat to tell
  if (result.telegramId && (result.why === "signature" || result.why === "below")) {
    const text = result.why === "signature" ? T.VERIFY_FAILED_SIGNATURE : T.NOT_A_HOLDER;
    ctx.waitUntil(sendMessage(env, result.telegramId, text));
  }
  const status = result.why === "nonce" || result.why === "shape" ? 400 : result.why === "unreadable" ? 503 : 200;
  return json({ ok: false, why: result.why }, status);
}

const json = (v, status = 200) => new Response(JSON.stringify(v), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});
