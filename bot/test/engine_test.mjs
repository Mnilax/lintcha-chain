// The main test of the round.
//
// One set of launches, put through the engine the way the page does it and the way the watcher does it, has to
// come out the same. If the tail folded one link differently, or hashed one skeleton differently, the site
// would print one answer and the bot would send another, and nothing else in the suite would notice.
//
// Three things are checked here and they are different claims:
//
//   1. The file is the vendored file. Its sha256 is compared against the hash VENDOR.md records for it — read
//      out of VENDOR.md, not pinned in this test — so an edited engine fails here as well as in
//      tools/verify-vendor.mjs.
//
//   2. It loads two ways, and both are real. The page's way is three script tags: the UMD's global branch,
//      the two vendored tables on `self`, and crypto.subtle for the digest. That is reproduced here by
//      evaluating the file's own bytes with `self` handed in — no bundler, no import, no edit. The watcher's
//      way is bot/src/engine.js. The collector's and the index writer's way is a third, createRequire, which
//      is Node's own and is covered by the hash above: one file, and whichever loader runs it, the same bytes.
//
//   3. The two loaded engines agree, value for value and hash for hash, over a fixture set built to hit the
//      awkward parts: a bare handle, a twitter.com url that folds to x.com, a case difference in a path, a
//      description one word under the floor, the zero address as a fee recipient, an unfilled field, two
//      spellings of one ticker, and a lookalike made with a diacritic rather than with a digit, so the case
//      turns on the marks step every skeleton does and not on one row of the confusable table.
//
// And the arithmetic on top of the engine is pinned the same way. The collector's Counter cannot be imported
// (not exported, and its module reads the chain on load), so bot/src/tally.js mirrors it; the mirror is
// checked here by counting the same fixtures with the collector's own twelve lines, transcribed below from
// tools/launch-collect.mjs, and comparing every table entry.
//
//   node test/engine_test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine, engineSelfTest, ENGINE_PATH, NAMESPACES, LINKS, MIN_WORDS } from "../src/engine.js";
import { Tally, valuesOf, hashesOf, rowOf, tallyText, tallyHash, entryCounts } from "../src/tally.js";
import { addRowToTally, engineInput } from "../src/watch.js";
import { harness } from "./fakes.mjs";

const t = harness("engine");
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const readFile = rel => fs.readFileSync(path.join(repo, ...rel.split("/")), "utf8");

const sha256 = async text => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
};

// ---------------------------------------------------------------- 1. the file is the vendored file
const vendor = readFile("VENDOR.md");
const rowFor = p => {
  const line = vendor.split("\n").find(l => l.includes("`" + p + "`"));
  const m = line && /`([0-9a-f]{64})`/.exec(line);
  return m ? m[1] : null;
};
const enginePath = "site/launch.js";
t.ok(ENGINE_PATH === enginePath, "the watcher says which file it counts with, and it is the page's");
const recorded = rowFor(enginePath);
t.ok(!!recorded, "VENDOR.md records a hash for " + enginePath);
const engineText = readFile(enginePath);
t.ok(await sha256(engineText) === recorded, "and the file on disk is that hash, byte for byte, unedited");

for (const p of ["site/launch-links.js", "site/launch-skeleton.js"]) {
  const h = rowFor(p);
  t.ok(!!h, "VENDOR.md records a hash for " + p);
  t.ok(await sha256(readFile(p)) === h, p + " is unedited too, and the engine cannot load without it");
}

// nothing in bot/ is a copy of it: the one import is the whole arrangement
const engineModule = readFile("bot/src/engine.js");
t.ok(/from "\.\.\/\.\.\/site\/launch\.js"/.test(engineModule), "bot/src/engine.js imports the vendored file by path");
for (const f of ["bot/src/tally.js", "bot/src/watch.js", "bot/src/rules.js"]) {
  const body = readFile(f);
  t.ok(!/normalize\s*=\s*function|function\s+skeleton|function\s+linkRaw/.test(body), f + " defines no normalizer of its own");
  t.ok(/from "\.\/engine\.js"|from "\.\/tally\.js"/.test(body), f + " gets its hashing from the loaded engine");
}

// ---------------------------------------------------------------- 2. the page's way, from the file's own bytes
/**
 * Three script tags, in the order the template loads them, and nothing else. The UMD sees `self`, so it takes
 * its global branch, reads the two tables off it and hashes with crypto.subtle — which is the page's path
 * exactly, and not one byte of any of the three files is changed to get there.
 */
function loadAsThePageDoes() {
  const self = {};
  for (const p of ["site/launch-skeleton.js", "site/launch-links.js", "site/launch.js"]) {
    new Function("self", readFile(p))(self);
  }
  return self;
}
const page = loadAsThePageDoes();
t.ok(!!page.LaunchSkeleton && !!page.LaunchLinks, "the two tables land on self, as the page's first two tags do");
t.ok(!!page.LaunchIdentity, "and the engine lands on self, as the third does");
const pageEngine = page.LaunchIdentity;

t.ok(engineSelfTest().ok, "the watcher's engine answers on every part it uses");
t.ok(pageEngine !== Engine, "the two engines are separately loaded objects, so agreeing means something");
t.ok(pageEngine.HEX_CHARS === Engine.HEX_CHARS, "both cut a hash to the same number of characters");
t.ok(pageEngine.MIN_WORDS === Engine.MIN_WORDS && Engine.MIN_WORDS === MIN_WORDS, "both use the same description floor");
t.ok(JSON.stringify(pageEngine.NAMESPACES) === JSON.stringify(NAMESPACES), "and the same namespaces, in the same order");
t.ok(JSON.stringify(pageEngine.LINKS) === JSON.stringify(LINKS), "and the same five link fields, in the same order");

// ---------------------------------------------------------------- the fixtures
const DEV_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEV_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REC_A = "0xcccccccccccccccccccccccccccccccccccccccc";
const ZERO = "0x" + "0".repeat(40);
const LONG = "a frozen index of counted hashes is what this launch is compared against and nothing here is a score";
const SHORT = "this description is one word under the floor and cannot compare";

const FIXTURES = [
  {
    token: "0x1000000000000000000000000000000000000001", deployer: DEV_A, block: 100, date: "2026-09-01",
    name: "Solana Dog", symbol: "$solana", logo: "ipfs://QmAbC", description: LONG, recipient: REC_A,
    socials: ["@Bob", "https://Telegram.me/Room", "", "https://WWW.Example.com/Path/", ""]
  },
  {
    token: "0x1000000000000000000000000000000000000002", deployer: DEV_B, block: 101, date: "2026-09-01",
    name: "solana dog!", symbol: "SOLANA", logo: "ipfs://QmAbC", description: LONG, recipient: REC_A,
    socials: ["https://twitter.com/bob", "@room", "", "example.com/Path", ""]
  },
  {
    token: "0x1000000000000000000000000000000000000003", deployer: DEV_B, block: 102, date: "2026-09-02",
    name: "Solan\u00e1 Dog", symbol: "SOLAN\u00c1", logo: "", description: SHORT, recipient: ZERO,
    socials: ["", "", "", "", ""]
  },
  {
    token: "0x1000000000000000000000000000000000000004", deployer: DEV_A, block: 103, date: "2026-09-02",
    name: "Something Else", symbol: "ELSE", logo: "ar://xyz", description: "", recipient: "not an address",
    socials: ["", "", "https://discord.gg/AbC", "", "@carol"]
  }
];

// ---------------------------------------------------------------- 3. every value, both ways
/** the collector's own per launch order, from tools/launch-collect.mjs, using whichever engine it is handed */
function valuesTheCollectorWay(L, launch) {
  const socials = {};
  L.LINKS.forEach((k, i) => { socials[k] = launch.socials[i] || ""; });
  const out = [];
  for (const k of L.LINKS) out.push({ ns: "link", value: L.normalize.link(socials[k], k) });
  out.push({ ns: "logo", value: L.normalize.logo(launch.logo) });
  const rec = L.normalize.recipient(launch.recipient);
  if (rec.state === "ok") out.push({ ns: "recipient", value: rec.value });
  const desc = L.normalize.description(launch.description);
  if (desc && L.words(desc) >= L.MIN_WORDS) out.push({ ns: "description", value: desc });
  const tick = L.normalize.ticker(launch.symbol), name = L.normalize.name(launch.name);
  out.push({ ns: "ticker", value: tick });
  out.push({ ns: "name", value: name });
  out.push({ ns: "ticker_skeleton", value: L.normalize.skeleton(tick), spelling: tick });
  out.push({ ns: "name_skeleton", value: L.normalize.skeleton(name), spelling: name });
  return out.filter(v => v.value);
}

let compared = 0;
for (const f of FIXTURES) {
  const watcherValues = valuesOf(f);
  const pageValues = valuesTheCollectorWay(pageEngine, f);
  t.ok(watcherValues.length === pageValues.length, f.symbol + ": the same number of values are counted, and the same ones are left out");
  for (let i = 0; i < Math.min(watcherValues.length, pageValues.length); i++) {
    t.ok(watcherValues[i].ns === pageValues[i].ns && watcherValues[i].value === pageValues[i].value, f.symbol + ": " + pageValues[i].ns + " normalizes identically");
    compared++;
  }
  // and every hash: the value the page's engine normalized, hashed by the page's engine, is a hash the
  // watcher stored for that namespace
  const stored = await hashesOf(f);
  t.ok(stored.every(h => /^[0-9a-f]{16}$/.test(h.hash)), f.symbol + ": every hash is sixteen hex characters");
  for (const v of pageValues) {
    const pageHash = await pageEngine.digest(v.value);
    t.ok(stored.some(x => x.ns === v.ns && x.hash === pageHash), f.symbol + ": the " + v.ns + " hash the page would compute is one the watcher stored");
    compared++;
  }
}
t.ok(compared > 60, "and that was over every value of every fixture, not a sample");

// ---------------------------------------------------------------- the engine's own two digests
//
// The vendored file carries two: digestNode, sha256 through node's crypto, and digestSubtle, sha256 through
// the platform's. Which one `digest` is depends on which branch of the UMD ran, and which branch ran depends
// on the loader — the collector and the bundle take the require branch, the page takes the other. Both cut
// the same sixteen hex characters off the same sha256 in the same line of the same file, and this is the
// assertion that says so rather than the comment.
//
// It has meaning only where the require branch is what ran. Under a loader that took the global branch the
// two names are one function and this passes without proving anything, which is worth knowing when reading a
// run: it is a real check under node and under the deployed bundle, and a formality anywhere else.
t.ok(typeof Engine.digestSubtle === "function", "the engine exposes its platform digest by name");
let digestsCompared = 0;
for (const f of FIXTURES) {
  for (const v of valuesOf(f)) {
    t.ok(await Engine.digest(v.value) === await Engine.digestSubtle(v.value), "both of the engine's digests agree on " + v.ns);
    digestsCompared++;
  }
}
t.ok(digestsCompared > 20, "over every value again, so which branch of the file loaded cannot change a hash");

// the awkward parts are actually awkward: these pairs have to fold together and these must not
const fold = (a, field) => pageEngine.normalize.link(a, field);
t.ok(fold("@Bob", "twitter") === fold("https://twitter.com/bob", "twitter"), "a bare handle and a twitter url are one account");
t.ok(fold("https://Telegram.me/Room", "telegram") === fold("@room", "telegram"), "and so are telegram.me and a handle");
t.ok(fold("https://WWW.Example.com/Path/", "website") !== fold("example.com/path", "website"), "but a path's case is kept where the table does not say otherwise");
t.ok(pageEngine.normalize.ticker("$solana") === pageEngine.normalize.ticker("SOLANA"), "a leading dollar and case are not a different ticker");
t.ok(pageEngine.normalize.description(SHORT) && pageEngine.words(pageEngine.normalize.description(SHORT)) < MIN_WORDS, "the short description is under the floor, as this fixture intends");
t.ok(pageEngine.normalize.recipient(ZERO).state === "empty", "the zero address is no recipient");
t.ok(pageEngine.normalize.recipient("not an address").state === "not readable", "and something that is not an address says so");

// ---------------------------------------------------------------- the counting, against the collector's own arithmetic
/** tools/launch-collect.mjs, class Counter, transcribed. The engine is handed in; only the arithmetic is here. */
async function countTheCollectorWay(L, launches) {
  const tables = {};
  for (const ns of L.NAMESPACES) tables[ns] = new Map();
  for (const launch of launches) {
    for (const v of valuesTheCollectorWay(L, launch)) {
      const h = await L.digest(v.value);
      const table = tables[v.ns];
      const e = table.get(h) || { n: 0, first: launch.date, deployers: new Set(), spellings: v.ns.endsWith("_skeleton") ? new Set() : null };
      e.n++;
      if (launch.date < e.first) e.first = launch.date;
      e.deployers.add(launch.deployer);
      if (e.spellings) e.spellings.add(v.spelling);
      table.set(h, e);
    }
  }
  const out = {};
  for (const ns of L.NAMESPACES) {
    out[ns] = {};
    for (const [h, e] of [...tables[ns]].sort()) {
      out[ns][h] = e.spellings ? { n: e.n, first: e.first, d: e.deployers.size, v: e.spellings.size } : { n: e.n, first: e.first, d: e.deployers.size };
    }
  }
  return out;
}

const theirs = await countTheCollectorWay(pageEngine, FIXTURES);
const counted = new Tally();
for (const f of FIXTURES) await counted.addLaunch(f);
const ours = counted.frozen();

let entries = 0;
for (const ns of NAMESPACES) {
  const a = Object.keys(theirs[ns]).sort(), b = Object.keys(ours[ns]).sort();
  t.ok(a.join(",") === b.join(","), ns + ": the same hashes are in the table");
  for (const h of a) {
    const x = theirs[ns][h], y = ours[ns][h];
    t.ok(y && x.n === y.n && x.first === y.first && x.d === y.d, ns + ": n, first and d agree on " + h);
    if (ns.endsWith("_skeleton")) t.ok(x.v === y.v, ns + ": and the spelling count agrees on " + h);
    entries++;
  }
}
t.ok(entries > 15, "and that was every entry of every namespace");
t.ok(await tallyHash(theirs) === await tallyHash(ours), "so the two tables have one hash between them, which is the claim this round rests on");

// the fixtures were built to produce the two cases the counting is interesting for
const tickerTable = ours.ticker, skeletonTable = ours.ticker_skeleton;
t.ok(Object.values(tickerTable).some(e => e.n === 2 && e.d === 2), "one ticker is carried by two launches under two deployers");
t.ok(Object.values(skeletonTable).some(e => e.v >= 2), "and one skeleton group holds more than one spelling, which is what a lookalike is");
t.ok(Object.values(ours.recipient).some(e => e.n === 2), "the fee recipient is shared by two of them");
t.ok(Object.keys(ours.description).length === 1, "the short description was not compared, and the empty one was not either");

// ---------------------------------------------------------------- the canonical bytes
t.ok(tallyText(ours) === tallyText(theirs), "the canonical text is the same text");
const shuffled = {};
for (const ns of [...NAMESPACES].reverse()) {
  shuffled[ns] = {};
  for (const h of Object.keys(ours[ns]).sort().reverse()) shuffled[ns][h] = ours[ns][h];
}
t.ok(tallyText(shuffled) === tallyText(ours), "and it does not depend on the order the table was built in");
t.ok(/^\{"link":\{/.test(tallyText(ours)), "namespaces come in the engine's order, so the first one is the engine's first one");
t.ok(await tallyHash(shuffled) === await tallyHash(ours), "so the hash does not either");
t.ok(/^[0-9a-f]{64}$/.test(await tallyHash(ours)), "a tail hash is a whole sha256: it names an artifact rather than counting a value");

// ---------------------------------------------------------------- the tail's own rebuild
/**
 * The tail stores hashes, not strings, and the two skeleton namespaces count distinct spellings. Rebuilding a
 * table from stored rows therefore uses the exact hash where the collector uses the exact string: two launches
 * spell a ticker the same way exactly when their exact ticker hashes are equal. This asserts that equivalence
 * rather than trusting it.
 */
const rebuilt = new Tally();
for (const f of FIXTURES) addRowToTally(rebuilt, await rowOf(f), f.date, f.deployer);
t.ok(await tallyHash(rebuilt.frozen()) === await tallyHash(ours), "a table rebuilt from stored rows is the table counted from the launches");
t.ok(JSON.stringify(entryCounts(rebuilt.frozen())) === JSON.stringify(entryCounts(ours)), "namespace for namespace");

// and a row carries hashes and nothing else
const row = await rowOf(FIXTURES[0]);
const rowText = JSON.stringify(row);
t.ok(!/0x[0-9a-fA-F]{40}/.test(rowText), "a stored row carries no address");
t.ok(!/https?:|ipfs:|@[A-Za-z0-9_]{2,}/.test(rowText), "and no raw string, link or handle");
t.ok(row.hashes.link.length === LINKS.length, "the five link slots stay five, so a position still names its field");
t.ok(row.hashes.link[2] === null, "an unfilled field is a null and not a hash of nothing");

// ---------------------------------------------------------------- check(), the page's own entry point
const index = {};
for (const ns of NAMESPACES) index[ns] = {};
for (const [h, e] of Object.entries(ours.ticker)) if (e.n >= 2) index.ticker[h] = { n: e.n, d: e.d, first: e.first };
for (const [h, e] of Object.entries(ours.ticker_skeleton)) if (e.n >= 2) index.ticker_skeleton[h] = { n: e.n, d: e.d, first: e.first, v: e.v };
for (const [h, e] of Object.entries(ours.link)) if (e.n >= 2) index.link[h] = { n: e.n, d: e.d, first: e.first };

for (const f of FIXTURES) {
  const a = await pageEngine.check(engineInput(f), index);
  const b = await Engine.check(engineInput(f), index);
  t.ok(JSON.stringify(a) === JSON.stringify(b), f.symbol + ": check() answers the same through both engines");
}
const checked = await Engine.check(engineInput(FIXTURES[0]), index);
t.ok(checked.N1.state === "shared" && checked.N1.n === 2, "the shared ticker reads as shared, with the index's own count");
t.ok(checked.N3.state === "lookalike", "and the lookalike reads as a lookalike");
t.ok(checked.I4.state === "unique" || checked.I4.state === "shared", "a description over the floor is compared");
const checkedShort = await Engine.check(engineInput(FIXTURES[2]), index);
t.ok(checkedShort.I4.state === "too short to compare", "and one under it says so instead of comparing");
t.ok(checkedShort.I1.state === "empty", "a launch with no links at all says empty");
const checkedBad = await Engine.check(engineInput(FIXTURES[3]), index);
t.ok(checkedBad.I3.state === "not readable", "a recipient that is not an address says so and does not guess");

t.done();
