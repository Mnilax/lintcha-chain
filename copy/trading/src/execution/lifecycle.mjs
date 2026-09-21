import { deterministicId } from "../utils.mjs";
import { assertFreshQuote, QuoteRefusal } from "./quote.mjs";
import { buildSwapTransaction } from "./builder.mjs";

const transitions = Object.freeze({
  QUOTED: ["AWAITING_APPROVAL", "EXPIRED", "REJECTED"],
  AWAITING_APPROVAL: ["SIGNED", "EXPIRED", "REJECTED"],
  SIGNED: ["SUBMITTED", "FAILED"],
  SUBMITTED: ["CONFIRMED", "FAILED"],
});

export class ExecutionCoordinator {
  constructor({ signer, broadcaster, broadcastEnabled = false }) {
    this.signer = signer;
    this.broadcaster = broadcaster;
    this.broadcastEnabled = broadcastEnabled;
  }

  prepare({ match, quote, availableBalance, maxPerTrade, remainingDailyCap, globalPaused, nowSeconds }) {
    if (globalPaused) throw new QuoteRefusal("GLOBAL_PAUSED");
    assertFreshQuote(quote, { nowSeconds });
    const amount = BigInt(quote.amountIn);
    if (amount > BigInt(availableBalance)) throw new QuoteRefusal("INSUFFICIENT_BALANCE");
    if (amount > BigInt(maxPerTrade) || amount > BigInt(remainingDailyCap)) throw new QuoteRefusal("CAP_EXCEEDED");
    const transaction = buildSwapTransaction(quote);
    return {
      id: deterministicId(match.id, quote.id),
      state: "QUOTED",
      revision: 1,
      matchId: match.id,
      quote,
      quoteFingerprint: deterministicId(JSON.stringify(quote)),
      transaction,
      history: [{ state: "QUOTED", reason: "FRESH_QUOTE", at: nowSeconds }],
    };
  }

  review(order) {
    return Object.freeze({
      chainId: order.quote.chainId,
      direction: order.quote.direction,
      token: order.quote.targetToken,
      router: order.quote.router,
      spender: order.quote.spender,
      amount: order.quote.amountIn,
      expectedOutput: order.quote.expectedOutput,
      minimumReceived: order.quote.minimumOutput,
      slippageBps: order.quote.slippageBps,
      priceImpactBps: order.quote.priceImpactBps,
      estimatedGas: order.quote.estimatedGas,
      quoteBlock: { number: order.quote.blockNumber, hash: order.quote.blockHash },
      deadline: order.quote.expiresAt,
    });
  }

  approve(order, { quoteFingerprint, nowSeconds }) {
    if (quoteFingerprint !== order.quoteFingerprint) throw new QuoteRefusal("QUOTE_CHANGED");
    assertFreshQuote(order.quote, { nowSeconds });
    this.#move(order, "AWAITING_APPROVAL", "USER_REVIEW_ACCEPTED", nowSeconds);
    return order;
  }

  async sign(order, { nowSeconds, authorization } = {}) {
    assertFreshQuote(order.quote, { nowSeconds });
    if (order.state !== "AWAITING_APPROVAL") throw new Error("INVALID_ORDER_STATE");
    if (authorization) {
      if (typeof this.signer.signDelegated !== "function") throw new Error("DELEGATED_SIGNER_UNAVAILABLE");
      order.signedReference = await this.signer.signDelegated(order.transaction, authorization);
      this.#move(order, "SIGNED", "DELEGATED_POLICY_AUTHORIZED", nowSeconds);
    } else {
      order.signedReference = await this.signer.signLocally(order.transaction);
      this.#move(order, "SIGNED", "LOCAL_OR_EXTERNAL_WALLET", nowSeconds);
    }
    return order;
  }

  async submit(order, { nowSeconds }) {
    if (!this.broadcastEnabled) throw new Error("REAL_BROADCAST_DISABLED");
    if (order.state !== "SIGNED") throw new Error("INVALID_ORDER_STATE");
    order.transactionHash = await this.broadcaster.submit(order.signedReference);
    this.#move(order, "SUBMITTED", "BROADCAST_ACCEPTED", nowSeconds);
    return order;
  }

  recordReceipt(order, receipt, { nowSeconds }) {
    if (order.state !== "SUBMITTED") throw new Error("INVALID_ORDER_STATE");
    if (receipt.transactionHash !== order.transactionHash || receipt.status !== 1) {
      this.#move(order, "FAILED", "RECEIPT_REJECTED", nowSeconds);
      return order;
    }
    order.receipt = Object.freeze({ ...receipt });
    this.#move(order, "CONFIRMED", "SUCCESS_RECEIPT", nowSeconds);
    return order;
  }

  #move(order, next, reason, at) {
    if (!transitions[order.state]?.includes(next)) throw new Error(`INVALID_TRANSITION:${order.state}->${next}`);
    order.state = next;
    order.revision += 1;
    order.history.push({ state: next, reason, at });
  }
}

export class OfflineBroadcaster {
  async submit() {
    throw new Error("REAL_BROADCAST_DISABLED");
  }
}
