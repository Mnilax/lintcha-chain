const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/i;
const RESOURCE_ID = /^[a-zA-Z0-9_-]{8,160}$/;
const CONFIGURE_SELECTOR = "0xdc63f7f4";
const SET_USER_PAUSED_SELECTOR = "0xb990b559";

/** Exact decimal conversion for user-entered native amounts. Floats and exponent notation are refused. */
export function decimalToUnits(value, decimals = 18) {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(String(value ?? "").trim());
  if (!match || !Number.isSafeInteger(decimals) || decimals < 0 || (match[2]?.length || 0) > decimals) throw new Error("INVALID_NATIVE_AMOUNT");
  return (BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] || "").padEnd(decimals, "0") || "0")).toString();
}

/** Exact percent → basis-points conversion. More than two decimals are refused rather than rounded. */
export function percentToBps(value) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value ?? "").trim());
  if (!match) throw new Error("INVALID_DELEGATION_SLIPPAGE");
  const parsed = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0") || "0");
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("INVALID_DELEGATION_SLIPPAGE");
  return Number(parsed);
}

function durationToSeconds(value) {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(String(value ?? "").trim());
  if (!match) throw new Error("INVALID_DELEGATION_EXPIRY");
  const scale = 10n ** BigInt(match[2]?.length || 0);
  const hours = BigInt(match[1]) * scale + BigInt(match[2] || "0");
  const seconds = hours * 3600n / scale;
  if (seconds <= 0n || seconds > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("INVALID_DELEGATION_EXPIRY");
  return Number(seconds);
}

function limits(input, now) {
  const maxTransactionWei = decimalToUnits(input.maxTransactionNative);
  const maxDailySpendWei = decimalToUnits(input.maxDailyNative);
  const maxSlippageBps = percentToBps(input.maxSlippagePercent);
  const durationSeconds = durationToSeconds(input.durationHours);
  if (BigInt(maxTransactionWei) <= 0n || BigInt(maxDailySpendWei) < BigInt(maxTransactionWei)) throw new Error("INVALID_DELEGATION_CAP");
  const expiresAt = now + durationSeconds;
  if (!Number.isSafeInteger(expiresAt)) throw new Error("INVALID_DELEGATION_EXPIRY");
  return Object.freeze({ maxTransactionWei, maxDailySpendWei, maxSlippageBps, expiresAt });
}

function uintWord(value, bits, code) {
  let parsed;
  try { parsed = BigInt(value); } catch { throw new Error(code); }
  if (parsed < 0n || parsed >= 1n << BigInt(bits)) throw new Error(code);
  return parsed.toString(16).padStart(64, "0");
}

export function configureCalldata({ maxTransactionWei, maxDailySpendWei, maxSlippageBps, expiresAt }) {
  return `${CONFIGURE_SELECTOR}${uintWord(maxTransactionWei, 128, "INVALID_DELEGATION_CAP")}${uintWord(maxDailySpendWei, 128, "INVALID_DELEGATION_CAP")}${uintWord(maxSlippageBps, 16, "INVALID_DELEGATION_SLIPPAGE")}${uintWord(expiresAt, 64, "INVALID_DELEGATION_EXPIRY")}`;
}

export function pauseCalldata() { return `${SET_USER_PAUSED_SELECTOR}${uintWord(1, 8, "INVALID_PAUSE_VALUE")}`; }

function publicHash(value) {
  const hash = typeof value === "string" ? value : value?.transactionHash;
  if (!HASH.test(String(hash || ""))) throw new Error("INVALID_TRANSACTION_HASH");
  return hash.toLowerCase();
}

function assertNoSensitiveMaterial(value) {
  const forbidden = new Set(["privatekey", "authorizationprivatekey", "sessionkey", "seed", "mnemonic", "signature", "signedtransaction", "rawtransaction"]);
  const pending = [value];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const [key, child] of Object.entries(current)) {
      if (forbidden.has(key.replace(/[_-]/g, "").toLowerCase()) && child !== undefined && child !== null) throw new Error("SECRET_OR_SIGNED_MATERIAL_FORBIDDEN");
      pending.push(child);
    }
  }
}

async function removeConfiguredSigner(api, privyAdapter, address, signerId, policyId, chainId) {
  let state;
  try { state = await privyAdapter.getSignerState({ address }); }
  catch { throw new Error("SIGNER_STATE_UNAVAILABLE"); }
  assertNoSensitiveMaterial(state);
  const additionalSigners = state?.additionalSigners;
  const signer = Array.isArray(additionalSigners) && additionalSigners.length === 1 ? additionalSigners[0] : null;
  if (
    String(state?.walletAddress || "").toLowerCase() !== address
    || !signer || signer.signerId !== signerId
    || !Array.isArray(signer.policyIds) || signer.policyIds.length !== 1 || signer.policyIds[0] !== policyId
  ) throw new Error("SIGNER_STATE_MANUAL_RECOVERY_REQUIRED");
  const readiness = await api.verifyRemovalReadiness(address);
  if (readiness?.ready !== true || String(readiness.walletAddress || "").toLowerCase() !== address || readiness.chainId !== chainId) throw new Error("SIGNER_REMOVAL_NOT_AUTHORIZED");
  const removed = await privyAdapter.removeSigners({ address });
  assertNoSensitiveMaterial(removed);
  return removed;
}

function assertFinalizedLimits(result, expected) {
  const readback = result?.readback;
  if (result?.finalized !== true || !readback) throw new Error("WRAPPER_CONFIGURATION_NOT_FINALIZED");
  try {
    if (
      BigInt(readback.maxPerTradeWei) !== BigInt(expected.maxTransactionWei)
      || BigInt(readback.maxDailyWei) !== BigInt(expected.maxDailySpendWei)
      || Number(readback.maxSlippageBps) !== expected.maxSlippageBps
      || Number(readback.expiresAt) !== expected.expiresAt
      || readback.paused !== false
    ) throw new Error();
  } catch { throw new Error("WRAPPER_CONFIGURATION_MISMATCH"); }
  return true;
}

function assertFinalizedPause(result) {
  if (result?.finalized !== true || result?.readback?.paused !== true) throw new Error("WRAPPER_PAUSE_NOT_FINALIZED");
  return true;
}

function assertPreparedActivation(prepared, expected, { chainId, wrapperAddress }) {
  if (!prepared || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(prepared.activationToken || "") || prepared.activationToken.length > 4096) throw new Error("INVALID_ACTIVATION_CHALLENGE");
  const serverLimits = prepared.limits;
  if (!serverLimits || Object.keys(serverLimits).sort().join(",") !== "expiresAt,maxDailySpendWei,maxSlippageBps,maxTransactionWei") throw new Error("ACTIVATION_LIMITS_MISMATCH");
  if (
    serverLimits.maxTransactionWei !== expected.maxTransactionWei
    || serverLimits.maxDailySpendWei !== expected.maxDailySpendWei
    || serverLimits.maxSlippageBps !== expected.maxSlippageBps
    || serverLimits.expiresAt !== expected.expiresAt
  ) throw new Error("ACTIVATION_LIMITS_MISMATCH");
  const transaction = prepared.transaction;
  if (!transaction || Object.keys(transaction).sort().join(",") !== "chainId,data,to,value") throw new Error("ACTIVATION_TRANSACTION_MISMATCH");
  const localTransaction = { chainId, to: wrapperAddress, value: "0", data: configureCalldata(expected) };
  if (
    transaction.chainId !== localTransaction.chainId
    || transaction.to !== localTransaction.to
    || transaction.value !== localTransaction.value
    || transaction.data !== localTransaction.data
  ) throw new Error("ACTIVATION_TRANSACTION_MISMATCH");
  return Object.freeze({ activationToken: prepared.activationToken, limits: serverLimits, transaction });
}

function assertPreparedPause(transaction, { chainId, wrapperAddress }) {
  if (!transaction || Object.keys(transaction).sort().join(",") !== "chainId,data,to,value") throw new Error("PAUSE_TRANSACTION_MISMATCH");
  const expected = { chainId, to: wrapperAddress, value: "0", data: pauseCalldata() };
  if (
    transaction.chainId !== expected.chainId
    || transaction.to !== expected.to
    || transaction.value !== expected.value
    || transaction.data !== expected.data
  ) throw new Error("PAUSE_TRANSACTION_MISMATCH");
  return transaction;
}

function pendingRemoval(stage, error, extra = {}) {
  const message = String(error?.message || "");
  const reason = /^[A-Z0-9_]+$/.test(message) ? message : "REMOVAL_STEP_FAILED";
  return Object.freeze({ active: false, localShutdown: true, pendingRemoval: true, stage, reason, ...extra });
}

function signerRemovalPending(error, transactionHash) {
  const message = String(error?.message || "");
  const reason = /^[A-Z0-9_]+$/.test(message) ? message : "SIGNER_REMOVAL_FAILED";
  return Object.freeze({ active: false, activationConfirmed: false, pendingRemoval: true, state: "SIGNER_REMOVAL_PENDING", reason, transactionHash, onchainConfigured: true });
}

/**
 * Provider-neutral orchestration. Wallet, finality/readback and Privy capabilities are injected by the host;
 * this module never receives a credential, signed transaction or signature.
 */
export class AutoBuySetupController {
  constructor({ api, walletAdapter, finalityAdapter, privyAdapter, wrapperAddress, signerId, policyId, chainId = 4663, clock = () => Math.floor(Date.now() / 1000) }) {
    const normalizedWrapper = String(wrapperAddress || "").toLowerCase();
    if (
      !api?.deactivateDelegation || !api?.verifyRemovalReadiness
      || !walletAdapter?.sendTransaction || !finalityAdapter?.waitForFinalizedReadback
      || !privyAdapter?.getSignerState || !privyAdapter?.removeSigners
      || !ADDRESS.test(normalizedWrapper)
      || !RESOURCE_ID.test(signerId || "") || !RESOURCE_ID.test(policyId || "")
      || !Number.isSafeInteger(chainId)
    ) throw new Error("AUTO_BUY_SETUP_NOT_CONFIGURED");
    const activationConfigured = Boolean(
      api?.prepareDelegation && api?.verifyConfiguration && api?.activateDelegation && api?.recoverRemoval
      && privyAdapter?.addSigners
    );
    this.api = api;
    this.walletAdapter = walletAdapter;
    this.finalityAdapter = finalityAdapter;
    this.privyAdapter = privyAdapter;
    this.wrapperAddress = normalizedWrapper;
    this.signerId = signerId;
    this.policyId = policyId;
    this.chainId = chainId;
    this.clock = clock;
    this.activationConfigured = activationConfigured;
  }

  async activate(input) {
    if (!this.activationConfigured) throw new Error("AUTO_BUY_SETUP_NOT_CONFIGURED");
    const walletAddress = String(input.walletAddress || "").toLowerCase();
    if (!ADDRESS.test(walletAddress)) throw new Error("INVALID_PUBLIC_ADDRESS");
    const boundedLimits = limits(input, this.clock());
    const prepared = assertPreparedActivation(
      await this.api.prepareDelegation({ walletAddress, ...boundedLimits }),
      boundedLimits,
      { chainId: this.chainId, wrapperAddress: this.wrapperAddress },
    );
    const transactionHash = publicHash(await this.walletAdapter.sendTransaction({
      walletAddress,
      transaction: prepared.transaction,
    }));
    const finalized = await this.finalityAdapter.waitForFinalizedReadback({
      operation: "CONFIGURE", transactionHash, walletAddress, wrapperAddress: this.wrapperAddress, expected: prepared.limits,
    });
    assertFinalizedLimits(finalized, prepared.limits);
    const configuration = await this.api.verifyConfiguration({ walletAddress, activationToken: prepared.activationToken });
    if (configuration?.ready !== true || String(configuration.walletAddress || "").toLowerCase() !== walletAddress) throw new Error("SERVER_CONFIGURATION_NOT_VERIFIED");
    let permission;
    let activated;
    try {
      permission = await this.privyAdapter.addSigners({ address: walletAddress, signers: [{ signerId: this.signerId, policyIds: [this.policyId] }] });
      assertNoSensitiveMaterial(permission);
      activated = await this.api.activateDelegation({ walletAddress, activationToken: prepared.activationToken });
      if (activated?.active !== true) throw new Error("DELEGATION_ACTIVATION_NOT_CONFIRMED");
    } catch (activationError) {
      // A rejected/failed addSigners promise does not prove that Privy left the signer unattached.
      // Ask the server to prove the signer state and persist a cleanup epoch before any retry.
      let cleanup;
      try {
        await this.api.recoverRemoval({ walletAddress, activationToken: prepared.activationToken });
        cleanup = await this.deactivate(walletAddress);
      }
      catch (removalError) { return signerRemovalPending(removalError, transactionHash); }
      if (cleanup.pendingRemoval) return signerRemovalPending(new Error(cleanup.reason), transactionHash);
      throw activationError;
    }
    return Object.freeze({ ...activated, transactionHash });
  }

  async deactivate(walletAddress) {
    const normalized = String(walletAddress || "").toLowerCase();
    if (!ADDRESS.test(normalized)) throw new Error("INVALID_PUBLIC_ADDRESS");
    const shutdown = await this.api.deactivateDelegation(normalized);
    if (shutdown?.active !== false) throw new Error("LOCAL_SHUTDOWN_NOT_CONFIRMED");

    let pauseTransaction;
    try { pauseTransaction = assertPreparedPause(shutdown.pauseTransaction, { chainId: this.chainId, wrapperAddress: this.wrapperAddress }); }
    catch (error) { return pendingRemoval("PAUSE_TRANSACTION", error); }

    let transactionHash;
    try {
      transactionHash = publicHash(await this.walletAdapter.sendTransaction({
        walletAddress: normalized,
        transaction: pauseTransaction,
      }));
    } catch (error) { return pendingRemoval("ONCHAIN_PAUSE", error); }

    try {
      const finalized = await this.finalityAdapter.waitForFinalizedReadback({
        operation: "PAUSE", transactionHash, walletAddress: normalized, wrapperAddress: this.wrapperAddress, expected: { paused: true },
      });
      assertFinalizedPause(finalized);
    } catch (error) { return pendingRemoval("PAUSE_FINALITY", error, { transactionHash }); }

    try {
      await removeConfiguredSigner(this.api, this.privyAdapter, normalized, this.signerId, this.policyId, this.chainId);
    } catch (error) { return pendingRemoval("PRIVY_SIGNER_REMOVAL", error, { transactionHash, onchainPaused: true }); }

    if (this.api.finalizeDelegationRemoval) {
      try { await this.api.finalizeDelegationRemoval(normalized); }
      catch (error) { return pendingRemoval("API_FINALIZE", error, { transactionHash, onchainPaused: true, signerRemoved: true }); }
    }
    return Object.freeze({ active: false, localShutdown: true, onchainPaused: true, signerRemoved: true, pendingRemoval: false, transactionHash });
  }
}
