import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_TELEGRAM_UPDATE_BYTES,
  TelegramBotTransport,
  normalizeTelegramUpdate,
  parseTelegramWebhookBody,
  telegramSendMessagePayload,
  verifyTelegramWebhookSecret,
} from "../src/telegram/transport.mjs";

test("CP9: webhook secret verification is strict and constant-time compatible", () => {
  const expected = "fixture-secret-at-least-16";
  assert.equal(verifyTelegramWebhookSecret(expected, expected), true);
  assert.equal(verifyTelegramWebhookSecret("wrong", expected), false);
  assert.equal(verifyTelegramWebhookSecret(undefined, expected), false);
  assert.equal(verifyTelegramWebhookSecret(expected, "short"), false);
});

test("CP9: webhook parser rejects empty, oversized, and malformed input", () => {
  assert.throws(() => parseTelegramWebhookBody(""), /size/);
  assert.throws(() => parseTelegramWebhookBody("{"), /JSON/);
  assert.throws(() => parseTelegramWebhookBody("x".repeat(MAX_TELEGRAM_UPDATE_BYTES + 1)), /size/);
  assert.deepEqual(parseTelegramWebhookBody('{"update_id":1}'), { update_id: 1 });
});

test("CP9: private bot command is normalized and foreign bot command is ignored", () => {
  const base = { update_id: 11, message: { chat: { id: 22, type: "private" }, from: { id: 33 } } };
  assert.equal(normalizeTelegramUpdate({ ...base, message: { ...base.message, text: "/COPY@LintchaCopyBot now" } }, { botUsername: "lintchacopybot" }).command, "/copy");
  assert.equal(normalizeTelegramUpdate({ ...base, message: { ...base.message, text: "/copy@OtherBot" } }, { botUsername: "lintchacopybot" }).command, "");
});

test("CP9: callback update preserves private boundary fields", () => {
  const result = normalizeTelegramUpdate({ update_id: 12, callback_query: { id: "cb", data: "copy.rules", from: { id: 33 }, message: { chat: { id: 22, type: "private" } } } });
  assert.deepEqual(result, { kind: "callback", updateId: "12", callbackQueryId: "cb", chatId: "22", chatType: "private", userId: "33", callbackData: "copy.rules" });
});

test("CP9: outgoing payload contains no URL and preserves inline controls", () => {
  const payload = telegramSendMessagePayload("22", { text: "Notify only", reply_markup: { inline_keyboard: [[{ text: "Rules", callback_data: "copy.rules" }]] } });
  assert.equal(payload.chat_id, "22");
  assert.doesNotMatch(JSON.stringify(payload), /https?:\/\//i);
  assert.equal(payload.reply_markup.inline_keyboard[0][0].callback_data, "copy.rules");
});

test("CP9: transport is disabled by default and performs no network request", async () => {
  let calls = 0;
  const transport = new TelegramBotTransport({ token: "123456:abcdefghijklmnopqrstuvwxyz", fetchImpl: async () => { calls += 1; } });
  await assert.rejects(transport.sendMessage("22", { text: "test" }), /DISABLED/);
  assert.equal(calls, 0);
});

test("CP9: enabled transport sends one bounded JSON request without leaking token in result", async () => {
  let request;
  const transport = new TelegramBotTransport({
    enabled: true,
    token: "123456:abcdefghijklmnopqrstuvwxyz",
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true }; },
  });
  const result = await transport.sendMessage("22", { text: "signal" });
  assert.deepEqual(result, { delivered: true });
  assert.match(request.url, /\/sendMessage$/);
  assert.deepEqual(JSON.parse(request.options.body), { chat_id: "22", text: "signal" });
  assert.doesNotMatch(JSON.stringify(result), /123456|abcdefghijklmnopqrstuvwxyz/);
});
