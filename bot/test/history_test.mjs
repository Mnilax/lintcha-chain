// Public retained deployer history: exact coverage, bounded rows, safe projection and route behavior.
//   node test/history_test.mjs
import worker, { forgetHistoryBucket, forgetTailBucket } from "../src/index.js";
import { Watch, SEL_TOKEN, deployerAddressOf, forgetPublished, wallRowsHash } from "../src/watch.js";
import { setGate } from "../src/chain.js";
import { harness, fakeWatchCtx, fakeChain, fakePublished, STAND_BOT_TOKEN } from "./fakes.mjs";

const t = harness("history");
const NOW = 1780000000000;
const SELECTORS = { name: SEL_TOKEN.name, symbol: SEL_TOKEN.symbol, info: SEL_TOKEN.info };
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const token = n => "0x" + String(n).padStart(2, "0").repeat(20);
const launch = (n, block, logIndex, deployer, name, ticker) => ({
  token: token(n), curve: "0x" + "2".repeat(40), deployer, block, logIndex,
  tx: "0x" + BigInt(n).toString(16).padStart(64, "0"), name, symbol: ticker,
  logo: "", description: "", socials: ["", "", "", "", ""]
});
const numbers = { window: { from_block: 1, to_block: 700, blocks: 700 } };

async function standing(limit) {
  forgetPublished();
  fakePublished({ numbers });
  const launches = [
    launch(1, 701, 4, A, "first", "ONE"),
    launch(2, 702, 3, B, "other", "THEIRS"),
    launch(3, 702, 1, A, 'quote " <tag>', "TWO"),
    launch(4, 703, 0, A, "unsafe\nname", "THREE")
  ];
  const chain = fakeChain({ selectors: SELECTORS, head: 700, launches, timestamps: { 701: 1780000000, 702: 1780000001, 703: 1780000002 } });
  setGate(chain.gate);
  const ctx = fakeWatchCtx();
  const watch = new Watch(ctx, { TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN, ...(limit ? { HISTORY_PAGE_ROWS: String(limit) } : {}) });
  await watch.tick(NOW);
  chain.head = 703;
  await watch.tick(NOW + 12000);
  return { chain, ctx, watch };
}

forgetPublished();
fakePublished({ numbers });
const emptyWatch = new Watch(fakeWatchCtx(), { TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN });
t.ok((await emptyWatch.deployerHistory(A, NOW)).why === "not_started", "history is unavailable before the watcher saves its own start boundary");

const s = await standing();
const body = await s.watch.deployerHistory(A.toUpperCase().replace("0X", "0x"), NOW + 20000);
const expectedRows = [
  { block: 701, log_index: 4, date: "2026-05-28", name: "first", ticker: "ONE" },
  { block: 702, log_index: 1, date: "2026-05-28", name: 'quote " <tag>', ticker: "TWO" },
  { block: 703, log_index: 0, date: "2026-05-28", name: null, ticker: "THREE" }
];
t.ok(Object.keys(body).join(",") === "ok,address,from_block,to_block,read_at,launches_seen,page_limit,truncated,rows_hash,rows", "success has the exact public keys");
t.ok(body.ok === true && body.address === A && body.from_block === 701 && body.to_block === 703, "the address is canonical and coverage begins only after the saved watcher boundary");
t.ok(body.launches_seen === 3 && body.truncated === false, "the count includes every retained launch by this deployer, including a redacted declaration");
t.ok(JSON.stringify(body.rows) === JSON.stringify(expectedRows), "rows are in factory position order and unsafe display text becomes null rather than executable or altered text");
t.ok(body.rows_hash === await wallRowsHash(expectedRows), "the exact ordered public rows have a reproducible hash");
t.ok(!JSON.stringify(body).includes(token(1)) && !JSON.stringify(body).includes("THEIRS") && !JSON.stringify(body).includes(B), "the response exposes no token, transaction, or another deployer's launch");
t.ok(s.ctx.storage.sql.statements.some(statement => /CREATE INDEX IF NOT EXISTS tail_deployer_block ON tail \(deployer, block\)/.test(statement)), "the singleton object's address scans have a composite deployer/block index");
t.ok(await s.watch.deployerHistory(A, NOW + 20000) === body, "a repeated address read in the same watcher state reuses the bounded success page");

const bounded = await standing(2);
const page = await bounded.watch.deployerHistory(A, NOW + 20000);
t.ok(page.launches_seen === 3 && page.rows.length === 2 && page.truncated === true, "a prolific address gets a bounded newest page and an explicit total/truncation flag");
t.ok(page.rows[0].block === 702 && page.rows[1].block === 703, "the bounded page keeps the newest factory positions in chronological order");

bounded.watch.set("wall_pruned_through", 701);
const afterPrune = await bounded.watch.deployerHistory(A, NOW + 20000);
t.ok(afterPrune.from_block === 702 && afterPrune.launches_seen === 2, "a retired covered prefix advances the stated history boundary instead of leaving a silent hole");

const missingIndex = await standing();
missingIndex.ctx.wallEvents.splice(missingIndex.ctx.wallEvents.findIndex(row => row.token === token(1)), 1);
t.ok((await missingIndex.watch.deployerHistory(A, NOW + 20000)).why === "migrating", "a retained launch without positional cleartext metadata cannot disappear from a successful history");
const unreadable = await standing();
unreadable.watch.set("unreadable", 1);
unreadable.watch.set("last_unreadable_block", 702);
t.ok((await unreadable.watch.deployerHistory(A, NOW + 20000)).why === "unreadable", "an unreadable launch inside coverage closes history rather than lowering the count");
const malformedUnreadable = await standing();
malformedUnreadable.watch.set("last_unreadable_block", "invalid");
t.ok((await malformedUnreadable.watch.deployerHistory(A, NOW + 20000)).why === "unreadable", "a malformed skip marker cannot disappear from retained history");
const malformedIndexError = await standing();
malformedIndexError.watch.set("wall_index_error_block", "invalid");
t.ok((await malformedIndexError.watch.deployerHistory(A, NOW + 20000)).why === "backfill", "a malformed structural-error marker closes retained history");
const invalidDate = await standing();
invalidDate.ctx.tail.find(row => row.token === token(1)).date = "2026-99-99";
t.ok((await invalidDate.watch.deployerHistory(A, NOW + 20000)).why === "backfill", "a non-calendar stored date closes history instead of becoming public metadata");
const futurePrune = await standing();
futurePrune.watch.set("wall_pruned_through", 704);
t.ok((await futurePrune.watch.deployerHistory(A, NOW + 20000)).why === "watcher", "a pruning boundary beyond watcher coverage cannot produce an impossible public range");
const stale = await standing();
t.ok((await stale.watch.deployerHistory(A, NOW + 12000 + stale.watch.watchdogMs())).why === "stale", "stale watcher state is not presented as current history");

t.ok(deployerAddressOf(new URLSearchParams("address=" + A)) === A, "one canonical address query is accepted");
t.ok(deployerAddressOf(new URLSearchParams("address=" + A + "&address=" + B)) === null, "a repeated address is refused rather than selected silently");
t.ok(deployerAddressOf(new URLSearchParams("address=" + A + "&limit=2")) === null, "unknown history query parameters are refused");
s.watch.set("last_round_at", Date.now());
let objectRes = await s.watch.fetch(new Request("https://watch/deployer?address=" + A));
t.ok(objectRes.status === 200 && (await objectRes.json()).launches_seen === 3, "the object endpoint returns validated retained history");
objectRes = await s.watch.fetch(new Request("https://watch/deployer?address=not-an-address"));
t.ok(objectRes.status === 400 && (await objectRes.json()).why === "query", "the object endpoint rejects a malformed address with a bounded reason");
const limitedObject = await standing();
limitedObject.watch.env.HISTORY_PER_SECOND = "1";
limitedObject.watch.set("last_round_at", Date.now());
const firstObjectRead = await limitedObject.watch.fetch(new Request("https://watch/deployer?address=" + A));
const secondObjectRead = await limitedObject.watch.fetch(new Request("https://watch/deployer?address=" + A));
t.ok(firstObjectRead.status === 200 && secondObjectRead.status === 429 && (await secondObjectRead.json()).why === "rate_limited", "the singleton object has its own restart-local history courtesy limit behind the isolate limit");

const envWith = stub => ({ TAIL_CACHE_MS: "5000", TAIL_PER_SECOND: "100", HISTORY_PER_SECOND: "100", WATCH: { idFromName: () => "one", get: () => stub } });
let forwarded = null;
const stub = { async fetch(input) { forwarded = String(input); return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); } };
const ctx = { waitUntil() {} };
let res = await worker.fetch(new Request("https://chain.lintcha.com/api/deployer?address=" + A), envWith(stub), ctx);
t.ok(res.status === 200 && forwarded === "https://watch/deployer?address=" + A, "the public route forwards the exact address query to the watcher");
t.ok(/max-age=5/.test(res.headers.get("cache-control") || "") && JSON.stringify(await res.json()) === JSON.stringify(body), "the route preserves the exact response and matching short cache window");
res = await worker.fetch(new Request("https://chain.lintcha.com/api/deployer?address=" + A, { method: "POST" }), envWith(stub), ctx);
t.ok(res.status === 405, "writes to deployer history are refused");
res = await worker.fetch(new Request("https://chain.lintcha.com/api/deployer?address=" + A), {}, ctx);
t.ok(res.status === 503 && (await res.json()).why === "no_watcher", "a missing watcher is not rewritten as an empty history");

forgetHistoryBucket();
forgetTailBucket();
const tight = envWith(stub);
tight.HISTORY_PER_SECOND = "1";
tight.TAIL_PER_SECOND = "1";
const firstHistory = await worker.fetch(new Request("https://chain.lintcha.com/api/deployer?address=" + A), tight, ctx);
const limitedHistory = await worker.fetch(new Request("https://chain.lintcha.com/api/deployer?address=" + A), tight, ctx);
const tailStub = { async fetch(input) { return String(input).endsWith("/tail") ? new Response("{}", { status: 200 }) : stub.fetch(input); } };
tight.WATCH.get = () => tailStub;
const separateTail = await worker.fetch(new Request("https://chain.lintcha.com/api/tail"), tight, ctx);
t.ok(firstHistory.status === 200 && limitedHistory.status === 429 && separateTail.status === 200, "history has its own per-isolate bucket and cannot consume the tail bucket");
forgetHistoryBucket();
const objectLimited = envWith({ async fetch() { return new Response(JSON.stringify({ ok: false, why: "rate_limited" }), { status: 429 }); } });
const propagated = await worker.fetch(new Request("https://chain.lintcha.com/api/deployer?address=" + A), objectLimited, ctx);
t.ok(propagated.status === 429 && (await propagated.json()).why === "rate_limited", "the public route preserves the singleton object's bounded rate response");

t.done();
