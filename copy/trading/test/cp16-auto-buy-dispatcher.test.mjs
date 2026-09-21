import assert from "node:assert/strict";
import test from "node:test";
import { CHAIN_ID, PONS_V2_FACTORY, ZERO_ADDRESS } from "../src/constants.mjs";
import { AutoBuyDispatcher } from "../src/dispatcher/auto-buy-dispatcher.mjs";

const wallet = "0x6666666666666666666666666666666666666666";
const token = "0x5555555555555555555555555555555555555555";
const curve = "0x4444444444444444444444444444444444444444";
const executor = "0x7777777777777777777777777777777777777777";

function event(direction = "BUY", state = "CONFIRMED") {
  return { sourceId: `4663:0x${"a".repeat(64)}:0`, state, direction, sourceAmount: "1000", factory: PONS_V2_FACTORY, curve, targetToken: token, pairToken: ZERO_ADDRESS };
}

function subscription(mode = "AUTO_BUY") {
  return {
    userId: "42", walletAddress: wallet, mode,
    rule: { id: "r1", revision: 1, direction: "BUY_AND_SELL", sizingPolicy: "SOURCE_RATIO", sizingValue: "5000", maxPerTrade: "600", maxPerDay: "1000", minSourceAmount: null, maxSlippageBps: 100, maxPriceImpactBps: 200, quoteTtlSeconds: 30, cooldownSeconds: 0, filters: {}, status: "active" },
    context: { globalPaused: false, duplicate: false, hasPosition: false, lastTradeAt: null, nowSeconds: 1_000, dailyUsed: "0", availableQuoteBalance: "1000", availableTokenBalance: "1000" },
  };
}

function fixture() {
  const notices = [];
  const submissions = [];
  const quoteEngine = { async quote(input) { return { id: "q1", venue: "PONS_V2_CURVE", chainId: CHAIN_ID, direction: input.direction, factory: input.launch.factory, curve: input.launch.curve, pairToken: input.launch.pairToken, recipient: input.recipient, targetToken: input.launch.token, amountIn: input.amountIn, expectedOutput: "900", minimumOutput: "850", slippageBps: input.slippageBps, expiresAt: input.nowSeconds + input.ttlSeconds }; } };
  const copyService = { async executeAutomaticBuy(input) { submissions.push(input); return { intentId: "i1", state: "SUBMITTED_PENDING_RECONCILIATION" }; } };
  const notifier = { async notify(input) { notices.push(input); } };
  return { dispatcher: new AutoBuyDispatcher({ quoteEngine, copyService, notifier, executorAddress: executor, clock: () => 1_000 }), notices, submissions };
}

test("confirmed source BUY becomes one unsigned BUY-only wrapper request", async () => {
  const current = fixture();
  const [result] = await current.dispatcher.dispatch(event(), [subscription()]);
  assert.equal(result.outcome, "SUBMITTED_PENDING_RECONCILIATION");
  assert.equal(current.submissions.length, 1);
  assert.equal(current.submissions[0].transaction.to, executor);
  assert.equal(current.submissions[0].transaction.data.slice(0, 10), "0xa59ac6dd");
  assert.equal(current.submissions[0].transaction.value, "500");
});

test("SELL is never dispatched automatically and notify-only never enters Copy execution", async () => {
  const current = fixture();
  const [manual] = await current.dispatcher.dispatch(event("SELL"), [subscription()]);
  const [notify] = await current.dispatcher.dispatch(event("BUY"), [subscription("NOTIFY_ONLY")]);
  assert.equal(manual.outcome, "MANUAL_SELL_REQUIRED");
  assert.equal(notify.outcome, "NOTIFIED");
  assert.equal(current.submissions.length, 0);
  assert.deepEqual(current.notices.map(({ action }) => action), ["MANUAL_SELL", "NOTIFY"]);
});

test("provisional or retracted source events fail before per-user work", async () => {
  const current = fixture();
  await assert.rejects(current.dispatcher.dispatch(event("BUY", "PROVISIONAL"), [subscription()]), /SOURCE_NOT_CONFIRMED/);
  await assert.rejects(current.dispatcher.dispatch(event("BUY", "RETRACTED"), [subscription()]), /SOURCE_NOT_CONFIRMED/);
  assert.equal(current.submissions.length, 0);
});

test("one bad subscription is isolated and does not stop a safe subscriber", async () => {
  const current = fixture();
  const broken = subscription(); broken.userId = "bad"; broken.rule.maxPerTrade = "0";
  const results = await current.dispatcher.dispatch(event(), [broken, subscription()]);
  assert.equal(results[0].outcome, "REJECTED");
  assert.equal(results[1].outcome, "SUBMITTED_PENDING_RECONCILIATION");
  assert.equal(current.submissions.length, 1);
});
