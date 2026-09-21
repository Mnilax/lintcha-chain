import { createHmac, timingSafeEqual } from "node:crypto";
import { COPY_TEXTS } from "./telegram-surface.mjs";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const INTENT_ID = /^[0-9a-f]{64}$/;
const BODY_LIMIT = 16 * 1024;

/** Stable error codes → HTTP status. Anything unlisted is a 500 that leaks nothing. */
const STATUS = Object.freeze({
  INVALID_GATEWAY_SIGNATURE: 401, INVALID_GATEWAY_ENVELOPE: 400, NON_MINIMAL_GATEWAY_ENVELOPE: 400, INVALID_GATEWAY_IDENTITY: 400,
  STALE_GATEWAY_ENVELOPE: 401, GATEWAY_UPDATE_REPLAYED: 409, INVALID_COPY_CALLBACK: 400,
  INVALID_INIT_DATA: 401, INVALID_INIT_DATA_SIGNATURE: 401, STALE_INIT_DATA: 401, INVALID_INIT_DATA_USER: 401,
  CONFIRMATION_OWNER_MISMATCH: 403, SUBMISSION_OWNER_MISMATCH: 403, CANCEL_OWNER_MISMATCH: 403, INTENT_OWNER_MISMATCH: 403,
  CONFIRMATION_REVISION_MISMATCH: 409, CONFIRMATION_REPLAYED: 409, SUBMISSION_REPLAYED: 409, NOT_CANCELLABLE: 409, NOT_RECONCILABLE: 409, QUOTE_ALREADY_USED: 409,
  CONFIRMATION_EXPIRED: 410, SUBMISSION_TOO_LATE: 410, STALE_QUOTE: 410,
  INVALID_CONFIRMATION_TOKEN: 400, INVALID_TRANSACTION_HASH: 400, INVALID_PUBLIC_ADDRESS: 400, INVALID_WALLET_KIND: 400, INVALID_UNSIGNED_TRANSACTION: 400, INVALID_QUOTE: 400, INVALID_BODY: 400, INVALID_ROUTE: 404,
  GLOBAL_BROADCAST_KILL_SWITCH: 423, USER_BROADCAST_KILL_SWITCH: 423, WALLET_BROADCAST_KILL_SWITCH: 423, USER_PAUSED: 423, USER_NOT_CONFIRM_EACH: 409, USER_NOT_AUTO_BUY: 409, AUTO_BUY_DISABLED: 423, ACTIVE_DELEGATION_REQUIRED: 409, WALLET_NOT_REGISTERED: 409, WALLET_LIMIT_REACHED: 409,
  RATE_LIMITED: 429, ORIGIN_FORBIDDEN: 403, METHOD_NOT_ALLOWED: 405, UNSUPPORTED_MEDIA_TYPE: 415, BODY_TOO_LARGE: 413,
  SIGNED_OR_SECRET_MATERIAL_FORBIDDEN: 400,
});

export class HttpError extends Error { constructor(code, status = STATUS[code] || 500) { super(code); this.status = status; } }

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...extra } });
}

const POLICY_CODE = /^(?:AUTO_SELL_FORBIDDEN|AUTO_BUY_TRADE_ONLY|BUY_APPROVAL_FORBIDDEN|EXPLICIT_CLIENT_CONFIRMATION_REQUIRED|DELEGATION_[A-Z_]+|[A-Z_]+_NOT_ALLOWLISTED|[A-Z_]+_CAP_EXCEEDED|[A-Z_]+_CAP_REQUIRED|NON_EXACT_APPROVAL_FORBIDDEN|VALUE_BEARING_[A-Z_]+_FORBIDDEN|QUOTE_VALUE_MISMATCH|APPROVAL_TOKEN_MISMATCH|SELL_ALLOWANCE_[A-Z_]+|INVALID_SOURCE_TRADE|INVALID_DIRECTION|INVALID_OPERATION|INVALID_APPROVAL_CALL)$/;
const DEPENDENCY_CODE = /^(?:SIMULATION_|RPC_)[A-Z_]+$/;

export function statusForCode(code) {
  if (STATUS[code]) return STATUS[code];
  if (POLICY_CODE.test(code)) return 422;
  if (DEPENDENCY_CODE.test(code)) return 503;
  if (/^INVALID_[A-Z_]+$/.test(code)) return 400;
  return null;
}

export function errorResponse(error) {
  const code = String(error?.message || "");
  const status = error instanceof HttpError ? error.status : statusForCode(code);
  if (!status) return json({ ok: false, why: "internal" }, 500);
  return json({ ok: false, why: code }, status);
}

async function readJson(request) {
  const type = String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") throw new HttpError("UNSUPPORTED_MEDIA_TYPE");
  const text = await request.text();
  if (text.length > BODY_LIMIT) throw new HttpError("BODY_TOO_LARGE");
  let body;
  try { body = JSON.parse(text); } catch { throw new HttpError("INVALID_BODY"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError("INVALID_BODY");
  return body;
}

/** Per-isolate courtesy window; the durable per-user ordering lives in the coordinator object, not here. */
export class FixedWindowRateLimiter {
  constructor({ limit = 30, windowSeconds = 60 } = {}) { this.limit = limit; this.windowSeconds = windowSeconds; this.buckets = new Map(); }
  take(key, nowSeconds) {
    const window = Math.floor(nowSeconds / this.windowSeconds);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.window !== window) { this.buckets.set(key, { window, taken: 1 }); if (this.buckets.size > 10_000) this.buckets.clear(); return true; }
    if (bucket.taken >= this.limit) return false;
    bucket.taken += 1;
    return true;
  }
}

/** Second signed channel over the same gateway secret, for Core-originated calls that are not Telegram updates. */
export class SignedServiceRequestVerifier {
  constructor({ secret, schema, replayStore, maxAgeSeconds = 30 }) {
    if (!secret || Buffer.byteLength(secret) < 32) throw new Error("COPY_GATEWAY_SECRET_REQUIRED");
    this.secret = secret; this.schema = schema; this.replayStore = replayStore; this.maxAgeSeconds = maxAgeSeconds;
  }
  async verify({ body, signature }, nowSeconds) {
    if (typeof body !== "string" || body.length > BODY_LIMIT || !/^[0-9a-f]{64}$/i.test(signature || "")) throw new HttpError("INVALID_GATEWAY_SIGNATURE");
    const expected = createHmac("sha256", this.secret).update(body).digest();
    const actual = Buffer.from(signature, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError("INVALID_GATEWAY_SIGNATURE");
    let payload;
    try { payload = JSON.parse(body); } catch { throw new HttpError("INVALID_GATEWAY_ENVELOPE"); }
    if (payload?.schema !== this.schema || !/^[0-9a-f]{16,64}$/.test(payload.requestId || "") || !Number.isSafeInteger(payload.issuedAt)) throw new HttpError("INVALID_GATEWAY_ENVELOPE");
    if (Math.abs(nowSeconds - payload.issuedAt) > this.maxAgeSeconds) throw new HttpError("STALE_GATEWAY_ENVELOPE");
    if (!(await this.replayStore.claim(`${this.schema}:${payload.requestId}`, nowSeconds + this.maxAgeSeconds * 2, nowSeconds))) throw new HttpError("GATEWAY_UPDATE_REPLAYED");
    return payload;
  }
}

/**
 * The Copy service's whole HTTP surface. Three audiences, three authentications:
 *   Core gateway  → HMAC(gateway secret): /gateway (Telegram replies), /gateway/outbox (drain), /intents, /notify
 *   Mini App      → Telegram third-party Ed25519 initData + Origin: /me, /wallet, /intents/:id[/begin|/submission|/cancel]
 *   Operator      → HMAC(admin secret): /admin/kill-switch, /admin/reconcile
 * There is no route that signs, broadcasts, or accepts key material.
 */
export function createCopyHttpHandler({ config, service, surface, userStore, delegationStore = null, outbox, killSwitches, gatewayVerifier, serviceVerifier, adminVerifier = null, initDataVerifier, clock = () => Math.floor(Date.now() / 1000), rateLimiter = new FixedWindowRateLimiter(), persistKillSwitches = async () => {} }) {
  const base = config.apiPath.replace(/\/$/, "");

  async function clientIdentity(request) {
    // Browsers send Origin on every POST and on cross-origin GETs, but not on same-origin GETs. So: a present
    // Origin must match exactly; an absent one is accepted only for GET and only when Sec-Fetch-Site, if sent,
    // says same-origin. Every mutating call therefore always carries a matching Origin.
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if (origin !== null ? origin !== config.appOrigin : (request.method !== "GET" || (site && site !== "same-origin"))) throw new HttpError("ORIGIN_FORBIDDEN");
    const identity = await initDataVerifier.verify(request.headers.get("x-telegram-init-data") || "", clock());
    if (!rateLimiter.take(`client:${identity.telegramUserId}`, clock())) throw new HttpError("RATE_LIMITED");
    return identity;
  }

  async function gatewaySigned(request, verifier) {
    const body = await readJson(request);
    return verifier.verify({ body: body.body, signature: body.signature }, clock());
  }

  async function handle(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${base}/`)) throw new HttpError("INVALID_ROUTE");
    const route = url.pathname.slice(base.length + 1).split("/");
    const method = request.method;

    if (route[0] === "health" && route.length === 1) {
      if (method !== "GET") throw new HttpError("METHOD_NOT_ALLOWED");
      return json({ ok: true, service: config.serviceName, mode: config.mode, chainId: config.chainId, appPath: config.appPath, apiPath: config.apiPath, globallyPaused: killSwitches.globallyPaused, providerIds: config.rpc.endpoints.map((item) => item.id), rpcReady: config.rpc.ready, broadcastEnabled: false, autoBuyEnabled: config.autoBuyEnabled, delegatedSubmissionEnabled: config.delegatedSubmissionEnabled });
    }

    if (route[0] === "gateway") {
      if (method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      if (route.length === 1) {
        const envelope = await gatewaySigned(request, gatewayVerifier);
        return json({ ok: true, response: await surface.handle(envelope) });
      }
      if (route[1] === "outbox" && route.length === 2) {
        const payload = await gatewaySigned(request, serviceVerifier.outbox);
        for (const id of payload.ack || []) await outbox.ack(id);
        for (const item of payload.fail || []) await outbox.fail(item.id, item.reason);
        const rows = await outbox.lease(Math.min(Number(payload.limit) || 10, 20), clock());
        return json({ ok: true, rows: rows.map((row) => ({ id: row.id, privateChatId: row.privateChatId, response: { text: row.text, inlineKeyboard: row.inlineKeyboard } })) });
      }
      throw new HttpError("INVALID_ROUTE");
    }

    if (route[0] === "notify" && route.length === 1) {
      if (method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      const payload = await gatewaySigned(request, serviceVerifier.notify);
      const user = await userStore.get(payload.telegramUserId);
      if (!user || !user.privateChatId) throw new HttpError("WALLET_NOT_REGISTERED", 409);
      if (user.paused) throw new HttpError("USER_PAUSED");
      const text = `${COPY_TEXTS.HEADER}\n${String(payload.text || "").replace(/[\u0000-\u001f\u007f<>]/g, "").slice(0, 3000)}`;
      const row = await outbox.enqueue({ telegramUserId: user.telegramUserId, privateChatId: user.privateChatId, text, dedupeKey: payload.dedupeKey || null });
      return json({ ok: true, queued: Boolean(row) });
    }

    if (route[0] === "intents" && route.length === 1) {
      if (method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      const payload = await gatewaySigned(request, serviceVerifier.intent);
      const user = await userStore.get(payload.userId);
      if (!user) throw new HttpError("WALLET_NOT_REGISTERED", 409);
      if (user.mode !== "CONFIRM_EACH") throw new HttpError("USER_NOT_CONFIRM_EACH");
      if (user.paused) throw new HttpError("USER_PAUSED");
      const wallets = await userStore.wallets(user.telegramUserId);
      if (!wallets.some((row) => row.publicAddress === String(payload.walletAddress || "").toLowerCase())) throw new HttpError("WALLET_NOT_REGISTERED");
      const view = await service.createConfirmEachIntent({ userId: user.telegramUserId, walletAddress: payload.walletAddress, sourceTradeId: payload.sourceTradeId, quote: payload.quote, transaction: payload.transaction, operation: payload.operation, manualSell: payload.manualSell === true });
      if (!view.duplicate && view.state === "AWAITING_USER_CONFIRMATION" && user.privateChatId) {
        const message = surface.reviewMessage({ intentId: view.intentId, direction: view.direction });
        await outbox.enqueue({ telegramUserId: user.telegramUserId, privateChatId: user.privateChatId, text: message.text, inlineKeyboard: message.inlineKeyboard, dedupeKey: `intent:${view.intentId}` });
      }
      const { confirmationToken, ...publicView } = view;
      return json({ ok: true, intent: publicView });
    }

    if (route[0] === "auto-buy" && route.length === 1) {
      if (method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      const payload = await gatewaySigned(request, serviceVerifier.autoBuy);
      const user = await userStore.get(payload.userId);
      if (!user) throw new HttpError("WALLET_NOT_REGISTERED", 409);
      if (user.mode !== "AUTO_BUY") throw new HttpError("USER_NOT_AUTO_BUY");
      if (user.paused) throw new HttpError("USER_PAUSED");
      const wallets = await userStore.wallets(user.telegramUserId);
      if (!wallets.some((row) => row.publicAddress === String(payload.walletAddress || "").toLowerCase())) throw new HttpError("WALLET_NOT_REGISTERED");
      const view = await service.executeAutomaticBuy({ userId: user.telegramUserId, walletAddress: payload.walletAddress, sourceTradeId: payload.sourceTradeId, quote: payload.quote, transaction: payload.transaction, operation: payload.operation });
      if (!view.duplicate && view.state === "SUBMITTED_PENDING_RECONCILIATION" && user.privateChatId) {
        await outbox.enqueue({ telegramUserId: user.telegramUserId, privateChatId: user.privateChatId, text: `${COPY_TEXTS.HEADER}\nA matched BUY was submitted inside your active limits. Reconciliation is pending; it will not be broadcast again automatically.`, dedupeKey: `auto-buy:${view.intentId}` });
      }
      return json({ ok: true, intent: view });
    }

    if (route[0] === "me" && route.length === 1) {
      if (method !== "GET") throw new HttpError("METHOD_NOT_ALLOWED");
      const identity = await clientIdentity(request);
      const user = await userStore.upsert({ telegramUserId: identity.telegramUserId });
      const wallets = await userStore.wallets(user.telegramUserId);
      const activeDelegations = delegationStore ? (await Promise.all(wallets.map((wallet) => delegationStore.getActive(user.telegramUserId, wallet.publicAddress)))).filter(Boolean).map((row) => ({ walletAddress: row.walletAddress, architecture: row.architecture, expiresAt: row.expiresAt })) : [];
      return json({ ok: true, label: COPY_TEXTS.HEADER, user: { mode: user.mode, paused: Boolean(user.paused) }, globallyPaused: killSwitches.globallyPaused, autoBuyAvailable: config.autoBuyEnabled, chainId: config.chainId, wallets, activeDelegations, intents: await service.listUserIntents(user.telegramUserId, 10).then((rows) => rows.map(({ confirmationToken, ...row }) => row)) });
    }

    if (route[0] === "wallet" && route.length === 1) {
      if (method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      const identity = await clientIdentity(request);
      const body = await readJson(request);
      if (!ADDRESS.test(body.publicAddress || "")) throw new HttpError("INVALID_PUBLIC_ADDRESS");
      if (body.seed || body.mnemonic || body.privateKey || body.vaultRecord) throw new HttpError("SIGNED_OR_SECRET_MATERIAL_FORBIDDEN");
      await userStore.upsert({ telegramUserId: identity.telegramUserId });
      return json({ ok: true, wallets: await userStore.addWallet({ telegramUserId: identity.telegramUserId, publicAddress: body.publicAddress.toLowerCase(), walletKind: body.walletKind || "EXTERNAL", publicLabel: typeof body.publicLabel === "string" ? body.publicLabel.replace(/[<>\u0000-\u001f]/g, "").slice(0, 32) : null }) });
    }

    if (route[0] === "intents" && INTENT_ID.test(route[1] || "")) {
      const identity = await clientIdentity(request);
      const intentId = route[1];
      if (route.length === 2) {
        if (method !== "GET") throw new HttpError("METHOD_NOT_ALLOWED");
        return json({ ok: true, intent: await service.getIntentForUser({ intentId, userId: identity.telegramUserId }) });
      }
      if (method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      const body = await readJson(request);
      if (body.rawTransaction || body.signedTransaction || body.privateKey || body.seed || body.mnemonic) throw new HttpError("SIGNED_OR_SECRET_MATERIAL_FORBIDDEN");
      if (route[2] === "begin") {
        if (typeof body.token !== "string" || !Number.isSafeInteger(body.revision)) throw new HttpError("INVALID_BODY");
        const user = await userStore.get(identity.telegramUserId);
        if (!user || user.paused) throw new HttpError("USER_PAUSED");
        const opened = await service.beginSecureSheetConfirmation({ token: body.token, userId: identity.telegramUserId, revision: body.revision });
        return json({ ok: true, intent: opened });
      }
      if (route[2] === "submission") {
        if (!Number.isSafeInteger(body.revision)) throw new HttpError("INVALID_BODY");
        return json({ ok: true, intent: await service.recordClientSubmission({ intentId, userId: identity.telegramUserId, revision: body.revision, transactionHash: body.transactionHash }) });
      }
      if (route[2] === "cancel") {
        return json({ ok: true, intent: await service.cancelIntent({ intentId, userId: identity.telegramUserId, reason: typeof body.reason === "string" ? body.reason.replace(/[^A-Z_]/g, "").slice(0, 32) || "USER_CANCELLED" : "USER_CANCELLED" }) });
      }
      throw new HttpError("INVALID_ROUTE");
    }

    if (route[0] === "admin") {
      if (!adminVerifier) throw new HttpError("INVALID_ROUTE");
      if (method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED");
      const payload = await gatewaySigned(request, adminVerifier);
      if (route[1] === "kill-switch" && route.length === 2) {
        if (payload.scope === "GLOBAL" && payload.action === "PAUSE") killSwitches.pauseGlobal();
        else if (payload.scope === "GLOBAL" && payload.action === "RESUME") killSwitches.resumeGlobal();
        else if (payload.scope === "USER" && payload.action === "PAUSE" && /^\d+$/.test(payload.subjectId || "")) killSwitches.pauseUser(payload.subjectId);
        else if (payload.scope === "USER" && payload.action === "RESUME" && /^\d+$/.test(payload.subjectId || "")) killSwitches.resumeUser(payload.subjectId);
        else if (payload.scope === "WALLET" && payload.action === "PAUSE" && ADDRESS.test(payload.subjectId || "")) killSwitches.pauseWallet(payload.subjectId);
        else if (payload.scope === "WALLET" && payload.action === "RESUME" && ADDRESS.test(payload.subjectId || "")) killSwitches.resumeWallet(payload.subjectId);
        else throw new HttpError("INVALID_BODY");
        await persistKillSwitches(killSwitches.snapshot(), { actorId: String(payload.actorId || "owner").slice(0, 32), reason: String(payload.reason || "").slice(0, 200) });
        return json({ ok: true, killSwitches: killSwitches.snapshot() });
      }
      if (route[1] === "reconcile" && route.length === 2) {
        await service.expireStale({ now: clock() });
        return json({ ok: true, results: await service.reconcilePending({ now: clock() }) });
      }
      if (route[1] === "referrals" && route.length === 2) {
        return json({ ok: true, referrals: await userStore.referralStats("SITE") });
      }
      throw new HttpError("INVALID_ROUTE");
    }

    throw new HttpError("INVALID_ROUTE");
  }

  return async function copyHttpHandler(request) {
    try { return await handle(request); } catch (error) { return errorResponse(error); }
  };
}

export function signServiceRequest(payload, secret) {
  const body = JSON.stringify(payload);
  return { body, signature: createHmac("sha256", secret).update(body).digest("hex") };
}
