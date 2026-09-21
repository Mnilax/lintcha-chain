import { deterministicId } from "../utils.mjs";
import { CallbackGuard } from "../wallet/callbacks.mjs";

export class ManualSellTelegramService {
  constructor({ eventReader, orderFactory, profileReader, executor, callbackSecret, callbackMaxAgeSeconds = 900 }) {
    this.eventReader = eventReader;
    this.orderFactory = orderFactory;
    this.profileReader = profileReader;
    this.executor = executor;
    this.signalGuard = new CallbackGuard({ signingSecret: callbackSecret, maxAgeSeconds: callbackMaxAgeSeconds });
    this.signalTokens = new Map();
  }

  registerSignal({ userId, event, nowSeconds }) {
    if (event.direction !== "SELL" || !["CONFIRMED", "FINALIZED"].includes(event.state)) throw new Error("MANUAL_SELL_SIGNAL_NOT_ELIGIBLE");
    const token = this.signalGuard.issue({
      userId: String(userId),
      subjectId: event.sourceId,
      action: "manual_sell_review",
      revision: event.revision,
      issuedAt: nowSeconds,
      nonce: deterministicId(userId, event.sourceId, event.revision, nowSeconds).slice(0, 16),
    });
    this.signalTokens.set(token, event.sourceId);
    return token;
  }

  async review({ userId, signalToken, nowSeconds }) {
    const sourceId = this.signalTokens.get(signalToken);
    if (!sourceId) throw new Error("INVALID_MANUAL_SELL_SIGNAL");
    const event = await this.eventReader.get(sourceId);
    if (!event || event.direction !== "SELL" || !["CONFIRMED", "FINALIZED"].includes(event.state)) throw new Error("MANUAL_SELL_SIGNAL_NO_LONGER_ELIGIBLE");
    this.signalGuard.consume(signalToken, { telegramUserId: String(userId), currentRevision: event.revision, nowSeconds });
    this.signalTokens.delete(signalToken);
    const profile = await this.profileReader.get(String(userId));
    const prepared = await this.orderFactory.createSellOrder({ userId: String(userId), event, profile, nowSeconds });
    const result = await this.executor.review({ profile, order: prepared.order, userId: String(userId), positionBalance: prepared.positionBalance, nowSeconds });
    return Object.freeze({
      token: result.review.token,
      amount: result.review.amount,
      expectedOutput: result.review.expectedOutput,
      minimumReceived: result.review.minimumReceived,
      slippageBps: result.review.slippageBps,
      priceImpactBps: result.review.priceImpactBps,
      expiresAt: result.expiresAt,
      confirmationToken: result.confirmationToken,
    });
  }

  async confirm({ userId, confirmationToken, nowSeconds }) {
    const profile = await this.profileReader.get(String(userId));
    return this.executor.confirm({ profile, token: confirmationToken, userId: String(userId), nowSeconds });
  }
}
