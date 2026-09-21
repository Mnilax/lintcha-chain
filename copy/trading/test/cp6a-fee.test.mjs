import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { assessUniversalRouterEvidence, decodeUniversalRouterFeeTail, FeeSchedule, FREE_PERIOD_SECONDS, verifyAtomicOutputFee } from "../src/fee/fee-policy.mjs";

const asset = "0x9999999999999999999999999999999999999999";

test("CP6A: seven UTC days are exactly zero fee; boundary activates 1%", () => {
  const schedule = new FeeSchedule({ version: 1, activationAtSeconds: 1000000 });
  assert.equal(schedule.preview({ timestampSeconds: 1000000, feeBaseAmount: "10000", feeAsset: asset }).feeAmount, "0");
  assert.equal(schedule.preview({ timestampSeconds: 1000000 + FREE_PERIOD_SECONDS - 1, feeBaseAmount: "10000", feeAsset: asset }).feeAmount, "0");
  const active = schedule.preview({ timestampSeconds: 1000000 + FREE_PERIOD_SECONDS, feeBaseAmount: "10000", feeAsset: asset });
  assert.equal(active.feeBps, 100);
  assert.equal(active.feeAmount, "100");
});

test("CP6A: rounding floors and atomic reconciliation rejects hidden output", () => {
  const schedule = new FeeSchedule({ version: 1, activationAtSeconds: 0 });
  const preview = schedule.preview({ timestampSeconds: FREE_PERIOD_SECONDS, feeBaseAmount: "99", feeAsset: asset });
  assert.equal(preview.feeAmount, "0");
  const full = schedule.preview({ timestampSeconds: FREE_PERIOD_SECONDS, feeBaseAmount: "10000", feeAsset: asset });
  assert.equal(verifyAtomicOutputFee({ preview: full, grossOutput: "10000", userOutput: "9900", feeTransferAmount: "100", feeTransferRecipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", expectedRecipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }).verified, true);
  assert.throws(() => verifyAtomicOutputFee({ preview: full, grossOutput: "10000", userOutput: "9899", feeTransferAmount: "100", feeTransferRecipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", expectedRecipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), /HIDDEN_OR_MISSING_OUTPUT/);
});

test("CP6A: official mainnet receipt proves PAY_PORTION then SWEEP exact arithmetic", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const evidence = JSON.parse(await readFile(resolve(here, "fixtures/mainnet-pay-portion-sweep.json"), "utf8"));
  const decoded = decodeUniversalRouterFeeTail(evidence.calldata);
  assert.deepEqual(decoded.swapCommands, [0x10]);
  assert.equal(decoded.feeAsset, evidence.asset.address);
  assert.equal(decoded.feeRecipient, evidence.feeTransfer.recipient);
  assert.equal(decoded.feeBps, 70);
  assert.equal(decoded.userRecipient, evidence.userTransfer.recipient);
  assert.equal(BigInt(evidence.grossRouterOutput.value) * 70n / 10000n, BigInt(evidence.feeTransfer.value));
  assert.equal(verifyAtomicOutputFee({
    preview: { feeAmount: evidence.feeTransfer.value, feeAsset: evidence.asset.address },
    grossOutput: evidence.grossRouterOutput.value,
    userOutput: evidence.userTransfer.value,
    feeTransferAmount: evidence.feeTransfer.value,
    feeTransferRecipient: evidence.feeTransfer.recipient,
    expectedRecipient: evidence.feeTransfer.recipient,
  }).verified, true);
});

test("CP6A: current Universal Router testnet evidence remains blocked", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const evidence = JSON.parse(await readFile(resolve(here, "fixtures/universal-router-evidence.json"), "utf8"));
  const result = assessUniversalRouterEvidence(evidence.testnet);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.blockers, ["OFFICIAL_TESTNET_MANIFEST_MISSING", "ATOMIC_TESTNET_RECEIPT_MISSING", "EXACT_DELTAS_MISSING"]);
});
