import { assertExecutionAuthorization, TRADING_MODES } from "./authorization.mjs";

export class AutomaticCopyExecutor {
  constructor({ coordinator, spendGuard, enabled = false }) {
    this.coordinator = coordinator;
    this.spendGuard = spendGuard;
    this.enabled = enabled === true;
  }

  async dispatch({ profile, order, nowSeconds, utcDay }) {
    if (profile?.mode === TRADING_MODES.NOTIFY_ONLY) {
      return Object.freeze({ outcome: "NOTIFIED", orderId: order.id, transactionSubmitted: false });
    }
    if (!this.enabled) throw new Error("AUTOMATIC_EXECUTION_DISABLED");
    if (!this.spendGuard || typeof this.spendGuard.reserve !== "function") throw new Error("SPEND_RESERVATION_UNAVAILABLE");
    const reservation = await this.spendGuard.reserve({ id: order.id, userId: profile.userId, utcDay, amount: order.quote.amountIn, maxPerDay: profile.maxPerDay });
    if (reservation.duplicate) {
      if (reservation.state === "SUBMITTED" || reservation.state === "CONFIRMED") {
        return Object.freeze({ outcome: "ALREADY_SUBMITTED", orderId: order.id, transactionHash: reservation.transactionHash, transactionSubmitted: true });
      }
      throw new Error(reservation.state === "SIGNING" ? "EXECUTION_RECONCILIATION_REQUIRED" : "EXECUTION_RESERVATION_EXISTS");
    }
    let authorization;
    try {
      authorization = assertExecutionAuthorization({
        ...profile,
        recipient: order.quote.recipient,
        orderAmount: order.quote.amountIn,
        orderDirection: order.quote.direction,
      }, order.transaction, { nowSeconds, dailyUsed: reservation.usedBefore });
      this.coordinator.approve(order, { quoteFingerprint: order.quoteFingerprint, nowSeconds });
    } catch (error) {
      await this.spendGuard.release(order.id);
      throw error;
    }
    await this.spendGuard.markSigning(order.id);
    await this.coordinator.sign(order, { nowSeconds, authorization });
    await this.coordinator.submit(order, { nowSeconds });
    await this.spendGuard.markSubmitted(order.id, order.transactionHash);
    return Object.freeze({ outcome: "SUBMITTED", orderId: order.id, transactionHash: order.transactionHash, transactionSubmitted: true });
  }
}

export class StoreSpendGuard {
  constructor({ store, now = () => Date.now() }) {
    this.store = store;
    this.now = now;
  }

  reserve(input) {
    return this.store.reserveExecutionSpend({ ...input, now: this.now() });
  }

  markSigning(id) {
    return this.store.markExecutionReservationSigning(id, this.now());
  }

  markSubmitted(id, transactionHash) {
    return this.store.markExecutionReservationSubmitted(id, transactionHash, this.now());
  }

  release(id) {
    return this.store.releaseExecutionReservation(id, this.now());
  }
}
