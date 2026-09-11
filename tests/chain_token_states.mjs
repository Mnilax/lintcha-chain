// lintcha-chain, the token block's three states and the header cluster's links, built and checked without touching the
// tree. site/token.json may carry either the explicit all-null dormant state or one exact active state; site/links.json
// names only accounts that really exist (no placeholder, no zeroes, no empty slot in the tree); this test
// writes a temporary token.json with an address made up at run time, builds into a temporary directory with --token and
// --out, and checks what each state renders:
//   a. all null           no contract row, no buy button, no token section, no launch band, the cluster is GITHUB, X
//                         on the default account and the configured TELEGRAM, the made-up address nowhere in the page
//   b. address and pons   one filled BUY button in the header cluster, the contract row, section seventeen with the
//                         pons button only, two live tiles showing a dash, the launch band under the footer
//   c. pons and uniswap   both buttons, the uniswap one an outline
// A fourth build takes a temporary links.json with both accounts filled and checks the cluster: three outbound items,
// GITHUB then X then TELEGRAM, X on the substituted address. States a, b and c pass no --links, so they render against
// the tree's own site/links.json and the shipped default is what is under test there.
//
// The address appears three times on a built page with an address, and two of those places carry a copy button:
//   data-token-address   3   the contract row under the status strip, section seventeen, the launch band under the footer
//   data-copy-address    2   the contract row's button and the band's; section seventeen prints the address without one
// Both numbers are the count of places the build renders, not a number fitted to the output: the band added one address
// and one button to the two addresses and one button the page carried before it.
//
// State a also carries the checks on the page's own shape, because none of them depend on the token: the section
// numbering after lore (round B) and the chain block (round C) joined the order, the bar's anchors against the
// sections that exist and against each other, the six lore cards, the never list, roadmap.close still last, the run
// section as three cards and one wide, the sprite in its three places, and the roadmap line against the three
// phase lists it was folded out of.
//
// Then it checks that the tree's own site/token.json and rendered page agree exactly in either dormant or active state,
// and that site/links.json carries only the confirmed Telegram account alongside the default X account.
//   node tests/chain_token_states.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tokenConfigOf } from "../lib/config-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0, failures = 0;
const ok = (cond, what) => { checks++; if (!cond) { failures++; console.log("  FAIL " + what); } };
const count = (html, re) => (html.match(re) || []).length;
const re = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const attr = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// the hrefs of the cluster's outbound items, in the order the build renders them
const outHrefs = html => (html.match(/class="out" href="[^"]*"/g) || []).map(m => m.slice('class="out" href="'.length, -1));
// the cluster's own markup: outbound anchors only, no nested div, so the first closing tag ends it
const clusterOf = html => { const m = /<div class="cluster">([\s\S]*?)<\/div>/.exec(html); return m ? m[1] : ""; };
// the text inside one named address slot, or null when that slot is not on the page
const slot = (html, cls) => { const m = new RegExp('class="' + cls + '" data-token-address>([^<]*)<').exec(html); return m ? m[1] : null; };
// every first capture of a global pattern, in the order the page carries them
const nums = (html, re) => [...html.matchAll(re)].map(m => m[1]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chain-token-"));
const address = "0x" + crypto.randomBytes(20).toString("hex");   // made up here, never written into the tree
const pons = "https://example.invalid/pons/" + crypto.randomBytes(4).toString("hex");
const uniswap = "https://example.invalid/uniswap/" + crypto.randomBytes(4).toString("hex");
const xAccount = "https://example.invalid/x/" + crypto.randomBytes(4).toString("hex");
const telegram = "https://example.invalid/telegram/" + crypto.randomBytes(4).toString("hex");
const X_DEFAULT = "https://x.com/mnilax";   // the account the vendored footer links; the build falls back to it when links.json carries no x
const TELEGRAM_DEFAULT = "https://t.me/lintcha";
const shippedNumbers = JSON.parse(fs.readFileSync(path.join(root, "site", "launch-numbers.json"), "utf8"));
const shippedIndexHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "site", "launch-index.json"))).digest("hex");
function build(name, tokenJson, linksJson) {
  const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true });
  const tokenFile = path.join(dir, "token.json"); fs.writeFileSync(tokenFile, JSON.stringify(tokenJson));
  const args = [path.join(root, "tools", "build.mjs"), "--token", tokenFile, "--out", dir];
  if (linksJson) {   // omitted on purpose in states a, b and c: those render against the tree's own site/links.json
    const linksFile = path.join(dir, "links.json"); fs.writeFileSync(linksFile, JSON.stringify(linksJson));
    args.push("--links", linksFile);
  }
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  ok(r.status === 0, `state ${name}: build exits 0 (${(r.stderr || "").trim()})`);
  return r.status === 0 ? fs.readFileSync(path.join(dir, "index.html"), "utf8") : "";
}

console.log("state a: all null");
const a = build("a", { address: null, pons: null, uniswap: null });
ok(count(a, /class="contract"/g) === 0, "no contract row");
ok(count(a, /class="buy"/g) === 0, "no buy button");
ok(count(a, /token-sec/g) === 0, "no token section");
ok(count(a, /class="band"/g) === 0 && count(a, /band-address|band-copy/g) === 0, "no launch band, not even an empty one");
ok(count(a, /data-token-address/g) === 0 && count(a, /data-copy-address/g) === 0, "no address slot and no copy button for one");
ok(count(a, /class="out"/g) === 3, "cluster is three outbound items");
ok(count(a, /data-i18n="nav\.telegram"/g) === 1, "the configured telegram item is present once");
ok(outHrefs(a).length === 3 && outHrefs(a)[1] === X_DEFAULT && outHrefs(a)[2] === TELEGRAM_DEFAULT, "X points at the default account and Telegram at the configured room");
ok(!a.includes(address) && !a.includes(pons), "the made-up address and link are nowhere");
ok(!a.includes(xAccount) && !a.includes(telegram), "the made-up accounts are nowhere");
ok(count(a, /class="hero-actions"/g) === 1 && count(a, /class="hero-action(?: hero-action-primary)?"/g) === 3, "the hero has one three-action start path");
ok(/class="hero-actions"[\s\S]*?href="#s02"[\s\S]*?href="\/live\/"[\s\S]*?href="#s09"[\s\S]*?<\/nav>/.test(a), "the hero actions lead to read, live names and the local run in that order");
// The order gained the lore section in round B and the chain block in round C, and each moved every number after it
// and every anchor with it. All of it is read back off the built page rather than trusted: the bar's anchors have to
// name sections that are on the page, there have to be as many anchors as items, the numbers they point at have to
// climb, and the numbering has to run without a gap. The climb is the round C check: the bar is read as a map of the
// page, and an item out of place reads as a section out of place.
const navNums = nums(a, /data-nav="(\d+)"/g);
const navHrefs = nums(a, /<a href="#s(\d+)" data-nav=/g);
const secNums = nums(a, /<section class="sec[^"]*" id="s(\d+)"/g);
ok(navNums.length === 10, "ten items in the bar");
ok(navHrefs.length === navNums.length && navHrefs.join(" ") === navNums.join(" "), "as many section anchors as items in the bar, each anchor on its own item");
ok(navNums.every(n => secNums.includes(n)), "every anchor in the bar names a section that is on the page");
ok(navNums.every((n, i) => i === 0 || Number(n) > Number(navNums[i - 1])), "the sections the bar points at climb: " + navNums.join(" "));
ok(secNums.join(" ") === "01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16", "sixteen sections, numbered without a gap");
ok(count(a, /class="sec sec-chain" id="s03"/g) === 1 && count(a, /data-nav="03" data-i18n="nav\.chain"/g) === 1, "the chain block is section three, and the bar names it there");
ok(a.indexOf('id="s03"') < a.indexOf('id="s04"') && count(a, /<section class="sec" id="s04"[\s\S]{0,400}data-i18n="reads\.h2"/g) === 1, "the chain block comes before what this reads");
ok(count(a, /href="https:\/\/docs\.robinhood\.com\/chain\/connecting\/"/g) === 1 && count(a, /data-i18n="chain\.source"/g) === 1, "the chain facts link to Robinhood's official network configuration");
ok(count(a, /data-nav="09" data-i18n="nav\.run"/g) === 1, "run has a bar item, at section nine");
ok(count(a, /data-nav="14" data-i18n="nav\.lore"/g) === 1, "lore is the bar item for section fourteen");
ok(count(a, /class="sec sec-lore" id="s14"/g) === 1, "the lore section is section fourteen");
ok(a.indexOf('id="s14"') < a.indexOf('id="s15"'), "lore comes before the roadmap");
ok(count(a, /class="lore-card"/g) === 6, "six lore cards");
ok(count(a, /class="never"/g) === 1 && count(a, /<li data-i18n="road\.never\.l\d">/g) === 8, "the never list, eight lines");
ok(count(a, /data-livetile="snapshot"/g) === 1 && a.includes(shippedIndexHash.slice(0, 16)), "the status strip identifies the shipped snapshot by its index key");
ok(count(a, /data-result-tools/g) === 1 && count(a, /data-share-result/g) === 1 && count(a, /data-copy-receipt/g) === 1 && count(a, /data-download-receipt/g) === 1, "one result context block with share, copy-receipt and download-receipt controls");
ok(a.includes(`data-window-from="${shippedNumbers.window.from_block}"`) && a.includes(`data-window-to="${shippedNumbers.window.to_block}"`) && a.includes(`data-window-start="${shippedNumbers.window.from_time}"`) && a.includes(`data-window-end="${shippedNumbers.window.to_time}"`) && a.includes(`data-index-hash="${shippedIndexHash}"`), "the result context carries both shipped snapshot boundaries, both times and the full index hash");
ok(count(a, /data-i18n="faq\.(?:bot_first|signature)\.q"/g) === 2, "the FAQ carries both bot questions");
ok(a.lastIndexOf('data-i18n="roadmap.close"') > a.lastIndexOf('data-i18n="road.check.p"'), "roadmap.close is still the last thing in the section");
// the closing angle bracket matters: without it the first pattern also matches the opening tag of cells-run-wide
ok(count(a, /class="cells cells-run">/g) === 1 && count(a, /class="cells cells-run-wide">/g) === 1, "the run section is three cards and one wide");
ok(count(a, /class="cell-t"/g) === 4, "three step cards and the wide one, each with a title");
ok(count(a, /<code>npm test<\/code>|<code>npm run build<\/code>|<code>npm run verify<\/code>/g) === 3 && count(a, /<code>git clone /g) === 1, "the same four commands, none added");
// the sprite: three on the page and no fourth, the same eleven rectangles every time, and no file behind it
const sprites = a.match(/<svg class="sprite [^"]*"[\s\S]*?<\/svg>/g) || [];
ok(sprites.length === 3, "the sprite is on the page three times");
ok(new Set(sprites.map(s => s.replace(/ class="sprite [^"]*"/, ""))).size === 1, "the three are one sprite in three sizes: the same markup apart from the size");
ok(sprites.every(s => count(s, /<rect /g) === 11 && count(s, /class="cut"/g) === 2) && sprites.every(s => !/href|src|url\(/.test(s)), "eleven rectangles each, two of them the cut strokes, and no file behind any of it");
ok(count(a, /class="sprite sprite-s"/g) === 1 && count(a, /class="sprite sprite-m"/g) === 1 && count(a, /class="sprite sprite-l"/g) === 1, "one small, one medium, one large");
// the roadmap line: the three phase lists folded onto one rule, a tick for every item and not one item lost
const road = a.slice(a.indexOf('id="s15"'), a.indexOf("<section", a.indexOf('id="s15"') + 1));
const roadItems = count(road, /data-i18n="roadmap\.(shipped|next|later)\.l\d"/g);
ok(roadItems === 8, "eight items across shipped, next and later, the same eight as the three columns carried");
ok(count(road, /class="road-tick"/g) === roadItems, "one tick on the line for each of them: " + count(road, /class="road-tick"/g));
ok(count(road, /class="road-stop road-up"/g) === 4 && count(road, /class="road-stop road-down"/g) === 4, "the labels alternate above and below the line");
ok(count(road, /class="road-ph"/g) === 3 && count(road, /data-phase="shipped"|data-phase="next"|data-phase="later"/g) === 3, "the three phases keep their names on the line");
ok(count(road, /class="road-sprite"/g) === 1 && road.indexOf('class="road-sprite"') > road.indexOf('data-phase="shipped"') && road.indexOf('class="road-sprite"') < road.indexOf('data-i18n="roadmap.next.l1"'), "the sprite stands where shipped ends and next begins");
// Not one label on the line carries a time. The promise round B published is "no dates on this page", and a row of
// milestones is exactly where a quarter or a year creeps in, so every label and every phase name is read off the
// built line and tested: no digit, no year, no quarter, no month, no deadline, no week. The prose below the line is
// round B's and is not under this check: "by the end of that week" down there is an argument about a stale window,
// not a date on a plan, and the round's instruction was that not one of those strings changes.
const line = road.slice(road.indexOf('class="road-line"'));
const labels = [...line.matchAll(/class="road-(?:label|ph)"[^>]*>([^<]*)</g)].map(m => m[1].trim()).filter(Boolean);
const DATED = [/\d/, /\bQ[1-4]\b/i, /\bH[12]\b/i, /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/i, /\bquarters?\b/i, /\bdeadlines?\b/i, /\beta\b/i, /\bweeks?\b|\bmonths?\b|\byears?\b/i];
const dated = labels.filter(l => DATED.some(re => re.test(l)));
ok(labels.length === roadItems + 3, "every stop and every phase name on the line carries its label: " + labels.length);
ok(dated.length === 0, "no label on the line carries a date, a year, a quarter, a month or a deadline" + (dated.length ? ": " + JSON.stringify(dated) : ""));

console.log("state b: address and pons");
const b = build("b", { address, pons, uniswap: null });
ok(count(b, /class="buy"/g) === 1 && b.includes(`class="buy" href="${pons}"`), "one filled buy button, to the pons link");
// three address slots: the contract row, section sixteen, the band; two copy buttons: the row's and the band's
ok(count(b, /class="contract"/g) === 1 && count(b, /data-token-address>[^<]*</g) === 3, "the contract row, the section and the band carry the address");
// the token section is numbered one past the last section of the page: the order in tools/build.mjs carries
// sixteen sections since the chain block joined it and none is pending, so String(ORDER.length + 1) makes the
// token section seventeen. The number is read off the order, not fitted to the output: it moved from fifteen to
// sixteen in round B and from sixteen to seventeen in round C, each time because the order grew by one.
ok(count(b, /class="sec token-sec" id="s17"/g) === 1, "the token section is section seventeen");
ok(count(b, /data-sec="16"/g) === 1 && count(b, /data-sec="17"/g) === 1 && count(b, /data-sec="18"/g) === 0, "numbered straight after the last section of the page, no gap");
ok(count(b, /token-btn-pons/g) === 1 && count(b, /token-btn-uni/g) === 0, "pons button only");
ok(count(b, /badge-live/g) === 2 && count(b, /class="cell-v" data-i18n="token.dash">—</g) === 2, "two live tiles, each a dash");
ok(count(b, /data-copy-address/g) === 2, "two copy buttons: the contract row's and the band's");
ok(count(b, /class="band"/g) === 1 && count(b, /class="band-copy"/g) === 1, "one launch band, with one copy button");
ok(slot(b, "band-address") === address && slot(b, "band-address") === slot(b, "contract-address"), "the band carries the contract row's address");
ok(b.indexOf('class="band"') > b.indexOf("</footer>"), "the band sits under the footer");
ok(count(b, /class="out"/g) === 3 && outHrefs(b)[1] === X_DEFAULT && outHrefs(b)[2] === TELEGRAM_DEFAULT, "the cluster is unchanged by the token: three items, X on the default account and Telegram on the configured room");

console.log("state c: pons and uniswap");
const c = build("c", { address, pons, uniswap });
ok(count(c, /token-btn-pons/g) === 1 && count(c, /token-btn-uni/g) === 1 && c.includes(`href="${uniswap}"`), "both buttons, the uniswap one an outline");
ok(count(c, /class="buy"/g) === 1, "still one filled button on the page");
ok(count(c, /class="band"/g) === 1 && slot(c, "band-address") === address, "one band, the same address");

console.log("links: both accounts filled");
const l = build("links", { address, pons, uniswap: null }, { x: xAccount, telegram });
const hrefs = outHrefs(l);
ok(count(l, /class="out"/g) === 3, "cluster is three outbound items");
ok(hrefs.length === 3 && hrefs[0] === "https://github.com/Mnilax/lintcha-chain" && hrefs[1] === xAccount && hrefs[2] === telegram, "github, then X on the substituted account, then telegram");
ok(count(clusterOf(l), /class="arrow"/g) === 3, "each of the three carries the arrow");
ok(count(l, /data-i18n="nav\.telegram"/g) === 1, "the telegram item is keyed nav.telegram");
ok(!l.includes(X_DEFAULT), "the default X account is not on the page once links.json names one");

console.log("the tree");
const treeToken = JSON.parse(fs.readFileSync(path.join(root, "site", "token.json"), "utf8"));
const treeState = tokenConfigOf(treeToken);
ok(!!treeState, "site/token.json matches the shared dormant-or-active contract");
const treeLinks = JSON.parse(fs.readFileSync(path.join(root, "site", "links.json"), "utf8"));
ok(treeLinks.x === null && treeLinks.telegram === TELEGRAM_DEFAULT, "site/links.json leaves X on its default and names the confirmed Telegram room");
const tree = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
if (treeState && treeState.address === null) {
  ok(treeState.pons === null && treeState.uniswap === null, "the dormant tree has no detached buy destination");
  ok(count(tree, /class="contract"|class="buy"|token-sec|class="band"/g) === 0, "the dormant page carries no token block and no band");
  ok(count(tree, /data-token-address|data-copy-address/g) === 0, "the dormant page carries no address or copy slot");
} else if (treeState) {
  const a = re(treeState.address), p = re(attr(treeState.pons));
  ok(count(tree, /class="contract"/g) === 1 && count(tree, /class="buy"/g) === 1 && count(tree, /class="sec token-sec"/g) === 1 && count(tree, /class="band"/g) === 1,
    "the active page carries one contract row, primary buy, token section and band");
  ok(count(tree, new RegExp(`data-token-address>${a}<`, "g")) === 3 && count(tree, /data-copy-address/g) === 2,
    "the active page carries only its exact configured address in all three slots and two copy buttons");
  ok(count(tree, new RegExp(`class="buy" href="${p}"`, "g")) === 1 && count(tree, new RegExp(`class="token-btn token-btn-pons" href="${p}"`, "g")) === 1,
    "the active page carries the exact configured pons URL in both primary destinations");
  if (treeState.uniswap === null) ok(count(tree, /token-btn-uni/g) === 0, "a null uniswap destination renders no secondary button");
  else ok(count(tree, new RegExp(`class="token-btn token-btn-uni" href="${re(attr(treeState.uniswap))}"`, "g")) === 1,
    "a configured uniswap destination renders exactly once");
}
ok(!tree.includes(address), "the made-up address is not in the tree's page");
ok(!tree.includes(xAccount) && !tree.includes(telegram), "the made-up accounts are not in the tree's page");
ok(count(tree, /class="out"/g) === 3 && outHrefs(tree)[1] === X_DEFAULT && outHrefs(tree)[2] === TELEGRAM_DEFAULT && count(tree, /data-i18n="nav\.telegram"/g) === 1, "the tree's page links the default X account and the confirmed Telegram room");

// The eight never lines are the product boundary, not ordinary copy. Pin the ordered set in every source language so
// a wording edit, a missing translation or a reordered line cannot pass merely because eight list items still exist.
const NEVER_DIGESTS = {
  en: "67a23b62b12149e602b7b7a397d789ebe98b1b75fd8326579024ba48ab837c97",
  es: "9142b4ed4fa3fe46194285b21410372c5edd550d7544c1fa4f618fe148b3dee2",
  pt: "0fdfd3d1028dbec27202cf27ec52ac1e8bfecc4a8025bce94a94bdcd2d052343"
};
for (const [lang, expected] of Object.entries(NEVER_DIGESTS)) {
  const strings = JSON.parse(fs.readFileSync(path.join(root, "src", "i18n-src", `chain.${lang}.json`), "utf8"));
  const lines = Array.from({ length: 8 }, (_, i) => strings[`road.never.l${i + 1}`]);
  const actual = crypto.createHash("sha256").update(JSON.stringify(lines)).digest("hex");
  ok(lines.every(line => typeof line === "string" && line.length > 0) && actual === expected, `${lang}: the eight never lines stay word for word and in order`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`chain token states: ${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
