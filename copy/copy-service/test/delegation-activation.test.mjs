import assert from "node:assert/strict";
import test from "node:test";
import {
  CONFIGURE_SELECTOR, LIMITS_SELECTOR, SET_USER_PAUSED_SELECTOR, DelegationActivationCodec,
  assertConfiguredLimits, configureTransaction, decodeConfiguredLimits, pauseTransaction,
  readFinalizedConfiguredLimits, validateActivationLimits,
} from "../src/delegation-activation.mjs";
import { RpcPool } from "../src/rpc-pool.mjs";
import { BLOCK_HASH, NOW, ROUTER, WALLET, provider, word } from "./helpers.mjs";

const config = { policy: { maxTransactionWei: "1000", maxDailySpendWei: "3000", maxSlippageBps: 100 }, delegationMaxTtlSeconds: 7200 };
const limits = { maxTransactionWei: "500", maxDailySpendWei: "1500", maxSlippageBps: 50, expiresAt: NOW + 3600 };
const encodedLimits = (value = limits, paused = false) => `0x${word(value.maxTransactionWei)}${word(value.maxDailySpendWei)}${word(value.maxSlippageBps)}${word(value.expiresAt)}${word(paused ? 1 : 0)}`;

test("builds exact wrapper configure/pause calldata and validates bounded integer limits", () => {
  const normalized = validateActivationLimits(limits, config, NOW);
  const configure = configureTransaction(ROUTER, normalized, 4663);
  assert.equal(configure.data, `${CONFIGURE_SELECTOR}${word(500)}${word(1500)}${word(50)}${word(NOW + 3600)}`);
  assert.deepEqual(pauseTransaction(ROUTER, 4663), { chainId: 4663, to: ROUTER, value: "0", data: `${SET_USER_PAUSED_SELECTOR}${word(1)}` });
  assert.throws(() => validateActivationLimits({ ...limits, maxTransactionWei: "1001" }, config, NOW), /CAP/);
  assert.throws(() => validateActivationLimits({ ...limits, maxSlippageBps: 101 }, config, NOW), /SLIPPAGE/);
  assert.throws(() => validateActivationLimits({ ...limits, expiresAt: NOW + 7201 }, config, NOW), /EXPIRY/);
});

test("activation challenge is user, wallet, limit and expiry bound", () => {
  const codec = new DelegationActivationCodec(Buffer.alloc(32, 9), { random: () => Buffer.alloc(16, 7) });
  const token = codec.issue({ userId: "42", walletAddress: WALLET, limits }, NOW);
  assert.deepEqual(codec.verify(token, { userId: "42", walletAddress: WALLET }, NOW + 1).limits, limits);
  assert.throws(() => codec.verify(token, { userId: "43", walletAddress: WALLET }, NOW + 1), /ACTIVATION_TOKEN/);
  assert.throws(() => codec.verify(`${token}x`, { userId: "42", walletAddress: WALLET }, NOW + 1), /ACTIVATION_TOKEN/);
  assert.throws(() => codec.verify(token, { userId: "42", walletAddress: WALLET }, NOW + 600), /ACTIVATION_TOKEN/);
});

test("reads exact finalized limits from two providers and refuses mismatch or malformed ABI", async () => {
  const finalizedHash = `0x${"c".repeat(64)}`;
  const ethCall = ({ params }) => {
    assert.equal(params[0].to, ROUTER);
    assert.equal(params[0].data, `${LIMITS_SELECTOR}${WALLET.slice(2).padStart(64, "0")}`);
    assert.equal(params[1], "0x64");
    return encodedLimits();
  };
  const block = ({ params }) => params[0] === "0x65"
    ? { number: "0x65", hash: BLOCK_HASH, parentHash: finalizedHash }
    : { number: "0x64", hash: finalizedHash, parentHash: `0x${"0".repeat(64)}` };
  const overrides = { eth_blockNumber: "0x65", eth_call: ethCall, eth_getBlockByNumber: block };
  const rpcPool = new RpcPool({ providers: [provider("one", overrides), provider("two", overrides)], chainId: 4663 });
  const readback = await readFinalizedConfiguredLimits({ rpcPool, wrapperAddress: ROUTER, walletAddress: WALLET });
  assert.deepEqual(readback.limits, { ...limits, paused: false });
  assert.equal(readback.blockNumber, 100);
  assert.equal(readback.blockHash, finalizedHash);
  assertConfiguredLimits(readback.limits, limits, NOW);
  assert.throws(() => assertConfiguredLimits({ ...readback.limits, paused: true }, limits, NOW), /MISMATCH/);
  assert.throws(() => decodeConfiguredLimits("0x01"), /UNREADABLE/);
});
