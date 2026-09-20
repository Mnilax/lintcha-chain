import { RpcError, isRevertError } from "./rpc-pool.mjs";

function gas(value) {
  try { return BigInt(value); } catch { throw new Error("INVALID_GAS_ESTIMATE"); }
}

export class SimulationQuorum {
  constructor({ rpcPool, maxGasEstimateSkewBps = 1500 }) {
    this.rpcPool = rpcPool;
    this.maxGasEstimateSkewBps = BigInt(maxGasEstimateSkewBps);
  }

  /**
   * Both providers evaluate the unsigned call at one common block. A revert on both sides is reported as
   * SIMULATION_REVERTED; a revert on one side only is a provider disagreement and is also fail-closed.
   */
  async simulate({ from, transaction }) {
    const health = await this.rpcPool.healthCheck();
    const blockTag = `0x${health.referenceBlock.toString(16)}`;
    const call = { from, to: transaction.to, data: transaction.data, value: `0x${BigInt(transaction.value || 0).toString(16)}` };
    const settled = await Promise.allSettled(this.rpcPool.providers.map(async (provider) => ({
      id: provider.id,
      output: await provider.request("eth_call", [call, blockTag]),
      gas: await provider.request("eth_estimateGas", [call, blockTag]),
    })));
    const reverted = settled.filter((item) => item.status === "rejected" && isRevertError(item.reason));
    if (reverted.length === settled.length) throw new RpcError("SIMULATION_REVERTED", { cause: reverted[0].reason, rpcError: reverted[0].reason?.rpcError });
    if (settled.some((item) => item.status === "rejected")) {
      const failure = settled.find((item) => item.status === "rejected").reason;
      throw new RpcError(isRevertError(failure) ? "SIMULATION_PROVIDER_DISAGREEMENT" : "SIMULATION_PROVIDER_UNAVAILABLE", { cause: failure });
    }
    const results = settled.map((item) => item.value);
    if (String(results[0].output).toLowerCase() !== String(results[1].output).toLowerCase()) throw new Error("SIMULATION_OUTPUT_DISAGREEMENT");
    const gasValues = results.map((item) => gas(item.gas));
    const high = gasValues[0] > gasValues[1] ? gasValues[0] : gasValues[1];
    const low = gasValues[0] < gasValues[1] ? gasValues[0] : gasValues[1];
    const skewBps = high === 0n ? 0n : ((high - low) * 10_000n) / high;
    if (skewBps > this.maxGasEstimateSkewBps) throw new Error("SIMULATION_GAS_DISAGREEMENT");
    return Object.freeze({
      simulated: true,
      providerIds: results.map((item) => item.id),
      blockNumber: health.referenceBlock,
      blockHash: health.referenceHash,
      safeBlock: health.safeBlock,
      output: results[0].output,
      gasLimitFloor: high.toString(),
      gasSkewBps: Number(skewBps),
    });
  }
}
