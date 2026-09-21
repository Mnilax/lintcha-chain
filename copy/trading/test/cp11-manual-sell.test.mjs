import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAIN_ID, UNISWAP_V2_ROUTER02 } from "../src/constants.mjs";
import { SIGNING_ARCHITECTURES, TRADING_MODES } from "../src/execution/authorization.mjs";
import { ExecutionCoordinator } from "../src/execution/lifecycle.mjs";
import { ManualSellExecutor, StoreManualSellIntentStore } from "../src/execution/manual-sell.mjs";
import { QuoteEngine } from "../src/execution/quote.mjs";
import { TradingStore } from "../src/persistence/store.mjs";
import { ManualSellTelegramService } from "../src/telegram/manual-sell-service.mjs";

const wallet = "0x6666666666666666666666666666666666666666";
const token = "0x5555555555555555555555555555555555555555";
const blockHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function profile() {
  return {
    userId: "u1",
    mode: TRADING_MODES.COPY_TRADING,
    status: "active",
    architecture: SIGNING_ARCHITECTURES.ERC4337_SESSION_KEY,
    authorizationId: "session:fixture:1234",
    chainId: CHAIN_ID,
    publicAddress: wallet,
    expiresAt: 2_000,
    allowedDirections: ["BUY", "SELL"],
    allowedTargets: [token, UNISWAP_V2_ROUTER02],
    platformFeeBps: 0,
  };
}

async function harness({ positionBalance = "1000", quoteNow = 1_000, matchId = "sell-match" } = {}) {
  const quoteEngine = new QuoteEngine({ provider: {
    async getBlockReference() { return { number: 100, hash: blockHash }; },
    async getAmountsOut() { return { amountOut: "250", priceImpactBps: 60, estimatedGas: "170000" }; },
  } });
  const quote = await quoteEngine.quote({ direction: "SELL", targetToken: token, amountIn: "100", recipient: wallet, slippageBps: 100, maxPriceImpactBps: 200, ttlSeconds: 30, nowSeconds: quoteNow, sourceState: "CONFIRMED" });
  const coordinator = new ExecutionCoordinator({
    signer: { async signDelegated(transaction, authorization) { return { transaction, authorizationId: authorization.authorizationId }; } },
    broadcaster: { async submit(reference) { assert.equal(reference.authorizationId, "session:fixture:1234"); return `0x${"d".repeat(64)}`; } },
    broadcastEnabled: true,
  });
  const order = coordinator.prepare({ match: { id: matchId }, quote, availableBalance: positionBalance, maxPerTrade: positionBalance, remainingDailyCap: positionBalance, globalPaused: false, nowSeconds: quoteNow + 1 });
  const store = new TradingStore();
  store.createUser({ id: "u1", telegramUserId: "1", now: 0 });
  const executor = new ManualSellExecutor({
    coordinator,
    intentStore: new StoreManualSellIntentStore({ store, now: () => 0 }),
    positionReader: { async balanceOf() { return positionBalance; } },
    callbackSecret: "FIXTURE_CALLBACK_SECRET_32_BYTES_LONG",
    enabled: true,
  });
  return { coordinator, executor, order, store };
}

test("CP11: manual SELL requires review and a second owner-bound callback", async () => {
  const { executor, order, store } = await harness();
  const review = await executor.review({ profile: profile(), order, userId: "u1", positionBalance: "1000", nowSeconds: 1_002 });
  assert.equal(review.review.direction, "SELL");
  assert.ok(review.confirmationToken.length <= 64);
  await assert.rejects(executor.confirm({ profile: profile(), token: review.confirmationToken, userId: "other", nowSeconds: 1_003 }), /OWNER_MISMATCH/);
  const result = await executor.confirm({ profile: profile(), token: review.confirmationToken, userId: "u1", nowSeconds: 1_003 });
  assert.equal(result.outcome, "SUBMITTED");
  assert.match(result.transactionHash, /^0x[d]{64}$/);
  assert.equal(store.getManualSellIntent(review.intentId).state, "SUBMITTED");
  await assert.rejects(executor.confirm({ profile: profile(), token: review.confirmationToken, userId: "u1", nowSeconds: 1_004 }), /INVALID_MANUAL_SELL_CALLBACK/);
  store.close();
});

test("CP11: expired quote is not submitted and releases pending position through expiry", async () => {
  const { executor, order, store } = await harness();
  const review = await executor.review({ profile: profile(), order, userId: "u1", positionBalance: "1000", nowSeconds: 1_002 });
  await assert.rejects(executor.confirm({ profile: profile(), token: review.confirmationToken, userId: "u1", nowSeconds: 1_030 }), /QUOTE_EXPIRED/);
  assert.equal(store.getManualSellIntent(review.intentId).state, "EXPIRED");
  store.close();
});

test("CP11: concurrent manual SELL reviews cannot reserve more tokens than held", async () => {
  const first = await harness({ positionBalance: "150", matchId: "sell-one" });
  const review = await first.executor.review({ profile: profile(), order: first.order, userId: "u1", positionBalance: "150", nowSeconds: 1_002 });
  assert.ok(review.intentId);
  const secondQuoteEngine = new QuoteEngine({ provider: {
    async getBlockReference() { return { number: 100, hash: blockHash }; },
    async getAmountsOut() { return { amountOut: "250", priceImpactBps: 60, estimatedGas: "170000" }; },
  } });
  const secondQuote = await secondQuoteEngine.quote({ direction: "SELL", targetToken: token, amountIn: "100", recipient: wallet, slippageBps: 100, maxPriceImpactBps: 200, ttlSeconds: 30, nowSeconds: 1_000, sourceState: "CONFIRMED" });
  const secondOrder = first.coordinator.prepare({ match: { id: "sell-two" }, quote: secondQuote, availableBalance: "150", maxPerTrade: "150", remainingDailyCap: "150", globalPaused: false, nowSeconds: 1_001 });
  await assert.rejects(first.executor.review({ profile: profile(), order: secondOrder, userId: "u1", positionBalance: "150", nowSeconds: 1_002 }), /POSITION_RESERVED/);
  first.store.close();
});

test("CP11: manual SELL remains unavailable without SELL delegation", async () => {
  const { executor, order, store } = await harness();
  await assert.rejects(executor.review({ profile: { ...profile(), allowedDirections: ["BUY"] }, order, userId: "u1", positionBalance: "1000", nowSeconds: 1_002 }), /MANUAL_SELL_NOT_ALLOWED/);
  store.close();
});

test("CP11: signal review token is owner-bound, revision-bound, and one-time", async () => {
  const { executor, order, store } = await harness();
  const event = { sourceId: "4663:source:1", revision: 3, direction: "SELL", state: "CONFIRMED" };
  const service = new ManualSellTelegramService({
    eventReader: { async get() { return event; } },
    orderFactory: { async createSellOrder() { return { order, positionBalance: "1000" }; } },
    profileReader: { async get() { return profile(); } },
    executor,
    callbackSecret: "FIXTURE_SIGNAL_CALLBACK_SECRET_32_BYTES",
  });
  const tokenForWrongOwner = service.registerSignal({ userId: "u1", event, nowSeconds: 1_001 });
  await assert.rejects(service.review({ userId: "u2", signalToken: tokenForWrongOwner, nowSeconds: 1_002 }), /OWNER_MISMATCH/);
  const reviewed = await service.review({ userId: "u1", signalToken: tokenForWrongOwner, nowSeconds: 1_002 });
  assert.equal(reviewed.amount, "100");
  await assert.rejects(service.review({ userId: "u1", signalToken: tokenForWrongOwner, nowSeconds: 1_003 }), /INVALID_MANUAL_SELL_SIGNAL/);
  const submitted = await service.confirm({ userId: "u1", confirmationToken: reviewed.confirmationToken, nowSeconds: 1_003 });
  assert.equal(submitted.outcome, "SUBMITTED");
  store.close();
});
