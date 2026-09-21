const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function flag(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("INVALID_BOOLEAN_CONFIG");
}

function integer(value, fallback, label) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`INVALID_${label}`);
  return parsed;
}

function list(value, validator = () => true) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(validator)) throw new Error("INVALID_ALLOWLIST");
  return [...new Set(parsed.map((item) => String(item).toLowerCase()))];
}

function origin(value, mode) {
  const parsed = new URL(value ?? "http://localhost:8788");
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error("INVALID_COPY_APP_ORIGIN");
  if (mode === "production" && parsed.protocol !== "https:") throw new Error("HTTPS_COPY_ORIGIN_REQUIRED");
  if (mode !== "production" && !["http:", "https:"].includes(parsed.protocol)) throw new Error("INVALID_COPY_APP_ORIGIN");
  return parsed.origin;
}

export function loadCopyConfig(env = {}) {
  if (env.BOT_TOKEN || env.TELEGRAM_BOT_TOKEN) throw new Error("COPY_SERVICE_MUST_NOT_RECEIVE_BOT_TOKEN");
  const mode = env.COPY_ENVIRONMENT || "local";
  if (!["local", "preproduction", "production"].includes(mode)) throw new Error("INVALID_COPY_ENVIRONMENT");
  const chainId = integer(env.COPY_CHAIN_ID, 4663, "CHAIN_ID");
  const primaryId = env.COPY_RPC_PRIMARY_PROVIDER || "alchemy";
  const secondaryId = env.COPY_RPC_SECONDARY_PROVIDER || "drpc";
  if (primaryId === secondaryId) throw new Error("INDEPENDENT_RPC_PROVIDERS_REQUIRED");
  const endpoints = [
    { id: primaryId, url: env.COPY_RPC_PRIMARY_URL || null },
    { id: secondaryId, url: env.COPY_RPC_SECONDARY_URL || null },
  ];
  const broadcastEnabled = flag(env.COPY_BROADCAST_ENABLED, false);
  const autoBuyEnabled = flag(env.COPY_AUTO_BUY_ENABLED ?? env.COPY_AUTO_COPY_ENABLED, false);
  const delegatedSubmissionEnabled = flag(env.COPY_DELEGATED_SUBMISSION_ENABLED, false);
  const autoBuyExecutorAddress = env.COPY_AUTO_BUY_EXECUTOR_ADDRESS ? String(env.COPY_AUTO_BUY_EXECUTOR_ADDRESS).toLowerCase() : null;
  if (broadcastEnabled) throw new Error("SERVER_BROADCAST_FORBIDDEN");
  if (autoBuyEnabled !== delegatedSubmissionEnabled) throw new Error("AUTO_BUY_FLAGS_MUST_MATCH");
  if (autoBuyEnabled && (!autoBuyExecutorAddress || !ADDRESS.test(autoBuyExecutorAddress))) throw new Error("AUTO_BUY_EXECUTOR_REQUIRED");
  if (mode === "production" && endpoints.some((item) => !item.url)) throw new Error("TWO_RPC_ENDPOINTS_REQUIRED");
  const appPath = env.COPY_APP_PATH || "/copy/";
  if (!/^\/copy(?:\/|$)/.test(appPath)) throw new Error("COPY_ROUTE_MUST_BE_ISOLATED");
  const apiPath = env.COPY_API_PATH || "/api/copy/";
  if (!/^\/api\/copy\/$/.test(apiPath)) throw new Error("COPY_API_ROUTE_MUST_BE_ISOLATED");
  const chains = list(env.COPY_ALLOW_CHAINS || "[4663]", (item) => Number.isSafeInteger(item)).map(Number);
  const routers = list(env.COPY_ALLOW_ROUTERS, (item) => ADDRESS.test(item));
  const spenders = list(env.COPY_ALLOW_SPENDERS, (item) => ADDRESS.test(item));
  const selectors = list(env.COPY_ALLOW_SELECTORS, (item) => /^0x[0-9a-fA-F]{8}$/.test(item));
  if (autoBuyEnabled && (!chains.includes(chainId) || !routers.includes(autoBuyExecutorAddress) || !selectors.includes("0xa59ac6dd"))) throw new Error("AUTO_BUY_POLICY_NOT_PINNED");
  return Object.freeze({
    serviceName: "lintcha-copy",
    mode,
    chainId,
    dbNamespace: env.COPY_DB_NAMESPACE || "lintcha_copy",
    appOrigin: origin(env.COPY_APP_ORIGIN, mode),
    appPath,
    apiPath,
    broadcastEnabled: false,
    autoBuyEnabled,
    delegatedSubmissionEnabled,
    autoBuyExecutorAddress,
    startsGloballyPaused: flag(env.COPY_GLOBAL_KILL_SWITCH, true),
    rpc: Object.freeze({
      endpoints: Object.freeze(endpoints.map(Object.freeze)),
      ready: endpoints.every((item) => Boolean(item.url)),
      maxHeadSkewBlocks: integer(env.COPY_RPC_MAX_HEAD_SKEW_BLOCKS, 2, "HEAD_SKEW"),
      maxGasEstimateSkewBps: integer(env.COPY_RPC_MAX_GAS_SKEW_BPS, 1500, "GAS_SKEW"),
    }),
    policy: Object.freeze({
      maxTransactionWei: String(env.COPY_MAX_TRANSACTION_WEI || "0"),
      maxDailySpendWei: String(env.COPY_MAX_DAILY_SPEND_WEI || "0"),
      maxSlippageBps: integer(env.COPY_MAX_SLIPPAGE_BPS, 0, "SLIPPAGE"),
      maxSellAmountByToken: Object.freeze(Object.fromEntries(Object.entries(JSON.parse(env.COPY_MAX_SELL_AMOUNT_BY_TOKEN || "{}"))
        .map(([token, cap]) => {
          if (!ADDRESS.test(token) || !/^\d+$/.test(String(cap))) throw new Error("INVALID_SELL_TOKEN_CAP");
          return [token.toLowerCase(), String(cap)];
        }))),
      chains,
      routers,
      spenders,
      selectors,
    }),
  });
}

export function publicConfig(config) {
  return Object.freeze({
    serviceName: config.serviceName,
    mode: config.mode,
    chainId: config.chainId,
    dbNamespace: config.dbNamespace,
    appOrigin: config.appOrigin,
    appPath: config.appPath,
    apiPath: config.apiPath,
    rpcReady: config.rpc.ready,
    providerIds: config.rpc.endpoints.map(({ id }) => id),
    broadcastEnabled: false,
    autoBuyEnabled: config.autoBuyEnabled,
    delegatedSubmissionEnabled: config.delegatedSubmissionEnabled,
    autoBuyExecutorAddress: config.autoBuyExecutorAddress,
  });
}
