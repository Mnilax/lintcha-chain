import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, randomBytes } from "node:crypto";
import { loadCopyConfig } from "../src/config.mjs";
import { GatewayRequestVerifier, MemoryReplayStore } from "../src/gateway-auth.mjs";
import { SignedServiceRequestVerifier, createCopyHttpHandler, signServiceRequest } from "../src/http.mjs";
import { MemoryOutboxStore, MemoryUserStore } from "../src/stores.mjs";
import { CopyTelegramSurface } from "../src/telegram-surface.mjs";
import { MemoryDelegationStore } from "../src/delegated-execution.mjs";
import { TelegramInitDataVerifier, telegramDataCheckString } from "../src/telegram-init-data.mjs";
import { routeCopyUpdate, drainCopyOutbox } from "../../copy-gateway/src/gateway.mjs";
import { ConfirmEachSheetController, ExternalEip1193WalletAdapter } from "../../secure-sheet-crypto/src/confirm-each.mjs";
import { HASH, NOW, ROUTER, TOKEN, WALLET, approvalInput, autoBuyInput, fixture, input, sellTradeInput } from "./helpers.mjs";

const subtle = webcrypto.subtle;
const ORIGIN = "https://lintcha.com";
const GATEWAY_SECRET = "g".repeat(40);
const ADMIN_SECRET = "a".repeat(40);
const BOT_ID = "7342037359";

async function telegramKeys() {
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { pair, publicKeyHex: [...raw].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
}

async function initDataFor(pair, userId, authDate = NOW) {
  const params = new URLSearchParams({ query_id: "q", user: JSON.stringify({ id: Number(userId), first_name: "V" }), auth_date: String(authDate), hash: "f".repeat(64) });
  const signature = new Uint8Array(await subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(telegramDataCheckString([...params.entries()], BOT_ID))));
  params.set("signature", Buffer.from(signature).toString("base64url"));
  return params.toString();
}

async function stack(fixtureOptions = {}, configEnv = {}, runtimeOptions = {}) {
  const keys = await telegramKeys();
  const current = fixture(fixtureOptions);
  const config = loadCopyConfig({ COPY_APP_ORIGIN: ORIGIN, COPY_ENVIRONMENT: "preproduction", ...configEnv });
  const clock = () => current.service.clock();
  const userStore = new MemoryUserStore(clock);
  const outbox = new MemoryOutboxStore(clock);
  const replayStore = new MemoryReplayStore();
  const delegationStore = current.service.delegationStore;
  const surface = new CopyTelegramSurface({ userStore, delegationStore, killSwitches: current.killSwitches, appOrigin: ORIGIN, appPath: "/copy/", service: current.service, autoBuyAvailable: config.autoBuyEnabled });
  const handler = createCopyHttpHandler({
    config, service: current.service, surface, userStore, delegationStore, delegationVerifier: runtimeOptions.delegationVerifier || null, outbox, killSwitches: current.killSwitches, clock,
    gatewayVerifier: new GatewayRequestVerifier({ secret: GATEWAY_SECRET, replayStore }),
    serviceVerifier: {
      outbox: new SignedServiceRequestVerifier({ secret: GATEWAY_SECRET, schema: "lintcha.copy.outbox.v1", replayStore }),
      notify: new SignedServiceRequestVerifier({ secret: GATEWAY_SECRET, schema: "lintcha.copy.notify.v1", replayStore }),
      intent: new SignedServiceRequestVerifier({ secret: GATEWAY_SECRET, schema: "lintcha.copy.intent.v1", replayStore }),
      autoBuy: new SignedServiceRequestVerifier({ secret: GATEWAY_SECRET, schema: "lintcha.copy.auto-buy.v1", replayStore }),
    },
    adminVerifier: new SignedServiceRequestVerifier({ secret: ADMIN_SECRET, schema: "lintcha.copy.admin.v1", replayStore }),
    initDataVerifier: new TelegramInitDataVerifier({ botId: BOT_ID, publicKeyHex: keys.publicKeyHex, subtle }),
  });
  const call = (path, init = {}) => handler(new Request(`${ORIGIN}/api/copy/${path}`, init));
  const post = (path, body, headers = {}) => call(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const signed = (path, schema, payload, secret = GATEWAY_SECRET) => post(path, signServiceRequest({ schema, requestId: randomBytes(16).toString("hex"), issuedAt: clock(), ...payload }, secret));
  const client = async (userId) => ({ origin: ORIGIN, "x-telegram-init-data": await initDataFor(keys.pair, userId, clock()) });
  const copyClient = { async handle(signedEnvelope) { const response = await post("gateway", signedEnvelope); const body = await response.json(); if (!body.ok) throw new Error(body.why); return body.response; } };
  const telegram = (update, updateId = 1) => routeCopyUpdate({ update: { update_id: updateId, ...update }, nowSeconds: clock(), serviceSecret: GATEWAY_SECRET, copyClient, copyAppOrigin: ORIGIN });
  const privateMessage = (text) => ({ message: { text, chat: { id: 99, type: "private" }, from: { id: 42 } } });
  const callback = (data) => ({ callback_query: { data, from: { id: 42 }, message: { chat: { id: 99, type: "private" } } } });
  let updateId = 100;
  const nextUpdate = () => ++updateId;
  return { ...current, keys, config, userStore, outbox, handler, call, post, signed, client, telegram, privateMessage, callback, nextUpdate, clock };
}

test("Mini App activation stores only server-verified public delegation metadata and deactivation disables auto-BUY", async () => {
  const delegations = new MemoryDelegationStore(() => NOW);
  const verified = [];
  const s = await stack(
    { service: { delegationStore: delegations, autoBuyEnabled: true, delegatedSubmissionEnabled: true, delegatedExecutor: { async submit() { return { transactionHash: HASH }; } } } },
    { COPY_AUTO_BUY_ENABLED: "true", COPY_DELEGATED_SUBMISSION_ENABLED: "true", COPY_AUTO_BUY_EXECUTOR_ADDRESS: ROUTER, COPY_ALLOW_ROUTERS: JSON.stringify([ROUTER]), COPY_ALLOW_SELECTORS: JSON.stringify(["0xa59ac6dd"]), COPY_MAX_TRANSACTION_WEI: "1000", COPY_MAX_DAILY_SPEND_WEI: "3000", COPY_MAX_SLIPPAGE_BPS: "100" },
    { delegationVerifier: { async verifyDelegation(input) { verified.push(input); return { architecture: "PRIVY_TEE", authorizationRef: "privy-wallet:wallet_fixture_1234", walletAddress: input.walletAddress, chainId: 4663 }; } } },
  );
  const headers = await s.client("42");
  await s.post("wallet", { publicAddress: WALLET, walletKind: "EXTERNAL" }, headers);
  const body = { walletAddress: WALLET, maxTransactionWei: "500", maxDailySpendWei: "1500", maxSlippageBps: 50, expiresAt: NOW + 3600 };
  const activated = await (await s.post("delegations/activate", body, headers)).json();
  assert.equal(activated.active, true);
  assert.equal(activated.delegation.architecture, "PRIVY_TEE");
  assert.equal((await s.userStore.get("42")).mode, "AUTO_BUY");
  assert.deepEqual(verified, [{ walletAddress: WALLET }]);
  assert.equal(JSON.stringify(activated).includes("authorizationRef"), false);
  const active = await delegations.getActive("42", WALLET);
  assert.equal(active.selectors[0], "0xa59ac6dd");
  assert.equal(active.routers[0], ROUTER);
  assert.equal(active.maxTransactionWei, "500");
  assert.equal((await s.post("delegations/activate", { ...body, maxTransactionWei: "1001" }, headers)).status, 400);
  assert.equal((await s.post("delegations/activate", { ...body, privateKey: "never" }, headers)).status, 400);
  const deactivated = await (await s.post("delegations/deactivate", { walletAddress: WALLET }, headers)).json();
  assert.equal(deactivated.active, false);
  assert.equal(await delegations.getActive("42", WALLET), null);
  assert.equal((await s.userStore.get("42")).mode, "NOTIFY_ONLY");
});

test("end-to-end bounded auto-BUY activates only after delegation and submits once", async () => {
  const delegations = new MemoryDelegationStore(() => NOW);
  await delegations.put({ userId: "42", walletAddress: WALLET, architecture: "EIP7702_SESSION", authorizationRef: "auth:http:auto:42", chainId: 4663, routers: [ROUTER], selectors: ["0xa59ac6dd"], maxTransactionWei: "600", maxDailySpendWei: "700", maxSlippageBps: 75, expiresAt: NOW + 3600 });
  let submissions = 0;
  const s = await stack({ service: { delegationStore: delegations, autoBuyEnabled: true, delegatedSubmissionEnabled: true, delegatedExecutor: { async submit() { submissions += 1; return { transactionHash: HASH }; } } } }, { COPY_AUTO_BUY_ENABLED: "true", COPY_DELEGATED_SUBMISSION_ENABLED: "true", COPY_AUTO_BUY_EXECUTOR_ADDRESS: ROUTER, COPY_ALLOW_ROUTERS: JSON.stringify([ROUTER]), COPY_ALLOW_SELECTORS: JSON.stringify(["0xa59ac6dd"]) });
  await s.telegram(s.privateMessage("/start copy_site"), s.nextUpdate());
  await s.post("wallet", { publicAddress: WALLET, walletKind: "EXTERNAL" }, await s.client("42"));
  const selected = await s.telegram(s.callback("copy.mode.auto_buy"), s.nextUpdate());
  assert.match(selected.response.text, /Mode: auto-copy BUY/);
  await s.telegram(s.callback("copy.resume"), s.nextUpdate());
  s.killSwitches.resumeGlobal();
  const created = await (await s.signed("auto-buy", "lintcha.copy.auto-buy.v1", { userId: "42", ...autoBuyInput() })).json();
  assert.equal(created.intent.state, "SUBMITTED_PENDING_RECONCILIATION");
  assert.equal(created.intent.executionMode, "AUTO_BUY");
  assert.equal(submissions, 1);
  const duplicate = await (await s.signed("auto-buy", "lintcha.copy.auto-buy.v1", { userId: "42", ...autoBuyInput() })).json();
  assert.equal(duplicate.intent.duplicate, true);
  assert.equal(submissions, 1);
  const me = await (await s.call("me", { headers: await s.client("42") })).json();
  assert.equal(me.autoBuyAvailable, true);
  assert.equal(me.activeDelegations[0].walletAddress, WALLET);
});

async function sheet(s, { intentId, userId = "42", wallet = WALLET, provider }) {
  const headers = await s.client(userId);
  const opened = await (await s.call(`intents/${intentId}`, { headers })).json();
  assert.equal(opened.ok, true);
  const controller = new ConfirmEachSheetController({
    copyApi: {
      async beginConfirmation({ token, revision }) { const body = await (await s.post(`intents/${intentId}/begin`, { token, revision }, headers)).json(); if (!body.ok) throw new Error(body.why); return body.intent; },
      async recordSubmission({ revision, transactionHash }) { const body = await (await s.post(`intents/${intentId}/submission`, { revision, transactionHash }, headers)).json(); if (!body.ok) throw new Error(body.why); return body.intent; },
      async cancel({ reason }) { await s.post(`intents/${intentId}/cancel`, { reason }, headers); },
    },
    walletAdapter: new ExternalEip1193WalletAdapter(provider),
    localReview: async () => {}, localConfirm: async () => true, clearSensitiveView: async () => {}, clock: s.clock,
  });
  return controller.execute({ token: opened.intent.confirmationToken, userId, revision: opened.intent.revision, walletAddress: wallet });
}

function wallet(sendHash = HASH) {
  return { calls: [], async request(request) { this.calls.push(request.method); if (request.method === "eth_accounts") return [WALLET]; if (request.method === "eth_chainId") return "0x1237"; if (request.method === "eth_sendTransaction") return sendHash; return null; } };
}

test("end-to-end confirm-each BUY: Telegram settings → signal → outbox → Mini App review → wallet → reconciliation", async () => {
  const s = await stack();
  const start = await s.telegram(s.privateMessage("/start copy_site"), s.nextUpdate());
  assert.match(start.response.text, /^Lintcha — copy-trading/);
  assert.match(start.response.text, /Lintcha Core remains read-only/);
  assert.equal(start.response.reply_markup.inline_keyboard.at(-1)[0].web_app.url, `${ORIGIN}/copy/`);
  await s.telegram(s.privateMessage("/start copy_site"), s.nextUpdate());
  const referralStats = await (await s.signed("admin/referrals", "lintcha.copy.admin.v1", {}, ADMIN_SECRET)).json();
  assert.deepEqual(referralStats.referrals, { source: "SITE", uniqueUsers: 1, starts: 2 });
  await s.telegram(s.callback("copy.mode.confirm_each"), s.nextUpdate());
  const resumed = await s.telegram(s.callback("copy.resume"), s.nextUpdate());
  assert.match(resumed.response.text, /Mode: confirm each trade/);
  assert.match(resumed.response.text, /Status: active/);
  s.killSwitches.resumeGlobal();

  // Signal before any wallet is registered is refused; the user registers a public address from the sheet.
  const early = await s.signed("intents", "lintcha.copy.intent.v1", { userId: "42", ...input() });
  assert.equal((await early.json()).why, "WALLET_NOT_REGISTERED");
  const registered = await s.post("wallet", { publicAddress: WALLET, walletKind: "EXTERNAL" }, await s.client("42"));
  assert.equal((await registered.json()).wallets[0].publicAddress, WALLET);
  const me = await (await s.call("me", { headers: await s.client("42") })).json();
  assert.equal(me.label, "Lintcha — copy-trading");
  assert.equal(me.user.mode, "CONFIRM_EACH");

  const created = await (await s.signed("intents", "lintcha.copy.intent.v1", { userId: "42", ...input() })).json();
  assert.equal(created.intent.state, "AWAITING_USER_CONFIRMATION");
  assert.equal("confirmationToken" in created.intent, false);
  const duplicate = await (await s.signed("intents", "lintcha.copy.intent.v1", { userId: "42", ...input() })).json();
  assert.equal(duplicate.intent.duplicate, true);

  // Core drains the outbox with its own token; the line names the module and links only the Copy origin.
  const delivered = [];
  const drained = await drainCopyOutbox({ serviceSecret: GATEWAY_SECRET, nowSeconds: s.clock(), copyAppOrigin: ORIGIN, requestId: "ab".repeat(8), copyClient: { async drain(signedRequest) { const body = await (await s.post("gateway/outbox", signedRequest)).json(); if (!body.ok) throw new Error(body.why); return body.rows; } }, send: async (row) => { delivered.push(row); return "accepted"; } });
  assert.equal(drained.sent, 1);
  assert.equal(delivered[0].chatId, "99");
  assert.match(delivered[0].response.text, /^Lintcha — copy-trading\nA source BUY/);
  assert.equal(delivered[0].response.reply_markup.inline_keyboard[0][0].web_app.url, `${ORIGIN}/copy/?intent=${created.intent.intentId}`);
  const again = await drainCopyOutbox({ serviceSecret: GATEWAY_SECRET, nowSeconds: s.clock(), copyAppOrigin: ORIGIN, requestId: "cd".repeat(8), copyClient: { async drain(signedRequest) { return (await (await s.post("gateway/outbox", signedRequest)).json()).rows; } }, send: async () => "accepted" });
  assert.equal(again.sent, 0);

  const provider = wallet();
  const outcome = await sheet(s, { intentId: created.intent.intentId, provider });
  assert.equal(outcome.outcome, "SUBMITTED_BY_USER_WALLET");
  assert.deepEqual(provider.calls, ["eth_accounts", "eth_chainId", "eth_sendTransaction"]);
  const reconciled = await (await s.signed("admin/reconcile", "lintcha.copy.admin.v1", {}, ADMIN_SECRET)).json();
  assert.equal(reconciled.results[0].state, "CONFIRMED");
  assert.equal(s.spendLedger.reservations.get(created.intent.intentId).state, "COMMITTED");
  const review = await s.telegram(s.callback(`trade.review.${created.intent.intentId}`), s.nextUpdate());
  assert.match(review.response.text, /closed \(CONFIRMED\)/);
  assert.equal(JSON.stringify(s.sink.records).includes("privateKey"), false);
});

test("end-to-end manual SELL: exact approval intent, reconciliation, then a separately quoted and confirmed trade", async () => {
  const s = await stack();
  s.killSwitches.resumeGlobal();
  await s.userStore.upsert({ telegramUserId: "42", privateChatId: "99", mode: "CONFIRM_EACH", paused: false });
  await s.userStore.addWallet({ telegramUserId: "42", publicAddress: WALLET });
  const tradeFirst = await (await s.signed("intents", "lintcha.copy.intent.v1", { userId: "42", ...sellTradeInput({ manualSell: false }) })).json();
  assert.equal(tradeFirst.why, "AUTO_SELL_FORBIDDEN");
  const approval = await (await s.signed("intents", "lintcha.copy.intent.v1", { userId: "42", ...approvalInput(500) })).json();
  assert.equal(approval.intent.operation, "APPROVAL");
  const approvalHash = `0x${"c".repeat(64)}`;
  s.primary.calls.length = 0;
  for (const p of [s.primary, s.secondary]) {
    p.request = ((original) => async (method, params = []) => {
      if (method === "eth_getTransactionByHash") return { hash: approvalHash, from: WALLET, to: TOKEN, input: approvalInput(500).transaction.data, value: "0x0", nonce: "0x2", blockHash: `0x${"b".repeat(64)}`, blockNumber: "0x63" };
      if (method === "eth_getTransactionReceipt") return { transactionHash: approvalHash, from: WALLET, to: TOKEN, status: "0x1", blockHash: `0x${"b".repeat(64)}`, blockNumber: "0x63", gasUsed: "0x5208", logs: [] };
      return original(method, params);
    })(p.request.bind(p));
  }
  const approved = await sheet(s, { intentId: approval.intent.intentId, provider: wallet(approvalHash) });
  assert.equal(approved.outcome, "SUBMITTED_BY_USER_WALLET");
  const reconciledResponse = await s.signed("admin/reconcile", "lintcha.copy.admin.v1", {}, ADMIN_SECRET);
  const reconciled = await reconciledResponse.json();
  assert.equal(reconciled.results[0].state, "CONFIRMED");
  // The trade is a new intent with a fresh quote and its own simulation and allowance read; Telegram cannot confirm it.
  const reused = await (await s.signed("intents", "lintcha.copy.intent.v1", { userId: "42", ...sellTradeInput() })).json();
  assert.equal(reused.why, "QUOTE_ALREADY_USED");
  const trade = await (await s.signed("intents", "lintcha.copy.intent.v1", { userId: "42", ...sellTradeInput({ quote: { ...sellTradeInput().quote, id: "sq2" } }) })).json();
  assert.equal(trade.intent.state, "AWAITING_USER_CONFIRMATION");
  assert.notEqual(trade.intent.intentId, approval.intent.intentId);
  const refused = await s.telegram(s.callback(`sell.confirm.${trade.intent.intentId}`), s.nextUpdate());
  assert.match(refused.response.text, /Telegram cannot confirm a SELL/);
  assert.equal((await s.service.getIntentForUser({ intentId: trade.intent.intentId, userId: "42" })).state, "AWAITING_USER_CONFIRMATION");
  const sold = await sheet(s, { intentId: trade.intent.intentId, provider: wallet() });
  assert.equal(sold.submitted, true);
});

test("HTTP negative branches: origin, init data, paused users, notify-only users, replay, secrets and unknown routes", async () => {
  const s = await stack();
  s.killSwitches.resumeGlobal();
  const headers = await s.client("42");
  assert.equal((await s.call("me", { headers: { ...headers, origin: "https://evil.example" } })).status, 403);
  assert.equal((await s.call("me", { headers: { ...headers, "x-telegram-init-data": headers["x-telegram-init-data"].replace("first_name", "first_nam3") } })).status, 401);
  assert.equal((await s.call("me", { headers: { origin: ORIGIN, "x-telegram-init-data": await s.client("42").then(() => "") } })).status, 401);
  assert.equal((await s.call("nothing", { headers })).status, 404);
  assert.equal((await s.handler(new Request(`${ORIGIN}/copy/api/me`, { headers }))).status, 404);
  assert.equal((await s.handler(new Request(`${ORIGIN}/api/telegram`, { method: "POST" }))).status, 404);
  // A same-origin GET carries no Origin in browsers and is accepted; a POST without Origin never is.
  assert.equal((await s.call("me", { headers: { "x-telegram-init-data": headers["x-telegram-init-data"] } })).status, 200);
  assert.equal((await s.call("me", { headers: { "x-telegram-init-data": headers["x-telegram-init-data"], "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await s.post("wallet", { publicAddress: WALLET }, { "x-telegram-init-data": headers["x-telegram-init-data"] })).status, 403);
  assert.equal((await s.call("me", { method: "POST", headers })).status, 405);
  assert.equal((await s.post("wallet", { publicAddress: WALLET, mnemonic: "one two" }, headers)).status, 400);
  assert.equal((await s.post("wallet", { publicAddress: "0x12" }, headers)).status, 400);
  await s.post("wallet", { publicAddress: WALLET }, headers);
  // Notify-only user: a signal never creates an intent, a plain notification is queued instead.
  await s.userStore.upsert({ telegramUserId: "42", privateChatId: "99", mode: "NOTIFY_ONLY", paused: false });
  assert.equal((await (await s.signed("intents", "lintcha.copy.intent.v1", { userId: "42", ...input() })).json()).why, "USER_NOT_CONFIRM_EACH");
  assert.equal((await (await s.signed("notify", "lintcha.copy.notify.v1", { telegramUserId: "42", text: "Source BUY seen <script>", dedupeKey: "n1" })).json()).queued, true);
  assert.equal((await (await s.signed("notify", "lintcha.copy.notify.v1", { telegramUserId: "42", text: "again", dedupeKey: "n1" })).json()).queued, false);
  const queued = await s.outbox.lease(5, s.clock());
  assert.equal(queued[0].text.includes("<script>"), false);
  // Paused user: no intent, no notification.
  await s.userStore.upsert({ telegramUserId: "42", mode: "CONFIRM_EACH", paused: true });
  assert.equal((await s.signed("intents", "lintcha.copy.intent.v1", { userId: "42", ...input() })).status, 423);
  assert.equal((await s.signed("notify", "lintcha.copy.notify.v1", { telegramUserId: "42", text: "x" })).status, 423);
  await s.userStore.upsert({ telegramUserId: "42", paused: false });
  const created = await (await s.signed("intents", "lintcha.copy.intent.v1", { userId: "42", ...input() })).json();
  await s.userStore.upsert({ telegramUserId: "42", paused: true });
  const view = await (await s.call(`intents/${created.intent.intentId}`, { headers })).json();
  assert.equal((await s.post(`intents/${created.intent.intentId}/begin`, { token: view.intent.confirmationToken, revision: view.intent.revision }, headers)).status, 423);
  // Another Telegram user cannot read or drive this intent.
  const other = await s.client("43");
  assert.equal((await s.call(`intents/${created.intent.intentId}`, { headers: other })).status, 403);
  assert.equal((await s.post(`intents/${created.intent.intentId}/cancel`, {}, other)).status, 403);
  // Signed-channel replay and bad admin secret.
  const replayed = signServiceRequest({ schema: "lintcha.copy.admin.v1", requestId: "ff".repeat(8), issuedAt: s.clock() }, ADMIN_SECRET);
  assert.equal((await s.post("admin/reconcile", replayed)).status, 200);
  assert.equal((await s.post("admin/reconcile", replayed)).status, 409);
  assert.equal((await s.signed("admin/reconcile", "lintcha.copy.admin.v1", {}, "wrong".repeat(8))).status, 401);
  // Global pause from the admin channel blocks the sheet even for a resumed user.
  await s.userStore.upsert({ telegramUserId: "42", paused: false });
  assert.equal((await (await s.signed("admin/kill-switch", "lintcha.copy.admin.v1", { scope: "GLOBAL", action: "PAUSE", reason: "drill" }, ADMIN_SECRET)).json()).killSwitches.global.paused, 1);
  assert.equal((await s.post(`intents/${created.intent.intentId}/begin`, { token: view.intent.confirmationToken, revision: view.intent.revision }, headers)).status, 423);
  const health = await (await s.call("health")).json();
  assert.equal(health.globallyPaused, true);
  assert.equal(JSON.stringify(health).includes("http"), false);

  await s.signed("admin/kill-switch", "lintcha.copy.admin.v1", { scope: "GLOBAL", action: "RESUME" }, ADMIN_SECRET);
  const walletPause = await (await s.signed("admin/kill-switch", "lintcha.copy.admin.v1", { scope: "WALLET", action: "PAUSE", subjectId: `0x${WALLET.slice(2).toUpperCase()}`, reason: "wallet drill" }, ADMIN_SECRET)).json();
  assert.equal(walletPause.killSwitches.wallets[0].subjectId, WALLET);
});

test("rate limit and duplicate clicks from the Mini App fail closed without touching the wallet path", async () => {
  const s = await stack();
  s.killSwitches.resumeGlobal();
  const headers = await s.client("42");
  let status = 200;
  for (let index = 0; index < 40 && status !== 429; index += 1) status = (await s.call("me", { headers })).status;
  assert.equal(status, 429);
});
