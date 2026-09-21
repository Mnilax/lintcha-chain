import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { RpcError } from "./rpc-pool.mjs";
import { assertDelegationAllows, UnconfiguredDelegatedExecutor } from "./delegated-execution.mjs";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ALLOWANCE_SELECTOR = "0xdd62ed3e";

/** States that leave nothing pending on chain: a new intent for the same source trade may supersede them. */
export const RETRYABLE_TERMINAL_STATES = Object.freeze(new Set(["REJECTED", "EXPIRED", "FAILED", "CANCELLED"]));
/** States that need a human: nothing is retried, re-broadcast or released automatically. */
export const MANUAL_STATES = Object.freeze(new Set(["RECONCILIATION_REQUIRED", "DROPPED_OR_REPLACED"]));
export const OPEN_STATES = Object.freeze(new Set(["AWAITING_USER_CONFIRMATION", "CLIENT_CONFIRMING"]));
export const RECONCILABLE_STATES = Object.freeze(new Set(["SUBMITTED_PENDING_RECONCILIATION", "INCLUDED_AWAITING_SAFE"]));

function stableId(...parts) { return createHash("sha256").update(parts.map(String).join("\n")).digest("hex"); }
function encode(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function word(address) { return address.slice(2).toLowerCase().padStart(64, "0"); }
export function utcDayOf(seconds) { return new Date(seconds * 1000).toISOString().slice(0, 10); }

function assertPublicTransaction(transaction) {
  if (!transaction || !ADDRESS.test(transaction.to) || !/^0x(?:[0-9a-fA-F]{2})*$/.test(transaction.data || "") || !Number.isSafeInteger(transaction.chainId)) throw new Error("INVALID_UNSIGNED_TRANSACTION");
  if (transaction.rawTransaction || transaction.signedTransaction || transaction.privateKey || transaction.seed || transaction.mnemonic) throw new Error("SIGNED_OR_SECRET_MATERIAL_FORBIDDEN");
  let value;
  try { value = BigInt(transaction.value || 0); if (value < 0n) throw new Error(); } catch { throw new Error("INVALID_UNSIGNED_TRANSACTION"); }
  return Object.freeze({ chainId: transaction.chainId, to: transaction.to.toLowerCase(), value: value.toString(), data: transaction.data.toLowerCase() });
}

function assertPublicQuote(quote, now) {
  if (!quote || typeof quote !== "object") throw new Error("INVALID_QUOTE");
  if (!["BUY", "SELL"].includes(quote.direction)) throw new Error("INVALID_DIRECTION");
  if (typeof quote.id !== "string" || !quote.id || quote.id.length > 128) throw new Error("INVALID_QUOTE");
  if (!ADDRESS.test(quote.targetToken || "")) throw new Error("INVALID_QUOTE_TOKEN");
  for (const key of ["amountIn", "expectedOutput", "minimumOutput"]) {
    try { if (BigInt(quote[key]) < 0n) throw new Error(); } catch { throw new Error(`INVALID_QUOTE_${key.toUpperCase()}`); }
  }
  if (!Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= now) throw new Error("STALE_QUOTE");
  return Object.freeze({
    id: quote.id, direction: quote.direction, targetToken: quote.targetToken.toLowerCase(),
    amountIn: String(BigInt(quote.amountIn)), expectedOutput: String(BigInt(quote.expectedOutput)), minimumOutput: String(BigInt(quote.minimumOutput)),
    slippageBps: Number(quote.slippageBps), expiresAt: quote.expiresAt, venue: typeof quote.venue === "string" ? quote.venue.slice(0, 64) : null,
  });
}

function assertAddress(value, label) {
  if (!ADDRESS.test(value || "")) throw new Error(`INVALID_${label}`);
  return value.toLowerCase();
}

export class ConfirmationTokenCodec {
  constructor(secret) {
    if (!Buffer.isBuffer(secret) || secret.length < 32) throw new Error("CONFIRMATION_SECRET_REQUIRED");
    this.secret = secret;
  }
  issue(payload) {
    const body = encode(payload);
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }
  verify(token) {
    const [body, signature, extra] = String(token).split(".");
    if (!body || !signature || extra || body.length > 2048) throw new Error("INVALID_CONFIRMATION_TOKEN");
    const expected = createHmac("sha256", this.secret).update(body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("INVALID_CONFIRMATION_TOKEN");
    try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new Error("INVALID_CONFIRMATION_TOKEN"); }
  }
}

/**
 * Intent store contract (implemented in memory here and on D1 in cloudflare/d1-store.mjs):
 *   claim(row)            -> { row, duplicate }   atomic on replayKey
 *   supersede(old, row)   -> row                  remaps the replay key to a fresh intent
 *   get(id) / save(row) / listByStates(states, limit) / listByUser(userId, limit)
 */
export class MemoryIntentStore {
  constructor() { this.rows = new Map(); this.replays = new Map(); }
  async claim(row) {
    const existingId = this.replays.get(row.replayKey);
    if (existingId) return { row: this.rows.get(existingId), duplicate: true };
    this.rows.set(row.id, row); this.replays.set(row.replayKey, row.id);
    return { row, duplicate: false };
  }
  async supersede(oldRow, row) {
    oldRow.replayKey = `${oldRow.replayKey}#superseded#${row.id}`;
    this.rows.set(row.id, row); this.replays.set(row.replayKey, row.id);
    return row;
  }
  async get(id) { return this.rows.get(id) || null; }
  async save(row) { this.rows.set(row.id, row); return row; }
  async listByStates(states, limit = 100) { return [...this.rows.values()].filter((row) => states.has(row.state)).slice(0, limit); }
  async listByUser(userId, limit = 20) { return [...this.rows.values()].filter((row) => row.userId === String(userId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit); }
}

export class LintchaCopyService {
  constructor({
    policyGate, simulator, rpcPool, auditLog, intentStore = new MemoryIntentStore(), confirmationSecret,
    delegationStore = null, delegatedExecutor = new UnconfiguredDelegatedExecutor(), autoBuyEnabled = false, delegatedSubmissionEnabled = false,
    clock = () => Math.floor(Date.now() / 1000), submissionGraceSeconds = 600, dropDeadlineSeconds = 1800,
    maxReconcileAttempts = 120, requireSafeInclusion = true,
  }) {
    this.policyGate = policyGate;
    this.simulator = simulator;
    this.rpcPool = rpcPool;
    this.auditLog = auditLog;
    this.intentStore = intentStore;
    this.delegationStore = delegationStore;
    this.delegatedExecutor = delegatedExecutor;
    this.autoBuyEnabled = autoBuyEnabled;
    this.delegatedSubmissionEnabled = delegatedSubmissionEnabled;
    this.tokens = new ConfirmationTokenCodec(confirmationSecret);
    this.clock = clock;
    this.submissionGraceSeconds = submissionGraceSeconds;
    this.dropDeadlineSeconds = dropDeadlineSeconds;
    this.maxReconcileAttempts = maxReconcileAttempts;
    this.requireSafeInclusion = requireSafeInclusion;
  }

  /** Automatic execution is BUY-only and possible only through a bounded, active public delegation record. */
  async executeAutomaticBuy({ userId, walletAddress, sourceTradeId, quote, transaction, operation = "TRADE", utcDay }) {
    if (!this.autoBuyEnabled || !this.delegatedSubmissionEnabled) throw new Error("AUTO_BUY_DISABLED");
    if (!this.delegationStore) throw new Error("DELEGATION_STORE_REQUIRED");
    const now = this.clock();
    const unsignedTransaction = assertPublicTransaction(transaction);
    const publicQuote = assertPublicQuote(quote, now);
    if (publicQuote.direction !== "BUY" || operation !== "TRADE") throw new Error(publicQuote.direction === "SELL" ? "AUTO_SELL_FORBIDDEN" : "AUTO_BUY_TRADE_ONLY");
    const publicWalletAddress = assertAddress(walletAddress, "WALLET_ADDRESS");
    if (typeof sourceTradeId !== "string" || !sourceTradeId || sourceTradeId.length > 128) throw new Error("INVALID_SOURCE_TRADE");
    const delegation = assertDelegationAllows(await this.delegationStore.getActive(userId, publicWalletAddress), { userId, walletAddress: publicWalletAddress, transaction: unsignedTransaction, quote: publicQuote }, now);
    const day = utcDay || utcDayOf(now);
    const replayKey = stableId(String(userId), publicWalletAddress, sourceTradeId, "BUY", "TRADE");
    const id = stableId("auto-buy", replayKey, publicQuote.id);
    const row = {
      id, replayKey, userId: String(userId), walletAddress: publicWalletAddress, direction: "BUY", operation: "TRADE", executionMode: "AUTO_BUY",
      sourceTradeId, utcDay: day, quote: publicQuote, transaction: unsignedTransaction, state: "CREATING", revision: 1,
      createdAt: now, updatedAt: now, expiresAt: Math.min(publicQuote.expiresAt, delegation.expiresAt), simulation: null,
      delegation: { architecture: delegation.architecture, authorizationRef: delegation.authorizationRef, expiresAt: delegation.expiresAt },
      transactionHash: null, submittedAt: null, reconcileAttempts: 0, history: [{ state: "CREATING", at: now }],
    };
    const claim = await this.intentStore.claim(row);
    if (claim.duplicate) {
      if (!RETRYABLE_TERMINAL_STATES.has(claim.row.state)) return this.#view(claim.row, true);
      if (claim.row.id === id) throw new Error("QUOTE_ALREADY_USED");
      await this.intentStore.supersede(claim.row, row);
    }
    try {
      await this.policyGate.authorize({ intentId: id, userId, walletAddress: publicWalletAddress, utcDay: day, direction: "BUY", operation: "TRADE", transaction: unsignedTransaction, quote: publicQuote, confirmationKind: "DELEGATED_AUTO_BUY", manualSell: false, dailySpendCapWei: delegation.maxDailySpendWei });
      row.simulation = await this.simulator.simulate({ from: row.walletAddress, transaction: unsignedTransaction });
      if (this.clock() >= row.expiresAt) throw new Error("STALE_QUOTE");
      this.policyGate.killSwitches.assertAllowed(userId, publicWalletAddress);
      assertDelegationAllows(await this.delegationStore.getActive(userId, publicWalletAddress), { userId, walletAddress: publicWalletAddress, transaction: unsignedTransaction, quote: publicQuote }, this.clock());
      this.#transition(row, "DELEGATED_SUBMISSION_PENDING");
      await this.intentStore.save(row);
      let submission;
      try {
        submission = await this.delegatedExecutor.submit({
          intentId: id, userId: String(userId), walletAddress: publicWalletAddress, authorizationRef: delegation.authorizationRef,
          transaction: unsignedTransaction, quoteId: publicQuote.id, expiresAt: row.expiresAt,
        });
        if (!HASH.test(submission?.transactionHash || "")) throw new Error("DELEGATED_SUBMISSION_UNCERTAIN");
      } catch (error) {
        this.#transition(row, "RECONCILIATION_REQUIRED", error.message === "DELEGATED_EXECUTOR_NOT_CONFIGURED" ? error.message : "DELEGATED_SUBMISSION_UNCERTAIN");
        await this.intentStore.save(row);
        await this.auditLog.append("AUTO_BUY_SUBMISSION_UNCERTAIN", { intentId: id, userId: row.userId, reason: row.history.at(-1).reason, automaticRetry: false, reservationReleased: false });
        return this.#view(row, false);
      }
      row.transactionHash = submission.transactionHash.toLowerCase(); row.submittedAt = this.clock();
      this.#transition(row, "SUBMITTED_PENDING_RECONCILIATION");
      await this.intentStore.save(row);
      await this.auditLog.append("AUTO_BUY_SUBMITTED", { intentId: id, userId: row.userId, walletAddress: row.walletAddress, transactionHash: row.transactionHash, simulationBlock: row.simulation.blockNumber, automaticRetry: false });
      return this.#view(row, false);
    } catch (error) {
      if (row.state === "DELEGATED_SUBMISSION_PENDING" || row.state === "RECONCILIATION_REQUIRED") throw error;
      await this.policyGate.spendLedger.release(id);
      this.#transition(row, "REJECTED", error.message);
      await this.intentStore.save(row);
      await this.auditLog.append("AUTO_BUY_REJECTED", { intentId: id, userId: row.userId, reason: error.message });
      throw error;
    }
  }

  async createConfirmEachIntent({ userId, walletAddress, sourceTradeId, quote, transaction, operation = "TRADE", manualSell = false, utcDay, ttlSeconds = 90 }) {
    const now = this.clock();
    const unsignedTransaction = assertPublicTransaction(transaction);
    const publicQuote = assertPublicQuote(quote, now);
    const direction = publicQuote.direction;
    const publicWalletAddress = assertAddress(walletAddress, "WALLET_ADDRESS");
    if (typeof sourceTradeId !== "string" || !sourceTradeId || sourceTradeId.length > 128) throw new Error("INVALID_SOURCE_TRADE");
    const day = utcDay || utcDayOf(now);
    const replayKey = stableId(String(userId), publicWalletAddress, sourceTradeId, direction, operation);
    const id = stableId("confirm-each", replayKey, publicQuote.id);
    const row = {
      id, replayKey, userId: String(userId), walletAddress: publicWalletAddress, direction, operation, sourceTradeId, utcDay: day,
      quote: publicQuote, transaction: unsignedTransaction, state: "CREATING", revision: 1,
      createdAt: now, updatedAt: now, expiresAt: Math.min(publicQuote.expiresAt, now + ttlSeconds), simulation: null,
      transactionHash: null, submittedAt: null, reconcileAttempts: 0, history: [{ state: "CREATING", at: now }],
    };
    const claim = await this.intentStore.claim(row);
    if (claim.duplicate) {
      if (!RETRYABLE_TERMINAL_STATES.has(claim.row.state)) return this.#view(claim.row, true);
      if (claim.row.id === id) throw new Error("QUOTE_ALREADY_USED");
      await this.intentStore.supersede(claim.row, row);
    }
    try {
      await this.policyGate.authorize({ intentId: id, userId, walletAddress: publicWalletAddress, utcDay: day, direction, operation, transaction: unsignedTransaction, quote: publicQuote, confirmationKind: "SECURE_SHEET_EXPLICIT", manualSell });
      row.simulation = await this.simulator.simulate({ from: row.walletAddress, transaction: unsignedTransaction });
      if (direction === "SELL" && operation === "TRADE") await this.#assertSellAllowance(row);
      this.#transition(row, "AWAITING_USER_CONFIRMATION");
      await this.intentStore.save(row);
      await this.auditLog.append("CONFIRM_EACH_INTENT_CREATED", { intentId: id, userId: row.userId, walletAddress: row.walletAddress, direction, operation, sourceTradeId, simulationBlock: row.simulation.blockNumber, superseded: claim.duplicate ? claim.row.id : null });
      return this.#view(row, false);
    } catch (error) {
      await this.policyGate.spendLedger.release(id);
      this.#transition(row, "REJECTED", error.message);
      await this.intentStore.save(row);
      await this.auditLog.append("CONFIRM_EACH_INTENT_REJECTED", { intentId: id, userId: row.userId, reason: error.message });
      throw error;
    }
  }

  /** The user's wallet must already allow the router to move exactly the quoted amount; the trade is never bundled with an approval. */
  async #assertSellAllowance(row) {
    const data = `${ALLOWANCE_SELECTOR}${word(row.walletAddress)}${word(row.transaction.to)}`;
    const blockTag = `0x${row.simulation.blockNumber.toString(16)}`;
    const raw = await this.rpcPool.quorumRead("eth_call", [{ to: row.quote.targetToken, data }, blockTag]);
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw || "")) throw new Error("SELL_ALLOWANCE_UNREADABLE");
    if (BigInt(raw) < BigInt(row.quote.amountIn)) throw new Error("SELL_ALLOWANCE_INSUFFICIENT");
    row.allowanceCheckedAtBlock = row.simulation.blockNumber;
  }

  /** Issues the review payload once per revision. A second open with the same token/revision is a replay. */
  async beginSecureSheetConfirmation({ token, userId, revision }) {
    const payload = this.tokens.verify(token);
    const row = await this.intentStore.get(payload.intentId);
    if (!row || row.userId !== String(userId) || payload.userId !== String(userId)) throw new Error("CONFIRMATION_OWNER_MISMATCH");
    const now = this.clock();
    if (row.state === "EXPIRED" || now >= row.expiresAt || now >= payload.expiresAt) {
      if (OPEN_STATES.has(row.state)) { await this.policyGate.spendLedger.release(row.id); this.#transition(row, "EXPIRED", "CONFIRMATION_EXPIRED"); await this.intentStore.save(row); }
      throw new Error("CONFIRMATION_EXPIRED");
    }
    if (row.revision !== revision || payload.revision !== revision) throw new Error("CONFIRMATION_REVISION_MISMATCH");
    if (row.state !== "AWAITING_USER_CONFIRMATION") throw new Error("CONFIRMATION_REPLAYED");
    this.policyGate.killSwitches.assertAllowed(userId, row.walletAddress);
    this.#transition(row, "CLIENT_CONFIRMING");
    await this.intentStore.save(row);
    return Object.freeze({
      intentId: row.id, revision: row.revision, expiresAt: row.expiresAt, transaction: row.transaction,
      review: this.#review(row), simulation: row.simulation,
    });
  }

  /** Explicit cancel from the sheet or Telegram. Nothing was signed; the reservation is released. */
  async cancelIntent({ intentId, userId, reason = "USER_CANCELLED" }) {
    const row = await this.intentStore.get(intentId);
    if (!row || row.userId !== String(userId)) throw new Error("CANCEL_OWNER_MISMATCH");
    if (!OPEN_STATES.has(row.state)) throw new Error("NOT_CANCELLABLE");
    await this.policyGate.spendLedger.release(row.id);
    this.#transition(row, "CANCELLED", String(reason).slice(0, 64));
    await this.intentStore.save(row);
    await this.auditLog.append("CONFIRM_EACH_INTENT_CANCELLED", { intentId: row.id, userId: row.userId, reason: row.history.at(-1).reason });
    return this.#view(row, false);
  }

  /** Idempotent single-intent expiry; returns whether the row changed. Ordered per user through the coordinator. */
  async expireIntent({ intentId, now = this.clock() }) {
    const row = await this.intentStore.get(intentId);
    if (!row || !OPEN_STATES.has(row.state)) return Object.freeze({ intentId, expired: false });
    const deadline = row.state === "CLIENT_CONFIRMING" ? row.expiresAt + this.submissionGraceSeconds : row.expiresAt;
    if (now < deadline) return Object.freeze({ intentId, expired: false });
    await this.policyGate.spendLedger.release(row.id);
    this.#transition(row, "EXPIRED", "WINDOW_CLOSED");
    await this.intentStore.save(row);
    await this.auditLog.append("CONFIRM_EACH_INTENT_EXPIRED", { intentId: row.id, userId: row.userId });
    return Object.freeze({ intentId, expired: true, userId: row.userId });
  }

  /** Sweeps open intents whose window closed without a client submission and frees their reservations. */
  async expireStale({ now = this.clock(), limit = 200 } = {}) {
    const expired = [];
    for (const row of await this.intentStore.listByStates(OPEN_STATES, limit)) {
      const result = await this.expireIntent({ intentId: row.id, now });
      if (result.expired) expired.push(row.id);
    }
    return Object.freeze({ expired });
  }

  async recordClientSubmission(submission) {
    if (!submission || submission.rawTransaction || submission.signedTransaction || submission.privateKey || submission.seed || submission.mnemonic) throw new Error("SIGNED_OR_SECRET_MATERIAL_FORBIDDEN");
    const row = await this.intentStore.get(submission.intentId);
    if (!row || row.userId !== String(submission.userId)) throw new Error("SUBMISSION_OWNER_MISMATCH");
    if (!HASH.test(submission.transactionHash || "")) throw new Error("INVALID_TRANSACTION_HASH");
    const now = this.clock();
    if (row.state === "CLIENT_CONFIRMING") {
      if (row.revision !== submission.revision) throw new Error("SUBMISSION_REPLAYED");
      if (now >= row.expiresAt + this.submissionGraceSeconds) throw new Error("SUBMISSION_TOO_LATE");
    } else if (row.state === "EXPIRED" && row.history.some((item) => item.state === "CLIENT_CONFIRMING")) {
      // The wallet may have submitted just before the sweep. Keep the hash for reconciliation, but the released
      // reservation cannot be silently retaken: the intent lands in manual review instead.
      row.lateSubmission = true;
    } else {
      throw new Error("SUBMISSION_REPLAYED");
    }
    row.transactionHash = submission.transactionHash.toLowerCase();
    row.submittedAt = now;
    this.#transition(row, row.lateSubmission ? "RECONCILIATION_REQUIRED" : "SUBMITTED_PENDING_RECONCILIATION", row.lateSubmission ? "LATE_SUBMISSION" : undefined);
    await this.intentStore.save(row);
    await this.auditLog.append("CLIENT_REPORTED_SUBMISSION", { intentId: row.id, userId: row.userId, transactionHash: row.transactionHash, late: row.lateSubmission === true });
    return this.#view(row, false);
  }

  /**
   * Reads the reported hash from both providers. Outcomes: CONFIRMED (exact match, success, at or below the safe
   * block), INCLUDED_AWAITING_SAFE, FAILED (exact match but reverted), RECONCILIATION_REQUIRED (mismatch, provider
   * disagreement or exhausted attempts), DROPPED_OR_REPLACED (never seen before the drop deadline). No path
   * re-broadcasts, re-signs or releases a reservation whose spend cannot be ruled out.
   */
  async reconcile(intentId, { now = this.clock() } = {}) {
    const row = await this.intentStore.get(intentId);
    if (!row || !RECONCILABLE_STATES.has(row.state)) throw new Error("NOT_RECONCILABLE");
    row.reconcileAttempts = (row.reconcileAttempts || 0) + 1;
    let tx;
    let receipt;
    let health;
    try {
      tx = await this.rpcPool.quorumRead("eth_getTransactionByHash", [row.transactionHash]);
      receipt = await this.rpcPool.quorumRead("eth_getTransactionReceipt", [row.transactionHash]);
      health = await this.rpcPool.healthCheck();
    } catch (error) {
      const transient = error instanceof RpcError && error.message === "RPC_QUORUM_UNAVAILABLE";
      if (transient && row.reconcileAttempts < this.maxReconcileAttempts) {
        await this.intentStore.save(row);
        return Object.freeze({ ...this.#view(row, false), pending: true, automaticRetry: false, reason: "RPC_QUORUM_UNAVAILABLE" });
      }
      return this.#manual(row, transient ? "RECONCILIATION_ATTEMPTS_EXHAUSTED" : error.message);
    }
    if (!tx && !receipt) {
      if (now >= row.submittedAt + this.dropDeadlineSeconds) return this.#manual(row, "TRANSACTION_NOT_FOUND_BEFORE_DEADLINE", "DROPPED_OR_REPLACED");
      await this.intentStore.save(row);
      return Object.freeze({ ...this.#view(row, false), pending: true, automaticRetry: false, reason: "NOT_YET_SEEN" });
    }
    const exact = Boolean(tx)
      && tx.hash?.toLowerCase() === row.transactionHash
      && tx.from?.toLowerCase() === row.walletAddress
      && tx.to?.toLowerCase() === row.transaction.to
      && String(tx.input ?? tx.data ?? "").toLowerCase() === row.transaction.data
      && BigInt(tx.value || 0) === BigInt(row.transaction.value || 0);
    if (!exact) return this.#manual(row, "TRANSACTION_MISMATCH");
    if (!receipt) {
      await this.intentStore.save(row);
      return Object.freeze({ ...this.#view(row, false), pending: true, automaticRetry: false, reason: "IN_MEMPOOL" });
    }
    if (String(receipt.transactionHash || "").toLowerCase() !== row.transactionHash) return this.#manual(row, "RECEIPT_MISMATCH");
    if (receipt.status !== "0x1") {
      await this.policyGate.spendLedger.release(row.id);
      this.#transition(row, "FAILED", "REVERTED");
      await this.intentStore.save(row);
      await this.auditLog.append("RECONCILIATION_FINISHED", { intentId: row.id, state: row.state, transactionHash: row.transactionHash, automaticRetry: false });
      return this.#view(row, false);
    }
    const receiptBlock = Number(BigInt(receipt.blockNumber || 0));
    row.includedAtBlock = receiptBlock;
    row.includedBlockHash = String(receipt.blockHash || "").toLowerCase();
    if (this.requireSafeInclusion && (health.safeBlock === null || receiptBlock > health.safeBlock)) {
      if (row.state !== "INCLUDED_AWAITING_SAFE") this.#transition(row, "INCLUDED_AWAITING_SAFE");
      await this.intentStore.save(row);
      return Object.freeze({ ...this.#view(row, false), pending: true, automaticRetry: false, reason: "AWAITING_SAFE_BLOCK" });
    }
    await this.policyGate.spendLedger.commit(row.id);
    this.#transition(row, "CONFIRMED");
    await this.intentStore.save(row);
    await this.auditLog.append("RECONCILIATION_FINISHED", { intentId: row.id, state: row.state, transactionHash: row.transactionHash, includedAtBlock: receiptBlock, safeBlock: health.safeBlock, automaticRetry: false });
    return this.#view(row, false);
  }

  /** Runs one reconciliation pass over everything reconcilable; used by the scheduled trigger. */
  async reconcilePending({ now = this.clock(), limit = 50 } = {}) {
    const results = [];
    for (const row of await this.intentStore.listByStates(RECONCILABLE_STATES, limit)) {
      try { results.push(await this.reconcile(row.id, { now })); } catch (error) { results.push({ intentId: row.id, error: error.message }); }
    }
    return results;
  }

  async getIntentForUser({ intentId, userId }) {
    const row = await this.intentStore.get(intentId);
    if (!row || row.userId !== String(userId)) throw new Error("INTENT_OWNER_MISMATCH");
    return this.#view(row, false);
  }

  async listUserIntents(userId, limit = 10) {
    return (await this.intentStore.listByUser(userId, limit)).map((row) => this.#view(row, false));
  }

  async #manual(row, reason, state = "RECONCILIATION_REQUIRED") {
    this.#transition(row, state, reason);
    await this.intentStore.save(row);
    await this.auditLog.append("RECONCILIATION_BLOCKED", { intentId: row.id, state, reason, automaticRetry: false, reservationReleased: false });
    return Object.freeze({ ...this.#view(row, false), automaticRetry: false });
  }

  #transition(row, state, reason) {
    row.state = state; row.revision += 1; row.updatedAt = this.clock();
    const entry = { state, at: row.updatedAt };
    if (reason) entry.reason = reason;
    row.history.push(entry);
  }

  #view(row, duplicate) {
    const last = row.history.at(-1) || {};
    const response = {
      intentId: row.id, state: row.state, revision: row.revision, expiresAt: row.expiresAt, duplicate, executionMode: row.executionMode || "CONFIRM_EACH",
      direction: row.direction, operation: row.operation, transactionHash: row.transactionHash || null,
      reason: last.reason || null, manualAttention: MANUAL_STATES.has(row.state),
    };
    if (row.state === "AWAITING_USER_CONFIRMATION") response.confirmationToken = this.tokens.issue({ intentId: row.id, userId: row.userId, revision: row.revision, expiresAt: row.expiresAt, nonce: randomBytes(12).toString("hex") });
    return Object.freeze(response);
  }

  #review(row) {
    return Object.freeze({
      module: "Lintcha", label: "Lintcha — copy-trading", confirmation: "REQUIRED_EACH_TIME", direction: row.direction, operation: row.operation,
      token: row.quote.targetToken, amountIn: String(row.quote.amountIn), expectedOutput: String(row.quote.expectedOutput),
      minimumOutput: String(row.quote.minimumOutput), slippageBps: Number(row.quote.slippageBps), venue: row.quote.venue,
      chainId: row.transaction.chainId, target: row.transaction.to, value: row.transaction.value, selector: row.transaction.data.slice(0, 10),
      simulationBlock: row.simulation?.blockNumber ?? null, simulationBlockHash: row.simulation?.blockHash ?? null, gasLimitFloor: row.simulation?.gasLimitFloor ?? null,
      expiresAt: row.expiresAt,
    });
  }
}
