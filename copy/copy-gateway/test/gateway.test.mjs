import test from "node:test";
import assert from "node:assert/strict";
import { GATEWAY_TEXTS, copyRoute, routeCopyUpdate, sanitizedCopyEnvelope, validateCopyResponse } from "../src/gateway.mjs";

const ORIGIN = "https://copy.example";
const SECRET = "x".repeat(32);
const privateUpdate = (text = "/copy") => ({ update_id: 10, message: { text, chat: { id: 99, type: "private" }, from: { id: 42, language_code: "ru" } } });

test("gateway leaves every Core command untouched", () => {
  assert.equal(copyRoute({ message: { text: "/contract" } }), null);
  assert.equal(copyRoute({ message: { text: "/holders" } }), null);
  assert.equal(copyRoute({ message: { text: "/copy@otherbot" } }), null);
  assert.equal(copyRoute({ message: { text: "/copy@LintchaBot" } }), "COPY_COMMAND");
  assert.equal(copyRoute({ message: { text: "/start copy_site" } }), "COPY_COMMAND");
  assert.equal(copyRoute({ message: { text: "/start@LintchaBot copy_site" } }), "COPY_COMMAND");
  assert.equal(copyRoute({ message: { text: "/start copy_other" } }), null);
  assert.equal(copyRoute({ message: { text: "/copycat" } }), null);
  assert.equal(copyRoute({ callback_query: { data: "core.forget" } }), null);
});

test("site deep link carries only a bounded attribution source", () => {
  const envelope = sanitizedCopyEnvelope(privateUpdate("/start copy_site"), 100);
  assert.equal(envelope.route, "COPY_COMMAND");
  assert.equal(envelope.referralSource, "SITE");
  assert.equal(JSON.stringify(envelope).includes("copy_site"), false);
});

test("gateway forwards only minimal Copy identity, not raw text or bot token", async () => {
  const update = privateUpdate("/copy secret words must not be forwarded");
  const envelope = sanitizedCopyEnvelope(update, 100);
  assert.equal(envelope.route, "COPY_COMMAND");
  assert.equal(JSON.stringify(envelope).includes("secret words"), false);
  let received;
  const result = await routeCopyUpdate({ update, nowSeconds: 100, serviceSecret: SECRET, copyAppOrigin: ORIGIN, copyClient: { async handle(payload) { received = payload; return { text: "Lintcha — copy-trading", inlineKeyboard: [[{ text: "Open secure sheet", webAppUrl: `${ORIGIN}/copy/confirm` }]] }; } } });
  assert.equal(result.handled, true);
  assert.equal(result.chatId, 99);
  assert.equal(JSON.stringify(received).includes("token"), false);
  assert.equal(result.response.reply_markup.inline_keyboard[0][0].web_app.url, `${ORIGIN}/copy/confirm`);
});

test("Copy callbacks require namespace; a group message gets the fixed private-only answer instead of an error", async () => {
  const update = { update_id: 11, callback_query: { data: "copy.pause", from: { id: 42 }, message: { chat: { id: 99, type: "private" } } } };
  assert.equal(sanitizedCopyEnvelope(update, 100).callbackData, "copy.pause");
  const group = { ...update, callback_query: { ...update.callback_query, message: { chat: { id: -5, type: "group" } } } };
  assert.equal(sanitizedCopyEnvelope(group, 100).privateRequired, true);
  const result = await routeCopyUpdate({ update: group, nowSeconds: 100, serviceSecret: SECRET, copyAppOrigin: ORIGIN, copyClient: { async handle() { throw new Error("must not be called"); } } });
  assert.equal(result.response.text, GATEWAY_TEXTS.PRIVATE_ONLY);
  assert.throws(() => sanitizedCopyEnvelope({ update_id: 12, message: { text: "/copy", chat: { id: 1, type: "private" } } }, 100), /IDENTITY/);
});

test("gateway rejects arbitrary Telegram controls and foreign Mini App origins", () => {
  assert.throws(() => validateCopyResponse({ text: "x", inlineKeyboard: [[{ text: "bad", callbackData: "core.delete" }]] }, ORIGIN), /NAMESPACE/);
  assert.throws(() => validateCopyResponse({ text: "x", inlineKeyboard: [[{ text: "bad", webAppUrl: "https://evil.example/copy/" }]] }, ORIGIN), /ORIGIN/);
  assert.throws(() => validateCopyResponse({ text: "x", inlineKeyboard: [[{ text: "bad", webAppUrl: `${ORIGIN}/app/` }]] }, ORIGIN), /ORIGIN/);
  assert.throws(() => validateCopyResponse({ text: "x", inlineKeyboard: [[{ text: "bad", url: "https://evil.example" }]] }, ORIGIN), /INVALID_COPY_RESPONSE/);
  assert.throws(() => validateCopyResponse({ text: "x", inlineKeyboard: [[]] }, ORIGIN), /INVALID_COPY_RESPONSE/);
  assert.throws(() => validateCopyResponse({ text: "x", inlineKeyboard: [[{ text: "bad", callbackData: `copy.${"a".repeat(60)}` }]] }, ORIGIN), /NAMESPACE/);
  assert.throws(() => validateCopyResponse({ text: "x", inlineKeyboard: [[{ text: "bad", callbackData: "copy.pause", url: "https://evil.example" }]] }, ORIGIN), /INVALID_COPY_RESPONSE/);
  assert.throws(() => validateCopyResponse({ text: "x", inlineKeyboard: [[{ text: "<>", callbackData: "copy.pause" }]] }, ORIGIN), /INVALID_COPY_RESPONSE/);
  assert.throws(() => validateCopyResponse({ text: "x", inlineKeyboard: [[{ text: "bad", webAppUrl: `${ORIGIN}/copy/#fragment` }]] }, ORIGIN), /ORIGIN/);
  assert.throws(() => validateCopyResponse({ text: "" }, ORIGIN), /INVALID_COPY_RESPONSE/);
});

test("Copy service failure or timeout never escapes into the Core webhook", async () => {
  const failures = [];
  const down = await routeCopyUpdate({ update: privateUpdate(), nowSeconds: 100, serviceSecret: SECRET, copyAppOrigin: ORIGIN, onFailure: (item) => failures.push(item), copyClient: { async handle() { throw new Error("ECONNREFUSED"); } } });
  assert.equal(down.handled, true);
  assert.equal(down.response.text, GATEWAY_TEXTS.UNAVAILABLE);
  assert.deepEqual(failures, [{ reason: "ECONNREFUSED", updateId: "10" }]);
  const slow = await routeCopyUpdate({ update: privateUpdate(), nowSeconds: 100, serviceSecret: SECRET, copyAppOrigin: ORIGIN, timeoutMs: 5, copyClient: { handle: () => new Promise(() => {}) } });
  assert.equal(slow.response.text, GATEWAY_TEXTS.UNAVAILABLE);
  const malformed = await routeCopyUpdate({ update: privateUpdate(), nowSeconds: 100, serviceSecret: SECRET, copyAppOrigin: ORIGIN, copyClient: { async handle() { return { text: "x", inlineKeyboard: [[{ text: "bad", callbackData: "core.forget" }]] }; } } });
  assert.equal(malformed.response.text, GATEWAY_TEXTS.UNAVAILABLE);
  const disabled = await routeCopyUpdate({ update: privateUpdate(), nowSeconds: 100, serviceSecret: null, copyAppOrigin: ORIGIN, copyClient: null });
  assert.equal(disabled.response.text, GATEWAY_TEXTS.DISABLED);
});
