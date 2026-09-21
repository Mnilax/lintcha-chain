import test from "node:test";
import assert from "node:assert/strict";
import { AutoBuySetupController, decimalToUnits } from "../copy/auto-buy-onboarding.mjs";

const WALLET = "0x1111111111111111111111111111111111111111";

test("native limit parsing is exact and rejects float ambiguity", () => {
  assert.equal(decimalToUnits("0.005"), "5000000000000000");
  assert.equal(decimalToUnits("2"), "2000000000000000000");
  assert.throws(() => decimalToUnits("1e-3"), /INVALID_NATIVE_AMOUNT/);
  assert.throws(() => decimalToUnits("0.0000000000000000001"), /INVALID_NATIVE_AMOUNT/);
});

test("explicit Privy consent forwards only public permission metadata and bounded limits", async () => {
  const calls = [];
  const controller = new AutoBuySetupController({
    clock: () => 1_700_000_000,
    privyAdapter: { async delegateWallet(input) { calls.push(["delegate", input]); } },
    api: {
      async activateDelegation(input) { calls.push(["activate", input]); return { active: true }; },
      async deactivateDelegation(walletAddress) { calls.push(["deactivate-api", walletAddress]); return { active: false }; },
    },
  });
  assert.deepEqual(await controller.activate({ walletAddress: WALLET, maxTransactionNative: "0.005", maxDailyNative: "0.02", maxSlippagePercent: "1", durationHours: "24" }), { active: true });
  assert.deepEqual(calls[0], ["delegate", { address: WALLET, chainType: "ethereum" }]);
  assert.deepEqual(calls[1], ["activate", { walletAddress: WALLET, maxTransactionWei: "5000000000000000", maxDailySpendWei: "20000000000000000", maxSlippageBps: 100, expiresAt: 1_700_086_400 }]);
  assert.doesNotMatch(JSON.stringify(calls), /privateKey|seed|mnemonic|signature/);
});

test("secret-like adapter output and invalid limits fail before the Copy API", async () => {
  let calls = 0;
  const api = { async activateDelegation() { calls += 1; }, async deactivateDelegation() {} };
  const secret = new AutoBuySetupController({ api, privyAdapter: { async delegateWallet() { return { privateKey: "never" }; } } });
  await assert.rejects(secret.activate({ walletAddress: WALLET, maxTransactionNative: "1", maxDailyNative: "1", maxSlippagePercent: "1", durationHours: "1" }), /SECRET/);
  const invalid = new AutoBuySetupController({ api, privyAdapter: { async delegateWallet() {} } });
  await assert.rejects(invalid.activate({ walletAddress: WALLET, maxTransactionNative: "2", maxDailyNative: "1", maxSlippagePercent: "1", durationHours: "1" }), /CAP/);
  assert.equal(calls, 0);
});
