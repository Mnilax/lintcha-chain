// The worker. Two routes and a cron, and nothing else answers.
//
//   POST /api/telegram   the webhook. Every update must carry X-Telegram-Bot-Api-Secret-Token matching the
//                        TELEGRAM_WEBHOOK_SECRET secret. A wrong or missing header gets four hundred and one
//                        with no body: no hint about what was wrong, no echo of what was sent.
//   POST /api/hold       the holder check, from the /hold page on the site. Same origin, which is why the
//                        vendored connect-src 'self' needs no editing.
//   scheduled            once a minute, the watchdog. It does not read the chain itself; it asks the feed
//                        whether a round happened recently and wakes it when one did not.
//
// Anything else under this worker's routes gets four hundred and four. The site's own pages are not touched:
// the route is /api/*, and the root stays with the assets worker.
//
// The webhook path is this worker's choice, not Telegram's. Vlad sets the webhook himself from a browser, and
// that command carries the bot token, so it is not written here, not in the README and not in the repository.

import { handleUpdate } from "./router.js";
import { perform, sendMessage } from "./telegram.js";
import { checkHold } from "./verify.js";
import { readToken } from "./chain.js";
import * as T from "./texts.js";
import { Tape } from "./tape.js";

export { Tape };

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

/** What the router is given for /top and /stats: the object, or null when there is no binding. */
function tapeDep(env) {
  const stub = tapeStub(env);
  if (!stub) return null;
  const ask = async path => {
    try {
      const r = await stub.fetch("https://tape/" + path);
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  return { stats: () => ask("stats"), top: () => ask("top") };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (path === "/api/telegram") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const given = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!sameSecret(given, env.TELEGRAM_WEBHOOK_SECRET)) return new Response(null, { status: 401 });
      let update;
      try { update = await request.json(); } catch { return new Response(null, { status: 400 }); }
      // Telegram retries anything that is not a two hundred, so the answer goes out at once and the work
      // finishes after it
      ctx.waitUntil(handleAndSend(update, env));
      return new Response(null, { status: 200 });
    }

    if (path === "/api/hold") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      return await hold(request, env, ctx);
    }

    return new Response(null, { status: 404 });
  },

  /** The cron. One minute is the shortest Cloudflare allows, which is why it is a watchdog and not the feed. */
  async scheduled(event, env, ctx) {
    const stub = tapeStub(env);
    if (!stub) return;
    ctx.waitUntil(stub.fetch("https://tape/watchdog").catch(() => {}));
  }
};

async function handleAndSend(update, env) {
  try {
    const actions = await handleUpdate(update, { env, kv: env.SESSIONS, tape: tapeDep(env) });
    await perform(env, actions);
  } catch {
    // a thrown handler must not turn into a retry storm; the update is dropped and the room is told nothing
  }
}

/**
 * The holder check. The page sends the mark, the address it connected and the signature over the sentence.
 * The worker recovers the address itself and only then reads a balance, so a wallet cannot be claimed by
 * anyone who did not sign for it.
 */
async function hold(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, why: "shape" }, 400); }
  const kv = env.SESSIONS;
  if (!kv) return json({ ok: false, why: "unreadable" }, 503);

  const token = await readToken(env);
  const result = await checkHold(env, kv, body, token);

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
