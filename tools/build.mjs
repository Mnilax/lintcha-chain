// lintcha-chain build. Node standard library only, no dependency. Reads the templates, substitutes every figure from
// site/launch-numbers.json and site/launch-index.json, inlines the i18n island, writes the page into site/ (the served
// directory). One page and a 404; English only is emitted while the i18n machinery stays whole.
//   node tools/build.mjs [--origin https://your.host] [--token path/to/token.json] [--out dir]
// What it does, in order:
//   - merges src/i18n-src/{launch,chain}.<lang>.json into src/i18n/<lang>.json (tools/i18n-merge.mjs; a duplicate key aborts)
//   - lifts the theme script and the <main> block out of the vendored src/templates/launch.html, untouched: the script
//     byte for byte so the CSP hash in site/_headers keeps matching (checked here); the block with its ids, order and
//     wording as approved. The vendored <section class="launch-fixed"> (the four paragraphs) is lifted out of that
//     block and placed as section five, where the approved design puts it; nothing in it is reworded
//   - renders src/templates/shell.html around them: the sections in the owner's order and numbering (below), the
//     sections whose prose is still with the owner removed whole (PENDING, below), {{t:key}} strings, data-i18n text
//     and attributes filled at build time, data-i18n-vars figures, the nav, the header cluster, the token block in its
//     three states (site/token.json), the charts and the ornament (tools/build-viz.mjs), the method tables from the
//     engine (tools/build-method.mjs)
//   - refuses a digit in the text of a template or in an i18n string of this site (the gate, below)
//   - writes site/index.html and site/404.html (the same shell around two approved strings, the wordmark and the nav
//     pointing back at the page)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { mergeAll } from "./i18n-merge.mjs";
import { charts, ornament } from "./build-viz.mjs";
import { loadEngine, normalization, alias, skeleton, indexTable } from "./build-method.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, "..");
const SRC = path.join(root, "src"), SITE = path.join(root, "site");
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const ORIGIN = (opt("origin", "") || "").replace(/\/$/, "");
const OUT = path.resolve(root, opt("out", SITE));                       // where index.html is written; the tree's site/ unless a test says otherwise
const TOKEN_FILE = path.resolve(root, opt("token", path.join(SITE, "token.json")));   // the token block's one input; a test may point at a temporary file
const REPO = "https://github.com/Mnilax/lintcha-chain";                 // GITHUB and Repository go to this repository (LINTCHA_CHAIN_05, section 2)
const X_URL = "https://x.com/mnilax";                                   // the account lintcha's own footer links (vendored launch.html)
const read = p => fs.readFileSync(p, "utf8");
const EMIT = ["en"];   // languages emitted; the string tables carry all three
const abort = m => { console.error("build aborted: " + m); process.exit(1); };

// ---------------------------------------------------------------- the sections: the owner's order and numbers (2026-09-09), fixed
// The number is a label the reader refers to and the anchor is named by (#s01 ... #s11), so a section keeps its number
// even while an earlier one is not yet on the page.
const ORDER = ["process", "tool", "reads", "definitions", "limits", "window", "reproduce", "origin", "method", "viz", "faq"];
const NUM = {}; ORDER.forEach((k, i) => { NUM[k] = String(i + 1).padStart(2, "0"); });
// Sections whose prose is still with the owner ("Propose the English to me before it lands"): removed whole from the
// page, template markup included, so nothing unapproved renders and nothing renders empty. Remove a key here in the
// same change that lands its strings; a missing string then aborts the build instead of shipping a blank.
const PENDING = [];   // every section's English is approved (2026-09-09); the mechanism stays for the next string that waits
const NAV = [{ key: "nav.tool", sec: "tool" }, { key: "nav.method", sec: "method" }, { key: "nav.faq", sec: "faq" }];

// ---------------------------------------------------------------- strings
const merged = mergeAll();
const i18n = {}; for (const r of merged) i18n[r.lang] = JSON.parse(read(r.file));
const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);
function t(lang, key, vars) {
  const s = i18n[lang][key];
  if (typeof s !== "string") abort(`missing i18n key [${lang}] ${key}`);
  return fill(s, vars);
}
// a string that may not exist yet (a chart caption whose English is with the owner): empty rather than invented
function tOpt(lang, key, vars) { const s = i18n[lang][key]; return typeof s === "string" ? fill(s, vars) : ""; }
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escText = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inlineJson = obj => JSON.stringify(obj).replace(/<\//g, "<\\/");

// ---------------------------------------------------------------- the figures: every one from launch-numbers.json or the index
const numbers = JSON.parse(read(path.join(SITE, "launch-numbers.json")));
const indexBytes = fs.readFileSync(path.join(SITE, "launch-index.json"));
const index = JSON.parse(indexBytes.toString("utf8"));
const stamp = iso => iso.slice(0, 10) + " " + iso.slice(11, 16);   // 2026-09-07T10:36:34.000Z -> 2026-09-07 10:36
// The specimen (section one, stage four): three made-up figures drawn in the diagram to show the shape of a result.
// They are marked SPECIMEN on the page, carry no badge, and are the only figures on the page that come from nowhere.
// Chosen so they cannot be mistaken for a reading (the owner's, 2026-09-09): a round thousand carried by a thousand
// deployers, ten spellings; the mock's 48 and 41 were a real day's values for one ticker.
const SPECIMEN = { sp_n: 1000, sp_d: 1000, sp_v: 10 };
function figures(lang) {
  const nf = new Intl.NumberFormat(lang), w = numbers.window, c = numbers.collector || {};
  return Object.assign({
    from_date: w.from_date, to_date: w.to_date, from_block: w.from_block, to_block: w.to_block, from_stamp: stamp(w.from_time), to_stamp: stamp(w.to_time),
    blocks: nf.format(w.blocks), hours: w.hours, chain_id: numbers.chain_id, launches: nf.format(numbers.launches_scanned), collected: numbers.collected,
    min_words: numbers.description_min_words, count_floor: numbers.count_floor, recipient_floor: recipientFloor(),
    index_hash: crypto.createHash("sha256").update(indexBytes).digest("hex"), index_bytes: nf.format(numbers.index.bytes), index_entries: nf.format(numbers.index.entries_total),
    calls: nf.format(c.calls), limited: nf.format(c.http_429), retries: nf.format(c.retries), errors: nf.format(c.other_errors), seconds: nf.format(c.seconds), in_log: nf.format(c.launches_in_log)
  }, { sp_n: nf.format(SPECIMEN.sp_n), sp_d: nf.format(SPECIMEN.sp_d), sp_v: nf.format(SPECIMEN.sp_v) });
}
function recipientFloor() {   // the fee recipient's second floor (d >= 2) is stated by the index schema, read from there
  const schema = JSON.parse(read(path.join(root, "tools", "launch-index-schema.json")));
  return schema.$defs.recipient_entry.properties.d.minimum;
}

// ---------------------------------------------------------------- the vendored template: the theme script and the <main> block
const vendored = read(path.join(SRC, "templates", "launch.html"));
const themeScript = (vendored.match(/<script>[\s\S]*?<\/script>/) || [])[0];
if (!themeScript) abort("no inline theme script in the vendored template");
const mainWhole = (vendored.match(/<main>[\s\S]*?<\/main>/) || [])[0];
if (!mainWhole) abort("no <main> block in the vendored template");
const fixed = (mainWhole.match(/<section class="launch-fixed">[\s\S]*?<\/section>/) || [])[0];
if (!fixed) abort("no launch-fixed section in the vendored <main>");
const main = mainWhole.replace(fixed, "").replace(/\n\s*\n/g, "\n");
// the CSP in the vendored _headers names the hash of that script; the shell carries it byte for byte, so check it here
const hash = "'sha256-" + crypto.createHash("sha256").update(themeScript.replace(/^<script>|<\/script>$/g, ""), "utf8").digest("base64") + "'";
const headers = read(path.join(SITE, "_headers"));
if (!headers.includes(hash)) abort("site/_headers does not carry the theme script's hash " + hash);

// ---------------------------------------------------------------- the engine, for the method tables
const engine = loadEngine(SITE);

// ---------------------------------------------------------------- the token block: three states from one file, nothing while address is null
//   a. no address: the header cluster is GITHUB and X, no contract row, no token section, no empty slot
//   b. address and a pons link: BUY $LINTCHA (the one filled button on the site) joins the cluster, the contract row
//      sits under the status strip, section twelve carries the address, the pons button and the live tiles
//   c. a uniswap link as well: the outline button arrives beside the pons one; each renders only when its link exists
const token = JSON.parse(read(TOKEN_FILE));
const outbound = (href, key) => `<a class="out" href="${esc(href)}" rel="noopener" target="_blank"><span data-i18n="${key}"></span><span class="arrow" aria-hidden="true">↗</span></a>`;
function cluster() {
  const items = [outbound(REPO, "nav.github"), outbound(X_URL, "nav.x")];
  if (token.address && token.pons) items.push(`<a class="buy" href="${esc(token.pons)}" rel="noopener" target="_blank" data-i18n="token.buy"></a>`);
  return items.join("");
}
function contractRow() {
  if (!token.address) return "";
  return `<div class="contract"><div class="contract-in"><span class="contract-label" data-i18n="token.contract"></span><code class="contract-address" data-token-address>${escText(token.address)}</code><button type="button" class="btn-copy" data-copy-address data-i18n-attr="data-label-copied:token.copied"><span data-copy-label data-i18n="token.copy"></span></button></div></div>\n`;
}
function tokenSection(lang) {
  if (!token.address) return "";
  const n = String(ORDER.length + 1).padStart(2, "0");
  // the section's two sentences are prose and land only once approved: until then the section carries the address,
  // the buttons and the tiles, and no paragraph
  const prose = ["token.p1", "token.p2"].filter(k => tOpt(lang, k)).map(k => `  <p class="sec-p sec-p-lg" data-i18n="${k}"></p>
`).join("");
  const btn = (k, cls) => (token[k] ? `<a class="token-btn token-btn-${cls}" href="${esc(token[k])}" rel="noopener" target="_blank" data-i18n="token.${k}"></a>` : "");
  const tile = key => `<div class="cell"><span class="badge badge-live" data-i18n="token.live"></span><div class="cell-v" data-i18n="token.dash"></div><div class="cell-l" data-i18n="${key}"></div></div>`;
  return `<section class="sec token-sec" id="s${n}" data-sec="${n}">
  <div class="sec-head"><span class="num" data-num="${n}">${n}</span><h2 class="sec-h" data-i18n="token.h2"></h2></div>
${prose}  <code class="token-address" data-token-address>${escText(token.address)}</code>
  <div class="token-btns">${btn("pons", "pons")}${btn("uniswap", "uni")}</div>
  <div class="cells">${tile("token.tile.holders")}${tile("token.tile.transfers")}</div>
</section>
`;
}

// ---------------------------------------------------------------- the nav: anchors on the one page, by section number
// prefix "" on the page itself, "/" on the 404 page, whose anchors point back at the page
const nav = prefix => NAV.map(n => `<a href="${prefix}#s${NUM[n.sec]}" data-nav="${NUM[n.sec]}" data-i18n="${n.key}"></a>`).join("");

// ---------------------------------------------------------------- data-i18n fill, as the vendored page expects (text at build time, refilled at runtime by the island)
function fillI18n(html, lang, vars) {
  html = html.replace(/<(\w+)([^>]*?)\sdata-i18n="([^"]+)"([^>]*)><\/\1>/g, (m, tag, pre, key, post) => {
    const vm = /data-i18n-vars="([^"]*)"/.exec(pre + post);
    const sub = {}; if (vm) vm[1].split(",").forEach(k => { const n = k.trim(); if (!(n in vars)) abort(`unknown figure {${n}} in data-i18n-vars`); sub[n] = vars[n]; });
    return "<" + tag + pre + ' data-i18n="' + key + '"' + post + ">" + escText(t(lang, key, vm ? sub : null)) + "</" + tag + ">";
  });
  html = html.replace(/data-i18n-attr="([^"]+)"/g, (m, spec) => spec.split(";").map(pair => { const [attr, key] = pair.split(":"); return attr.trim() + '="' + esc(t(lang, key.trim())) + '"'; }).join(" ") + " " + m);
  return html;
}

// ---------------------------------------------------------------- the digit gate
// RULE (the owner's, 2026-09-09): the gate was written against figures, not geometry, so it is testable rather than
// interpreted. The check reads rendered TEXT nodes of the templates and i18n string VALUES (every language, vendored
// keys included). Attributes are out of scope: viewBox, path data, initial-scale, charset, icon names, class names,
// data-check, data-stage. A digit inside a text node or a string value is a failure unless it arrived by substitution,
// and substitution happens after this check, through {var} slots in strings and data-i18n-vars in markup, from these
// sources and no other:
//   - site/launch-numbers.json and site/launch-index.json (the window, the counts, the collector's figures, the hash)
//   - the section order above (the section numbers, the stage numbers of the diagram, the check ids N1 to I4)
//   - the engine's own tables (tools/build-method.mjs: the alias table, the skeleton table, the recipient pattern)
//   - SPECIMEN above (three made-up figures, marked as such on the page and carrying no badge)
function digitsInText(html, name) {
  const text = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]*>/g, " ").replace(/\{\{[^}]*\}\}/g, " ");
  const m = text.match(/\d/);
  if (m) abort(`${name} carries a digit in a text node: "${text.slice(Math.max(0, m.index - 30), m.index + 30).trim()}"`);
}
for (const lang of Object.keys(i18n)) for (const [k, v] of Object.entries(i18n[lang])) if (/\d/.test(v)) abort(`i18n ${lang}: digit in the value of ${k}`);

// ---------------------------------------------------------------- the sections: pending ones removed, the rest numbered
function sections(html) {
  for (const k of PENDING) {
    const re = new RegExp(`\\n?<!-- section:${k} -->[\\s\\S]*?<!-- /section:${k} -->\\n?`);
    if (!re.test(html)) abort(`pending section "${k}" has no fenced block in the template`);
    html = html.replace(re, "\n");
  }
  html = html.replace(/<!-- \/?section:\w+ -->\n?/g, "");
  html = html.replace(/<section class="sec([^"]*)" data-sec="(\w+)">([\s\S]*?)<span class="num" data-num><\/span>/g, (m, cls, key, mid) => {
    if (!NUM[key]) abort(`section "${key}" is not in the order`);
    return `<section class="sec${cls}" id="s${NUM[key]}" data-sec="${NUM[key]}">${mid}<span class="num" data-num="${NUM[key]}">${NUM[key]}</span>`;
  });
  let stage = 0;
  html = html.replace(/<span class="dg-num" data-stage-num><\/span>/g, () => { const n = String(++stage).padStart(2, "0"); return `<span class="dg-num" data-stage-num="${n}">${n}</span>`; });
  html = html.replace(/<span class="reads-id" data-check="(\w+)"><\/span>/g, (m, id) => `<span class="reads-id" data-check="${id}">${id}</span>`);
  return html;
}

// ---------------------------------------------------------------- render
const abs = p => (ORIGIN ? ORIGIN + p : p);
function render(tplName, lang, extra) {
  let html = read(path.join(SRC, "templates", tplName));
  digitsInText(html, "templates/" + tplName);
  const vars = figures(lang);
  const T = (key, v) => t(lang, key, v), TO = (key, v) => tOpt(lang, key, v);
  const nf = new Intl.NumberFormat(lang);
  const landed = k => !PENDING.includes(k);
  const tokens = Object.assign({
    lang, root: "/", url: abs("/"), og_image: abs("/og.png"), theme_script: themeScript, main, fixed, nav: nav(""), cluster: cluster(),
    contract_row: contractRow(), token_section: tokenSection(lang), repo: REPO, anchor_method: "#s" + NUM.method,
    charts: landed("viz") ? charts(index, numbers, T, TO, lang) : "", ornament: landed("viz") ? ornament(T) : "",
    method_norm: landed("method") ? normalization(T, engine.L) : "", method_alias: landed("method") ? alias(T, engine.Links) : "",
    method_skeleton: landed("method") ? skeleton(T, engine.Skeleton) : "", method_index: landed("method") ? indexTable(T, numbers, engine.L, nf) : "",
    i18n_json: inlineJson({ lang, strings: i18n[lang], fallback: lang === "en" ? null : i18n.en })
  }, extra || {});
  html = sections(html);
  html = html.replace(/\{\{t:([\w.]+)\}\}/g, (m, key) => esc(t(lang, key)));
  html = html.replace(/\{\{(\w+)\}\}/g, (m, k) => { if (!(k in tokens)) abort("unknown token " + k); return tokens[k]; });
  return fillI18n(html, lang, vars);
}

fs.mkdirSync(OUT, { recursive: true });
for (const lang of EMIT) {
  fs.writeFileSync(path.join(OUT, "index.html"), render("shell.html", lang));
  if (fs.existsSync(path.join(SRC, "templates", "404.html"))) fs.writeFileSync(path.join(OUT, "404.html"), render("404.html", lang, { url: abs("/404"), nav: nav("/"), anchor_method: "/#s" + NUM.method }));
}
const out = fs.readFileSync(path.join(OUT, "index.html"));
const state = !token.address ? "a, off (address null)" : token.uniswap ? "c, pons and uniswap" : token.pons ? "b, pons only" : "address without a buy link";
console.log(`built ${path.relative(root, path.join(OUT, "index.html"))}: ${out.length} bytes, ${EMIT.join(",")} emitted of ${Object.keys(i18n).join(",")}; theme script hash present in _headers; token state ${state}; sections on the page ${ORDER.filter(k => !PENDING.includes(k)).map(k => NUM[k]).join(" ")}, pending ${PENDING.map(k => NUM[k] + " " + k).join(", ")}; window ${numbers.window.from_date} to ${numbers.window.to_date}, blocks ${numbers.window.from_block} to ${numbers.window.to_block}, ${numbers.launches_scanned} launches`);
