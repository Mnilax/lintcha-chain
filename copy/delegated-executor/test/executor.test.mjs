import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { D1SubmissionStore, DelegatedExecutor, MemorySubmissionStore, PrivyDelegatedWalletClient, PrivyDelegationVerifier, createExecutorHandler } from "../src/executor.mjs";
import { buildExecutorRuntime } from "../src/worker.mjs";
import { fakeD1 } from "../../copy-service/test/fake-d1.mjs";

const EXECUTOR = "0x7777777777777777777777777777777777777777";
const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"a".repeat(64)}`;
const NOW = 1_700_000_000;
const PRIVY_POLICY_ID = "policy_buy_only_1";
const PRIVY_SIGNER_ID = "signer_lintcha_1";
const PRIVY_OWNER_ID = "owner_lintcha_1";
const AUTHORIZATION_REF = `privy-wallet:wallet_fixture_1234:${"1".repeat(32)}`;
const NEXT_AUTHORIZATION_REF = `privy-wallet:wallet_fixture_1234:${"2".repeat(32)}`;
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (value) => value.slice(2).padStart(64, "0");

const POLICY_SECURITY_PROJECTION = {
  chain_type: "ethereum",
  version: "1.0",
  owner_id: PRIVY_OWNER_ID,
  rules: [{
    action: "ALLOW",
    method: "eth_sendTransaction",
    conditions: [
      { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: "4663" },
      { field_source: "ethereum_transaction", field: "to", operator: "eq", value: EXECUTOR },
      { field_source: "ethereum_transaction", field: "value", operator: "lte", value: "1000" },
      { field_source: "ethereum_calldata", field: "function_name", operator: "eq", value: "buy", abi: [{ type: "function", name: "buy", stateMutability: "payable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "uint256" }], outputs: [] }] },
    ],
  }],
};
const POLICY_CONTENT_SHA256 = createHash("sha256").update(JSON.stringify(POLICY_SECURITY_PROJECTION)).digest("hex");

function validPolicy() {
  return {
    id: PRIVY_POLICY_ID,
    chain_type: "ethereum",
    version: "1.0",
    owner_id: PRIVY_OWNER_ID,
    name: "cosmetic policy name",
    created_at: NOW * 1000,
    rules: [{
      id: "generated_rule_id",
      name: "cosmetic rule name",
      action: "ALLOW",
      method: "eth_sendTransaction",
      conditions: structuredClone(POLICY_SECURITY_PROJECTION.rules[0].conditions),
    }],
  };
}

function privyVerifier(client, overrides = {}) {
  const completeClient = client.policies ? client : { ...client, policies: () => ({ async get(id) { assert.equal(id, PRIVY_POLICY_ID); return validPolicy(); } }) };
  return new PrivyDelegationVerifier({
    client: completeClient,
    signerId: PRIVY_SIGNER_ID,
    policyId: PRIVY_POLICY_ID,
    chainId: 4663,
    wrapperAddress: EXECUTOR,
    maxTransactionWei: "1000",
    expectedOwnerId: PRIVY_OWNER_ID,
    policyContentSha256: POLICY_CONTENT_SHA256,
    ...overrides,
  });
}

function payload(patches = {}) {
  return {
    intentId: "b".repeat(64), telegramUserId: "42", walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF, quoteId: "q1", expiresAt: NOW + 60,
    transaction: { chainId: 4663, to: EXECUTOR, value: "500", data: `0xa59ac6dd${addressWord(TOKEN)}${word(500)}${word(450)}` },
    ...patches,
  };
}

function current({ enabled = true, paused = false, send, store = new MemorySubmissionStore(), delegationVerifier } = {}) {
  const calls = [];
  const policyChecks = [];
  const walletClient = { async send(input) { calls.push(input); return send ? send(input) : { transactionHash: HASH }; } };
  const effectiveVerifier = delegationVerifier || { async verifySubmissionAuthorization(input) { policyChecks.push(structuredClone(input)); return { authorized: true, telegramUserId: input.telegramUserId, walletAddress: input.walletAddress, authorizationRef: input.authorizationRef, chainId: 4663, policyContentSha256: POLICY_CONTENT_SHA256 }; } };
  const executor = new DelegatedExecutor({ config: { enabled, globallyPaused: paused, executorAddress: EXECUTOR, chainId: 4663, maxTransactionWei: 1_000n, maxTtlSeconds: 120 }, store, walletClient, delegationVerifier: effectiveVerifier, clock: () => NOW });
  return { executor, calls, store, policyChecks };
}

test("submits exactly one bounded wrapper BUY and returns the same hash for a duplicate", async () => {
  const { executor, calls, policyChecks } = current();
  assert.deepEqual(await executor.submit(payload()), { transactionHash: HASH });
  assert.deepEqual(await executor.submit(payload()), { transactionHash: HASH, duplicate: true });
  assert.equal(calls.length, 1);
  assert.equal(policyChecks.length, 2);
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

test("executor-side deactivation is idempotent and wallet-wide across user ids and epochs", async () => {
  let releaseSend, markStarted;
  let firstSend = true;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const { executor, calls, store } = current({ send: async () => { if (firstSend) { firstSend = false; markStarted(); await new Promise((resolve) => { releaseSend = resolve; }); } return { transactionHash: HASH }; } });
  const inFlight = executor.submit(payload());
  await started;
  const authorization = { telegramUserId: "42", walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF };
  const blocked = await executor.deactivateAuthorization(authorization);
  const duplicate = await executor.deactivateAuthorization(authorization);
  assert.deepEqual(blocked, { blocked: true, ...authorization, blockedAt: NOW, duplicate: false });
  assert.deepEqual(duplicate, { ...blocked, duplicate: true });
  releaseSend();
  assert.deepEqual(await inFlight, { transactionHash: HASH });
  await assert.rejects(executor.submit(payload({ intentId: "c".repeat(64) })), /AUTHORIZATION_BLOCKED/);
  await assert.rejects(executor.submit(payload()), /AUTHORIZATION_BLOCKED/);
  await assert.rejects(executor.submit(payload({ intentId: "d".repeat(64), telegramUserId: "43" })), /AUTHORIZATION_BLOCKED/);
  await assert.rejects(executor.submit(payload({ intentId: "e".repeat(64), authorizationRef: NEXT_AUTHORIZATION_REF })), /AUTHORIZATION_BLOCKED/);
  assert.equal(calls.length, 1);
  assert.equal(store.rows.size, 1);
});

test("D1 authorization block is idempotent and atomically prevents new claims", async () => {
  const db = fakeD1({ schema: false });
  db.raw.exec(readFileSync(fileURLToPath(new URL("../src/schema.sql", import.meta.url)), "utf8"));
  const store = new D1SubmissionStore(db);
  const authorization = { telegramUserId: "42", walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF };
  assert.equal((await store.blockAuthorization(authorization, NOW)).duplicate, false);
  const duplicate = await store.blockAuthorization({ ...authorization, telegramUserId: "43" }, NOW + 1);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.telegramUserId, "42");
  assert.deepEqual(await store.claim("c".repeat(64), NOW + 1, { ...authorization, telegramUserId: "43" }), { claimed: false, row: null, blocked: true });
  const otherAuthorization = { ...authorization, authorizationRef: NEXT_AUTHORIZATION_REF };
  assert.deepEqual(await store.claim("d".repeat(64), NOW + 1, otherAuthorization), { claimed: false, row: null, blocked: true });
  assert.equal((await store.clearAuthorizationBlock({ ...otherAuthorization, revoked: true })).authorizationBlockCleared, true);
  assert.equal((await store.claim("d".repeat(64), NOW + 1, otherAuthorization)).claimed, true);
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

test("Privy delegation verification binds the exact Telegram user, linked wallet, signer and override policy", async () => {
  const userCalls = [], walletCalls = [], policyCalls = [];
  const client = {
    users: () => ({ async getByTelegramUserID(input) { userCalls.push(input); return { linked_accounts: [{ id: "wallet_fixture_1234", address: WALLET, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: true }] }; } }),
    wallets: () => ({ async get(id) { walletCalls.push(id); return { id: "wallet_fixture_1234", address: WALLET, chain_type: "ethereum", archived_at: null, policy_ids: ["policy_unrelated_1"], additional_signers: [{ signer_id: PRIVY_SIGNER_ID, override_policy_ids: [PRIVY_POLICY_ID] }] }; } }),
    policies: () => ({ async get(id) { policyCalls.push(id); const policy = validPolicy(); policy.rules[0].conditions[2].value = "0x3E8"; return policy; } }),
  };
  const verifier = privyVerifier(client);
  assert.deepEqual(await verifier.verify({ telegramUserId: "42", walletAddress: WALLET }), { architecture: "PRIVY_TEE", authorizationRef: "privy-wallet:wallet_fixture_1234", walletAddress: WALLET, chainId: 4663, policyContentSha256: POLICY_CONTENT_SHA256 });
  assert.deepEqual(await verifier.verifySubmissionAuthorization(payload()), { authorized: true, telegramUserId: "42", walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF, chainId: 4663, policyContentSha256: POLICY_CONTENT_SHA256 });
  assert.deepEqual(userCalls, [{ telegram_user_id: "42" }, { telegram_user_id: "42" }]);
  assert.deepEqual(walletCalls, ["wallet_fixture_1234", "wallet_fixture_1234"]);
  assert.deepEqual(policyCalls, [PRIVY_POLICY_ID, PRIVY_POLICY_ID]);
  await assert.rejects(verifier.verify({ walletAddress: WALLET }), /TELEGRAM_USER_ID/);
  await assert.rejects(verifier.verify({ telegramUserId: "42", walletAddress: WALLET, privateKey: "no" }), /SECRET/);
});

test("Privy policy verification rejects broadened, incomplete, mis-owned, over-cap, wrong-ABI and wrong-hash policies", async (t) => {
  const cases = [
    ["broad extra rule", (policy) => { policy.rules.push({ ...structuredClone(policy.rules[0]), id: "broad_rule", method: "*" }); }],
    ["missing condition", (policy) => { policy.rules[0].conditions.pop(); }],
    ["wrong owner", (policy) => { policy.owner_id = "owner_attacker_1"; }],
    ["wrong cap", (policy) => { policy.rules[0].conditions[2].value = "1001"; }],
    ["wrong ABI", (policy) => { policy.rules[0].conditions[3].abi[0].inputs[2].type = "address"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const policy = validPolicy();
      mutate(policy);
      const client = { users: () => ({}), wallets: () => ({}), policies: () => ({ async get() { return policy; } }) };
      await assert.rejects(privyVerifier(client).verifyPolicy(), /PRIVY_POLICY_CONTENT_MISMATCH/);
    });
  }
  await t.test("wrong canonical hash", async () => {
    const client = { users: () => ({}), wallets: () => ({}), policies: () => ({ async get() { return validPolicy(); } }) };
    await assert.rejects(privyVerifier(client, { policyContentSha256: "f".repeat(64) }).verifyPolicy(), /PRIVY_POLICY_HASH_MISMATCH/);
  });
});

test("policy drift after activation is fetched again and blocks submission before claim or send", async () => {
  let policy = validPolicy();
  let policyReads = 0;
  const linked = { id: "wallet_fixture_1234", address: WALLET, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: true };
  const client = {
    users: () => ({ async getByTelegramUserID() { return { linked_accounts: [linked] }; } }),
    wallets: () => ({ async get() { return { id: linked.id, address: WALLET, chain_type: "ethereum", archived_at: null, additional_signers: [{ signer_id: PRIVY_SIGNER_ID, override_policy_ids: [PRIVY_POLICY_ID] }] }; } }),
    policies: () => ({ async get() { policyReads += 1; return structuredClone(policy); } }),
  };
  const verifier = privyVerifier(client);
  assert.equal((await verifier.verify({ telegramUserId: "42", walletAddress: WALLET })).policyContentSha256, POLICY_CONTENT_SHA256);
  policy.rules[0].conditions[2].value = "1001";
  const { executor, calls, store } = current({ delegationVerifier: verifier });
  await assert.rejects(executor.submit(payload()), /PRIVY_POLICY_CONTENT_MISMATCH/);
  assert.equal(policyReads, 2);
  assert.equal(calls.length, 0);
  assert.equal(store.rows.size, 0);
});

test("submit authorization rejects an authorizationRef for another wallet before claim or send", async () => {
  let walletReads = 0;
  let policyReads = 0;
  const linked = { id: "wallet_fixture_1234", address: WALLET, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: true };
  const client = {
    users: () => ({ async getByTelegramUserID() { return { linked_accounts: [linked] }; } }),
    wallets: () => ({ async get() { walletReads += 1; return { id: linked.id, address: WALLET, chain_type: "ethereum", archived_at: null, additional_signers: [{ signer_id: PRIVY_SIGNER_ID, override_policy_ids: [PRIVY_POLICY_ID] }] }; } }),
    policies: () => ({ async get() { policyReads += 1; return validPolicy(); } }),
  };
  const { executor, calls, store } = current({ delegationVerifier: privyVerifier(client) });
  const wrongWalletRef = `privy-wallet:wallet_attacker_1234:${"3".repeat(32)}`;
  await assert.rejects(executor.submit(payload({ authorizationRef: wrongWalletRef })), /PRIVY_WALLET_MISMATCH/);
  assert.equal(walletReads, 0);
  assert.equal(policyReads, 0);
  assert.equal(calls.length, 0);
  assert.equal(store.rows.size, 0);
});

test("submit authorization rejects signer drift after activation before claim or send", async () => {
  let additionalSigners = [{ signer_id: PRIVY_SIGNER_ID, override_policy_ids: [PRIVY_POLICY_ID] }];
  let policyReads = 0;
  const linked = { id: "wallet_fixture_1234", address: WALLET, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: true };
  const client = {
    users: () => ({ async getByTelegramUserID() { return { linked_accounts: [linked] }; } }),
    wallets: () => ({ async get() { return { id: linked.id, address: WALLET, chain_type: "ethereum", archived_at: null, additional_signers: structuredClone(additionalSigners) }; } }),
    policies: () => ({ async get() { policyReads += 1; return validPolicy(); } }),
  };
  const verifier = privyVerifier(client);
  await verifier.verify({ telegramUserId: "42", walletAddress: WALLET });
  additionalSigners = [...additionalSigners, { signer_id: "third_party_signer_1", override_policy_ids: ["third_party_policy_1"] }];
  const { executor, calls, store } = current({ delegationVerifier: verifier });
  await assert.rejects(executor.submit(payload()), /PRIVY_SIGNER_SET_MISMATCH/);
  assert.equal(policyReads, 1);
  assert.equal(calls.length, 0);
  assert.equal(store.rows.size, 0);
});

test("Privy delegation verification refuses a cross-tenant public wallet address", async () => {
  let walletReads = 0;
  const client = {
    users: () => ({ async getByTelegramUserID() { return { linked_accounts: [{ id: "wallet_attacker_1234", address: EXECUTOR, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: true }] }; } }),
    wallets: () => ({ async get() { walletReads += 1; return { id: "wallet_fixture_1234", address: WALLET }; } }),
  };
  const verifier = privyVerifier(client);
  await assert.rejects(verifier.verify({ telegramUserId: "43", walletAddress: WALLET }), /LINKED_WALLET_MISMATCH/);
  assert.equal(walletReads, 0);
});

test("Privy delegation verification refuses a wallet record that differs from the linked wallet id", async () => {
  const client = {
    users: () => ({ async getByTelegramUserID() { return { linked_accounts: [{ id: "wallet_fixture_1234", address: WALLET, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: true }] }; } }),
    wallets: () => ({ async get() { return { id: "wallet_other_5678", address: WALLET, chain_type: "ethereum", archived_at: null, additional_signers: [] }; } }),
  };
  const verifier = privyVerifier(client);
  await assert.rejects(verifier.verify({ telegramUserId: "42", walletAddress: WALLET }), /PRIVY_WALLET_MISMATCH/);
});

test("Privy delegation activation rejects any unrelated additional signer", async () => {
  const linked = { id: "wallet_fixture_1234", address: WALLET, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: true };
  const client = {
    users: () => ({ async getByTelegramUserID() { return { linked_accounts: [linked] }; } }),
    wallets: () => ({ async get() { return { id: linked.id, address: WALLET, chain_type: "ethereum", archived_at: null, additional_signers: [{ signer_id: PRIVY_SIGNER_ID, override_policy_ids: [PRIVY_POLICY_ID] }, { signer_id: "third_party_signer_1", override_policy_ids: ["third_party_policy_1"] }] }; } }),
  };
  await assert.rejects(privyVerifier(client).verify({ telegramUserId: "42", walletAddress: WALLET }), /PRIVY_SIGNER_SET_MISMATCH/);
});

test("wallet preflight Telegram-binds the wallet and requires an active empty signer set", async () => {
  const linked = { id: "wallet_fixture_1234", address: WALLET, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: false };
  let additionalSigners = [];
  const client = {
    users: () => ({ async getByTelegramUserID() { return { linked_accounts: [linked] }; } }),
    wallets: () => ({ async get() { return { id: linked.id, address: WALLET, chain_type: "ethereum", archived_at: null, additional_signers: additionalSigners }; } }),
  };
  const verifier = privyVerifier(client);
  assert.deepEqual(await verifier.verifyWalletPreflight({ telegramUserId: "42", walletAddress: WALLET }), { eligible: true, walletAddress: WALLET, chainId: 4663 });
  additionalSigners = [{ signer_id: "third_party_signer_1", override_policy_ids: ["third_party_policy_1"] }];
  await assert.rejects(verifier.verifyWalletPreflight({ telegramUserId: "42", walletAddress: WALLET }), /PREFLIGHT_SIGNERS_PRESENT/);
  additionalSigners = undefined;
  await assert.rejects(verifier.verifyWalletPreflight({ telegramUserId: "42", walletAddress: WALLET }), /PREFLIGHT_SIGNERS_PRESENT/);
});

test("wallet preflight refuses a wallet linked to another Telegram user", async () => {
  let walletReads = 0;
  const client = {
    users: () => ({ async getByTelegramUserID() { return { linked_accounts: [{ id: "wallet_attacker_1234", address: EXECUTOR, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: false }] }; } }),
    wallets: () => ({ async get() { walletReads += 1; return { id: "wallet_fixture_1234", address: WALLET, chain_type: "ethereum", additional_signers: [] }; } }),
  };
  await assert.rejects(privyVerifier(client).verifyWalletPreflight({ telegramUserId: "43", walletAddress: WALLET }), /LINKED_WALLET_MISMATCH/);
  assert.equal(walletReads, 0);
});

test("removal readiness binds the exact epoch wallet and requires the sole Lintcha signer and policy", async () => {
  const linked = { id: "wallet_fixture_1234", address: WALLET, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: true };
  let additionalSigners = [{ signer_id: PRIVY_SIGNER_ID, override_policy_ids: [PRIVY_POLICY_ID] }];
  const client = {
    users: () => ({ async getByTelegramUserID() { return { linked_accounts: [linked] }; } }),
    wallets: () => ({ async get() { return { id: linked.id, address: WALLET, chain_type: "ethereum", archived_at: null, additional_signers: structuredClone(additionalSigners) }; } }),
  };
  const verifier = privyVerifier(client);
  const request = { telegramUserId: "42", walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF };
  assert.deepEqual(await verifier.verifyRemovalReadiness(request), { ready: true, walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF, chainId: 4663 });
  await assert.rejects(verifier.verifyRemovalReadiness({ ...request, authorizationRef: `privy-wallet:wallet_attacker_1234:${"4".repeat(32)}` }), /PRIVY_WALLET_MISMATCH/);
  additionalSigners = [...additionalSigners, { signer_id: "third_party_signer_1", override_policy_ids: ["third_party_policy_1"] }];
  await assert.rejects(verifier.verifyRemovalReadiness(request), /PRIVY_SIGNER_SET_MISMATCH/);
  additionalSigners = [{ signer_id: PRIVY_SIGNER_ID, override_policy_ids: [PRIVY_POLICY_ID, "policy_broad_1"] }];
  await assert.rejects(verifier.verifyRemovalReadiness(request), /PRIVY_SIGNER_POLICY_MISMATCH/);
});

test("Privy delegation verification refuses multiple or wallet-level policies", async () => {
  const linked = { id: "wallet_fixture_1234", address: WALLET, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: true };
  const client = {
    users: () => ({ async getByTelegramUserID() { return { linked_accounts: [linked] }; } }),
    wallets: () => ({ async get() { return { id: linked.id, address: WALLET, chain_type: "ethereum", archived_at: null, policy_ids: [PRIVY_POLICY_ID], additional_signers: [{ signer_id: PRIVY_SIGNER_ID, override_policy_ids: [PRIVY_POLICY_ID, "policy_broad_1"] }] }; } }),
  };
  const verifier = privyVerifier(client);
  await assert.rejects(verifier.verify({ telegramUserId: "42", walletAddress: WALLET }), /SIGNER_POLICY_MISMATCH/);
  const wrongPolicy = privyVerifier(client, { policyId: "policy_wrong_1" });
  await assert.rejects(wrongPolicy.verify({ telegramUserId: "42", walletAddress: WALLET }), /SIGNER_POLICY_MISMATCH/);
});

test("Privy revocation proof requires the configured signer to be absent, not only delegated=false", async () => {
  let additionalSigners = [{ signer_id: PRIVY_SIGNER_ID, override_policy_ids: [PRIVY_POLICY_ID] }];
  const linked = { id: "wallet_fixture_1234", address: WALLET, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: false };
  const client = {
    users: () => ({ async getByTelegramUserID() { return { linked_accounts: [linked] }; } }),
    wallets: () => ({ async get() { return { id: linked.id, address: WALLET, chain_type: "ethereum", archived_at: null, additional_signers: additionalSigners }; } }),
  };
  const verifier = privyVerifier(client);
  const request = { telegramUserId: "42", walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF };
  await assert.rejects(verifier.verifyRevocation(request), /SIGNER_STILL_DELEGATED/);
  additionalSigners = undefined;
  await assert.rejects(verifier.verifyRevocation(request), /SIGNER_STATE_UNAVAILABLE/);
  additionalSigners = [];
  assert.deepEqual(await verifier.verifyRevocation(request), { revoked: true, architecture: "PRIVY_TEE", ...request, chainId: 4663 });
  await assert.rejects(verifier.verifyRevocation({ ...request, authorizationRef: "privy-wallet:wallet_other_5678" }), /PRIVY_WALLET_MISMATCH/);
});

test("Privy revocation proof refuses a wallet linked to another Telegram user", async () => {
  let walletReads = 0;
  const client = {
    users: () => ({ async getByTelegramUserID() { return { linked_accounts: [{ id: "wallet_attacker_1234", address: EXECUTOR, type: "wallet", connector_type: "embedded", wallet_client: "privy", chain_type: "ethereum", delegated: false }] }; } }),
    wallets: () => ({ async get() { walletReads += 1; return { id: "wallet_fixture_1234", address: WALLET, chain_type: "ethereum", additional_signers: [] }; } }),
  };
  const verifier = privyVerifier(client);
  await assert.rejects(verifier.verifyRevocation({ telegramUserId: "43", walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF }), /LINKED_WALLET_MISMATCH/);
  assert.equal(walletReads, 0);
});

test("a failed fresh revocation proof cannot clear the wallet-wide executor block", async () => {
  const { executor } = current();
  const authorization = { telegramUserId: "42", walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF };
  await executor.deactivateAuthorization(authorization);
  const handler = createExecutorHandler(executor, { async verifyRevocation() { throw new Error("PRIVY_SIGNER_STILL_DELEGATED"); } });
  const response = await handler(new Request("https://executor/verify-revocation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(authorization) }));
  assert.equal(response.status, 409);
  await assert.rejects(executor.submit(payload({ intentId: "f".repeat(64), authorizationRef: NEXT_AUTHORIZATION_REF })), /AUTHORIZATION_BLOCKED/);
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

test("private service exposes verified public delegation metadata but no health or secret surface", async () => {
  const { executor } = current();
  const handler = createExecutorHandler(executor, {
    async verifyWalletPreflight(payload) { assert.deepEqual(payload, { telegramUserId: "42", walletAddress: WALLET }); return { eligible: true, walletAddress: WALLET, chainId: 4663 }; },
    async verify(payload) { assert.deepEqual(payload, { telegramUserId: "42", walletAddress: WALLET }); return { architecture: "PRIVY_TEE", authorizationRef: "privy-wallet:wallet_fixture_1234", walletAddress: WALLET, chainId: 4663, policyContentSha256: POLICY_CONTENT_SHA256 }; },
    async verifyRemovalReadiness(payload) { assert.deepEqual(payload, { telegramUserId: "42", walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF }); return { ready: true, walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF, chainId: 4663 }; },
    async verifyRevocation(payload) { return { revoked: true, ...payload, architecture: "PRIVY_TEE", chainId: 4663 }; },
  });
  const response = await handler(new Request("https://executor/verify-delegation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: "42", walletAddress: WALLET }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { architecture: "PRIVY_TEE", authorizationRef: "privy-wallet:wallet_fixture_1234", walletAddress: WALLET, chainId: 4663, policyContentSha256: POLICY_CONTENT_SHA256 });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const preflight = await handler(new Request("https://executor/verify-wallet-preflight", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ telegramUserId: "42", walletAddress: WALLET }) }));
  assert.equal(preflight.status, 200);
  assert.deepEqual(await preflight.json(), { eligible: true, walletAddress: WALLET, chainId: 4663 });
  const authorization = { telegramUserId: "42", walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF };
  const removalReadiness = await handler(new Request("https://executor/verify-removal-readiness", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(authorization) }));
  assert.equal(removalReadiness.status, 200);
  assert.deepEqual(await removalReadiness.json(), { ready: true, walletAddress: WALLET, authorizationRef: AUTHORIZATION_REF, chainId: 4663 });
  const deactivated = await handler(new Request("https://executor/wallets/deactivate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(authorization) }));
  assert.equal(deactivated.status, 200);
  assert.equal((await deactivated.json()).blocked, true);
  const blockedNextEpoch = await handler(new Request("https://executor/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload({ intentId: "f".repeat(64), authorizationRef: NEXT_AUTHORIZATION_REF })) }));
  assert.equal(blockedNextEpoch.status, 423);
  const revoked = await handler(new Request("https://executor/verify-revocation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(authorization) }));
  assert.equal(revoked.status, 200);
  const revokedBody = await revoked.json();
  assert.equal(revokedBody.revoked, true);
  assert.equal(revokedBody.authorizationBlockCleared, true);
  const reactivated = await handler(new Request("https://executor/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload({ intentId: "f".repeat(64), authorizationRef: NEXT_AUTHORIZATION_REF })) }));
  assert.equal(reactivated.status, 200);
});

test("Worker runtime deploys fail-closed without Privy secrets and rejects Telegram secrets", async () => {
  const env = { EXECUTOR_DB: { prepare() {} }, EXECUTOR_CONTRACT_ADDRESS: EXECUTOR, EXECUTOR_MAX_TRANSACTION_WEI: "1000", EXECUTOR_ENABLED: "false", EXECUTOR_GLOBAL_PAUSED: "true" };
  const handler = buildExecutorRuntime(env, { clock: () => NOW });
  const response = await handler(new Request("https://executor/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) }));
  assert.equal(response.status, 423);
  assert.throws(() => buildExecutorRuntime({ ...env, TELEGRAM_BOT_TOKEN: "forbidden" }), /BOUNDARY_VIOLATION/);
  assert.throws(() => buildExecutorRuntime({ ...env, COPY_BOT_TOKEN: "forbidden" }), /BOUNDARY_VIOLATION/);
  assert.throws(() => buildExecutorRuntime({ ...env, USER_PRIVATE_KEY: "forbidden" }), /BOUNDARY_VIOLATION/);
  assert.throws(() => buildExecutorRuntime({ ...env, EXECUTOR_ENABLED: "true", EXECUTOR_GLOBAL_PAUSED: "false" }), /PRIVY_EXECUTOR_SECRETS_REQUIRED/);
  assert.throws(() => buildExecutorRuntime({
    ...env,
    EXECUTOR_ENABLED: "true",
    EXECUTOR_GLOBAL_PAUSED: "false",
    PRIVY_APP_ID: "app_fixture",
    PRIVY_APP_SECRET: "secret_fixture",
    PRIVY_AUTHORIZATION_PRIVATE_KEY: "k".repeat(64),
    PRIVY_AUTHORIZATION_SIGNER_ID: PRIVY_SIGNER_ID,
    PRIVY_POLICY_ID,
  }), /PRIVY_EXECUTOR_POLICY_CONFIG_REQUIRED/);
});
