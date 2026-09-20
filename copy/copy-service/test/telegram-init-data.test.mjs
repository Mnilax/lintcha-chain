import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { TELEGRAM_THIRD_PARTY_PUBLIC_KEYS, TelegramInitDataVerifier, telegramDataCheckString } from "../src/telegram-init-data.mjs";

const subtle = webcrypto.subtle;
const BOT_ID = "7342037359";

async function keypair() {
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { pair, publicKeyHex: [...raw].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
}

async function signedInitData(pair, { botId = BOT_ID, authDate = 1_700_000_000, user = { id: 42, first_name: "V", language_code: "ru" }, startParam = "intent_abc" } = {}) {
  const params = new URLSearchParams();
  params.set("query_id", "AAHdF6IQAAAAAN0XohDhrOrc");
  params.set("user", JSON.stringify(user));
  params.set("auth_date", String(authDate));
  if (startParam) params.set("start_param", startParam);
  params.set("hash", "f".repeat(64));
  const message = new TextEncoder().encode(telegramDataCheckString([...params.entries()], botId));
  const signature = new Uint8Array(await subtle.sign({ name: "Ed25519" }, pair.privateKey, message));
  params.set("signature", Buffer.from(signature).toString("base64url"));
  return params.toString();
}

test("data-check string follows the third-party layout: bot id prefix, hash and signature excluded, sorted keys", () => {
  const pairs = [["signature", "s"], ["user", "{\"id\":1}"], ["hash", "h"], ["auth_date", "1"]];
  assert.equal(telegramDataCheckString(pairs, BOT_ID), `${BOT_ID}:WebAppData\nauth_date=1\nuser={"id":1}`);
  assert.match(TELEGRAM_THIRD_PARTY_PUBLIC_KEYS.production, /^[0-9a-f]{64}$/);
});

test("verifier accepts a valid Ed25519 signature and rejects tampering, wrong bot, stale data and bad shapes", async () => {
  const { pair, publicKeyHex } = await keypair();
  const verifier = new TelegramInitDataVerifier({ botId: BOT_ID, publicKeyHex, maxAgeSeconds: 600, subtle });
  const initData = await signedInitData(pair);
  const identity = await verifier.verify(initData, 1_700_000_100);
  assert.equal(identity.telegramUserId, "42");
  assert.equal(identity.startParam, "intent_abc");
  await assert.rejects(verifier.verify(initData.replace("%22id%22%3A42", "%22id%22%3A43"), 1_700_000_100), /INVALID_INIT_DATA_SIGNATURE/);
  await assert.rejects(verifier.verify(initData, 1_700_001_000), /STALE_INIT_DATA/);
  await assert.rejects(verifier.verify(await signedInitData(pair, { botId: "1" }), 1_700_000_100), /INVALID_INIT_DATA_SIGNATURE/);
  await assert.rejects(verifier.verify("user=%7B%7D", 1), /INVALID_INIT_DATA/);
  const other = await keypair();
  await assert.rejects(new TelegramInitDataVerifier({ botId: BOT_ID, publicKeyHex: other.publicKeyHex, subtle }).verify(initData, 1_700_000_100), /INVALID_INIT_DATA_SIGNATURE/);
  assert.throws(() => new TelegramInitDataVerifier({ botId: "", subtle }), /BOT_ID_REQUIRED/);
});
