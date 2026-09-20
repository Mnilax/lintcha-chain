import test from "node:test";
import assert from "node:assert/strict";
import { HashChainedAuditLog, MemoryAuditSink } from "../src/audit.mjs";
import { ExecutionPolicyGate, InMemorySpendLedger, KillSwitches } from "../src/policy.mjs";
import { RpcPool } from "../src/rpc-pool.mjs";
import { SimulationQuorum } from "../src/simulation.mjs";
import { LintchaCopyService } from "../src/service.mjs";
import { fixtureProvider, loadFixture } from "./fixture-rpc.mjs";

const PONS_V2_BUY = "0x59a87bc1";
const PONS_V2_SELL = "0xd04c6983";

function serviceFor(fixture, { allowance = null, head = null, maxTx = "100000000000000000", maxDay = "200000000000000000", sellCap = "1000000000000000000000000000" } = {}) {
  const providers = [fixtureProvider("alchemy", fixture, { allowance, head }), fixtureProvider("quicknode", fixture, { allowance, head })];
  const rpcPool = new RpcPool({ providers, chainId: 4663, maxHeadSkewBlocks: 2 });
  const killSwitches = new KillSwitches({ globallyPaused: false });
  const spendLedger = new InMemorySpendLedger();
  const policyGate = new ExecutionPolicyGate({ killSwitches, spendLedger, config: {
    chains: [4663], routers: [fixture.source.curve.toLowerCase()], spenders: [fixture.source.curve.toLowerCase()], selectors: [PONS_V2_BUY, PONS_V2_SELL, "0x095ea7b3"],
    maxSlippageBps: 300, maxTransactionWei: maxTx, maxDailySpendWei: maxDay, maxSellAmountByToken: { [fixture.source.token.toLowerCase()]: sellCap },
  } });
  const clock = () => 1_758_146_000;
  const service = new LintchaCopyService({ policyGate, simulator: new SimulationQuorum({ rpcPool }), rpcPool, auditLog: new HashChainedAuditLog({ sink: new MemoryAuditSink(), clock: () => 1 }), confirmationSecret: Buffer.alloc(32, 1), clock });
  return { service, spendLedger, providers, clock };
}

test("recorded Pons V2 mainnet BUY calldata passes policy, simulates at one common block and reconciles exactly", async () => {
  const fixture = loadFixture("pons-v2-mainnet-buy");
  const { service, spendLedger, providers, clock } = serviceFor(fixture);
  const amountIn = fixture.transaction.value;
  const created = await service.createConfirmEachIntent({
    userId: "42", walletAddress: fixture.transaction.from, sourceTradeId: "pons-buy-1",
    quote: { id: "q-pons-buy", direction: "BUY", targetToken: fixture.source.token, amountIn, expectedOutput: "1", minimumOutput: "1", slippageBps: 100, expiresAt: clock() + 60, venue: "Pons V2 bonding curve" },
    transaction: { chainId: 4663, to: fixture.transaction.to, value: amountIn, data: fixture.transaction.input },
  });
  assert.equal(created.state, "AWAITING_USER_CONFIRMATION");
  const opened = await service.beginSecureSheetConfirmation({ token: created.confirmationToken, userId: "42", revision: created.revision });
  assert.equal(opened.review.selector, PONS_V2_BUY);
  assert.equal(opened.review.target, fixture.source.curve.toLowerCase());
  assert.equal(opened.simulation.blockHash, fixture.block.hash.toLowerCase());
  assert.equal(opened.simulation.providerIds.join(","), "alchemy,quicknode");
  // Simulation used the same numeric block tag on both providers.
  for (const provider of providers) assert.equal(provider.calls.filter((call) => call.method === "eth_call")[0].params[1], fixture.block.number.replace(/^0x0*/, "0x"));
  await service.recordClientSubmission({ intentId: created.intentId, userId: "42", revision: opened.revision, transactionHash: fixture.transaction.hash });
  const reconciled = await service.reconcile(created.intentId);
  assert.equal(reconciled.state, "CONFIRMED");
  assert.equal((await spendLedger.get(created.intentId)).state, "COMMITTED");
  assert.equal(providers.every((provider) => provider.calls.every((call) => !/send|sign/i.test(call.method))), true);
});

test("the same BUY is refused when the cap, the value or the selector is off by one", async () => {
  const fixture = loadFixture("pons-v2-mainnet-buy");
  const amountIn = fixture.transaction.value;
  const base = (overrides = {}) => ({
    userId: "42", walletAddress: fixture.transaction.from, sourceTradeId: "pons-buy-2",
    quote: { id: "q-pons-buy-2", direction: "BUY", targetToken: fixture.source.token, amountIn, expectedOutput: "1", minimumOutput: "1", slippageBps: 100, expiresAt: 1_758_146_060 },
    transaction: { chainId: 4663, to: fixture.transaction.to, value: amountIn, data: fixture.transaction.input },
    ...overrides,
  });
  await assert.rejects(serviceFor(fixture, { maxTx: (BigInt(amountIn) - 1n).toString() }).service.createConfirmEachIntent(base()), /TRANSACTION_CAP_EXCEEDED/);
  await assert.rejects(serviceFor(fixture).service.createConfirmEachIntent(base({ transaction: { chainId: 4663, to: fixture.transaction.to, value: (BigInt(amountIn) + 1n).toString(), data: fixture.transaction.input } })), /QUOTE_VALUE_MISMATCH/);
  await assert.rejects(serviceFor(fixture).service.createConfirmEachIntent(base({ transaction: { chainId: 4663, to: fixture.transaction.to, value: amountIn, data: `0x59a87bc2${fixture.transaction.input.slice(10)}` } })), /SELECTOR_NOT_ALLOWLISTED/);
  await assert.rejects(serviceFor(fixture).service.createConfirmEachIntent(base({ transaction: { chainId: 4663, to: fixture.source.factory, value: amountIn, data: fixture.transaction.input } })), /ROUTER_NOT_ALLOWLISTED/);
  // Providers whose heads disagree by more than the allowed skew never reach simulation.
  const skewed = serviceFor(fixture);
  skewed.providers[1].request = ((original) => async (method, params) => method === "eth_blockNumber" ? `0x${(Number(BigInt(fixture.block.number)) + 5).toString(16)}` : original(method, params))(skewed.providers[1].request);
  await assert.rejects(skewed.service.createConfirmEachIntent(base()), /RPC_HEAD_SKEW/);
});

test("recorded Pons V2 mainnet SELL calldata needs the manual flag, a token cap and a live allowance", async () => {
  const fixture = loadFixture("pons-v2-mainnet-sell");
  const amountIn = `0x${fixture.transaction.input.slice(10, 74)}`;
  const quote = { id: "q-pons-sell", direction: "SELL", targetToken: fixture.source.token, amountIn: BigInt(amountIn).toString(), expectedOutput: "1", minimumOutput: "1", slippageBps: 100, expiresAt: 1_758_146_060 };
  const transaction = { chainId: 4663, to: fixture.transaction.to, value: "0", data: fixture.transaction.input };
  await assert.rejects(serviceFor(fixture, { allowance: amountIn }).service.createConfirmEachIntent({ userId: "42", walletAddress: fixture.transaction.from, sourceTradeId: "pons-sell-1", quote, transaction }), /AUTO_SELL_FORBIDDEN/);
  await assert.rejects(serviceFor(fixture, { allowance: (BigInt(amountIn) - 1n).toString() }).service.createConfirmEachIntent({ userId: "42", walletAddress: fixture.transaction.from, sourceTradeId: "pons-sell-1", quote, transaction, manualSell: true }), /SELL_ALLOWANCE_INSUFFICIENT/);
  await assert.rejects(serviceFor(fixture, { allowance: amountIn, sellCap: "1" }).service.createConfirmEachIntent({ userId: "42", walletAddress: fixture.transaction.from, sourceTradeId: "pons-sell-1", quote, transaction, manualSell: true }), /TRANSACTION_CAP_EXCEEDED/);
  const { service } = serviceFor(fixture, { allowance: amountIn });
  const created = await service.createConfirmEachIntent({ userId: "42", walletAddress: fixture.transaction.from, sourceTradeId: "pons-sell-1", quote, transaction, manualSell: true });
  assert.equal(created.state, "AWAITING_USER_CONFIRMATION");
  const opened = await service.beginSecureSheetConfirmation({ token: created.confirmationToken, userId: "42", revision: created.revision });
  assert.equal(opened.review.selector, PONS_V2_SELL);
  await service.recordClientSubmission({ intentId: created.intentId, userId: "42", revision: opened.revision, transactionHash: fixture.transaction.hash });
  assert.equal((await service.reconcile(created.intentId)).state, "CONFIRMED");
});
