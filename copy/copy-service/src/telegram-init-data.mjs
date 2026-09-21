/**
 * Telegram Mini App init data, validated the third-party way: an Ed25519 signature Telegram attaches to every
 * initData (`signature` field) that anyone can verify with Telegram's published public key. No bot token is
 * involved, which is the only acceptable way for the Copy service to learn who opened the sheet.
 *
 * Data-check string: "<bot_id>:WebAppData\n" + every field except `hash` and `signature`, as "key=value",
 * sorted by key, joined with "\n". The bot id is public (numeric) and is configuration, not a secret.
 *
 * Public keys (hex) as published for third-party validation; production key confirmed against the tma.js
 * platform docs on 2026-09-20 and to be re-checked against core.telegram.org before public resume (see CP15 report).
 */
export const TELEGRAM_THIRD_PARTY_PUBLIC_KEYS = Object.freeze({
  production: "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d",
  test: "40055058a4ee38156a06562e52eece92a771bcd8346a8c4615cb7376eddf72ec",
});

function hexBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("INVALID_TELEGRAM_PUBLIC_KEY");
  return Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
}

function base64urlBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function telegramDataCheckString(pairs, botId) {
  const lines = [...pairs].filter(([key]) => key !== "hash" && key !== "signature").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${key}=${value}`);
  return `${botId}:WebAppData\n${lines.join("\n")}`;
}

export class TelegramInitDataVerifier {
  constructor({ botId, environment = "production", publicKeyHex = null, maxAgeSeconds = 3600, subtle = globalThis.crypto?.subtle }) {
    if (!/^\d{1,20}$/.test(String(botId || ""))) throw new Error("COPY_TELEGRAM_BOT_ID_REQUIRED");
    if (!subtle) throw new Error("WEBCRYPTO_REQUIRED");
    this.botId = String(botId);
    this.maxAgeSeconds = maxAgeSeconds;
    this.subtle = subtle;
    this.publicKeyBytes = hexBytes(publicKeyHex || TELEGRAM_THIRD_PARTY_PUBLIC_KEYS[environment]);
    this.key = null;
  }

  async #key() {
    if (!this.key) this.key = await this.subtle.importKey("raw", this.publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
    return this.key;
  }

  /** Returns the verified Telegram identity or throws. Never returns anything it did not verify. */
  async verify(initData, nowSeconds) {
    if (typeof initData !== "string" || initData.length === 0 || initData.length > 8192) throw new Error("INVALID_INIT_DATA");
    const params = new URLSearchParams(initData);
    const pairs = [...params.entries()];
    const signature = params.get("signature");
    const authDate = Number(params.get("auth_date"));
    if (!signature || !params.get("hash") || !Number.isSafeInteger(authDate)) throw new Error("INVALID_INIT_DATA");
    let signatureBytes;
    try { signatureBytes = base64urlBytes(signature); } catch { throw new Error("INVALID_INIT_DATA_SIGNATURE"); }
    if (signatureBytes.length !== 64) throw new Error("INVALID_INIT_DATA_SIGNATURE");
    const message = new TextEncoder().encode(telegramDataCheckString(pairs, this.botId));
    const valid = await this.subtle.verify({ name: "Ed25519" }, await this.#key(), signatureBytes, message);
    if (!valid) throw new Error("INVALID_INIT_DATA_SIGNATURE");
    if (Math.abs(nowSeconds - authDate) > this.maxAgeSeconds) throw new Error("STALE_INIT_DATA");
    let user;
    try { user = JSON.parse(params.get("user") || "null"); } catch { throw new Error("INVALID_INIT_DATA_USER"); }
    if (!user || !Number.isSafeInteger(user.id)) throw new Error("INVALID_INIT_DATA_USER");
    return Object.freeze({
      telegramUserId: String(user.id),
      authDate,
      queryId: params.get("query_id") || null,
      startParam: params.get("start_param") || null,
      languageCode: typeof user.language_code === "string" ? user.language_code.slice(0, 16) : null,
    });
  }
}
