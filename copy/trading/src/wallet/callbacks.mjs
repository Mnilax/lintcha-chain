import { createHmac } from "node:crypto";

function payloadText(payload) {
  return [payload.userId, payload.subjectId, payload.action, payload.revision, payload.issuedAt, payload.nonce].join("|");
}

export class CallbackGuard {
  constructor({ signingSecret, maxAgeSeconds }) {
    if (!signingSecret || !Number.isSafeInteger(maxAgeSeconds)) throw new TypeError("callback policy required");
    this.signingSecret = signingSecret;
    this.maxAgeSeconds = maxAgeSeconds;
    this.used = new Set();
    this.pending = new Map();
  }

  issue(payload) {
    const body = { ...payload };
    const token = createHmac("sha256", this.signingSecret).update(payloadText(body)).digest("base64url");
    if (this.pending.has(token) || this.used.has(token)) throw new Error("CALLBACK_TOKEN_COLLISION");
    this.pending.set(token, body);
    return token;
  }

  consume(token, { telegramUserId, currentRevision, nowSeconds }) {
    if (this.used.has(token)) throw new Error("CALLBACK_REPLAY");
    const parsed = this.pending.get(token);
    if (!parsed) throw new Error("INVALID_CALLBACK");
    const expected = createHmac("sha256", this.signingSecret).update(payloadText(parsed)).digest("base64url");
    if (token !== expected) throw new Error("INVALID_CALLBACK_SIGNATURE");
    if (String(parsed.userId) !== String(telegramUserId)) throw new Error("CALLBACK_OWNER_MISMATCH");
    if (parsed.revision !== currentRevision) throw new Error("STALE_CALLBACK_REVISION");
    if (parsed.issuedAt > nowSeconds || nowSeconds - parsed.issuedAt > this.maxAgeSeconds) throw new Error("STALE_CALLBACK");
    this.pending.delete(token);
    this.used.add(token);
    return Object.freeze({ subjectId: parsed.subjectId, action: parsed.action, revision: parsed.revision });
  }
}
