const ADDRESS = /^0x[0-9a-f]{40}$/;

function address(value) {
  const normalized = String(value || "").toLowerCase();
  if (!ADDRESS.test(normalized)) throw new Error("INVALID_PUBLIC_ADDRESS");
  return normalized;
}

function amount(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch { throw new Error(`INVALID_${label}`); }
}

/**
 * Global, per-user and per-wallet pause state. Starts paused. `load()` accepts persisted rows so a durable adapter
 * (D1 `copy_kill_switches`) can hydrate the same object per request; `snapshot()` is what it persists.
 */
export class KillSwitches {
  constructor({ globallyPaused = true } = {}) {
    this.globallyPaused = globallyPaused !== false;
    this.users = new Set();
    this.wallets = new Set();
    this.revision = 1;
  }
  static load(rows = [], fallback = { globallyPaused: true }) {
    const switches = new KillSwitches(fallback);
    let seenGlobal = false;
    for (const row of rows) {
      if (row.scope === "GLOBAL") { switches.globallyPaused = Number(row.paused) === 1; seenGlobal = true; }
      else if (row.scope === "USER" && Number(row.paused) === 1) switches.users.add(String(row.subjectId ?? row.subject_id));
      else if (row.scope === "WALLET" && Number(row.paused) === 1) switches.wallets.add(address(row.subjectId ?? row.subject_id));
      switches.revision = Math.max(switches.revision, Number(row.revision) || 1);
    }
    // A global row that was never written means the switch was never deliberately opened: stay paused.
    if (!seenGlobal) switches.globallyPaused = true;
    return switches;
  }
  snapshot() {
    return Object.freeze({
      revision: this.revision,
      global: { scope: "GLOBAL", subjectId: "global", paused: this.globallyPaused ? 1 : 0 },
      users: [...this.users].map((id) => ({ scope: "USER", subjectId: id, paused: 1 })),
      wallets: [...this.wallets].map((id) => ({ scope: "WALLET", subjectId: id, paused: 1 })),
    });
  }
  pauseGlobal() { this.globallyPaused = true; this.revision += 1; }
  resumeGlobal() { this.globallyPaused = false; this.revision += 1; }
  pauseUser(userId) { this.users.add(String(userId)); this.revision += 1; }
  resumeUser(userId) { this.users.delete(String(userId)); this.revision += 1; }
  pauseWallet(walletAddress) { this.wallets.add(address(walletAddress)); this.revision += 1; }
  resumeWallet(walletAddress) { this.wallets.delete(address(walletAddress)); this.revision += 1; }
  isPaused(userId, walletAddress = null) { return this.globallyPaused || this.users.has(String(userId)) || (walletAddress !== null && this.wallets.has(address(walletAddress))); }
  assertAllowed(userId, walletAddress = null) {
    if (this.globallyPaused) throw new Error("GLOBAL_BROADCAST_KILL_SWITCH");
    if (this.users.has(String(userId))) throw new Error("USER_BROADCAST_KILL_SWITCH");
    if (walletAddress !== null && this.wallets.has(address(walletAddress))) throw new Error("WALLET_BROADCAST_KILL_SWITCH");
  }
}

/** Interface: reserve/commit/release are async so a D1-backed ledger implements the same contract. */
export class InMemorySpendLedger {
  constructor() { this.reservations = new Map(); }
  async reserve({ intentId, userId, utcDay, amountWei, maxDailySpendWei }) {
    if (this.reservations.has(intentId)) return this.reservations.get(intentId);
    const amountValue = amount(amountWei, "SPEND");
    const used = [...this.reservations.values()]
      .filter((item) => item.userId === String(userId) && item.utcDay === utcDay && item.state !== "RELEASED")
      .reduce((sum, item) => sum + BigInt(item.amountWei), 0n);
    if (used + amountValue > amount(maxDailySpendWei, "DAILY_CAP")) throw new Error("DAILY_SPEND_CAP_EXCEEDED");
    const row = { intentId, userId: String(userId), utcDay, amountWei: amountValue.toString(), state: "RESERVED" };
    this.reservations.set(intentId, row);
    return row;
  }
  async commit(intentId) { const row = this.reservations.get(intentId); if (row) row.state = "COMMITTED"; }
  async release(intentId) { const row = this.reservations.get(intentId); if (row && row.state !== "COMMITTED") row.state = "RELEASED"; }
  async get(intentId) { return this.reservations.get(intentId) || null; }
}

export function decodeApproval(transaction) {
  const data = String(transaction.data || "").toLowerCase();
  if (!data.startsWith("0x095ea7b3") || data.length !== 138) throw new Error("INVALID_APPROVAL_CALL");
  return {
    spender: address(`0x${data.slice(34, 74)}`),
    amount: BigInt(`0x${data.slice(74)}`),
  };
}

export class ExecutionPolicyGate {
  constructor({ config, killSwitches, spendLedger }) {
    this.config = config;
    this.killSwitches = killSwitches;
    this.spendLedger = spendLedger;
  }

  /**
   * Fail-closed authorization of one unsigned intent. Returns the reservation for BUY trades.
   * Every check here runs before simulation and before any confirmation token is issued.
   */
  async authorize({ intentId, userId, walletAddress = null, utcDay, direction, operation = "TRADE", transaction, quote, confirmationKind, manualSell = false, dailySpendCapWei = null }) {
    this.killSwitches.assertAllowed(userId, walletAddress);
    const delegatedAutoBuy = confirmationKind === "DELEGATED_AUTO_BUY";
    if (confirmationKind !== "SECURE_SHEET_EXPLICIT" && !delegatedAutoBuy) throw new Error("EXPLICIT_CLIENT_CONFIRMATION_REQUIRED");
    if (!this.config.chains.includes(Number(transaction.chainId))) throw new Error("CHAIN_NOT_ALLOWLISTED");
    const selector = String(transaction.data || "").slice(0, 10).toLowerCase();
    if (!this.config.selectors.includes(selector)) throw new Error("SELECTOR_NOT_ALLOWLISTED");
    if (!Number.isSafeInteger(Number(quote.slippageBps)) || Number(quote.slippageBps) < 0 || Number(quote.slippageBps) > this.config.maxSlippageBps) throw new Error("SLIPPAGE_CAP_EXCEEDED");
    if (!["BUY", "SELL"].includes(direction)) throw new Error("INVALID_DIRECTION");
    if (!["TRADE", "APPROVAL"].includes(operation)) throw new Error("INVALID_OPERATION");
    if (delegatedAutoBuy && (direction !== "BUY" || operation !== "TRADE")) throw new Error(direction === "SELL" ? "AUTO_SELL_FORBIDDEN" : "AUTO_BUY_TRADE_ONLY");
    if (direction === "SELL" && manualSell !== true) throw new Error("AUTO_SELL_FORBIDDEN");
    const value = amount(transaction.value || 0, "TRANSACTION_VALUE");
    const tradeAmount = amount(quote.amountIn, "TRANSACTION_AMOUNT");
    if (operation === "APPROVAL") {
      if (direction !== "SELL") throw new Error("BUY_APPROVAL_FORBIDDEN");
      const decoded = decodeApproval(transaction);
      if (value !== 0n) throw new Error("VALUE_BEARING_APPROVAL_FORBIDDEN");
      if (address(transaction.to) !== address(quote.targetToken)) throw new Error("APPROVAL_TOKEN_MISMATCH");
      if (!this.config.spenders.includes(decoded.spender)) throw new Error("SPENDER_NOT_ALLOWLISTED");
      if (decoded.amount !== tradeAmount) throw new Error("NON_EXACT_APPROVAL_FORBIDDEN");
    } else {
      if (!this.config.routers.includes(address(transaction.to))) throw new Error("ROUTER_NOT_ALLOWLISTED");
      if (direction === "SELL" && value !== 0n) throw new Error("VALUE_BEARING_SELL_FORBIDDEN");
      // A native-in BUY must carry exactly the quoted amount; the cap is enforced on what the wallet would send,
      // not only on what the quote claims. A zero-value BUY is a token-in swap and is capped by the quote amount.
      if (direction === "BUY" && value !== 0n && value !== tradeAmount) throw new Error("QUOTE_VALUE_MISMATCH");
    }
    if (direction === "BUY") {
      if (tradeAmount > amount(this.config.maxTransactionWei, "TRANSACTION_CAP")) throw new Error("TRANSACTION_CAP_EXCEEDED");
    } else {
      const token = address(quote.targetToken);
      const tokenCap = this.config.maxSellAmountByToken?.[token];
      if (tokenCap === undefined) throw new Error("SELL_TOKEN_CAP_REQUIRED");
      if (tradeAmount > amount(tokenCap, "SELL_TOKEN_CAP")) throw new Error("TRANSACTION_CAP_EXCEEDED");
    }
    let reservation = null;
    if (direction === "BUY" && operation === "TRADE") {
      const configuredCap = amount(this.config.maxDailySpendWei, "DAILY_CAP");
      const delegatedCap = dailySpendCapWei === null ? configuredCap : amount(dailySpendCapWei, "DAILY_CAP");
      reservation = await this.spendLedger.reserve({ intentId, userId, utcDay, amountWei: tradeAmount, maxDailySpendWei: (delegatedCap < configuredCap ? delegatedCap : configuredCap).toString() });
    }
    return Object.freeze({ authorized: true, selector, reservation });
  }
}
