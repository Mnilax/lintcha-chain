import test from "node:test";
import assert from "node:assert/strict";
import { AutoBuySetupController, configureCalldata, decimalToUnits, pauseCalldata, percentToBps } from "../copy/auto-buy-onboarding.mjs";

const WALLET = "0x1111111111111111111111111111111111111111";
const WRAPPER = "0x7777777777777777777777777777777777777777";
const HASH = `0x${"a".repeat(64)}`;
const NOW = 1_700_000_000;
const SIGNER = "signer_lintcha_1";
const POLICY = "policy_buy_only_1";
const ACTIVATION_TOKEN = "activation_body_12345678.activation_signature_12345678";
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const PAUSE_TRANSACTION = Object.freeze({ chainId: 4663, to: WRAPPER, value: "0", data: `0xb990b559${word(1)}` });

test("native and slippage parsing are exact and reject exponent or rounding ambiguity", () => {
  assert.equal(decimalToUnits("0.005"), "5000000000000000");
  assert.equal(decimalToUnits("2"), "2000000000000000000");
  assert.equal(percentToBps("0"), 0);
  assert.equal(percentToBps("0.01"), 1);
  assert.equal(percentToBps("1.5"), 150);
  assert.equal(percentToBps("20.00"), 2000);
  assert.throws(() => decimalToUnits("1e-3"), /INVALID_NATIVE_AMOUNT/);
  assert.throws(() => decimalToUnits("0.0000000000000000001"), /INVALID_NATIVE_AMOUNT/);
  assert.throws(() => percentToBps("1e-2"), /INVALID_DELEGATION_SLIPPAGE/);
  assert.throws(() => percentToBps("0.005"), /INVALID_DELEGATION_SLIPPAGE/);
});

test("wrapper calldata pins the exact configure and pause selectors and ABI widths", () => {
  assert.equal(configureCalldata({ maxTransactionWei: "5", maxDailySpendWei: "20", maxSlippageBps: 100, expiresAt: NOW + 3600 }), `0xdc63f7f4${word(5)}${word(20)}${word(100)}${word(NOW + 3600)}`);
  assert.equal(pauseCalldata(), `0xb990b559${word(1)}`);
  assert.throws(() => configureCalldata({ maxTransactionWei: 1n << 128n, maxDailySpendWei: 1, maxSlippageBps: 1, expiresAt: 1 }), /CAP/);
});

function setup(overrides = {}) {
  const calls = [];
  const api = {
    async prepareDelegation(input) {
      calls.push(["prepare-api", input]);
      const { walletAddress, ...preparedLimits } = input;
      return { activationToken: ACTIVATION_TOKEN, limits: preparedLimits, transaction: { chainId: 4663, to: WRAPPER, value: "0", data: configureCalldata(preparedLimits) } };
    },
    async verifyConfiguration(input) { calls.push(["verify-configuration-api", input]); return { ready: true, walletAddress: input.walletAddress }; },
    async activateDelegation(input) { calls.push(["activate-api", input]); return { active: true }; },
    async recoverRemoval(input) { calls.push(["recover-removal-api", input]); return { active: false, pendingRemoval: true }; },
    async deactivateDelegation(address) { calls.push(["deactivate-api", address]); return { active: false, pauseTransaction: PAUSE_TRANSACTION }; },
    async verifyRemovalReadiness(address) { calls.push(["readiness-api", address]); return { ready: true, walletAddress: address, chainId: 4663 }; },
    ...(overrides.api || {}),
  };
  const walletAdapter = overrides.walletAdapter || {
    async sendTransaction(input) { calls.push(["wallet", input]); return HASH; },
  };
  const finalityAdapter = overrides.finalityAdapter || {
    async waitForFinalizedReadback(input) {
      calls.push(["finality", input]);
      return input.operation === "CONFIGURE"
        ? { finalized: true, readback: { maxPerTradeWei: input.expected.maxTransactionWei, maxDailyWei: input.expected.maxDailySpendWei, maxSlippageBps: input.expected.maxSlippageBps, expiresAt: input.expected.expiresAt, paused: false } }
        : { finalized: true, readback: { paused: true } };
    },
  };
  const privyAdapter = {
    async addSigners(input) { calls.push(["add-signers", input]); return { address: input.address }; },
    async getSignerState(input) { calls.push(["get-signers", input]); return { walletAddress: input.address, additionalSigners: [{ signerId: SIGNER, policyIds: [POLICY] }] }; },
    async removeSigners(input) { calls.push(["remove-signers", input]); return { address: input.address }; },
    ...(overrides.privyAdapter || {}),
  };
  return {
    calls,
    controller: new AutoBuySetupController({ api, walletAdapter, finalityAdapter, privyAdapter, wrapperAddress: WRAPPER, signerId: SIGNER, policyId: POLICY, clock: () => NOW }),
  };
}

test("activation configures on-chain limits, proves finality/readback, then adds the exact signer policy and activates", async () => {
  const { controller, calls } = setup();
  const result = await controller.activate({ walletAddress: WALLET, maxTransactionNative: "0.005", maxDailyNative: "0.02", maxSlippagePercent: "1", durationHours: "24" });
  assert.equal(result.active, true);
  assert.equal(result.transactionHash, HASH);
  assert.deepEqual(calls.map(([name]) => name), ["prepare-api", "wallet", "finality", "verify-configuration-api", "add-signers", "activate-api"]);
  assert.deepEqual(calls[1][1], {
    walletAddress: WALLET,
    transaction: { chainId: 4663, to: WRAPPER, value: "0", data: `0xdc63f7f4${word("5000000000000000")}${word("20000000000000000")}${word(100)}${word(NOW + 86400)}` },
  });
  assert.deepEqual(calls[3][1], { walletAddress: WALLET, activationToken: ACTIVATION_TOKEN });
  assert.deepEqual(calls[4][1], { address: WALLET, signers: [{ signerId: SIGNER, policyIds: [POLICY] }] });
  assert.deepEqual(calls[5][1], { walletAddress: WALLET, activationToken: ACTIVATION_TOKEN });
});

test("activation refuses a server transaction that differs from the locally derived wrapper call", async () => {
  let walletCalls = 0;
  const { controller } = setup({
    api: {
      async prepareDelegation(input) { const { walletAddress, ...preparedLimits } = input; return { activationToken: ACTIVATION_TOKEN, limits: preparedLimits, transaction: { chainId: 4663, to: WALLET, value: "0", data: configureCalldata(preparedLimits) } }; },
      async activateDelegation() { throw new Error("MUST_NOT_ACTIVATE"); },
      async deactivateDelegation() { return { active: false, pauseTransaction: PAUSE_TRANSACTION }; },
    },
    walletAdapter: { async sendTransaction() { walletCalls += 1; return HASH; } },
  });
  await assert.rejects(controller.activate({ walletAddress: WALLET, maxTransactionNative: "0.005", maxDailyNative: "0.02", maxSlippagePercent: "1", durationHours: "24" }), /TRANSACTION_MISMATCH/);
  assert.equal(walletCalls, 0);
});

test("activation refuses server limits that differ from the user's exact local limits", async () => {
  let walletCalls = 0;
  const { controller } = setup({
    api: {
      async prepareDelegation(input) { const { walletAddress, ...preparedLimits } = input; const tamperedLimits = { ...preparedLimits, maxSlippageBps: preparedLimits.maxSlippageBps + 1 }; return { activationToken: ACTIVATION_TOKEN, limits: tamperedLimits, transaction: { chainId: 4663, to: WRAPPER, value: "0", data: configureCalldata(tamperedLimits) } }; },
      async activateDelegation() { throw new Error("MUST_NOT_ACTIVATE"); },
      async deactivateDelegation() { return { active: false, pauseTransaction: PAUSE_TRANSACTION }; },
    },
    walletAdapter: { async sendTransaction() { walletCalls += 1; return HASH; } },
  });
  await assert.rejects(controller.activate({ walletAddress: WALLET, maxTransactionNative: "0.005", maxDailyNative: "0.02", maxSlippagePercent: "1", durationHours: "24" }), /LIMITS_MISMATCH/);
  assert.equal(walletCalls, 0);
});

test("activation stops before signer attachment when finalized wrapper readback differs", async () => {
  let downstreamCalls = 0;
  const { controller } = setup({
    finalityAdapter: { async waitForFinalizedReadback(input) { return { finalized: true, readback: { maxPerTradeWei: "1", maxDailyWei: input.expected.maxDailySpendWei, maxSlippageBps: input.expected.maxSlippageBps, expiresAt: input.expected.expiresAt, paused: false } }; } },
    privyAdapter: { async addSigners() { downstreamCalls += 1; }, async removeSigners() {} },
    api: {
      async prepareDelegation(input) { const { walletAddress, ...preparedLimits } = input; return { activationToken: ACTIVATION_TOKEN, limits: preparedLimits, transaction: { chainId: 4663, to: WRAPPER, value: "0", data: configureCalldata(preparedLimits) } }; },
      async activateDelegation() { downstreamCalls += 1; },
      async deactivateDelegation() { return { active: false, pauseTransaction: PAUSE_TRANSACTION }; },
    },
  });
  await assert.rejects(controller.activate({ walletAddress: WALLET, maxTransactionNative: "0.005", maxDailyNative: "0.02", maxSlippagePercent: "1", durationHours: "24" }), /CONFIGURATION_MISMATCH/);
  assert.equal(downstreamCalls, 0);
});

test("API activation failure immediately removes the signer and preserves the activation error", async () => {
  const calls = [];
  const { controller } = setup({
    api: {
      async prepareDelegation(input) { const { walletAddress, ...preparedLimits } = input; return { activationToken: ACTIVATION_TOKEN, limits: preparedLimits, transaction: { chainId: 4663, to: WRAPPER, value: "0", data: configureCalldata(preparedLimits) } }; },
      async activateDelegation() { calls.push("activate-api"); throw new Error("ACTIVATION_UNAVAILABLE"); },
      async deactivateDelegation() { return { active: false, pauseTransaction: PAUSE_TRANSACTION }; },
    },
    privyAdapter: {
      async addSigners() { calls.push("add-signers"); },
      async getSignerState(input) { calls.push(["get-signers", input]); return { walletAddress: input.address, additionalSigners: [{ signerId: SIGNER, policyIds: [POLICY] }] }; },
      async removeSigners(input) { calls.push(["remove-signers", input]); },
    },
  });
  await assert.rejects(controller.activate({ walletAddress: WALLET, maxTransactionNative: "0.005", maxDailyNative: "0.02", maxSlippagePercent: "1", durationHours: "24" }), /ACTIVATION_UNAVAILABLE/);
  assert.deepEqual(calls, ["add-signers", "activate-api", ["get-signers", { address: WALLET }], ["remove-signers", { address: WALLET }]]);
});

test("an ambiguous addSigners failure attempts server recovery before another activation", async () => {
  const { controller, calls } = setup({
    privyAdapter: {
      async addSigners(input) { calls.push(["add-signers", input]); throw new Error("PRIVY_RESPONSE_LOST"); },
    },
  });
  await assert.rejects(controller.activate({ walletAddress: WALLET, maxTransactionNative: "0.005", maxDailyNative: "0.02", maxSlippagePercent: "1", durationHours: "24" }), /PRIVY_RESPONSE_LOST/);
  assert.deepEqual(calls.map(([name]) => name), ["prepare-api", "wallet", "finality", "verify-configuration-api", "add-signers", "recover-removal-api", "deactivate-api", "wallet", "finality", "get-signers", "readiness-api", "remove-signers"]);
  assert.equal(calls.some(([name]) => name === "activate-api"), false);
});

test("an unverified signer state after addSigners failure stops setup with pending cleanup", async () => {
  const { controller, calls } = setup({
    api: { async recoverRemoval(input) { calls.push(["recover-removal-api", input]); throw new Error("DELEGATION_VERIFICATION_FAILED"); } },
    privyAdapter: { async addSigners(input) { calls.push(["add-signers", input]); throw new Error("PRIVY_RESPONSE_LOST"); } },
  });
  const result = await controller.activate({ walletAddress: WALLET, maxTransactionNative: "0.005", maxDailyNative: "0.02", maxSlippagePercent: "1", durationHours: "24" });
  assert.equal(result.pendingRemoval, true);
  assert.equal(result.reason, "DELEGATION_VERIFICATION_FAILED");
  assert.equal(calls.some(([name]) => name === "activate-api" || name === "deactivate-api"), false);
});

test("failed cleanup after an activation error returns an explicit signer-removal-pending state", async () => {
  const { controller } = setup({
    api: {
      async prepareDelegation(input) { const { walletAddress, ...preparedLimits } = input; return { activationToken: ACTIVATION_TOKEN, limits: preparedLimits, transaction: { chainId: 4663, to: WRAPPER, value: "0", data: configureCalldata(preparedLimits) } }; },
      async activateDelegation() { throw new Error("ACTIVATION_UNAVAILABLE"); },
      async deactivateDelegation() { return { active: false, pauseTransaction: PAUSE_TRANSACTION }; },
    },
    privyAdapter: { async addSigners() {}, async removeSigners() { throw new Error("PRIVY_UNAVAILABLE"); } },
  });
  const result = await controller.activate({ walletAddress: WALLET, maxTransactionNative: "0.005", maxDailyNative: "0.02", maxSlippagePercent: "1", durationHours: "24" });
  assert.deepEqual(result, { active: false, activationConfirmed: false, pendingRemoval: true, state: "SIGNER_REMOVAL_PENDING", reason: "PRIVY_UNAVAILABLE", transactionHash: HASH, onchainConfigured: true });
});

test("deactivation shuts down locally before on-chain pause, signer removal and optional finalize", async () => {
  const base = setup();
  base.controller.api.finalizeDelegationRemoval = async (address) => { base.calls.push(["finalize-api", address]); return { finalized: true }; };
  const result = await base.controller.deactivate(WALLET);
  assert.deepEqual(base.calls.map(([name]) => name), ["deactivate-api", "wallet", "finality", "get-signers", "readiness-api", "remove-signers", "finalize-api"]);
  assert.deepEqual(result, { active: false, localShutdown: true, onchainPaused: true, signerRemoved: true, pendingRemoval: false, transactionHash: HASH });
  assert.equal(base.calls[1][1].transaction.data, `0xb990b559${word(1)}`);
});

test("deactivation uses only the canonical server pause transaction and fails closed after local shutdown if it is tampered", async () => {
  let walletCalls = 0;
  const { controller } = setup({
    api: {
      async prepareDelegation() {},
      async activateDelegation() {},
      async deactivateDelegation() { return { active: false, pauseTransaction: { ...PAUSE_TRANSACTION, to: WALLET } }; },
    },
    walletAdapter: { async sendTransaction() { walletCalls += 1; return HASH; } },
  });
  assert.deepEqual(await controller.deactivate(WALLET), { active: false, localShutdown: true, pendingRemoval: true, stage: "PAUSE_TRANSACTION", reason: "PAUSE_TRANSACTION_MISMATCH" });
  assert.equal(walletCalls, 0);
});

test("deactivation-only construction does not require activation signer identifiers", async () => {
  const calls = [];
  const controller = new AutoBuySetupController({
    api: {
      async deactivateDelegation() { calls.push("local-shutdown"); return { active: false, pauseTransaction: PAUSE_TRANSACTION }; },
      async verifyRemovalReadiness(address) { calls.push("readiness-api"); return { ready: true, walletAddress: address, chainId: 4663 }; },
    },
    walletAdapter: { async sendTransaction() { calls.push("wallet"); return HASH; } },
    finalityAdapter: { async waitForFinalizedReadback() { calls.push("finality"); return { finalized: true, readback: { paused: true } }; } },
    privyAdapter: {
      async addSigners() {},
      async getSignerState({ address }) { calls.push("get-signers"); return { walletAddress: address, additionalSigners: [{ signerId: SIGNER, policyIds: [POLICY] }] }; },
      async removeSigners() { calls.push("remove-signers"); },
    },
    wrapperAddress: WRAPPER,
    signerId: SIGNER,
    policyId: POLICY,
    chainId: 4663,
  });
  assert.equal((await controller.deactivate(WALLET)).pendingRemoval, false);
  assert.deepEqual(calls, ["local-shutdown", "wallet", "finality", "get-signers", "readiness-api", "remove-signers"]);
  await assert.rejects(controller.activate({ walletAddress: WALLET }), /AUTO_BUY_SETUP_NOT_CONFIGURED/);
});

test("any failure after local shutdown stays inactive and returns pending removal", async () => {
  const calls = [];
  const { controller } = setup({
    api: {
      async prepareDelegation() {},
      async activateDelegation() { return { active: true }; },
      async deactivateDelegation(address) { calls.push(["deactivate-api", address]); return { active: false, pauseTransaction: PAUSE_TRANSACTION }; },
    },
    walletAdapter: { async sendTransaction(input) { calls.push(["wallet", input]); throw new Error("USER_REJECTED_IN_WALLET"); } },
  });
  const result = await controller.deactivate(WALLET);
  assert.deepEqual(calls.map(([name]) => name), ["deactivate-api", "wallet"]);
  assert.deepEqual(result, { active: false, localShutdown: true, pendingRemoval: true, stage: "ONCHAIN_PAUSE", reason: "USER_REJECTED_IN_WALLET" });
});

test("signer-removal failure after a finalized pause remains locally inactive", async () => {
  const { controller, calls } = setup({
    privyAdapter: { async addSigners() {}, async removeSigners() { throw new Error("PRIVY_UNAVAILABLE"); } },
  });
  const result = await controller.deactivate(WALLET);
  assert.deepEqual(calls.map(([name]) => name), ["deactivate-api", "wallet", "finality", "get-signers", "readiness-api"]);
  assert.deepEqual(result, { active: false, localShutdown: true, pendingRemoval: true, stage: "PRIVY_SIGNER_REMOVAL", reason: "PRIVY_UNAVAILABLE", transactionHash: HASH, onchainPaused: true });
});

test("signer removal reads fresh state and refuses to remove all when any non-Lintcha signer is present", async () => {
  let removals = 0;
  const { controller, calls } = setup({
    privyAdapter: {
      async getSignerState({ address }) {
        calls.push(["get-signers", { address }]);
        return { walletAddress: address, additionalSigners: [{ signerId: SIGNER, policyIds: [POLICY] }, { signerId: "owner_other_123", policyIds: ["policy_other_123"] }] };
      },
      async removeSigners() { removals += 1; },
    },
  });
  const result = await controller.deactivate(WALLET);
  assert.equal(removals, 0);
  assert.deepEqual(calls.map(([name]) => name), ["deactivate-api", "wallet", "finality", "get-signers"]);
  assert.equal(result.reason, "SIGNER_STATE_MANUAL_RECOVERY_REQUIRED");
  assert.equal(result.pendingRemoval, true);
});

test("local shutdown failure aborts before wallet or Privy calls", async () => {
  let downstreamCalls = 0;
  const { controller } = setup({
    api: { async prepareDelegation() {}, async activateDelegation() { return { active: true }; }, async deactivateDelegation() { throw new Error("AUTO_BUY_DISABLED"); } },
    walletAdapter: { async sendTransaction() { downstreamCalls += 1; return HASH; } },
    privyAdapter: { async addSigners() { downstreamCalls += 1; }, async removeSigners() { downstreamCalls += 1; } },
  });
  await assert.rejects(controller.deactivate(WALLET), /AUTO_BUY_DISABLED/);
  assert.equal(downstreamCalls, 0);
});

test("secret-like Privy output is refused before API activation", async () => {
  let activations = 0;
  const { controller } = setup({
    api: {
      async prepareDelegation(input) { const { walletAddress, ...preparedLimits } = input; return { activationToken: ACTIVATION_TOKEN, limits: preparedLimits, transaction: { chainId: 4663, to: WRAPPER, value: "0", data: configureCalldata(preparedLimits) } }; },
      async activateDelegation() { activations += 1; return { active: true }; },
      async deactivateDelegation() { return { active: false, pauseTransaction: PAUSE_TRANSACTION }; },
    },
    privyAdapter: { async addSigners() { return { nested: { authorizationPrivateKey: "never" } }; }, async removeSigners() {} },
  });
  await assert.rejects(controller.activate({ walletAddress: WALLET, maxTransactionNative: "1", maxDailyNative: "1", maxSlippagePercent: "1", durationHours: "1" }), /SECRET/);
  assert.equal(activations, 0);
});
