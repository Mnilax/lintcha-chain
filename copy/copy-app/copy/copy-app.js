// Lintcha copy-trading — the secure sheet. Provider-neutral: any EIP-1193 wallet the host exposes. No storage, no
// tracking, no third-party script. The only network target is this origin's /api/copy/. The module label in
// index.html is static and is never touched from here.
import { ConfirmEachSheetController, ExternalEip1193WalletAdapter } from "./confirm-each.mjs";
import { AutoBuySetupController } from "./auto-buy-onboarding.mjs";

export const CHAIN_ID = 4663;
const API = "/api/copy";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const LIMITS_SELECTOR = "0x20d7bec1";

/** Telegram puts init data in the URL fragment (#tgWebAppData=…) for every Mini App; read it without any SDK. */
export function parseTelegramLaunch(hash) {
  const fragment = String(hash || "").replace(/^#/, "");
  if (!fragment) return null;
  const params = new URLSearchParams(fragment);
  const initData = params.get("tgWebAppData");
  if (!initData) return null;
  let userId = null;
  try { userId = String(JSON.parse(new URLSearchParams(initData).get("user") || "null")?.id ?? ""); } catch { userId = null; }
  return Object.freeze({ initData, userId: /^-?\d{1,20}$/.test(userId || "") ? userId : null, platform: params.get("tgWebAppPlatform") || null, startParam: new URLSearchParams(initData).get("start_param") || null });
}

/** Wei/token base units → decimal string, no floats, no rounding surprises. */
export function formatUnits(value, decimals = 18, precision = 6) {
  const big = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = big / base;
  const fraction = (big % base).toString().padStart(decimals, "0").slice(0, precision).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export function shortAddress(address) { return `${address.slice(0, 6)}…${address.slice(-4)}`; }

/** A non-zero amount must never be shown as a flat 0: below display precision it is stated in base units. */
export function formatNative(value, symbol = "ETH") {
  const shown = formatUnits(value);
  return shown === "0" && BigInt(value) > 0n ? `${value} wei` : `${shown} ${symbol}`;
}

/** The exact fields a person reads before the wallet opens. Order is fixed so screenshots across devices compare. */
export function reviewLines(review, nativeSymbol = "ETH") {
  const lines = [
    ["Mode", review.label || "Lintcha — copy-trading"],
    ["Action", `${review.direction} · ${review.operation === "APPROVAL" ? "exact ERC-20 approval" : "trade"}`],
    ["Chain", `Robinhood Chain (${review.chainId})`],
    ["Token", review.token],
    ["Amount in", review.direction === "BUY" && BigInt(review.value || 0) > 0n ? formatNative(review.amountIn, nativeSymbol) : `${review.amountIn} base units`],
    ["Minimum out", review.minimumOutput],
    ["Slippage cap", `${(Number(review.slippageBps) / 100).toFixed(2)}%`],
    ["Target contract", review.target],
    ["Selector", review.selector],
    ["Native value", formatNative(review.value || 0, nativeSymbol)],
    ["Simulated at block", review.simulationBlock === null || review.simulationBlock === undefined ? "—" : String(review.simulationBlock)],
    ["Expires", new Date(Number(review.expiresAt) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC"],
  ];
  if (review.venue) lines.splice(2, 0, ["Venue", review.venue]);
  return lines;
}

export const REQUEST_TIMEOUT_MS = 15_000;

export function createApi({ fetchImpl = globalThis.fetch, origin = globalThis.location?.origin, initData, timeoutMs = REQUEST_TIMEOUT_MS }) {
  async function call(path, { method = "GET", body } = {}) {
    // A request that never answers used to leave the sheet on its loading line forever. Bound it and report it.
    const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
    let response;
    try {
      response = await fetchImpl(`${origin}${API}/${path}`, {
        method, mode: "same-origin", credentials: "omit", cache: "no-store", signal,
        headers: { "x-telegram-init-data": initData, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) { throw new Error(error?.name === "TimeoutError" ? "COPY_API_TIMEOUT" : "COPY_API_UNREACHABLE"); }
    const json = await response.json().catch(() => ({ ok: false, why: response.status >= 400 ? `HTTP_${response.status}` : "BAD_RESPONSE" }));
    if (!json.ok) throw new Error(json.why || `HTTP_${response.status}`);
    return json;
  }
  return Object.freeze({
    me: () => call("me"),
    registerWallet: (publicAddress) => call("wallet", { method: "POST", body: { publicAddress, walletKind: "EXTERNAL" } }),
    prepareDelegation: (body) => call("delegations/prepare", { method: "POST", body }),
    verifyConfiguration: (body) => call("delegations/verify-configuration", { method: "POST", body }),
    activateDelegation: (body) => call("delegations/activate", { method: "POST", body }),
    recoverRemoval: (body) => call("delegations/recover-removal", { method: "POST", body }),
    deactivateDelegation: (walletAddress) => call("delegations/deactivate", { method: "POST", body: { walletAddress } }),
    verifyRemovalReadiness: (walletAddress) => call("delegations/removal-readiness", { method: "POST", body: { walletAddress } }),
    finalizeDelegationRemoval: (walletAddress) => call("delegations/verify-revocation", { method: "POST", body: { walletAddress } }),
    intent: (id) => call(`intents/${id}`),
    begin: (id, { token, revision }) => call(`intents/${id}/begin`, { method: "POST", body: { token, revision } }),
    submission: (id, { revision, transactionHash }) => call(`intents/${id}/submission`, { method: "POST", body: { revision, transactionHash } }),
    cancel: (id, reason) => call(`intents/${id}/cancel`, { method: "POST", body: { reason } }),
  });
}

/** Any injected EIP-1193 provider (window.ethereum). Nothing is chosen for the user; absence is shown, not hidden. */
export function injectedProvider(windowLike = globalThis) {
  const provider = windowLike?.ethereum;
  return provider && typeof provider.request === "function" ? provider : null;
}

/**
 * First-party bridge contract. The bridge is injected by the Lintcha host; this page never downloads an SDK.
 * Its public identifiers must match the server-published setup before any embedded-wallet control is enabled.
 */
export function discoverPrivyBridge(windowLike, expected) {
  const bridge = windowLike?.lintchaPrivy;
  const config = bridge?.publicConfig;
  const wrapperAddress = String(expected?.wrapperAddress || "").toLowerCase();
  if (
    !bridge || typeof bridge.getWallet !== "function" || typeof bridge.addSigners !== "function" || typeof bridge.getSignerState !== "function" || typeof bridge.removeSigners !== "function"
    || !config || !ADDRESS.test(wrapperAddress) || !Number.isSafeInteger(expected?.chainId)
    || String(config.wrapperAddress || "").toLowerCase() !== wrapperAddress
    || config.chainId !== expected.chainId
  ) return null;
  for (const key of ["privyAppId", "signerId", "policyId"]) {
    if (expected[key] !== undefined && expected[key] !== null && config[key] !== expected[key]) return null;
  }
  return Object.freeze({
    publicConfig: Object.freeze({
      privyAppId: config.privyAppId,
      signerId: config.signerId,
      policyId: config.policyId,
      wrapperAddress,
      chainId: config.chainId,
    }),
    getWallet: () => bridge.getWallet(),
    addSigners: (input) => bridge.addSigners(input),
    getSignerState: (input) => bridge.getSignerState(input),
    removeSigners: (input) => bridge.removeSigners(input),
  });
}

/** Resolve one atomic embedded-wallet context and prove its Telegram identity and provider account agree. */
export async function resolvePrivyWallet(bridge, telegramUserId) {
  if (!bridge?.getWallet) throw new Error("FIRST_PARTY_WALLET_BRIDGE_REQUIRED");
  let wallet;
  try { wallet = await bridge.getWallet(); } catch { throw new Error("PRIVY_WALLET_UNAVAILABLE"); }
  const walletAddress = String(wallet?.walletAddress || "").toLowerCase();
  if (String(wallet?.telegramUserId ?? "") !== String(telegramUserId)) throw new Error("PRIVY_TELEGRAM_IDENTITY_MISMATCH");
  if (!ADDRESS.test(walletAddress) || typeof wallet?.provider?.request !== "function") throw new Error("PRIVY_WALLET_UNAVAILABLE");
  let accounts;
  try { accounts = await wallet.provider.request({ method: "eth_accounts", params: [] }); }
  catch { throw new Error("PRIVY_WALLET_ACCOUNT_UNAVAILABLE"); }
  if (!Array.isArray(accounts) || !accounts.some((address) => String(address).toLowerCase() === walletAddress)) throw new Error("PRIVY_WALLET_ACCOUNT_MISMATCH");
  return Object.freeze({ walletAddress, provider: wallet.provider });
}

/** Adapts the embedded wallet's EIP-1193 provider to AutoBuySetupController without exposing key material. */
export class AutoBuyEip1193WalletAdapter {
  constructor(provider) { this.wallet = new ExternalEip1193WalletAdapter(provider); }
  sendTransaction(input) { return this.wallet.sendConfirmed(input); }
}

function addressWord(address) {
  const normalized = String(address || "").toLowerCase();
  if (!ADDRESS.test(normalized)) throw new Error("INVALID_PUBLIC_ADDRESS");
  return normalized.slice(2).padStart(64, "0");
}

function hexQuantity(value, code) {
  if (!/^0x[0-9a-f]+$/i.test(String(value || ""))) throw new Error(code);
  return BigInt(value);
}

function decodeLimits(raw) {
  if (!/^0x[0-9a-f]{320}$/i.test(String(raw || ""))) throw new Error("WRAPPER_READBACK_INVALID");
  const words = Array.from({ length: 5 }, (_, index) => BigInt(`0x${raw.slice(2 + index * 64, 66 + index * 64)}`));
  if (words[0] >= 1n << 128n || words[1] >= 1n << 128n || words[2] >= 1n << 16n || words[3] >= 1n << 64n || words[4] > 1n) throw new Error("WRAPPER_READBACK_INVALID");
  return Object.freeze({
    maxPerTradeWei: words[0].toString(),
    maxDailyWei: words[1].toString(),
    maxSlippageBps: Number(words[2]),
    expiresAt: Number(words[3]),
    paused: words[4] === 1n,
  });
}

/**
 * Waits a bounded time for the user's transaction to enter the finalized chain, then reads limits at that exact
 * finalized block. It is intentionally provider-neutral and never broadcasts or retries a transaction.
 */
export class Eip1193FinalityReadbackAdapter {
  constructor(provider, { chainId = CHAIN_ID, maxAttempts = 40, pollIntervalMs = 1500, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    if (
      typeof provider?.request !== "function" || !Number.isSafeInteger(chainId)
      || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 120
      || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 5000
      || maxAttempts * pollIntervalMs > 180_000 || typeof wait !== "function"
    ) throw new Error("FINALITY_ADAPTER_NOT_CONFIGURED");
    this.provider = provider;
    this.chainId = chainId;
    this.maxAttempts = maxAttempts;
    this.pollIntervalMs = pollIntervalMs;
    this.wait = wait;
  }

  async waitForFinalizedReadback({ transactionHash, walletAddress, wrapperAddress }) {
    const hash = String(transactionHash || "").toLowerCase();
    const wallet = String(walletAddress || "").toLowerCase();
    const wrapper = String(wrapperAddress || "").toLowerCase();
    if (!HASH.test(hash) || !ADDRESS.test(wallet) || !ADDRESS.test(wrapper)) throw new Error("FINALITY_INPUT_INVALID");
    let reportedChain;
    try { reportedChain = await this.provider.request({ method: "eth_chainId", params: [] }); }
    catch { throw new Error("FINALITY_PROVIDER_UNAVAILABLE"); }
    if (hexQuantity(reportedChain, "FINALITY_CHAIN_INVALID") !== BigInt(this.chainId)) throw new Error("FINALITY_CHAIN_MISMATCH");

    let receipt = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        receipt ||= await this.provider.request({ method: "eth_getTransactionReceipt", params: [hash] });
        if (receipt) {
          if (hexQuantity(receipt.status, "TRANSACTION_RECEIPT_INVALID") !== 1n) throw new Error("TRANSACTION_REVERTED");
          if (String(receipt.to || "").toLowerCase() !== wrapper) throw new Error("RECEIPT_TARGET_MISMATCH");
          if (String(receipt.from || "").toLowerCase() !== wallet) throw new Error("RECEIPT_SENDER_MISMATCH");
          const receiptBlock = hexQuantity(receipt.blockNumber, "TRANSACTION_RECEIPT_INVALID");
          const finalized = await this.provider.request({ method: "eth_getBlockByNumber", params: ["finalized", false] });
          if (finalized) {
            const finalizedNumber = hexQuantity(finalized.number, "FINALIZED_BLOCK_INVALID");
            if (finalizedNumber > BigInt(Number.MAX_SAFE_INTEGER) || !HASH.test(String(finalized.hash || "").toLowerCase())) throw new Error("FINALIZED_BLOCK_INVALID");
            if (finalizedNumber >= receiptBlock) {
              const blockTag = `0x${finalizedNumber.toString(16)}`;
              const raw = await this.provider.request({ method: "eth_call", params: [{ to: wrapper, data: `${LIMITS_SELECTOR}${addressWord(wallet)}` }, blockTag] });
              return Object.freeze({ finalized: true, readback: decodeLimits(raw), blockNumber: Number(finalizedNumber), blockHash: String(finalized.hash).toLowerCase() });
            }
          }
        }
      } catch (error) {
        if (/^(TRANSACTION_REVERTED|TRANSACTION_RECEIPT_INVALID|RECEIPT_TARGET_MISMATCH|RECEIPT_SENDER_MISMATCH|FINALIZED_BLOCK_INVALID|WRAPPER_READBACK_INVALID)$/.test(error?.message || "")) throw error;
      }
      if (attempt + 1 < this.maxAttempts) await this.wait(this.pollIntervalMs);
    }
    throw new Error("FINALITY_TIMEOUT");
  }
}

export const OUTCOME_TEXT = Object.freeze({
  SUBMITTED_BY_USER_WALLET: ["Submitted by your wallet", "Lintcha is now reconciling the transaction hash against two RPC providers. Nothing is retried or re-sent automatically."],
  CANCELLED: ["Cancelled", "The wallet was not opened and no transaction was submitted. The pending review was closed and released on the Lintcha backend."],
  EXPIRED: ["Expired", "The review window closed before the wallet opened. Nothing was submitted. Wait for a fresh signal."],
  WALLET_ERROR: ["Wallet did not complete", "The wallet reported an error. If it did submit something, Lintcha will only reconcile a hash you report; nothing is re-sent."],
});

function $(root, selector) { return root.querySelector(selector); }

/** The attribute is set beside the class, so a page that never got its stylesheet still shows exactly one view. */
function show(root, name) {
  for (const view of root.querySelectorAll("[data-view]")) {
    const hidden = view.dataset.view !== name;
    view.classList.toggle("hidden", hidden);
    view.hidden = hidden;
  }
}

/** Codes a person can actually hit, each with one sentence saying what happened and what is safe. */
export const FAILURE_TEXT = Object.freeze({
  COPY_API_TIMEOUT: "Lintcha did not answer in time. Nothing was sent to your wallet.",
  COPY_API_UNREACHABLE: "This page could not reach Lintcha. Check the connection and try again.",
  WALLET_NOT_REGISTERED: "No wallet address is registered yet. Connect a wallet first.",
  NO_WALLET_PROVIDER_IN_THIS_CLIENT: "No wallet is available in this Telegram client, so this review cannot be signed here.",
  USER_REJECTED_IN_WALLET: "You rejected the transaction in your wallet. Nothing was submitted.",
  WALLET_ACCOUNT_MISMATCH: "The wallet switched to a different account than the one registered here.",
  WALLET_CHAIN_MISMATCH: "The wallet is on a different chain. Switch it to Robinhood Chain and try again.",
  CONFIRMATION_EXPIRED: "This review expired before the wallet opened. Ask for a fresh one in Telegram.",
  INVALID_INIT_DATA: "Telegram identity could not be verified. Reopen the sheet from /copy in Telegram.",
  STALE_INIT_DATA: "This Mini App session is too old. Reopen it from /copy in Telegram.",
  GLOBAL_BROADCAST_KILL_SWITCH: "Lintcha copy-trading is paused for everyone right now. Nothing runs while it is paused.",
  USER_BROADCAST_KILL_SWITCH: "Your copy-trading is paused. Resume it from /copy in Telegram.",
});

function fail(root, code) {
  const text = String(code ?? "UNKNOWN");
  const message = $(root, "[data-error-message]");
  if (message) message.textContent = FAILURE_TEXT[text] || "This action stopped before anything was signed or submitted.";
  $(root, "[data-error]").textContent = text;
  show(root, "error");
}

/** Anything the host injects (wallet bridge, provider) can hang; a hang must become a visible failure. */
export async function withTimeout(promise, ms, code) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]);
  } finally { clearTimeout(timer); }
}

export async function boot({ document: doc = globalThis.document, windowLike = globalThis, fetchImpl = globalThis.fetch, clock = () => Math.floor(Date.now() / 1000) } = {}) {
  const root = $(doc, "[data-copy-sheet]");
  const launch = parseTelegramLaunch(windowLike.location?.hash);
  if (!launch?.initData || !launch.userId) { show(root, "unauthenticated"); return; }
  const api = createApi({ fetchImpl, origin: windowLike.location.origin, initData: launch.initData });
  const provider = injectedProvider(windowLike);
  let me;
  let activeDelegation = null;
  let pendingRemovalDelegation = null;
  let cleanupDelegation = null;
  let activationSession = null;
  let deactivationSession = null;
  let autoBuyBusy = false;
  const autoBuyUi = Object.freeze({
    controls: $(root, "[data-auto-buy-controls]"),
    setup: $(root, "[data-auto-buy-setup]"),
    deactivation: $(root, "[data-auto-buy-deactivation]"),
    setupNote: $(root, "[data-auto-buy-setup-note]"),
    status: $(root, "[data-auto-buy-status]"),
    error: $(root, "[data-auto-buy-error]"),
    activate: $(root, "[data-action=activate-auto-buy]"),
    deactivate: $(root, "[data-action=deactivate-auto-buy]"),
  });

  function clearAutoBuyFeedback() {
    autoBuyUi.status.textContent = "";
    autoBuyUi.error.textContent = "";
    autoBuyUi.error.classList.add("hidden");
  }

  function autoBuyError(message) {
    autoBuyUi.status.textContent = "";
    autoBuyUi.error.textContent = String(message || "AUTO_BUY_SETUP_FAILED");
    autoBuyUi.error.classList.remove("hidden");
  }

  function syncAutoBuyButtons() {
    autoBuyUi.activate.disabled = autoBuyBusy || !activationSession || Boolean(activeDelegation) || Boolean(pendingRemovalDelegation);
    autoBuyUi.deactivate.disabled = autoBuyBusy || !deactivationSession || !cleanupDelegation;
  }

  async function bridgeSession(expected, requiredWalletAddress = null) {
    const bridge = discoverPrivyBridge(windowLike, expected);
    if (!bridge) throw new Error("FIRST_PARTY_WALLET_BRIDGE_MISMATCH");
    const wallet = await withTimeout(resolvePrivyWallet(bridge, launch.userId), REQUEST_TIMEOUT_MS, "PRIVY_WALLET_TIMEOUT");
    if (requiredWalletAddress && wallet.walletAddress !== String(requiredWalletAddress).toLowerCase()) throw new Error("PRIVY_DELEGATION_WALLET_MISMATCH");
    return Object.freeze({ bridge, wallet });
  }

  function autoBuyController(session, setup, activation = false) {
    return new AutoBuySetupController({
      api,
      walletAdapter: new AutoBuyEip1193WalletAdapter(session.wallet.provider),
      finalityAdapter: new Eip1193FinalityReadbackAdapter(session.wallet.provider, { chainId: setup.chainId }),
      privyAdapter: session.bridge,
      wrapperAddress: setup.wrapperAddress,
      signerId: activation ? setup.signerId : session.bridge.publicConfig.signerId,
      policyId: activation ? setup.policyId : session.bridge.publicConfig.policyId,
      chainId: setup.chainId,
      clock,
    });
  }

  async function home() {
    try { me = await api.me(); } catch (error) { return fail(root, error.message); }
    const modeLabel = me.user.mode === "AUTO_BUY" ? "auto-copy BUY" : me.user.mode === "CONFIRM_EACH" ? "confirm each trade" : "notifications only";
    $(root, "[data-mode]").textContent = modeLabel;
    $(root, "[data-status]").textContent = me.globallyPaused ? "paused for everyone" : me.user.paused ? "paused" : "active";
    $(root, "[data-home-note]").textContent = me.user.mode === "AUTO_BUY"
      ? "Matched BUYs may execute only inside your active permission and limits. Pause or change mode from /copy. SELL always waits for your manual confirmation here."
      : "Change mode or pause from the /copy message in Telegram. BUY and manual SELL reviews are confirmed here.";
    $(root, "[data-wallets]").textContent = me.wallets.length ? me.wallets.map((row) => `${row.walletKind.toLowerCase()} ${shortAddress(row.publicAddress)}`).join(" · ") : "No public address registered yet.";
    const connect = $(root, "[data-action=connect-wallet]");
    connect.disabled = !provider;
    $(root, "[data-wallet-note]").textContent = provider ? "Connecting shares only your public address. Seed phrases and private keys never enter this page or the server." : "No external EIP-1193 wallet is exposed by this Telegram client. You can still use the built-in secure-sheet wallet when enabled; an external connector is optional.";
    activeDelegation = me.activeDelegations?.[0] || null;
    pendingRemovalDelegation = me.pendingRemovals?.[0] || null;
    cleanupDelegation = pendingRemovalDelegation || activeDelegation;
    $(root, "[data-delegation]").textContent = pendingRemovalDelegation
      ? `Auto-BUY execution is off for ${shortAddress(pendingRemovalDelegation.walletAddress)}; wallet pause and signer removal are still pending.`
      : activeDelegation
      ? `Active until ${new Date(activeDelegation.expiresAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC · ${activeDelegation.architecture}`
      : me.autoBuyAvailable && me.autoBuySetup ? "No active auto-BUY permission. Setup stays inactive until the embedded-wallet permission is completed." : "Auto-BUY activation is disabled.";

    const activationSetup = me.autoBuyAvailable === true && me.autoBuySetup ? me.autoBuySetup : null;
    activationSession = null;
    deactivationSession = null;
    clearAutoBuyFeedback();
    autoBuyUi.controls.classList.toggle("hidden", !activationSetup && !cleanupDelegation);
    autoBuyUi.setup.classList.toggle("hidden", !activationSetup);
    autoBuyUi.deactivation.classList.toggle("hidden", !cleanupDelegation);
    autoBuyUi.deactivate.textContent = pendingRemovalDelegation ? "Retry wallet and signer cleanup" : "Deactivate auto-BUY";
    const setupNotes = [];
    if (activationSetup) {
      try {
        activationSession = await bridgeSession(activationSetup);
        setupNotes.push(`Embedded wallet ${shortAddress(activationSession.wallet.walletAddress)} is identity-matched and ready for setup.`);
      } catch (error) { setupNotes.push(`Activation unavailable in this client: ${error.message}.`); }
    }
    if (cleanupDelegation) {
      try {
        deactivationSession = await bridgeSession(cleanupDelegation, cleanupDelegation.walletAddress);
        setupNotes.push(pendingRemovalDelegation ? "Pending removal was restored from the server and is ready to retry." : "Emergency deactivation is ready for the wallet that owns this permission.");
      } catch (error) { setupNotes.push(`Deactivation needs the original embedded wallet: ${error.message}.`); }
    }
    autoBuyUi.setupNote.textContent = setupNotes.join(" ");
    syncAutoBuyButtons();
    const list = $(root, "[data-intents]");
    list.textContent = "";
    const open = me.intents.filter((row) => row.state === "AWAITING_USER_CONFIRMATION");
    $(root, "[data-no-intents]").classList.toggle("hidden", open.length > 0);
    for (const row of open) {
      const item = doc.createElement("li");
      const label = doc.createElement("span");
      label.textContent = `${row.direction} · ${row.operation === "APPROVAL" ? "approval" : "trade"}`;
      const state = doc.createElement("span");
      state.className = "state";
      state.textContent = `expires ${new Date(row.expiresAt * 1000).toISOString().slice(11, 19)} UTC`;
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = "Review";
      button.addEventListener("click", () => review(row.intentId));
      item.append(label, state, button);
      list.append(item);
    }
    show(root, "home");
    const wanted = new URL(windowLike.location.href).searchParams.get("intent") || (launch.startParam?.startsWith("intent_") ? launch.startParam.slice(7) : null);
    if (wanted && /^[0-9a-f]{64}$/.test(wanted) && open.some((row) => row.intentId === wanted)) await review(wanted);
  }

  async function review(intentId) {
    if (!me.wallets.length) return fail(root, "WALLET_NOT_REGISTERED");
    if (!provider) return fail(root, "NO_WALLET_PROVIDER_IN_THIS_CLIENT");
    const walletAddress = me.wallets[0].publicAddress;
    let decision = null;
    const controller = new ConfirmEachSheetController({
      copyApi: {
        beginConfirmation: ({ token, revision }) => api.begin(intentId, { token, revision }).then((body) => body.intent),
        recordSubmission: ({ revision, transactionHash }) => api.submission(intentId, { revision, transactionHash }).then((body) => body.intent),
        cancel: ({ reason }) => api.cancel(intentId, reason),
      },
      walletAdapter: new ExternalEip1193WalletAdapter(provider),
      expectedChainId: CHAIN_ID,
      clock,
      localReview: async (card) => {
        $(root, "[data-review-direction]").textContent = `${card.direction} — ${card.moduleBoundary}`;
        const fields = $(root, "[data-review-fields]");
        fields.textContent = "";
        for (const [key, value] of reviewLines(card)) {
          const dt = doc.createElement("dt"); dt.textContent = key;
          const dd = doc.createElement("dd"); dd.textContent = value;
          fields.append(dt, dd);
        }
        $(root, "[data-expiry]").textContent = `This review expires at ${new Date(card.expiresAt * 1000).toISOString().slice(11, 19)} UTC.`;
        show(root, "review");
      },
      localConfirm: () => new Promise((resolve) => {
        decision = resolve;
        $(root, "[data-action=confirm]").onclick = () => resolve(true);
        $(root, "[data-action=cancel]").onclick = () => resolve(false);
      }),
      clearSensitiveView: async () => { $(root, "[data-review-fields]").textContent = ""; decision = null; },
    });
    let outcome;
    try {
      const current = await api.intent(intentId);
      outcome = await controller.execute({ token: current.intent.confirmationToken, userId: launch.userId, revision: current.intent.revision, walletAddress });
    } catch (error) { return fail(root, error.message); }
    const [title, text] = OUTCOME_TEXT[outcome.outcome] || ["Finished", outcome.outcome];
    $(root, "[data-result-title]").textContent = title;
    $(root, "[data-result-text]").textContent = outcome.reason ? `${text} (${outcome.reason})` : text;
    $(root, "[data-result-hash]").textContent = outcome.transactionHash ? `Transaction hash: ${outcome.transactionHash}` : "";
    show(root, "result");
  }

  $(root, "[data-action=connect-wallet]").addEventListener("click", async () => {
    try {
      const connected = await new ExternalEip1193WalletAdapter(provider).connect();
      if (connected.chainId !== CHAIN_ID) { fail(root, `WALLET_CHAIN_MISMATCH (wallet is on chain ${connected.chainId}; switch to Robinhood Chain ${CHAIN_ID})`); return; }
      await api.registerWallet(connected.accounts[0]);
      await home();
    } catch (error) { fail(root, error.message); }
  });
  autoBuyUi.activate.addEventListener("click", async () => {
    clearAutoBuyFeedback();
    if (!activationSession || !me?.autoBuyAvailable || !me?.autoBuySetup || activeDelegation || pendingRemovalDelegation) return autoBuyError("AUTO_BUY_ACTIVATION_NOT_READY");
    autoBuyBusy = true;
    syncAutoBuyButtons();
    autoBuyUi.status.textContent = "Waiting for wrapper configuration in your embedded wallet…";
    try {
      const walletAddress = activationSession.wallet.walletAddress;
      if (!me.wallets.some((row) => row.publicAddress === walletAddress)) await api.registerWallet(walletAddress);
      const result = await autoBuyController(activationSession, me.autoBuySetup, true).activate({
        walletAddress,
        maxTransactionNative: $(root, "[data-auto-buy-input=max-trade]").value,
        maxDailyNative: $(root, "[data-auto-buy-input=daily-cap]").value,
        maxSlippagePercent: $(root, "[data-auto-buy-input=slippage]").value,
        durationHours: $(root, "[data-auto-buy-input=duration]").value,
      });
      if (result.pendingRemoval) {
        // Do not permit another activation attempt while an attached signer may still exist.
        activationSession = null;
        autoBuyError(`${result.state || "SIGNER_REMOVAL_PENDING"}: ${result.reason}. Auto-BUY was not activated; check the original wallet and complete any pending signer cleanup before retrying.`);
      } else {
        await home();
        autoBuyUi.status.textContent = "Auto-BUY is active inside the finalized limits shown by your wallet.";
      }
    } catch (error) { autoBuyError(error.message); }
    finally { autoBuyBusy = false; syncAutoBuyButtons(); }
  });
  autoBuyUi.deactivate.addEventListener("click", async () => {
    clearAutoBuyFeedback();
    if (!deactivationSession || !cleanupDelegation) return autoBuyError("AUTO_BUY_DEACTIVATION_NOT_READY");
    autoBuyBusy = true;
    syncAutoBuyButtons();
    autoBuyUi.status.textContent = "Stopping locally before the wallet pause and signer removal…";
    try {
      const result = await autoBuyController(deactivationSession, cleanupDelegation).deactivate(cleanupDelegation.walletAddress);
      if (result.pendingRemoval) {
        autoBuyError(`AUTO_BUY_REMOVAL_PENDING: ${result.stage} (${result.reason}). Local execution stays off; reconnect the original wallet and retry removal.`);
      } else {
        await home();
        autoBuyUi.status.textContent = "Auto-BUY is off. The wrapper is paused and its signer permission was removed.";
      }
    } catch (error) { autoBuyError(error.message); }
    finally { autoBuyBusy = false; syncAutoBuyButtons(); }
  });
  // Both entry points swallow nothing: a rejected reload becomes the error view rather than a dead button.
  const reload = () => home().catch((error) => fail(root, error?.message));
  $(root, "[data-action=home]").addEventListener("click", reload);
  $(root, "[data-action=retry]").addEventListener("click", () => { show(root, "loading"); reload(); });
  await home();
}

// The module executed, so the static rescue in the loading view is no longer the only way out: the marker
// switches its CSS reveal off. A page whose script never arrives never gets this attribute and keeps the
// rescue. From here on a stuck sheet is the script's own problem, and the bounded API timeout reports it.
if (typeof document !== "undefined") document.documentElement.setAttribute("data-copy-boot", "running");
if (typeof document !== "undefined" && document.querySelector("[data-copy-sheet]")) boot().catch((error) => fail(document.querySelector("[data-copy-sheet]"), error.message));
