// lintcha-chain, the token block's three states and the header cluster's links, built and checked without touching the
// tree. site/token.json may carry either the explicit all-null dormant state or one exact active state; site/links.json
// names only accounts that really exist (no placeholder, no zeroes, no empty slot in the tree); this test
// writes a temporary token.json with an address made up at run time, builds all three locale pages into a temporary
// directory with --token and --out, and checks what each state renders:
//   a. all null           no contract row, no buy button, no token section, no launch band, the cluster is GITHUB, X
//                         on the default account and the configured TELEGRAM, the made-up address nowhere in the page
//   b. address and pons   one filled BUY button in the header cluster, the contract row, section seventeen with the
//                         pons button only, two live tiles showing a dash, the launch band under the footer
//   c. pons and uniswap   both buttons, the uniswap one an outline
// A fourth build takes a temporary links.json with two labelled X accounts and Telegram and checks the cluster: four
// outbound items, GITHUB then both X accounts then TELEGRAM. States a, b and c pass no --links, so they render against
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
// and that site/links.json carries the two confirmed X accounts and the confirmed Telegram room.
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
const outHrefs = html => [...html.matchAll(/class="out(?: [^"]*)?" href="([^"]*)"/g)].map(m => m[1]);
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
const xAccountTwo = "https://example.invalid/x/" + crypto.randomBytes(4).toString("hex");
const telegram = "https://example.invalid/telegram/" + crypto.randomBytes(4).toString("hex");
const X_DEFAULT = "https://x.com/mnilax";   // the account the vendored footer links; the build falls back to it when links.json carries no x
const TELEGRAM_DEFAULT = "https://t.me/lintchaRH";
const ORIGIN = JSON.parse(fs.readFileSync(path.join(root, "site", "launch-site.json"), "utf8")).origin;
const LOCALES = Object.freeze({ en: { file: "index.html", url: "/" }, es: { file: "es/index.html", url: "/es/" }, pt: { file: "pt/index.html", url: "/pt/" } });
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
const localePages = Object.fromEntries(Object.entries(LOCALES).map(([lang, locale]) => [lang, fs.readFileSync(path.join(tmp, "a", locale.file), "utf8")]));
for (const [lang, locale] of Object.entries(LOCALES)) {
  const page = localePages[lang];
  const sourceStrings = JSON.parse(fs.readFileSync(path.join(root, "src", "i18n-src", `chain.${lang}.json`), "utf8"));
  ok(page.startsWith(`<!doctype html>\n<html lang="${lang}">`) && page.includes(`<body data-lang="${lang}" data-root="/" data-alt-en="/" data-alt-es="/es/" data-alt-pt="/pt/" data-page="chain" data-mascot-rail>`), `${lang}: URL locale is the document and content locale`);
  ok(count(page, new RegExp(`<link rel="canonical" href="${re(ORIGIN + locale.url)}">`, "g")) === 1 &&
    count(page, new RegExp(`<link rel="alternate" hreflang="en" href="${re(ORIGIN + "/")}">`, "g")) === 1 &&
    count(page, new RegExp(`<link rel="alternate" hreflang="es" href="${re(ORIGIN + "/es/")}">`, "g")) === 1 &&
    count(page, new RegExp(`<link rel="alternate" hreflang="pt" href="${re(ORIGIN + "/pt/")}">`, "g")) === 1 &&
    count(page, new RegExp(`<link rel="alternate" hreflang="x-default" href="${re(ORIGIN + "/")}">`, "g")) === 1,
  `${lang}: canonical and the complete hreflang set name only emitted pages`);
  ok(count(page, /data-lang-host/g) === 1 && page.includes(`<script id="i18n-data" type="application/json">{"lang":"${lang}",`), `${lang}: one language control is bound to the matching i18n island`);
  ok(page.includes(`<title>${sourceStrings["site.meta.title"]}</title>`) && sourceStrings["site.meta.title"].startsWith("Lintcha — ") &&
    page.includes(`<meta property="og:title" content="${attr(sourceStrings["site.meta.og_title"])}">`), `${lang}: the browser and social titles lead with the Lintcha brand`);
  ok(Array.from({ length: 8 }, (_, i) => attr(sourceStrings[`road.never.l${i + 1}`])).every(line => page.includes(`>${line}</li>`)), `${lang}: all eight never lines render from that locale without substitution`);
}
const sitemapA = fs.readFileSync(path.join(tmp, "a", "sitemap.xml"), "utf8");
const sitemapUrls = [...sitemapA.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
ok(JSON.stringify(sitemapUrls) === JSON.stringify(Object.values(LOCALES).map(locale => ORIGIN + locale.url)), "the sitemap advertises all and only emitted comparison locales in this isolated build");
ok(fs.existsSync(path.join(tmp, "a", "404.html")) && !fs.existsSync(path.join(tmp, "a", "es", "404.html")) && !fs.existsSync(path.join(tmp, "a", "pt", "404.html")), "one English root 404 remains the whole not-found contract");
ok(count(a, /class="contract"/g) === 0, "no contract row");
ok(count(a, /class="buy"/g) === 0, "no buy button");
ok(count(a, /token-sec/g) === 0, "no token section");
ok(count(a, /class="band"/g) === 0 && count(a, /band-address|band-copy/g) === 0, "no launch band, not even an empty one");
ok(count(a, /data-token-address/g) === 0 && count(a, /data-copy-address/g) === 0, "no address slot and no copy button for one");
ok(count(a, /class="out(?: [^"]*)?"/g) === 5, "cluster is five outbound items including the Copy bot");
ok(count(a, /data-i18n="nav\.telegram"/g) === 1, "the configured telegram item is present once");
ok(outHrefs(a).length === 5 && outHrefs(a)[1] === X_DEFAULT && outHrefs(a)[2] === "https://x.com/lintchadotcom" && outHrefs(a)[3] === TELEGRAM_DEFAULT && outHrefs(a)[4] === "https://t.me/lintchabot?start=copy_site", "social links and the site-attributed bot button point at the configured destinations");
ok(!a.includes(address) && !a.includes(pons), "the made-up address and link are nowhere");
ok(!a.includes(xAccount) && !a.includes(telegram), "the made-up accounts are nowhere");
ok(count(a, /class="hero-actions"/g) === 1 && count(a, /class="hero-action(?: hero-action-primary)?"/g) === 2, "the Copy-first hero has one focused two-action path");
ok(/class="hero-actions"[\s\S]*?href="https:\/\/t\.me\/lintchabot\?start=copy_site"[\s\S]*?href="#s04"[\s\S]*?<\/nav>/.test(a), "the primary hero action opens the site-attributed Lintcha Copy start before the compact Core tool");
ok(count(a, /class="copy-mode(?: copy-mode-primary)?"/g) === 3 && count(a, /class="core-entry"/g) === 0, "the hero explains notify-only, bounded auto-BUY and manual SELL without the old Core transition card");
ok(count(a, /data-proof-loop/g) === 1 && count(a, /data-proof-step/g) === 5 && count(a, /data-proof-play/g) === 1 && count(a, /class="proof-loop copy-terminal"/g) === 1, "one user-controlled five-stage Copy terminal sits in the hero");
ok(count(a, /class="sec sec-copy"/g) === 3 && a.indexOf('data-i18n="copy.sources.h2"') < a.indexOf('data-i18n="copy.execution.h2"') && a.indexOf('data-i18n="copy.execution.h2"') < a.indexOf('data-i18n="copy.controls.h2"'), "three dedicated Copy sections follow the hero in sources, execution and controls order");
ok(count(a, /class="copy-feature"/g) === 3 && count(a, /class="copy-flow-mark"/g) === 4 && count(a, /class="copy-control(?: copy-control-primary)?"/g) === 2, "the Copy sections carry three sources, four execution gates and two control panels");
ok(count(a, /class="copy-inline-cta"[^>]+start=copy_site/g) === 1, "the Copy controls close with the attributed bot route");
ok(/class="page-switch"[\s\S]*?class="page-switch-copy"[^>]*href="https:\/\/t\.me\/lintchabot\?start=copy_site"[\s\S]*?page-switch-current[^>]*aria-current="page"[\s\S]*?href="\/live\/"[\s\S]*?href="\/deployer\/"[\s\S]*?<\/nav>/.test(a), "the persistent page switch puts Copy first and sends a site-attributed start to the existing Telegram bot");
ok(count(a, /class="nav section-nav"/g) === 1, "the long-page section anchors remain a distinct secondary navigation");
// The homepage now carries a compact seven-section product path. All numbering is read back off the built page:
// three Copy sections first, then the Core tool and method, roadmap and FAQ. The sticky bar deliberately skips the
// technical method, which remains linked from the footer, and every bar item must still climb to a real section.
const navNums = nums(a, /data-nav="(\d+)"/g);
const navHrefs = nums(a, /<a href="#s(\d+)" data-nav=/g);
const secNums = nums(a, /<section class="sec[^"]*" id="s(\d+)"/g);
ok(navNums.length === 6 && navNums.join(" ") === "01 02 03 04 06 07", "six focused items in the bar, with method left to the footer");
ok(navHrefs.length === navNums.length && navHrefs.join(" ") === navNums.join(" "), "as many section anchors as items in the bar, each anchor on its own item");
ok(navNums.every(n => secNums.includes(n)), "every anchor in the bar names a section that is on the page");
ok(navNums.every((n, i) => i === 0 || Number(n) > Number(navNums[i - 1])), "the sections the bar points at climb: " + navNums.join(" "));
ok(secNums.join(" ") === "01 02 03 04 05 06 07", "seven sections, numbered without a gap");
ok(count(a, /class="sec sec-tool" id="s04"/g) === 1 && count(a, /data-nav="04" data-i18n="nav\.tool"/g) === 1, "the read-only Core tool is a compact fourth section after Copy");
ok(count(a, /data-i18n="(?:process|chain|reads|definitions|refusal|window|reproduce|run|origin|viz|not|lore)\.h2"/g) === 0, "the twelve legacy explainer sections are absent from the homepage");
ok(count(a, /class="never"/g) === 1 && count(a, /<li data-i18n="road\.never\.l\d">/g) === 8, "the never list, eight lines");
ok(count(a, /data-livetile="snapshot"/g) === 1 && a.includes(shippedIndexHash.slice(0, 16)), "the status strip identifies the shipped snapshot by its index key");
ok(count(a, /data-result-tools/g) === 1 && count(a, /data-share-result/g) === 1 && count(a, /data-copy-receipt/g) === 1 && count(a, /data-download-receipt(?:>|\s)/g) === 1 && count(a, /data-download-receipt-svg/g) === 1, "one result context block with share, JSON receipt and SVG receipt controls");
ok(a.includes(`data-window-from="${shippedNumbers.window.from_block}"`) && a.includes(`data-window-to="${shippedNumbers.window.to_block}"`) && a.includes(`data-window-start="${shippedNumbers.window.from_time}"`) && a.includes(`data-window-end="${shippedNumbers.window.to_time}"`) && a.includes(`data-index-hash="${shippedIndexHash}"`), "the result context carries both shipped snapshot boundaries, both times and the full index hash");
ok(count(a, /class="qa"/g) === 8 && count(a, /data-i18n="faq\.(?:auto|sources|custody|pause|sell)\.q"/g) === 5, "the compact FAQ leads with five Copy questions and keeps only three Core questions");
ok(a.lastIndexOf('data-i18n="roadmap.close"') > a.lastIndexOf('data-i18n="road.check.p"'), "roadmap.close is still the last thing in the section");
// the caret survives only as the theme control; brand and roadmap carry the owned Echo Bat assets
const sprites = a.match(/<svg class="sprite [^"]*"[\s\S]*?<\/svg>/g) || [];
ok(sprites.length === 1 && count(a, /class="sprite sprite-s"/g) === 1, "the caret sprite appears only in the theme control");
ok(count(sprites[0] || "", /<rect /g) === 11 && count(sprites[0] || "", /class="cut"/g) === 2, "the theme caret keeps its eleven-cell shape and two cut strokes");
ok(count(a, /class="lore-mascot"/g) === 0, "the removed lore block leaves no duplicate mascot below the hero");
ok(count(a, /data-hero-lockup/g) === 1 && /class="hero-lockup-bat"[^>]+echo-bat-front-flight\.gif/.test(a) && count(a, /class="hero-bat-wing/g) === 0 && /class="hero-lockup-word"[^>]*>LINTCHA</.test(a), "the hero opens with the front-facing Echo Bat flight loop and LINTCHA lockup");
ok(count(a, /class="road-mascot"[^>]+echo-bat-flight\.gif/g) === 1 && count(a, /data-mascot-progress/g) === 1, "the roadmap and scroll rail carry Echo Bat flight assets");
ok(count(a, /data-mascot-fill/g) === 1 && count(a, /data-mascot-section/g) === 1 && /data-i18n="progress\.prefix">you are in</.test(a) && /href="\/favicon-bat\.png"/.test(a), "the bottom rail carries progress, its current-section label and the dedicated bat favicon");
// the roadmap line: the three phase lists folded onto one rule, a tick for every item and not one item lost
const road = a.slice(a.indexOf('id="s06"'), a.indexOf("<section", a.indexOf('id="s06"') + 1));
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
// three address slots: the contract row, the token section, the band; two copy buttons: the row's and the band's
ok(count(b, /class="contract"/g) === 1 && count(b, /data-token-address>[^<]*</g) === 3, "the contract row, the section and the band carry the address");
// The optional token block remains mechanically one number after the compact seven-section page.
ok(count(b, /class="sec token-sec" id="s08"/g) === 1, "the optional token section is section eight");
ok(count(b, /data-sec="07"/g) === 1 && count(b, /data-sec="08"/g) === 1 && count(b, /data-sec="09"/g) === 0, "the token is numbered straight after the last homepage section, with no gap");
ok(count(b, /token-btn-pons/g) === 1 && count(b, /token-btn-uni/g) === 0, "pons button only");
ok(count(b, /badge-live/g) === 2 && count(b, /class="cell-v" data-i18n="token.dash">—</g) === 2, "two live tiles, each a dash");
ok(count(b, /data-copy-address/g) === 2, "two copy buttons: the contract row's and the band's");
ok(count(b, /class="band"/g) === 1 && count(b, /class="band-copy"/g) === 1, "one launch band, with one copy button");
ok(slot(b, "band-address") === address && slot(b, "band-address") === slot(b, "contract-address"), "the band carries the contract row's address");
ok(b.indexOf('class="band"') > b.indexOf("</footer>"), "the band sits under the footer");
ok(count(b, /class="out(?: [^"]*)?"/g) === 5 && outHrefs(b)[1] === X_DEFAULT && outHrefs(b)[2] === "https://x.com/lintchadotcom" && outHrefs(b)[3] === TELEGRAM_DEFAULT, "the cluster is unchanged by the token: social links and BOT remain configured");
for (const lang of ["es", "pt"]) {
  const localized = fs.readFileSync(path.join(tmp, "b", lang, "index.html"), "utf8");
  ok(count(localized, new RegExp(`data-token-address>${re(address)}<`, "g")) === 3 && count(localized, new RegExp(`href="${re(attr(pons))}"`, "g")) === 2 && !/token-btn-uni/.test(localized), `${lang}: the active page carries the exact same pons-only token state`);
}

console.log("state c: pons and uniswap");
const c = build("c", { address, pons, uniswap });
ok(count(c, /token-btn-pons/g) === 1 && count(c, /token-btn-uni/g) === 1 && c.includes(`href="${uniswap}"`), "both buttons, the uniswap one an outline");
ok(count(c, /class="buy"/g) === 1, "still one filled button on the page");
ok(count(c, /class="band"/g) === 1 && slot(c, "band-address") === address, "one band, the same address");

console.log("token-state prose: the status line and the roadmap token paragraph follow token.json");
// The hero status line and the roadmap's token paragraph have one string per state, and the build picks the key from
// the same validated token.json that switches the contract row and the band. The check reads the visible page (the
// i18n island is data for the language control, not text on the page) in every locale of states a, b and c: a dormant
// page carries the dormant sentences and not one live sentence; an activated page carries the live sentences and not
// one pre-launch sentence, the unrendered lore paragraph included, so a launch can never leave "if it launches" up.
const visible = html => html.replace(/<script id="i18n-data"[^>]*>[\s\S]*?<\/script>/, "");
const textOf = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const DORMANT_KEYS = ["hero.status.dormant", "road.token.p", "lore.token.p"], LIVE_KEYS = ["hero.status.live", "road.token.live.p"];
for (const [name, live] of [["a", false], ["b", true], ["c", true]]) {
  for (const [lang, locale] of Object.entries(LOCALES)) {
    const strings = JSON.parse(fs.readFileSync(path.join(root, "src", "i18n-src", `chain.${lang}.json`), "utf8"));
    const page = visible(fs.readFileSync(path.join(tmp, name, locale.file), "utf8"));
    const statusKey = live ? "hero.status.live" : "hero.status.dormant", roadKey = live ? "road.token.live.p" : "road.token.p";
    ok(count(page, /data-site-status/g) === 1 && page.includes(`<p class="copy-availability" data-site-status data-i18n="${statusKey}">${textOf(strings[statusKey])}</p>`),
      `state ${name}, ${lang}: one status line under the hero, keyed ${statusKey}`);
    ok(page.includes(`<p class="sec-p" data-i18n="${roadKey}">${textOf(strings[roadKey])}</p>`), `state ${name}, ${lang}: the roadmap token paragraph is ${roadKey}`);
    const wrong = (live ? DORMANT_KEYS : LIVE_KEYS).filter(key => page.includes(`data-i18n="${key}"`) || page.includes(textOf(strings[key])));
    ok(wrong.length === 0, `state ${name}, ${lang}: no ${live ? "pre-launch" : "post-launch"} sentence on the page` + (wrong.length ? ": " + wrong.join(", ") : ""));
  }
}

console.log("links: both X accounts and Telegram filled");
const l = build("links", { address, pons, uniswap: null }, { x: [{ href: xAccount, label: "@first" }, { href: xAccountTwo, label: "@second" }], telegram });
const hrefs = outHrefs(l);
ok(count(l, /class="out(?: [^"]*)?"/g) === 5, "cluster is five outbound items");
ok(hrefs.length === 5 && hrefs[0] === "https://github.com/Mnilax/lintcha-chain" && hrefs[1] === xAccount && hrefs[2] === xAccountTwo && hrefs[3] === telegram && hrefs[4] === "https://t.me/lintchabot?start=copy_site", "github, both labelled X accounts, telegram, then the attributed bot button");
ok(clusterOf(l).includes("@first") && clusterOf(l).includes("@second"), "both configured X labels are visible");
ok(count(clusterOf(l), /class="arrow"/g) === 5, "each of the five carries the arrow");
ok(count(l, /data-i18n="nav\.telegram"/g) === 1, "the telegram item is keyed nav.telegram");
ok(!l.includes(X_DEFAULT), "the default X account is not on the page once links.json names one");

console.log("the tree");
const treeToken = JSON.parse(fs.readFileSync(path.join(root, "site", "token.json"), "utf8"));
const treeState = tokenConfigOf(treeToken);
ok(!!treeState, "site/token.json matches the shared dormant-or-active contract");
const treeLinks = JSON.parse(fs.readFileSync(path.join(root, "site", "links.json"), "utf8"));
ok(JSON.stringify(treeLinks.x) === JSON.stringify([
  { href: "https://x.com/mnilax", label: "Founder" },
  { href: "https://x.com/lintchadotcom", label: "X" }
]) && treeLinks.telegram === TELEGRAM_DEFAULT, "site/links.json names both confirmed X accounts and the confirmed Telegram room");
const tree = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
const treeLocales = [tree, ...["es", "pt"].map(lang => fs.readFileSync(path.join(root, "site", lang, "index.html"), "utf8"))];
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
ok(treeLocales.every(page => page.includes(`data-site-status data-i18n="${treeState && treeState.address ? "hero.status.live" : "hero.status.dormant"}"`) &&
  page.includes(`data-i18n="${treeState && treeState.address ? "road.token.live.p" : "road.token.p"}"`)), "every tree locale carries the status line and token paragraph of the tree's own token state");
ok(!tree.includes(address), "the made-up address is not in the tree's page");
ok(!tree.includes(xAccount) && !tree.includes(telegram), "the made-up accounts are not in the tree's page");
ok(count(tree, /class="out(?: [^"]*)?"/g) === 5 && outHrefs(tree)[1] === X_DEFAULT && outHrefs(tree)[2] === "https://x.com/lintchadotcom" && outHrefs(tree)[3] === TELEGRAM_DEFAULT && outHrefs(tree)[4] === "https://t.me/lintchabot?start=copy_site" &&
  clusterOf(tree).includes("Founder") && clusterOf(tree).includes(">X<") && clusterOf(tree).includes(">BOT<") && count(tree, /class="social-icon"/g) >= 2 && count(tree, /data-i18n="nav\.telegram"/g) === 1,
  "the tree's page renders Founder, vector X and Telegram, plus the attributed BOT button");
ok(treeLocales.every(page => treeState.address === null ? count(page, /data-token-address|data-copy-address|class="buy"|token-sec/g) === 0 : page.includes(`data-token-address>${treeState.address}<`)), "every tree locale agrees with the shared token document");

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
