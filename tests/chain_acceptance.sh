#!/usr/bin/env bash
# lintcha-chain acceptance: the fourteen criteria of the spec (LINTCHA_CHAIN_03, section 9), each with the command that
# ran it, in order, stopping at the first failure. Owned here; the vendored tests/launch_acceptance.sh is bound to
# lintcha's layout and stays as it is. Every line under a criterion is the output of the command above it; nothing is
# reported from reading the code. Criteria 5 to 8 drive a real browser (tests/console_check.sh, tests/chain_browser.mjs)
# and say so. Criterion 14 runs the collector over the recorded window against the public RPC and takes as long as the
# collector takes (about twenty minutes on the published day); it is the only criterion that touches the network.
#   bash tests/chain_acceptance.sh [served-dir] [upto] [from]      default site, all fourteen; "upto N" stops after N, "from N" starts at N
# Criterion 11 as the owner rewrote it in the spec on 2026-09-09 (logged there under "Criteria changed by the owner"):
# "the status strip" in place of "the mode line", which the design superseded; "reads strings" is read in the strip,
# the definitions block, the limits section, the reproduce block and the independence line where the approved page
# puts them (sections 05, 06, 08 and the footer since the chain block joined the order in round C).
set -u
cd "$(dirname "$0")/.."
DIR="${1:-site}"
UPTO="${2:-14}"
FROM="${3:-1}"      # "from N" starts at criterion N: for a rerun after a stop, never for a report of the whole
mkdir -p build
passed=0
run() {   # run N "title" "command"
  local n="$1" title="$2" cmd="$3" out rc first
  first="${n%% *}"
  if [ "$first" -gt "$UPTO" ] || [ "$first" -lt "$FROM" ]; then return 0; fi
  echo "criterion $n: $title"
  echo "  command: $cmd"
  out=$(bash -o pipefail -c "$cmd" 2>&1); rc=$?
  echo "$out" | sed 's/^/    /'
  if [ $rc -eq 0 ]; then echo "  result: pass"; passed=$((passed+1)); else echo "  result: FAIL (exit $rc)"; echo "stopped at criterion $n; $passed passed before it"; exit 1; fi
  echo
}

run 1 "git remote and wrangler name both say lintcha-chain (read-only identity checks)" \
  "git remote -v | head -1; grep -E '^name' wrangler.toml; git remote -v | head -1 | grep -q 'Mnilax/lintcha-chain' && grep -qE '^name = \"lintcha-chain\"' wrangler.toml"

run 2 "verify-vendor passes on the tree, and fails on a deliberately altered vendored file, naming it (the alteration is made in a temporary copy of the tree; the tree itself is not touched)"   "node tools/verify-vendor.mjs | tail -1; T=\$(mktemp -d); for d in site src tests tools; do cp -r \$d \$T/; done; cp VENDOR.md .gitignore \$T/; printf '\n' >> \$T/site/launch.js; echo '--- a copy with one byte appended to site/launch.js:'; node tools/verify-vendor.mjs \$T/VENDOR.md > \$T/out.txt; rc=\$?; grep -E 'MISMATCH|^verify-vendor:' \$T/out.txt; named=\$(grep -c 'MISMATCH site/launch.js' \$T/out.txt); rm -rf \$T; node tools/verify-vendor.mjs > /dev/null && [ \$rc -ne 0 ] && [ \$named -eq 1 ]"

run 3 "the CI workflow (.github/workflows/vendor.yml) runs verify-vendor and nothing else, actions pinned by SHA (the refresh workflow, approved separately, is listed with its pins too)" \
  "node -e '
const fs = require(\"fs\"); let bad = 0;
for (const f of [\"vendor.yml\", \"launch-refresh.yml\"]) { const y = fs.readFileSync(\".github/workflows/\" + f, \"utf8\");
  const uses = [...y.matchAll(/uses:\\s*(\\S+)/g)].map(m => m[1]); const runs = [...y.matchAll(/^\\s*(?:- )?run:\\s*(.+)$/gm)].map(m => m[1].trim()).concat([...y.matchAll(/run: \\|\\n((?:\\s{10,}.*\\n)+)/g)].flatMap(m => m[1].trim().split(/\\n/).map(s => s.trim())));
  const pinned = uses.every(u => /@[0-9a-f]{40}$/.test(u)); console.log(f + \": uses \" + uses.join(\", \") + \" | pinned by SHA: \" + pinned); if (!pinned) bad++;
  if (f === \"vendor.yml\") { console.log(\"  run steps: \" + JSON.stringify(runs)); if (runs.length !== 1 || runs[0] !== \"node tools/verify-vendor.mjs\") bad++; } }
process.exit(bad ? 1 : 0);'"

run 4 "the served tree contains no rules.js, verdict.js, job.js, library.js, numbers.json, library-numbers.json or roles" \
  "found=\$(find $DIR \\( -name rules.js -o -name verdict.js -o -name job.js -o -name library.js -o -name numbers.json -o -name library-numbers.json -o -name roles \\) -print); echo \"found: \${found:-none}\"; [ -z \"\$found\" ]"

run 5 "console clean at load on every built page (browser driven: tests/console_check.sh opens every page under $DIR in headless Chrome)" \
  "bash tests/console_check.sh $DIR"

run "6 7 8" "no more than the two storage keys, nothing outside lintcha:theme and lintcha:lang, after a full run (paste, read, read again, clear, toggle theme); hosts contacted: own origin only; the index not fetched at load, once on the first read, not on the second (browser driven: tests/chain_browser.mjs over /)" \
  "node tests/chain_browser.mjs $DIR --out build/chain-browser.json"

run 9 "every figure traces to launch-numbers.json or launch-index.json: the templates and the i18n sources grepped for digits, raw counts first, then the gate's reading (text nodes of the templates, values of every string, attributes out of scope)" \
  "echo 'raw: lines with a digit, attributes included:'; for f in src/templates/shell.html src/templates/launch.html src/i18n-src/*.json; do printf '  %s: %s\\n' \$f \$(grep -c '[0-9]' \$f); done; node -e '
const fs = require(\"fs\"); let bad = 0;
for (const f of [\"src/templates/shell.html\", \"src/templates/launch.html\"]) { const html = fs.readFileSync(f, \"utf8\"); const text = html.replace(/<script[\\s\\S]*?<\\/script>/g, \" \").replace(/<[^>]*>/g, \" \").replace(/\\{\\{[^}]*\\}\\}/g, \" \"); const hits = text.match(/\\S*\\d\\S*/g) || []; console.log(f + \": digits in text nodes: \" + (hits.length ? hits.join(\" \") : \"none\")); if (hits.length) bad++; }
for (const f of fs.readdirSync(\"src/i18n-src\").filter(x => x.endsWith(\".json\"))) { const j = JSON.parse(fs.readFileSync(\"src/i18n-src/\" + f, \"utf8\")); const hits = Object.entries(j).filter(([k, v]) => /\\d/.test(v)).map(([k]) => k); console.log(\"src/i18n-src/\" + f + \": \" + Object.keys(j).length + \" values, digits in \" + (hits.length ? hits.join(\" \") : \"none\")); if (hits.length) bad++; }
const page = fs.readFileSync(\"$DIR/index.html\", \"utf8\"); const slots = [...fs.readFileSync(\"src/templates/shell.html\", \"utf8\").matchAll(/data-i18n-vars=\"([^\"]+)\"/g)].flatMap(m => m[1].split(\",\")); console.log(\"figures on the page arrive through \" + new Set(slots).size + \" named slots: \" + [...new Set(slots)].sort().join(\" \"));
process.exit(bad ? 1 : 0);'"

run 10 "the schema test passes on the shipped index and every negative case fails (tests/launch_index_test.mjs, then the shipped file validated directly)" \
  "node tests/launch_index_test.mjs | tail -1; node -e '
import(\"./tools/launch/schema.mjs\").then(({ validate }) => { const fs = require(\"fs\"); const schema = JSON.parse(fs.readFileSync(\"tools/launch-index-schema.json\", \"utf8\")); const index = JSON.parse(fs.readFileSync(\"$DIR/launch-index.json\", \"utf8\")); const p = validate(schema, index); console.log(\"shipped index against the schema: \" + (p.length ? p.length + \" problem(s)\" : \"no problem\") + \", \" + Object.keys(index).length + \" namespaces, \" + Object.values(index).reduce((a, t) => a + Object.keys(t).length, 0) + \" entries\"); process.exit(p.length ? 1 : 0); });'"

run 11 "the status strip, the definitions block, the limits section, the reproduce block and the independence line are all present on the front page" \
  "node -e '
const html = require(\"fs\").readFileSync(\"$DIR/index.html\", \"utf8\"); let bad = 0;
const show = (label, re) => { const m = re.exec(html); console.log(label + \": \" + (m ? \"present, \\\"\" + m[1].replace(/\\s+/g, \" \").slice(0, 90) + \"\\\"\" : \"MISSING\")); if (!m) bad++; };
show(\"status strip\", /data-i18n=\"strip.reads\"[^>]*>([^<]+)</);
show(\"definitions block (section 05)\", /id=\"s05\"[\\s\\S]*?data-i18n=\"definitions.close\"[^>]*>([^<]+)</);
show(\"limits section (section 06, the vendored paragraphs)\", /id=\"s06\"[\\s\\S]*?data-i18n=\"launch.fixed.p1\"[^>]*>([^<]+)</);
show(\"reproduce block (section 08)\", /id=\"s08\"[\\s\\S]*?data-i18n=\"reproduce.cmd\"[^>]*>([^<]+)</);
show(\"independence line (footer)\", /data-i18n=\"footer.independence\"[^>]*>([^<]+)</);
process.exit(bad ? 1 : 0);'"

run 12 "the dormant or active token document agrees exactly with every served page, and every forty-hex address has a source-scoped allowance" \
  "node --input-type=module -e '
import fs from \"node:fs\"; import path from \"node:path\"; import { execFileSync } from \"node:child_process\"; import { tokenConfigOf } from \"./lib/config-contract.mjs\"; let bad = 0;
const rawToken = JSON.parse(fs.readFileSync(\"site/token.json\", \"utf8\")); const t = tokenConfigOf(rawToken); console.log(\"site/token.json: \" + JSON.stringify(rawToken)); if (!t) bad++;
const active = !!(t && t.address); const exactHits = (text, value) => value ? text.split(value).length - 1 : 0; const htmlUrl = value => String(value).replace(/&/g, \"&amp;\").replace(/</g, \"&lt;\").replace(/>/g, \"&gt;\").replace(/\"/g, \"&quot;\");
const htmlFiles = []; (function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (/\\.html$/i.test(entry.name)) htmlFiles.push(file); } })(\"$DIR\");
for (const file of htmlFiles.sort()) { const rel = path.relative(\"$DIR\", file).replace(/\\\\/g, \"/\"), page = fs.readFileSync(file, \"utf8\"); const blocks = (page.match(/class\\s*=\\s*(?:\"[^\"]*\\b(?:contract|buy|token-sec|token-btn)\\b[^\"]*\"|\\x27[^\\x27]*\\b(?:contract|buy|token-sec|token-btn)\\b[^\\x27]*\\x27)/gi) || []).length; const addressHits = active ? exactHits(page, \"data-token-address>\" + t.address + \"<\") : 0, ponsHits = active ? exactHits(page, htmlUrl(t.pons)) : 0, uniswapHits = active && t.uniswap ? exactHits(page, htmlUrl(t.uniswap)) : 0; let agrees;
  if (!active) agrees = blocks === 0;
  else if ([\"index.html\", \"es/index.html\", \"pt/index.html\"].includes(rel)) agrees = addressHits === 3 && ponsHits === 2 && uniswapHits === (t.uniswap ? 1 : 0) && blocks >= 4;
  else if (rel === \"404.html\") agrees = addressHits === 1 && ponsHits === 1 && uniswapHits === 0 && blocks >= 2;
  else agrees = addressHits === 0 && ponsHits === 0 && uniswapHits === 0 && blocks === 0;
  console.log(rel + \": token state \" + (active ? \"active\" : \"dormant\") + \", address slots \" + addressHits + \", primary link \" + ponsHits + \", markup \" + blocks + (agrees ? \"\" : \" <- MISMATCH\")); if (!agrees) bad++; }
const files = execFileSync(\"git\", [\"ls-files\", \"--cached\", \"--others\", \"--exclude-standard\", \"-z\"], { encoding: \"utf8\" }).split(\"\\0\").filter(Boolean);
const syntheticAddress = /^(?:0x([0-9a-f])\\1{39}|0x1[0]{38}[1-4]|0x(?:(?:10){20}|(?:20){20})|0x0{39}1)$/i;
const ALLOW = [
  [/^tools[\\/\\\\]launch-collect\\.mjs$/, /0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e|0xca11bde05977b3631167028862be2a173976ca11/i, \"the collector constants: the factory and Multicall3\"],
  [/^bot[\\/\\\\]src[\\/\\\\]chain\\.js$/, /0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e/i, \"the watcher copy of the verified factory constant\"],
  [/^tools[\\/\\\\]collection-guard\\.mjs$/, /0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e|0xe33e9e479df8802cb0866d5d05258bec4cf62948/i, \"the guard constants: the factory and wrapped native token\"],
  [/^(?:tests|bot[\\/\\\\]test)[\\/\\\\]/, syntheticAddress, \"an unmistakably synthetic test address\"],
  [/^(?:fixtures[\\/\\\\]identity-conformance\\.json|tests[\\/\\\\]launch_test\\.js)$/, /0xabcdef0123456789abcdef0123456789abcdef01/i, \"the explicit public conformance fixture\"],
  [/^bot[\\/\\\\]test[\\/\\\\]fakes\\.mjs$/, /0x44ddefb6d59de6523cd7ff06821d48847e95c176/i, \"the shared bot test fixture\"],
  [/^bot[\\/\\\\]test[\\/\\\\](?:rules_router|texts|watch)_test\\.mjs$/, /0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f/i, \"the exact command-copy fixture\"],
  [/^tests[\\/\\\\]chain_acceptance\\.sh$/, /0xabcdef0123456789abcdef0123456789abcdef01|0x44ddefb6d59de6523cd7ff06821d48847e95c176|0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f/i, \"an exact fixture named by this allowlist\"],
  [/^(?:bot[\\/\\\\]test[\\/\\\\]chain_test\\.mjs|tests[\\/\\\\](?:chain_acceptance\\.sh|launch_extraction\\.mjs))$/, /0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e/i, \"the factory constant under test\"],
  [/^tests[\\/\\\\](?:chain_acceptance\\.sh|launch_abi_test\\.mjs|launch_extraction\\.mjs)$/, /0xca11bde05977b3631167028862be2a173976ca11/i, \"the Multicall3 constant under test\"],
  [/^tests[\\/\\\\]chain_acceptance\\.sh$/, /0xe33e9e479df8802cb0866d5d05258bec4cf62948/i, \"the wrapped native constant in the guard allowance\"]
];
const activeAddressFiles = new Set([\"site/token.json\", \"site/index.html\", \"site/es/index.html\", \"site/pt/index.html\", \"site/404.html\", \"README.md\"]);
let hits = 0; for (const f of files) { if (/\\.(png|woff2|jpg|log)$/i.test(f)) continue;   /* *.log is gitignored: a run record, not the tree */ const s = fs.readFileSync(f, \"utf8\"); for (const m of s.matchAll(/(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/gi)) { hits++; const rel = f.replace(/^\\.[\\/\\\\]/, \"\"); const projectToken = active && activeAddressFiles.has(rel) && m[0].toLowerCase() === t.address; const a = projectToken ? [null, null, \"the exact active address from site/token.json\"] : ALLOW.find(([fr, ar]) => fr.test(rel) && ar.test(m[0])); console.log(\"  \" + rel + \": \" + m[0].slice(0, 10) + \"… \" + (a ? \"allowed, \" + a[2] : \"NOT ALLOWED\")); if (!a) bad++; } }
console.log(\"forty-hex strings in the tree: \" + hits + \", not allowed: \" + bad); process.exit(bad ? 1 : 0);'"

run 13 "i18n_check passes on all three languages after the merge, and en, es and pt comparison pages are emitted with one root 404" \
  "node tools/i18n-merge.mjs && node src/tools/i18n_check.js | tail -1 && node -e '
const fs = require(\"fs\"), path = require(\"path\"), root = \"$DIR\", pages = [];
(function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (/\\.html$/i.test(entry.name)) pages.push(path.relative(root, file).replace(/\\\\/g, \"/\")); } })(root);
pages.sort(); const expected = [\"404.html\", \"deployer/index.html\", \"es/index.html\", \"hold/index.html\", \"index.html\", \"live/index.html\", \"pt/index.html\"]; const languageDirectories = [\"es\", \"pt\"].filter(lang => fs.existsSync(path.join(root, lang))); console.log(\"pages emitted: \" + pages.join(\" \")); console.log(\"language directories: \" + languageDirectories.join(\" \")); process.exit(JSON.stringify(pages) === JSON.stringify(expected) && JSON.stringify(languageDirectories) === JSON.stringify([\"es\", \"pt\"]) ? 0 : 1);'"

run 14 "npm run verify exists, runs, and prints exactly both hashes plus the match result (the collector over the recorded window against the public RPC; exit 0 match and 1 mismatch are accepted only with that complete evidence; 2 means it could not run)" \
  "node -e 'const p=require(\"./package.json\"); console.log(\"verify script: \" + p.scripts.verify); process.exit(p.scripts.verify === \"node tools/verify-index.mjs\" ? 0 : 1)' || exit \$?; npm run verify --silent > build/verify.log 2>&1; rc=\$?; shipped=\$(grep -Ec '^shipped index hash  [0-9a-f]{64}$' build/verify.log); rebuilt=\$(grep -Ec '^rebuilt index hash  [0-9a-f]{64}$' build/verify.log); yes=\$(grep -Ec '^match: yes( |$)' build/verify.log); no=\$(grep -Ec '^match: no( |$)' build/verify.log); shipped_hash=\$(grep -E '^shipped index hash  [0-9a-f]{64}$' build/verify.log | awk '{print \$4}'); rebuilt_hash=\$(grep -E '^rebuilt index hash  [0-9a-f]{64}$' build/verify.log | awk '{print \$4}'); grep -E '^(shipped index hash|rebuilt index hash|match:)' build/verify.log || true; echo \"exit \$rc, evidence shipped=\$shipped rebuilt=\$rebuilt yes=\$yes no=\$no (full log: build/verify.log)\"; [ \$shipped -eq 1 ] && [ \$rebuilt -eq 1 ] && { { [ \$rc -eq 0 ] && [ \$yes -eq 1 ] && [ \$no -eq 0 ] && [ \"\$shipped_hash\" = \"\$rebuilt_hash\" ]; } || { [ \$rc -eq 1 ] && [ \$yes -eq 0 ] && [ \$no -eq 1 ] && [ \"\$shipped_hash\" != \"\$rebuilt_hash\" ]; }; }"

echo "chain acceptance: $passed criteria passed (through $UPTO of fourteen)"
