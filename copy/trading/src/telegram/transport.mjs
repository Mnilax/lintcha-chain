import { createHash, timingSafeEqual } from "node:crypto";

export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";
export const MAX_TELEGRAM_UPDATE_BYTES = 128 * 1024;

function digest(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest();
}

function decimalId(value, label) {
  const normalized = String(value ?? "");
  if (!/^-?[0-9]+$/.test(normalized)) throw new TypeError(`invalid Telegram ${label}`);
  return normalized;
}

function commandFromText(text, botUsername) {
  const match = /^\/([a-z][a-z0-9_]*)(?:@([a-z0-9_]{5,32}))?(?=\s|$)/i.exec(String(text ?? ""));
  if (!match) return "";
  if (match[2] && (!botUsername || match[2].toLowerCase() !== botUsername.toLowerCase())) return "";
  return `/${match[1].toLowerCase()}`;
}

export function verifyTelegramWebhookSecret(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string" || expected.length < 16) return false;
  return timingSafeEqual(digest(received), digest(expected));
}

export function parseTelegramWebhookBody(body, { maxBytes = MAX_TELEGRAM_UPDATE_BYTES } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""), "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new RangeError("invalid Telegram update size");
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("invalid Telegram update JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("invalid Telegram update");
  return parsed;
}

export function normalizeTelegramUpdate(update, { botUsername } = {}) {
  const updateId = decimalId(update?.update_id, "update id");
  if (update?.message) {
    const message = update.message;
    return Object.freeze({
      kind: "message",
      updateId,
      chatId: decimalId(message.chat?.id, "chat id"),
      chatType: String(message.chat?.type ?? "unknown"),
      userId: decimalId(message.from?.id, "user id"),
      command: commandFromText(message.text, botUsername),
    });
  }
  if (update?.callback_query) {
    const callback = update.callback_query;
    const data = String(callback.data ?? "");
    if (Buffer.byteLength(data, "utf8") === 0 || Buffer.byteLength(data, "utf8") > 64) {
      throw new RangeError("invalid Telegram callback data");
    }
    return Object.freeze({
      kind: "callback",
      updateId,
      callbackQueryId: String(callback.id ?? ""),
      chatId: decimalId(callback.message?.chat?.id, "chat id"),
      chatType: String(callback.message?.chat?.type ?? "unknown"),
      userId: decimalId(callback.from?.id, "user id"),
      callbackData: data,
    });
  }
  return Object.freeze({ kind: "unsupported", updateId });
}

export function telegramSendMessagePayload(chatId, response) {
  const text = String(response?.text ?? "");
  if (!text || text.length > 4096) throw new RangeError("invalid Telegram message text");
  const payload = { chat_id: decimalId(chatId, "chat id"), text };
  if (response?.reply_markup) payload.reply_markup = structuredClone(response.reply_markup);
  return Object.freeze(payload);
}

export class TelegramBotTransport {
  constructor({ enabled = false, token, fetchImpl = globalThis.fetch } = {}) {
    this.enabled = enabled === true;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async sendMessage(chatId, response) {
    if (!this.enabled) throw new Error("TELEGRAM_TRANSPORT_DISABLED");
    if (typeof this.token !== "string" || !/^[0-9]{6,15}:[A-Za-z0-9_-]{20,}$/.test(this.token)) {
      throw new Error("TELEGRAM_CONFIGURATION_INVALID");
    }
    if (typeof this.fetchImpl !== "function") throw new Error("TELEGRAM_TRANSPORT_UNAVAILABLE");
    const payload = telegramSendMessagePayload(chatId, response);
    let result;
    try {
      result = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("TELEGRAM_DELIVERY_FAILED");
    }
    if (!result?.ok) throw new Error("TELEGRAM_DELIVERY_FAILED");
    return { delivered: true };
  }
}
