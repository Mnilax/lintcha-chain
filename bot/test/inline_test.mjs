// Telegram inline mode as a bounded share surface. This file keeps query text out of replies, proves the
// three published token states remain distinct, and checks the exact Bot API body without a real token or
// network request.
//
//   node test/inline_test.mjs
import { inlineActionFor, inlineKindsFor, inlineQueryOf } from "../src/inline.js";
import {
  answerInlineQueryResult,
  inlineActionOf,
  TELEGRAM_INLINE_RESULT_LIMIT,
  TELEGRAM_TEXT_LIMIT
} from "../src/telegram.js";
import { handleUpdate } from "../src/router.js";
import { forgetToken } from "../src/chain.js";
import { telegramCommandClaimOf } from "../src/index.js";
import { Watch } from "../src/watch.js";
import * as T from "../src/texts.js";
import { fakeWatchCtx, harness, STAND_BOT_TOKEN, TOKEN_ADDRESS } from "./fakes.mjs";

const t = harness("inline");
const copy = value => JSON.parse(JSON.stringify(value));
const rawInline = (query = "", extra = {}) => ({
  inline_query: { id: "inline-query-one", from: { id: 7001 }, query, offset: "", ...extra }
});

// ---------------------------------------------------------------- query boundary and filtering
const parsed = inlineQueryOf(rawInline("  ＬＩＶＥ  "));
t.ok(parsed && parsed.id === "inline-query-one" && parsed.owner === "7001" && parsed.query === "live",
  "a valid query is reduced to its id, string owner and normalized lower-case search text");
t.ok(inlineQueryOf(null) === null && inlineQueryOf({ inline_query: [] }) === null,
  "a missing or non-object inline query is refused");
t.ok(inlineQueryOf(rawInline("", { id: "" })) === null &&
  inlineQueryOf(rawInline("", { from: { id: 0 } })) === null &&
  inlineQueryOf(rawInline("x".repeat(257))) === null &&
  inlineQueryOf(rawInline("", { offset: "x".repeat(65) })) === null,
  "empty ids, unsafe senders, oversized query text and oversized offsets are refused");

const allKinds = ["app", "read", "live", "deployer", "run", "token"];
t.ok(JSON.stringify(inlineKindsFor("")) === JSON.stringify(allKinds) &&
  JSON.stringify(inlineKindsFor("lintcha")) === JSON.stringify(allKinds),
  "an empty query or the product name exposes the whole small palette");
t.ok(JSON.stringify(inlineKindsFor("liv")) === JSON.stringify(["live"]) &&
  JSON.stringify(inlineKindsFor("wallet")) === JSON.stringify(["deployer"]) &&
  JSON.stringify(inlineKindsFor("tick")) === JSON.stringify(["live"]) &&
  JSON.stringify(inlineKindsFor("$lintcha")) === JSON.stringify(["token"]),
  "English typed prefixes and the token spelling select only their fixed cards");
t.ok(inlineKindsFor("private words nobody reflects").length === 0,
  "unknown query words produce no article instead of being reflected into a result");

const classified = telegramCommandClaimOf({ update_id: 7001, ...rawInline("live") });
t.ok(JSON.stringify(classified) === JSON.stringify({
  known: true,
  owner: "7001",
  meteredOwner: "inline:7001",
  metered: true,
  inline: true
}), "a valid inline update is runnable and uses a rate bucket separate from slash commands");
t.ok(telegramCommandClaimOf({ update_id: 7002, ...rawInline("live", { from: undefined }) }).known === false,
  "a malformed inline update is deduped as non-runnable instead of bypassing attribution");

// ---------------------------------------------------------------- fixed actions and the three token states
const query = { id: "inline-query-two", owner: "7001", query: "token" };
const dormant = inlineActionFor(query, { ok: true, address: null, pons: null, uniswap: null });
const unreadable = inlineActionFor(query, { ok: false });
const active = inlineActionFor(query, {
  ok: true,
  address: TOKEN_ADDRESS,
  pons: "https://example.invalid/chart",
  uniswap: null
});
t.ok(dormant && dormant.kind === "answer-inline" && dormant.cacheTime === 0 && dormant.results.length === 1 &&
  /not published/i.test(dormant.results[0].title) && dormant.results[0].text.includes(T.NO_TOKEN_YET) &&
  !dormant.results[0].text.includes("0x"),
  "dormant status says no token is published and carries no placeholder address");
t.ok(unreadable && unreadable.cacheTime === 0 && unreadable.results.length === 1 &&
  /unavailable/i.test(unreadable.results[0].title) && unreadable.results[0].text.includes(T.SITE_UNREADABLE) &&
  unreadable.results[0].text !== dormant.results[0].text,
  "an unreadable token document stays distinct from a dormant token");
t.ok(active && active.cacheTime === 0 && active.results.length === 1 &&
  active.results[0].text.includes("<code>" + TOKEN_ADDRESS + "</code>") &&
  !active.results[0].text.includes("example.invalid"),
  "active status shares only the address read from the public token document, not an unrelated chart URL");

const full = inlineActionFor({ ...query, query: "" }, { ok: true, address: null, pons: null, uniswap: null });
const readOnly = inlineActionFor({ ...query, query: "read" }, dormant);
const noMatch = inlineActionFor({ ...query, query: "no-such-card" }, dormant);
t.ok(full.results.map(result => result.id).join(",") === "app-v1,read-v1,live-v1,deployer-v1,run-v1,token-v1" &&
  full.buttonText === "Open Lintcha Mini App" && full.buttonWebAppUrl === T.MINI_APP,
  "the full palette has stable unique result ids and one Mini App top button");
t.ok(readOnly.cacheTime === 300 && readOnly.results.length === 1 && readOnly.results[0].id === "read-v1" &&
  noMatch.cacheTime === 60 && noMatch.results.length === 0,
  "fixed non-token cards may cache briefly while an unknown filter returns only the Mini App button");
t.ok(inlineActionFor(null, dormant) === null,
  "an invalid reduced query cannot create a durable action");

// ---------------------------------------------------------------- exact durable-action schema
const canonical = inlineActionOf(active);
t.ok(canonical && canonical.kind === "answer-inline" && canonical.results[0].id === "token-v1",
  "the generated active action crosses the strict durable boundary");

const extraActionField = { ...copy(active), rawTelegram: { parse_mode: "MarkdownV2" } };
const extraResultField = copy(active);
extraResultField.results[0].rawTelegram = true;
const duplicateIds = copy(full);
duplicateIds.results[1].id = duplicateIds.results[0].id;
const unsafeResultUrl = copy(active);
unsafeResultUrl.results[0].openUrl = "javascript:alert(1)";
const unsafeAppUrl = copy(active);
unsafeAppUrl.buttonWebAppUrl = "http://lintcha.com/app/";
const oversizedText = copy(active);
oversizedText.results[0].text = "x".repeat(TELEGRAM_TEXT_LIMIT + 1);
const tooMany = copy(active);
tooMany.results = Array.from({ length: TELEGRAM_INLINE_RESULT_LIMIT + 1 }, (_, index) => ({
  ...copy(active.results[0]),
  id: "token-" + index
}));
t.ok(inlineActionOf(extraActionField) === null && inlineActionOf(extraResultField) === null,
  "unknown action and result fields cannot smuggle raw Bot API options through the durable record");
t.ok(inlineActionOf(duplicateIds) === null && inlineActionOf({ ...copy(active), cacheTime: 301 }) === null,
  "duplicate result ids and cache durations outside the authored bound are refused");
t.ok(inlineActionOf(unsafeResultUrl) === null && inlineActionOf(unsafeAppUrl) === null,
  "result links and the Mini App button both require canonical HTTPS destinations");
t.ok(inlineActionOf(oversizedText) === null && inlineActionOf(tooMany) === null,
  "Telegram text and result-count ceilings are enforced before transport");

const durableCtx = fakeWatchCtx();
const durableWatch = new Watch(durableCtx, {});
const durableNow = Date.parse("2026-09-13T00:00:00.000Z");
const inlineClaim = durableWatch.claimTelegramUpdate(7101, "inline:7001", durableNow, true, true);
const commandClaim = durableWatch.claimTelegramUpdate(7102, "7001", durableNow, true, true);
const durableStored = durableWatch.storeTelegramResponse(7101, [active]);
t.ok(inlineClaim.allowed === true && commandClaim.allowed === true && durableStored.ok === true &&
  durableStored.actions[0].kind === "answer-inline",
  "Watch durably stores the canonical inline answer and accepts the isolated inline bucket namespace");
t.ok(durableCtx.telegramCommandBuckets.has("inline:7001") && durableCtx.telegramCommandBuckets.has("7001") &&
  durableCtx.telegramCommandBuckets.size === 2,
  "typing inline does not consume the slash-command bucket for the same Telegram user");

// ---------------------------------------------------------------- exact answerInlineQuery wire body and delivery classification
const realFetch = globalThis.fetch;
let request = null;
globalThis.fetch = async (url, options) => {
  request = { url: String(url), options, body: JSON.parse(options.body) };
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
let accepted;
try {
  accepted = await answerInlineQueryResult({ TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN }, active);
} finally {
  globalThis.fetch = realFetch;
}
const wire = request && request.body;
const wireResult = wire && wire.results && wire.results[0];
t.ok(accepted === "accepted" && request && request.url.endsWith("/answerInlineQuery") &&
  request.options.method === "POST" && request.options.headers["content-type"] === "application/json",
  "a bounded Bot API acknowledgement accepts the inline answer over the dedicated method");
t.ok(wire && wire.inline_query_id === active.inlineQueryId && wire.cache_time === 0 && wire.is_personal === false &&
  wire.button.text === active.buttonText && wire.button.web_app.url === T.MINI_APP,
  "the wire body identifies the query, keeps token status personal-neutral and exposes the Mini App top button");
t.ok(wireResult && wireResult.type === "article" && wireResult.id === "token-v1" &&
  wireResult.input_message_content.message_text === active.results[0].text &&
  wireResult.input_message_content.parse_mode === "HTML" &&
  wireResult.input_message_content.link_preview_options.is_disabled === true &&
  wireResult.reply_markup.inline_keyboard[0][0].url === active.results[0].openUrl &&
  !Object.prototype.hasOwnProperty.call(wireResult.reply_markup.inline_keyboard[0][0], "web_app"),
  "each share card is an article with fixed HTML, disabled preview and a normal HTTPS button usable from any chat");

let calls = 0;
globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ ok: false, error_code: 400 }), { status: 400 }); };
let terminalHttp;
let terminalShape;
try {
  terminalHttp = await answerInlineQueryResult({ TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN }, active);
  terminalShape = await answerInlineQueryResult({ TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN }, extraActionField);
} finally {
  globalThis.fetch = realFetch;
}
t.ok(terminalHttp === "terminal" && terminalShape === "terminal" && calls === 1,
  "an explicit client refusal is terminal and a malformed action is rejected without any request");

const retryCases = [
  async () => new Response(JSON.stringify({ ok: false }), { status: 503 }),
  async () => new Response(JSON.stringify({ ok: false, error_code: 429 }), { status: 200 }),
  async () => { throw new Error("stand network loss"); }
];
const retryResults = [];
try {
  for (const stand of retryCases) {
    globalThis.fetch = stand;
    retryResults.push(await answerInlineQueryResult({ TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN }, active));
  }
} finally {
  globalThis.fetch = realFetch;
}
t.ok(retryResults.every(result => result === "retryable"),
  "server refusal, rate limiting and uncertain network loss remain retryable for the same query id");

// ---------------------------------------------------------------- router priority: inline text cannot become a private command
forgetToken();
const privateCalls = [];
const privateStore = {
  async get(...args) { privateCalls.push(["get", ...args]); return null; },
  async put(...args) { privateCalls.push(["put", ...args]); },
  async delete(...args) { privateCalls.push(["delete", ...args]); }
};
const privateWatch = new Proxy({}, {
  get(_target, property) {
    return async (...args) => { privateCalls.push([String(property), ...args]); return null; };
  }
});
globalThis.fetch = async () => new Response(JSON.stringify({
  address: null,
  pons: null,
  uniswap: null
}), { status: 200, headers: { "content-type": "application/json" } });
let routed;
try {
  routed = await handleUpdate({
    ...rawInline("token /forget /rule /verify"),
    message: { chat: { id: 7001, type: "private" }, from: { id: 7001 }, text: "/forget" }
  }, { env: {}, kv: privateStore, nonces: privateStore, watch: privateWatch, tape: privateWatch });
} finally {
  globalThis.fetch = realFetch;
  forgetToken();
}
t.ok(routed && routed.length === 1 && routed[0].kind === "answer-inline" &&
  routed[0].results.length === 1 && routed[0].results[0].id === "token-v1",
  "an inline update takes the share path even if a malformed combined update also carries a private command");
t.ok(privateCalls.length === 0 && !routed[0].results[0].text.includes("/forget /rule /verify"),
  "inline query words neither enter private storage/watch mutations nor appear in the shared message");

let staticReads = 0;
globalThis.fetch = async () => { staticReads++; throw new Error("static inline cards must not read a network source"); };
let staticRouted;
try {
  staticRouted = await handleUpdate(rawInline("source"), { env: {}, kv: privateStore, watch: privateWatch });
} finally {
  globalThis.fetch = realFetch;
  forgetToken();
}
t.ok(staticRouted.length === 1 && staticRouted[0].results[0].id === "run-v1" && staticReads === 0,
  "a static inline filter answers without reading token, chain, KV or watcher state on each typed query");

t.done();
