import { PrivyClient } from "@privy-io/node";
import { D1SubmissionStore, DelegatedExecutor, PrivyDelegatedWalletClient, PrivyDelegationVerifier, createExecutorHandler } from "./executor.mjs";

const FORBIDDEN = /^(?:BOT_TOKEN|TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET|SEED|MNEMONIC|PRIVATE_KEY|WALLET_VAULT)$/i;

function flag(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("INVALID_BOOLEAN_CONFIG");
}

export function buildExecutorRuntime(env, { clock = () => Math.floor(Date.now() / 1000) } = {}) {
  for (const key of Object.keys(env)) if (FORBIDDEN.test(key)) throw new Error("EXECUTOR_SECRET_BOUNDARY_VIOLATION");
  const enabled = flag(env.EXECUTOR_ENABLED, false);
  const globallyPaused = flag(env.EXECUTOR_GLOBAL_PAUSED, true);
  if (!env.EXECUTOR_DB) throw new Error("EXECUTOR_DB_REQUIRED");
  let walletClient = { async send() { throw new Error("PRIVY_NOT_CONFIGURED"); } };
  let delegationVerifier = null;
  if (enabled) {
    if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET || !env.PRIVY_AUTHORIZATION_PRIVATE_KEY || !env.PRIVY_AUTHORIZATION_SIGNER_ID || !env.PRIVY_POLICY_ID) throw new Error("PRIVY_EXECUTOR_SECRETS_REQUIRED");
    const client = new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET, requestExpiry: { defaultMs: 120_000, defaultIntentMs: 120_000 } });
    walletClient = new PrivyDelegatedWalletClient({
      client,
      authorizationPrivateKey: env.PRIVY_AUTHORIZATION_PRIVATE_KEY,
    });
    delegationVerifier = new PrivyDelegationVerifier({ client, signerId: env.PRIVY_AUTHORIZATION_SIGNER_ID, policyId: env.PRIVY_POLICY_ID, chainId: Number(env.EXECUTOR_CHAIN_ID || 4663) });
  }
  const executor = new DelegatedExecutor({
    config: {
      enabled,
      globallyPaused,
      executorAddress: String(env.EXECUTOR_CONTRACT_ADDRESS || "").toLowerCase(),
      chainId: Number(env.EXECUTOR_CHAIN_ID || 4663),
      maxTransactionWei: env.EXECUTOR_MAX_TRANSACTION_WEI || "0",
      maxTtlSeconds: Number(env.EXECUTOR_MAX_TTL_SECONDS || 120),
    },
    store: new D1SubmissionStore(env.EXECUTOR_DB),
    walletClient,
    clock,
  });
  return createExecutorHandler(executor, delegationVerifier);
}

export default { fetch(request, env) { try { return buildExecutorRuntime(env)(request); } catch { return new Response(JSON.stringify({ ok: false, why: "EXECUTOR_UNAVAILABLE" }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } }); } } };
