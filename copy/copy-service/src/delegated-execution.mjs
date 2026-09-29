const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const POLICY_CONTENT_SHA256 = /^[0-9a-f]{64}$/;

function lowerList(values, test, code) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(code);
  const normalized = [...new Set(values.map((value) => String(value).toLowerCase()))];
  if (!normalized.every(test)) throw new Error(code);
  return normalized;
}

/** Public metadata only. No session key, signature, seed or signed transaction is accepted or stored. */
export function validateDelegation(input, now = Math.floor(Date.now() / 1000)) {
  if (!input || typeof input !== "object") throw new Error("INVALID_DELEGATION");
  for (const forbidden of ["privateKey", "sessionKey", "seed", "mnemonic", "signature", "signedTransaction", "rawTransaction"]) {
    if (input[forbidden]) throw new Error("SIGNED_OR_SECRET_MATERIAL_FORBIDDEN");
  }
  const walletAddress = String(input.walletAddress || "").toLowerCase();
  if (!ADDRESS.test(walletAddress)) throw new Error("INVALID_DELEGATION_WALLET");
  if (!["PRIVY_TEE", "EIP7702_SESSION", "ERC4337_SESSION"].includes(input.architecture)) throw new Error("UNSUPPORTED_DELEGATION_ARCHITECTURE");
  if (!/^[a-zA-Z0-9:_-]{8,192}$/.test(input.authorizationRef || "")) throw new Error("INVALID_DELEGATION_REFERENCE");
  if (!Number.isSafeInteger(input.chainId)) throw new Error("INVALID_DELEGATION_CHAIN");
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) throw new Error("DELEGATION_EXPIRED");
  if (!Number.isSafeInteger(input.maxSlippageBps) || input.maxSlippageBps < 0) throw new Error("INVALID_DELEGATION_SLIPPAGE");
  for (const key of ["maxTransactionWei", "maxDailySpendWei"]) {
    try { if (BigInt(input[key]) < 0n) throw new Error(); } catch { throw new Error("INVALID_DELEGATION_CAP"); }
  }
  return Object.freeze({
    userId: String(input.userId), walletAddress, architecture: input.architecture,
    authorizationRef: input.authorizationRef, status: input.status || "ACTIVE", chainId: input.chainId,
    routers: Object.freeze(lowerList(input.routers, (value) => ADDRESS.test(value), "INVALID_DELEGATION_ROUTER")),
    selectors: Object.freeze(lowerList(input.selectors, (value) => /^0x[0-9a-f]{8}$/.test(value), "INVALID_DELEGATION_SELECTOR")),
    maxTransactionWei: String(BigInt(input.maxTransactionWei)), maxDailySpendWei: String(BigInt(input.maxDailySpendWei)),
    maxSlippageBps: input.maxSlippageBps, expiresAt: input.expiresAt, createdAt: input.createdAt || now, updatedAt: now,
  });
}

export function assertDelegationAllows(delegation, { userId, walletAddress, transaction, quote }, now) {
  if (!delegation || delegation.status !== "ACTIVE") throw new Error("ACTIVE_DELEGATION_REQUIRED");
  if (delegation.userId !== String(userId) || delegation.walletAddress !== String(walletAddress).toLowerCase()) throw new Error("DELEGATION_OWNER_MISMATCH");
  if (delegation.expiresAt <= now) throw new Error("DELEGATION_EXPIRED");
  if (delegation.chainId !== transaction.chainId) throw new Error("DELEGATION_CHAIN_NOT_ALLOWED");
  if (!delegation.routers.includes(transaction.to)) throw new Error("DELEGATION_ROUTER_NOT_ALLOWED");
  if (!delegation.selectors.includes(transaction.data.slice(0, 10))) throw new Error("DELEGATION_SELECTOR_NOT_ALLOWED");
  if (quote.direction !== "BUY") throw new Error("AUTO_SELL_FORBIDDEN");
  if (BigInt(quote.amountIn) > BigInt(delegation.maxTransactionWei)) throw new Error("DELEGATION_TRANSACTION_CAP_EXCEEDED");
  if (quote.slippageBps > delegation.maxSlippageBps) throw new Error("DELEGATION_SLIPPAGE_CAP_EXCEEDED");
  return delegation;
}

export class MemoryDelegationStore {
  constructor(clock = () => Math.floor(Date.now() / 1000)) { this.rows = new Map(); this.clock = clock; }
  async put(input) {
    const row = validateDelegation(input, this.clock());
    for (const existing of this.rows.values()) if (existing.walletAddress === row.walletAddress && existing.userId !== row.userId && existing.status === "ACTIVE" && existing.expiresAt > this.clock()) throw new Error("DELEGATION_WALLET_ALREADY_ACTIVE");
    this.rows.set(`${row.userId}:${row.walletAddress}`, { ...row }); return structuredClone(row);
  }
  async get(userId, walletAddress) { const row = this.rows.get(`${String(userId)}:${String(walletAddress).toLowerCase()}`); return row ? structuredClone(row) : null; }
  async getActive(userId, walletAddress) { const row = this.rows.get(`${String(userId)}:${String(walletAddress).toLowerCase()}`); return row?.status === "ACTIVE" && row.expiresAt > this.clock() ? structuredClone(row) : null; }
  async revoke(userId, walletAddress) { const row = this.rows.get(`${String(userId)}:${String(walletAddress).toLowerCase()}`); if (row) { row.status = "REVOKED"; row.updatedAt = this.clock(); } }
  async completeRemoval(userId, walletAddress) { this.rows.delete(`${String(userId)}:${String(walletAddress).toLowerCase()}`); }
}

export class UnconfiguredDelegatedExecutor {
  async submit() { throw new Error("DELEGATED_EXECUTOR_NOT_CONFIGURED"); }
  async verifyWalletPreflight() { throw new Error("DELEGATED_EXECUTOR_NOT_CONFIGURED"); }
  async verifyDelegation() { throw new Error("DELEGATED_EXECUTOR_NOT_CONFIGURED"); }
  async verifyRemovalReadiness() { throw new Error("DELEGATED_EXECUTOR_NOT_CONFIGURED"); }
  async deactivate() { throw new Error("DELEGATED_EXECUTOR_NOT_CONFIGURED"); }
  async verifyRevocation() { throw new Error("DELEGATED_EXECUTOR_NOT_CONFIGURED"); }
}

/** Calls a separately controlled signer/broadcaster. Copy sends only public transaction data and an opaque authorization reference. */
export class ServiceBindingDelegatedExecutor {
  constructor(binding) { this.binding = binding; }
  async submit(payload) {
    if (!this.binding?.fetch) throw new Error("DELEGATED_EXECUTOR_NOT_CONFIGURED");
    const response = await this.binding.fetch("https://delegated-executor/submit", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !HASH.test(body?.transactionHash || "")) throw new Error("DELEGATED_SUBMISSION_UNCERTAIN");
    return Object.freeze({ transactionHash: body.transactionHash.toLowerCase() });
  }
  async verifyDelegation(payload) {
    if (!this.binding?.fetch) throw new Error("DELEGATED_EXECUTOR_NOT_CONFIGURED");
    const response = await this.binding.fetch("https://delegated-executor/verify-delegation", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.architecture !== "PRIVY_TEE" || !ADDRESS.test(body?.walletAddress || "") || !/^privy-wallet:[a-zA-Z0-9_-]{8,128}$/.test(body?.authorizationRef || "") || !Number.isSafeInteger(body?.chainId) || !POLICY_CONTENT_SHA256.test(body?.policyContentSha256 || "")) throw new Error("DELEGATION_VERIFICATION_FAILED");
    return Object.freeze({ architecture: body.architecture, walletAddress: body.walletAddress, authorizationRef: body.authorizationRef, chainId: body.chainId, policyContentSha256: body.policyContentSha256 });
  }
  async verifyWalletPreflight(payload) {
    if (!this.binding?.fetch) throw new Error("DELEGATED_EXECUTOR_NOT_CONFIGURED");
    const response = await this.binding.fetch("https://delegated-executor/verify-wallet-preflight", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => null);
    if (!response.ok || !ADDRESS.test(body?.walletAddress || "") || !Number.isSafeInteger(body?.chainId) || body?.eligible !== true) throw new Error("DELEGATION_PREFLIGHT_FAILED");
    return Object.freeze({ eligible: true, walletAddress: body.walletAddress.toLowerCase(), chainId: body.chainId });
  }
  async verifyRemovalReadiness(payload) {
    if (!this.binding?.fetch) throw new Error("DELEGATED_EXECUTOR_NOT_CONFIGURED");
    const response = await this.binding.fetch("https://delegated-executor/verify-removal-readiness", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => null);
    if (
      !response.ok || body?.ready !== true || !ADDRESS.test(body?.walletAddress || "")
      || body.walletAddress.toLowerCase() !== String(payload.walletAddress).toLowerCase()
      || body.authorizationRef !== payload.authorizationRef || !Number.isSafeInteger(body.chainId)
    ) throw new Error("DELEGATION_REMOVAL_NOT_READY");
    return Object.freeze({ ready: true, walletAddress: body.walletAddress.toLowerCase(), authorizationRef: body.authorizationRef, chainId: body.chainId });
  }
  async deactivate(payload) {
    if (!this.binding?.fetch) throw new Error("DELEGATED_EXECUTOR_NOT_CONFIGURED");
    const response = await this.binding.fetch("https://delegated-executor/wallets/deactivate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.blocked !== true) throw new Error("DELEGATED_EXECUTOR_DEACTIVATION_PENDING");
    return Object.freeze({ blocked: true });
  }
  async verifyRevocation(payload) {
    if (!this.binding?.fetch) throw new Error("DELEGATED_EXECUTOR_NOT_CONFIGURED");
    const response = await this.binding.fetch("https://delegated-executor/verify-revocation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.revoked !== true || !ADDRESS.test(body?.walletAddress || "")) throw new Error("DELEGATION_REVOCATION_NOT_VERIFIED");
    return Object.freeze({ revoked: true, walletAddress: body.walletAddress.toLowerCase() });
  }
}
