// Launch identity (site/launch.js, site/launch-skeleton.js): the normalizers, the skeleton table row by row (a pair
// that folds and a pair that must not, criterion 4), shared never lookalike (criterion 5), the twelve-word floor
// (criterion 6), both digest paths, and check() against a handmade fixture index. No network.
//   node tests/launch_test.js
"use strict";
const path = require("path");
const L = require(path.resolve(__dirname, "..", "site", "launch.js"));
const S = require(path.resolve(__dirname, "..", "site", "launch-skeleton.js"));
const K = require(path.resolve(__dirname, "..", "site", "launch-links.js"));
const n = L.normalize;
let checks = 0, failures = 0;
const fail = m => { failures++; console.error("FAIL " + m); };
const eq = (got, want, what) => { checks++; if (got !== want) fail(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); };
const folds = (a, b, row) => { checks++; if (a === b) fail(`row ${row}: the pair must differ as strings`); else if (n.skeleton(a) !== n.skeleton(b)) fail(`row ${row}: ${JSON.stringify(a)} and ${JSON.stringify(b)} must fold to one skeleton (${n.skeleton(a)} / ${n.skeleton(b)})`); };
const keeps = (a, b, row) => { checks++; if (n.skeleton(a) === n.skeleton(b)) fail(`row ${row}: ${JSON.stringify(a)} and ${JSON.stringify(b)} must not fold together`); };
const cy = s => s.replace(/\{(\w+)\}/g, (_, k) => String.fromCharCode(parseInt(k, 16)));   // {0430} -> cyrillic a

(async () => {
  // ---------------------------------------------------------------- the skeleton table, row by row (criterion 4)
  folds("B0B", "BOB", "0 O o");            keeps("BOB", "BAB", "0 O o");
  folds("1", "l", "1 l I i |");           folds("PIPE", "P|PE", "1 l I i |");   folds("BIT", "BlT", "1 l I i |");   keeps("LIT", "LET", "1 l I i |");
  folds("5OL", "SOL", "5 S s");            keeps("SOL", "TOL", "5 S s");
  folds("2EN", "ZEN", "2 Z z");            keeps("ZEN", "ZAN", "2 Z z");
  folds("8OB", "BOB", "8 B");              keeps("8OB", "9OB", "8 B");
  folds("rnoon", "moon", "rn -> m");       keeps("rnoon", "noon", "rn -> m");
  folds("vvave", "wave", "vv -> w");       keeps("vvave", "vave", "vv -> w");
  const twins = [["0430", "a"], ["0435", "e"], ["043e", "o"], ["0440", "p"], ["0441", "c"], ["0445", "x"], ["0443", "y"], ["043a", "k"], ["043c", "m"], ["043d", "h"], ["0442", "t"], ["0432", "b"]];
  for (const [code, latin] of twins) {
    folds(cy(`x{${code}}x`), `x${latin}x`, `cyrillic ${code}`);
    keeps(cy(`x{${code}}x`), `x${latin === "a" ? "b" : "a"}x`, `cyrillic ${code}`);
    folds(cy(`X{${(parseInt(code, 16) - 0x20).toString(16)}}X`), `x${latin}x`, `cyrillic ${code} upper`);   // uppercase cyrillic lowercases first
  }
  folds(cy("bo{200b}b"), "bob", "zero-width space");   folds(cy("bo{200d}b"), "bob", "zero-width joiner");   folds(cy("bo{200c}b"), "bob", "zero-width non-joiner");
  folds(cy("bo{feff}b"), "bob", "byte order mark");    folds(cy("bo{00ad}b"), "bob", "soft hyphen");         folds(cy("bo{2060}b"), "bob", "word joiner");
  folds(cy("caf{0065}{0301}"), "cafe", "combining mark");   folds("caf\u00e9", "cafe", "precomposed mark");   keeps("cafe", "caff", "marks");
  // every CHARS row is reachable and every PAIRS row is reachable: the table and the tests agree on the row count
  eq(Object.keys(S.CHARS).length, 7 + twins.length, "CHARS rows (0 1 i | 5 2 8 plus twelve cyrillic)");
  eq(S.PAIRS.length, 2, "PAIRS rows");
  for (const k of Object.keys(S.CHARS)) { checks++; if (n.skeleton(k) !== S.CHARS[k]) fail(`CHARS ${JSON.stringify(k)} must fold to ${S.CHARS[k]}`); }
  for (const [a, b] of S.PAIRS) { checks++; if (n.skeleton("x" + a + "x") !== "x" + b + "x") fail(`PAIRS ${a} must fold to ${b}`); }
  // the file that holds the table is one file under fifty lines (criterion 4)
  const lines = require("fs").readFileSync(path.resolve(__dirname, "..", "site", "launch-skeleton.js"), "utf8").split(/\r?\n/).filter(l => l.length).length;
  checks++; if (lines >= 50) fail("launch-skeleton.js must stay under fifty lines, has " + lines);
  // a skeleton is stable and never widens a plain string
  eq(n.skeleton("moon"), "moon", "plain ascii unchanged");
  eq(n.skeleton(n.skeleton("B0B rnoon")), n.skeleton("B0B rnoon"), "idempotent");

  // ---------------------------------------------------------------- normalizers
  eq(n.link(" HTTPS://WWW.Example.com/Foo/ "), "example.com/Foo", "link: scheme, www, host case, trailing slash");
  eq(n.link("http://x.com/Foo"), n.link("https://x.com/foo".replace("foo", "Foo")), "link: scheme does not matter");
  eq(n.link("example.com/Foo") === n.link("example.com/foo"), false, "link: outside the table the path keeps its case");
  eq(n.link("t.me/abc#top"), "t.me/abc", "link: fragment dropped");
  eq(n.link("discord.gg/AbCd?x=1"), "discord.gg/AbCd?x=1", "link: query kept, code case kept");
  eq(n.link(""), "", "link: empty stays empty");
  eq(n.link(null), "", "link: null is empty");
  // ---------------------------------------------------------------- the link alias table, row by row
  const foldsTo = (a, b, row) => { checks++; if (a === b) fail(`link row ${row}: the pair must differ as strings`); else if (n.link(a) !== n.link(b)) fail(`link row ${row}: ${JSON.stringify(a)} and ${JSON.stringify(b)} must fold to one value (${n.link(a)} / ${n.link(b)})`); };
  const stayApart = (a, b, row) => { checks++; if (n.link(a) === n.link(b)) fail(`link row ${row}: ${JSON.stringify(a)} and ${JSON.stringify(b)} must stay apart`); };
  foldsTo("https://twitter.com/Bob", "x.com/bob", "twitter.com");              stayApart("twitter.com/bob", "twitter.com/bobby", "twitter.com");
  foldsTo("mobile.twitter.com/Bob", "x.com/bob", "mobile.twitter.com");        stayApart("mobile.twitter.com/bob", "mobile.twitter.com/rob", "mobile.twitter.com");
  foldsTo("m.twitter.com/Bob", "x.com/bob", "m.twitter.com");                  stayApart("m.twitter.com/bob", "x.com/bob/status/1", "m.twitter.com");
  foldsTo("mobile.x.com/Bob", "x.com/bob", "mobile.x.com");                    stayApart("mobile.x.com/bob", "mobile.x.com/bobby", "mobile.x.com");
  foldsTo("X.com/Bob", "x.com/bob", "x.com path case");                        stayApart("x.com/bob", "t.me/bob", "x.com against t.me");
  foldsTo("https://telegram.me/Bob", "t.me/bob", "telegram.me");               stayApart("telegram.me/bob", "telegram.me/bobby", "telegram.me");
  foldsTo("telegram.dog/Bob", "t.me/bob", "telegram.dog");                     stayApart("telegram.dog/bob", "telegram.dog/rob", "telegram.dog");
  foldsTo("T.me/Bob", "t.me/bob", "t.me path case");                           stayApart("t.me/bob", "t.me/joinchat/bob", "t.me");
  // a bare handle in a field that names its platform
  eq(n.link("@Bob", "twitter"), "x.com/bob", "twitter field: @handle is the page");
  eq(n.link("Bob", "twitter"), "x.com/bob", "twitter field: handle without @");
  eq(n.link("@bob", "telegram"), "t.me/bob", "telegram field: @handle is the page");
  eq(n.link("@bob", "website"), "@bob", "website field names no platform: value stays");
  eq(n.link("@bob", "discord"), "@bob", "discord field is not in the table: value stays");
  eq(n.link("@bob", "farcaster"), "@bob", "farcaster field is not in the table: value stays");
  eq(n.link("@bob"), "@bob", "no field: value stays");
  eq(n.link("bob.eth", "twitter"), "bob.eth", "a dot is not a handle");
  eq(n.link("x.com/@bob", "twitter"), "x.com/@bob", "an @ inside a path is not a handle");
  // outside the table nothing changes: path case, shorteners, other hosts
  eq(n.link("discord.gg/AbCd"), "discord.gg/AbCd", "outside the table the path keeps its case");
  eq(n.link("https://t.co/AbC"), "t.co/AbC", "a shortener is never expanded");
  stayApart("t.co/abc", "x.com/abc", "shortener against the page it may point to");
  eq(n.link("https://x.com/bob?s=21"), "x.com/bob?s=21", "query kept, lowercased with the path on a table host");
  eq(n.linkRaw("https://twitter.com/Bob"), "twitter.com/Bob", "linkRaw: by value, no folding");
  eq(n.linkRaw("@bob", "twitter"), "@bob", "linkRaw: no handle folding");
  // every HOSTS row and every PLATFORM row is exercised
  for (const h of Object.keys(K.HOSTS)) { checks++; if (n.link(h + "/Bob") !== K.HOSTS[h] + "/bob") fail("HOSTS " + h + " must fold to " + K.HOSTS[h] + " with a lowercase path, got " + n.link(h + "/Bob")); }
  for (const f of Object.keys(K.PLATFORM)) { checks++; if (n.link("@Bob", f) !== K.PLATFORM[f] + "/bob") fail("PLATFORM " + f + " must fold a handle"); }
  eq(Object.keys(K.HOSTS).length, 8, "HOSTS rows");
  eq(Object.keys(K.PLATFORM).length, 2, "PLATFORM rows");
  const linkLines = require("fs").readFileSync(path.resolve(__dirname, "..", "site", "launch-links.js"), "utf8").split(/\r?\n/).filter(l => l.length).length;
  checks++; if (linkLines >= 50) fail("launch-links.js must stay under fifty lines, has " + linkLines);

  eq(n.logo("ipfs://QmAbc"), "ipfs://QmAbc", "logo: a non-web scheme is kept whole, id case kept");
  eq(n.logo(" ipfs://QmAbc "), "ipfs://QmAbc", "logo: trimmed");
  eq(n.logo("HTTPS://Gateway.io/ipfs/QmAbc/"), "gateway.io/ipfs/QmAbc", "logo: a web address follows the raw link rules");
  eq(n.logo("https://twitter.com/Bob/photo"), "twitter.com/Bob/photo", "logo: never folded through the alias table");
  eq(n.ticker(" $bob "), "BOB", "ticker: leading $ and whitespace, uppercased");
  eq(n.ticker("$$ bob"), "BOB", "ticker: repeated $ and inner leading space");
  eq(n.ticker("bo$b"), "BO$B", "ticker: only a leading $ goes");
  eq(n.name("Bob  Coin!"), "bob coin", "name: case, whitespace, punctuation");
  eq(n.name("BOB-COIN"), "bobcoin", "name: punctuation stripped without a space");
  eq(n.description("Hi! Visit https://a.b/c and www.d.e now\u2026 don't \u{1f680}"), "hi visit and now dont", "description: urls, punctuation, emoji, apostrophe");
  eq(n.description("  A   B  "), "a b", "description: whitespace collapsed");
  eq(L.words(n.description("one two three")), 3, "words");
  eq(L.words(""), 0, "words of empty");
  eq(n.recipient("0xABCDEF0123456789abcdef0123456789ABCDEF01").value, "0xabcdef0123456789abcdef0123456789abcdef01", "recipient: checksum case folded");
  eq(n.recipient("0x1234").state, "not readable", "recipient: not an address");
  eq(n.recipient("bob").state, "not readable", "recipient: not hex");
  eq(n.recipient("0x" + "0".repeat(40)).state, "empty", "recipient: zero address is not set");
  eq(n.recipient("").state, "empty", "recipient: empty");

  // ---------------------------------------------------------------- digests
  eq(await L.digest("abc"), "ba7816bf8f01cfea", "sha256(abc) first eight bytes");
  eq(await L.digestSubtle("abc"), await L.digest("abc"), "web crypto path equals node path");
  eq((await L.digest("\u00e9")).length, L.HEX_CHARS, "utf8 input, sixteen hex chars");
  eq(await L.digest("x"), await L.digest("x"), "deterministic");

  // ---------------------------------------------------------------- a handmade fixture index
  const idx = {}; for (const ns of L.NAMESPACES) idx[ns] = {};
  const put = async (ns, value, n_, first, d = 1, v) => { idx[ns][await L.digest(value)] = v === undefined ? { n: n_, d, first } : { n: n_, d, first, v }; };
  await put("link", n.link("https://x.com/shared"), 41, "2026-08-14", 7);   // the twitter field below reaches it as twitter.com/Shared
  await put("logo", n.logo("ipfs://QmLogo"), 3, "2026-08-20", 1);
  await put("recipient", "0x" + "ab".repeat(20), 2, "2026-08-21", 2);
  await put("description", n.description("this description has exactly twelve words in it for the floor test"), 5, "2026-07-01", 3);
  await put("ticker", "BOB", 4, "2026-08-01", 4);         await put("ticker_skeleton", n.skeleton("BOB"), 6, "2026-07-15", 5, 3);   // three spellings: a lookalike group
  await put("name", "bob coin", 4, "2026-08-01", 2);      await put("name_skeleton", n.skeleton("bob coin"), 4, "2026-08-01", 2, 1);  // one spelling: an exact repeat, not a lookalike
  await put("ticker_skeleton", n.skeleton("ZEN"), 2, "2026-08-05", 2, 2);                                                            // a group the pasted spelling is not in the exact table of
  await put("ticker", "SAME", 2, "2026-08-09", 1);        await put("ticker_skeleton", n.skeleton("SAME"), 2, "2026-08-09", 1, 1);   // spelt one way twice

  const r = await L.check({
    name: "Bob Coin", ticker: "$bob", description: "This description has exactly twelve words in it for the floor test.",
    links: { twitter: "HTTPS://twitter.com/Shared/", telegram: "t.me/other", discord: "", website: "", farcaster: "" },
    logo: "ipfs://QmLogo", recipient: "0x" + "AB".repeat(20)
  }, idx);
  eq(Object.keys(r).join(), "I1,I2,I3,I4,N1,N2,N3", "check() returns the seven checks");
  eq(r.I1.state, "shared", "I1 shared when one link is shared");
  eq(r.I1.links.twitter.state + " " + r.I1.links.twitter.n + " " + r.I1.links.twitter.d + " " + r.I1.links.twitter.first, "shared 41 7 2026-08-14", "I1 twitter: count, deployers and first date, through the alias table");
  eq(r.I1.links.telegram.state, "unique", "I1 telegram unique");
  eq(r.I1.links.discord.state, "empty", "I1 discord empty");
  eq(r.I2.state + " " + r.I2.n + " " + r.I2.d, "shared 3 1", "I2 logo shared, one deployer");
  eq(r.I3.state + " " + r.I3.n + " " + r.I3.d, "shared 2 2", "I3 recipient shared across two deployers, case folded");
  eq(r.I4.state + " " + r.I4.n + " " + r.I4.first, "shared 5 2026-07-01", "I4 description shared after normalization");
  eq(r.N1.state + " " + r.N1.n, "shared 4", "N1 ticker shared");
  eq(r.N2.state + " " + r.N2.n, "shared 4", "N2 name shared");
  eq([r.N3.ticker.state, r.N3.ticker.n, r.N3.ticker.v, r.N3.ticker.d, r.N3.ticker.first].join(" "), "lookalike 6 3 5 2026-07-15", "N3 ticker: the group read directly, no arithmetic: launches, spellings, deployers, first date");
  eq(r.N3.name.state, "unique", "N3 name: a group spelt one way is an exact repeat, never lookalike (criterion 5)");
  eq(r.N3.state, "lookalike", "N3 folds to lookalike when either side is");

  // criterion 5 the other way round: identical after normalization is shared and not lookalike, with nothing else in the skeleton namespace
  const same = await L.check({ ticker: "same", name: "" }, idx);
  eq(same.N1.state + " " + same.N1.n + " " + same.N1.d, "shared 2 1", "N1 SAME shared, one deployer");
  eq(same.N3.ticker.state, "unique", "N3 SAME: spelt one way, v = 1, N3 shows nothing even though the skeleton entry exists");
  const only = await L.check({ ticker: "2en" }, idx);
  eq(only.N1.state, "unique", "N1 2EN unique: the exact table has no entry for this spelling");
  eq([only.N3.ticker.state, only.N3.ticker.n, only.N3.ticker.v, only.N3.ticker.first].join(" "), "lookalike 2 2 2026-08-05", "N3 2EN: the group holds two spellings, reported as the group is, with its date");
  // an exact value seen once fell out of the exact table under the floor; its skeleton group with one spelling must not read as a lookalike
  { const k = await L.digest(n.skeleton("ONCE")); idx.ticker_skeleton[k] = { n: 2, d: 2, first: "2026-08-10", v: 1 };
    const once = await L.check({ ticker: "once" }, idx); eq(once.N1.state + " " + once.N3.ticker.state, "unique unique", "N3: no subtraction; an exact repeat absent from the exact table is not a lookalike"); }
  // a skeleton entry without v (an older index) never reads as a lookalike
  { const k = await L.digest(n.skeleton("NOV")); idx.ticker_skeleton[k] = { n: 3, d: 3, first: "2026-08-10" };
    eq((await L.check({ ticker: "nov" }, idx)).N3.ticker.state, "unique", "N3: an entry without v is never a lookalike"); }
  // criterion 6: eleven words is too short, twelve is compared
  const eleven = await L.check({ description: "this description has exactly eleven words in it for the floor" }, idx);
  eq(eleven.I4.state, "too short to compare", "I4 eleven words");
  eq(L.words(n.description("this description has exactly eleven words in it for the floor")), 11, "eleven words counted");
  eq(L.MIN_WORDS, 12, "the floor is twelve");
  const twelveOther = await L.check({ description: "one two three four five six seven eight nine ten eleven twelve" }, idx);
  eq(twelveOther.I4.state, "unique", "I4 twelve words compared and unique");
  // empty and unreadable
  const empty = await L.check({}, idx);
  eq([empty.I1.state, empty.I2.state, empty.I3.state, empty.I4.state, empty.N1.state, empty.N2.state, empty.N3.state].join(), "empty,empty,empty,empty,empty,empty,empty", "empty input is empty everywhere, never a verdict");
  eq((await L.check({ recipient: "0x12" }, idx)).I3.state, "not readable", "I3 unreadable says so");
  eq((await L.check({ recipient: "0x" + "0".repeat(40) }, idx)).I3.state, "empty", "I3 zero address is not set");
  // an index with no namespace for a field, or a zero count, is unique, never a crash
  eq((await L.check({ ticker: "BOB" }, {})).N1.state, "unique", "missing namespace is unique");
  eq((await L.check({ ticker: "BOB" }, { ticker: { [await L.digest("BOB")]: { n: 0, first: "" } } })).N1.state, "unique", "zero count is unique");
  // no raw value, hash or address leaves check(): only state, n, first
  const keysOf = o => Object.keys(o).sort().join();
  eq(keysOf(r.I1.links.twitter), "d,first,n,state", "result carries state, n, d, first only");
  eq(keysOf(r.N3.ticker), "d,first,n,state,v", "lookalike result carries state, n, d, v, first only");
  eq(JSON.stringify(r).indexOf("x.com"), -1, "no raw link in the result");

  console.log(`launch test: ${checks} checks, ${failures} failure(s)`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
