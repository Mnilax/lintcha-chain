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
import { DEFAULT_RULES_PER_HOLDER } from "../src/rules.js";
import * as T from "../src/texts.js";
import { harness, fakeKV, fakeWatchCtx, fakePublished, OWNER_A, OWNER_B, TOKEN_ADDRESS, STAND_BOT_TOKEN } from "./fakes.mjs";

const t = harness("rules_router");

const HOLDER_A = "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";
const HOLDER_B = "0x1111111111111111111111111111111111111111";
const DEV_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const net = fakePublished({ token: { address: TOKEN_ADDRESS, pons: null, uniswap: null } });

const msg = (text, from = OWNER_A, type = "private") => ({ message: { chat: { id: Number(from), type }, from: { id: from }, text } });
const textOf = a => (a[0] && a[0].text) || "";

/** the same three calls index.js makes over a request boundary, made straight against the object */
const dep = w => ({
  list: owner => w.ruleCommand({ what: "list", owner: String(owner) }),
  add: (owner, kind, arg) => w.ruleCommand({ what: "add", owner: String(owner), kind, arg }),
  remove: (owner, number) => w.ruleCommand({ what: "remove", owner: String(owner), number })
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
for (const c of ["/rule string", "/rule dev", "/rule shared", "/rules", "/unrule"]) {
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

t.done();
