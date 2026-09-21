import { createHmac, timingSafeEqual } from "node:crypto";

const BASE_KEYS = new Set(["schema", "route", "updateId", "telegramUserId", "privateChatId", "locale", "receivedAt", "callbackData", "referralSource"]);
export const COPY_CALLBACK = /^(?:copy|trade|sell)\.[a-z0-9._-]{1,96}$/;

/**
 * Replay store contract: `claim(updateId, expiresAt)` returns true exactly once per update id until
 * `expiresAt` (unix seconds). The in-memory version prunes by time and is the test adapter; production uses
 * the D1-backed store so a replay across isolates is still refused.
 */
export class MemoryReplayStore {
  constructor() { this.seen = new Map(); }
  async claim(updateId, expiresAt, nowSeconds) {
    for (const [key, until] of this.seen) if (until <= nowSeconds) this.seen.delete(key);
    if (this.seen.has(updateId)) return false;
    this.seen.set(updateId, expiresAt);
    return true;
  }
}

export class GatewayRequestVerifier {
  constructor({ secret, maxAgeSeconds = 30, replayStore = new MemoryReplayStore() }) {
    if (!secret || Buffer.byteLength(secret) < 32) throw new Error("COPY_GATEWAY_SECRET_REQUIRED");
    this.secret = secret;
    this.maxAgeSeconds = maxAgeSeconds;
    this.replayStore = replayStore;
  }

  /** Signature and shape checks are synchronous; the replay claim is the only async, durable step. */
  parse({ body, signature }, nowSeconds) {
    if (typeof body !== "string" || body.length > 4096 || !/^[0-9a-f]{64}$/i.test(signature || "")) throw new Error("INVALID_GATEWAY_SIGNATURE");
    const expected = createHmac("sha256", this.secret).update(body).digest();
    const actual = Buffer.from(signature, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("INVALID_GATEWAY_SIGNATURE");
    let envelope;
    try { envelope = JSON.parse(body); } catch { throw new Error("INVALID_GATEWAY_ENVELOPE"); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("INVALID_GATEWAY_ENVELOPE");
    if (Object.keys(envelope).some((key) => !BASE_KEYS.has(key))) throw new Error("NON_MINIMAL_GATEWAY_ENVELOPE");
    if (envelope.schema !== "lintcha.copy.gateway.v1" || !["COPY_COMMAND", "COPY_CALLBACK"].includes(envelope.route)) throw new Error("INVALID_GATEWAY_ENVELOPE");
    if (!/^\d{1,20}$/.test(envelope.updateId) || !/^-?\d{1,20}$/.test(envelope.telegramUserId) || !/^-?\d{1,20}$/.test(envelope.privateChatId)) throw new Error("INVALID_GATEWAY_IDENTITY");
    if (typeof envelope.locale !== "string" || envelope.locale.length > 16) throw new Error("INVALID_GATEWAY_ENVELOPE");
    if (envelope.referralSource !== undefined && (envelope.route !== "COPY_COMMAND" || envelope.referralSource !== "SITE")) throw new Error("INVALID_GATEWAY_ENVELOPE");
    if (!Number.isSafeInteger(envelope.receivedAt) || Math.abs(nowSeconds - envelope.receivedAt) > this.maxAgeSeconds) throw new Error("STALE_GATEWAY_ENVELOPE");
    if (envelope.route === "COPY_CALLBACK" && !COPY_CALLBACK.test(envelope.callbackData || "")) throw new Error("INVALID_COPY_CALLBACK");
    if (envelope.route === "COPY_COMMAND" && envelope.callbackData !== undefined) throw new Error("NON_MINIMAL_GATEWAY_ENVELOPE");
    return Object.freeze(envelope);
  }

  async verify(signed, nowSeconds) {
    const envelope = this.parse(signed, nowSeconds);
    // Keep the replay mark for twice the freshness window so a late duplicate is still refused.
    const fresh = await this.replayStore.claim(envelope.updateId, nowSeconds + this.maxAgeSeconds * 2, nowSeconds);
    if (!fresh) throw new Error("GATEWAY_UPDATE_REPLAYED");
    return envelope;
  }
}
