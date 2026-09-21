import assert from "node:assert/strict";
import { test } from "node:test";
import { SOURCE_STATES } from "../src/constants.mjs";
import { EXECUTION_FINALITY_MODES, ExecutionFinalityPolicy } from "../src/execution/finality-policy.mjs";

const transactionHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const blockHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function observations(patches = {}) {
  const common = { transactionHash, blockHash, blockNumber: 100, receiptStatus: 1, productionReady: true };
  return [
    { providerId: "provider-a", ...common, ...patches.first },
    { providerId: "provider-b", ...common, ...patches.second },
  ];
}

function softEvidence(patches = {}) {
  return {
    sourceState: SOURCE_STATES.PROVISIONAL,
    chainId: 4663,
    amountIn: "100",
    sourceTransactionHash: transactionHash,
    sourceBlockHash: blockHash,
    sourceBlockNumber: 100,
    observations: observations(),
    canonicalChainContinuous: true,
    transactionStillPresent: true,
    sequencerFeedHealthy: true,
    reorgMonitorHealthy: true,
    quoteRevalidated: true,
    simulationPassed: true,
    userAcceptedSoftRisk: true,
    ...patches,
  };
}

test("CP5 finality: default policy remains parent-safe and rejects provisional source events", () => {
  const policy = new ExecutionFinalityPolicy();
  assert.deepEqual(policy.assess({ sourceState: SOURCE_STATES.PROVISIONAL }), {
    allowed: false,
    reason: "PARENT_SAFE_REQUIRED",
    mode: EXECUTION_FINALITY_MODES.PARENT_SAFE,
    effectiveLevel: null,
  });
  assert.equal(policy.assess({ sourceState: SOURCE_STATES.CONFIRMED }).allowed, true);
});

test("CP5 finality: parent-finalized mode does not accept safe", () => {
  const policy = new ExecutionFinalityPolicy({ mode: EXECUTION_FINALITY_MODES.PARENT_FINALIZED });
  assert.equal(policy.assess({ sourceState: SOURCE_STATES.CONFIRMED }).reason, "PARENT_FINALIZED_REQUIRED");
  assert.equal(policy.assess({ sourceState: SOURCE_STATES.FINALIZED }).allowed, true);
});

test("CP5 finality: soft mode is disabled unless explicitly configured", () => {
  const policy = new ExecutionFinalityPolicy({ mode: EXECUTION_FINALITY_MODES.SEQUENCER_SOFT_LIMITED });
  assert.equal(policy.assess(softEvidence()).reason, "SOFT_MODE_DISABLED");
});

test("CP5 finality: explicitly enabled capped soft confirmation can pass complete evidence", () => {
  const policy = new ExecutionFinalityPolicy({
    mode: EXECUTION_FINALITY_MODES.SEQUENCER_SOFT_LIMITED,
    soft: { enabled: true, providerQuorum: 2, maxExposureAmount: "100", evidenceVersion: "fixture-v1" },
  });
  const result = policy.assess(softEvidence());
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "CAPPED_SEQUENCER_SOFT_CONFIRMATION");
});

test("CP5 finality: soft mode fails closed on cap, provider, monitoring or user-risk gaps", () => {
  const policy = new ExecutionFinalityPolicy({
    mode: EXECUTION_FINALITY_MODES.SEQUENCER_SOFT_LIMITED,
    soft: { enabled: true, providerQuorum: 2, maxExposureAmount: "100", evidenceVersion: "fixture-v1" },
  });
  assert.equal(policy.assess(softEvidence({ amountIn: "101" })).reason, "SOFT_EXPOSURE_CAP_EXCEEDED");
  assert.equal(policy.assess(softEvidence({ sourceBlockNumber: 99 })).reason, "SOURCE_REFERENCE_MISMATCH");
  assert.equal(policy.assess(softEvidence({ observations: observations({ second: { blockHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" } }) })).reason, "PROVIDER_DISAGREEMENT");
  assert.equal(policy.assess(softEvidence({ observations: observations({ second: { productionReady: false } }) })).reason, "NON_PRODUCTION_RPC");
  assert.equal(policy.assess(softEvidence({ reorgMonitorHealthy: false })).reason, "REORG_MONITOR_UNHEALTHY");
  assert.equal(policy.assess(softEvidence({ userAcceptedSoftRisk: false })).reason, "SOFT_RISK_NOT_ACCEPTED");
});

test("CP5 finality: retracted sources are always refused", () => {
  const policy = new ExecutionFinalityPolicy();
  assert.equal(policy.assess({ sourceState: SOURCE_STATES.RETRACTED }).reason, "SOURCE_RETRACTED");
});

test("CP5 finality: exact chain is required for every mode", () => {
  const policy = new ExecutionFinalityPolicy();
  assert.equal(policy.assess({ sourceState: SOURCE_STATES.CONFIRMED, chainId: 46630 }).reason, "CHAIN_ID_MISMATCH");
});
