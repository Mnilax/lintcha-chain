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
/** Inline cards are intentionally a small palette, not an unbounded Bot API passthrough. */
export const TELEGRAM_INLINE_RESULT_LIMIT = 8;
export const TELEGRAM_INLINE_ACTION_LIMIT = 16 * 1024;

/** the three characters HTML cares about */
export const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttribute = s => esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** monospace, for an address or an amount */
export const code = s => "<code>" + esc(s) + "</code>";

/** a link whose text is its own words, never the raw url twice */
export const link = (text, href) => '<a href="' + escAttribute(href) + '">' + esc(text) + "</a>";

const plainObject = value => !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => plainObject(value) && Object.keys(value).length === keys.length &&
  Object.keys(value).every(key => keys.includes(key));
const charsWithin = (value, min, max) => typeof value === "string" && value.length >= min &&
  Array.from(value).length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const bytesWithin = (value, min, max) => typeof value === "string" &&
  new TextEncoder().encode(value).byteLength >= min && new TextEncoder().encode(value).byteLength <= max;
const httpsUrl = value => {
  if (!bytesWithin(value, 1, 2048)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};

/**
 * Canonical durable inline action. The router cannot smuggle arbitrary Bot API fields through this boundary:
 * the transport below constructs every Telegram object from this short, exact schema.
 */
export function inlineActionOf(value) {
  const actionKeys = ["kind", "inlineQueryId", "cacheTime", "results", "buttonText", "buttonWebAppUrl"];
  if (!exactKeys(value, actionKeys) || value.kind !== "answer-inline" ||
      !bytesWithin(value.inlineQueryId, 1, 256) || !Number.isSafeInteger(value.cacheTime) ||
      value.cacheTime < 0 || value.cacheTime > 300 || !Array.isArray(value.results) ||
      value.results.length > TELEGRAM_INLINE_RESULT_LIMIT || !charsWithin(value.buttonText, 1, 64)) return null;
  const buttonWebAppUrl = httpsUrl(value.buttonWebAppUrl);
  if (!buttonWebAppUrl) return null;

  const ids = new Set();
  const results = [];
  const resultKeys = ["id", "title", "description", "text", "openText", "openUrl"];
  for (const raw of value.results) {
    if (!exactKeys(raw, resultKeys) || typeof raw.id !== "string" || !/^[a-z0-9_-]{1,64}$/.test(raw.id) || ids.has(raw.id) ||
        !charsWithin(raw.title, 1, 256) || !charsWithin(raw.description, 1, 512) ||
        !charsWithin(raw.text, 1, TELEGRAM_TEXT_LIMIT) || !charsWithin(raw.openText, 1, 64)) return null;
    const openUrl = httpsUrl(raw.openUrl);
    if (!openUrl) return null;
    ids.add(raw.id);
    results.push({ id: raw.id, title: raw.title, description: raw.description, text: raw.text, openText: raw.openText, openUrl });
  }
  const action = {
    kind: "answer-inline",
    inlineQueryId: value.inlineQueryId,
    cacheTime: value.cacheTime,
    results,
    buttonText: value.buttonText,
    buttonWebAppUrl
  };
  try {
    return new TextEncoder().encode(JSON.stringify(action)).byteLength <= TELEGRAM_INLINE_ACTION_LIMIT ? action : null;
  } catch { return null; }
}

/** One bounded Bot API call, retaining enough refusal detail for inline-query expiry to be terminal. */
async function botApiCallResult(env, method, body) {
  const token = env && env.TELEGRAM_BOT_TOKEN;
  if (!token || typeof method !== "string" || !plainObject(body)) return { state: "refused" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const r = await fetch(API + token + "/" + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (controller.signal.aborted) { cancelBody(r); return { state: "uncertain" }; }
    if (!r.ok) {
      const status = Number.isSafeInteger(r.status) ? r.status : null;
      cancelBody(r);
      return { state: "refused", status };
    }
    const answer = await boundedJson(r, TELEGRAM_RESPONSE_LIMIT, controller.signal);
    if (controller.signal.aborted) return { state: "uncertain" };
    if (plainObject(answer) && answer.ok === true) return { state: "accepted" };
    if (plainObject(answer) && answer.ok === false) {
      return { state: "refused", errorCode: Number.isSafeInteger(answer.error_code) ? answer.error_code : null };
    }
    return { state: "uncertain" };
  } catch {
    return { state: "uncertain" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One message, with a tri-state result. A valid Bot API `ok: true` is accepted, an explicit HTTP/API rejection
 * is refused, and a lost or malformed success response is uncertain because Telegram may already have posted.
 */
export async function sendMessageResult(env, chatId, text, options = {}) {
  if (!env || !env.TELEGRAM_BOT_TOKEN || !chatId || typeof text !== "string" || text.length > TELEGRAM_TEXT_LIMIT) return "refused";
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: options.preview !== true },
    disable_notification: options.quiet === true
  };
  if (options.replyTo) body.reply_parameters = { message_id: options.replyTo, allow_sending_without_reply: true };
  // Only the Lintcha Copy seam sets these: its text is plain and is escaped here, and its keyboard was already
  // constrained to namespaced callbacks and the exact Copy origin before it reached this Worker.
  if (options.escape === true) body.text = esc(text);
  if (options.reply_markup && typeof options.reply_markup === "object") body.reply_markup = options.reply_markup;
  return (await botApiCallResult(env, "sendMessage", body)).state;
}

/**
 * Dismiss the spinner on a Lintcha Copy button. Answering the same callback id twice is harmless, a stale id is
 * terminal, and Telegram posts nothing on this call, so a retry can never duplicate a message.
 */
export async function answerCallbackQueryResult(env, value) {
  if (!env || !env.TELEGRAM_BOT_TOKEN || !value || !bytesWithin(value.callbackQueryId, 1, 256)) return "terminal";
  const { state, errorCode } = await botApiCallResult(env, "answerCallbackQuery", { callback_query_id: value.callbackQueryId });
  if (state === "accepted") return "accepted";
  if (state === "refused" && errorCode === 400) return "terminal";
  return "retryable";
}

/** Existing callers need only acceptance; command delivery additionally consumes the tri-state above. */
export async function sendMessage(env, chatId, text, options = {}) {
  return await sendMessageResult(env, chatId, text, options) === "accepted";
}

/**
 * Answer one inline query. A stale/invalid query id is terminal and is durably completed; transient failures
 * are retryable because answering the same query id again cannot create a duplicate chat message.
 */
export async function answerInlineQueryResult(env, value) {
  const action = inlineActionOf(value);
  if (!action) return "terminal";
  const body = {
    inline_query_id: action.inlineQueryId,
    results: action.results.map(result => ({
      type: "article",
      id: result.id,
      title: result.title,
      description: result.description,
      input_message_content: {
        message_text: result.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true }
      },
      reply_markup: { inline_keyboard: [[{ text: result.openText, url: result.openUrl }]] }
    })),
    cache_time: action.cacheTime,
    is_personal: false,
    button: { text: action.buttonText, web_app: { url: action.buttonWebAppUrl } }
  };
  const result = await botApiCallResult(env, "answerInlineQuery", body);
  if (result.state === "accepted") return "accepted";
  const refusal = result.status === null || result.status === undefined ? result.errorCode : result.status;
  if (result.state === "uncertain" || refusal === null || refusal === undefined || refusal === 408 || refusal === 429 || refusal >= 500) {
    return "retryable";
  }
  return "terminal";
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
    if (!a) continue;
    if (a.kind === "send" && await sendMessage(env, a.chat, a.text, a)) sent++;
    if (a.kind === "answer-inline" && await answerInlineQueryResult(env, a) === "accepted") sent++;
    if (a.kind === "answer-callback" && await answerCallbackQueryResult(env, a) === "accepted") sent++;
  }
  return sent;
}
