import { buildPonsV2AutoBuyTransaction } from "../execution/builder.mjs";
import { evaluateRule } from "../rules/engine.mjs";

const READY_STATES = new Set(["CONFIRMED", "FINALIZED"]);

/**
 * Converts one verified source trade into per-user outcomes. The dispatcher never signs or broadcasts;
 * it submits an unsigned BUY wrapper call to Copy service. Every SELL outcome is manual-only.
 */
export class AutoBuyDispatcher {
  constructor({ quoteEngine, copyService, notifier, executorAddress, clock = () => Math.floor(Date.now() / 1000) }) {
    this.quoteEngine = quoteEngine;
    this.copyService = copyService;
    this.notifier = notifier;
    this.executorAddress = executorAddress;
    this.clock = clock;
  }

  async dispatch(event, subscriptions) {
    if (!READY_STATES.has(event?.state)) throw new Error("SOURCE_NOT_CONFIRMED");
    const outcomes = [];
    for (const subscription of subscriptions) {
      try {
        const match = evaluateRule(subscription.rule, event, subscription.context);
        if (!match.matched) {
          outcomes.push(Object.freeze({ userId: subscription.userId, outcome: "SKIPPED", reason: match.reason, match }));
          continue;
        }
        if (subscription.mode === "NOTIFY_ONLY") {
          await this.notifier.notify({ subscription, event, match, action: "NOTIFY" });
          outcomes.push(Object.freeze({ userId: subscription.userId, outcome: "NOTIFIED", match }));
          continue;
        }
        if (event.direction === "SELL") {
          await this.notifier.notify({ subscription, event, match, action: "MANUAL_SELL" });
          outcomes.push(Object.freeze({ userId: subscription.userId, outcome: "MANUAL_SELL_REQUIRED", match }));
          continue;
        }
        if (subscription.mode !== "AUTO_BUY") throw new Error("UNSUPPORTED_COPY_MODE");
        const now = this.clock();
        const quote = await this.quoteEngine.quote({
          direction: "BUY",
          launch: { factory: event.factory, curve: event.curve, token: event.targetToken, pairToken: event.pairToken },
          amountIn: match.ownAmount,
          recipient: subscription.walletAddress,
          slippageBps: subscription.rule.maxSlippageBps,
          maxPriceImpactBps: subscription.rule.maxPriceImpactBps,
          ttlSeconds: subscription.rule.quoteTtlSeconds,
          nowSeconds: now,
          sourceState: event.state,
        });
        const transaction = buildPonsV2AutoBuyTransaction(quote, { executorAddress: this.executorAddress });
        const intent = await this.copyService.executeAutomaticBuy({
          userId: subscription.userId,
          walletAddress: subscription.walletAddress,
          sourceTradeId: event.sourceId,
          quote,
          transaction,
        });
        outcomes.push(Object.freeze({ userId: subscription.userId, outcome: intent.state, intent, match }));
      } catch (error) {
        outcomes.push(Object.freeze({ userId: subscription.userId, outcome: "REJECTED", reason: error.message }));
      }
    }
    return Object.freeze(outcomes);
  }
}
