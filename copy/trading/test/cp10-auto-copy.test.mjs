import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAIN_ID, PONS_V2_FACTORY, UNISWAP_V2_ROUTER02, ZERO_ADDRESS } from "../src/constants.mjs";
import { AutomaticCopyExecutor } from "../src/execution/automatic.mjs";
import { SIGNING_ARCHITECTURES, TRADING_MODES, assertExecutionAuthorization } from "../src/execution/authorization.mjs";
import { buildPonsV2AutoBuyTransaction, buildPonsV2CurveTransaction } from "../src/execution/builder.mjs";
import { ExecutionCoordinator } from "../src/execution/lifecycle.mjs";
import { PonsV2QuoteEngine } from "../src/execution/pons-v2-quote.mjs";
import { QuoteEngine } from "../src/execution/quote.mjs";
import { TradingStore } from "../src/persistence/store.mjs";

const wallet = "0x6666666666666666666666666666666666666666";
const token = "0x5555555555555555555555555555555555555555";
const curve = "0x4444444444444444444444444444444444444444";
const blockHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function activeProfile(patches = {}) {
  return {
    userId: "u1",
    mode: TRADING_MODES.COPY_TRADING,
    status: "active",
    architecture: SIGNING_ARCHITECTURES.ERC4337_SESSION_KEY,
    authorizationId: "session:fixture:1234",
    chainId: CHAIN_ID,
    publicAddress: wallet,
    expiresAt: 2_000,
    allowedDirections: ["BUY"],
    allowedTargets: [UNISWAP_V2_ROUTER02],
    platformFeeBps: 0,
    maxPerTrade: "500",
    maxPerDay: "1000",
    ...patches,
  };
}

function spendGuard() {
  const states = new Map();
  return {
    async reserve({ id }) {
      const existing = states.get(id);
      if (existing) return { reserved: false, duplicate: true, ...existing };
      states.set(id, { state: "RESERVED", transactionHash: null });
      return { reserved: true, duplicate: false, state: "RESERVED", usedBefore: "100" };
    },
    async markSigning(id) { states.set(id, { state: "SIGNING", transactionHash: null }); },
    async markSubmitted(id, transactionHash) { states.set(id, { state: "SUBMITTED", transactionHash }); },
    async release(id) { states.set(id, { state: "RELEASED", transactionHash: null }); },
  };
}

async function uniswapOrder() {
  const engine = new QuoteEngine({ provider: {
    async getBlockReference() { return { number: 100, hash: blockHash }; },
    async getAmountsOut() { return { amountOut: "1000", priceImpactBps: 50, estimatedGas: "150000" }; },
  } });
  const quote = await engine.quote({ direction: "BUY", targetToken: token, amountIn: "100", recipient: wallet, slippageBps: 100, maxPriceImpactBps: 200, ttlSeconds: 30, nowSeconds: 1_000, sourceState: "CONFIRMED" });
  const coordinator = new ExecutionCoordinator({
    signer: { async signDelegated(transaction, authorization) { return { transaction, authorizationId: authorization.authorizationId }; } },
    broadcaster: { async submit(reference) { assert.equal(reference.authorizationId, "session:fixture:1234"); return `0x${"b".repeat(64)}`; } },
    broadcastEnabled: true,
  });
  const order = coordinator.prepare({ match: { id: "match" }, quote, availableBalance: "1000", maxPerTrade: "500", remainingDailyCap: "1000", globalPaused: false, nowSeconds: 1_001 });
  return { coordinator, order };
}

test("CP10: notify-only mode never signs or submits", async () => {
  const { coordinator, order } = await uniswapOrder();
  const executor = new AutomaticCopyExecutor({ coordinator, spendGuard: spendGuard(), enabled: true });
  const result = await executor.dispatch({ profile: { mode: TRADING_MODES.NOTIFY_ONLY }, order, nowSeconds: 1_002 });
  assert.deepEqual(result, { outcome: "NOTIFIED", orderId: order.id, transactionSubmitted: false });
  assert.equal(order.state, "QUOTED");
});

test("CP10: automatic mode signs through delegated authorization and submits", async () => {
  const { coordinator, order } = await uniswapOrder();
  const executor = new AutomaticCopyExecutor({ coordinator, spendGuard: spendGuard(), enabled: true });
  const result = await executor.dispatch({ profile: activeProfile(), order, utcDay: "2026-09-18", nowSeconds: 1_002 });
  assert.equal(result.outcome, "SUBMITTED");
  assert.equal(order.state, "SUBMITTED");
  assert.match(result.transactionHash, /^0x[b]{64}$/);
  assert.equal(order.history.at(-1).reason, "BROADCAST_ACCEPTED");
});

test("CP10: automatic execution remains kill-switched independently", async () => {
  const { coordinator, order } = await uniswapOrder();
  const executor = new AutomaticCopyExecutor({ coordinator, spendGuard: spendGuard() });
  await assert.rejects(executor.dispatch({ profile: activeProfile(), order, nowSeconds: 1_002 }), /AUTOMATIC_EXECUTION_DISABLED/);
});

test("CP10: authorization fails closed on expiry, targets, and caps", () => {
  const transaction = { chainId: CHAIN_ID, to: UNISWAP_V2_ROUTER02, value: "100", data: "0x" };
  const base = { ...activeProfile(), recipient: wallet, orderAmount: "100", orderDirection: "BUY" };
  assert.throws(() => assertExecutionAuthorization({ ...base, expiresAt: 1_000 }, transaction, { nowSeconds: 1_000 }), /EXPIRED/);
  assert.throws(() => assertExecutionAuthorization({ ...base, allowedTargets: [token] }, transaction, { nowSeconds: 1_000 }), /TARGET_NOT_ALLOWED/);
  assert.throws(() => assertExecutionAuthorization({ ...base, maxPerTrade: "99" }, transaction, { nowSeconds: 1_000 }), /TRADE_CAP_EXCEEDED/);
  assert.throws(() => assertExecutionAuthorization(base, transaction, { nowSeconds: 1_000, dailyUsed: "901" }), /DAILY_CAP_EXCEEDED/);
  assert.throws(() => assertExecutionAuthorization({ ...base, platformFeeBps: 100 }, transaction, { nowSeconds: 1_000 }), /FEE_ROUTE_UNAVAILABLE/);
  assert.throws(() => assertExecutionAuthorization({ ...base, orderDirection: "SELL", allowedDirections: ["SELL"] }, transaction, { nowSeconds: 1_000 }), /AUTO_SELL_NOT_ENABLED/);
});

test("CP10: Pons V2 native curve BUY is quoted and built from verified provenance", async () => {
  const engine = new PonsV2QuoteEngine({ provider: {
    async getBlockReference() { return { number: 100, hash: blockHash }; },
    async getCurveState() { return { factory: PONS_V2_FACTORY, token, pairToken: ZERO_ADDRESS, graduated: false, readyToGraduate: false, quoteReserve: "1000000", tokenReserve: "5000000", reservedTokens: "1000000", feeBps: "100", creatorTaxBps: "50", estimatedGas: "120000" }; },
  } });
  const quote = await engine.quote({ direction: "BUY", launch: { factory: PONS_V2_FACTORY, curve, token, pairToken: ZERO_ADDRESS }, amountIn: "10000", recipient: wallet, slippageBps: 100, maxPriceImpactBps: 200, ttlSeconds: 30, nowSeconds: 1_000, sourceState: "CONFIRMED" });
  const transaction = buildPonsV2CurveTransaction(quote);
  assert.equal(transaction.to, curve);
  assert.equal(transaction.value, "10000");
  assert.equal(transaction.data.slice(0, 10), "0x59a87bc1");
  assert.equal(transaction.provenance.factory, PONS_V2_FACTORY);
});

test("CP10: Pons V2 SELL uses an exact token approval", () => {
  const transaction = buildPonsV2CurveTransaction({ id: "q", venue: "PONS_V2_CURVE", chainId: CHAIN_ID, direction: "SELL", factory: PONS_V2_FACTORY, curve, pairToken: ZERO_ADDRESS, targetToken: token, recipient: wallet, amountIn: "123", minimumOutput: "100", expiresAt: 1_030 });
  assert.equal(transaction.data.slice(0, 10), "0xd04c6983");
  assert.equal(transaction.approval.approvalAmount, "123");
  assert.equal(transaction.approval.spender, curve);
  assert.notEqual(transaction.approval.approvalAmount, ((1n << 256n) - 1n).toString());
});

test("CP10: delegated Pons auto-BUY targets only the Lintcha wrapper and cannot encode SELL", () => {
  const executor = "0x7777777777777777777777777777777777777777";
  const quote = { id: "q-auto", venue: "PONS_V2_CURVE", chainId: CHAIN_ID, direction: "BUY", factory: PONS_V2_FACTORY, curve, pairToken: ZERO_ADDRESS, targetToken: token, recipient: wallet, amountIn: "123", minimumOutput: "100", expiresAt: 1_030 };
  const transaction = buildPonsV2AutoBuyTransaction(quote, { executorAddress: executor });
  assert.equal(transaction.to, executor);
  assert.equal(transaction.data.slice(0, 10), "0xa59ac6dd");
  assert.equal(transaction.value, "123");
  assert.equal(transaction.provenance.curve, curve);
  assert.throws(() => buildPonsV2AutoBuyTransaction({ ...quote, direction: "SELL" }, { executorAddress: executor }), /AUTO_SELL_FORBIDDEN/);
});

test("CP10: execution profile persists references and limits but no key material", () => {
  const store = new TradingStore();
  store.createUser({ id: "u1", telegramUserId: "1", now: 0 });
  const profile = store.upsertExecutionProfile({ userId: "u1", publicAddress: wallet, mode: TRADING_MODES.COPY_TRADING, authorizationStatus: "active", authorizationId: "session:fixture:1234", signingArchitecture: SIGNING_ARCHITECTURES.ERC4337_SESSION_KEY, authorizationExpiresAt: 2_000, maxPerTrade: "500", maxPerDay: "1000", allowedTargets: [UNISWAP_V2_ROUTER02], now: 0 });
  assert.equal(profile.mode, TRADING_MODES.COPY_TRADING);
  assert.deepEqual(profile.allowed_directions, ["BUY"]);
  assert.deepEqual(profile.allowed_targets, [UNISWAP_V2_ROUTER02]);
  assert.doesNotMatch(JSON.stringify(store.safeSnapshot()), /private.?key|seed phrase|mnemonic/i);
  store.close();
});

test("CP10: spend reservations enforce the daily cap atomically and deduplicate orders", () => {
  const store = new TradingStore();
  store.createUser({ id: "u1", telegramUserId: "1", now: 0 });
  const first = store.reserveExecutionSpend({ id: "order-1", userId: "u1", utcDay: "2026-09-18", amount: "600", maxPerDay: "1000", now: 0 });
  assert.equal(first.reserved, true);
  assert.deepEqual(store.reserveExecutionSpend({ id: "order-1", userId: "u1", utcDay: "2026-09-18", amount: "600", maxPerDay: "1000", now: 0 }), { reserved: false, duplicate: true, state: "RESERVED", transactionHash: null });
  assert.throws(() => store.reserveExecutionSpend({ id: "order-2", userId: "u1", utcDay: "2026-09-18", amount: "401", maxPerDay: "1000", now: 0 }), /DAILY_CAP/);
  store.markExecutionReservationSigning("order-1", 1);
  store.markExecutionReservationSubmitted("order-1", `0x${"c".repeat(64)}`, 2);
  assert.equal(store.safeSnapshot().execution_reservations[0].state, "SUBMITTED");
  store.close();
});
