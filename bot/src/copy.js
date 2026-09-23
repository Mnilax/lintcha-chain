// The Lintcha Copy seam, Core side. Copy is a separate Worker with its own database, secrets and origin; the
// only things Core knows are a shared HMAC secret (staged as a secret, never in this file), the Copy Worker
// (a service binding or an HTTPS URL) and the exact Copy origin for Mini App buttons. With any of the three
// absent, `/copy` and Copy callbacks stay silent, `/start copy_site` gets Core's ordinary /start answer, and nothing else in Core changes.
//
// What crosses the seam is decided in ./copy-gateway.js, vendored byte-for-byte from the Copy repository:
// a signed minimal identity envelope out, a validated text-plus-namespaced-buttons reply back. The bot token
// never leaves this Worker, and the raw Telegram update never enters Copy.

import { routeCopyUpdate, drainCopyOutbox, GATEWAY_TEXTS } from "./copy-gateway.js";
import { botUsernameOf } from "./config.js";

const COPY_TIMEOUT_MS = 8000;
const MINIMUM_SECRET_BYTES = 32;

function exactOrigin(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch { return null; }
}

/** Null unless every piece of the seam is configured; a half-configured Copy is a disabled Copy. */
export function copyConfigOf(env) {
  if (!env) return null;
  const secret = env.COPY_GATEWAY_SECRET;
  const origin = exactOrigin(env.COPY_APP_ORIGIN);
  const service = env.COPY_SERVICE && typeof env.COPY_SERVICE.fetch === "function" ? env.COPY_SERVICE : null;
  const serviceUrl = service ? null : exactOrigin(env.COPY_SERVICE_URL);
  if (typeof secret !== "string" || new TextEncoder().encode(secret).length < MINIMUM_SECRET_BYTES || !origin || (!service && !serviceUrl)) return null;
  return Object.freeze({ secret, origin, service, serviceUrl, apiBase: `${serviceUrl || origin}/api/copy` });
}

async function copyPost(config, path, signed) {
  const request = new Request(`${config.apiBase}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
  const response = config.service ? await config.service.fetch(request) : await fetch(request);
  const body = await response.json().catch(() => null);
  if (!body || body.ok !== true) throw new Error(body && typeof body.why === "string" ? body.why.slice(0, 64) : `COPY_HTTP_${response.status}`);
  return body;
}

/** The client the gateway talks to. Two calls, both signed, both JSON, both bounded by the gateway's timeout. */
export function copyClientOf(config) {
  return Object.freeze({
    handle: async (signed) => (await copyPost(config, "gateway", signed)).response,
    drain: async (signed) => (await copyPost(config, "gateway/outbox", signed)).rows,
  });
}

/**
 * Routes one update through the seam. Returns null when the update is not for Copy (Core carries on), or the
 * list of actions Core should perform. A Copy failure yields the gateway's fixed unavailable line; it never throws.
 */
export async function copyActionsFor(update, env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const config = copyConfigOf(env);
  const routed = await routeCopyUpdate({
    update, nowSeconds,
    serviceSecret: config ? config.secret : null,
    copyClient: config ? copyClientOf(config) : null,
    copyAppOrigin: config ? config.origin : "https://copy.invalid",
    botUsername: botUsernameOf(env && env.BOT_USERNAME) || "lintchabot",
    timeoutMs: COPY_TIMEOUT_MS,
  });
  if (!routed.handled) return null;
  // Copy is not wired up. The site's deep link is still a /start, so Core answers it with its own status text
  // rather than leaving a visitor from the site's main button with no reply; /copy and Copy buttons stay silent.
  if (!config && update && update.message && /^\/start(?:@\S+)?\s/i.test(String(update.message.text || "").trim())) return null;
  if (!config || !routed.response) return [];                                            // Copy is not wired up: silence, like an unknown command
  const actions = [];
  if (update && update.callback_query && typeof update.callback_query.id === "string") actions.push({ kind: "answer-callback", callbackQueryId: update.callback_query.id });
  if (routed.chatId !== null && routed.chatId !== undefined) {
    actions.push({ kind: "send", chat: routed.chatId, text: routed.response.text, reply_markup: routed.response.reply_markup, escape: true });
    const msg = update && update.message;
    if (routed.response.text !== GATEWAY_TEXTS.UNAVAILABLE && msg && msg.chat && msg.chat.type === "private" &&
        (/^\/copy(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(String(msg.text || "")) ||
         /^\/start(?:@[A-Za-z0-9_]+)?\s+copy_site(?:\s|$)/i.test(String(msg.text || "")))) {
      actions.push({ kind: "send-photo", chat: routed.chatId, photo: "copy" });
      actions.push({ kind: "send", chat: routed.chatId,
        text: "Send a public wallet address to save it; /watches to view. BUY trade alerts are not active yet. Saved addresses expire up to 30 days after the last change." });
    }
  }
  return actions;
}

/** Cron hook: deliver the lines Copy queued (a review is ready, a notification). At-least-once by contract. */
export async function drainCopyOutboxFor(env, send, nowSeconds = Math.floor(Date.now() / 1000)) {
  const config = copyConfigOf(env);
  if (!config) return { sent: 0, failed: 0, reason: "COPY_DISABLED" };
  return drainCopyOutbox({ serviceSecret: config.secret, nowSeconds, copyAppOrigin: config.origin, copyClient: copyClientOf(config), send, timeoutMs: COPY_TIMEOUT_MS });
}
