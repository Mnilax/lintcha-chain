// The Mini App script driven against the real Copy HTTP handler through a minimal DOM stand-in: proves the
// page authenticates with Telegram init data, registers a public address, reviews the intent from the server,
// requires the separate confirm, hands the wallet exactly the server's unsigned transaction and reports the hash.
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, randomBytes } from "node:crypto";
import { boot } from "../copy/copy-app.js";
import { configureCalldata } from "../copy/auto-buy-onboarding.mjs";
import { loadCopyConfig } from "../../copy-service/src/config.mjs";
import { GatewayRequestVerifier, MemoryReplayStore } from "../../copy-service/src/gateway-auth.mjs";
import { SignedServiceRequestVerifier, createCopyHttpHandler, signServiceRequest } from "../../copy-service/src/http.mjs";
import { MemoryOutboxStore, MemoryUserStore } from "../../copy-service/src/stores.mjs";
import { CopyTelegramSurface } from "../../copy-service/src/telegram-surface.mjs";
import { TelegramInitDataVerifier, telegramDataCheckString } from "../../copy-service/src/telegram-init-data.mjs";
import { HASH, ROUTER, WALLET, fixture, input } from "../../copy-service/test/helpers.mjs";

const subtle = webcrypto.subtle;
const ORIGIN = "https://copy.example.invalid";
const SECRET = "g".repeat(40);
const BOT_ID = "7342037359";

function element(tag = "div") {
  const el = { tag, textContent: "", value: "", disabled: false, hidden: false, children: [], listeners: {}, dataset: {}, className: "", onclick: null,
    classList: {
      toggle(name, force) { if (name === "hidden") el.hidden = force; },
      add(name) { if (name === "hidden") el.hidden = true; },
      remove(name) { if (name === "hidden") el.hidden = false; },
    },
    addEventListener(type, fn) { el.listeners[type] = fn; },
    append(...nodes) { el.children.push(...nodes); },
    click() { return (el.onclick || el.listeners.click)?.(); } };
  return el;
}

function fakeDocument() {
  const views = ["loading", "unauthenticated", "error", "home", "review", "result"].map((name) => { const view = element("section"); view.dataset.view = name; return view; });
  const named = new Map();
  const get = (selector) => { if (!named.has(selector)) named.set(selector, element()); return named.get(selector); };
  const root = { querySelector: (selector) => get(selector), querySelectorAll: (selector) => (selector === "[data-view]" ? views : []) };
  return { doc: { querySelector: (selector) => (selector === "[data-copy-sheet]" ? root : get(selector)), createElement: (tag) => element(tag) }, views, get, visible: () => views.find((view) => !view.hidden)?.dataset.view };
}

test("Mini App boot → wallet registration → review → separate confirm → wallet submit → hash reported", async () => {
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKeyHex = [...new Uint8Array(await subtle.exportKey("raw", pair.publicKey))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const params = new URLSearchParams({ query_id: "q", user: JSON.stringify({ id: 42 }), auth_date: "1700000000", hash: "f".repeat(64) });
  params.set("signature", Buffer.from(new Uint8Array(await subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(telegramDataCheckString([...params.entries()], BOT_ID))))).toString("base64url"));
  const initData = params.toString();

  const current = fixture();
  current.killSwitches.resumeGlobal();
  const clock = () => current.service.clock();
  const config = loadCopyConfig({ COPY_APP_ORIGIN: ORIGIN, COPY_ENVIRONMENT: "preproduction" });
  const userStore = new MemoryUserStore(clock);
  const outbox = new MemoryOutboxStore(clock);
  const replayStore = new MemoryReplayStore();
  const handler = createCopyHttpHandler({
    config, service: current.service, surface: new CopyTelegramSurface({ userStore, killSwitches: current.killSwitches, appOrigin: ORIGIN, service: current.service }), userStore, outbox, killSwitches: current.killSwitches, clock,
    gatewayVerifier: new GatewayRequestVerifier({ secret: SECRET, replayStore }),
    serviceVerifier: { intent: new SignedServiceRequestVerifier({ secret: SECRET, schema: "lintcha.copy.intent.v1", replayStore }) },
    initDataVerifier: new TelegramInitDataVerifier({ botId: BOT_ID, publicKeyHex, subtle }),
  });
  await userStore.upsert({ telegramUserId: "42", privateChatId: "99", mode: "CONFIRM_EACH", paused: false });
  const walletCalls = [];
  const ethereum = { async request(request) { walletCalls.push(request); if (request.method === "eth_requestAccounts" || request.method === "eth_accounts") return [WALLET]; if (request.method === "eth_chainId") return "0x1237"; if (request.method === "eth_sendTransaction") return HASH; return null; } };
  const { doc, get, visible } = fakeDocument();
  const windowLike = { location: { hash: `#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppPlatform=ios`, origin: ORIGIN, href: `${ORIGIN}/copy/` }, ethereum };
  const requests = [];
  // A browser adds Origin to every POST (and never to a same-origin GET); the stand-in does the same.
  const fetchImpl = (url, init) => { requests.push(String(url)); const headers = { ...init.headers }; if (init.method && init.method !== "GET") headers.origin = ORIGIN; return handler(new Request(url, { ...init, headers })); };

  await boot({ document: doc, windowLike, fetchImpl, clock });
  assert.equal(visible(), "home", get("[data-error]").textContent);
  assert.equal(get("[data-mode]").textContent, "confirm each trade");
  assert.match(get("[data-wallets]").textContent, /No public address/);
  await get("[data-action=connect-wallet]").click();
  assert.match(get("[data-wallets]").textContent, /external 0x1111…1111/);

  // A signal from the producer side creates the intent; the sheet lists it after Back/refresh.
  const signal = signServiceRequest({ schema: "lintcha.copy.intent.v1", requestId: randomBytes(16).toString("hex"), issuedAt: clock(), userId: "42", ...input() }, SECRET);
  const created = await (await handler(new Request(`${ORIGIN}/api/copy/intents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signal) }))).json();
  assert.equal(created.intent.state, "AWAITING_USER_CONFIRMATION");
  await get("[data-action=home]").click();
  const item = get("[data-intents]").children.at(-1);
  assert.equal(item.children[0].textContent, "BUY · trade");
  const reviewing = item.children[2].click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(visible(), "review");
  assert.match(get("[data-review-direction]").textContent, /^BUY — Copy-trading is an opt-in mode inside Lintcha\. Lintcha Core remains read-only\./);
  const fields = get("[data-review-fields]").children.map((node) => node.textContent);
  assert.equal(fields[fields.indexOf("Target contract") + 1], ROUTER);
  assert.equal(fields[fields.indexOf("Selector") + 1], "0x12345678");
  assert.equal(walletCalls.some((call) => call.method === "eth_sendTransaction"), false);
  await get("[data-action=confirm]").click();
  await reviewing;
  assert.equal(visible(), "result");
  assert.equal(get("[data-result-title]").textContent, "Submitted by your wallet");
  assert.match(get("[data-result-hash]").textContent, new RegExp(HASH));
  const sent = walletCalls.find((call) => call.method === "eth_sendTransaction").params[0];
  assert.deepEqual(sent, { from: WALLET, to: ROUTER, value: "0x1f4", data: "0x12345678" });
  assert.equal((await current.service.getIntentForUser({ intentId: created.intent.intentId, userId: "42" })).state, "SUBMITTED_PENDING_RECONCILIATION");
  assert.equal(requests.every((url) => url.startsWith(`${ORIGIN}/api/copy/`)), true);
  assert.equal(get("[data-review-fields]").textContent, "");
});

test("without Telegram init data the sheet shows the unauthenticated state and calls nothing", async () => {
  const { doc, visible } = fakeDocument();
  let calls = 0;
  await boot({ document: doc, windowLike: { location: { hash: "", origin: ORIGIN, href: `${ORIGIN}/copy/` } }, fetchImpl: () => { calls += 1; } });
  assert.equal(visible(), "unauthenticated");
  assert.equal(calls, 0);
});

test("auto-BUY setup is wired only to the identity-matched first-party embedded wallet", async () => {
  const wrapperAddress = `0x${"7".repeat(40)}`;
  const transactionHash = `0x${"a".repeat(64)}`;
  const finalizedHash = `0x${"b".repeat(64)}`;
  const now = 1_700_000_000;
  const setup = { privyAppId: "privy_app_123", signerId: "signer_12345678", policyId: "policy_12345678", wrapperAddress, chainId: 4663 };
  const events = [];
  let active = false;
  let registered = false;
  let preparedLimits;
  const word = (value) => BigInt(value).toString(16).padStart(64, "0");
  const embeddedProvider = {
    async request(request) {
      events.push(request.method);
      if (request.method === "eth_accounts") return [WALLET];
      if (request.method === "eth_chainId") return "0x1237";
      if (request.method === "eth_sendTransaction") return transactionHash;
      if (request.method === "eth_getTransactionReceipt") return { status: "0x1", blockNumber: "0x64", from: WALLET, to: wrapperAddress };
      if (request.method === "eth_getBlockByNumber") return { number: "0x64", hash: finalizedHash };
      if (request.method === "eth_call") return `0x${word(preparedLimits.maxTransactionWei)}${word(preparedLimits.maxDailySpendWei)}${word(preparedLimits.maxSlippageBps)}${word(preparedLimits.expiresAt)}${word(0)}`;
      throw new Error("UNEXPECTED_EMBEDDED_PROVIDER_METHOD");
    },
  };
  const lintchaPrivy = {
    publicConfig: setup,
    async getWallet() { return { walletAddress: WALLET, telegramUserId: "42", provider: embeddedProvider }; },
    async addSigners(input) { events.push(["addSigners", input]); return { address: input.address }; },
    async getSignerState() { return { walletAddress: WALLET, additionalSigners: [{ signerId: setup.signerId, policyIds: [setup.policyId] }] }; },
    async removeSigners(input) { events.push(["removeSigners", input]); },
  };
  const { doc, get } = fakeDocument();
  const windowLike = {
    location: { hash: "#tgWebAppData=user%3D%257B%2522id%2522%253A42%257D", origin: ORIGIN, href: `${ORIGIN}/copy/` },
    lintchaPrivy,
    ethereum: { request() { throw new Error("GENERIC_PROVIDER_MUST_NOT_BE_USED_FOR_AUTO_BUY"); } },
  };
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname.replace("/api/copy/", "");
    const body = init.body ? JSON.parse(init.body) : null;
    events.push([route, body]);
    let response;
    if (route === "me") response = {
      ok: true, user: { mode: active ? "AUTO_BUY" : "NOTIFY_ONLY", paused: false }, globallyPaused: false,
      autoBuyAvailable: true, autoBuySetup: setup, chainId: 4663,
      wallets: registered ? [{ publicAddress: WALLET, walletKind: "EXTERNAL" }] : [],
      activeDelegations: active ? [{ walletAddress: WALLET, architecture: "PRIVY", chainId: 4663, wrapperAddress, expiresAt: preparedLimits.expiresAt }] : [],
      intents: [],
    };
    else if (route === "wallet") { registered = true; response = { ok: true }; }
    else if (route === "delegations/prepare") {
      const { walletAddress, ...limits } = body;
      assert.equal(walletAddress, WALLET);
      preparedLimits = limits;
      response = { ok: true, activationToken: "activation_body_12345678.activation_signature_12345678", limits, transaction: { chainId: 4663, to: wrapperAddress, value: "0", data: configureCalldata(limits) } };
    } else if (route === "delegations/verify-configuration") {
      assert.deepEqual(Object.keys(body).sort(), ["activationToken", "walletAddress"]);
      response = { ok: true, ready: true, walletAddress: WALLET, finalizedBlock: 100 };
    } else if (route === "delegations/activate") {
      assert.deepEqual(Object.keys(body).sort(), ["activationToken", "walletAddress"]);
      active = true;
      response = { ok: true, active: true };
    } else throw new Error(`UNEXPECTED_ROUTE_${route}`);
    return { status: 200, async json() { return response; } };
  };

  await boot({ document: doc, windowLike, fetchImpl, clock: () => now });
  assert.equal(get("[data-auto-buy-setup]").hidden, false);
  assert.equal(get("[data-action=activate-auto-buy]").disabled, false);
  get("[data-auto-buy-input=max-trade]").value = "0.005";
  get("[data-auto-buy-input=daily-cap]").value = "0.02";
  get("[data-auto-buy-input=slippage]").value = "1";
  get("[data-auto-buy-input=duration]").value = "24";
  await get("[data-action=activate-auto-buy]").click();
  assert.equal(active, true);
  assert.match(get("[data-auto-buy-status]").textContent, /Auto-BUY is active/);
  assert.equal(events.some((entry) => entry === "eth_sendTransaction"), true);
  assert.deepEqual(events.find((entry) => Array.isArray(entry) && entry[0] === "addSigners")[1], { address: WALLET, signers: [{ signerId: setup.signerId, policyIds: [setup.policyId] }] });
  assert.equal(events.some((entry) => entry === "GENERIC_PROVIDER_MUST_NOT_BE_USED_FOR_AUTO_BUY"), false);
});
