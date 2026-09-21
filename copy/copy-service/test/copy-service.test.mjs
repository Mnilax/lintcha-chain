import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { loadCopyConfig, publicConfig } from "../src/config.mjs";
import { HashChainedAuditLog, MemoryAuditSink, publicAuditPayload } from "../src/audit.mjs";
import { RpcPool } from "../src/rpc-pool.mjs";
import { KillSwitches } from "../src/policy.mjs";
import { GatewayRequestVerifier } from "../src/gateway-auth.mjs";
import { MemoryDelegationStore } from "../src/delegated-execution.mjs";
import { BLOCK_HASH, HASH, NOW, ROUTER, TOKEN, WALLET, approvalInput, fixture, input, openAndSubmit, provider, revert, sellTradeInput, word } from "./helpers.mjs";

test("config is isolated, credential-free capable, and never exposes RPC URLs", () => {
  const config = loadCopyConfig({ COPY_ALLOW_CHAINS: "[4663]", COPY_APP_ORIGIN: "http://localhost:8788" });
  assert.equal(config.dbNamespace, "lintcha_copy");
  assert.equal(config.rpc.ready, false);
  assert.deepEqual(publicConfig(config).providerIds, ["alchemy", "quicknode"]);
  assert.equal(JSON.stringify(publicConfig(config)).includes("URL"), false);
  assert.throws(() => loadCopyConfig({ TELEGRAM_BOT_TOKEN: "x" }), /MUST_NOT_RECEIVE/);
  assert.throws(() => loadCopyConfig({ COPY_AUTO_BUY_ENABLED: "true" }), /AUTO_BUY_FLAGS_MUST_MATCH/);
  const auto = loadCopyConfig({ COPY_AUTO_BUY_ENABLED: "true", COPY_DELEGATED_SUBMISSION_ENABLED: "true" });
  assert.equal(publicConfig(auto).autoBuyEnabled, true);
  assert.equal(publicConfig(auto).delegatedSubmissionEnabled, true);
  assert.throws(() => loadCopyConfig({ COPY_BROADCAST_ENABLED: "true" }), /SERVER_BROADCAST_FORBIDDEN/);
});

test("auto-BUY requires a bounded delegation, submits once and never turns SELL automatic", async () => {
  const delegations = new MemoryDelegationStore(() => 1_700_000_000);
  await delegations.put({
    userId: "42", walletAddress: WALLET, architecture: "EIP7702_SESSION", authorizationRef: "auth:test:42",
    chainId: 4663, routers: [ROUTER], selectors: ["0x12345678"], maxTransactionWei: "600",
    maxDailySpendWei: "700", maxSlippageBps: 75, expiresAt: 1_700_003_600,
  });
  const submissions = [];
  const current = fixture({ service: {
    delegationStore: delegations, autoBuyEnabled: true, delegatedSubmissionEnabled: true,
    delegatedExecutor: { async submit(payload) { submissions.push(payload); return { transactionHash: HASH }; } },
  } });
  const created = await current.service.executeAutomaticBuy(input());
  assert.equal(created.state, "SUBMITTED_PENDING_RECONCILIATION");
  assert.equal(created.executionMode, "AUTO_BUY");
  assert.equal(submissions.length, 1);
  assert.equal("privateKey" in submissions[0], false);
  assert.equal((await current.service.executeAutomaticBuy(input())).duplicate, true);
  assert.equal(submissions.length, 1);
  await assert.rejects(current.service.executeAutomaticBuy(sellTradeInput()), /AUTO_SELL_FORBIDDEN/);
  const noDelegation = fixture({ service: { delegationStore: new MemoryDelegationStore(() => 1_700_000_000), autoBuyEnabled: true, delegatedSubmissionEnabled: true, delegatedExecutor: { submit: async () => ({ transactionHash: HASH }) } } });
  await assert.rejects(noDelegation.service.executeAutomaticBuy(input()), /ACTIVE_DELEGATION_REQUIRED/);
});

test("uncertain delegated submission is never retried and keeps the spend reservation", async () => {
  const delegations = new MemoryDelegationStore(() => 1_700_000_000);
  await delegations.put({ userId: "42", walletAddress: WALLET, architecture: "ERC4337_SESSION", authorizationRef: "auth:uncertain:42", chainId: 4663, routers: [ROUTER], selectors: ["0x12345678"], maxTransactionWei: "600", maxDailySpendWei: "700", maxSlippageBps: 75, expiresAt: 1_700_003_600 });
  let attempts = 0;
  const current = fixture({ service: { delegationStore: delegations, autoBuyEnabled: true, delegatedSubmissionEnabled: true, delegatedExecutor: { async submit() { attempts += 1; throw new Error("network"); } } } });
  const result = await current.service.executeAutomaticBuy(input());
  assert.equal(result.state, "RECONCILIATION_REQUIRED");
  assert.equal(result.manualAttention, true);
  assert.equal(attempts, 1);
  assert.equal(current.spendLedger.reservations.get(result.intentId).state, "RESERVED");
  assert.equal((await current.service.executeAutomaticBuy(input())).duplicate, true);
  assert.equal(attempts, 1);
});

test("auto-BUY rechecks quote expiry after simulation and before delegated submission", async () => {
  const delegations = new MemoryDelegationStore(() => NOW);
  await delegations.put({ userId: "42", walletAddress: WALLET, architecture: "EIP7702_SESSION", authorizationRef: "auth:expiry:42", chainId: 4663, routers: [ROUTER], selectors: ["0x12345678"], maxTransactionWei: "600", maxDailySpendWei: "700", maxSlippageBps: 75, expiresAt: NOW + 3600 });
  let submissions = 0;
  const current = fixture({ service: { delegationStore: delegations, autoBuyEnabled: true, delegatedSubmissionEnabled: true, delegatedExecutor: { async submit() { submissions += 1; return { transactionHash: HASH }; } } } });
  current.service.simulator = { async simulate() { current.advance(81); return { blockNumber: 100, blockHash: BLOCK_HASH, gasLimitFloor: 21_000 }; } };
  await assert.rejects(current.service.executeAutomaticBuy(input()), /STALE_QUOTE/);
  assert.equal(submissions, 0);
  const intent = (await current.service.listUserIntents("42"))[0];
  assert.equal(intent.state, "REJECTED");
  assert.equal(current.spendLedger.reservations.get(intent.intentId).state, "RELEASED");
});

test("audit log rejects sensitive fields and chains records", async () => {
  assert.throws(() => publicAuditPayload({ privateKey: "no" }), /SENSITIVE/);
  const sink = new MemoryAuditSink();
  const log = new HashChainedAuditLog({ sink, clock: () => 10 });
  const first = await log.append("A", { address: WALLET });
  const second = await log.append("B", { txHash: HASH });
  assert.equal(second.previousHash, first.hash);
  assert.equal(sink.records.length, 2);
});

test("RPC health checks chain, common block hash, finality tags and conservative safe block", async () => {
  const { rpcPool } = fixture();
  const health = await rpcPool.healthCheck();
  assert.equal(health.healthy, true);
  assert.equal(health.referenceHash, BLOCK_HASH);
  assert.equal(health.safeBlock, 100);
  assert.equal(health.providers.every((item) => item.safeSupported && item.finalizedSupported), true);
});

test("read failover works but quorum, block disagreement and vendor field noise are handled", async () => {
  const first = provider("a", { eth_getCode: new Error("down") });
  const second = provider("b", { eth_getCode: "0x1234" });
  const pool = new RpcPool({ providers: [first, second] });
  assert.equal(await pool.failoverRead("eth_getCode", [ROUTER, "latest"]), "0x1234");
  await assert.rejects(pool.quorumRead("eth_getCode", [ROUTER, "latest"]), /QUORUM_UNAVAILABLE/);
  const bad = fixture({ secondOverrides: { eth_getBlockByNumber: { number: "0x64", hash: `0x${"c".repeat(64)}` } } });
  await assert.rejects(bad.rpcPool.healthCheck(), /BLOCK_HASH_DISAGREEMENT/);
  // Extra vendor-specific fields on one side are not a disagreement; a different `to` is.
  const noisy = fixture({ secondOverrides: { eth_getTransactionByHash: { hash: HASH, from: WALLET, to: ROUTER, input: "0x12345678", value: "0x1f4", nonce: "0x1", blockHash: BLOCK_HASH, blockNumber: "0x63", yParity: "0x1", type: "0x2" } } });
  assert.equal((await noisy.rpcPool.quorumRead("eth_getTransactionByHash", [HASH])).hash, HASH);
  const different = fixture({ secondOverrides: { eth_getTransactionByHash: { hash: HASH, from: WALLET, to: TOKEN, input: "0x12345678", value: "0x1f4" } } });
  await assert.rejects(different.rpcPool.quorumRead("eth_getTransactionByHash", [HASH]), /RPC_DISAGREEMENT/);
});

test("simulation requires two matching eth_call results, bounded gas skew, and reports reverts", async () => {
  await assert.rejects(fixture({ secondOverrides: { eth_call: "0x02" } }).service.createConfirmEachIntent(input()), /SIMULATION_OUTPUT_DISAGREEMENT/);
  await assert.rejects(fixture({ secondOverrides: { eth_estimateGas: "0x100000" } }).service.createConfirmEachIntent(input()), /SIMULATION_GAS_DISAGREEMENT/);
  await assert.rejects(fixture({ firstOverrides: { eth_call: revert() }, secondOverrides: { eth_call: revert() } }).service.createConfirmEachIntent(input()), /SIMULATION_REVERTED/);
  await assert.rejects(fixture({ secondOverrides: { eth_call: revert() } }).service.createConfirmEachIntent(input()), /SIMULATION_PROVIDER_DISAGREEMENT/);
  await assert.rejects(fixture({ secondOverrides: { eth_call: new Error("timeout") } }).service.createConfirmEachIntent(input()), /SIMULATION_PROVIDER_UNAVAILABLE/);
});

test("global and per-user kill switches fail closed, including between creation and opening", async () => {
  await assert.rejects(fixture({ paused: true }).service.createConfirmEachIntent(input()), /GLOBAL_BROADCAST_KILL_SWITCH/);
  const current = fixture();
  current.killSwitches.pauseUser("42");
  await assert.rejects(current.service.createConfirmEachIntent(input()), /USER_BROADCAST_KILL_SWITCH/);
  const late = fixture();
  const created = await late.service.createConfirmEachIntent(input());
  late.killSwitches.pauseGlobal();
  await assert.rejects(late.service.beginSecureSheetConfirmation({ token: created.confirmationToken, userId: "42", revision: created.revision }), /GLOBAL_BROADCAST_KILL_SWITCH/);
  const loaded = KillSwitches.load([{ scope: "GLOBAL", subjectId: "global", paused: 0, revision: 4 }, { scope: "USER", subjectId: "7", paused: 1, revision: 5 }]);
  assert.equal(loaded.isPaused("42"), false);
  assert.equal(loaded.isPaused("7"), true);
  assert.equal(KillSwitches.load([]).globallyPaused, true);
});

test("confirm-each BUY is simulated, single-use and reconciled without server broadcast", async () => {
  const current = fixture();
  const created = await current.service.createConfirmEachIntent(input());
  assert.equal(created.state, "AWAITING_USER_CONFIRMATION");
  const opened = await current.service.beginSecureSheetConfirmation({ token: created.confirmationToken, userId: "42", revision: created.revision });
  assert.equal(opened.review.module, "Lintcha Copy");
  assert.equal(opened.review.label, "Lintcha Copy — trading");
  assert.equal(opened.review.value, "500");
  await assert.rejects(current.service.beginSecureSheetConfirmation({ token: created.confirmationToken, userId: "42", revision: created.revision }), /REVISION_MISMATCH|REPLAYED/);
  const submitted = await current.service.recordClientSubmission({ intentId: created.intentId, userId: "42", revision: opened.revision, transactionHash: HASH });
  assert.equal(submitted.state, "SUBMITTED_PENDING_RECONCILIATION");
  const reconciled = await current.service.reconcile(created.intentId);
  assert.equal(reconciled.state, "CONFIRMED");
  assert.equal(current.spendLedger.reservations.get(created.intentId).state, "COMMITTED");
  assert.equal([...current.primary.calls, ...current.secondary.calls].some((call) => /send|sign/i.test(call.method)), false);
});

test("duplicate source trade returns the same intent, but a rejected or cancelled one can be superseded", async () => {
  const current = fixture();
  const first = await current.service.createConfirmEachIntent(input());
  const second = await current.service.createConfirmEachIntent(input());
  assert.equal(second.intentId, first.intentId);
  assert.equal(second.duplicate, true);
  assert.equal(current.spendLedger.reservations.size, 1);
  const cancelled = await current.service.cancelIntent({ intentId: first.intentId, userId: "42" });
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(current.spendLedger.reservations.get(first.intentId).state, "RELEASED");
  await assert.rejects(current.service.createConfirmEachIntent(input()), /QUOTE_ALREADY_USED/);
  const fresh = await current.service.createConfirmEachIntent(input({ quote: { ...input().quote, id: "q1b" } }));
  assert.notEqual(fresh.intentId, first.intentId);
  assert.equal(fresh.duplicate, false);
  assert.equal(fresh.state, "AWAITING_USER_CONFIRMATION");
});

test("transaction, value and daily caps are enforced before signing", async () => {
  await assert.rejects(fixture({ maxTx: "499" }).service.createConfirmEachIntent(input()), /TRANSACTION_CAP_EXCEEDED/);
  await assert.rejects(fixture().service.createConfirmEachIntent(input({ transaction: { chainId: 4663, to: ROUTER, value: "900", data: "0x12345678" } })), /QUOTE_VALUE_MISMATCH/);
  const current = fixture({ maxDay: "700" });
  await current.service.createConfirmEachIntent(input());
  await assert.rejects(current.service.createConfirmEachIntent(input({ sourceTradeId: "source-2", quote: { ...input().quote, id: "q2" } })), /DAILY_SPEND_CAP_EXCEEDED/);
});

test("allowlists and stale quotes fail closed", async () => {
  await assert.rejects(fixture().service.createConfirmEachIntent(input({ transaction: { chainId: 1, to: ROUTER, value: "500", data: "0x12345678" } })), /CHAIN_NOT_ALLOWLISTED/);
  await assert.rejects(fixture().service.createConfirmEachIntent(input({ transaction: { chainId: 4663, to: TOKEN, value: "500", data: "0x12345678" } })), /ROUTER_NOT_ALLOWLISTED/);
  await assert.rejects(fixture().service.createConfirmEachIntent(input({ transaction: { chainId: 4663, to: ROUTER, value: "500", data: "0xdeadbeef" } })), /SELECTOR_NOT_ALLOWLISTED/);
  await assert.rejects(fixture().service.createConfirmEachIntent(input({ quote: { ...input().quote, slippageBps: 101 } })), /SLIPPAGE_CAP_EXCEEDED/);
  await assert.rejects(fixture().service.createConfirmEachIntent(input({ quote: { ...input().quote, expiresAt: 1 } })), /STALE_QUOTE/);
});

test("SELL requires manual flag, exact allowlisted approval, and a live allowance before the trade", async () => {
  await assert.rejects(fixture().service.createConfirmEachIntent(sellTradeInput({ manualSell: false })), /AUTO_SELL_FORBIDDEN/);
  const approved = await fixture().service.createConfirmEachIntent(approvalInput(500));
  assert.equal(approved.state, "AWAITING_USER_CONFIRMATION");
  await assert.rejects(fixture().service.createConfirmEachIntent(approvalInput(501)), /NON_EXACT_APPROVAL/);
  await assert.rejects(fixture().service.createConfirmEachIntent(approvalInput(500, { transaction: { chainId: 4663, to: TOKEN, value: "1", data: approvalInput(500).transaction.data } })), /VALUE_BEARING_APPROVAL/);
  await assert.rejects(fixture().service.createConfirmEachIntent(approvalInput(500, { transaction: { ...approvalInput(500).transaction, to: ROUTER } })), /APPROVAL_TOKEN_MISMATCH/);
  const trade = await fixture().service.createConfirmEachIntent(sellTradeInput());
  assert.equal(trade.state, "AWAITING_USER_CONFIRMATION");
  const short = fixture({ firstOverrides: { eth_call: `0x${word(499)}` }, secondOverrides: { eth_call: `0x${word(499)}` } });
  await assert.rejects(short.service.createConfirmEachIntent(sellTradeInput()), /SELL_ALLOWANCE_INSUFFICIENT/);
  await assert.rejects(fixture().service.createConfirmEachIntent(sellTradeInput({ transaction: { chainId: 4663, to: ROUTER, value: "5", data: "0xabcdef01" } })), /VALUE_BEARING_SELL_FORBIDDEN/);
});

test("reconciliation disagreement, mismatch and reverts stop without automatic retry and keep spend accounted", async () => {
  const disagree = fixture({ secondOverrides: { eth_getTransactionReceipt: { transactionHash: HASH, status: "0x0", blockHash: BLOCK_HASH, blockNumber: "0x63" } } });
  const created = await disagree.service.createConfirmEachIntent(input());
  await openAndSubmit(disagree, created);
  const result = await disagree.service.reconcile(created.intentId);
  assert.equal(result.state, "RECONCILIATION_REQUIRED");
  assert.equal(result.manualAttention, true);
  assert.equal(disagree.sink.records.at(-1).payload.automaticRetry, false);
  assert.equal(disagree.spendLedger.reservations.get(created.intentId).state, "RESERVED");

  const mismatch = fixture({ firstOverrides: { eth_getTransactionByHash: { hash: HASH, from: WALLET, to: TOKEN, input: "0x12345678", value: "0x1f4" } }, secondOverrides: { eth_getTransactionByHash: { hash: HASH, from: WALLET, to: TOKEN, input: "0x12345678", value: "0x1f4" } } });
  const mismatched = await mismatch.service.createConfirmEachIntent(input());
  await openAndSubmit(mismatch, mismatched);
  assert.equal((await mismatch.service.reconcile(mismatched.intentId)).reason, "TRANSACTION_MISMATCH");
  assert.equal(mismatch.spendLedger.reservations.get(mismatched.intentId).state, "RESERVED");

  const reverted = fixture({ firstOverrides: { eth_getTransactionReceipt: { transactionHash: HASH, status: "0x0", blockHash: BLOCK_HASH, blockNumber: "0x63" } }, secondOverrides: { eth_getTransactionReceipt: { transactionHash: HASH, status: "0x0", blockHash: BLOCK_HASH, blockNumber: "0x63" } } });
  const failed = await reverted.service.createConfirmEachIntent(input());
  await openAndSubmit(reverted, failed);
  assert.equal((await reverted.service.reconcile(failed.intentId)).state, "FAILED");
  assert.equal(reverted.spendLedger.reservations.get(failed.intentId).state, "RELEASED");
});

test("pending, dropped/replaced, provider outage and unsafe inclusion are distinguished", async () => {
  const unseen = fixture({ firstOverrides: { eth_getTransactionByHash: null, eth_getTransactionReceipt: null }, secondOverrides: { eth_getTransactionByHash: null, eth_getTransactionReceipt: null } });
  const created = await unseen.service.createConfirmEachIntent(input());
  await openAndSubmit(unseen, created);
  const early = await unseen.service.reconcile(created.intentId);
  assert.equal(early.pending, true);
  assert.equal(early.state, "SUBMITTED_PENDING_RECONCILIATION");
  unseen.advance(1801);
  const dropped = await unseen.service.reconcile(created.intentId);
  assert.equal(dropped.state, "DROPPED_OR_REPLACED");
  assert.equal(unseen.spendLedger.reservations.get(created.intentId).state, "RESERVED");

  const outage = fixture({ secondOverrides: { eth_getTransactionByHash: new Error("down") } });
  const intent = await outage.service.createConfirmEachIntent(input());
  await openAndSubmit(outage, intent);
  const transient = await outage.service.reconcile(intent.intentId);
  assert.equal(transient.pending, true);
  assert.equal(transient.reason, "RPC_QUORUM_UNAVAILABLE");
  assert.equal(transient.state, "SUBMITTED_PENDING_RECONCILIATION");

  const unsafe = fixture({ firstOverrides: { eth_getTransactionReceipt: { transactionHash: HASH, from: WALLET, to: ROUTER, status: "0x1", blockHash: BLOCK_HASH, blockNumber: "0x65", gasUsed: "0x5208", logs: [] } }, secondOverrides: { eth_getTransactionReceipt: { transactionHash: HASH, from: WALLET, to: ROUTER, status: "0x1", blockHash: BLOCK_HASH, blockNumber: "0x65", gasUsed: "0x5208", logs: [] } } });
  const included = await unsafe.service.createConfirmEachIntent(input());
  await openAndSubmit(unsafe, included);
  const waiting = await unsafe.service.reconcile(included.intentId);
  assert.equal(waiting.state, "INCLUDED_AWAITING_SAFE");
  assert.equal(unsafe.spendLedger.reservations.get(included.intentId).state, "RESERVED");
});

test("expiry sweeps release reservations, and a late submission lands in manual review instead of retaking the cap", async () => {
  const current = fixture();
  const idle = await current.service.createConfirmEachIntent(input());
  const opened = await current.service.createConfirmEachIntent(input({ sourceTradeId: "source-2", quote: { ...input().quote, id: "q2" } }));
  const view = await current.service.beginSecureSheetConfirmation({ token: opened.confirmationToken, userId: "42", revision: opened.revision });
  current.advance(81);
  assert.deepEqual((await current.service.expireStale()).expired, [idle.intentId]);
  assert.equal(current.spendLedger.reservations.get(idle.intentId).state, "RELEASED");
  await assert.rejects(current.service.beginSecureSheetConfirmation({ token: idle.confirmationToken, userId: "42", revision: idle.revision }), /CONFIRMATION_EXPIRED/);
  current.advance(600);
  assert.deepEqual((await current.service.expireStale()).expired, [opened.intentId]);
  const late = await current.service.recordClientSubmission({ intentId: opened.intentId, userId: "42", revision: view.revision, transactionHash: HASH });
  assert.equal(late.state, "RECONCILIATION_REQUIRED");
  assert.equal(late.reason, "LATE_SUBMISSION");
});

test("owner, revision and duplicate-click protections hold on every client callback", async () => {
  const current = fixture();
  const created = await current.service.createConfirmEachIntent(input());
  await assert.rejects(current.service.beginSecureSheetConfirmation({ token: created.confirmationToken, userId: "43", revision: created.revision }), /OWNER_MISMATCH/);
  await assert.rejects(current.service.beginSecureSheetConfirmation({ token: created.confirmationToken, userId: "42", revision: created.revision + 5 }), /REVISION_MISMATCH/);
  await assert.rejects(current.service.beginSecureSheetConfirmation({ token: `${created.confirmationToken}x`, userId: "42", revision: created.revision }), /INVALID_CONFIRMATION_TOKEN/);
  const opened = await current.service.beginSecureSheetConfirmation({ token: created.confirmationToken, userId: "42", revision: created.revision });
  await assert.rejects(current.service.recordClientSubmission({ intentId: created.intentId, userId: "43", revision: opened.revision, transactionHash: HASH }), /OWNER_MISMATCH/);
  await assert.rejects(current.service.recordClientSubmission({ intentId: created.intentId, userId: "42", revision: opened.revision, transactionHash: "0x1234" }), /INVALID_TRANSACTION_HASH/);
  await current.service.recordClientSubmission({ intentId: created.intentId, userId: "42", revision: opened.revision, transactionHash: HASH });
  await assert.rejects(current.service.recordClientSubmission({ intentId: created.intentId, userId: "42", revision: opened.revision, transactionHash: HASH }), /SUBMISSION_REPLAYED/);
  await assert.rejects(current.service.cancelIntent({ intentId: created.intentId, userId: "42" }), /NOT_CANCELLABLE/);
  await assert.rejects(current.service.getIntentForUser({ intentId: created.intentId, userId: "43" }), /OWNER_MISMATCH/);
  assert.equal((await current.service.listUserIntents("42")).length, 1);
});

test("server rejects raw signed material on client callback", async () => {
  const current = fixture();
  const created = await current.service.createConfirmEachIntent(input());
  const opened = await current.service.beginSecureSheetConfirmation({ token: created.confirmationToken, userId: "42", revision: created.revision });
  await assert.rejects(current.service.recordClientSubmission({ intentId: created.intentId, userId: "42", revision: opened.revision, transactionHash: HASH, rawTransaction: "0xdead" }), /FORBIDDEN/);
  await assert.rejects(current.service.createConfirmEachIntent(input({ transaction: { ...input().transaction, privateKey: "0x" } })), /FORBIDDEN/);
});

test("Copy service verifies gateway signature, freshness, minimal shape and replay", async () => {
  const secret = "g".repeat(32);
  const envelope = { schema: "lintcha.copy.gateway.v1", route: "COPY_COMMAND", updateId: "10", telegramUserId: "42", privateChatId: "99", locale: "ru", receivedAt: 100 };
  const sign = (body) => ({ body, signature: createHmac("sha256", secret).update(body).digest("hex") });
  const verifier = new GatewayRequestVerifier({ secret, maxAgeSeconds: 30 });
  assert.equal((await verifier.verify(sign(JSON.stringify(envelope)), 110)).telegramUserId, "42");
  await assert.rejects(verifier.verify(sign(JSON.stringify(envelope)), 110), /REPLAYED/);
  await assert.rejects(verifier.verify(sign(JSON.stringify({ ...envelope, updateId: "11", rawUpdate: {} })), 110), /NON_MINIMAL/);
  await assert.rejects(verifier.verify(sign(JSON.stringify({ ...envelope, updateId: "12", receivedAt: 1 })), 110), /STALE/);
  await assert.rejects(verifier.verify({ body: JSON.stringify(envelope), signature: "0".repeat(64) }, 110), /INVALID_GATEWAY_SIGNATURE/);
  await assert.rejects(verifier.verify(sign(JSON.stringify({ ...envelope, updateId: "13", route: "COPY_CALLBACK", callbackData: "core.forget" })), 110), /INVALID_COPY_CALLBACK/);
  assert.equal((await verifier.verify(sign(JSON.stringify({ ...envelope, updateId: "14", referralSource: "SITE" })), 110)).referralSource, "SITE");
  await assert.rejects(verifier.verify(sign(JSON.stringify({ ...envelope, updateId: "15", referralSource: "AD" })), 110), /INVALID_GATEWAY_ENVELOPE/);
});
