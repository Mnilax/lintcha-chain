import { PrivyClient } from "@privy-io/node";
import { D1SubmissionStore, DelegatedExecutor, PrivyDelegatedWalletClient, createExecutorHandler } from "./executor.mjs";

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
  if (enabled) {
    if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET || !env.PRIVY_AUTHORIZATION_PRIVATE_KEY) throw new Error("PRIVY_EXECUTOR_SECRETS_REQUIRED");
    walletClient = new PrivyDelegatedWalletClient({
      client: new PrivyClient({ appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET, requestExpiry: { defaultMs: 120_000, defaultIntentMs: 120_000 } }),
      authorizationPrivateKey: env.PRIVY_AUTHORIZATION_PRIVATE_KEY,
    });
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
  return createExecutorHandler(executor);
}

export default { fetch(request, env) { try { return buildExecutorRuntime(env)(request); } catch { return new Response(JSON.stringify({ ok: false, why: "EXECUTOR_UNAVAILABLE" }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } }); } } };
