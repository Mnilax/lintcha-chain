import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAIN_ID, UNISWAP_V2_ROUTER02, WRAPPED_NATIVE } from "../src/constants.mjs";
import { buildExactApproval } from "../src/execution/builder.mjs";
import { ExecutionCoordinator, OfflineBroadcaster } from "../src/execution/lifecycle.mjs";
import { QuoteEngine } from "../src/execution/quote.mjs";

const token = "0x5555555555555555555555555555555555555555";
const recipient = "0x6666666666666666666666666666666666666666";
const blockHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function provider({ amountOut = "1000", priceImpactBps = 50 } = {}) {
  return {
    async getBlockReference() { return { number: 100, hash: blockHash }; },
    async getAmountsOut() { return { amountOut, priceImpactBps, estimatedGas: "150000" }; },
  };
}

async function quote(direction = "BUY", patches = {}) {
  const engine = new QuoteEngine({ provider: provider(patches.provider) });
  return engine.quote({ direction, targetToken: token, amountIn: "100", recipient, slippageBps: 100, maxPriceImpactBps: 200, ttlSeconds: 30, nowSeconds: 1000, sourceState: "CONFIRMED", ...patches.input });
}

const match = { id: "fixture-match" };
const fakeSigner = { async signLocally(transaction) { return { fixtureOnly: true, transaction }; } };
const fixtureBroadcaster = { async submit() { return "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; } };

test("CP5: local simulated BUY lifecycle reaches a controlled receipt", async () => {
  const q = await quote("BUY");
  const coordinator = new ExecutionCoordinator({ signer: fakeSigner, broadcaster: fixtureBroadcaster, broadcastEnabled: true });
  const order = coordinator.prepare({ match, quote: q, availableBalance: "1000", maxPerTrade: "500", remainingDailyCap: "500", globalPaused: false, nowSeconds: 1001 });
  const review = coordinator.review(order);
  assert.equal(review.router, UNISWAP_V2_ROUTER02);
  assert.equal(review.minimumReceived, "990");
  assert.deepEqual(q.path, [WRAPPED_NATIVE, token]);
  coordinator.approve(order, { quoteFingerprint: order.quoteFingerprint, nowSeconds: 1002 });
  await coordinator.sign(order, { nowSeconds: 1003 });
  await coordinator.submit(order, { nowSeconds: 1004 });
  coordinator.recordReceipt(order, { transactionHash: order.transactionHash, status: 1, blockNumber: 101 }, { nowSeconds: 1005 });
  assert.equal(order.state, "CONFIRMED");
});

test("CP5: SELL uses exact approval and controlled proportional amount", async () => {
  const q = await quote("SELL");
  assert.deepEqual(q.path, [token, WRAPPED_NATIVE]);
  const approval = buildExactApproval({ token, spender: q.spender, amount: q.amountIn, chainId: CHAIN_ID });
  assert.equal(approval.approvalAmount, "100");
  assert.equal(approval.data.slice(0, 10), "0x095ea7b3");
  assert.notEqual(approval.approvalAmount, ((1n << 256n) - 1n).toString());
});

test("CP5: stale quote, cap, balance and price impact fail closed", async () => {
  const q = await quote("BUY");
  const coordinator = new ExecutionCoordinator({ signer: fakeSigner, broadcaster: new OfflineBroadcaster() });
  assert.throws(() => coordinator.prepare({ match, quote: q, availableBalance: "1000", maxPerTrade: "500", remainingDailyCap: "500", globalPaused: false, nowSeconds: 1031 }), /QUOTE_EXPIRED/);
  assert.throws(() => coordinator.prepare({ match, quote: q, availableBalance: "99", maxPerTrade: "500", remainingDailyCap: "500", globalPaused: false, nowSeconds: 1001 }), /INSUFFICIENT_BALANCE/);
  assert.throws(() => coordinator.prepare({ match, quote: q, availableBalance: "1000", maxPerTrade: "99", remainingDailyCap: "500", globalPaused: false, nowSeconds: 1001 }), /CAP_EXCEEDED/);
  await assert.rejects(() => quote("BUY", { provider: { priceImpactBps: 201 } }), /PRICE_IMPACT_EXCEEDED/);
});

test("CP5: review invalidates when quote fingerprint changes", async () => {
  const q = await quote("BUY");
  const coordinator = new ExecutionCoordinator({ signer: fakeSigner, broadcaster: new OfflineBroadcaster() });
  const order = coordinator.prepare({ match, quote: q, availableBalance: "1000", maxPerTrade: "500", remainingDailyCap: "500", globalPaused: false, nowSeconds: 1001 });
  assert.throws(() => coordinator.approve(order, { quoteFingerprint: "changed", nowSeconds: 1002 }), /QUOTE_CHANGED/);
});

test("CP5: real broadcast is disabled by default", async () => {
  const q = await quote("BUY");
  const coordinator = new ExecutionCoordinator({ signer: fakeSigner, broadcaster: new OfflineBroadcaster() });
  const order = coordinator.prepare({ match, quote: q, availableBalance: "1000", maxPerTrade: "500", remainingDailyCap: "500", globalPaused: false, nowSeconds: 1001 });
  coordinator.approve(order, { quoteFingerprint: order.quoteFingerprint, nowSeconds: 1002 });
  await coordinator.sign(order, { nowSeconds: 1003 });
  await assert.rejects(() => coordinator.submit(order, { nowSeconds: 1004 }), /REAL_BROADCAST_DISABLED/);
});
