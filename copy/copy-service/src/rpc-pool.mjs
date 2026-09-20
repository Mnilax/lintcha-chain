const READ_METHODS = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_call", "eth_estimateGas",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getCode", "eth_getLogs",
]);

const lower = (value) => (typeof value === "string" ? value.toLowerCase() : value);

/**
 * Two vendors serialize the same object differently (extra fields such as `yParity`, `type`, `l1BlockNumber`).
 * Quorum compares a projection of the fields the service relies on, never the raw vendor JSON.
 */
export const QUORUM_PROJECTIONS = Object.freeze({
  eth_getTransactionByHash: (tx) => tx && ({
    hash: lower(tx.hash), from: lower(tx.from), to: lower(tx.to), input: lower(tx.input ?? tx.data),
    value: BigInt(tx.value || 0).toString(), nonce: BigInt(tx.nonce || 0).toString(),
    blockHash: lower(tx.blockHash) ?? null, blockNumber: tx.blockNumber ? BigInt(tx.blockNumber).toString() : null,
  }),
  eth_getTransactionReceipt: (receipt) => receipt && ({
    transactionHash: lower(receipt.transactionHash), from: lower(receipt.from), to: lower(receipt.to),
    status: lower(receipt.status), blockHash: lower(receipt.blockHash), blockNumber: BigInt(receipt.blockNumber || 0).toString(),
    gasUsed: BigInt(receipt.gasUsed || 0).toString(), logCount: Array.isArray(receipt.logs) ? receipt.logs.length : null,
  }),
  eth_getBlockByNumber: (block) => block && ({ number: BigInt(block.number || 0).toString(), hash: lower(block.hash), parentHash: lower(block.parentHash) }),
});

function canonical(method, value) {
  const project = QUORUM_PROJECTIONS[method];
  return JSON.stringify(project ? project(value) : value);
}

export class RpcError extends Error {
  constructor(code, { cause, rpcError = null, providerId = null } = {}) {
    super(code, { cause });
    this.rpcError = rpcError;
    this.providerId = providerId;
  }
}

export function isRevertError(error) {
  const rpc = error?.rpcError;
  if (!rpc) return false;
  const message = String(rpc.message || "").toLowerCase();
  return rpc.code === 3 || rpc.code === -32000 || /revert|execution reverted|out of gas|insufficient funds/.test(message);
}

export class ReadOnlyJsonRpcProvider {
  constructor({ id, url, fetchImpl = globalThis.fetch, timeoutMs = 8_000 }) {
    if (!id || !url) throw new Error("RPC_PROVIDER_CONFIGURATION_REQUIRED");
    this.id = id;
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.counter = 0;
  }
  async request(method, params = []) {
    if (!READ_METHODS.has(method)) throw new RpcError("RPC_METHOD_NOT_READ_ONLY", { providerId: this.id });
    let response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.counter, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // The provider URL is never included in the error: it may carry an API key.
      throw new RpcError("RPC_NETWORK_FAILURE", { providerId: this.id, cause: new Error(String(cause?.name || "fetch_failed")) });
    }
    if (!response?.ok) throw new RpcError("RPC_HTTP_FAILURE", { providerId: this.id });
    const body = await response.json().catch(() => null);
    if (!body || body.error || !("result" in body)) throw new RpcError("RPC_JSON_FAILURE", { providerId: this.id, rpcError: body?.error ? { code: body.error.code, message: String(body.error.message || "").slice(0, 200) } : null });
    return body.result;
  }
}

export class RpcPool {
  constructor({ providers, chainId = 4663, maxHeadSkewBlocks = 2, requireFinalityTags = true }) {
    if (!Array.isArray(providers) || providers.length !== 2) throw new Error("EXACTLY_TWO_RPC_PROVIDERS_REQUIRED");
    if (providers[0].id === providers[1].id) throw new Error("INDEPENDENT_RPC_PROVIDERS_REQUIRED");
    this.providers = providers;
    this.chainId = chainId;
    this.maxHeadSkewBlocks = maxHeadSkewBlocks;
    this.requireFinalityTags = requireFinalityTags;
  }

  async healthCheck() {
    const rows = await Promise.all(this.providers.map(async (provider) => {
      const [chainId, head, safe, finalized] = await Promise.all([
        provider.request("eth_chainId"),
        provider.request("eth_blockNumber"),
        provider.request("eth_getBlockByNumber", ["safe", false]).catch(() => null),
        provider.request("eth_getBlockByNumber", ["finalized", false]).catch(() => null),
      ]);
      return {
        id: provider.id, chainId: Number(BigInt(chainId)), head: Number(BigInt(head)),
        safeSupported: Boolean(safe?.hash), finalizedSupported: Boolean(finalized?.hash),
        safeNumber: safe?.number ? Number(BigInt(safe.number)) : null,
        finalizedNumber: finalized?.number ? Number(BigInt(finalized.number)) : null,
      };
    }));
    if (rows.some((row) => row.chainId !== this.chainId)) throw new Error("RPC_CHAIN_MISMATCH");
    if (this.requireFinalityTags && rows.some((row) => !row.safeSupported || !row.finalizedSupported)) throw new Error("RPC_FINALITY_TAGS_UNSUPPORTED");
    if (Math.max(...rows.map((row) => row.head)) - Math.min(...rows.map((row) => row.head)) > this.maxHeadSkewBlocks) throw new Error("RPC_HEAD_SKEW");
    const reference = Math.min(...rows.map((row) => row.head));
    const blocks = await Promise.all(this.providers.map((provider) => provider.request("eth_getBlockByNumber", [`0x${reference.toString(16)}`, false])));
    if (!blocks[0]?.hash || blocks[0].hash.toLowerCase() !== String(blocks[1]?.hash || "").toLowerCase()) throw new Error("RPC_BLOCK_HASH_DISAGREEMENT");
    const safeNumbers = rows.map((row) => row.safeNumber).filter((item) => Number.isSafeInteger(item));
    const finalizedNumbers = rows.map((row) => row.finalizedNumber).filter((item) => Number.isSafeInteger(item));
    return Object.freeze({
      healthy: true, providers: rows, referenceBlock: reference, referenceHash: blocks[0].hash.toLowerCase(),
      // The conservative view: a block is safe/finalized only when both providers say so.
      safeBlock: safeNumbers.length === rows.length ? Math.min(...safeNumbers) : null,
      finalizedBlock: finalizedNumbers.length === rows.length ? Math.min(...finalizedNumbers) : null,
    });
  }

  async failoverRead(method, params = []) {
    let lastError;
    for (const provider of this.providers) {
      try { return await provider.request(method, params); } catch (error) { lastError = error; }
    }
    throw new RpcError("RPC_FAILOVER_EXHAUSTED", { cause: lastError });
  }

  async quorumRead(method, params = []) {
    const settled = await Promise.allSettled(this.providers.map((provider) => provider.request(method, params)));
    if (settled.some((item) => item.status !== "fulfilled")) {
      const failure = settled.find((item) => item.status === "rejected")?.reason;
      // A revert is a deterministic answer both providers agree on only if both reverted; surface it separately.
      if (settled.every((item) => item.status === "rejected" && isRevertError(item.reason))) throw new RpcError("RPC_CALL_REVERTED", { cause: failure, rpcError: failure?.rpcError });
      throw new RpcError("RPC_QUORUM_UNAVAILABLE", { cause: failure });
    }
    const [left, right] = settled.map((item) => item.value);
    if (canonical(method, left) !== canonical(method, right)) throw new RpcError("RPC_DISAGREEMENT");
    return left;
  }
}
