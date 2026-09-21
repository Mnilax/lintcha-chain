function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function configuredThresholds(config) {
  return isNonNegativeInteger(config.maxHeadSkewBlocks)
    && isNonNegativeInteger(config.maxWallLagSeconds)
    && isNonNegativeInteger(config.maxRpcLatencyMs);
}

function addReason(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

export function evaluateRpcAcceptance({ expectedChainId, providers = [], thresholds = {} } = {}) {
  const reasons = [];
  if (!Number.isSafeInteger(expectedChainId) || expectedChainId <= 0) addReason(reasons, "EXPECTED_CHAIN_ID_INVALID");
  if (!configuredThresholds(thresholds)) addReason(reasons, "ACCEPTANCE_THRESHOLDS_UNSET");
  if (!Array.isArray(providers) || providers.length < 2) addReason(reasons, "PROVIDER_QUORUM_NOT_MET");

  const providerIds = new Set();
  const vendorIds = new Set();
  for (const provider of providers) {
    if (!provider || typeof provider.providerId !== "string" || provider.providerId.length === 0) {
      addReason(reasons, "PROVIDER_ID_INVALID");
      continue;
    }
    providerIds.add(provider.providerId);
    if (typeof provider.vendorId !== "string" || provider.vendorId.length === 0) addReason(reasons, "VENDOR_ID_INVALID");
    else vendorIds.add(provider.vendorId);
    if (provider.ok !== true) addReason(reasons, "RPC_PROBE_FAILED");
    if (provider.productionReady !== true) addReason(reasons, "NON_PRODUCTION_PROVIDER");
    if (provider.chainId !== expectedChainId) addReason(reasons, "CHAIN_ID_MISMATCH");
    if (provider.syncing !== false) addReason(reasons, "PROVIDER_SYNCING_OR_UNKNOWN");
    if (!provider.latest || !provider.safe || !provider.finalized) addReason(reasons, "FINALITY_TAGS_MISSING");
    if (!provider.reference || !isNonNegativeInteger(provider.reference.number) || typeof provider.reference.hash !== "string") {
      addReason(reasons, "REFERENCE_BLOCK_MISSING");
    }
    if (configuredThresholds(thresholds)) {
      if (!isNonNegativeInteger(provider.latestWallLagSeconds)
        || provider.latestWallLagSeconds > thresholds.maxWallLagSeconds) addReason(reasons, "WALL_LAG_EXCEEDED");
      if (!isNonNegativeInteger(provider.latencyMs)
        || provider.latencyMs > thresholds.maxRpcLatencyMs) addReason(reasons, "RPC_LATENCY_EXCEEDED");
    }
  }

  if (providerIds.size < 2) addReason(reasons, "INDEPENDENT_PROVIDER_QUORUM_NOT_MET");
  if (vendorIds.size < 2) addReason(reasons, "INDEPENDENT_VENDOR_QUORUM_NOT_MET");
  const healthy = providers.filter((provider) => provider?.ok === true);
  if (healthy.length >= 2) {
    const baselineReference = healthy[0].reference;
    if (!baselineReference || healthy.some((provider) => !provider.reference
      || provider.reference.number !== baselineReference.number
      || provider.reference.hash.toLowerCase() !== baselineReference.hash.toLowerCase())) {
      addReason(reasons, "REFERENCE_BLOCK_DISAGREEMENT");
    }
    if (configuredThresholds(thresholds)) {
      const latestNumbers = healthy.map((provider) => provider.latest?.number).filter(isNonNegativeInteger);
      if (latestNumbers.length !== healthy.length
        || Math.max(...latestNumbers) - Math.min(...latestNumbers) > thresholds.maxHeadSkewBlocks) {
        addReason(reasons, "HEAD_SKEW_EXCEEDED");
      }
    }
  }

  return Object.freeze({ accepted: reasons.length === 0, reasons: Object.freeze(reasons) });
}

function hexToNumber(value, field) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) throw new Error(`${field}_INVALID`);
  const parsed = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field}_OUT_OF_RANGE`);
  return parsed;
}

function blockSummary(block) {
  if (!block || typeof block.hash !== "string") throw new Error("BLOCK_INVALID");
  return Object.freeze({
    number: hexToNumber(block.number, "BLOCK_NUMBER"),
    hash: block.hash.toLowerCase(),
    timestamp: hexToNumber(block.timestamp, "BLOCK_TIMESTAMP"),
  });
}

async function rpcCall(endpoint, method, params, timeoutMs) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error("RPC_HTTP_FAILURE");
  const payload = await response.json();
  if (payload.error || !("result" in payload)) throw new Error("RPC_RESPONSE_FAILURE");
  return payload.result;
}

function endpointHost(endpoint) {
  return new URL(endpoint).host;
}

export async function probeRpcEndpoint({ providerId, vendorId = null, endpoint, productionReady = false, timeoutMs = 10000,
  referenceBlockNumber = null, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const startedAt = performance.now();
  const base = { providerId, vendorId, endpointHost: endpointHost(endpoint), productionReady };
  try {
    const [chainIdHex, latestRaw, safeRaw, finalizedRaw] = await Promise.all([
      rpcCall(endpoint, "eth_chainId", [], timeoutMs),
      rpcCall(endpoint, "eth_getBlockByNumber", ["latest", false], timeoutMs),
      rpcCall(endpoint, "eth_getBlockByNumber", ["safe", false], timeoutMs),
      rpcCall(endpoint, "eth_getBlockByNumber", ["finalized", false], timeoutMs),
    ]);
    let syncing = null;
    let syncingMethodSupported = false;
    try {
      syncing = await rpcCall(endpoint, "eth_syncing", [], timeoutMs);
      syncingMethodSupported = true;
    } catch {}
    const latest = blockSummary(latestRaw);
    const safe = blockSummary(safeRaw);
    const finalized = blockSummary(finalizedRaw);
    const referenceNumber = referenceBlockNumber ?? safe.number;
    const referenceRaw = await rpcCall(endpoint, "eth_getBlockByNumber", [`0x${referenceNumber.toString(16)}`, false], timeoutMs);
    return Object.freeze({
      ...base,
      ok: true,
      chainId: hexToNumber(chainIdHex, "CHAIN_ID"),
      syncing,
      syncingMethodSupported,
      latencyMs: Math.ceil(performance.now() - startedAt),
      latestWallLagSeconds: Math.max(0, nowSeconds - latest.timestamp),
      latest,
      safe,
      finalized,
      reference: blockSummary(referenceRaw),
    });
  } catch {
    return Object.freeze({ ...base, ok: false, error: "RPC_PROBE_FAILED" });
  }
}

export async function probeSequencerFeed({ feedId, url, timeoutMs = 10000, messageWaitMs = 5000 }) {
  const startedAt = performance.now();
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return Object.freeze({ feedId, ok: false, error: "FEED_URL_INVALID" });
  }
  return new Promise((resolve) => {
    let settled = false;
    let messageTimer = null;
    let connectLatencyMs = null;
    const socket = new WebSocket(url);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (messageTimer) clearTimeout(messageTimer);
      try { socket.close(); } catch {}
      resolve(Object.freeze({ feedId, host, ...result }));
    };
    const timer = setTimeout(() => finish({ ok: false, error: "FEED_TIMEOUT" }), timeoutMs);
    socket.addEventListener("open", () => {
      connectLatencyMs = Math.ceil(performance.now() - startedAt);
      clearTimeout(timer);
      messageTimer = setTimeout(() => finish({ ok: true, connectLatencyMs, messageObserved: false }), messageWaitMs);
    }, { once: true });
    socket.addEventListener("message", (event) => {
      const firstMessageBytes = event.data?.byteLength ?? event.data?.size ?? event.data?.length ?? null;
      finish({ ok: true, connectLatencyMs, messageObserved: true, firstMessageBytes,
        firstMessageLatencyMs: Math.ceil(performance.now() - startedAt) });
    }, { once: true });
    socket.addEventListener("error", () => finish({ ok: false, error: "FEED_CONNECT_FAILED" }), { once: true });
  });
}
