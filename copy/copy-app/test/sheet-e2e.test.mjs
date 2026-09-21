// The Mini App script driven against the real Copy HTTP handler through a minimal DOM stand-in: proves the
// page authenticates with Telegram init data, registers a public address, reviews the intent from the server,
// requires the separate confirm, hands the wallet exactly the server's unsigned transaction and reports the hash.
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, randomBytes } from "node:crypto";
import { boot } from "../copy/copy-app.js";
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
  const el = { tag, textContent: "", disabled: false, hidden: false, children: [], listeners: {}, dataset: {}, className: "", onclick: null,
    classList: { toggle(name, force) { if (name === "hidden") el.hidden = force; } },
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
  assert.equal(get("[data-mode]").textContent, "legacy confirm-each");
  assert.match(get("[data-wallets]").textContent, /No public address/);
  await get("[data-action=connect-wallet]").click();
  assert.match(get("[data-wallets]").textContent, /external 0x1111…1111/);

  // A signal from the producer side creates the intent; the sheet lists it after Back/refresh.
  const signal = signServiceRequest({ schema: "lintcha.copy.intent.v1", requestId: randomBytes(16).toString("hex"), issuedAt: clock(), userId: "42", ...input() }, SECRET);
  const created = await (await handler(new Request(`${ORIGIN}/copy/api/intents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signal) }))).json();
  assert.equal(created.intent.state, "AWAITING_USER_CONFIRMATION");
  await get("[data-action=home]").click();
  const item = get("[data-intents]").children.at(-1);
  assert.equal(item.children[0].textContent, "BUY · trade");
  const reviewing = item.children[2].click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(visible(), "review");
  assert.match(get("[data-review-direction]").textContent, /^BUY — This is Lintcha Copy, not read-only Lintcha Core\./);
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
  assert.equal(requests.every((url) => url.startsWith(`${ORIGIN}/copy/api/`)), true);
  assert.equal(get("[data-review-fields]").textContent, "");
});

test("without Telegram init data the sheet shows the unauthenticated state and calls nothing", async () => {
  const { doc, visible } = fakeDocument();
  let calls = 0;
  await boot({ document: doc, windowLike: { location: { hash: "", origin: ORIGIN, href: `${ORIGIN}/copy/` } }, fetchImpl: () => { calls += 1; } });
  assert.equal(visible(), "unauthenticated");
  assert.equal(calls, 0);
});
