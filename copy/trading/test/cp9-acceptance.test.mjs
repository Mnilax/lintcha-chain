import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateRpcAcceptance } from "../src/operations/rpc-acceptance.mjs";

const hash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const block = (number) => ({ number, hash, timestamp: 1000 });
const provider = (providerId, patches = {}) => ({
  providerId,
  vendorId: providerId,
  productionReady: true,
  ok: true,
  chainId: 4663,
  syncing: false,
  latencyMs: 100,
  latestWallLagSeconds: 2,
  latest: block(110),
  safe: block(100),
  finalized: block(90),
  reference: block(100),
  ...patches,
});
const thresholds = { maxHeadSkewBlocks: 2, maxWallLagSeconds: 10, maxRpcLatencyMs: 1000 };

test("CP9: two independent production providers can satisfy an explicit acceptance policy", () => {
  const result = evaluateRpcAcceptance({ expectedChainId: 4663, providers: [provider("a"), provider("b")], thresholds });
  assert.deepEqual(result, { accepted: true, reasons: [] });
});

test("CP9: public single-provider evidence is never production acceptance", () => {
  const result = evaluateRpcAcceptance({
    expectedChainId: 4663,
    providers: [provider("public", { productionReady: false })],
    thresholds,
  });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("PROVIDER_QUORUM_NOT_MET"));
  assert.ok(result.reasons.includes("NON_PRODUCTION_PROVIDER"));
});

test("CP9: thresholds must be explicit rather than invented by the harness", () => {
  const result = evaluateRpcAcceptance({ expectedChainId: 4663, providers: [provider("a"), provider("b")] });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("ACCEPTANCE_THRESHOLDS_UNSET"));
});

test("CP9: chain, sync, latency, wall lag and head skew fail closed", () => {
  const result = evaluateRpcAcceptance({
    expectedChainId: 4663,
    providers: [provider("a"), provider("b", {
      chainId: 46630,
      syncing: { currentBlock: "0x1" },
      latencyMs: 1001,
      latestWallLagSeconds: 11,
      latest: block(113),
    })],
    thresholds,
  });
  for (const reason of ["CHAIN_ID_MISMATCH", "PROVIDER_SYNCING_OR_UNKNOWN", "RPC_LATENCY_EXCEEDED", "WALL_LAG_EXCEEDED", "HEAD_SKEW_EXCEEDED"]) {
    assert.ok(result.reasons.includes(reason), reason);
  }
});

test("CP9: disagreement at a common safe reference block fails closed", () => {
  const otherHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const result = evaluateRpcAcceptance({
    expectedChainId: 4663,
    providers: [provider("a"), provider("b", { reference: { number: 100, hash: otherHash, timestamp: 1000 } })],
    thresholds,
  });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("REFERENCE_BLOCK_DISAGREEMENT"));
});

test("CP9: two labels from one vendor do not satisfy independence", () => {
  const result = evaluateRpcAcceptance({
    expectedChainId: 4663,
    providers: [provider("a", { vendorId: "same-vendor" }), provider("b", { vendorId: "same-vendor" })],
    thresholds,
  });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes("INDEPENDENT_VENDOR_QUORUM_NOT_MET"));
});
