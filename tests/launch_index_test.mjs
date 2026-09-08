// The launch index (site/launch-index.json) against its schema (tools/launch-index-schema.json) through the
// checker in tools/launch/schema.mjs: the shipped file passes; a file with one extra field, a short key, a count of
// one, a fee recipient under one deployer or a non-date first fails; the writer is deterministic and honours the
// count floor and the size ceiling; site/launch-numbers.json carries the figures the page prints and agrees with
// the engine's own constants and with the index.
//   node tests/launch_index_test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { validate } from "../tools/launch/schema.mjs";
import { buildIndex, buildNumbers } from "../tools/launch-index.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const L = require(path.join(root, "site", "launch.js"));
let checks = 0, failures = 0;
const fail = m => { failures++; console.error("FAIL " + m); };
const ok = (cond, what) => { checks++; if (!cond) fail(what); };
const clone = o => JSON.parse(JSON.stringify(o));

const schema = JSON.parse(fs.readFileSync(path.join(root, "tools", "launch-index-schema.json"), "utf8"));
const indexText = fs.readFileSync(path.join(root, "site", "launch-index.json"), "utf8");
const index = JSON.parse(indexText);
const numbers = JSON.parse(fs.readFileSync(path.join(root, "site", "launch-numbers.json"), "utf8"));

// ---------------------------------------------------------------- the shipped index passes, and only hash, n, d, first exist at any level
ok(validate(schema, index).length === 0, "shipped index passes its schema: " + validate(schema, index).slice(0, 3).join("; "));
ok(Object.keys(index).sort().join() === [...L.NAMESPACES].sort().join(), "exactly the eight namespaces");
let entries = 0; const fields = {};
for (const ns of L.NAMESPACES) { fields[ns] = new Set(); for (const [h, e] of Object.entries(index[ns])) { entries++; Object.keys(e).forEach(k => fields[ns].add(k)); if (!/^[0-9a-f]{16}$/.test(h)) fail("key is not sixteen hex: " + h); } }
checks++;
ok(L.NAMESPACES.filter(ns => !ns.endsWith("_skeleton")).every(ns => [...fields[ns]].sort().join() === "d,first,n"), "no field beyond n, d, first on the six plain namespaces");
ok(L.NAMESPACES.filter(ns => ns.endsWith("_skeleton")).every(ns => [...fields[ns]].sort().join() === "d,first,n,v"), "exactly n, d, first, v on the two skeleton namespaces");
ok(["ticker_skeleton", "name_skeleton"].every(ns => Object.values(index[ns]).every(e => Number.isInteger(e.v) && e.v >= 1 && e.v <= e.n)), "v is an integer from one up to n");
ok(Object.values(index.ticker_skeleton).filter(e => e.v >= 2).length === numbers.lookalike_ticker_groups, "lookalike ticker groups in the index equal the figure in the numbers file");
ok(L.NAMESPACES.every(ns => Object.values(index[ns]).every(e => e.n >= 2)), "count floor: no entry under two");
ok(Object.values(index.recipient).every(e => e.d >= 2), "fee recipient: only values carried by more than one deployer");
ok(L.NAMESPACES.every(ns => Object.values(index[ns]).every(e => e.d <= e.n)), "deployers never exceed launches");
ok(!/0x[0-9a-fA-F]{40}/.test(indexText) && !/https?:/.test(indexText), "no address and no url in the file");
ok(indexText.length <= 1500000, "under the size ceiling: " + indexText.length);
ok(indexText.endsWith("}\n") && indexText.indexOf("\n") === indexText.length - 1, "compact, one line, newline at the end");
for (const ns of L.NAMESPACES) { const k = Object.keys(index[ns]); ok(k.every((h, i) => i === 0 || k[i - 1] < h), ns + ": keys sorted"); }

// ---------------------------------------------------------------- negatives: each must fail
const withExtra = clone(index); withExtra.link[Object.keys(withExtra.link)[0]].value = "x.com/bob";
ok(validate(schema, withExtra).some(p => p.includes("field not allowed")), "an extra field on an entry fails");
const withTop = clone(index); withTop.launches = [];
ok(validate(schema, withTop).some(p => p.includes("field not allowed")), "an extra top-level field fails");
const shortKey = clone(index); shortKey.ticker["abc"] = { n: 2, d: 1, first: "2026-09-07" };
ok(validate(schema, shortKey).some(p => p.includes("key does not match")), "a key that is not sixteen hex fails");
const one = clone(index); one.name[Object.keys(one.name)[0]].n = 1;
ok(validate(schema, one).some(p => p.includes("below minimum 2")), "a count of one fails");
const solo = clone(index); solo.recipient[Object.keys(solo.recipient)[0]].d = 1;
ok(validate(schema, solo).some(p => p.includes("below minimum 2")), "a fee recipient under one deployer fails");
const stamp = clone(index); stamp.logo[Object.keys(stamp.logo)[0]].first = "2026-09-07T10:00:00Z";
ok(validate(schema, stamp).some(p => p.includes("does not match")), "a timestamp instead of a date fails");
const missing = clone(index); delete missing.description;
ok(validate(schema, missing).some(p => p.includes("missing description")), "a missing namespace fails");
const float = clone(index); float.ticker[Object.keys(float.ticker)[0]].n = 2.5;
ok(validate(schema, float).some(p => p.includes("expected integer")), "a non-integer count fails");
const vPlain = clone(index); vPlain.ticker[Object.keys(vPlain.ticker)[0]].v = 2;
ok(validate(schema, vPlain).some(p => p.includes(".v: field not allowed")), "v on a non-skeleton entry fails");
const vLow = clone(index); vLow.ticker_skeleton[Object.keys(vLow.ticker_skeleton)[0]].v = 0;
ok(validate(schema, vLow).some(p => p.includes(".v: below minimum 1")), "v below one fails");
const vGone = clone(index); delete vGone.name_skeleton[Object.keys(vGone.name_skeleton)[0]].v;
ok(validate(schema, vGone).some(p => p.includes("missing v")), "v missing on a skeleton entry fails");
const vFloat = clone(index); vFloat.ticker_skeleton[Object.keys(vFloat.ticker_skeleton)[0]].v = 1.5;
ok(validate(schema, vFloat).some(p => p.includes(".v: expected integer")), "v not an integer fails");
let threw = false; try { validate({ type: "object", oneOf: [] }, {}); } catch { threw = true; }
ok(threw, "the checker refuses a keyword it does not implement, so nothing in the schema is silently ignored");

// ---------------------------------------------------------------- the writer: floor, recipient rule, determinism
const collected = { tables: {}, window: { from: 1, to: 2, blocks: 2, from_time: "2026-09-07T10:36:34.000Z", to_time: "2026-09-08T10:36:34.000Z", chain_id: 4663 },
  six: { launches_scanned: 3, launches_with_a_link: { count: 2, share: 66.7 }, distinct_link_values: { folded: 2, raw: 3 }, link_values_by_more_than_one_deployer: { folded: 1, raw: 1 }, tickers_by_more_than_one_deployer: 1, lookalike_ticker_pairs: { pairs: 0, skeleton_groups: 0 } },
  also: { names_by_more_than_one_deployer: 0, logos_by_more_than_one_deployer: 0, recipients_by_more_than_one_deployer: 1, descriptions_compared: 0, descriptions_by_more_than_one_deployer: 0, lookalike_ticker_groups_v: 1, lookalike_name_groups: 0 },
  verified: { launches_in_log: 3, tokens_readable: 3 }, limiter: { calls: 9, http429: 0, rpc429: 0, retries: 0, otherErrors: 0, seconds: 4, lastAt: Date.parse("2026-09-08T10:40:00Z") } };
for (const ns of L.NAMESPACES) collected.tables[ns] = {};
collected.tables.ticker["b".repeat(16)] = { n: 2, d: 2, first: "2026-09-07" };
collected.tables.ticker_skeleton["e".repeat(16)] = { n: 2, d: 2, first: "2026-09-07", v: 2 };
collected.tables.ticker_skeleton["f".repeat(16)] = { n: 1, d: 1, first: "2026-09-07", v: 1 };
collected.tables.ticker["a".repeat(16)] = { n: 1, d: 1, first: "2026-09-07" };
collected.tables.recipient["c".repeat(16)] = { n: 3, d: 1, first: "2026-09-07" };
collected.tables.recipient["d".repeat(16)] = { n: 2, d: 2, first: "2026-09-08" };
const built = buildIndex(collected);
ok(Object.keys(built.ticker).join() === "b".repeat(16), "the writer drops a count of one");
ok(Object.keys(built.recipient).join() === "d".repeat(16), "the writer drops a recipient under one deployer even with a count of three");
ok(validate(schema, built).length === 0, "what the writer builds passes the schema: " + validate(schema, built).slice(0, 2).join("; "));
ok(Object.keys(built.ticker_skeleton).join() === "e".repeat(16) && built.ticker_skeleton["e".repeat(16)].v === 2, "the writer keeps v on a skeleton entry and applies the floor there too");
ok(!("v" in built.ticker["b".repeat(16)]), "the writer never puts v on a plain entry");
ok(JSON.stringify(buildIndex(collected)) === JSON.stringify(built), "deterministic");
const nums = buildNumbers(collected, built, 10);
ok(nums.collected === "2026-09-08" && nums.window.hours === 24 && nums.window.from_date === "2026-09-07", "numbers: collection date and window");
ok(nums.links.distinct_raw === 3 && nums.links.distinct_folded === 2, "numbers: raw and folded side by side");

// ---------------------------------------------------------------- the shipped numbers agree with the engine and the index
ok(numbers.description_min_words === L.MIN_WORDS, "numbers: the word floor is the engine's");
ok(numbers.count_floor === 2, "numbers: the count floor");
ok(numbers.chain_id === 4663, "numbers: chain id");
ok(numbers.index.entries_total === entries && L.NAMESPACES.every(ns => numbers.index.entries[ns] === Object.keys(index[ns]).length), "numbers: entry counts equal the index");
ok(numbers.index.bytes === indexText.length, "numbers: index size equals the file");
ok(numbers.window.hours === 24 && numbers.window.to_block > numbers.window.from_block && numbers.window.blocks === numbers.window.to_block - numbers.window.from_block + 1, "numbers: a twenty-four hour window with an exact block range");
ok(numbers.links.distinct_raw >= numbers.links.distinct_folded, "numbers: folding never adds distinct values");
ok(Number.isInteger(numbers.launches_scanned) && numbers.launches_scanned > 0, "numbers: launches scanned");
ok(Object.values(index.recipient).length === numbers.recipients_shared_by_more_than_one_deployer, "recipient entries equal the shared-across-deployers count");
// criterion 10 (as the owner rewrote it): every launch in the log was read and none was lost, every retry is counted, the 429
// count and the retry count are stated in the numbers file; the number is reported by tests/launch_acceptance.sh, never gated
ok(numbers.collector.launches_in_log === numbers.collector.tokens_readable && numbers.collector.launches_in_log === numbers.launches_scanned, "the run that produced the index lost no launch: every one in the log was read");
ok(Number.isInteger(numbers.collector.http_429) && Number.isInteger(numbers.collector.rpc_429), "the run's 429 counts are stated in the numbers file");
ok(Number.isInteger(numbers.collector.retries) && Number.isInteger(numbers.collector.other_errors), "the run's retry count and other-error count are stated in the numbers file");

console.log(`launch index test: ${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
