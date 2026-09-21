import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, randomBytes } from "node:crypto";
import worker, { CopyUserCoordinator } from "../src/cloudflare/worker.mjs";
import { buildRuntime } from "../src/cloudflare/runtime.mjs";
import { signServiceRequest } from "../src/http.mjs";
import { signGatewayEnvelope } from "../../copy-gateway/src/gateway.mjs";
import { telegramDataCheckString } from "../src/telegram-init-data.mjs";
import { fakeD1 } from "./fake-d1.mjs";
import { BLOCK_HASH, HASH, ROUTER, TOKEN, WALLET, input, word } from "./helpers.mjs";

const subtle = webcrypto.subtle;
const ORIGIN = "https://lintcha.com";
const GATEWAY_SECRET = "g".repeat(40);
const ADMIN_SECRET = "a".repeat(40);
const BOT_ID = "7342037359";
const NOW = 1_700_000_000;

const RPC = {
  eth_chainId: () => "0x1237", eth_blockNumber: () => "0x64",
  eth_getBlockByNumber: (params) => ({ number: /^0x/.test(params[0]) ? params[0] : "0x64", hash: BLOCK_HASH }),
  eth_call: (params) => String(params[0]?.data || "").startsWith("0xdd62ed3e") ? `0x${word(1_000_000)}` : "0x01",
  eth_estimateGas: () => "0x5208",
  eth_getTransactionByHash: () => ({ hash: HASH, from: WALLET, to: ROUTER, input: "0x12345678", value: "0x1f4", nonce: "0x1", blockHash: BLOCK_HASH, blockNumber: "0x63" }),
  eth_getTransactionReceipt: () => ({ transactionHash: HASH, from: WALLET, to: ROUTER, status: "0x1", blockHash: BLOCK_HASH, blockNumber: "0x63", gasUsed: "0x5208", logs: [] }),
};
const seenUrls = [];
const fakeFetch = async (url, init) => {
  seenUrls.push(String(url));
  const body = JSON.parse(init.body);
  const handler = RPC[body.method];
  return Response.json(handler ? { jsonrpc: "2.0", id: body.id, result: handler(body.params) } : { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } });
};

async function telegramKeys() {
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { pair, publicKeyHex: [...raw].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
}
async function initData(pair, userId) {
  const params = new URLSearchParams({ query_id: "q", user: JSON.stringify({ id: Number(userId) }), auth_date: String(Math.floor(Date.now() / 1000)), hash: "f".repeat(64) });
  const signature = new Uint8Array(await subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(telegramDataCheckString([...params.entries()], BOT_ID))));
  params.set("signature", Buffer.from(signature).toString("base64url"));
  return params.toString();
}

function fakeEnv(keys, overrides = {}) {
  const instances = new Map();
  const env = {
    COPY_DB: fakeD1(),
    COPY_USER: { idFromName: (name) => name, get: (id) => ({ fetch: (url, init) => { if (!instances.has(id)) instances.set(id, new CopyUserCoordinator({ id }, env)); return instances.get(id).fetch(new Request(url, init)); } }) },
    COPY_GATEWAY_SECRET: GATEWAY_SECRET, COPY_CONFIRMATION_SECRET: "7".repeat(64), COPY_ADMIN_SECRET: ADMIN_SECRET,
    COPY_ENVIRONMENT: "preproduction", COPY_APP_ORIGIN: ORIGIN, COPY_TELEGRAM_BOT_ID: BOT_ID, COPY_TELEGRAM_PUBLIC_KEY_HEX: keys.publicKeyHex,
    COPY_RPC_PRIMARY_URL: "https://primary.invalid/v2/SECRET-KEY-A", COPY_RPC_SECONDARY_URL: "https://secondary.invalid/SECRET-KEY-B",
    COPY_ALLOW_ROUTERS: JSON.stringify([ROUTER]), COPY_ALLOW_SPENDERS: JSON.stringify([ROUTER]), COPY_ALLOW_SELECTORS: JSON.stringify(["0x12345678", "0x095ea7b3"]),
    COPY_MAX_TRANSACTION_WEI: "1000", COPY_MAX_DAILY_SPEND_WEI: "1500", COPY_MAX_SLIPPAGE_BPS: "100", COPY_MAX_SELL_AMOUNT_BY_TOKEN: JSON.stringify({ [TOKEN]: "1000" }),
    ...overrides,
  };
  return { env, instances };
}

const api = (path, init) => new Request(`${ORIGIN}/api/copy/${path}`, init);
const post = (path, body, headers = {}) => api(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const signed = (path, schema, payload, secret = GATEWAY_SECRET) => post(path, signServiceRequest({ schema, requestId: randomBytes(16).toString("hex"), issuedAt: Math.floor(Date.now() / 1000), ...payload }, secret));

test("worker refuses to start with a bot token or without its own bindings, and never echoes RPC URLs", async () => {
  const keys = await telegramKeys();
  const { env } = fakeEnv(keys);
  const poisoned = await worker.fetch(api("health"), { ...env, TELEGRAM_BOT_TOKEN: "123:abc" });
  assert.equal(poisoned.status, 503);
  assert.equal((await poisoned.json()).why, "COPY_SERVICE_MUST_NOT_RECEIVE_BOT_TOKEN");
  assert.equal((await (await worker.fetch(api("health"), { ...env, COPY_DB: undefined })).json()).why, "COPY_DB_BINDING_REQUIRED");
  assert.equal((await (await worker.fetch(api("health"), { ...env, COPY_GATEWAY_SECRET: "short" })).json()).why, "COPY_GATEWAY_SECRET_REQUIRED");
  await assert.rejects(buildRuntime({ ...env, COPY_ENVIRONMENT: "production", COPY_RPC_SECONDARY_URL: "" }), /TWO_RPC_ENDPOINTS_REQUIRED/);
  const health = await worker.fetch(api("health"), env);
  const body = await health.text();
  assert.equal(health.status, 200);
  assert.equal(body.includes("SECRET-KEY"), false);
  assert.equal(JSON.parse(body).globallyPaused, true);
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/copy/`), env)).status, 404);
});

test("worker runs confirm-each BUY through D1 and the per-user Durable Object, and the cron reconciles", async () => {
  const keys = await telegramKeys();
  const { env, instances } = fakeEnv(keys);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const envelope = (route, extra = {}, updateId = String(Date.now())) => signGatewayEnvelope({ schema: "lintcha.copy.gateway.v1", route, updateId, telegramUserId: "42", privateChatId: "99", locale: "ru", receivedAt: Math.floor(Date.now() / 1000), ...extra }, GATEWAY_SECRET);
    const start = await (await worker.fetch(post("gateway", await envelope("COPY_COMMAND", {}, "1")), env)).json();
    assert.match(start.response.text, /^Lintcha — copy-trading/);
    assert.equal((await worker.fetch(post("gateway", await envelope("COPY_COMMAND", {}, "1")), env)).status, 409);
    await worker.fetch(post("gateway", await envelope("COPY_CALLBACK", { callbackData: "copy.mode.confirm_each" }, "2")), env);
    await worker.fetch(post("gateway", await envelope("COPY_CALLBACK", { callbackData: "copy.resume" }, "3")), env);
    const resumed = await (await worker.fetch(signed("admin/kill-switch", "lintcha.copy.admin.v1", { scope: "GLOBAL", action: "RESUME", reason: "test" }, ADMIN_SECRET), env)).json();
    assert.equal(resumed.killSwitches.global.paused, 0);
    const headers = { origin: ORIGIN, "x-telegram-init-data": await initData(keys.pair, "42") };
    assert.equal((await worker.fetch(post("wallet", { publicAddress: WALLET }, headers), env)).status, 200);
    const created = await (await worker.fetch(signed("intents", "lintcha.copy.intent.v1", { userId: "42", ...input({ quote: { ...input().quote, expiresAt: Math.floor(Date.now() / 1000) + 80 } }) }), env)).json();
    assert.equal(created.intent.state, "AWAITING_USER_CONFIRMATION");
    assert.equal(instances.has("copy-user:42"), true);
    const view = await (await worker.fetch(api(`intents/${created.intent.intentId}`, { headers }), env)).json();
    const opened = await (await worker.fetch(post(`intents/${created.intent.intentId}/begin`, { token: view.intent.confirmationToken, revision: view.intent.revision }, headers), env)).json();
    assert.equal(opened.intent.review.label, "Lintcha — copy-trading");
    const replay = await worker.fetch(post(`intents/${created.intent.intentId}/begin`, { token: view.intent.confirmationToken, revision: view.intent.revision }, headers), env);
    assert.equal(replay.status, 409);
    const submitted = await (await worker.fetch(post(`intents/${created.intent.intentId}/submission`, { revision: opened.intent.revision, transactionHash: HASH }, headers), env)).json();
    assert.equal(submitted.intent.state, "SUBMITTED_PENDING_RECONCILIATION");
    const waits = [];
    await worker.scheduled({}, env, { waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    const final = await (await worker.fetch(api(`intents/${created.intent.intentId}`, { headers }), env)).json();
    assert.equal(final.intent.state, "CONFIRMED");
    const audit = (await env.COPY_DB.prepare("SELECT event_type, public_payload_json FROM copy_audit_log ORDER BY sequence").all()).results;
    assert.deepEqual(audit.map((row) => row.event_type), ["CONFIRM_EACH_INTENT_CREATED", "CLIENT_REPORTED_SUBMISSION", "RECONCILIATION_FINISHED"]);
    assert.equal(audit.some((row) => /SECRET-KEY|privateKey|seed/.test(row.public_payload_json)), false);
    assert.equal(seenUrls.every((url) => url.includes(".invalid/")), true);
    const outbox = (await env.COPY_DB.prepare("SELECT text FROM copy_outbox").all()).results;
    assert.equal(outbox.length, 1);
    assert.match(outbox[0].text, /^Lintcha — copy-trading/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Durable Object serializes concurrent operations for one user", async () => {
  const keys = await telegramKeys();
  const { env } = fakeEnv(keys);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    await worker.fetch(signed("admin/kill-switch", "lintcha.copy.admin.v1", { scope: "GLOBAL", action: "RESUME" }, ADMIN_SECRET), env);
    await env.COPY_DB.prepare("INSERT INTO copy_users (telegram_user_id, private_chat_id, mode, paused, created_at, updated_at) VALUES ('42', '99', 'CONFIRM_EACH', 0, 1, 1)").run();
    await env.COPY_DB.prepare("INSERT INTO copy_wallets (telegram_user_id, public_address, wallet_kind, created_at) VALUES ('42', ?, 'EXTERNAL', 1)").bind(WALLET).run();
    const quote = { ...input().quote, expiresAt: Math.floor(Date.now() / 1000) + 80 };
    const bursts = await Promise.all(Array.from({ length: 5 }, (_, index) => worker.fetch(signed("intents", "lintcha.copy.intent.v1", { userId: "42", ...input({ sourceTradeId: `burst-${index}`, quote: { ...quote, id: `q-${index}` } }) }), env).then((response) => response.json())));
    const accepted = bursts.filter((item) => item.ok);
    const capped = bursts.filter((item) => item.why === "DAILY_SPEND_CAP_EXCEEDED");
    assert.equal(accepted.length, 3);
    assert.equal(capped.length, 2);
    const reserved = (await env.COPY_DB.prepare("SELECT COUNT(*) AS n FROM copy_daily_spend_reservations WHERE state = 'RESERVED'").first()).n;
    assert.equal(reserved, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});
