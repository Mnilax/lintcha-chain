// lintcha-chain, the tables of the method section, written at build time from the engine itself so they cannot drift
// from it: the alias table from site/launch-links.js, the skeleton table from site/launch-skeleton.js, the namespaces of
// the index from site/launch-numbers.json, the fee recipient's pattern checked against site/launch.js by behaviour.
// The sentences of the section (what each field is compared as) are i18n strings; the tables here carry values only,
// so every digit in them arrives from the code or the numbers file, never from a template or a string.
import path from "node:path";
import { createRequire } from "node:module";

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cp = ch => { const c = ch.codePointAt(0); return c < 128 ? ch : "U+" + c.toString(16).toUpperCase().padStart(4, "0"); };

export function loadEngine(siteDir) {
  const require = createRequire(import.meta.url);
  return { L: require(path.join(siteDir, "launch.js")), Links: require(path.join(siteDir, "launch-links.js")), Skeleton: require(path.join(siteDir, "launch-skeleton.js")) };
}

// The recipient pattern is not exported by launch.js; the literal below is checked against recipient() by behaviour on
// every build: an address of forty hex characters reads ok, thirty-nine and forty-one do not, and the zero address is empty.
export function recipientPattern(L) {
  const pattern = "^0x[0-9a-f]{40}$";
  const ok = L.normalize.recipient("0x" + "a".repeat(40)).state === "ok" && L.normalize.recipient("0x" + "a".repeat(39)).state === "not readable"
    && L.normalize.recipient("0x" + "a".repeat(41)).state === "not readable" && L.normalize.recipient("0x" + "0".repeat(40)).state === "empty"
    && L.normalize.recipient("0X" + "A".repeat(40)).state === "ok" && new RegExp(pattern).test("0x" + "a".repeat(40)) && !new RegExp(pattern).test("0x" + "a".repeat(39));
  if (!ok) throw new Error("the recipient pattern printed by the method section no longer matches launch.js");
  return pattern;
}

// the MARKS character class, read from its source: each escape or range becomes a code point or a range of them
export function marksList(Skeleton) {
  const src = Skeleton.MARKS.source.replace(/^\[|\]$/g, ""), out = [];
  const re = /\\u([0-9a-fA-F]{4})(?:-\\u([0-9a-fA-F]{4}))?/g; let m;
  while ((m = re.exec(src))) out.push("U+" + m[1].toUpperCase() + (m[2] ? "–U+" + m[2].toUpperCase() : ""));
  return out.join(", ");
}

const to = '<span class="to">→</span>';
const row = (k, v) => `<div class="tbl-row"><span class="tbl-k">${k}</span><span class="tbl-v">${v}</span></div>`;

// the normalization table: the field names and the sentences are strings (t), the recipient pattern is substituted
export function normalization(t, L) {
  const fields = ["link_raw", "link_folded", "logo", "recipient", "description", "ticker", "name", "skeleton"];
  const vars = { recipient_pattern: recipientPattern(L), min_words: L.MIN_WORDS };
  const cell = key => esc(t("method.norm." + key + ".v", vars)).replace(/\{code\}([\s\S]*?)\{\/code\}/g, "<code>$1</code>")   // non-greedy: the recipient pattern itself carries braces;
  return `<div class="tbl"><div class="tbl-head"><span>${esc(t("method.norm.head.k"))}</span><span>${esc(t("method.norm.head.v"))}</span></div>` +
    fields.map(f => row(esc(t("method.norm." + f + ".k")), cell(f))).join("") + "</div>";
}

export function alias(t, Links) {
  const hosts = Object.keys(Links.HOSTS).map(h => `<div>${esc(h)} ${to} ${esc(Links.HOSTS[h])}</div>`).join("");
  const byField = Object.keys(Links.PLATFORM).map(f => `<div>${esc(f)} ${to} ${esc(Links.PLATFORM[f])}/&lt;${esc(t("method.alias.handle_word"))}&gt;</div>`).join("");
  const handle = esc(Links.HANDLE.source) + (Links.HANDLE.ignoreCase ? ` <span class="to">${esc(t("method.alias.handle_ci"))}</span>` : "");
  return `<div class="cards"><div class="card"><div class="card-t">${esc(t("method.alias.hosts"))}</div>${hosts}</div>` +
    `<div class="card"><div class="card-t">${esc(t("method.alias.byfield"))}</div>${byField}<div class="card-t">${esc(t("method.alias.handle"))}</div><div>${handle}</div></div></div>`;
}

export function skeleton(t, Skeleton) {
  const chars = Object.keys(Skeleton.CHARS).map(k => `<div>${esc(cp(k))} ${to} ${esc(Skeleton.CHARS[k])}</div>`).join("");
  const pairs = Skeleton.PAIRS.map(([a, b]) => `${esc(a)} ${to} ${esc(b)}`).join(" &nbsp;&nbsp; ");
  return `<div class="skel"><div class="skel-grid">${chars}</div><div class="skel-foot">` +
    `<div><span class="lbl">${esc(t("method.skeleton.pairs"))}</span>${pairs}</div>` +
    `<div><span class="lbl">${esc(t("method.skeleton.removed"))}</span>${esc(marksList(Skeleton))}</div></div></div>`;
}

export function indexTable(t, numbers, L, nf) {
  const e = numbers.index.entries;
  const rows = L.NAMESPACES.map(ns => `<div class="tbl-row"><span>${esc(ns)}</span><span class="tbl-n">${nf.format(e[ns])}</span></div>`).join("");
  return `<div class="tbl tbl-idx"><div class="tbl-head"><span>${esc(t("method.index.head.ns"))}</span><span class="tbl-n">${esc(t("method.index.head.n"))}</span></div>${rows}` +
    `<div class="tbl-row tbl-total"><span>${esc(t("method.index.total", { index_bytes: nf.format(numbers.index.bytes) }))}</span><span class="tbl-n">${nf.format(numbers.index.entries_total)}</span></div></div>`;
}
