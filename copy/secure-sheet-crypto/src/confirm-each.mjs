const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function assertHash(value) {
  if (!HASH.test(value || "")) throw new Error("INVALID_TRANSACTION_HASH");
  return value.toLowerCase();
}

function switchChainHex(chainId) { return `0x${Number(chainId).toString(16)}`; }

/** Maps EIP-1193 / EIP-1474 provider errors to stable codes the sheet can display; never rethrows wallet internals. */
export function walletErrorCode(error) {
  const code = Number(error?.code);
  if (code === 4001) return "USER_REJECTED_IN_WALLET";
  if (code === 4100 || code === 4900 || code === 4901) return "WALLET_NOT_CONNECTED";
  if (code === 4902) return "CHAIN_NOT_AVAILABLE_IN_WALLET";
  if (code === -32002) return "WALLET_REQUEST_ALREADY_PENDING";
  if (code === -32603 || code === -32000) return "WALLET_INTERNAL_ERROR";
  if (/^[A-Z_]+$/.test(String(error?.message || ""))) return error.message;
  return "WALLET_ERROR";
}

/**
 * External self-custody wallet through a standard EIP-1193 provider (injected or bridged). The adapter never sees
 * key material: it asks the wallet to sign and submit and receives only the public transaction hash.
 */
export class ExternalEip1193WalletAdapter {
  constructor(provider) {
    if (typeof provider?.request !== "function") throw new Error("EIP1193_PROVIDER_REQUIRED");
    this.provider = provider;
    this.kind = "external";
  }

  async #request(method, params = []) {
    try { return await this.provider.request({ method, params }); }
    catch (error) { throw new Error(walletErrorCode(error)); }
  }

  /** Connection step, separate from sending: returns the accounts and chain the wallet reports. */
  async connect() {
    const accounts = await this.#request("eth_requestAccounts");
    if (!Array.isArray(accounts) || !accounts.length || !ADDRESS.test(accounts[0])) throw new Error("WALLET_NOT_CONNECTED");
    const chainId = await this.#request("eth_chainId");
    return Object.freeze({ accounts: accounts.map((item) => String(item).toLowerCase()), chainId: Number(BigInt(chainId)) });
  }

  async sendConfirmed({ walletAddress, transaction }) {
    const accounts = await this.#request("eth_accounts");
    if (!Array.isArray(accounts) || !accounts.some((item) => String(item).toLowerCase() === String(walletAddress).toLowerCase())) throw new Error("WALLET_ACCOUNT_MISMATCH");
    const wanted = switchChainHex(transaction.chainId);
    let chainId = await this.#request("eth_chainId");
    if (BigInt(chainId) !== BigInt(wanted)) {
      // A chain the wallet does not know is not added from here: adding one means handing the wallet an RPC URL,
      // and that is an owner/vendor decision, not something the sheet does silently.
      await this.#request("wallet_switchEthereumChain", [{ chainId: wanted }]);
      chainId = await this.#request("eth_chainId");
    }
    if (BigInt(chainId) !== BigInt(wanted)) throw new Error("WALLET_CHAIN_MISMATCH");
    const request = {
      from: walletAddress,
      to: transaction.to,
      value: `0x${BigInt(transaction.value || 0).toString(16)}`,
      data: transaction.data,
    };
    if (transaction.gas) request.gas = `0x${BigInt(transaction.gas).toString(16)}`;
    const transactionHash = await this.#request("eth_sendTransaction", [request]);
    return assertHash(transactionHash);
  }
}

export class LocalVaultWalletAdapter {
  constructor({ secureStorage, biometric, signerEngine }) {
    if (typeof secureStorage?.getItem !== "function" || typeof biometric?.authenticate !== "function" || typeof signerEngine?.signAndBroadcast !== "function") throw new Error("LOCAL_SIGNER_CAPABILITY_REQUIRED");
    this.secureStorage = secureStorage;
    this.biometric = biometric;
    this.signerEngine = signerEngine;
    this.kind = "local";
  }
  async sendConfirmed({ walletAddress, storageKey, transaction }) {
    await new Promise((resolve, reject) => this.biometric.authenticate({ reason: "Confirm Lintcha transaction" }, (ok) => ok ? resolve() : reject(new Error("BIOMETRIC_AUTH_FAILED"))));
    let vaultRecord;
    try {
      vaultRecord = await new Promise((resolve, reject) => this.secureStorage.getItem(storageKey, (error, value) => error ? reject(new Error(String(error))) : resolve(value)));
      if (!vaultRecord) throw new Error("LOCAL_WALLET_NOT_FOUND");
      const result = await this.signerEngine.signAndBroadcast({ walletAddress, vaultRecord, transaction });
      if (result?.rawTransaction || result?.signedTransaction || result?.privateKey) throw new Error("SIGNER_MATERIAL_ESCAPE_BLOCKED");
      return assertHash(result?.transactionHash);
    } finally {
      vaultRecord = null;
    }
  }
}

/**
 * The sheet does not trust the server's review card blindly: the fields a user reads are cross-checked against
 * the unsigned transaction the wallet will actually receive. A mismatch aborts before the wallet is opened.
 */
export function assertReviewMatchesTransaction(review, transaction, expected = {}) {
  if (!review || !transaction) throw new Error("REVIEW_TRANSACTION_MISMATCH");
  const selector = String(transaction.data || "").slice(0, 10).toLowerCase();
  if (String(review.target).toLowerCase() !== String(transaction.to).toLowerCase()) throw new Error("REVIEW_TRANSACTION_MISMATCH");
  if (String(review.selector).toLowerCase() !== selector) throw new Error("REVIEW_TRANSACTION_MISMATCH");
  if (Number(review.chainId) !== Number(transaction.chainId)) throw new Error("REVIEW_TRANSACTION_MISMATCH");
  if (BigInt(review.value ?? 0) !== BigInt(transaction.value || 0)) throw new Error("REVIEW_TRANSACTION_MISMATCH");
  if (review.module !== "Lintcha" || review.label !== "Lintcha — copy-trading") throw new Error("REVIEW_MODULE_LABEL_MISSING");
  if (expected.chainId !== undefined && Number(transaction.chainId) !== Number(expected.chainId)) throw new Error("REVIEW_CHAIN_MISMATCH");
  if (expected.walletAddress !== undefined && review.walletAddress && String(review.walletAddress).toLowerCase() !== String(expected.walletAddress).toLowerCase()) throw new Error("REVIEW_WALLET_MISMATCH");
  return true;
}

export class ConfirmEachSheetController {
  constructor({ copyApi, walletAdapter, localReview, localConfirm, clearSensitiveView, expectedChainId = 4663, clock = () => Math.floor(Date.now() / 1000) }) {
    this.copyApi = copyApi;
    this.walletAdapter = walletAdapter;
    this.localReview = localReview;
    this.localConfirm = localConfirm;
    this.clearSensitiveView = clearSensitiveView;
    this.expectedChainId = expectedChainId;
    this.clock = clock;
  }

  /**
   * One confirm-each pass: open → review → separate confirm → wallet submit → report hash. A cancel before confirm
   * tells the server so the reservation is released; a wallet rejection after confirm is reported as CANCELLED too,
   * because nothing was submitted. Only a public hash ever goes back to the server.
   */
  async execute({ token, userId, revision, walletAddress, storageKey = null }) {
    let intent;
    let confirmed = false;
    try {
      intent = await this.copyApi.beginConfirmation({ token, userId, revision });
      if (this.clock() >= intent.expiresAt) throw new Error("CONFIRMATION_EXPIRED");
      assertReviewMatchesTransaction(intent.review, intent.transaction, { chainId: this.expectedChainId, walletAddress });
      await this.localReview({
        title: "Lintcha — confirm transaction",
        moduleBoundary: "Copy-trading is an opt-in mode inside Lintcha. Lintcha Core remains read-only.",
        ...intent.review,
        simulation: intent.simulation,
      });
      confirmed = (await this.localConfirm({ intentId: intent.intentId, revision: intent.revision, direction: intent.review.direction, operation: intent.review.operation })) === true;
      if (!confirmed) {
        await this.copyApi.cancel?.({ intentId: intent.intentId, userId, reason: "USER_CANCELLED" }).catch(() => {});
        return Object.freeze({ outcome: "CANCELLED", submitted: false });
      }
      if (this.clock() >= intent.expiresAt) {
        await this.copyApi.cancel?.({ intentId: intent.intentId, userId, reason: "EXPIRED_BEFORE_WALLET" }).catch(() => {});
        return Object.freeze({ outcome: "EXPIRED", submitted: false });
      }
      let transactionHash;
      try {
        transactionHash = await this.walletAdapter.sendConfirmed({ walletAddress, storageKey, transaction: intent.transaction });
      } catch (error) {
        const code = walletErrorCode(error);
        if (code === "USER_REJECTED_IN_WALLET") {
          await this.copyApi.cancel?.({ intentId: intent.intentId, userId, reason: code }).catch(() => {});
          return Object.freeze({ outcome: "CANCELLED", submitted: false, reason: code });
        }
        // Anything else is ambiguous from the sheet's point of view: the wallet may or may not have broadcast.
        // The sheet reports nothing it cannot prove; the server's expiry sweep and manual review handle the rest.
        return Object.freeze({ outcome: "WALLET_ERROR", submitted: false, reason: code, ambiguous: code !== "WALLET_ACCOUNT_MISMATCH" && code !== "WALLET_CHAIN_MISMATCH" && code !== "CHAIN_NOT_AVAILABLE_IN_WALLET" });
      }
      const result = await this.copyApi.recordSubmission({ intentId: intent.intentId, userId, revision: intent.revision, transactionHash });
      return Object.freeze({ outcome: "SUBMITTED_BY_USER_WALLET", submitted: true, transactionHash, state: result.state });
    } finally {
      intent = null;
      await this.clearSensitiveView();
    }
  }
}

export function assertSecureSheetNetworkBoundary(request) {
  const serialized = JSON.stringify(request);
  if (/seed|mnemonic|private.?key|vaultRecord|rawTransaction|signedTransaction/i.test(serialized)) throw new Error("SENSITIVE_NETWORK_BOUNDARY_VIOLATION");
  return true;
}
