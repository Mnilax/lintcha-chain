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
import { Watch, SEL_TOKEN, forgetPublished, DEFAULT_TAIL_CACHE_MS } from "../src/watch.js";
import { setGate } from "../src/chain.js";
import { Tally, tallyHash, tallyText } from "../src/tally.js";
import { addRowToTally } from "../src/watch.js";
import { NAMESPACES } from "../src/engine.js";
import { harness, fakeWatchCtx, fakeChain, fakePublished, STAND_BOT_TOKEN } from "./fakes.mjs";

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

async function standing(numbers = NUMBERS, numbersOk = true) {
  forgetPublished();
  const net = fakePublished({ numbers, numbersOk });
  const chain = fakeChain({ selectors: SELECTORS, head: 700, launches: LAUNCHES, timestamps: { 701: NOW_SECONDS, 702: NOW_SECONDS } });
  setGate(chain.gate);
  const ctx = fakeWatchCtx();
  const watch = new Watch(ctx, { TELEGRAM_BOT_TOKEN: STAND_BOT_TOKEN });
  await watch.tick(NOW);
  chain.head = 702;
  await watch.tick(NOW + 12000);
  return { net, chain, ctx, watch };
}

// ---------------------------------------------------------------- the shape, and the two block numbers
const s = await standing();
const body = await s.watch.tail(NOW + 20000);
t.ok(s.ctx.tail.length === 2, "two launches are in the tail");
t.ok(body.from_block === 701 && body.to_block === 702, "the tail states the range it covers");
t.ok(body.launches_in_tail === 2, "and how many launches that is");
t.ok(typeof body.collected_at === "string" && /T.*Z$/.test(body.collected_at), "when it was built");
t.ok(/^[0-9a-f]{64}$/.test(body.hash), "and its own hash");
t.ok(body.engine === "site/launch.js", "it names the engine that counted it");
t.ok(body.depth_days === 7, "and how far back it keeps");
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

// ---------------------------------------------------------------- the route
const envWith = watchObject => ({ TAIL_CACHE_MS: "5000", TAIL_PER_SECOND: "100", WATCH: { idFromName: () => "one", get: () => watchObject } });
const stub = { async fetch() { return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); } };
const ctxOf = () => ({ waitUntil() {} });

let res = await worker.fetch(new Request("https://chain.lintcha.com/api/tail"), envWith(stub), ctxOf());
t.ok(res.status === 200, "GET /api/tail answers");
t.ok(res.headers.get("content-type") === "application/json", "as json");
t.ok(/max-age=5/.test(res.headers.get("cache-control") || ""), "cached for the same few seconds the object holds it for");
t.ok((await res.json()).hash === body.hash, "and hands out what the object built");

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

t.done();
