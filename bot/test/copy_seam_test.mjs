// The Lintcha Copy seam. Everything Core promises about it: disabled means silence and no Core change, a
// group `/copy` gets the fixed private-only line, an enabled seam forwards a signed minimal envelope and
// nothing more, a Copy failure never throws into the webhook, Core commands are byte-for-byte untouched.
import { handleUpdate, KNOWN_COMMANDS, COPY_COMMANDS } from "../src/router.js";
import { telegramCommandClaimOf } from "../src/index.js";
import { copyConfigOf, copyActionsFor, drainCopyOutboxFor } from "../src/copy.js";
import { GATEWAY_TEXTS } from "../src/copy-gateway.js";
import * as T from "../src/texts.js";
import { harness, fakeKV } from "./fakes.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const t = harness("copy_seam");
const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = "https://copy.example.invalid";
const SECRET = "s".repeat(40);
const privateCopy = (text = "/copy", from = 7) => ({ update_id: 5, message: { chat: { id: 100, type: "private" }, from: { id: from, language_code: "ru" }, text } });
const groupCopy = { update_id: 6, message: { chat: { id: -100, type: "supergroup" }, from: { id: 7 }, text: "/copy@lintchabot" } };
const callback = (data) => ({ update_id: 7, callback_query: { id: "4242", data, from: { id: 7 }, message: { chat: { id: 100, type: "private" } } } });
const textOf = (actions) => actions.map(a => a.text).join("\n");

// The vendored gateway is the Copy repository's file, unchanged. (Checked again by the Copy repository's own test.)
t.ok(fs.readFileSync(path.join(here, "..", "src", "copy-gateway.js"), "utf8").includes("export async function routeCopyUpdate"), "the vendored gateway exports the router");
t.ok(!/from "node:/.test(fs.readFileSync(path.join(here, "..", "src", "copy-gateway.js"), "utf8")) && !/from "node:/.test(fs.readFileSync(path.join(here, "..", "src", "copy.js"), "utf8")), "neither seam module imports a node builtin");

// Disabled: no config, silence, and nothing Core does changes.
t.ok(copyConfigOf({}) === null && copyConfigOf({ COPY_GATEWAY_SECRET: SECRET }) === null && copyConfigOf({ COPY_GATEWAY_SECRET: SECRET, COPY_APP_ORIGIN: ORIGIN }) === null, "a half-configured seam is a disabled seam");
t.ok(copyConfigOf({ COPY_GATEWAY_SECRET: "short", COPY_APP_ORIGIN: ORIGIN, COPY_SERVICE_URL: ORIGIN }) === null, "a short secret disables the seam");
t.ok(copyConfigOf({ COPY_GATEWAY_SECRET: SECRET, COPY_APP_ORIGIN: "http://copy.example.invalid", COPY_SERVICE_URL: ORIGIN }) === null, "a non-https origin disables the seam");
t.ok(copyConfigOf({ COPY_GATEWAY_SECRET: SECRET, COPY_APP_ORIGIN: ORIGIN, COPY_SERVICE_URL: ORIGIN }) !== null, "secret plus origin plus URL enables the seam");
t.ok(copyConfigOf({ COPY_GATEWAY_SECRET: SECRET, COPY_APP_ORIGIN: ORIGIN, COPY_SERVICE: { fetch() {} } }).service !== null, "a service binding is preferred over a URL");
const silent = await handleUpdate(privateCopy(), { env: {}, kv: fakeKV() });
t.ok(Array.isArray(silent) && silent.length === 0, "disabled: /copy in private is silence");
t.ok((await handleUpdate(callback("copy.pause"), { env: {}, kv: fakeKV() })).length === 0, "disabled: a Copy callback is silence");
t.ok((await handleUpdate({ update_id: 8, callback_query: { id: "1", data: "anything", from: { id: 7 }, message: { chat: { id: 100, type: "private" } } } }, { env: {}, kv: fakeKV() })).length === 0, "a foreign callback query is silence, enabled or not");
t.ok(!KNOWN_COMMANDS.includes("copy") && COPY_COMMANDS.length === 1, "copy is not a Core command; it is claimed only while the seam is configured");
t.ok(textOf(await handleUpdate(privateCopy("/start"), { env: {}, kv: fakeKV() })).includes("Lintcha Core"), "/start still answers as Core");
{
  const fallback = await handleUpdate(privateCopy("/start copy_site"), { env: {}, kv: fakeKV() });
  t.ok(fallback.length === 1 && /copy-trading/.test(JSON.stringify(fallback[0])), "disabled: the site deep link gets Core's /start answer instead of silence");
}

// Claims: a Copy callback is metered to its presser; a foreign callback is not known.
const claim = telegramCommandClaimOf(callback("copy.pause"), "lintchabot", { copy: true });
t.ok(claim.known === true && claim.owner === "7" && claim.metered === true, "enabled: a Copy callback is a known, metered action of its presser");
t.ok(telegramCommandClaimOf(callback("copy.pause"), "lintchabot").known === false && telegramCommandClaimOf(privateCopy(), "lintchabot").known === false, "disabled: /copy and Copy callbacks are not even claimed, exactly like unknown traffic");
t.ok(telegramCommandClaimOf({ update_id: 9, callback_query: { id: "1", data: "core.x", from: { id: 7 } } }, "lintchabot", { copy: true }).known === false, "a foreign callback is not known");
t.ok(telegramCommandClaimOf(privateCopy(), "lintchabot", { copy: true }).known === true && telegramCommandClaimOf(privateCopy("/start"), "lintchabot", { copy: true }).known === true, "enabled: /copy is claimed and Core commands stay claimed");

// Enabled with a fake Copy service: a signed minimal envelope goes out, a validated reply comes back.
const received = [];
const env = { BOT_USERNAME: "lintchabot", COPY_GATEWAY_SECRET: SECRET, COPY_APP_ORIGIN: ORIGIN, COPY_SERVICE: { async fetch(request) {
  const body = await request.json();
  received.push({ url: request.url, body });
  if (request.url.endsWith("/gateway/outbox")) return Response.json({ ok: true, rows: [{ id: "1", privateChatId: "100", response: { text: "Lintcha — copy-trading\nA source BUY matched", inlineKeyboard: [[{ text: "Review", webAppUrl: ORIGIN + "/copy/?intent=" + "a".repeat(64) }]] } }] });
  return Response.json({ ok: true, response: { text: "Lintcha — copy-trading\nhello & <b>", inlineKeyboard: [[{ text: "Open", webAppUrl: ORIGIN + "/copy/" }], [{ text: "Pause", callbackData: "copy.pause" }]] } });
} } };
const enabled = await handleUpdate(privateCopy("/copy these words never leave"), { env, kv: fakeKV() });
t.ok(enabled.length === 1 && enabled[0].kind === "send" && enabled[0].chat === 100, "enabled: one send action to the private chat");
t.ok(enabled[0].escape === true && enabled[0].text.startsWith("Lintcha — copy-trading"), "the reply is marked for escaping and names the mode first");
t.ok(enabled[0].reply_markup.inline_keyboard[0][0].web_app.url === ORIGIN + "/copy/" && enabled[0].reply_markup.inline_keyboard[1][0].callback_data === "copy.pause", "buttons are the exact Copy origin and a namespaced callback");
t.ok(received.length === 1 && received[0].url === ORIGIN + "/api/copy/gateway", "the seam posted to the gateway route of the bound service");
const envelope = JSON.parse(received[0].body.body);
t.ok(envelope.schema === "lintcha.copy.gateway.v1" && envelope.telegramUserId === "7" && envelope.privateChatId === "100" && envelope.route === "COPY_COMMAND", "the envelope carries identity and route");
t.ok(!JSON.stringify(received[0].body).includes("never leave") && !("update" in received[0].body) && /^[0-9a-f]{64}$/.test(received[0].body.signature), "the envelope carries no message text or raw update, and is signed");
t.ok(!JSON.stringify(received[0].body).toLowerCase().includes("token"), "no token-shaped field crosses the seam");
const attributed = await handleUpdate(privateCopy("/start copy_site"), { env, kv: fakeKV() });
t.ok(attributed.length === 1 && JSON.parse(received[1].body.body).referralSource === "SITE" && !JSON.stringify(received[1].body.body).includes("copy_site"), "the site deep link enters Copy with only the bounded SITE attribution");
const pressed = await handleUpdate(callback("copy.pause"), { env, kv: fakeKV() });
t.ok(pressed.length === 2 && pressed[0].kind === "answer-callback" && pressed[0].callbackQueryId === "4242" && pressed[1].kind === "send", "a callback is answered and then replied to");
t.ok(JSON.parse(received[2].body.body).callbackData === "copy.pause", "the callback payload is forwarded by namespace");
const grouped = await handleUpdate(groupCopy, { env, kv: fakeKV() });
t.ok(grouped.length === 1 && grouped[0].text === GATEWAY_TEXTS.PRIVATE_ONLY && received.length === 3, "a group /copy gets the fixed private-only line without a Copy call");

// Copy failure: a fixed line, no throw, Core unaffected.
const broken = { ...env, COPY_SERVICE: { async fetch() { throw new Error("ECONNRESET"); } } };
const down = await handleUpdate(privateCopy(), { env: broken, kv: fakeKV() });
t.ok(down.length === 1 && down[0].text === GATEWAY_TEXTS.UNAVAILABLE, "a Copy outage answers with the fixed unavailable line");
const refusing = { ...env, COPY_SERVICE: { async fetch() { return Response.json({ ok: false, why: "INVALID_GATEWAY_SIGNATURE" }); } } };
t.ok((await handleUpdate(privateCopy(), { env: refusing, kv: fakeKV() }))[0].text === GATEWAY_TEXTS.UNAVAILABLE, "a Copy refusal is also the fixed line, never a raw error");
const foreignButtons = { ...env, COPY_SERVICE: { async fetch() { return Response.json({ ok: true, response: { text: "x", inlineKeyboard: [[{ text: "evil", webAppUrl: "https://evil.example/copy/" }]] } }); } } };
t.ok((await handleUpdate(privateCopy(), { env: foreignButtons, kv: fakeKV() }))[0].text === GATEWAY_TEXTS.UNAVAILABLE, "a reply pointing off-origin is refused and replaced by the fixed line");
const smuggledButton = { ...env, COPY_SERVICE: { async fetch() { return Response.json({ ok: true, response: { text: "x", inlineKeyboard: [[{ text: "Pause", callbackData: "copy.pause", url: "https://evil.example" }]] } }); } } };
t.ok((await handleUpdate(privateCopy(), { env: smuggledButton, kv: fakeKV() }))[0].text === GATEWAY_TEXTS.UNAVAILABLE, "extra Bot API button fields are refused before the durable boundary");
t.ok(textOf(await handleUpdate(privateCopy("/start"), { env: broken, kv: fakeKV() })).includes("Lintcha Core"), "Core commands answer normally while Copy is down");

// Outbox drain: Core delivers what Copy queued, with the same validation, and acknowledges only accepted sends.
const sent = [];
const drained = await drainCopyOutboxFor(env, async (row) => { sent.push(row); return "accepted"; });
t.ok(drained.sent === 1 && sent[0].chatId === "100" && sent[0].response.reply_markup.inline_keyboard[0][0].web_app.url.startsWith(ORIGIN + "/copy/?intent="), "the queued review line is delivered to the private chat with its Copy-origin button");
t.ok(received.filter(r => r.url.endsWith("/gateway/outbox")).length === 2 && JSON.parse(received.at(-1).body.body).ack[0] === "1", "the accepted row is acknowledged in a second signed call");
t.ok((await drainCopyOutboxFor({}, async () => "accepted")).reason === "COPY_DISABLED", "disabled Copy drains nothing");

// The Core never lines are untouched by the seam.
t.ok(Array.isArray(T.NEVER) && T.NEVER.length >= 6, "the never lines still exist");
t.done();
