const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{64}$/;
const BUY_SELECTOR = "0xa59ac6dd";

function asWei(value, code) {
  try { const parsed = BigInt(value); if (parsed < 0n) throw new Error(); return parsed; } catch { throw new Error(code); }
}

export function parsePrivyWalletRef(value) {
  const match = /^privy-wallet:([a-zA-Z0-9_-]{8,128})$/.exec(String(value || ""));
  if (!match) throw new Error("INVALID_PRIVY_WALLET_REFERENCE");
  return match[1];
}

export function validateSubmission(payload, config, now = Math.floor(Date.now() / 1000)) {
  if (!payload || typeof payload !== "object") throw new Error("INVALID_SUBMISSION");
  for (const forbidden of ["privateKey", "seed", "mnemonic", "signature", "signedTransaction", "rawTransaction"]) {
    if (payload[forbidden] || payload.transaction?.[forbidden]) throw new Error("SECRET_OR_SIGNED_MATERIAL_FORBIDDEN");
  }
  if (!ID.test(payload.intentId || "")) throw new Error("INVALID_INTENT_ID");
  if (!ADDRESS.test(String(payload.walletAddress || "").toLowerCase())) throw new Error("INVALID_WALLET_ADDRESS");
  const walletId = parsePrivyWalletRef(payload.authorizationRef);
  if (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now || payload.expiresAt > now + config.maxTtlSeconds) throw new Error("INVALID_SUBMISSION_EXPIRY");
  const tx = payload.transaction;
  if (!tx || tx.chainId !== config.chainId || String(tx.to || "").toLowerCase() !== config.executorAddress) throw new Error("EXECUTOR_TARGET_NOT_ALLOWED");
  if (!/^0x[0-9a-f]*$/.test(tx.data || "") || tx.data.slice(0, 10) !== BUY_SELECTOR || tx.data.length !== 202) throw new Error("BUY_CALL_REQUIRED");
  const value = asWei(tx.value, "INVALID_TRANSACTION_VALUE");
  if (value <= 0n || value > config.maxTransactionWei) throw new Error("EXECUTOR_TRANSACTION_CAP_EXCEEDED");
  const encodedAmount = BigInt(`0x${tx.data.slice(74, 138)}`);
  if (encodedAmount !== value) throw new Error("EXECUTOR_VALUE_MISMATCH");
  return Object.freeze({
    intentId: payload.intentId,
    walletAddress: payload.walletAddress.toLowerCase(),
    walletId,
    expiresAt: payload.expiresAt,
    transaction: Object.freeze({ chainId: tx.chainId, to: config.executorAddress, value: value.toString(), data: tx.data }),
  });
}

export class MemorySubmissionStore {
  constructor() { this.rows = new Map(); }
  async get(id) { return this.rows.get(id) ? structuredClone(this.rows.get(id)) : null; }
  async claim(id, now) {
    if (this.rows.has(id)) return { claimed: false, row: structuredClone(this.rows.get(id)) };
    const row = { id, state: "PENDING", transactionHash: null, createdAt: now, updatedAt: now };
    this.rows.set(id, row);
    return { claimed: true, row: structuredClone(row) };
  }
  async markSubmitted(id, transactionHash, now) { const row = this.rows.get(id); row.state = "SUBMITTED"; row.transactionHash = transactionHash; row.updatedAt = now; }
  async markUncertain(id, now) { const row = this.rows.get(id); row.state = "UNCERTAIN"; row.updatedAt = now; }
}

/** Thin adapter over the official Privy client. Secrets stay in the isolated executor runtime. */
export class PrivyDelegatedWalletClient {
  constructor({ client, authorizationPrivateKey }) {
    if (!client?.wallets) throw new Error("PRIVY_CLIENT_REQUIRED");
    if (typeof authorizationPrivateKey !== "string" || authorizationPrivateKey.length < 40) throw new Error("PRIVY_AUTHORIZATION_KEY_REQUIRED");
    this.client = client;
    this.authorizationPrivateKey = authorizationPrivateKey;
  }
  async send({ intentId, walletId, expiresAt, transaction }) {
    const response = await this.client.wallets().ethereum().sendTransaction(walletId, {
      caip2: `eip155:${transaction.chainId}`,
      params: { transaction: { to: transaction.to, data: transaction.data, value: `0x${BigInt(transaction.value).toString(16)}` } },
      authorization_context: { authorization_private_keys: [this.authorizationPrivateKey] },
      idempotency_key: intentId,
      request_expiry: expiresAt * 1000,
    });
    const hash = String(response?.hash || response?.data?.hash || "").toLowerCase();
    if (!HASH.test(hash)) throw new Error("PRIVY_SUBMISSION_UNCERTAIN");
    return Object.freeze({ transactionHash: hash });
  }
}

export class D1SubmissionStore {
  constructor(db) { if (!db?.prepare) throw new Error("EXECUTOR_DB_REQUIRED"); this.db = db; }
  async get(id) { return this.db.prepare("SELECT id, state, transaction_hash AS transactionHash, created_at AS createdAt, updated_at AS updatedAt FROM delegated_submissions WHERE id = ?").bind(id).first(); }
  async claim(id, now) {
    const result = await this.db.prepare("INSERT OR IGNORE INTO delegated_submissions (id, state, created_at, updated_at) VALUES (?, 'PENDING', ?, ?)").bind(id, now, now).run();
    return { claimed: Number(result?.meta?.changes || 0) === 1, row: await this.get(id) };
  }
  async markSubmitted(id, transactionHash, now) { await this.db.prepare("UPDATE delegated_submissions SET state = 'SUBMITTED', transaction_hash = ?, updated_at = ? WHERE id = ? AND state = 'PENDING'").bind(transactionHash, now, id).run(); }
  async markUncertain(id, now) { await this.db.prepare("UPDATE delegated_submissions SET state = 'UNCERTAIN', updated_at = ? WHERE id = ? AND state = 'PENDING'").bind(now, id).run(); }
}

export class DelegatedExecutor {
  constructor({ config, store, walletClient, clock = () => Math.floor(Date.now() / 1000) }) {
    if (!config || !ADDRESS.test(config.executorAddress || "") || !Number.isSafeInteger(config.chainId)) throw new Error("INVALID_EXECUTOR_CONFIG");
    this.config = Object.freeze({ ...config, maxTransactionWei: asWei(config.maxTransactionWei, "INVALID_EXECUTOR_CAP"), maxTtlSeconds: Number(config.maxTtlSeconds || 120) });
    if (this.config.maxTransactionWei <= 0n || !Number.isSafeInteger(this.config.maxTtlSeconds) || this.config.maxTtlSeconds <= 0) throw new Error("INVALID_EXECUTOR_CONFIG");
    this.store = store;
    this.walletClient = walletClient;
    this.clock = clock;
  }

  async submit(payload) {
    if (!this.config.enabled || this.config.globallyPaused) throw new Error("EXECUTOR_KILL_SWITCH_ACTIVE");
    const now = this.clock();
    const input = validateSubmission(payload, this.config, now);
    const claim = await this.store.claim(input.intentId, now);
    if (!claim.claimed) {
      if (claim.row.state === "SUBMITTED" && HASH.test(claim.row.transactionHash || "")) return Object.freeze({ transactionHash: claim.row.transactionHash, duplicate: true });
      throw new Error("EXECUTOR_RECONCILIATION_REQUIRED");
    }
    try {
      const result = await this.walletClient.send(input);
      await this.store.markSubmitted(input.intentId, result.transactionHash, this.clock());
      return result;
    } catch {
      await this.store.markUncertain(input.intentId, this.clock());
      throw new Error("DELEGATED_SUBMISSION_UNCERTAIN");
    }
  }
}

export function createExecutorHandler(executor) {
  return async function handle(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/submit") return new Response(JSON.stringify({ ok: false, why: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
    try {
      const result = await executor.submit(await request.json());
      return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (error) {
      const status = error.message === "EXECUTOR_KILL_SWITCH_ACTIVE" ? 423 : error.message === "EXECUTOR_RECONCILIATION_REQUIRED" ? 409 : 400;
      return new Response(JSON.stringify({ ok: false, why: error.message }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
  };
}
