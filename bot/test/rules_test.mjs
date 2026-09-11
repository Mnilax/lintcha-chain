// Rules: reading one, storing one, matching one, and removing one that is not yours.
//
// The four cases specification section sixteen asks for are here as four blocks, each with its own silence:
// a string rule fires on a match and says nothing otherwise, a dev rule fires on that deployer and no other,
// a shared rule fires at the threshold and not one below it, and one person's rule is not reachable by
// another person's /unrule — refused twice, once by the number the router resolves and once by the owner in
// the delete's own where clause, which is the one asserted here.
//
// Every hash on both sides of a match comes out of the loaded engine. A string rule is stored as the hashes
// the engine gives its query, and a launch as the hashes the engine gave its fields, so a match is the same
// hash equality the page performs.
//
//   node test/rules_test.mjs
import { parseRule, rifleOf, match, Rules, KINDS, MIN_SHARED, MAX_ARG, DEFAULT_RULES_PER_HOLDER, MAX_RULES_PER_HOLDER } from "../src/rules.js";
import { LINKS, normalize } from "../src/engine.js";
import { rowOf } from "../src/tally.js";
import { harness, fakeWatchCtx, OWNER_A, OWNER_B } from "./fakes.mjs";

const t = harness("rules");

const DEV_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEV_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const LAUNCH = {
  token: "0x1000000000000000000000000000000000000001", deployer: DEV_A, block: 500, date: "2026-09-01",
  name: "Solana Dog", symbol: "SOLANA", logo: "ipfs://QmAbC", description: "", recipient: "0x" + "0".repeat(40),
  socials: ["@bob", "https://t.me/room", "", "", ""]
};
const OTHER = { ...LAUNCH, token: "0x1000000000000000000000000000000000000002", deployer: DEV_B, name: "Something Else", symbol: "ELSE", socials: ["", "", "", "", ""] };

const subjectOf = async (launch, extra = {}) => {
  const row = await rowOf(launch);
  return { deployer: launch.deployer, hashes: { ticker: row.hashes.ticker, name: row.hashes.name, link: row.hashes.link }, indexState: "unique", indexCount: 0, tailCount: 1, ...extra };
};
const ruleOf = async (kind, arg) => ({ kind, arg, rifle: await rifleOf(kind, arg) });

// ---------------------------------------------------------------- reading a rule, and refusing to guess
t.ok(KINDS.length === 3, "three kinds, and no fourth to be invented later");
t.ok(parseRule("string", "SOLANA").ok, "a string rule reads");
t.ok(parseRule("STRING", "SOLANA").kind === "string", "the kind is not case sensitive");
t.ok(parseRule("moon", "SOLANA").why === "kind", "an unknown kind is refused by name");
t.ok(parseRule("string", "").why === "empty", "a rule with nothing to watch for is refused");
t.ok(parseRule("string", "x".repeat(MAX_ARG + 1)).why === "long", "and one longer than anything a launch can be called");
t.ok(parseRule("dev", DEV_A.toUpperCase()).arg === DEV_A, "a dev rule lowers its address");
t.ok(parseRule("dev", "bob").why === "address", "and refuses a name rather than turning it into a string rule");
t.ok(parseRule("dev", "0x123").why === "address", "or half an address");
t.ok(parseRule("shared", "3").arg === "3", "a shared rule takes a count");
t.ok(parseRule("shared", String(MIN_SHARED - 1)).why === "number", "one below the floor is refused, because one launch carrying a ticker is the launch itself");
t.ok(parseRule("shared", "two").why === "number", "and a word is not a count");
t.ok(parseRule("shared", "2.5").why === "number", "nor is a fraction");
t.ok(parseRule("shared", "9007199254740993").why === "number", "an unsafe integer is refused instead of being rounded into another threshold");
t.ok(parseRule("shared", String(Number.MAX_SAFE_INTEGER)).arg === String(Number.MAX_SAFE_INTEGER), "the largest exactly representable threshold remains exact");
t.ok(MIN_SHARED === 2, "the floor is two");

// ---------------------------------------------------------------- a string rule fires on a match and is otherwise quiet
const onTicker = await ruleOf("string", "solana");
t.ok(match(onTicker, await subjectOf(LAUNCH)).where === "the ticker", "a ticker written in another case still matches: the engine folds it");
t.ok(match(onTicker, await subjectOf(OTHER)) === null, "and a launch that does not carry it is silence, not a message saying so");

const withDollar = await ruleOf("string", "$SOLANA");
t.ok(match(withDollar, await subjectOf(LAUNCH)).where === "the ticker", "a leading dollar is not a different ticker");

const onName = await ruleOf("string", "solana dog");
t.ok(match(onName, await subjectOf(LAUNCH)).where === "the name", "a name matches as a name");

const onHandle = await ruleOf("string", "@bob");
const hitLink = match(onHandle, await subjectOf(LAUNCH));
t.ok(hitLink && hitLink.where === "a link", "a bare handle matches the link field that names its platform");
t.ok(hitLink && hitLink.field === "twitter", "and the message can say which platform, because the empty slots are kept");

const onTwitterUrl = await ruleOf("string", "https://twitter.com/BOB");
t.ok(match(onTwitterUrl, await subjectOf(LAUNCH)) !== null, "and so does the same account written as a twitter url, through the alias table");

const onTelegram = await ruleOf("string", "telegram.me/Room");
t.ok(match(onTelegram, await subjectOf(LAUNCH)) !== null, "telegram.me folds to t.me, so the room matches either way");

const onStranger = await ruleOf("string", "https://x.com/carol");
t.ok(match(onStranger, await subjectOf(LAUNCH)) === null, "a different account does not match");
t.ok(match(await ruleOf("string", "sol"), await subjectOf(LAUNCH)) === null, "and a rule is equality, not a substring: sol does not match SOLANA");

// ---------------------------------------------------------------- a dev rule fires on that deployer and no other
const onDev = await ruleOf("dev", DEV_A);
t.ok(match(onDev, await subjectOf(LAUNCH)).where === "the deployer", "the named deployer matches");
t.ok(match(onDev, await subjectOf(OTHER)) === null, "another deployer does not");
t.ok(match(onDev, await subjectOf({ ...LAUNCH, deployer: DEV_A.toUpperCase() })) !== null, "and case in an address is not a different deployer");

// ---------------------------------------------------------------- a shared rule fires at the threshold and not below
const onShared = await ruleOf("shared", "4");
t.ok(match(onShared, await subjectOf(LAUNCH, { indexState: "shared", indexCount: 3, tailCount: 1 })).count === 4, "three in the index and one in its disjoint suffix is four, which is the threshold");
t.ok(match(onShared, await subjectOf(LAUNCH, { indexState: "shared", indexCount: 2, tailCount: 1 })) === null, "one below the threshold is silence");
t.ok(match(onShared, await subjectOf(LAUNCH, { indexState: "shared", indexCount: 10, tailCount: 1 })).count === 11, "and above it fires with the real count, not the threshold");
const fired = match(onShared, await subjectOf(LAUNCH, { indexState: "shared", indexCount: 3, tailCount: 2 }));
t.ok(fired.indexCount === 3 && fired.tailCount === 2, "the two halves of the count are kept apart, because they come from two places");
t.ok(fired.exact === true, "a present snapshot entry plus a disjoint suffix is marked exact");
t.ok(match(onShared, await subjectOf(LAUNCH, { indexState: null, indexCount: null, tailCount: 9 })) === null,
  "and with no index to read it stays quiet: a threshold compared against half a count is compared against nothing");
t.ok(match(onShared, await subjectOf(LAUNCH, { indexState: "unique", indexCount: 0, tailCount: 3 })) === null,
  "an absent snapshot entry plus three suffix launches stays quiet, because the snapshot contributes zero or one rather than a known zero");
const floor = match(onShared, await subjectOf(LAUNCH, { indexState: "unique", indexCount: 0, tailCount: 4 }));
t.ok(floor && floor.count === 4 && floor.exact === false && floor.indexCount === null,
  "the suffix may prove the threshold by itself, but the answer remains a floor rather than a false exact total");
t.ok(match(onShared, await subjectOf(LAUNCH, { indexState: "shared", indexCount: 3, tailCount: null })) === null,
  "without a readable snapshot boundary there is no disjoint suffix and the rule stays quiet");
t.ok(match(onShared, await subjectOf(LAUNCH, { indexState: "shared", indexCount: Number.MAX_SAFE_INTEGER, tailCount: 1 })) === null,
  "a combined count beyond the safe integer range is silence rather than a rounded match count");

// ---------------------------------------------------------------- storing, listing, removing
const ctx = fakeWatchCtx();
const rules = new Rules(ctx.storage.sql);
t.ok(rules.countFor(OWNER_A) === 0, "a person starts with none");
t.ok(rules.limit({}) === DEFAULT_RULES_PER_HOLDER, "the limit has a default");
t.ok(rules.limit({ RULES_PER_HOLDER: "3" }) === 3, "and is a setting");
t.ok(MAX_RULES_PER_HOLDER === DEFAULT_RULES_PER_HOLDER, "the documented default is also the product cap");
for (const invalid of ["NaN", "Infinity", "-1", "0", "1.5", String(MAX_RULES_PER_HOLDER + 1), String(Number.MAX_SAFE_INTEGER + 1)]) {
  t.ok(rules.limit({ RULES_PER_HOLDER: invalid }) === 0, `an explicit invalid rule limit ${JSON.stringify(invalid)} closes new-rule capacity`);
}

const first = rules.add(OWNER_A, "string", "SOLANA", await rifleOf("string", "SOLANA"), 1000);
const second = rules.add(OWNER_A, "dev", DEV_A, await rifleOf("dev", DEV_A), 1001);
const theirs = rules.add(OWNER_B, "string", "MOON", await rifleOf("string", "MOON"), 1002);
t.ok(first.id !== second.id && second.id !== theirs.id, "each rule gets its own id");
t.ok(rules.countFor(OWNER_A) === 2, "two for one person");
t.ok(rules.countFor(OWNER_B) === 1, "one for the other");
t.ok(rules.list(OWNER_A).length === 2, "a list is only your own");
t.ok(rules.list(OWNER_A).every(r => r.owner === OWNER_A), "every row in it, without exception");
t.ok(rules.list(OWNER_A)[0].id === first.id, "oldest first, so the number /rules shows is stable");
t.ok(rules.all().length === 3, "the watcher reads all of them against a launch, which is a different question");
t.ok(rules.list(OWNER_A)[0].rifle.ticker === (await rifleOf("string", "SOLANA")).ticker, "the stored hashes come back as they went in");

// the one that matters: another person's rule is not removable
t.ok(rules.removeById(OWNER_A, theirs.id) === false, "removing somebody else's rule by its id answers no");
t.ok(rules.all().length === 3, "and removes nothing at all");
t.ok(rules.list(OWNER_B).length === 1, "their rule is still theirs");
t.ok(rules.removeById(OWNER_A, first.id) === true, "your own comes away");
t.ok(rules.list(OWNER_A).length === 1, "leaving the other one");
t.ok(rules.removeById(OWNER_A, first.id) === false, "and a second attempt answers no rather than throwing");

rules.bumpHit(second.id);
rules.bumpHit(second.id);
t.ok(rules.list(OWNER_A)[0].hits === 2, "a rule counts its own hits");
t.ok(rules.removeAll(OWNER_A) === true && rules.list(OWNER_A).length === 0, "full forget removes every rule for its owner");
t.ok(rules.list(OWNER_B).length === 1, "full forget cannot remove another owner's rule");
t.ok(rules.removeAll(OWNER_A) === true && rules.list(OWNER_B).length === 1, "full forget is idempotent");

// ---------------------------------------------------------------- the engine, not a copy of it
t.ok(normalize.ticker("$solana") === "SOLANA", "the normalizers a rule compares with are the engine's own");
t.ok(LINKS.length === 5, "and the five link fields are the engine's five");

t.done();
