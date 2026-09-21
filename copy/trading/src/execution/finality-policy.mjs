import { CHAIN_ID, SOURCE_STATES } from "../constants.mjs";
import { asBigInt, normalizeHash } from "../utils.mjs";

export const EXECUTION_FINALITY_MODES = Object.freeze({
  PARENT_SAFE: "PARENT_SAFE",
  PARENT_FINALIZED: "PARENT_FINALIZED",
  SEQUENCER_SOFT_LIMITED: "SEQUENCER_SOFT_LIMITED",
});

const supportedModes = new Set(Object.values(EXECUTION_FINALITY_MODES));

function decision(allowed, reason, mode, effectiveLevel = null) {
  return Object.freeze({ allowed, reason, mode, effectiveLevel });
}

function deny(reason, mode) {
  return decision(false, reason, mode);
}

function requirePositiveInteger(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name}_INVALID`);
  return value;
}

function validateObservation(observation) {
  if (!observation || typeof observation.providerId !== "string" || observation.providerId.length === 0) {
    throw new TypeError("PROVIDER_ID_INVALID");
  }
  if (!Number.isSafeInteger(observation.blockNumber) || observation.blockNumber < 0) {
    throw new TypeError("BLOCK_NUMBER_INVALID");
  }
  return {
    providerId: observation.providerId,
    productionReady: observation.productionReady === true,
    transactionHash: normalizeHash(observation.transactionHash),
    blockHash: normalizeHash(observation.blockHash),
    blockNumber: observation.blockNumber,
    receiptStatus: observation.receiptStatus,
  };
}

export class ExecutionFinalityPolicy {
  constructor({ mode = EXECUTION_FINALITY_MODES.PARENT_SAFE, soft = null } = {}) {
    if (!supportedModes.has(mode)) throw new TypeError("FINALITY_MODE_INVALID");
    this.mode = mode;

    if (mode === EXECUTION_FINALITY_MODES.SEQUENCER_SOFT_LIMITED) {
      const enabled = soft?.enabled === true;
      this.soft = Object.freeze({
        enabled,
        chainId: soft?.chainId ?? CHAIN_ID,
        providerQuorum: enabled ? requirePositiveInteger(soft?.providerQuorum, "PROVIDER_QUORUM", 2) : null,
        maxExposureAmount: enabled ? asBigInt(soft?.maxExposureAmount, "maxExposureAmount") : null,
        evidenceVersion: enabled && typeof soft?.evidenceVersion === "string" && soft.evidenceVersion.length > 0
          ? soft.evidenceVersion
          : null,
      });
      if (enabled && this.soft.chainId !== CHAIN_ID) throw new TypeError("SOFT_CHAIN_ID_INVALID");
      if (enabled && this.soft.maxExposureAmount <= 0n) throw new TypeError("MAX_EXPOSURE_INVALID");
      if (enabled && !this.soft.evidenceVersion) throw new TypeError("EVIDENCE_VERSION_REQUIRED");
    } else {
      this.soft = null;
    }

    Object.freeze(this);
  }

  assess({ sourceState, chainId = CHAIN_ID, amountIn = "0", sourceTransactionHash = null,
    sourceBlockHash = null, sourceBlockNumber = null, observations = [], canonicalChainContinuous = false,
    transactionStillPresent = false, sequencerFeedHealthy = false, reorgMonitorHealthy = false,
    quoteRevalidated = false, simulationPassed = false, userAcceptedSoftRisk = false } = {}) {
    if (sourceState === SOURCE_STATES.RETRACTED) return deny("SOURCE_RETRACTED", this.mode);
    if (chainId !== CHAIN_ID) return deny("CHAIN_ID_MISMATCH", this.mode);
    if (sourceState === SOURCE_STATES.FINALIZED) {
      return decision(true, "PARENT_FINALIZED", this.mode, SOURCE_STATES.FINALIZED);
    }
    if (this.mode === EXECUTION_FINALITY_MODES.PARENT_FINALIZED) {
      return deny("PARENT_FINALIZED_REQUIRED", this.mode);
    }
    if (sourceState === SOURCE_STATES.CONFIRMED) {
      return decision(true, "PARENT_SAFE", this.mode, SOURCE_STATES.CONFIRMED);
    }
    if (sourceState !== SOURCE_STATES.PROVISIONAL) return deny("SOURCE_STATE_INVALID", this.mode);
    if (this.mode !== EXECUTION_FINALITY_MODES.SEQUENCER_SOFT_LIMITED) {
      return deny("PARENT_SAFE_REQUIRED", this.mode);
    }
    if (!this.soft.enabled) return deny("SOFT_MODE_DISABLED", this.mode);
    if (chainId !== this.soft.chainId) return deny("CHAIN_ID_MISMATCH", this.mode);
    if (asBigInt(amountIn, "amountIn") > this.soft.maxExposureAmount) return deny("SOFT_EXPOSURE_CAP_EXCEEDED", this.mode);
    if (!canonicalChainContinuous) return deny("CANONICAL_CONTINUITY_UNPROVEN", this.mode);
    if (!transactionStillPresent) return deny("SOURCE_TRANSACTION_MISSING", this.mode);
    if (!sequencerFeedHealthy) return deny("SEQUENCER_FEED_UNHEALTHY", this.mode);
    if (!reorgMonitorHealthy) return deny("REORG_MONITOR_UNHEALTHY", this.mode);
    if (!quoteRevalidated) return deny("QUOTE_NOT_REVALIDATED", this.mode);
    if (!simulationPassed) return deny("SIMULATION_NOT_PASSED", this.mode);
    if (!userAcceptedSoftRisk) return deny("SOFT_RISK_NOT_ACCEPTED", this.mode);

    if (!Array.isArray(observations) || observations.length < this.soft.providerQuorum) {
      return deny("PROVIDER_QUORUM_NOT_MET", this.mode);
    }

    let normalized;
    try {
      normalized = observations.map(validateObservation);
    } catch {
      return deny("PROVIDER_OBSERVATION_INVALID", this.mode);
    }
    const providerIds = new Set(normalized.map((item) => item.providerId));
    if (providerIds.size < this.soft.providerQuorum) return deny("INDEPENDENT_PROVIDER_QUORUM_NOT_MET", this.mode);
    if (normalized.some((item) => !item.productionReady)) return deny("NON_PRODUCTION_RPC", this.mode);

    const baseline = normalized[0];
    if (baseline.receiptStatus !== 1) return deny("SOURCE_RECEIPT_FAILED", this.mode);
    let expectedTransactionHash;
    let expectedBlockHash;
    try {
      expectedTransactionHash = normalizeHash(sourceTransactionHash);
      expectedBlockHash = normalizeHash(sourceBlockHash);
    } catch {
      return deny("SOURCE_REFERENCE_INVALID", this.mode);
    }
    if (!Number.isSafeInteger(sourceBlockNumber) || sourceBlockNumber < 0) {
      return deny("SOURCE_REFERENCE_INVALID", this.mode);
    }
    if (baseline.transactionHash !== expectedTransactionHash
      || baseline.blockHash !== expectedBlockHash
      || baseline.blockNumber !== sourceBlockNumber) {
      return deny("SOURCE_REFERENCE_MISMATCH", this.mode);
    }
    const disagree = normalized.some((item) => item.transactionHash !== baseline.transactionHash
      || item.blockHash !== baseline.blockHash
      || item.blockNumber !== baseline.blockNumber
      || item.receiptStatus !== baseline.receiptStatus);
    if (disagree) return deny("PROVIDER_DISAGREEMENT", this.mode);

    return decision(true, "CAPPED_SEQUENCER_SOFT_CONFIRMATION", this.mode, SOURCE_STATES.PROVISIONAL);
  }
}
