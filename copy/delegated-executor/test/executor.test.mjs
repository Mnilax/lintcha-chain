import assert from "node:assert/strict";
import test from "node:test";
import { DelegatedExecutor, MemorySubmissionStore, PrivyDelegatedWalletClient, createExecutorHandler } from "../src/executor.mjs";
import { buildExecutorRuntime } from "../src/worker.mjs";

const EXECUTOR = "0x7777777777777777777777777777777777777777";
const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"a".repeat(64)}`;
const NOW = 1_700_000_000;
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (value) => value.slice(2).padStart(64, "0");

function payload(patches = {}) {
  return {
    intentId: "b".repeat(64), userId: "42", walletAddress: WALLET, authorizationRef: "privy-wallet:wallet_fixture_1234", quoteId: "q1", expiresAt: NOW + 60,
    transaction: { chainId: 4663, to: EXECUTOR, value: "500", data: `0xa59ac6dd${addressWord(TOKEN)}${word(500)}${word(450)}` },
    ...patches,
  };
}

function current({ enabled = true, paused = false, send } = {}) {
  const calls = [];
  const walletClient = { async send(input) { calls.push(input); return send ? send(input) : { transactionHash: HASH }; } };
  const executor = new DelegatedExecutor({ config: { enabled, globallyPaused: paused, executorAddress: EXECUTOR, chainId: 4663, maxTransactionWei: 1_000n, maxTtlSeconds: 120 }, store: new MemorySubmissionStore(), walletClient, clock: () => NOW });
  return { executor, calls };
}

test("submits exactly one bounded wrapper BUY and returns the same hash for a duplicate", async () => {
  const { executor, calls } = current();
  assert.deepEqual(await executor.submit(payload()), { transactionHash: HASH });
  assert.deepEqual(await executor.submit(payload()), { transactionHash: HASH, duplicate: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].walletId, "wallet_fixture_1234");
  assert.equal(calls[0].transaction.to, EXECUTOR);
});

test("fails closed for kill switch, target, selector, amount, expiry and secret material", async () => {
  await assert.rejects(current({ paused: true }).executor.submit(payload()), /KILL_SWITCH/);
  await assert.rejects(current().executor.submit(payload({ transaction: { ...payload().transaction, to: WALLET } })), /TARGET/);
  await assert.rejects(current().executor.submit(payload({ transaction: { ...payload().transaction, data: `0xd04c6983${payload().transaction.data.slice(10)}` } })), /BUY_CALL/);
  await assert.rejects(current().executor.submit(payload({ transaction: { ...payload().transaction, value: "1001" } })), /CAP/);
  await assert.rejects(current().executor.submit(payload({ expiresAt: NOW })), /EXPIRY/);
  await assert.rejects(current().executor.submit(payload({ privateKey: "no" })), /SECRET/);
});

test("an uncertain Privy call is never automatically attempted again", async () => {
  let attempts = 0;
  const { executor } = current({ send: async () => { attempts += 1; throw new Error("timeout"); } });
  await assert.rejects(executor.submit(payload()), /UNCERTAIN/);
  await assert.rejects(executor.submit(payload()), /RECONCILIATION_REQUIRED/);
  assert.equal(attempts, 1);
});

test("Privy adapter emits only an unsigned transaction request and validates its hash", async () => {
  const calls = [];
  const adapter = new PrivyDelegatedWalletClient({ client: { wallets: () => ({ ethereum: () => ({ async sendTransaction(...args) { calls.push(args); return { hash: HASH }; } }) }) }, authorizationPrivateKey: "k".repeat(64) });
  assert.equal((await adapter.send({ intentId: "b".repeat(64), walletId: "wallet_fixture_1234", expiresAt: NOW + 60, transaction: payload().transaction })).transactionHash, HASH);
  assert.deepEqual(calls[0][1], {
    caip2: "eip155:4663", params: { transaction: { to: EXECUTOR, data: payload().transaction.data, value: "0x1f4" } },
    authorization_context: { authorization_private_keys: ["k".repeat(64)] }, idempotency_key: "b".repeat(64), request_expiry: (NOW + 60) * 1000,
  });
  assert.doesNotMatch(JSON.stringify(calls[0][1].params), /private.?key|seed|mnemonic/i);
});

test("private service handler exposes submit only and never caches responses", async () => {
  const { executor } = current();
  const handler = createExecutorHandler(executor);
  assert.equal((await handler(new Request("https://executor/health"))).status, 404);
  const response = await handler(new Request("https://executor/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).transactionHash, HASH);
});

test("Worker runtime deploys fail-closed without Privy secrets and rejects Telegram secrets", async () => {
  const env = { EXECUTOR_DB: { prepare() {} }, EXECUTOR_CONTRACT_ADDRESS: EXECUTOR, EXECUTOR_MAX_TRANSACTION_WEI: "1000", EXECUTOR_ENABLED: "false", EXECUTOR_GLOBAL_PAUSED: "true" };
  const handler = buildExecutorRuntime(env, { clock: () => NOW });
  const response = await handler(new Request("https://executor/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) }));
  assert.equal(response.status, 423);
  assert.throws(() => buildExecutorRuntime({ ...env, TELEGRAM_BOT_TOKEN: "forbidden" }), /BOUNDARY_VIOLATION/);
  assert.throws(() => buildExecutorRuntime({ ...env, EXECUTOR_ENABLED: "true", EXECUTOR_GLOBAL_PAUSED: "false" }), /PRIVY_EXECUTOR_SECRETS_REQUIRED/);
});
