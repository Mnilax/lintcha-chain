// The webhook. Specification section six: an update without the right header gets four hundred and one and
// nothing in the body. Also the two routes that exist, and the one thing every other path gets.
//
//   node test/webhook_test.mjs
import worker, { sameSecret, Tape } from "../src/index.js";
import { forgetToken } from "../src/chain.js";
import { harness, fakeKV, fakeNetwork, STAND_BOT_TOKEN, STAND_WEBHOOK_SECRET, FIXTURE } from "./fakes.mjs";

const t = harness("webhook");
const net = fakeNetwork();

const waited = [];
const ctx = { waitUntil: p => waited.push(p) };
const env = () => ({
  TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: STAND_WEBHOOK_SECRET,
  SESSIONS: fakeKV()
});

const post = (path, body, headers = {}) => new Request("https://chain.lintcha.com" + path, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body)
});

const update = { message: { chat: { id: 1, type: "private" }, from: { id: 1 }, text: "/start" } };

// ---------------------------------------------------------------- the comparison itself
t.ok(sameSecret("abc", "abc") === true, "equal strings match");
t.ok(sameSecret("abc", "abd") === false, "one byte off does not match");
t.ok(sameSecret("abc", "abcd") === false, "a different length does not match");
t.ok(sameSecret("", "") === false, "two empty strings do not match");
t.ok(sameSecret(null, "abc") === false, "a missing header does not match");
t.ok(sameSecret("abc", undefined) === false, "a missing secret does not match");

// ---------------------------------------------------------------- no header, wrong header, right header
let r = await worker.fetch(post("/api/telegram", update), env(), ctx);
t.ok(r.status === 401, "no header at all is four hundred and one");
t.ok((await r.text()) === "", "and the body is empty");

r = await worker.fetch(post("/api/telegram", update, { "X-Telegram-Bot-Api-Secret-Token": "not-it" }), env(), ctx);
t.ok(r.status === 401, "a wrong header is four hundred and one");
t.ok((await r.text()) === "", "and that body is empty too");

r = await worker.fetch(post("/api/telegram", update, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET + "x" }), env(), ctx);
t.ok(r.status === 401, "a header with the secret as a prefix is still refused");

forgetToken();
net.site = { address: null, pons: null, uniswap: null };
waited.length = 0;
r = await worker.fetch(post("/api/telegram", update, { "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET }), env(), ctx);
t.ok(r.status === 200, "the right header is two hundred");
t.ok(waited.length === 1, "and the answering is left to run after the response");
await Promise.all(waited);
t.ok(net.sent.length === 1, "one message went out");
t.ok(String(net.sent[0].text).startsWith("lintcha reads what a launch"), "and it is the /start text");

// ---------------------------------------------------------------- the method and the other paths
r = await worker.fetch(new Request("https://chain.lintcha.com/api/telegram", { method: "GET" }), env(), ctx);
t.ok(r.status === 405, "a GET on the webhook is refused by method");

r = await worker.fetch(new Request("https://chain.lintcha.com/api/anything", { method: "GET" }), env(), ctx);
t.ok(r.status === 404, "an unknown path under the api is four hundred and four");
t.ok((await r.text()) === "", "with nothing in the body");

r = await worker.fetch(new Request("https://chain.lintcha.com/", { method: "GET" }), env(), ctx);
t.ok(r.status === 404, "the root is not this worker's business");

// a body that is not json, with the right header
r = await worker.fetch(new Request("https://chain.lintcha.com/api/telegram", {
  method: "POST",
  headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": STAND_WEBHOOK_SECRET },
  body: "not json at all"
}), env(), ctx);
t.ok(r.status === 400, "a body that will not parse is four hundred");

// ---------------------------------------------------------------- /api/hold
forgetToken();
net.site = { address: null, pons: null, uniswap: null };
r = await worker.fetch(post("/api/hold", { t: "aaaaaaaaaaaaaaaa", address: FIXTURE.address, signature: FIXTURE.signature }), env(), ctx);
let body = await r.json();
t.ok(r.status === 400 && body.ok === false && body.why === "nonce", "a mark that was never issued is refused by the hold route");

r = await worker.fetch(new Request("https://chain.lintcha.com/api/hold", { method: "GET" }), env(), ctx);
t.ok(r.status === 405, "a GET on the hold route is refused by method");

r = await worker.fetch(new Request("https://chain.lintcha.com/api/hold", {
  method: "POST", headers: { "content-type": "application/json" }, body: "{"
}), env(), ctx);
t.ok(r.status === 400, "a hold body that will not parse is four hundred");

const noKv = { TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: STAND_WEBHOOK_SECRET };
r = await worker.fetch(post("/api/hold", { t: "aaaaaaaaaaaaaaaa", address: FIXTURE.address, signature: FIXTURE.signature }), noKv, ctx);
t.ok(r.status === 503, "with no store bound the hold route says so rather than pretending");

// ---------------------------------------------------------------- the durable object is exported for the migration
t.ok(typeof Tape === "function", "the worker exports the Tape class, which the migration names");
t.ok(typeof worker.scheduled === "function", "and it has a scheduled handler for the cron");

// the cron with no binding must not throw
await worker.scheduled({}, { }, ctx);
t.ok(true, "the cron with no feed binding does nothing and does not throw");

t.done();
