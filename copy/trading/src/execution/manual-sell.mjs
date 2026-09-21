import { deterministicId } from "../utils.mjs";
import { CallbackGuard } from "../wallet/callbacks.mjs";
import { assertManualSellAuthorization } from "./authorization.mjs";
import { assertFreshQuote } from "./quote.mjs";

export class ManualSellExecutor {
  constructor({ coordinator, intentStore, positionReader, callbackSecret, callbackMaxAgeSeconds = 120, enabled = false }) {
    this.coordinator = coordinator;
    this.intentStore = intentStore;
    this.positionReader = positionReader;
    this.enabled = enabled === true;
    this.callbackGuard = new CallbackGuard({ signingSecret: callbackSecret, maxAgeSeconds: callbackMaxAgeSeconds });
    this.tokenIntent = new Map();
  }

  async review({ profile, order, userId, positionBalance, nowSeconds }) {
    if (!this.enabled) throw new Error("MANUAL_SELL_DISABLED");
    if (order?.quote?.direction !== "SELL") throw new Error("MANUAL_SELL_DIRECTION_REQUIRED");
    assertFreshQuote(order.quote, { nowSeconds });
    assertManualSellAuthorization({
      ...profile,
      recipient: order.quote.recipient,
      orderAmount: order.quote.amountIn,
      orderDirection: "SELL",
    }, order.transaction, { nowSeconds, positionBalance });
    const intentId = deterministicId("manual-sell", userId, order.id);
    const created = await this.intentStore.create({ id: intentId, userId: String(userId), order, positionBalance, nowSeconds });
    const intent = created.intent;
    if (intent.state !== "AWAITING_CONFIRMATION") throw new Error("MANUAL_SELL_ALREADY_PROCESSED");
    const token = this.callbackGuard.issue({
      userId: String(userId),
      subjectId: intentId,
      action: "manual_sell_confirm",
      revision: intent.revision,
      issuedAt: nowSeconds,
      nonce: deterministicId(intentId, nowSeconds, intent.revision).slice(0, 16),
    });
    this.tokenIntent.set(token, intentId);
    return Object.freeze({
      intentId,
      confirmationToken: token,
      review: this.coordinator.review(order),
      expiresAt: order.quote.expiresAt,
    });
  }

  async confirm({ profile, token, userId, nowSeconds }) {
    if (!this.enabled) throw new Error("MANUAL_SELL_DISABLED");
    const intentId = this.tokenIntent.get(token);
    if (!intentId) throw new Error("INVALID_MANUAL_SELL_CALLBACK");
    const intent = await this.intentStore.get(intentId);
    if (!intent || intent.user_id !== String(userId)) throw new Error("MANUAL_SELL_OWNER_MISMATCH");
    const order = JSON.parse(intent.order_json);
    if (nowSeconds >= intent.expires_at) {
      await this.intentStore.expire(intentId);
      throw new Error("QUOTE_EXPIRED");
    }
    assertFreshQuote(order.quote, { nowSeconds });
    const positionBalance = await this.positionReader.balanceOf({ userId: String(userId), token: intent.token });
    const authorization = assertManualSellAuthorization({
      ...profile,
      recipient: order.quote.recipient,
      orderAmount: order.quote.amountIn,
      orderDirection: "SELL",
    }, order.transaction, { nowSeconds, positionBalance });
    this.callbackGuard.consume(token, { telegramUserId: String(userId), currentRevision: intent.revision, nowSeconds });
    this.tokenIntent.delete(token);
    await this.intentStore.claim({ id: intentId, userId: String(userId), expectedRevision: intent.revision });
    this.coordinator.approve(order, { quoteFingerprint: intent.quote_fingerprint, nowSeconds });
    await this.coordinator.sign(order, { nowSeconds, authorization });
    await this.coordinator.submit(order, { nowSeconds });
    await this.intentStore.markSubmitted(intentId, order.transactionHash);
    return Object.freeze({ outcome: "SUBMITTED", intentId, orderId: order.id, transactionHash: order.transactionHash });
  }
}

export class StoreManualSellIntentStore {
  constructor({ store, now = () => Date.now() }) {
    this.store = store;
    this.now = now;
  }

  create({ id, userId, order, positionBalance, nowSeconds }) {
    return this.store.createManualSellIntent({ id, userId, token: order.quote.targetToken, amount: order.quote.amountIn, positionBalance, order, nowSeconds, now: this.now() });
  }

  get(id) {
    return this.store.getManualSellIntent(id);
  }

  claim({ id, userId, expectedRevision }) {
    return this.store.claimManualSellIntent({ id, userId, expectedRevision, now: this.now() });
  }

  markSubmitted(id, transactionHash) {
    return this.store.markManualSellSubmitted({ id, transactionHash, now: this.now() });
  }

  expire(id) {
    return this.store.expireManualSellIntent(id, this.now());
  }
}
