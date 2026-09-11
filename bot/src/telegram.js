// Sending, and the little markup the bot uses. HTML rather than MarkdownV2, because an address and a number
// need no escaping in HTML beyond three characters, while MarkdownV2 would have every underscore and full stop
// in a sentence escaped by hand and one miss would swallow a message.
//
// The bot token arrives as a secret named TELEGRAM_BOT_TOKEN. It is read from env at the moment of the call and
// never logged, never put in a URL that gets logged by this code, and never returned to a caller. No token,
// no secret and no example of either appears anywhere in this repository.

const API = "https://api.telegram.org/bot";
/** Telegram's sendMessage text ceiling. Pagination happens before actions reach this transport. */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** Bound the acknowledgement Telegram echoes; four message ceilings leave room for its message envelope. */
export const TELEGRAM_RESPONSE_LIMIT = TELEGRAM_TEXT_LIMIT * 4;
/** A Telegram request cannot hold a Durable Object delivery beat beyond the existing five-second I/O window. */
export const TELEGRAM_TIMEOUT_MS = 5000;

/** the three characters HTML cares about */
export const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttribute = s => esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** monospace, for an address or an amount */
export const code = s => "<code>" + esc(s) + "</code>";

/** a link whose text is its own words, never the raw url twice */
export const link = (text, href) => '<a href="' + escAttribute(href) + '">' + esc(text) + "</a>";

/**
 * One message, with a tri-state result. A valid Bot API `ok: true` is accepted, an explicit HTTP/API rejection
 * is refused, and a lost or malformed success response is uncertain because Telegram may already have posted.
 */
export async function sendMessageResult(env, chatId, text, options = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId || typeof text !== "string" || text.length > TELEGRAM_TEXT_LIMIT) return "refused";
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: options.preview !== true },
    disable_notification: options.quiet === true
  };
  if (options.replyTo) body.reply_parameters = { message_id: options.replyTo, allow_sending_without_reply: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const r = await fetch(API + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (controller.signal.aborted) { cancelBody(r); return "uncertain"; }
    if (!r.ok) { cancelBody(r); return "refused"; }
    const answer = await boundedJson(r, TELEGRAM_RESPONSE_LIMIT, controller.signal);
    if (controller.signal.aborted) return "uncertain";
    if (answer && typeof answer === "object" && !Array.isArray(answer) && answer.ok === true) return "accepted";
    if (answer && typeof answer === "object" && !Array.isArray(answer) && answer.ok === false) return "refused";
    return "uncertain";
  } catch {
    return "uncertain";
  } finally {
    clearTimeout(timer);
  }
}

/** Existing callers need only acceptance; command delivery additionally consumes the tri-state above. */
export async function sendMessage(env, chatId, text, options = {}) {
  return await sendMessageResult(env, chatId, text, options) === "accepted";
}

const cancelBestEffort = target => {
  try {
    const pending = target && typeof target.cancel === "function" ? target.cancel() : null;
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {}
};

const cancelBody = response => {
  if (response && response.body) cancelBestEffort(response.body);
};

async function boundedJson(response, limit, signal) {
  if (!response || !response.body || typeof response.body.getReader !== "function") return null;
  const declaredRaw = response.headers && response.headers.get("content-length");
  if (declaredRaw !== null && (!/^(?:0|[1-9]\d*)$/.test(declaredRaw) || Number(declaredRaw) > limit)) {
    cancelBody(response);
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
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > limit - size) {
        cancelBestEffort(reader);
        return null;
      }
      bytes.set(part.value, size);
      size += part.value.byteLength;
    }
    if (aborted) return null;
    if (declaredRaw !== null && Number(declaredRaw) !== size) return null;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } catch {
    cancelBestEffort(reader);
    return null;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Carry out what the router decided. The router returns plain objects and never sends anything itself, so every
 * command can be read in a test without a network and without a bot token.
 */
export async function perform(env, actions) {
  let sent = 0;
  for (const a of actions || []) {
    if (!a || a.kind !== "send") continue;
    if (await sendMessage(env, a.chat, a.text, a)) sent++;
  }
  return sent;
}
