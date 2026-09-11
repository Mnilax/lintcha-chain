// The public wall: exact shape, strict snapshot suffix, deterministic order, and fail-closed metadata.
//
//   node test/wall_test.mjs
import worker, { forgetTailBucket, forgetWallBucket } from "../src/index.js";
import { Watch, SEL_TOKEN, forgetPublished, MAX_WALL_TEXT, wallRowsHash, readWallCursor, wallPageOf } from "../src/watch.js";
import { setGate } from "../src/chain.js";
import { harness, fakeWatchCtx, fakeChain, fakePublished, STAND_BOT_TOKEN } from "./fakes.mjs";

const t = harness("wall");
const NOW = 1780000000000;
const SELECTORS = { name: SEL_TOKEN.name, symbol: SEL_TOKEN.symbol, info: SEL_TOKEN.info };
const DEV = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const token = n => "0x" + String(n).padStart(2, "0").repeat(20);
const launch = (n, block, logIndex, name, ticker) => ({
  token: token(n), curve: "0x" + "2".repeat(40), deployer: DEV, block, logIndex,
  tx: "0x" + BigInt(n).toString(16).padStart(64, "0"), name, symbol: ticker, logo: "", description: "",
  socials: ["", "", "", "", ""]
});
const validNumbers = to => ({ window: { from_block: 1, to_block: to, blocks: to } });

async function standing({ numbers = validNumbers(701), numbersOk = true, launches, head = 700, wallPageRows } = {}) {
  forgetPublished();
  fakePublished({ numbers, numbersOk });
  const list = launches || [
    launch(1, 701, 9, "at boundary", "OLD"),
    launch(2, 702, 4, "second", "TWO"),
    launch(3, 702, 1, 'quote " slash \\ <tag>', "ONE"),
    launch(4, 703, 0, "third", "THREE"),
    launch(5, 703, 2, "x".repeat(MAX_WALL_TEXT + 1), "TOO-LONG"),
    launch(6, 703, 3, "unsafe\nname", "CONTROL"),
    launch(7, 703, 4, "bidi\u202eoverride", "FORMAT")
  ];
  const chain = fakeChain({ selectors: SELECTORS, head, launches: list, timestamps: { 701: 1780000000, 702: 1780000000, 703: 1780000000 } });
  setGate(chain.gate);
  const ctx = fakeWatchCtx();
  const watch = new Watch(ctx, { TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN, ...(wallPageRows ? { WALL_PAGE_ROWS: String(wallPageRows) } : {}) });
  await watch.tick(NOW);
  if (head === 700) {
    chain.head = 701;
    await watch.tick(NOW + 4000);
    chain.head = 702;
    await watch.tick(NOW + 8000);
    chain.head = 703;
    await watch.tick(NOW + 12000);
  }
  return { chain, ctx, watch };
}

// Exact success shape and rows. The launch at the boundary is excluded; same-block rows use log index.
const s = await standing();
const body = await s.watch.wall(NOW + 20000);
const expectedRows = [
  { name: 'quote " slash \\ <tag>', ticker: "ONE" },
  { name: "second", ticker: "TWO" },
  { name: "third", ticker: "THREE" }
];
t.ok(Object.keys(body).join(",") === "ok,snapshot_to_block,gap_blocks,watcher_to_block,read_at,page_limit,mode,older_cursor,live_cursor,rows_hash,view_hash,rows", "success has the exact public keys");
t.ok(body.ok === true && body.snapshot_to_block === 701 && body.gap_blocks === 0 && body.watcher_to_block === 703, "boundary, startup gap, and watcher cursor are explicit");
t.ok(body.read_at === new Date(NOW + 12000).toISOString(), "read_at is the saved watcher round time, not request time");
t.ok(body.mode === "latest" && body.page_limit > 0 && body.older_cursor === null && !!readWallCursor(body.live_cursor), "the first bounded page has a live coverage cursor and no invented older page");
t.ok(JSON.stringify(body.rows) === JSON.stringify(expectedRows), "only the strict suffix is returned, ordered by block then log index, with unsafe declarations omitted");
t.ok(body.rows.every(row => Object.keys(row).join(",") === "name,ticker" && typeof row.name === "string" && typeof row.ticker === "string"), "each row is exactly two strings");
t.ok(body.rows_hash === await wallRowsHash(expectedRows), "rows_hash is reproducible from exact public JSON rows");
t.ok(body.view_hash === body.rows_hash, "a full page's visible hash is its response rows hash");
t.ok(JSON.parse(JSON.stringify(body)).rows[0].name === expectedRows[0].name, "quotes and backslashes survive JSON escaping without changing the declaration");
s.watch.set("last_round_at", Date.now());
s.watch.wallCached = { at: 0, body: null };
let objectRes = await s.watch.fetch(new Request("https://watch/wall"));
t.ok(objectRes.status === 200 && (await objectRes.json()).ok === true, "the durable-object wall endpoint returns a fresh validated success");

const stored = s.ctx.tail.map(row => JSON.parse(row.row));
t.ok(stored.some(row => row.wall && row.wall.name === "second" && row.wall.ticker === "TWO" && row.wall.log_index === 4), "bounded cleartext and log index live inside the existing JSON row");
t.ok(stored.some(row => row.wall && row.wall.name === null), "an overlong or control-bearing name is stored as absent, never truncated into a different name");
t.ok(!JSON.stringify(body.rows).includes("override"), "format controls such as bidi overrides are not publishable");

// Bounded history is contiguous and live reads carry only the delta after a coverage cursor.
const paged = await standing({ wallPageRows: 2 });
const newest = await paged.watch.wall(NOW + 20000);
t.ok(newest.rows.length === 2 && newest.older_cursor !== null, "the newest response is bounded and names an earlier page when one exists");
const earlier = await paged.watch.wall(NOW + 20000, { mode: "before", cursor: newest.older_cursor });
t.ok(earlier.ok === true && earlier.mode === "before" && earlier.live_cursor === null, "a history cursor answers one non-live page");
t.ok(JSON.stringify(earlier.rows.concat(newest.rows)) === JSON.stringify(expectedRows), "repeated history pages preserve the complete factory order without overlap");
t.ok(earlier.older_cursor === null, "the oldest page says when no earlier publishable row remains");

paged.chain.launches.push(launch(8, 704, 0, "fourth", "FOUR"));
paged.chain.timestamps[704] = 1780000001;
paged.chain.head = 704;
await paged.watch.tick(NOW + 24000);
let delta = await paged.watch.wall(NOW + 25000, { mode: "after", cursor: newest.live_cursor });
t.ok(delta.ok === true && delta.mode === "after" && JSON.stringify(delta.rows) === JSON.stringify([{ name: "fourth", ticker: "FOUR" }]), "a live cursor returns only the new publishable declaration");
t.ok(delta.rows_hash === await wallRowsHash(delta.rows), "the delta carries its own reproducible hash");
t.ok(delta.view_hash === await wallRowsHash([{ name: "third", ticker: "THREE" }, { name: "fourth", ticker: "FOUR" }]), "and the expected bounded visible page is hashed before a client changes its DOM");

const afterFour = delta.live_cursor;
paged.chain.launches.push(launch(9, 705, 0, "unsafe\nname", "HIDDEN"));
paged.chain.timestamps[705] = 1780000002;
paged.chain.head = 705;
await paged.watch.tick(NOW + 36000);
delta = await paged.watch.wall(NOW + 37000, { mode: "after", cursor: afterFour });
t.ok(delta.ok === true && delta.rows.length === 0 && delta.live_cursor !== afterFour, "an all-filtered delta still advances the complete coverage cursor");
t.ok(delta.view_hash === await wallRowsHash([{ name: "third", ticker: "THREE" }, { name: "fourth", ticker: "FOUR" }]), "a filtered event does not change the verified visible page");

// The private tail is token-keyed. A literal retry at the same factory position is harmless, but seeing the
// same token address at another position cannot be represented there and must close the public wall.
const repeated = await standing();
const firstStored = repeated.ctx.tail.find(row => Number(row.block) === 702);
const sameFixture = repeated.chain.launches.find(row => row.token === firstStored.token);
const sameEvent = (await repeated.watch.launchesIn(sameFixture.block, sameFixture.block)).find(row => row.token === sameFixture.token);
const sameFields = await repeated.watch.readLaunch(sameEvent);
const sameLaunch = { ...sameEvent, ...sameFields, ts: Number(firstStored.ts), date: firstStored.date };
t.ok(await repeated.watch.record(sameLaunch) === false && repeated.watch.get("wall_index_error_block") === null, "an exact factory-position retry stays idempotent");
const conflictingLaunch = { ...sameLaunch, block: 704, log_index: 8 };
t.ok(await repeated.watch.record(conflictingLaunch) === false && repeated.watch.get("wall_index_error_block") === "704", "a repeated token at a different factory position records a fail-closed boundary");
repeated.watch.set("last_block", 704);
repeated.watch.set("observed_finalized", 704);
repeated.watch.set("last_round_at", NOW + 24000);
const conflictFailure = await repeated.watch.wall(NOW + 25000);
t.ok(JSON.stringify(conflictFailure) === JSON.stringify({ ok: false, why: "backfill" }), "the unrepresentable repeated-token event cannot disappear from a successful wall");

const overflow = await standing({ wallPageRows: 2 });
const overflowBase = await overflow.watch.wall(NOW + 20000);
overflow.chain.launches.push(launch(10, 704, 0, "four", "FOUR"), launch(11, 704, 1, "five", "FIVE"), launch(12, 704, 2, "six", "SIX"));
overflow.chain.timestamps[704] = 1780000001;
overflow.chain.head = 704;
await overflow.watch.tick(NOW + 24000);
const reset = await overflow.watch.wall(NOW + 25000, { mode: "after", cursor: overflowBase.live_cursor });
t.ok(JSON.stringify(reset) === JSON.stringify({ ok: false, why: "reset_required" }), "a delta over the page bound asks for one fresh bounded page instead of an unbounded catch-up loop");
t.ok((await paged.watch.wall(NOW + 37000, { mode: "after", cursor: newest.older_cursor })).why === "reset_required", "a history cursor cannot be used as a live cursor");
t.ok((await paged.watch.wall(NOW + 37000, { mode: "before", cursor: newest.live_cursor })).why === "cursor", "a live cursor cannot be used as a history cursor");
t.ok(wallPageOf(new URLSearchParams("before=a&after=b")) === null && wallPageOf(new URLSearchParams("limit=2")) === null, "mixed, repeated or unknown wall query parameters are refused");

// The old endpoint must project that additive private row data away, at both levels.
const tail = await s.watch.tail(NOW + 20000);
t.ok(Object.keys(tail).join(",") === "ok,tail_version,engine,watcher_started_block,watcher_started_at,coverage_from_block,from_block,to_block,watcher_to_block,current_watcher_to_block,page,page_limit,previous_page_commitment,page_commitment,more,next_cursor,collected_at,depth_days,snapshot_to_block,gap_blocks,launches_in_tail,launches_in_page,entries,hash,rows_hash,tables,launches", "/api/tail adds only the explicit bounded-page and commitment keys");
t.ok(tail.launches.every(row => Object.keys(row).join(",") === "block,date,hashes"), "and its exact hash-only launch-row keys");
t.ok(!JSON.stringify(tail).includes("second") && !JSON.stringify(tail).includes("THREE"), "wall cleartext cannot leak through tail");

// Fail closed when the published boundary or watcher state cannot establish a fresh complete suffix.
let bad = await standing({ numbersOk: false });
let failure = await bad.watch.wall(NOW + 20000);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "snapshot" }), "unreadable numbers fail closed");
objectRes = await bad.watch.fetch(new Request("https://watch/wall"));
t.ok(objectRes.status === 503 && (await objectRes.json()).ok === false, "durable-object failures are HTTP 503, not 200 with empty facts");

bad = await standing({ numbers: { window: { from_block: 1, to_block: "701", blocks: 701 } } });
failure = await bad.watch.wall(NOW + 20000);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "snapshot" }), "invalid or unsafe numbers fail closed");

bad = await standing({ numbers: validNumbers(704), launches: [] });
failure = await bad.watch.wall(NOW + 20000);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "behind" }), "a watcher behind the snapshot boundary is not presented as an empty wall");

bad = await standing();
bad.watch.set("last_block", "not-a-block");
failure = await bad.watch.wall(NOW + 20000);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "watcher" }), "an invalid watcher cursor fails closed");

bad = await standing();
failure = await bad.watch.wall(NOW + 12000 + bad.watch.watchdogMs());
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "stale" }), "a stale last_round_at fails closed");

bad = await standing();
bad.watch.set("observed_finalized", 704);
failure = await bad.watch.wall(NOW + 20000);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "backlog" }), "a cursor behind the last observed finalized block fails closed");

bad = await standing();
bad.watch.set("unreadable", 1);
failure = await bad.watch.wall(NOW + 20000);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "unreadable" }), "known skipped launches fail closed");

bad = await standing();
bad.watch.set("last_unreadable_block", "invalid");
failure = await bad.watch.wall(NOW + 20000);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "unreadable" }), "a malformed skip marker cannot be interpreted as no skipped launch");

bad = await standing();
bad.watch.set("wall_index_error_block", "invalid");
failure = await bad.watch.wall(NOW + 20000);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "backfill" }), "a malformed structural-error marker cannot be interpreted as no conflict");

bad = await standing();
bad.watch.set("unreadable", 1);
bad.watch.set("last_unreadable_block", 700);
failure = await bad.watch.wall(NOW + 20000);
t.ok(failure.ok === true, "an old unreadable launch no longer blocks the wall after the snapshot overtakes it");

bad = await standing();
bad.watch.set("unreadable", 1);
bad.watch.set("last_unreadable_block", 702);
failure = await bad.watch.wall(NOW + 20000);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "unreadable" }), "an unreadable launch inside the suffix fails closed");

bad = await standing();
let legacyTail = bad.ctx.tail.find(row => Number(row.block) > 701);
bad.ctx.wallEvents.splice(bad.ctx.wallEvents.findIndex(row => row.token === legacyTail.token), 1);
legacyTail.row = "{";
bad.watch.wallCached = { at: 0, body: null };
failure = await bad.watch.wall(NOW + 20000);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "backfill" }), "a malformed stored post-snapshot row cannot disappear silently");

bad = await standing();
legacyTail = bad.ctx.tail.find(row => Number(row.block) > 701);
bad.ctx.wallEvents.splice(bad.ctx.wallEvents.findIndex(row => row.token === legacyTail.token), 1);
const legacy = JSON.parse(legacyTail.row);
delete legacy.wall;
legacyTail.row = JSON.stringify(legacy);
bad.watch.wallCached = { at: 0, body: null };
failure = await bad.watch.wall(NOW + 20000);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "backfill" }), "a post-snapshot row from older code cannot disappear silently");

bad = await standing({ wallPageRows: 2 });
bad.ctx.wallEvents.splice(0);
bad.watch.wallCached = { at: 0, key: null, body: null };
failure = await bad.watch.wall(NOW + 20000);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "migrating" }), "legacy suffix indexing is bounded and exposes no partial first page");
failure = await bad.watch.wall(NOW + 20001);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "migrating" }), "a second bounded migration step remains fail closed while rows are missing");
failure = await bad.watch.wall(NOW + 20002);
t.ok(failure.ok === true && failure.rows.length <= 2, "the bounded page opens only after every legacy suffix event has a positional record");

// Time-based retention must never punch a silent hole in a snapshot suffix. At eight days every fixture row
// is old, but only the boundary row is covered by the published snapshot and therefore eligible for pruning.
bad = await standing();
const pruneNow = NOW + 8 * 86400000;
const suffixBeforePrune = bad.ctx.tail.filter(row => Number(row.block) > 701).length;
const coveredWallBeforePrune = bad.ctx.wallEvents.filter(row => Number(row.block) <= 701).length;
const pruned = await bad.watch.prune(pruneNow);
const suffixAfterPrune = bad.ctx.tail.filter(row => Number(row.block) > 701).length;
bad.watch.set("last_round_at", pruneNow);
bad.watch.wallCached = { at: 0, body: null };
failure = await bad.watch.wall(pruneNow);
t.ok(pruned === 1 && suffixBeforePrune > 0 && suffixAfterPrune === suffixBeforePrune, "retention removes only old rows the snapshot already covers");
t.ok(coveredWallBeforePrune === 1 && bad.ctx.wallEvents.every(row => Number(row.block) > 701), "retention removes the matching positional wall event too");
t.ok(failure.ok === true && JSON.stringify(failure.rows) === JSON.stringify(expectedRows), "an overdue snapshot cannot turn a pruned suffix into a partial successful wall");
forgetPublished();
fakePublished({ numbers: validNumbers(700) });
bad.watch.wallCached = { at: 0, key: null, body: null };
failure = await bad.watch.wall(pruneNow);
t.ok(JSON.stringify(failure) === JSON.stringify({ ok: false, why: "snapshot_regressed" }), "a boundary behind data already retired fails closed instead of inventing the missing suffix");

// Public routing preserves exact success/failure bodies, GET/HEAD, cache policy, and a separate limiter.
const envWith = stub => ({ TAIL_CACHE_MS: "5000", TAIL_PER_SECOND: "100", WALL_PER_SECOND: "100", WATCH: { idFromName: () => "one", get: () => stub } });
let forwardedWall = null;
const successStub = { async fetch(input) { forwardedWall = String(input); return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); } };
const ctx = { waitUntil() {} };
let res = await worker.fetch(new Request("https://chain.lintcha.com/api/wall"), envWith(successStub), ctx);
t.ok(res.status === 200 && /max-age=5/.test(res.headers.get("cache-control") || ""), "GET /api/wall returns the wall with the matching cache window");
t.ok(JSON.stringify(await res.json()) === JSON.stringify(body), "the public route does not add wrapper keys");
res = await worker.fetch(new Request("https://chain.lintcha.com/api/wall?after=opaque_cursor"), envWith(successStub), ctx);
t.ok(res.status === 200 && forwardedWall === "https://watch/wall?after=opaque_cursor", "the public route forwards the one opaque cursor without interpreting it");
res = await worker.fetch(new Request("https://chain.lintcha.com/api/wall", { method: "HEAD" }), envWith(successStub), ctx);
t.ok(res.status === 200, "HEAD /api/wall is supported");
res = await worker.fetch(new Request("https://chain.lintcha.com/api/wall", { method: "POST" }), envWith(successStub), ctx);
t.ok(res.status === 405, "writes to /api/wall are refused");
res = await worker.fetch(new Request("https://chain.lintcha.com/api/wall"), {}, ctx);
t.ok(JSON.stringify(await res.json()) === JSON.stringify({ ok: false, why: "no_watcher" }), "a missing watcher is an exact bounded 503 failure");

const failStub = { async fetch() { return new Response(JSON.stringify({ ok: false, why: "stale" }), { status: 503, headers: { "content-type": "application/json" } }); } };
res = await worker.fetch(new Request("https://chain.lintcha.com/api/wall"), envWith(failStub), ctx);
t.ok(res.status === 503, "watcher failure remains 503 at the public route");
t.ok(JSON.stringify(await res.json()) === JSON.stringify({ ok: false, why: "stale" }), "and its bounded reason is preserved exactly");
const resetStub = { async fetch() { return new Response(JSON.stringify({ ok: false, why: "reset_required" }), { status: 409, headers: { "content-type": "application/json" } }); } };
res = await worker.fetch(new Request("https://chain.lintcha.com/api/wall?after=old"), envWith(resetStub), ctx);
t.ok(res.status === 409 && JSON.stringify(await res.json()) === JSON.stringify({ ok: false, why: "reset_required" }), "a stale or overflowing live cursor remains a bounded reset response through the public route");

forgetTailBucket();
forgetWallBucket();
const tight = envWith(successStub);
tight.TAIL_PER_SECOND = "1";
tight.WALL_PER_SECOND = "1";
const tailStub = { async fetch(url) { return String(url).endsWith("/tail") ? new Response(JSON.stringify(tail), { status: 200 }) : successStub.fetch(); } };
tight.WATCH.get = () => tailStub;
const tailRes = await worker.fetch(new Request("https://chain.lintcha.com/api/tail"), tight, ctx);
const wallRes = await worker.fetch(new Request("https://chain.lintcha.com/api/wall"), tight, ctx);
t.ok(tailRes.status === 200 && wallRes.status === 200, "wall and tail have separate per-isolate buckets");
const limitedWall = await worker.fetch(new Request("https://chain.lintcha.com/api/wall"), tight, ctx);
t.ok(limitedWall.status === 429 && JSON.stringify(await limitedWall.json()) === JSON.stringify({ ok: false, why: "rate_limited" }), "wall rate limiting has a bounded machine-readable response");

t.done();
