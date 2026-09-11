// The three rule commands, from the message to the stored rule and back.
//
// The router and the watcher are both real here and only the network and the storage are fakes, because the
// two questions worth asking span both: does a stranger get a rule stored, and can one person's /unrule reach
// another person's rule. The first is refused in the router, where the session is read; the second is refused
// twice, once by the number the router resolves inside the sender's own list and once by the owner in the
// delete's where clause.
//
// This is a separate file from router_test.mjs rather than more of it. That file is round D1's and answers
// round D1's question — every command answers, an unknown one is silent — and it keeps doing that; this one
// is about rules.
//
//   node test/rules_router_test.mjs
import { handleUpdate, argsOf, PRIVATE_COMMANDS } from "../src/router.js";
import { Watch } from "../src/watch.js";
import { forgetToken } from "../src/chain.js";
import { putSession } from "../src/verify.js";
import { DEFAULT_RULES_PER_HOLDER, MAX_ARG } from "../src/rules.js";
import { perform, sendMessage, sendMessageResult, TELEGRAM_TEXT_LIMIT, TELEGRAM_RESPONSE_LIMIT, TELEGRAM_TIMEOUT_MS } from "../src/telegram.js";
import * as T from "../src/texts.js";
import { harness, fakeKV, fakeWatchCtx, fakePublished, OWNER_A, OWNER_B, TOKEN_ADDRESS, STAND_BOT_TOKEN } from "./fakes.mjs";

const t = harness("rules_router");

const HOLDER_A = "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";
const HOLDER_B = "0x1111111111111111111111111111111111111111";
const DEV_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const net = fakePublished({ token: { address: TOKEN_ADDRESS, pons: "https://example.invalid/pons", uniswap: null } });

const msg = (text, from = OWNER_A, type = "private") => ({ message: { chat: { id: Number(from), type }, from: { id: from }, text } });
const textOf = a => (a[0] && a[0].text) || "";

/** the same three calls index.js makes over a request boundary, made straight against the object */
const dep = w => ({
  list: owner => w.ruleCommand({ what: "list", owner: String(owner) }),
  add: (owner, kind, arg) => w.ruleCommand({ what: "add", owner: String(owner), kind, arg }),
  remove: (owner, number) => w.ruleCommand({ what: "remove", owner: String(owner), number }),
  forget: owner => w.ruleCommand({ what: "forget", owner: String(owner) })
});

const standing = async () => {
  forgetToken();
  const kv = fakeKV();
  const watch = new Watch(fakeWatchCtx(), { TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN });
  return { kv, watch, deps: { env: {}, kv, watch: dep(watch) } };
};
const say = (deps, text, from = OWNER_A, type = "private") => handleUpdate(msg(text, from, type), deps);

// ---------------------------------------------------------------- what followed the command
t.ok(argsOf("/rule string SOLANA") === "string SOLANA", "the argument is what came after the command");
t.ok(argsOf("/rule@lintcha_chain_bot string SOLANA") === "string SOLANA", "with the bot name stripped, as a room sends it");
t.ok(argsOf("/rule   string    SOLANA  ") === "string SOLANA", "and its whitespace collapsed");
t.ok(argsOf("/rules") === "", "nothing after the command is an empty string, not a null to trip over");
t.ok(argsOf(null) === "", "and no text at all is the same");

// ---------------------------------------------------------------- no live session: refused, and told why
let s = await standing();
t.ok(textOf(await say(s.deps, "/rule string SOLANA")) === T.RULE_HOLDERS_ONLY, "/rule from somebody with no session is refused");
t.ok(textOf(await say(s.deps, "/rules")) === T.RULE_HOLDERS_ONLY, "so is /rules");
t.ok(textOf(await say(s.deps, "/unrule 1")) === T.RULE_HOLDERS_ONLY, "so is /unrule");
t.ok(s.watch.rules.all().length === 0, "and nothing was stored on the way past");
t.ok(/verify/.test(T.RULE_HOLDERS_ONLY), "the refusal says how to become one, rather than only saying no");

// in a room, all three point at the direct message before anything else happens
for (const c of ["rule", "rules", "unrule"]) {
  t.ok(PRIVATE_COMMANDS.includes(c), "/" + c + " is a direct message command");
  t.ok(textOf(await say(s.deps, "/" + c, OWNER_A, "supergroup")) === T.PRIVATE_ONLY, "/" + c + " in a room points at the direct message");
}

// ---------------------------------------------------------------- with a session, and with no watcher up
s = await standing();
await putSession(s.kv, OWNER_A, HOLDER_A);
t.ok(textOf(await say({ env: {}, kv: s.kv, watch: null }, "/rule string SOLANA")) === T.RULES_NOT_UP,
  "with no watcher bound the rule is refused rather than accepted into nothing");

// ---------------------------------------------------------------- a rule that reads, and one that does not
s = await standing();
await putSession(s.kv, OWNER_A, HOLDER_A);
let body = textOf(await say(s.deps, "/rule string SOLANA"));
t.ok(/rule number 1/.test(body), "a stored rule comes back with the number /unrule will take");
t.ok(/string SOLANA/.test(body), "and the rule as it was typed");
t.ok(new RegExp("of a possible " + DEFAULT_RULES_PER_HOLDER).test(body), "and how many of the limit are used");
t.ok(s.watch.rules.all().length === 1, "and it is actually stored");
t.ok(s.watch.rules.all()[0].owner === String(OWNER_A), "against the person who asked");

t.ok(textOf(await say(s.deps, "/rule moon SOLANA")) === T.RULE_KIND_UNKNOWN, "an unknown kind is refused by name");
t.ok(textOf(await say(s.deps, "/rule")) === T.RULE_KIND_UNKNOWN, "/rule on its own says what the kinds are");
t.ok(textOf(await say(s.deps, "/rule string")) === T.RULE_NEEDS_ARGUMENT, "a kind with nothing to watch for is refused");
t.ok(textOf(await say(s.deps, "/rule dev bob")) === T.RULE_NEEDS_ADDRESS, "a dev rule will not take a name");
t.ok(textOf(await say(s.deps, "/rule shared 1")) === T.RULE_NEEDS_COUNT, "a shared rule will not take one");
t.ok(textOf(await say(s.deps, "/rule shared many")) === T.RULE_NEEDS_COUNT, "nor a word");
t.ok(s.watch.rules.all().length === 1, "and none of those five stored anything");

t.ok(/watch the launch log/.test(T.RULE_HELP), "the help says what a rule does: it watches the log");
t.ok(/good or bad/.test(T.RULE_HELP), "and that it makes no judgment about what it finds");
for (const c of ["/rule string", "/rule dev", "/rule shared", "/rules", "/unrule", "/unrule all"]) {
  t.ok(T.RULE_HELP.includes(c), "the help writes out " + c);
}
t.ok(!/score|probability|rating|likely|safe|risky/i.test(T.RULE_HELP), "and offers nothing that would be a judgment");

// the other three kinds do read
t.ok(textOf(await say(s.deps, "/rule dev " + DEV_A)).includes(DEV_A), "a dev rule reads and comes back as it was typed");
t.ok(/shared 4/.test(textOf(await say(s.deps, "/rule shared 4"))), "and a shared rule with its count");
t.ok(s.watch.rules.all().length === 3, "three rules now");

// ---------------------------------------------------------------- the limit
s = await standing();
await putSession(s.kv, OWNER_A, HOLDER_A);
const small = new Watch(fakeWatchCtx(), { RULES_PER_HOLDER: "2", TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN });
const smallDeps = { env: {}, kv: s.kv, watch: dep(small) };
await say(smallDeps, "/rule string ONE");
await say(smallDeps, "/rule string TWO");
t.ok(textOf(await say(smallDeps, "/rule string THREE")) === T.RULE_LIMIT_REACHED, "past the limit a rule is refused and the refusal says what to do");
t.ok(small.rules.all().length === 2, "and the third is not stored");

const malformedLimit = new Watch(fakeWatchCtx(), { RULES_PER_HOLDER: "NaN", TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN });
const malformedLimitDeps = { env: {}, kv: s.kv, watch: dep(malformedLimit) };
t.ok(textOf(await say(malformedLimitDeps, "/rule string NONE")) === T.RULE_LIMIT_REACHED,
  "an explicitly malformed deployment limit refuses the first rule rather than removing the capacity check");
t.ok(malformedLimit.rules.all().length === 0, "that fail-closed limit writes no rule row");

const capKv = fakeKV();
await putSession(capKv, OWNER_A, HOLDER_A);
await putSession(capKv, OWNER_B, HOLDER_B);
const capped = new Watch(fakeWatchCtx(), { RULES_TOTAL: "2", TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN });
const cappedDeps = { env: {}, kv: capKv, watch: dep(capped) };
await say(cappedDeps, "/rule string ONE", OWNER_A);
await say(cappedDeps, "/rule string TWO", OWNER_B);
t.ok(textOf(await say(cappedDeps, "/rule string THREE", OWNER_B)) === T.RULE_CAPACITY_REACHED,
  "the product-wide cap refuses only a new add and names overall capacity rather than blaming that holder");
t.ok(capped.rules.all().length === 2, "the global boundary stores no row past its exact limit");
t.ok(/1\. string ONE/.test(textOf(await say(cappedDeps, "/rules", OWNER_A))), "listing remains available while the global store is full");
t.ok(textOf(await say(cappedDeps, "/unrule 1", OWNER_A)) === T.UNRULE_DONE, "removing a rule remains available while the global store is full");
t.ok(/string THREE/.test(textOf(await say(cappedDeps, "/rule string THREE", OWNER_B))), "an add fits again after removal frees global capacity");
await say(cappedDeps, "/forget", OWNER_B);
t.ok(capped.rules.list(String(OWNER_B)).length === 0, "forgetting rules remains available at the global boundary");

const malformedTotal = new Watch(fakeWatchCtx(), { RULES_TOTAL: "Infinity", TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN });
const malformedTotalDeps = { env: {}, kv: capKv, watch: dep(malformedTotal) };
t.ok(textOf(await say(malformedTotalDeps, "/rule string NONE", OWNER_A)) === T.RULE_CAPACITY_REACHED,
  "an explicitly malformed global cap fails the first add closed");
t.ok(malformedTotal.rules.all().length === 0, "a malformed global cap writes no rule row");

// ---------------------------------------------------------------- /rules, and what it discloses
s = await standing();
await putSession(s.kv, OWNER_A, HOLDER_A);
body = textOf(await say(s.deps, "/rules"));
t.ok(body.startsWith("You have no rules."), "with none, /rules says so");
t.ok(body.includes("/rule string SOLANA"), "and writes the four of them out");
t.ok(/read the pons launch log/.test(body), "and says what it has read");

await say(s.deps, "/rule string SOLANA");
await say(s.deps, "/rule dev " + DEV_A);
body = textOf(await say(s.deps, "/rules"));
t.ok(/1\. string SOLANA/.test(body), "with rules, they are numbered from one");
t.ok(/2\. dev /.test(body), "in the order they were made");
t.ok(/nothing yet/.test(body), "and the watcher says it has read nothing yet rather than printing a zero");

// a gap in the watcher's reading is shown to the people it costs
s.watch.set("gaps", 2);
s.watch.set("last_block", 900);
body = textOf(await say(s.deps, "/rules"));
t.ok(/up to block 900/.test(body), "once it has read something, it says how far");
t.ok(/had to be restarted: 2/.test(body), "and how many times its reading stopped");
t.ok(/cannot match a launch I did not read/.test(body), "and what that costs a rule, in words");

// The longest legal list is paged before it reaches Telegram. Escaping '<' makes this a stricter wire-size
// case than an ordinary two-hundred-character rule while remaining a legal string rule.
const paged = await standing();
await putSession(paged.kv, OWNER_A, HOLDER_A);
const longest = "<".repeat(MAX_ARG);
for (let i = 0; i < DEFAULT_RULES_PER_HOLDER; i++) {
  paged.watch.rules.add(OWNER_A, "string", longest, { ticker: null, name: null, links: [] }, i + 1);
}
const pages = await say(paged.deps, "/rules");
t.ok(pages.length > 1, "the longest legal full rule list becomes more than one send action");
t.ok(pages.every(action => action.kind === "send" && action.preview === false && action.text.length <= TELEGRAM_TEXT_LIMIT),
  "every rule-list action stays within the exact sendMessage text ceiling");
t.ok(pages.every((action, i) => action.text.startsWith("Your rules (page " + (i + 1) + " of " + pages.length + "):\n\n")),
  "each part names its position, so a missing transient delivery is visible to the reader");
const pagedRuleLines = pages.flatMap(action => action.text.split("\n")).filter(line => /^[0-9]+\. string /.test(line));
t.ok(pagedRuleLines.length === DEFAULT_RULES_PER_HOLDER, "pagination loses none of the legal stored rules");
t.ok(pagedRuleLines.every((line, i) => line.startsWith(String(i + 1) + ". string ") && line.endsWith("&lt;".repeat(MAX_ARG))),
  "every rule keeps its stable /unrule number and its complete escaped argument across pages");

const realFetch = globalThis.fetch;
const attemptedPages = [];
globalThis.fetch = async (_url, options) => {
  attemptedPages.push(JSON.parse(options.body));
  const accepted = attemptedPages.length !== 2;
  return new Response(JSON.stringify({ ok: accepted }), { status: accepted ? 200 : 503, headers: { "content-type": "application/json" } });
};
let delivered;
let oversizedRefused;
try {
  delivered = await perform({ TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN }, pages);
  const beforeOversized = attemptedPages.length;
  oversizedRefused = await sendMessage({ TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN }, OWNER_A, "x".repeat(TELEGRAM_TEXT_LIMIT + 1)) === false && attemptedPages.length === beforeOversized;
} finally {
  globalThis.fetch = realFetch;
}
t.ok(attemptedPages.length === pages.length && delivered === pages.length - 1,
  "one transient page failure is counted but does not suppress any later page attempt");
t.ok(attemptedPages.at(-1).text === pages.at(-1).text,
  "the final numbered page is still attempted unchanged after an earlier page fails");
t.ok(oversizedRefused, "the transport refuses an accidentally oversized action before making a Telegram request");

const acknowledgementBodies = [
  new Response(JSON.stringify({ ok: false, error_code: 429 }), { status: 200 }),
  new Response("{", { status: 200 }),
  new Response(null, { status: 204 }),
  new Response("x".repeat(TELEGRAM_RESPONSE_LIMIT + 1), { status: 200 }),
  new Response(JSON.stringify({ ok: true }), { status: 200 })
];
const acknowledgementResults = [];
globalThis.fetch = async () => acknowledgementBodies.shift();
try {
  for (let i = 0; i < 5; i++) acknowledgementResults.push(await sendMessage({ TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN }, OWNER_A, "bounded acknowledgement"));
} finally {
  globalThis.fetch = realFetch;
}
t.ok(JSON.stringify(acknowledgementResults) === JSON.stringify([false, false, false, false, true]),
  "HTTP success is accepted only with a bounded valid Bot API body whose ok field is exactly true");

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let deadline = null;
let deadlineMs = null;
let hangingAborted = false;
globalThis.setTimeout = (fn, ms) => { deadline = fn; deadlineMs = ms; return 1; };
globalThis.clearTimeout = () => {};
globalThis.fetch = async (_url, options) => await new Promise((_resolve, reject) => {
  options.signal.addEventListener("abort", () => { hangingAborted = true; reject(new Error("aborted")); }, { once: true });
});
let hangingResult;
try {
  const pending = sendMessageResult({ TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN }, OWNER_A, "bounded deadline");
  await Promise.resolve();
  deadline();
  hangingResult = await pending;
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.fetch = realFetch;
}
t.ok(hangingResult === "uncertain" && hangingAborted && deadlineMs === TELEGRAM_TIMEOUT_MS,
  "a never-settling Telegram request aborts at the authored deadline and remains an uncertain at-least-once delivery");

let lateResolve;
let lateCancelled = false;
deadline = null;
globalThis.setTimeout = fn => { deadline = fn; return 2; };
globalThis.clearTimeout = () => {};
globalThis.fetch = async () => await new Promise(resolve => { lateResolve = resolve; });
let lateResult;
try {
  const pending = sendMessageResult({ TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN }, OWNER_A, "late acknowledgement");
  await Promise.resolve();
  deadline();
  lateResolve(new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true }))); },
    cancel() { lateCancelled = true; }
  }), { status: 200 }));
  lateResult = await pending;
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.fetch = realFetch;
}
t.ok(lateResult === "uncertain" && lateCancelled,
  "a success that arrives after the deadline is cancelled and cannot turn an already uncertain send into acceptance");

let oversizedCancelled = false;
globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(TELEGRAM_RESPONSE_LIMIT + 1)); },
  cancel() { oversizedCancelled = true; return new Promise(() => {}); }
}), { status: 200 });
let oversizedResult;
let oversizedSettled = false;
globalThis.setTimeout = () => 3;
globalThis.clearTimeout = () => {};
try {
  sendMessageResult({ TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN }, OWNER_A, "bounded response").then(value => {
    oversizedResult = value;
    oversizedSettled = true;
  });
  for (let i = 0; i < 12 && !oversizedSettled; i++) await Promise.resolve();
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.fetch = realFetch;
}
t.ok(oversizedSettled && oversizedResult === "uncertain" && oversizedCancelled,
  "a streamed oversized success body returns uncertain even when reader cancellation never settles");

let refusalCancelled = false;
let refusalSettled = false;
let refusalResult;
globalThis.setTimeout = () => 4;
globalThis.clearTimeout = () => {};
globalThis.fetch = async () => new Response(new ReadableStream({
  cancel() { refusalCancelled = true; return new Promise(() => {}); }
}), { status: 503 });
try {
  sendMessageResult({ TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN }, OWNER_A, "definite refusal").then(value => {
    refusalResult = value;
    refusalSettled = true;
  });
  for (let i = 0; i < 12 && !refusalSettled; i++) await Promise.resolve();
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  globalThis.fetch = realFetch;
}
t.ok(refusalSettled && refusalResult === "refused" && refusalCancelled,
  "a definite HTTP refusal returns without awaiting a cancellation promise that never settles");

// one person is never shown another's
await putSession(s.kv, OWNER_B, HOLDER_B);
s.watch.rules.add(OWNER_B, "string", "MOONSHOT", { ticker: "deadbeefdeadbeef", name: null, links: [] }, 1);
body = textOf(await say(s.deps, "/rules", OWNER_A));
t.ok(!/MOONSHOT/.test(body), "/rules shows one person their own rules and no trace of anybody else's");
t.ok(textOf(await say(s.deps, "/rules", OWNER_B)).includes("MOONSHOT"), "and shows them theirs");

// ---------------------------------------------------------------- /unrule, and whose rule it can reach
t.ok(textOf(await say(s.deps, "/unrule")) === T.UNRULE_NEEDS_NUMBER, "/unrule with no number says which number it wants");
t.ok(textOf(await say(s.deps, "/unrule two")) === T.UNRULE_NEEDS_NUMBER, "and a word is not a number");
t.ok(textOf(await say(s.deps, "/unrule 9")) === T.UNRULE_NOT_YOURS, "a number that is not one of yours is refused");

// OWNER_B has exactly one rule, and it is the third rule stored overall. Their /unrule 1 must reach that one
// and nothing of OWNER_A's, which is the case section sixteen names.
const before = s.watch.rules.all().length;
t.ok(textOf(await say(s.deps, "/unrule 1", OWNER_B)) === T.UNRULE_DONE, "their own first rule comes away");
t.ok(s.watch.rules.all().length === before - 1, "one rule fewer in total");
t.ok(s.watch.rules.list(OWNER_A).length === 2, "and both of the other person's are untouched");
t.ok(s.watch.rules.list(OWNER_B).length === 0, "while theirs is gone");
t.ok(textOf(await say(s.deps, "/unrule 1", OWNER_B)) === T.UNRULE_NOT_YOURS, "and asking again is refused rather than reaching further down the list");

// and the numbering closes up, so /unrule 1 twice removes two of your own and never one of anybody else's
t.ok(textOf(await say(s.deps, "/unrule 1", OWNER_A)) === T.UNRULE_DONE, "the first of your own goes");
t.ok(s.watch.rules.list(OWNER_A).length === 1, "leaving one");
t.ok(textOf(await say(s.deps, "/unrule 1", OWNER_A)) === T.UNRULE_DONE, "and then the other");
t.ok(s.watch.rules.all().length === 0, "and the table is empty, with nothing removed that was not asked for");

// all is explicit, owner-scoped, idempotent, and leaves the holder session in KV.
await say(s.deps, "/rule string ONE", OWNER_A);
await say(s.deps, "/rule string TWO", OWNER_A);
s.watch.rules.add(OWNER_B, "string", "THEIRS", { ticker: "feedfacefeedface", name: null, links: [] }, 1);
t.ok(textOf(await say(s.deps, "/unrule all", OWNER_A)) === T.UNRULE_ALL_DONE, "/unrule all confirms the owner-scoped bulk delete");
t.ok(s.watch.rules.list(OWNER_A).length === 0 && s.watch.rules.list(OWNER_B).length === 1, "bulk delete removes every rule of the sender and none of another owner");
t.ok(await s.kv.get("session:" + OWNER_A) === HOLDER_A, "bulk rule deletion leaves the holder session alone");
t.ok(textOf(await say(s.deps, "/unrule ALL", OWNER_A)) === T.UNRULE_ALL_DONE, "bulk delete is case-insensitive and idempotent");

// ---------------------------------------------------------------- /forget reaches both stores, is owner-scoped, and tells partial truth
s = await standing();
await putSession(s.kv, OWNER_A, HOLDER_A);
await putSession(s.kv, OWNER_B, HOLDER_B);
await say(s.deps, "/rule string SOLANA", OWNER_A);
await say(s.deps, "/rule string MOON", OWNER_B);
t.ok(textOf(await say(s.deps, "/forget", OWNER_A)) === T.FORGOTTEN, "full forget confirms both stores without consulting token state");
t.ok(await s.kv.get("session:" + OWNER_A) === null && s.watch.rules.list(OWNER_A).length === 0, "it deletes the address session and every rule for that owner");
t.ok(await s.kv.get("session:" + OWNER_B) === HOLDER_B && s.watch.rules.list(OWNER_B).length === 1, "it leaves the other owner's session and rules untouched");
t.ok(textOf(await say(s.deps, "/forget", OWNER_A)) === T.FORGOTTEN, "repeating full forget remains the same idempotent request");

const deleteRejected = { async delete() { throw new Error("unconfirmed"); } };
const rulesOk = { async forget() { return { ok: true }; } };
const rulesNo = { async forget() { return null; } };
t.ok(textOf(await say({ env: {}, kv: fakeKV(), watch: rulesNo }, "/forget")) === T.FORGET_RULES_UNCONFIRMED, "an address-only acknowledgement names unconfirmed rules");
t.ok(textOf(await say({ env: {}, kv: deleteRejected, watch: rulesOk }, "/forget")) === T.FORGET_SESSION_UNCONFIRMED, "a rules-only acknowledgement names the unconfirmed address deletion");
t.ok(textOf(await say({ env: {}, kv: deleteRejected, watch: rulesNo }, "/forget")) === T.FORGET_UNCONFIRMED, "two missing acknowledgements are not rewritten as success");

t.done();
