const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Exact decimal conversion for user-entered native amounts. Floats and exponent notation are refused. */
export function decimalToUnits(value, decimals = 18) {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(String(value || "").trim());
  if (!match || (match[2]?.length || 0) > decimals) throw new Error("INVALID_NATIVE_AMOUNT");
  return (BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] || "").padEnd(decimals, "0") || "0")).toString();
}

function limits(input, now) {
  const maxTransactionWei = decimalToUnits(input.maxTransactionNative);
  const maxDailySpendWei = decimalToUnits(input.maxDailyNative);
  const maxSlippageBps = Math.round(Number(input.maxSlippagePercent) * 100);
  const durationSeconds = Math.round(Number(input.durationHours) * 3600);
  if (BigInt(maxTransactionWei) <= 0n || BigInt(maxDailySpendWei) < BigInt(maxTransactionWei)) throw new Error("INVALID_DELEGATION_CAP");
  if (!Number.isSafeInteger(maxSlippageBps) || maxSlippageBps < 0) throw new Error("INVALID_DELEGATION_SLIPPAGE");
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds <= 0) throw new Error("INVALID_DELEGATION_EXPIRY");
  return Object.freeze({ maxTransactionWei, maxDailySpendWei, maxSlippageBps, expiresAt: now + durationSeconds });
}

/**
 * Provider-neutral bridge around Privy's explicit consent UI.
 * The adapter must call `useHeadlessDelegatedActions().delegateWallet(...)` and return only the wallet's
 * public address. The private executor resolves the Privy wallet id and independently verifies signer and policy attachment.
 */
export class AutoBuySetupController {
  constructor({ api, privyAdapter, clock = () => Math.floor(Date.now() / 1000) }) {
    if (!api?.activateDelegation || !api?.deactivateDelegation || !privyAdapter?.delegateWallet) throw new Error("AUTO_BUY_SETUP_NOT_CONFIGURED");
    this.api = api;
    this.privyAdapter = privyAdapter;
    this.clock = clock;
  }
  async activate(input) {
    const walletAddress = String(input.walletAddress || "").toLowerCase();
    if (!ADDRESS.test(walletAddress)) throw new Error("INVALID_PRIVY_PERMISSION_RESULT");
    const boundedLimits = limits(input, this.clock());
    const permission = await this.privyAdapter.delegateWallet({ address: walletAddress, chainType: "ethereum" });
    for (const forbidden of ["privateKey", "authorizationPrivateKey", "sessionKey", "seed", "mnemonic", "signature"]) if (permission?.[forbidden]) throw new Error("SECRET_OR_SIGNED_MATERIAL_FORBIDDEN");
    return this.api.activateDelegation({ walletAddress, ...boundedLimits });
  }
  async deactivate(walletAddress) {
    const normalized = String(walletAddress || "").toLowerCase();
    if (!ADDRESS.test(normalized)) throw new Error("INVALID_PUBLIC_ADDRESS");
    return this.api.deactivateDelegation(normalized);
  }
}
