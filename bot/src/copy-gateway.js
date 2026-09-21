// Platform primitives only (WebCrypto, TextEncoder): this file is vendored unchanged into the Core Worker as
// bot/src/copy-gateway.js, where no node builtin may be imported.
const encoder = new TextEncoder();

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function secretUsable(secret) { return typeof secret === "string" && encoder.encode(secret).length >= 32; }

const COPY_CALLBACK = /^(?:copy|trade|sell)\.[a-z0-9._-]{1,96}$/;

/** Fixed Core-side wording. The Copy service cannot change these; they are what the user sees when Copy is unreachable. */
export const GATEWAY_TEXTS = Object.freeze({
  PRIVATE_ONLY: "Lintcha copy-trading answers only in a private chat with @lintchabot.",
  UNAVAILABLE: "Lintcha copy-trading is temporarily unavailable. Nothing was signed or submitted. Lintcha Core commands keep working.",
  DISABLED: "Copy-trading is not enabled in Lintcha yet. Lintcha Core commands keep working.",
});

function clean(value, max = 96) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").slice(0, max);
}

export function copyRoute(update, botUsername = "lintchabot") {
  const message = update?.message;
  const callback = update?.callback_query;
  const text = String(message?.text || "").trim();
  const parts = text.split(/\s+/);
  const [command, suffix] = parts[0].toLowerCase().split("@");
  if (command === "/copy" && (!suffix || suffix === String(botUsername).toLowerCase())) return "COPY_COMMAND";
  if (command === "/start" && (!suffix || suffix === String(botUsername).toLowerCase()) && parts.length === 2 && parts[1] === "copy_site") return "COPY_COMMAND";
  if (callback && COPY_CALLBACK.test(String(callback.data || ""))) return "COPY_CALLBACK";
  return null;
}

/** Null when the update is not for Copy; `{ privateRequired: true }` when it is but arrived outside a private chat. */
export function sanitizedCopyEnvelope(update, nowSeconds, botUsername = "lintchabot") {
  const route = copyRoute(update, botUsername);
  if (!route) return null;
  const text = String(update?.message?.text || "").trim();
  const source = update.callback_query || update.message;
  const chat = source?.message?.chat || source?.chat;
  const user = source?.from;
  if (!Number.isSafeInteger(update.update_id) || !Number.isSafeInteger(user?.id)) throw new Error("COPY_IDENTITY_REQUIRED");
  if (chat?.type !== "private" || !Number.isSafeInteger(chat?.id)) return Object.freeze({ privateRequired: true, route, chatId: chat?.id ?? null });
  const envelope = {
    schema: "lintcha.copy.gateway.v1",
    route,
    updateId: String(update.update_id),
    telegramUserId: String(user.id),
    privateChatId: String(chat.id),
    locale: clean(user.language_code || "", 16),
    receivedAt: nowSeconds,
  };
  if (/^\/start(?:@[^\s]+)?\s+copy_site$/.test(text.toLowerCase())) envelope.referralSource = "SITE";
  if (route === "COPY_CALLBACK") envelope.callbackData = clean(update.callback_query.data);
  return Object.freeze(envelope);
}

export async function signGatewayEnvelope(envelope, secret) {
  if (!secretUsable(secret)) throw new Error("COPY_GATEWAY_SECRET_REQUIRED");
  const body = JSON.stringify(envelope);
  return Object.freeze({ body, signature: await hmacHex(secret, body) });
}

export function validateCopyResponse(response, copyAppOrigin) {
  if (!response || typeof response.text !== "string" || !response.text.trim() || response.text.length > 4096) throw new Error("INVALID_COPY_RESPONSE");
  const buttons = response.inlineKeyboard || [];
  if (!Array.isArray(buttons) || buttons.length > 8 || buttons.some((row) => !Array.isArray(row) || row.length > 4)) throw new Error("INVALID_COPY_RESPONSE");
  for (const row of buttons) for (const button of row) {
    if (!button || typeof button.text !== "string") throw new Error("INVALID_COPY_RESPONSE");
    if (Boolean(button.callbackData) === Boolean(button.webAppUrl)) throw new Error("INVALID_COPY_RESPONSE");
    if (button.callbackData && !COPY_CALLBACK.test(button.callbackData)) throw new Error("COPY_CALLBACK_NAMESPACE_REQUIRED");
    if (button.webAppUrl) {
      let url;
      try { url = new URL(button.webAppUrl); } catch { throw new Error("COPY_APP_ORIGIN_MISMATCH"); }
      if (url.origin !== copyAppOrigin || !url.pathname.startsWith("/copy/") || url.username || url.password) throw new Error("COPY_APP_ORIGIN_MISMATCH");
    }
  }
  return Object.freeze({
    text: response.text,
    reply_markup: buttons.length ? { inline_keyboard: buttons.map((row) => row.map((button) => button.webAppUrl
      ? { text: clean(button.text, 64), web_app: { url: button.webAppUrl } }
      : { text: clean(button.text, 64), callback_data: button.callbackData })) } : undefined,
  });
}

/**
 * Routes one Telegram update. Anything that is not `/copy`, the exact `/start copy_site` deep link, or a namespaced Copy callback returns `handled: false`
 * and stays in Core. A Copy-side failure never propagates into the Core webhook: the user gets a fixed
 * unavailable message, the update is acknowledged, and Core never retries on Copy's behalf.
 */
export async function routeCopyUpdate({ update, nowSeconds, serviceSecret, copyClient, copyAppOrigin, botUsername = "lintchabot", timeoutMs = 8_000, onFailure = () => {} }) {
  let envelope;
  try { envelope = sanitizedCopyEnvelope(update, nowSeconds, botUsername); }
  catch { return Object.freeze({ handled: true, response: null, chatId: null }); }   // a Copy update without a usable identity: silence
  if (!envelope) return Object.freeze({ handled: false });
  if (envelope.privateRequired) return Object.freeze({ handled: true, response: validateCopyResponse({ text: GATEWAY_TEXTS.PRIVATE_ONLY }, copyAppOrigin), chatId: envelope.chatId });
  if (!copyClient || !serviceSecret) return Object.freeze({ handled: true, response: validateCopyResponse({ text: GATEWAY_TEXTS.DISABLED }, copyAppOrigin), chatId: Number(envelope.privateChatId) });
  let response;
  try {
    const signed = await signGatewayEnvelope(envelope, serviceSecret);
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("COPY_SERVICE_TIMEOUT")), timeoutMs); });
    try { response = validateCopyResponse(await Promise.race([copyClient.handle(signed), timeout]), copyAppOrigin); }
    finally { clearTimeout(timer); }
  } catch (error) {
    onFailure({ reason: String(error?.message || "COPY_SERVICE_FAILURE").slice(0, 64), updateId: envelope.updateId });
    response = validateCopyResponse({ text: GATEWAY_TEXTS.UNAVAILABLE }, copyAppOrigin);
  }
  return Object.freeze({ handled: true, response, chatId: Number(envelope.privateChatId), userId: Number(envelope.telegramUserId) });
}

/**
 * Proactive lines (a BUY review is ready, a notification) cannot be sent by the Copy service, which holds no
 * bot token. Core drains the Copy outbox over the same signed channel and delivers each row itself, after the
 * same response validation as replies. Sends are at-least-once by design: an ack is only recorded for rows the
 * Bot API accepted, and a row that keeps failing is retired by the Copy side after its attempt budget.
 */
export async function drainCopyOutbox({ serviceSecret, nowSeconds, copyAppOrigin, copyClient, send, limit = 10, requestId = null, timeoutMs = 8_000 }) {
  if (!secretUsable(serviceSecret)) throw new Error("COPY_GATEWAY_SECRET_REQUIRED");
  const base = requestId || randomHex(16);
  const id = (suffix) => `${base}${suffix}`;
  const sign = async (payload) => { const body = JSON.stringify(payload); return { body, signature: await hmacHex(serviceSecret, body) }; };
  const call = async (payload) => {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("COPY_SERVICE_TIMEOUT")), timeoutMs); });
    try { return await Promise.race([copyClient.drain(await sign(payload)), timeout]); } finally { clearTimeout(timer); }
  };
  let rows;
  try { rows = await call({ schema: "lintcha.copy.outbox.v1", requestId: id("00"), issuedAt: nowSeconds, limit, ack: [], fail: [] }); }
  catch (error) { return Object.freeze({ sent: 0, failed: 0, reason: String(error?.message || "COPY_SERVICE_FAILURE").slice(0, 64) }); }
  if (!Array.isArray(rows)) return Object.freeze({ sent: 0, failed: 0, reason: "INVALID_OUTBOX" });
  const ack = [];
  const fail = [];
  for (const row of rows.slice(0, limit)) {
    let response;
    try { response = validateCopyResponse(row.response, copyAppOrigin); } catch (error) { fail.push({ id: String(row.id), reason: error.message }); continue; }
    if (!/^-?\d{1,20}$/.test(String(row.privateChatId || ""))) { fail.push({ id: String(row.id), reason: "INVALID_CHAT" }); continue; }
    const delivery = await send({ chatId: String(row.privateChatId), response });
    if (delivery === "accepted") ack.push(String(row.id));
    else if (delivery === "refused") fail.push({ id: String(row.id), reason: "BOT_API_REFUSED" });
    // "retryable" (or anything ambiguous) is left leased: the Copy side re-leases it after the lease expires.
  }
  if (ack.length || fail.length) {
    try { await call({ schema: "lintcha.copy.outbox.v1", requestId: id("01"), issuedAt: nowSeconds, limit: 0, ack, fail }); }
    catch { /* the lease expiry re-delivers; at-least-once is the documented contract */ }
  }
  return Object.freeze({ sent: ack.length, failed: fail.length });
}
