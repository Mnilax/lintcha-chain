// Lintcha copy-trading — the secure sheet. Provider-neutral: any EIP-1193 wallet the host exposes. No storage, no
// tracking, no third-party script. The only network target is this origin's /api/copy/. The module label in
// index.html is static and is never touched from here.
import { ConfirmEachSheetController, ExternalEip1193WalletAdapter } from "./confirm-each.mjs";

export const CHAIN_ID = 4663;
const API = "/api/copy";

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

/** The exact fields a person reads before the wallet opens. Order is fixed so screenshots across devices compare. */
export function reviewLines(review, nativeSymbol = "ETH") {
  const lines = [
    ["Mode", review.label || "Lintcha — copy-trading"],
    ["Action", `${review.direction} · ${review.operation === "APPROVAL" ? "exact ERC-20 approval" : "trade"}`],
    ["Chain", `Robinhood Chain (${review.chainId})`],
    ["Token", review.token],
    ["Amount in", review.direction === "BUY" && BigInt(review.value || 0) > 0n ? `${formatUnits(review.amountIn)} ${nativeSymbol}` : `${review.amountIn} base units`],
    ["Minimum out", review.minimumOutput],
    ["Slippage cap", `${(Number(review.slippageBps) / 100).toFixed(2)}%`],
    ["Target contract", review.target],
    ["Selector", review.selector],
    ["Native value", `${formatUnits(review.value || 0)} ${nativeSymbol}`],
    ["Simulated at block", review.simulationBlock === null || review.simulationBlock === undefined ? "—" : String(review.simulationBlock)],
    ["Expires", new Date(Number(review.expiresAt) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC"],
  ];
  if (review.venue) lines.splice(2, 0, ["Venue", review.venue]);
  return lines;
}

export function createApi({ fetchImpl = globalThis.fetch, origin = globalThis.location?.origin, initData }) {
  async function call(path, { method = "GET", body } = {}) {
    const response = await fetchImpl(`${origin}${API}/${path}`, {
      method, mode: "same-origin", credentials: "omit", cache: "no-store",
      headers: { "x-telegram-init-data": initData, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json().catch(() => ({ ok: false, why: "BAD_RESPONSE" }));
    if (!json.ok) throw new Error(json.why || `HTTP_${response.status}`);
    return json;
  }
  return Object.freeze({
    me: () => call("me"),
    registerWallet: (publicAddress) => call("wallet", { method: "POST", body: { publicAddress, walletKind: "EXTERNAL" } }),
    activateDelegation: (body) => call("delegations/activate", { method: "POST", body }),
    deactivateDelegation: (walletAddress) => call("delegations/deactivate", { method: "POST", body: { walletAddress } }),
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

export const OUTCOME_TEXT = Object.freeze({
  SUBMITTED_BY_USER_WALLET: ["Submitted by your wallet", "Lintcha is now reconciling the transaction hash against two RPC providers. Nothing is retried or re-sent automatically."],
  CANCELLED: ["Cancelled", "Nothing was signed or submitted."],
  EXPIRED: ["Expired", "The review window closed before the wallet opened. Nothing was submitted. Wait for a fresh signal."],
  WALLET_ERROR: ["Wallet did not complete", "The wallet reported an error. If it did submit something, Lintcha will only reconcile a hash you report; nothing is re-sent."],
});

function $(root, selector) { return root.querySelector(selector); }
function show(root, name) { for (const view of root.querySelectorAll("[data-view]")) view.classList.toggle("hidden", view.dataset.view !== name); }
function fail(root, message) { $(root, "[data-error]").textContent = String(message); show(root, "error"); }

export async function boot({ document: doc = globalThis.document, windowLike = globalThis, fetchImpl = globalThis.fetch, clock = () => Math.floor(Date.now() / 1000) } = {}) {
  const root = $(doc, "[data-copy-sheet]");
  const launch = parseTelegramLaunch(windowLike.location?.hash);
  if (!launch?.initData || !launch.userId) { show(root, "unauthenticated"); return; }
  const api = createApi({ fetchImpl, origin: windowLike.location.origin, initData: launch.initData });
  const provider = injectedProvider(windowLike);
  let me;

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
    $(root, "[data-delegation]").textContent = me.activeDelegations?.length
      ? `Active until ${new Date(me.activeDelegations[0].expiresAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC · ${me.activeDelegations[0].architecture}`
      : me.autoBuyAvailable ? "No active auto-BUY permission. Setup stays inactive until the wallet-provider permission is completed." : "Auto-BUY is globally disabled.";
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
  $(root, "[data-action=home]").addEventListener("click", home);
  await home();
}

if (typeof document !== "undefined" && document.querySelector("[data-copy-sheet]")) boot().catch((error) => fail(document.querySelector("[data-copy-sheet]"), error.message));
