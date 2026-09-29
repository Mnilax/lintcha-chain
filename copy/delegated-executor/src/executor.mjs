import { createHash } from "node:crypto";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{64}$/;
const BUY_SELECTOR = "0xa59ac6dd";
const POLICY_CONTENT_SHA256 = /^[0-9a-f]{64}$/;
const POLICY_ID = /^[a-zA-Z0-9_-]{8,160}$/;
const CANONICAL_DECIMAL_UINT = /^(?:0|[1-9][0-9]*)$/;
const CANONICAL_HEX_UINT = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;

function asWei(value, code) {
  try { const parsed = BigInt(value); if (parsed < 0n) throw new Error(); return parsed; } catch { throw new Error(code); }
}

function canonicalPolicyUint(value) {
  if (typeof value !== "string" || (!CANONICAL_DECIMAL_UINT.test(value) && !CANONICAL_HEX_UINT.test(value))) throw new Error("PRIVY_POLICY_CONTENT_MISMATCH");
  try { return BigInt(value); } catch { throw new Error("PRIVY_POLICY_CONTENT_MISMATCH"); }
}

function policySecurityProjection(policy, expected) {
  if (!policy || policy.id !== expected.policyId || policy.chain_type !== "ethereum" || policy.version !== "1.0" || policy.owner_id === null || policy.owner_id !== expected.expectedOwnerId) throw new Error("PRIVY_POLICY_CONTENT_MISMATCH");
  if (!Array.isArray(policy.rules) || policy.rules.length !== 1) throw new Error("PRIVY_POLICY_CONTENT_MISMATCH");
  const rule = policy.rules[0];
  if (rule?.action !== "ALLOW" || rule?.method !== "eth_sendTransaction" || !Array.isArray(rule.conditions) || rule.conditions.length !== 4) throw new Error("PRIVY_POLICY_CONTENT_MISMATCH");

  const conditions = new Map();
  for (const condition of rule.conditions) {
    const key = `${condition?.field_source || ""}:${condition?.field || ""}`;
    if (conditions.has(key)) throw new Error("PRIVY_POLICY_CONTENT_MISMATCH");
    conditions.set(key, condition);
  }
  const chain = conditions.get("ethereum_transaction:chain_id");
  const to = conditions.get("ethereum_transaction:to");
  const value = conditions.get("ethereum_transaction:value");
  const calldata = conditions.get("ethereum_calldata:function_name");
  if (!chain || !to || !value || !calldata || conditions.size !== 4) throw new Error("PRIVY_POLICY_CONTENT_MISMATCH");
  if (chain.operator !== "eq" || chain.value !== String(expected.chainId)) throw new Error("PRIVY_POLICY_CONTENT_MISMATCH");
  if (to.operator !== "eq" || typeof to.value !== "string" || String(to.value).toLowerCase() !== expected.wrapperAddress) throw new Error("PRIVY_POLICY_CONTENT_MISMATCH");
  if (value.operator !== "lte" || canonicalPolicyUint(value.value) !== expected.maxTransactionWei) throw new Error("PRIVY_POLICY_CONTENT_MISMATCH");
  if (calldata.operator !== "eq" || calldata.value !== "buy" || !Array.isArray(calldata.abi) || calldata.abi.length !== 1) throw new Error("PRIVY_POLICY_CONTENT_MISMATCH");

  const abi = calldata.abi[0];
  const inputTypes = Array.isArray(abi?.inputs) ? abi.inputs.map((input) => input?.type) : null;
  if (abi?.type !== "function" || abi?.name !== "buy" || abi?.stateMutability !== "payable" || !inputTypes || inputTypes.length !== 3 || inputTypes[0] !== "address" || inputTypes[1] !== "uint256" || inputTypes[2] !== "uint256" || !Array.isArray(abi.outputs) || abi.outputs.length !== 0) throw new Error("PRIVY_POLICY_CONTENT_MISMATCH");

  return {
    chain_type: "ethereum",
    version: "1.0",
    owner_id: expected.expectedOwnerId,
    rules: [{
      action: "ALLOW",
      method: "eth_sendTransaction",
      conditions: [
        { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: String(expected.chainId) },
        { field_source: "ethereum_transaction", field: "to", operator: "eq", value: expected.wrapperAddress },
        { field_source: "ethereum_transaction", field: "value", operator: "lte", value: expected.maxTransactionWei.toString() },
        { field_source: "ethereum_calldata", field: "function_name", operator: "eq", value: "buy", abi: [{ type: "function", name: "buy", stateMutability: "payable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }], outputs: [] }] },
      ],
    }],
  };
}

function sha256Canonical(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function parsePrivyWalletRef(value) {
  const match = /^privy-wallet:([a-zA-Z0-9_-]{8,128})(?::[0-9a-f]{32})?$/.exec(String(value || ""));
  if (!match) throw new Error("INVALID_PRIVY_WALLET_REFERENCE");
  return match[1];
}

function publicVerificationInput(payload) {
  if (!payload || typeof payload !== "object") throw new Error("INVALID_DELEGATION_VERIFICATION");
  for (const forbidden of ["privateKey", "seed", "mnemonic", "signature", "signedTransaction", "rawTransaction", "authorizationPrivateKey"]) {
    if (payload[forbidden]) throw new Error("SECRET_OR_SIGNED_MATERIAL_FORBIDDEN");
  }
  const telegramUserId = String(payload.telegramUserId || "");
  if (!/^\d{1,20}$/.test(telegramUserId)) throw new Error("INVALID_TELEGRAM_USER_ID");
  const walletAddress = String(payload.walletAddress || "").toLowerCase();
  if (!ADDRESS.test(walletAddress)) throw new Error("INVALID_WALLET_ADDRESS");
  return Object.freeze({ telegramUserId, walletAddress });
}

function authorizationInput(payload) {
  const input = publicVerificationInput(payload);
  const authorizationRef = String(payload.authorizationRef || "");
  const walletId = parsePrivyWalletRef(authorizationRef);
  return Object.freeze({ ...input, walletId, authorizationRef });
}

async function resolveTelegramLinkedWallet(client, input, { delegatedOnly }) {
  const user = await client.users().getByTelegramUserID({ telegram_user_id: input.telegramUserId });
  const linkedWallets = (Array.isArray(user?.linked_accounts) ? user.linked_accounts : []).filter((account) =>
    account?.type === "wallet"
    && account?.connector_type === "embedded"
    && account?.wallet_client === "privy"
    && account?.chain_type === "ethereum"
    && (!delegatedOnly || account?.delegated === true)
    && /^[a-zA-Z0-9_-]{8,128}$/.test(account?.id || "")
    && String(account?.address || "").toLowerCase() === input.walletAddress
  );
  if (linkedWallets.length !== 1) throw new Error("PRIVY_LINKED_WALLET_MISMATCH");
  const linked = linkedWallets[0];
  if (input.walletId && input.walletId !== linked.id) throw new Error("PRIVY_WALLET_MISMATCH");
  const wallet = await client.wallets().get(linked.id);
  if (!wallet || wallet.id !== linked.id || String(wallet.address || "").toLowerCase() !== input.walletAddress || wallet.chain_type !== "ethereum") throw new Error("PRIVY_WALLET_MISMATCH");
  return wallet;
}

function assertExactDelegatedSigner(wallet, signerId, policyId) {
  if (wallet.archived_at) throw new Error("PRIVY_WALLET_NOT_ACTIVE");
  if (!Array.isArray(wallet.additional_signers) || wallet.additional_signers.length !== 1 || wallet.additional_signers[0]?.signer_id !== signerId) throw new Error("PRIVY_SIGNER_SET_MISMATCH");
  const effectivePolicies = wallet.additional_signers[0].override_policy_ids;
  if (!Array.isArray(effectivePolicies) || effectivePolicies.length !== 1 || effectivePolicies[0] !== policyId) throw new Error("PRIVY_SIGNER_POLICY_MISMATCH");
}

/** Resolves the Telegram user's exact embedded wallet, then proves the configured signer + policy are attached. */
export class PrivyDelegationVerifier {
  constructor({ client, signerId, policyId, chainId, wrapperAddress, maxTransactionWei, expectedOwnerId, policyContentSha256 }) {
    if (!client?.users || !client?.wallets || !client?.policies || !POLICY_ID.test(signerId || "") || !POLICY_ID.test(policyId || "") || !Number.isSafeInteger(chainId) || chainId <= 0 || !ADDRESS.test(wrapperAddress || "") || !POLICY_ID.test(expectedOwnerId || "") || !POLICY_CONTENT_SHA256.test(policyContentSha256 || "")) throw new Error("INVALID_DELEGATION_VERIFIER_CONFIG");
    const cap = asWei(maxTransactionWei, "INVALID_DELEGATION_VERIFIER_CONFIG");
    if (cap <= 0n) throw new Error("INVALID_DELEGATION_VERIFIER_CONFIG");
    this.client = client;
    this.signerId = signerId;
    this.policyId = policyId;
    this.chainId = chainId;
    this.wrapperAddress = wrapperAddress;
    this.maxTransactionWei = cap;
    this.expectedOwnerId = expectedOwnerId;
    this.policyContentSha256 = policyContentSha256;
  }
  async verifyPolicy() {
    const policy = await this.client.policies().get(this.policyId);
    const projection = policySecurityProjection(policy, this);
    const actualHash = sha256Canonical(projection);
    if (actualHash !== this.policyContentSha256) throw new Error("PRIVY_POLICY_HASH_MISMATCH");
    return Object.freeze({ policyContentSha256: actualHash });
  }
  async verify(payload) {
    const input = publicVerificationInput(payload);
    const wallet = await resolveTelegramLinkedWallet(this.client, input, { delegatedOnly: true });
    assertExactDelegatedSigner(wallet, this.signerId, this.policyId);
    const policyVerification = await this.verifyPolicy();
    return Object.freeze({ architecture: "PRIVY_TEE", authorizationRef: `privy-wallet:${wallet.id}`, walletAddress: input.walletAddress, chainId: this.chainId, policyContentSha256: policyVerification.policyContentSha256 });
  }
  async verifySubmissionAuthorization(payload) {
    const input = authorizationInput(payload);
    const wallet = await resolveTelegramLinkedWallet(this.client, input, { delegatedOnly: true });
    assertExactDelegatedSigner(wallet, this.signerId, this.policyId);
    const policyVerification = await this.verifyPolicy();
    return Object.freeze({ authorized: true, telegramUserId: input.telegramUserId, walletAddress: input.walletAddress, authorizationRef: input.authorizationRef, chainId: this.chainId, policyContentSha256: policyVerification.policyContentSha256 });
  }
  async verifyWalletPreflight(payload) {
    const input = publicVerificationInput(payload);
    const wallet = await resolveTelegramLinkedWallet(this.client, input, { delegatedOnly: false });
    if (wallet.archived_at) throw new Error("PRIVY_WALLET_NOT_ACTIVE");
    if (!Array.isArray(wallet.additional_signers) || wallet.additional_signers.length !== 0) throw new Error("PRIVY_WALLET_PREFLIGHT_SIGNERS_PRESENT");
    return Object.freeze({ eligible: true, walletAddress: input.walletAddress, chainId: this.chainId });
  }
  async verifyRemovalReadiness(payload) {
    const input = authorizationInput(payload);
    const wallet = await resolveTelegramLinkedWallet(this.client, input, { delegatedOnly: false });
    assertExactDelegatedSigner(wallet, this.signerId, this.policyId);
    return Object.freeze({ ready: true, walletAddress: input.walletAddress, authorizationRef: input.authorizationRef, chainId: this.chainId });
  }
  async verifyRevocation(payload) {
    const input = authorizationInput(payload);
    const wallet = await resolveTelegramLinkedWallet(this.client, input, { delegatedOnly: false });
    if (!Array.isArray(wallet.additional_signers)) throw new Error("PRIVY_SIGNER_STATE_UNAVAILABLE");
    const signerStillPresent = wallet.additional_signers.some((item) => item?.signer_id === this.signerId);
    if (signerStillPresent) throw new Error("PRIVY_SIGNER_STILL_DELEGATED");
    return Object.freeze({ revoked: true, architecture: "PRIVY_TEE", authorizationRef: input.authorizationRef, telegramUserId: input.telegramUserId, walletAddress: input.walletAddress, chainId: this.chainId });
  }
}

export function validateSubmission(payload, config, now = Math.floor(Date.now() / 1000)) {
  if (!payload || typeof payload !== "object") throw new Error("INVALID_SUBMISSION");
  for (const forbidden of ["privateKey", "seed", "mnemonic", "signature", "signedTransaction", "rawTransaction"]) {
    if (payload[forbidden] || payload.transaction?.[forbidden]) throw new Error("SECRET_OR_SIGNED_MATERIAL_FORBIDDEN");
  }
  if (!ID.test(payload.intentId || "")) throw new Error("INVALID_INTENT_ID");
  const authorization = authorizationInput(payload);
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
    telegramUserId: authorization.telegramUserId,
    walletAddress: authorization.walletAddress,
    authorizationRef: authorization.authorizationRef,
    walletId: authorization.walletId,
    expiresAt: payload.expiresAt,
    transaction: Object.freeze({ chainId: tx.chainId, to: config.executorAddress, value: value.toString(), data: tx.data }),
  });
}

export class MemorySubmissionStore {
  constructor() { this.rows = new Map(); this.authorizationBlocks = new Map(); }
  async get(id) { return this.rows.get(id) ? structuredClone(this.rows.get(id)) : null; }
  #authorizationKey(input) { return input.walletAddress; }
  async blockAuthorization(value, now) {
    const input = authorizationInput(value);
    const key = this.#authorizationKey(input);
    const existing = this.authorizationBlocks.get(key);
    if (existing) return { ...structuredClone(existing), duplicate: true };
    const row = { blocked: true, telegramUserId: input.telegramUserId, walletAddress: input.walletAddress, authorizationRef: input.authorizationRef, blockedAt: now };
    this.authorizationBlocks.set(key, row);
    return { ...structuredClone(row), duplicate: false };
  }
  async isAuthorizationBlocked(value) {
    const input = authorizationInput(value);
    return this.authorizationBlocks.has(this.#authorizationKey(input));
  }
  async clearAuthorizationBlock(value) {
    const input = authorizationInput(value);
    this.authorizationBlocks.delete(this.#authorizationKey(input));
    return { authorizationBlockCleared: true, walletAddress: input.walletAddress };
  }
  async claim(id, now, authorization) {
    const input = authorizationInput(authorization);
    if (this.authorizationBlocks.has(this.#authorizationKey(input))) return { claimed: false, row: null, blocked: true };
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
  async blockAuthorization(value, now) {
    const input = authorizationInput(value);
    const result = await this.db.prepare("INSERT OR IGNORE INTO delegated_authorization_blocks (telegram_user_id, wallet_address, authorization_ref, blocked_at) VALUES (?, ?, ?, ?)").bind(input.telegramUserId, input.walletAddress, input.authorizationRef, now).run();
    const row = await this.db.prepare("SELECT telegram_user_id AS telegramUserId, wallet_address AS walletAddress, authorization_ref AS authorizationRef, blocked_at AS blockedAt FROM delegated_authorization_blocks WHERE wallet_address = ?").bind(input.walletAddress).first();
    return { blocked: true, ...row, duplicate: Number(result?.meta?.changes || 0) !== 1 };
  }
  async isAuthorizationBlocked(value) {
    const input = authorizationInput(value);
    return Boolean(await this.db.prepare("SELECT 1 AS blocked FROM delegated_authorization_blocks WHERE wallet_address = ?").bind(input.walletAddress).first());
  }
  async clearAuthorizationBlock(value) {
    const input = authorizationInput(value);
    await this.db.prepare("DELETE FROM delegated_authorization_blocks WHERE wallet_address = ?").bind(input.walletAddress).run();
    return { authorizationBlockCleared: true, walletAddress: input.walletAddress };
  }
  async claim(id, now, authorization) {
    const input = authorizationInput(authorization);
    const result = await this.db.prepare("INSERT OR IGNORE INTO delegated_submissions (id, state, created_at, updated_at) SELECT ?, 'PENDING', ?, ? WHERE NOT EXISTS (SELECT 1 FROM delegated_authorization_blocks WHERE wallet_address = ?)").bind(id, now, now, input.walletAddress).run();
    const claimed = Number(result?.meta?.changes || 0) === 1;
    if (claimed) return { claimed: true, row: await this.get(id), blocked: false };
    const blocked = await this.isAuthorizationBlocked(input);
    return { claimed: false, row: await this.get(id), blocked };
  }
  async markSubmitted(id, transactionHash, now) { await this.db.prepare("UPDATE delegated_submissions SET state = 'SUBMITTED', transaction_hash = ?, updated_at = ? WHERE id = ? AND state = 'PENDING'").bind(transactionHash, now, id).run(); }
  async markUncertain(id, now) { await this.db.prepare("UPDATE delegated_submissions SET state = 'UNCERTAIN', updated_at = ? WHERE id = ? AND state = 'PENDING'").bind(now, id).run(); }
}

export class DelegatedExecutor {
  constructor({ config, store, walletClient, delegationVerifier = null, clock = () => Math.floor(Date.now() / 1000) }) {
    if (!config || !ADDRESS.test(config.executorAddress || "") || !Number.isSafeInteger(config.chainId)) throw new Error("INVALID_EXECUTOR_CONFIG");
    this.config = Object.freeze({ ...config, maxTransactionWei: asWei(config.maxTransactionWei, "INVALID_EXECUTOR_CAP"), maxTtlSeconds: Number(config.maxTtlSeconds || 120) });
    if (this.config.maxTransactionWei <= 0n || !Number.isSafeInteger(this.config.maxTtlSeconds) || this.config.maxTtlSeconds <= 0) throw new Error("INVALID_EXECUTOR_CONFIG");
    this.store = store;
    this.walletClient = walletClient;
    if (this.config.enabled && typeof delegationVerifier?.verifySubmissionAuthorization !== "function") throw new Error("DELEGATION_VERIFIER_NOT_CONFIGURED");
    this.delegationVerifier = delegationVerifier;
    this.clock = clock;
  }

  async deactivateAuthorization(payload) {
    const input = authorizationInput(payload);
    return this.store.blockAuthorization(input, this.clock());
  }

  async verifyRevocationAndClear(payload, delegationVerifier = this.delegationVerifier) {
    if (typeof delegationVerifier?.verifyRevocation !== "function") throw new Error("DELEGATION_VERIFIER_NOT_CONFIGURED");
    const verification = await delegationVerifier.verifyRevocation(payload);
    if (verification?.revoked !== true || verification.chainId !== this.config.chainId) throw new Error("DELEGATION_REVOCATION_NOT_VERIFIED");
    const input = authorizationInput(verification);
    const cleared = await this.store.clearAuthorizationBlock(input);
    return Object.freeze({ ...verification, authorizationBlockCleared: cleared.authorizationBlockCleared === true });
  }

  async submit(payload) {
    if (!this.config.enabled || this.config.globallyPaused) throw new Error("EXECUTOR_KILL_SWITCH_ACTIVE");
    const now = this.clock();
    const input = validateSubmission(payload, this.config, now);
    const verifiedAuthorization = await this.delegationVerifier.verifySubmissionAuthorization(input);
    if (verifiedAuthorization?.authorized !== true
      || verifiedAuthorization.telegramUserId !== input.telegramUserId
      || verifiedAuthorization.walletAddress !== input.walletAddress
      || verifiedAuthorization.authorizationRef !== input.authorizationRef
      || verifiedAuthorization.chainId !== this.config.chainId
      || !POLICY_CONTENT_SHA256.test(verifiedAuthorization.policyContentSha256 || "")) throw new Error("DELEGATION_VERIFICATION_FAILED");
    const claim = await this.store.claim(input.intentId, now, input);
    if (claim.blocked) throw new Error("EXECUTOR_AUTHORIZATION_BLOCKED");
    if (!claim.claimed) {
      if (claim.row?.state === "SUBMITTED" && HASH.test(claim.row.transactionHash || "")) return Object.freeze({ transactionHash: claim.row.transactionHash, duplicate: true });
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

export function createExecutorHandler(executor, delegationVerifier = null) {
  return async function handle(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || !["/submit", "/verify-wallet-preflight", "/verify-delegation", "/verify-removal-readiness", "/verify-revocation", "/wallets/deactivate"].includes(url.pathname)) return new Response(JSON.stringify({ ok: false, why: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
    try {
      const payload = await request.json();
      if (["/verify-wallet-preflight", "/verify-delegation", "/verify-removal-readiness", "/verify-revocation"].includes(url.pathname) && !delegationVerifier) throw new Error("DELEGATION_VERIFIER_NOT_CONFIGURED");
      let result;
      if (url.pathname === "/submit") result = await executor.submit(payload);
      else if (url.pathname === "/wallets/deactivate") result = await executor.deactivateAuthorization(payload);
      else if (url.pathname === "/verify-revocation") result = await executor.verifyRevocationAndClear(payload, delegationVerifier);
      else if (url.pathname === "/verify-removal-readiness") result = await delegationVerifier.verifyRemovalReadiness(payload);
      else if (url.pathname === "/verify-wallet-preflight") result = await delegationVerifier.verifyWalletPreflight(payload);
      else result = await delegationVerifier.verify(payload);
      return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (error) {
      const status = ["EXECUTOR_KILL_SWITCH_ACTIVE", "EXECUTOR_AUTHORIZATION_BLOCKED"].includes(error.message) ? 423 : ["EXECUTOR_RECONCILIATION_REQUIRED", "PRIVY_SIGNER_STILL_DELEGATED"].includes(error.message) ? 409 : error.message === "DELEGATION_VERIFIER_NOT_CONFIGURED" ? 503 : 400;
      return new Response(JSON.stringify({ ok: false, why: error.message }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
  };
}
