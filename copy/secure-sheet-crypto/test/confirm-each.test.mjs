import test from "node:test";
import assert from "node:assert/strict";
import { ConfirmEachSheetController, ExternalEip1193WalletAdapter, LocalVaultWalletAdapter, assertReviewMatchesTransaction, assertSecureSheetNetworkBoundary, walletErrorCode } from "../src/confirm-each.mjs";

const HASH = `0x${"a".repeat(64)}`;
const WALLET = "0x1111111111111111111111111111111111111111";
const TX = { chainId: 4663, to: "0x2222222222222222222222222222222222222222", value: "1", data: "0x12345678" };
const REVIEW = { module: "Lintcha", label: "Lintcha — copy-trading", direction: "BUY", operation: "TRADE", target: TX.to, selector: "0x12345678", chainId: 4663, value: "1" };

function walletMock({ chain = "0x1237", afterSwitch = "0x1237", send = HASH, reject = null } = {}) {
  const calls = [];
  let current = chain;
  return {
    calls,
    async request(request) {
      calls.push(request);
      if (reject && request.method === reject.method) { const error = new Error("wallet"); error.code = reject.code; throw error; }
      if (request.method === "eth_accounts" || request.method === "eth_requestAccounts") return [WALLET];
      if (request.method === "eth_chainId") return current;
      if (request.method === "wallet_switchEthereumChain") { current = afterSwitch; return null; }
      if (request.method === "eth_sendTransaction") return send;
      return null;
    },
  };
}

test("external adapter verifies account and chain, switches only when needed, and submits from the client", async () => {
  const already = walletMock();
  const adapter = new ExternalEip1193WalletAdapter(already);
  assert.equal(await adapter.sendConfirmed({ walletAddress: WALLET, transaction: TX }), HASH);
  assert.deepEqual(already.calls.map((item) => item.method), ["eth_accounts", "eth_chainId", "eth_sendTransaction"]);
  const other = walletMock({ chain: "0x1" });
  assert.equal(await new ExternalEip1193WalletAdapter(other).sendConfirmed({ walletAddress: WALLET, transaction: TX }), HASH);
  assert.deepEqual(other.calls.map((item) => item.method), ["eth_accounts", "eth_chainId", "wallet_switchEthereumChain", "eth_chainId", "eth_sendTransaction"]);
  const stubborn = walletMock({ chain: "0x1", afterSwitch: "0x1" });
  await assert.rejects(new ExternalEip1193WalletAdapter(stubborn).sendConfirmed({ walletAddress: WALLET, transaction: TX }), /WALLET_CHAIN_MISMATCH/);
  assert.equal(stubborn.calls.some((item) => item.method === "eth_sendTransaction"), false);
  const unknown = walletMock({ chain: "0x1", reject: { method: "wallet_switchEthereumChain", code: 4902 } });
  await assert.rejects(new ExternalEip1193WalletAdapter(unknown).sendConfirmed({ walletAddress: WALLET, transaction: TX }), /CHAIN_NOT_AVAILABLE_IN_WALLET/);
  assert.equal(unknown.calls.some((item) => item.method === "wallet_addEthereumChain"), false);
  const foreign = new ExternalEip1193WalletAdapter({ async request(request) { return request.method === "eth_accounts" ? ["0x9999999999999999999999999999999999999999"] : null; } });
  await assert.rejects(foreign.sendConfirmed({ walletAddress: WALLET, transaction: TX }), /WALLET_ACCOUNT_MISMATCH/);
  assert.equal(walletErrorCode({ code: 4001 }), "USER_REJECTED_IN_WALLET");
  const connected = await new ExternalEip1193WalletAdapter(walletMock()).connect();
  assert.deepEqual(connected, { accounts: [WALLET], chainId: 4663 });
});

test("local adapter keeps vault inside secure sheet and returns hash only", async () => {
  let receivedVault = null;
  const adapter = new LocalVaultWalletAdapter({
    secureStorage: { getItem(key, callback) { callback(null, "encrypted-local-vault"); } },
    biometric: { authenticate(options, callback) { callback(true); } },
    signerEngine: { async signAndBroadcast(input) { receivedVault = input.vaultRecord; return { transactionHash: HASH }; } },
  });
  const result = await adapter.sendConfirmed({ walletAddress: WALLET, storageKey: "wallet_1", transaction: TX });
  assert.equal(result, HASH);
  assert.equal(receivedVault, "encrypted-local-vault");
});

test("secure sheet cross-checks the review card against the transaction, displays the boundary and requires a separate confirmation", async () => {
  const events = [];
  const controller = new ConfirmEachSheetController({
    copyApi: {
      async beginConfirmation() { return { intentId: "i1", revision: 3, expiresAt: 200, transaction: TX, review: { ...REVIEW, direction: "SELL" }, simulation: { blockNumber: 10 } }; },
      async recordSubmission(input) { events.push({ submitted: input }); return { state: "SUBMITTED_PENDING_RECONCILIATION" }; },
    },
    walletAdapter: { async sendConfirmed() { events.push({ sent: true }); return HASH; } },
    localReview: async (review) => events.push({ review }),
    localConfirm: async (confirmation) => { events.push({ confirmation }); return true; },
    clearSensitiveView: async () => events.push({ cleared: true }),
    clock: () => 100,
  });
  const result = await controller.execute({ token: "opaque", userId: "42", revision: 2, walletAddress: WALLET });
  assert.equal(result.outcome, "SUBMITTED_BY_USER_WALLET");
  assert.match(events[0].review.moduleBoundary, /Lintcha Core remains read-only/);
  assert.deepEqual(events.map((item) => Object.keys(item)[0]), ["review", "confirmation", "sent", "submitted", "cleared"]);
  assert.throws(() => assertReviewMatchesTransaction({ ...REVIEW, target: WALLET }, TX), /REVIEW_TRANSACTION_MISMATCH/);
  assert.throws(() => assertReviewMatchesTransaction({ ...REVIEW, value: "2" }, TX), /REVIEW_TRANSACTION_MISMATCH/);
  assert.throws(() => assertReviewMatchesTransaction({ ...REVIEW, label: "Lintcha Core" }, TX), /REVIEW_MODULE_LABEL_MISSING/);
  assert.throws(() => assertReviewMatchesTransaction(REVIEW, { ...TX, chainId: 1 }, { chainId: 4663 }), /REVIEW_TRANSACTION_MISMATCH/);
  const tampered = new ConfirmEachSheetController({
    copyApi: { async beginConfirmation() { return { intentId: "i1", revision: 3, expiresAt: 200, transaction: { ...TX, to: WALLET }, review: REVIEW, simulation: {} }; } },
    walletAdapter: { async sendConfirmed() { throw new Error("must not run"); } }, localReview: async () => {}, localConfirm: async () => true, clearSensitiveView: async () => {}, clock: () => 100,
  });
  await assert.rejects(tampered.execute({ token: "opaque", userId: "42", revision: 2, walletAddress: WALLET }), /REVIEW_TRANSACTION_MISMATCH/);
});

test("cancel, wallet rejection and expiry never invoke or misreport the wallet", async () => {
  const cancels = [];
  let sent = false;
  const api = {
    async beginConfirmation() { return { intentId: "i1", revision: 3, expiresAt: 200, transaction: TX, review: REVIEW, simulation: {} }; },
    async cancel(input) { cancels.push(input); },
    async recordSubmission() { throw new Error("must not be called"); },
  };
  const base = { copyApi: api, localReview: async () => {}, clearSensitiveView: async () => {}, clock: () => 100 };
  const cancelled = new ConfirmEachSheetController({ ...base, walletAdapter: { async sendConfirmed() { sent = true; return HASH; } }, localConfirm: async () => false });
  assert.equal((await cancelled.execute({ token: "opaque", userId: "42", revision: 2, walletAddress: WALLET })).submitted, false);
  assert.equal(sent, false);
  assert.equal(cancels.at(-1).reason, "USER_CANCELLED");
  const rejected = new ConfirmEachSheetController({ ...base, walletAdapter: { async sendConfirmed() { const error = new Error("x"); error.code = 4001; throw error; } }, localConfirm: async () => true });
  const outcome = await rejected.execute({ token: "opaque", userId: "42", revision: 2, walletAddress: WALLET });
  assert.deepEqual(outcome, { outcome: "CANCELLED", submitted: false, reason: "USER_REJECTED_IN_WALLET" });
  const ambiguous = new ConfirmEachSheetController({ ...base, walletAdapter: { async sendConfirmed() { const error = new Error("x"); error.code = -32603; throw error; } }, localConfirm: async () => true });
  const unknown = await ambiguous.execute({ token: "opaque", userId: "42", revision: 2, walletAddress: WALLET });
  assert.equal(unknown.outcome, "WALLET_ERROR");
  assert.equal(unknown.ambiguous, true);
  assert.equal(cancels.length, 2);
  let tick = 100;
  const expiring = new ConfirmEachSheetController({ ...base, clock: () => tick, walletAdapter: { async sendConfirmed() { sent = true; return HASH; } }, localConfirm: async () => { tick = 250; return true; } });
  assert.equal((await expiring.execute({ token: "opaque", userId: "42", revision: 2, walletAddress: WALLET })).outcome, "EXPIRED");
  assert.equal(sent, false);
});

test("network boundary rejects wallet secrets and signed transaction material", () => {
  assert.equal(assertSecureSheetNetworkBoundary({ address: WALLET, transactionHash: HASH }), true);
  assert.throws(() => assertSecureSheetNetworkBoundary({ mnemonic: "one two" }), /VIOLATION/);
  assert.throws(() => assertSecureSheetNetworkBoundary({ rawTransaction: "0xdead" }), /VIOLATION/);
});
