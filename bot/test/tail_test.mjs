// The tail, and the endpoint that hands it out.
//
// Two claims are checked here and they are the two the round rests on.
//
//   What leaves this worker is counted hashes. No address, no raw string, no handle, no link — the same rule
//   tools/launch-index.mjs enforces on the file the page reads, checked with that file's own pattern, so the
//   tail cannot become the private index the never list promises does not exist.
//
//   The tail is reproducible. It hands out a block range and a hash over the table in that range, the same
//   canonical bytes a collector run over the same blocks produces, so the promise that the repository can
//   recompute whatever the site computes survives a database whose range moves. bot/tools/verify-tail.mjs is
//   that comparison against a real collector run; what is checked here is that the hash is a function of the
//   table and of nothing else.
//
//   node test/tail_test.mjs
import worker, { forgetTailBucket } from "../src/index.js";
import { Watch, SEL_TOKEN, forgetPublished, DEFAULT_TAIL_CACHE_MS, MAX_TAIL_ROWS, MAX_PUBLISHED_FILE_BYTES, tailPageCommitment } from "../src/watch.js";
import { setGate } from "../src/chain.js";
import { Tally, tallyHash, tallyText } from "../src/tally.js";
import { addRowToTally } from "../src/watch.js";
import { NAMESPACES } from "../src/engine.js";
import { harness, fakeWatchCtx, fakeChain, fakePublished, STAND_BOT_TOKEN } from "./fakes.mjs";
import { fetchTailJson, VERIFY_TAIL_RESPONSE_LIMIT, VERIFY_TAIL_TIMEOUT_MS } from "../tools/verify-tail.mjs";

const t = harness("tail");

/** the pattern tools/launch-index.mjs greps its own output for before it will write it */
const FORBIDDEN = /0x[0-9a-fA-F]{40}|https?:|@[A-Za-z0-9_]{2,}/;

const NOW_SECONDS = 1780000000;
const NOW = NOW_SECONDS * 1000;
const SELECTORS = { name: SEL_TOKEN.name, symbol: SEL_TOKEN.symbol, info: SEL_TOKEN.info };
const DEV_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEV_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const LAUNCHES = [
  {
    token: "0x1010101010101010101010101010101010101010", curve: "0x" + "2".repeat(40), deployer: DEV_A, block: 701,
    tx: "0x" + "a".repeat(64), name: "Solana Dog", symbol: "SOLANA", logo: "ipfs://QmAbC",
    description: "a frozen index of counted hashes is what this launch is compared against and nothing here is a score",
    socials: ["@bob", "https://t.me/room", "", "https://example.com/site", ""], recipient: "0xcccccccccccccccccccccccccccccccccccccccc"
  },
  {
    token: "0x2020202020202020202020202020202020202020", curve: "0x" + "2".repeat(40), deployer: DEV_B, block: 702,
    tx: "0x" + "b".repeat(64), name: "solana dog", symbol: "SOLANA", logo: "ipfs://QmAbC",
    description: "", socials: ["https://twitter.com/bob", "", "", "", ""], recipient: "0xcccccccccccccccccccccccccccccccccccccccc"
  }
];

const NUMBERS = { window: { from_block: 1, to_block: 690, blocks: 690 } };

async function standing(numbers = NUMBERS, numbersOk = true, secondNow = NOW + 12000) {
  forgetPublished();
  const net = fakePublished({ numbers, numbersOk });
  const chain = fakeChain({ selectors: SELECTORS, head: 700, launches: LAUNCHES, timestamps: { 701: NOW_SECONDS, 702: NOW_SECONDS } });
  setGate(chain.gate);
  const ctx = fakeWatchCtx();
  const watch = new Watch(ctx, { TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN });
  await watch.tick(NOW);
  chain.head = 702;
  const result = await watch.tick(secondNow);
  return { net, chain, ctx, watch, result };
}

// ---------------------------------------------------------------- the shape, and the two block numbers
const s = await standing();
const body = await s.watch.tail(NOW + 20000);
t.ok(s.ctx.tail.length === 2, "two launches are in the tail");
t.ok(body.from_block === 701 && body.to_block === 702, "the tail states the range it covers");
t.ok(body.ok === true && body.tail_version === 1 && body.page === 1 && body.page_limit === MAX_TAIL_ROWS,
  "the bounded response declares its version, page, and authored row ceiling");
t.ok(body.more === false && body.next_cursor === null && body.previous_page_commitment === null,
  "a one-page suffix says explicitly that the committed page chain is complete");
t.ok(/^[0-9a-f]{64}$/.test(body.page_commitment) && /^[0-9a-f]{64}$/.test(body.rows_hash),
  "the page commits both its ordered public rows and its place in the chunk chain");
t.ok(body.page_commitment === await tailPageCommitment({
  snapshot: body.snapshot_to_block, started: body.watcher_started_block, startedAt: body.watcher_started_at,
  coverageFrom: body.coverage_from_block, from: body.from_block, to: body.to_block, upper: body.watcher_to_block,
  page: body.page, previous: body.previous_page_commitment, total: body.launches_in_tail,
  count: body.launches_in_page, tableHash: body.hash, rowsHash: body.rows_hash
}), "the public metadata independently recomputes the page commitment");
t.ok(body.launches_in_tail === 2, "and how many launches that is");
t.ok(typeof body.collected_at === "string" && /T.*Z$/.test(body.collected_at), "when it was built");
t.ok(/^[0-9a-f]{64}$/.test(body.hash), "and its own hash");
t.ok(body.engine === "site/launch.js", "it names the engine that counted it");
t.ok(body.depth_days === 7, "and states its configured pruning age floor");
t.ok(body.snapshot_to_block === 690, "it reads the snapshot's last block from the numbers file the page prints from");
t.ok(body.gap_blocks === 10, "and states the hole between the snapshot's end and its own start rather than implying they meet");
t.ok(Object.keys(body.tables).join(",") === NAMESPACES.join(","), "the tables are the engine's namespaces, in the engine's order");
t.ok(body.entries.ticker === 1, "one ticker entry, because both launches carry the same one");
t.ok(body.tables.ticker[Object.keys(body.tables.ticker)[0]].n === 2, "with a count of two");
t.ok(body.tables.ticker[Object.keys(body.tables.ticker)[0]].d === 2, "under two deployers");

// a numbers file that cannot be read is a null, never a zero
const noNumbers = await standing(null, false);
const bodyB = await noNumbers.watch.tail(NOW + 20000);
t.ok(bodyB.snapshot_to_block === null, "an unreadable numbers file leaves the snapshot's last block null");
t.ok(bodyB.gap_blocks === null, "and the gap null, because a gap of zero would be a claim");

// ---------------------------------------------------------------- nothing but hashes leaves the worker
const text = JSON.stringify(body);
t.ok(!FORBIDDEN.test(text), "the whole answer carries nothing that is not a counted hash, by the index writer's own pattern");
t.ok(!text.includes("SOLANA") && !text.includes("solana"), "no ticker in the clear");
t.ok(!text.includes("bob"), "no handle in the clear");
t.ok(!text.includes(LAUNCHES[0].token), "no token address");
t.ok(!text.includes(DEV_A) && !text.includes(DEV_B), "no deployer");
t.ok(!text.includes(LAUNCHES[0].tx), "no transaction");
t.ok(body.launches.every(l => Object.keys(l).join(",") === "block,date,hashes"), "a row is a block, a date and hashes, and has no fourth field to leak through");
t.ok(body.launches[0].hashes.link.length === 5, "the five link slots are kept, so a position still names its field");
t.ok(body.launches[0].hashes.link[2] === null, "and an unfilled one is a null");
t.ok(Object.values(body.launches[0].hashes).flat().filter(Boolean).every(h => /^[0-9a-f]{16}$/.test(h)), "every hash in it is sixteen hex characters and nothing else");

// the object does keep the three things it needs, and keeps them on its own side
t.ok(s.ctx.tail[0].deployer === DEV_A, "the deployer is stored, for a dev rule");
t.ok(s.ctx.tail[0].token === LAUNCHES[0].token, "and the token, to name a launch in a direct message");
t.ok(s.ctx.tail[0].tx === LAUNCHES[0].tx, "and the transaction, to link one");

// ---------------------------------------------------------------- the hash is a function of the table
const rebuilt = new Tally();
for (const l of body.launches) {
  const row = s.ctx.tail.find(r => JSON.parse(r.row).block === l.block);
  addRowToTally(rebuilt, l, row.date, row.deployer);
}
t.ok(await tallyHash(rebuilt.frozen()) === body.hash, "a table rebuilt from the rows the tail published hashes to the hash it published");
t.ok(tallyText(rebuilt.frozen()) === tallyText(body.tables), "and to the same canonical bytes");

const again = await s.watch.tail(NOW + 20000);
t.ok(again.hash === body.hash, "asking twice gives the same hash");
t.ok(again === body, "and inside the cache window it is the same answer, built once");
const later = await s.watch.tail(NOW + 20000 + DEFAULT_TAIL_CACHE_MS + 1);
t.ok(later !== body, "past the window it is built again");
t.ok(later.hash === body.hash, "and comes out identical, because nothing about it depends on when it was asked for");
t.ok(DEFAULT_TAIL_CACHE_MS === 5000, "the window is a few seconds, and a setting");

// Corrupt/incomplete skip metadata cannot be turned into a successful empty public range.
const incomplete = await standing();
incomplete.watch.set("unreadable", 1);
const incompleteBody = await incomplete.watch.tail(NOW + 30000);
t.ok(JSON.stringify(incompleteBody) === JSON.stringify({ ok: false, why: "unreadable" }), "a missing unreadable boundary fails the tail closed");
const incompleteResponse = await incomplete.watch.fetch(new Request("https://watch/tail"));
t.ok(incompleteResponse.status === 503, "the object's tail endpoint does not publish that incomplete state as success");

// External snapshot reads and Web Crypto yield the Durable Object input gate. A state mutation during either
// phase must be reflected or fenced; it may never resurrect the pre-prune coverage through the cache.
const raced = await standing();
let releaseNumbers;
let numbersEntered;
const enteredNumbers = new Promise(resolve => { numbersEntered = resolve; });
const originalNumbersRead = raced.watch.numbers.bind(raced.watch);
raced.watch.numbers = async () => {
  numbersEntered();
  await new Promise(resolve => { releaseNumbers = resolve; });
  return NUMBERS;
};
raced.watch.cached = { at: 0, body: null };
const racingTail = raced.watch.tail(NOW + 25000);
await enteredNumbers;
raced.watch.set("unreadable", 1);
raced.watch.set("last_unreadable_block", 701);
releaseNumbers();
const racedBody = await racingTail;
t.ok(racedBody.ok === true && racedBody.coverage_from_block === 702 && racedBody.launches_in_tail === 1,
  "state is captured after the fallible snapshot fetch, so an interleaved gap cannot be hidden by old coverage");
raced.watch.numbers = originalNumbersRead;

const fenced = await standing();
const realStamp = fenced.watch.tailStateStamp.bind(fenced.watch);
let stampReads = 0;
fenced.watch.tailStateStamp = () => (++stampReads === 3 ? realStamp() + ":changed" : realStamp());
fenced.watch.cached = { at: 0, body: null };
const fencedBody = await fenced.watch.tail(NOW + 26000);
t.ok(JSON.stringify(fencedBody) === JSON.stringify({ ok: false, why: "state_changed" }) && !fenced.watch.cached.body,
  "a watcher mutation across asynchronous hashing refuses the page and cannot overwrite cache invalidation");
fenced.watch.tailStateStamp = realStamp;
const afterFence = await fenced.watch.tail(NOW + 26001);
t.ok(afterFence.ok === true && afterFence.coverage_from_block === 701,
  "the request after a fenced race rebuilds from current durable state instead of a resurrected old cache entry");

// Retention and token-position conflicts are coverage boundaries too: neither may leave the old from_block
// wrapped around a table whose rows no longer represent every launch in that range.
const DAY_MS = 86400000;
const afterPrune = await standing({ window: { from_block: 1, to_block: 701, blocks: 701 } }, true, NOW + 8 * DAY_MS);
t.ok(afterPrune.result.pruned === 1 && afterPrune.watch.get("wall_pruned_through") === "701", "the fixture really removes only the snapshot-covered old row");
const prunedTail = await afterPrune.watch.tail(NOW + 8 * DAY_MS + 1);
t.ok(prunedTail.from_block === 702 && prunedTail.to_block === 702 && prunedTail.launches_in_tail === 1, "tail coverage begins after the durable prune boundary");
t.ok(prunedTail.gap_blocks === 0, "the overtaking snapshot makes that retention boundary contiguous rather than hiding a hole");

const conflicted = await standing();
const original = conflicted.chain.launches[0];
t.ok(await conflicted.watch.record({ ...original, block: 703, log_index: 9 }) === false, "the fixture creates a second factory position for one token without storing it");
conflicted.watch.set("last_block", 703);
conflicted.watch.cached = { at: 0, body: null };
const conflictTail = await conflicted.watch.tail(NOW + 30000);
t.ok(conflictTail.from_block === 704 && conflictTail.to_block === 703 && conflictTail.launches_in_tail === 0, "the unrepresentable event closes the old tail range at its block");
t.ok(conflictTail.gap_blocks === 13, "that empty suffix states the resulting gap instead of hashing a partial 701..703 table");

const capacity = await standing();
for (let i = 0; i < MAX_TAIL_ROWS; i++) {
  capacity.ctx.tail.push({ token: "capacity-" + i, block: 701, ts: NOW_SECONDS, date: "2026-05-28", deployer: DEV_A, tx: "capacity", row: "{}" });
}
capacity.watch.cached = { at: 0, body: null };
const capacityTail = await capacity.watch.tail(NOW + 30000);
t.ok(capacityTail.ok === false && capacityTail.why === "capacity" && capacityTail.block === 701 && capacityTail.page_limit === MAX_TAIL_ROWS,
  "a single block larger than one safe page fails closed without publishing a partial block");
const capacityResponse = await capacity.watch.fetch(new Request("https://watch/tail"));
t.ok(capacityResponse.status === 503 && (await capacityResponse.json()).why === "capacity",
  "the object exposes the exceptional one-block capacity boundary as a machine-readable service response");

// A normally large suffix is paged at complete block boundaries. The fixed watcher upper bound, snapshot,
// watcher epoch and previous-page commitment make all pages one stable traversal even while new beats arrive.
const paged = await standing();
const rowTemplate = JSON.parse(paged.ctx.tail[0].row);
for (let i = 0; i < MAX_TAIL_ROWS + 7; i++) {
  const block = 703 + i;
  paged.ctx.tail.push({
    token: "paged-" + String(i).padStart(6, "0"), block, ts: NOW_SECONDS, date: "2026-05-28",
    deployer: DEV_A, tx: "paged", row: JSON.stringify({ ...rowTemplate, block })
  });
}
paged.watch.set("last_block", 702 + MAX_TAIL_ROWS + 7);
paged.watch.cached = { at: 0, body: null };
const pageOne = await paged.watch.tail(NOW + 31000);
t.ok(pageOne.ok === true && pageOne.more === true && pageOne.launches_in_page === MAX_TAIL_ROWS && !!pageOne.next_cursor,
  "more than one thousand retained rows become a bounded first page instead of making the normal tail unavailable");
t.ok(pageOne.to_block < pageOne.watcher_to_block && pageOne.current_watcher_to_block === pageOne.watcher_to_block,
  "the first page fixes one upper block while exposing that its own range ends earlier");
const pageTwo = await paged.watch.tail(NOW + 31001, { cursor: pageOne.next_cursor });
t.ok(pageTwo.ok === true && pageTwo.page === 2 && pageTwo.more === false && pageTwo.next_cursor === null,
  "the opaque cursor reaches the last bounded page");
t.ok(pageTwo.from_block === pageOne.to_block + 1 && pageTwo.watcher_to_block === pageOne.watcher_to_block &&
  pageTwo.previous_page_commitment === pageOne.page_commitment,
  "pages are adjacent, retain one watcher upper bound, and chain through the prior commitment");
t.ok(pageOne.launches_in_page + pageTwo.launches_in_page === pageOne.launches_in_tail &&
  pageTwo.launches_in_tail === pageOne.launches_in_tail,
  "the committed pages account for the complete fixed suffix exactly once");
t.ok([...pageOne.launches, ...pageTwo.launches].every((row, i, all) => i === 0 || row.block >= all[i - 1].block),
  "the public rows remain in canonical block order across the page boundary");
const boundedSelects = paged.ctx.storage.sql.calls.filter(call => /FROM tail WHERE block >= \? AND block <= \? ORDER BY block, token LIMIT \?/.test(call.stmt));
t.ok(boundedSelects.length === 2 && boundedSelects.every(call => call.args[2] === MAX_TAIL_ROWS + 1),
  "each page asks SQLite for only one bounded look-ahead row rather than materializing the retained suffix");

const tampered = pageOne.next_cursor.slice(0, -1) + (pageOne.next_cursor.endsWith("0") ? "1" : "0");
const tamperedResponse = await paged.watch.fetch(new Request("https://watch/tail?cursor=" + encodeURIComponent(tampered)));
t.ok(tamperedResponse.status === 400 && (await tamperedResponse.json()).why === "cursor",
  "an altered authenticated cursor cannot skip or reorder a committed page");
const originalNumbers = paged.net.numbers;
paged.net.numbers = { window: { from_block: 1, to_block: 691, blocks: 691 } };
paged.net.manifest = null;
forgetPublished();
paged.watch.cached = { at: 0, body: null };
const snapshotStale = await paged.watch.fetch(new Request("https://watch/tail?cursor=" + encodeURIComponent(pageOne.next_cursor)));
t.ok(snapshotStale.status === 409 && (await snapshotStale.json()).why === "reset_required",
  "a cursor cannot cross a newly published snapshot generation");
paged.net.numbers = originalNumbers;
paged.net.manifest = null;
forgetPublished();
const staleCursor = pageOne.next_cursor;
paged.watch.set("last_unreadable_block", pageOne.from_block);
paged.watch.set("unreadable", 1);
paged.watch.cached = { at: 0, body: null };
const staleResponse = await paged.watch.fetch(new Request("https://watch/tail?cursor=" + encodeURIComponent(staleCursor)));
t.ok(staleResponse.status === 409 && (await staleResponse.json()).why === "reset_required",
  "a cursor whose coverage epoch changed gets an explicit reset instead of a mixed-generation page");

const preGap = await standing();
preGap.watch.set("unreadable", 1);
preGap.watch.set("last_unreadable_block", 701);
for (let i = 0; i <= MAX_TAIL_ROWS; i++) {
  preGap.ctx.tail.push({ token: "pre-gap-" + i, block: 701, ts: NOW_SECONDS, date: "2026-05-28", deployer: DEV_A, tx: "pre-gap", row: "{}" });
}
preGap.watch.cached = { at: 0, body: null };
const boundedSuffix = await preGap.watch.tail(NOW + 30000);
t.ok(boundedSuffix.launches_in_tail === 1 && boundedSuffix.from_block === 702,
  "rows behind a declared gap do not consume or poison the bounded suffix materialization");
t.ok(preGap.ctx.storage.sql.statements.some(stmt => /FROM tail WHERE block >= \? AND block <= \? ORDER BY/.test(stmt)),
  "the same block predicate bounds the SQLite SELECT itself instead of filtering an unbounded result in JavaScript");

// Pruning is also one bounded storage batch. Removing some covered rows immediately closes their old coverage;
// later beats continue draining without one invocation selecting the full retained corpus.
const pruning = await standing({ window: { from_block: 1, to_block: 5000, blocks: 5000 } });
const pruneTemplate = JSON.parse(pruning.ctx.tail[0].row);
pruning.ctx.tail.splice(0, pruning.ctx.tail.length);
for (let i = 0; i < MAX_TAIL_ROWS + 3; i++) {
  pruning.ctx.tail.push({
    token: "prune-" + i, block: 701 + i, ts: 1, date: "1970-01-01", deployer: DEV_A, tx: "prune",
    row: JSON.stringify({ ...pruneTemplate, block: 701 + i })
  });
}
const prunedFirst = await pruning.watch.prune(NOW + 8 * DAY_MS);
t.ok(prunedFirst === MAX_TAIL_ROWS && pruning.ctx.tail.length === 3,
  "one prune call deletes only the authored batch even when more covered rows are eligible");
const prunedSecond = await pruning.watch.prune(NOW + 8 * DAY_MS + 1);
t.ok(prunedSecond === 3 && pruning.ctx.tail.length === 0,
  "a later beat drains the next prune batch without losing the durable coverage boundary");
t.ok(pruning.ctx.storage.sql.calls.filter(call => /SELECT token FROM tail WHERE ts < \? AND block <= \?.*LIMIT \?/.test(call.stmt))
  .every(call => call.args[2] === MAX_TAIL_ROWS), "the prune bound is enforced by SQLite LIMIT, not a JavaScript slice");

// ---------------------------------------------------------------- the route
const envWith = watchObject => ({ TAIL_CACHE_MS: "5000", TAIL_PER_SECOND: "100", WATCH: { idFromName: () => "one", get: () => watchObject } });
let forwardedTail = null;
const stub = { async fetch(input) { forwardedTail = String(input); return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); } };
const ctxOf = () => ({ waitUntil() {} });

let res = await worker.fetch(new Request("https://chain.lintcha.com/api/tail"), envWith(stub), ctxOf());
t.ok(res.status === 200, "GET /api/tail answers");
t.ok(res.headers.get("content-type") === "application/json", "as json");
t.ok(/max-age=5/.test(res.headers.get("cache-control") || ""), "cached for the same few seconds the object holds it for");
t.ok((await res.json()).hash === body.hash, "and hands out what the object built");

res = await worker.fetch(new Request("https://chain.lintcha.com/api/tail?cursor=opaque_page"), envWith(stub), ctxOf());
t.ok(res.status === 200 && forwardedTail === "https://watch/tail?cursor=opaque_page",
  "the public route forwards one opaque cursor without interpreting or dropping it");

const staleStub = { async fetch() { return new Response(JSON.stringify({ ok: false, why: "reset_required" }), { status: 409, headers: { "content-type": "application/json" } }); } };
res = await worker.fetch(new Request("https://chain.lintcha.com/api/tail?cursor=stale"), envWith(staleStub), ctxOf());
t.ok(res.status === 409 && (await res.json()).why === "reset_required" && res.headers.get("cache-control") === "no-store",
  "the public route preserves the cursor upgrade/reset response instead of masking it as no_tail");

res = await worker.fetch(new Request("https://chain.lintcha.com/api/tail", { method: "POST" }), envWith(stub), ctxOf());
t.ok(res.status === 405, "posting to it is refused");

res = await worker.fetch(new Request("https://chain.lintcha.com/api/tail"), { TAIL_PER_SECOND: "100" }, ctxOf());
t.ok(res.status === 503, "with no watcher bound it says so rather than answering an empty tail");

res = await worker.fetch(new Request("https://chain.lintcha.com/api/taily"), envWith(stub), ctxOf());
t.ok(res.status === 404, "and nothing near it answers by accident");

// the courtesy limit, which is per isolate and says so in the code
forgetTailBucket();
const tight = { TAIL_PER_SECOND: "1", WATCH: envWith(stub).WATCH };
const first = await worker.fetch(new Request("https://chain.lintcha.com/api/tail"), tight, ctxOf());
const second = await worker.fetch(new Request("https://chain.lintcha.com/api/tail"), tight, ctxOf());
t.ok(first.status === 200 && second.status === 429, "past the limit one isolate answers too many requests rather than working through them");

// The manual verifier treats the public endpoint as an external byte stream: one deadline and one fixed ceiling
// cover both the response headers and every body chunk before JSON can reach the comparison below.
const tailFixtureBytes = new TextEncoder().encode(JSON.stringify({ ok: true, tail_version: 1 }));
const noTimer = () => 1;
const noClear = () => {};
const fetchedFixture = await fetchTailJson(new URL("https://tail.example.invalid"), {
  fetchImpl: async () => new Response(tailFixtureBytes, {
    status: 200,
    headers: { "content-length": String(tailFixtureBytes.byteLength), "content-type": "application/json" }
  }),
  limit: tailFixtureBytes.byteLength,
  setTimer: noTimer,
  clearTimer: noClear
});
t.ok(fetchedFixture.ok === true && fetchedFixture.tail_version === 1,
  "verify-tail accepts an exact bounded JSON response");

let declaredCancelled = false;
const declaredLimit = tailFixtureBytes.byteLength;
const declaredFailure = await fetchTailJson(new URL("https://tail.example.invalid"), {
  fetchImpl: async () => new Response(new ReadableStream({
    cancel() { declaredCancelled = true; return new Promise(() => {}); }
  }), {
    status: 200,
    headers: { "content-length": String(declaredLimit + 1) }
  }),
  limit: declaredLimit,
  setTimer: noTimer,
  clearTimer: noClear
}).then(() => null, error => error.message);
t.ok(declaredFailure === "the tail response content-length is invalid" && declaredCancelled,
  "verify-tail rejects a declared oversized response without awaiting cancellation");

let overflowCancelled = false;
const overflowFailure = await fetchTailJson(new URL("https://tail.example.invalid"), {
  fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(declaredLimit + 1)); },
    cancel() { overflowCancelled = true; return new Promise(() => {}); }
  }), { status: 200 }),
  limit: declaredLimit,
  setTimer: noTimer,
  clearTimer: noClear
}).then(() => null, error => error.message);
t.ok(overflowFailure === "the tail response body exceeds its bound" && overflowCancelled,
  "verify-tail rejects streamed overflow without awaiting reader cancellation");

const truncatedFailure = await fetchTailJson(new URL("https://tail.example.invalid"), {
  fetchImpl: async () => new Response(tailFixtureBytes, {
    status: 200,
    headers: { "content-length": String(tailFixtureBytes.byteLength + 1) }
  }),
  limit: tailFixtureBytes.byteLength + 1,
  setTimer: noTimer,
  clearTimer: noClear
}).then(() => null, error => error.message);
t.ok(truncatedFailure === "the tail response content-length does not match its body",
  "verify-tail requires a declared byte count to match the complete body");

let fetchDeadline = null;
let fetchDeadlineMs = null;
let fetchAborted = false;
const hangingFetch = fetchTailJson(new URL("https://tail.example.invalid"), {
  fetchImpl: async (_url, options) => await new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      fetchAborted = true;
      reject(new Error("aborted"));
    }, { once: true });
  }),
  setTimer(fn, ms) { fetchDeadline = fn; fetchDeadlineMs = ms; return 2; },
  clearTimer: noClear
});
await Promise.resolve();
fetchDeadline();
const fetchDeadlineFailure = await hangingFetch.then(() => null, error => error.message);
t.ok(fetchDeadlineFailure === "the tail response deadline expired" && fetchAborted &&
  fetchDeadlineMs === VERIFY_TAIL_TIMEOUT_MS && VERIFY_TAIL_RESPONSE_LIMIT === MAX_PUBLISHED_FILE_BYTES,
  "verify-tail aborts a hanging fetch at the shared authored deadline and byte ceiling");

let bodyDeadline = null;
let bodyReadStarted = false;
let bodyCancelled = false;
const hangingBody = fetchTailJson(new URL("https://tail.example.invalid"), {
  fetchImpl: async () => new Response(new ReadableStream({
    pull() { bodyReadStarted = true; return new Promise(() => {}); },
    cancel() { bodyCancelled = true; return new Promise(() => {}); }
  }), { status: 200 }),
  setTimer(fn) { bodyDeadline = fn; return 3; },
  clearTimer: noClear
});
for (let i = 0; i < 20 && (!bodyDeadline || !bodyReadStarted); i++) await Promise.resolve();
bodyDeadline();
const bodyDeadlineFailure = await hangingBody.then(() => null, error => error.message);
t.ok(bodyDeadlineFailure === "the tail response deadline expired" && bodyReadStarted && bodyCancelled,
  "verify-tail bounds a hanging response body even when stream cancellation never settles");

t.done();
