// Launch identity, the extraction constraint file by file (LINTCHA_12, hard gate 4 and section 11): nothing the
// collector read from the chain leaves it as itself. No address, no raw link, no handle, no name and no description of a
// launch may appear in any served file, any frozen file, any report, any log or any page. What may appear is listed per
// file as an allowance and printed next to every hit, so a reader sees what was found and why it is not an extraction:
// the collector's own constants (the endpoint, the factory, Multicall3), the alias table's hosts, the site's own footer
// links, and the made-up inputs of the browser run. Anything else fails.
//   node tests/launch_extraction.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADDRESS = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;   // forty hex exactly: a sixty-four hex string is a hash, not an address
const URL_ = /\bhttps?:\/\/[^\s"'<>)]+/g;
const HOSTPATH = /\b(?:[a-z0-9-]+\.)+(?:com|io|gg|me|dog|xyz|org|net|app|chat|link|co)\/[A-Za-z0-9_./?=&-]+/g;
const HANDLE = /(^|[\s"(])@[A-Za-z0-9_]{3,}/g;

// the collector's own constants: not read from the chain, written into the tool
const CONSTANTS = ["0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e", "0xcA11bde05977b3631167028862bE2a173976CA11", "https://rpc.mainnet.chain.robinhood.com"];
// the alias table and its tests name platform hosts, never a page on them
const ALIAS_HOSTS = /^(?:(?:mobile\.|m\.|www\.)?(?:twitter|x)\.com|(?:telegram\.(?:me|dog)|t\.me))\//;
// the site's own footer and head links
const SITE = /^https:\/\/(?:lintcha\.com|github\.com\/Mnilax\/lintcha|t\.me\/dobzhik|x\.com\/mnilax|fonts\.gstatic\.com)/;
// the browser run's made-up inputs (tests/launch_browser.mjs) and the engine tests' made-up values
// "bob", "foo", "abc", "shared", "handle", "QmAbc", "QmLogo", a ".example" host, "a.b", "d.e", "gateway.io" and the run's own
// "made up" values are the fixtures of tests/launch_test.js, tests/launch_abi_test.mjs and tests/launch_browser.mjs
const MADE_UP = /made[_ -]?up|example\.com|\.example\b|\bbob\b|\/foo\b|\/abc\b|\/shared\b|@handle\b|QmAbc|QmLogo|^https?:\/\/a\.b\/|gateway\.io\/ipfs\/QmAbc|discord\.gg\/(?:abcd|AbCd)|t\.me\/joinchat|telegram\.(?:me|dog)\/rob|0x0{39}1|0x0{40}|0x1{40}|0x(?:ab){20}|0x(?:cd){20}|0xabc/i;

const FILES = [
  // served and frozen
  { f: "site/launch-index.json", allow: [] },
  { f: "site/launch-numbers.json", allow: [] },
  { f: "site/dist/launch/index.html", allow: ["site"] },
  { f: "site/dist/es/launch/index.html", allow: ["site"] },
  { f: "site/dist/pt/launch/index.html", allow: ["site"] },
  { f: "site/i18n/en.json", allow: ["site"] },
  { f: "site/i18n/es.json", allow: ["site"] },
  { f: "site/i18n/pt.json", allow: ["site"] },
  { f: "site/launch.js", allow: [] },
  { f: "site/launch-page.js", allow: [] },
  { f: "site/launch-skeleton.js", allow: [] },
  { f: "site/launch-links.js", allow: ["alias"] },
  { f: "site/launch.css", allow: [] },
  { f: "site/flags.json", allow: [] },
  { f: "site/launch-site.json", allow: ["site"] },
  { f: "build/launch-i18n.en.json", allow: [] },
  { f: "build/launch-i18n.es.json", allow: [] },
  { f: "build/launch-i18n.pt.json", allow: [] },
  { f: "tools/launch/MANIFEST.md", allow: ["site"] },
  // reports, logs and intermediate files
  { f: "build/launch-index-report.json", allow: [] },
  { f: "build/launch-day.json", allow: [] },
  { f: "build/launch-acceptance-smoke.json", allow: [], optional: true },
  { f: "build/launch-browser.json", allow: ["madeup"] },
  { f: "build/launch-day.log", allow: ["constants"], optional: true },
  // tools and tests
  { f: "tools/launch-collect.mjs", allow: ["constants"] },
  { f: "tools/launch-index.mjs", allow: [] },
  { f: "tools/launch/rpc.mjs", allow: ["constants", "site"] },
  { f: "tools/launch/abi.mjs", allow: [] },
  { f: "tools/launch/keccak.mjs", allow: [] },
  { f: "tools/launch/schema.mjs", allow: [] },
  { f: "tools/launch-index-schema.json", allow: [] },
  { f: "tests/launch_test.js", allow: ["alias", "madeup"] },
  { f: "tests/launch_index_test.mjs", allow: ["madeup"] },
  { f: "tests/launch_abi_test.mjs", allow: ["madeup", "constants"] },
  { f: "tests/launch_gate_test.mjs", allow: ["constants", "madeup"] },
  { f: "tests/launch_browser.mjs", allow: ["madeup"] },
  { f: "tests/launch_acceptance.sh", allow: ["constants", "site"] }
];

function allowed(hit, allow) {
  if (allow.includes("constants") && CONSTANTS.some(c => c.toLowerCase() === hit.toLowerCase())) return "constant";
  if (allow.includes("alias") && (ALIAS_HOSTS.test(hit) || /^@bob$/i.test(hit))) return "alias table host or its example handle";
  if (allow.includes("site") && SITE.test(hit)) return "the site's own link";
  if (allow.includes("madeup") && MADE_UP.test(hit)) return "made up for a test";
  if (/^@(?:media|font-face|import|keyframes|supports)$/.test(hit)) return "css at-rule";
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost)/.test(hit)) return "local server";
  if (/^https?:\/\/json-schema\.org\//.test(hit)) return "schema identifier";
  if (/^https?:\/\/lintcha\.com/.test(hit)) return "the site's own name";
  return null;
}

let failures = 0, scanned = 0;
for (const { f, allow, optional } of FILES) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { if (optional) { console.log(`  ${f}: absent, skipped`); continue; } console.log(`  ${f}: MISSING`); failures++; continue; }
  scanned++;
  const text = fs.readFileSync(p, "utf8");
  const hits = new Map();
  for (const [kind, re] of [["address", ADDRESS], ["url", URL_], ["host/path", HOSTPATH], ["handle", HANDLE]]) {
    for (const m of text.matchAll(re)) { const v = m[0].trim().replace(/^[\s"(]+/, ""); if (kind === "host/path" && /^https?:/.test(text.slice(Math.max(0, m.index - 8), m.index + 2))) continue; const k = kind + " " + v; if (!hits.has(k)) hits.set(k, { kind, v, n: 0 }); hits.get(k).n++; }
  }
  const bad = [], fine = [];
  for (const h of hits.values()) { const why = allowed(h.v, allow); (why ? fine : bad).push(`${h.kind} ${h.v} x${h.n}${why ? " (" + why + ")" : ""}`); }
  const size = Buffer.byteLength(text);
  if (bad.length) { failures++; console.log(`  ${f} (${size} bytes): FAIL, not allowed: ${bad.join("; ")}`); }
  else console.log(`  ${f} (${size} bytes): nothing extracted${fine.length ? "; allowed: " + fine.join("; ") : ""}`);
}
console.log(`extraction check: ${scanned} files scanned, ${failures} with something extracted`);
process.exit(failures ? 1 : 0);
