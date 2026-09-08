#!/usr/bin/env bash
# Launch identity acceptance (LINTCHA_12, spec section 8, criterion 10 as the owner rewrote it on 2026-09-08). Runs the
# ten criteria in order and prints, per criterion, the command it ran and the result; stops at the first failure and
# says which. Nothing here is reported from reading the code: every line is the output of the command above it.
# Criteria 1, 2 and 8 drive a real browser (tests/launch_browser.mjs, tests/console_check.sh) and say so. After the
# ten: the shipped index, the three pages, the storage keys, the hosts contacted, the three untouched files and the
# extraction constraint file by file (tests/launch_extraction.mjs).
#   bash tests/launch_acceptance.sh [served-dir]      default site/dist
set -u
cd "$(dirname "$0")/.."
DIR="${1:-site/dist}"
mkdir -p build
RPC="https://rpc.mainnet.chain.robinhood.com"
# sha256 of the three files as recorded before the first line of LINTCHA_12 code (step 1, from HEAD cfdfeb35): the
# working copy and the served copy carry CRLF, the commit and the live site carry LF, so both forms are pinned
PIN_RULES_LF=de4a141824e7ee93fdaec84cf9e2b8ac26c713336992b5cfdd7f5cbefe613f08
PIN_RULES_CRLF=b529a9046b1b87b9f1af518441de61be5d6ce15c5e572b93e8ccc85efe5494f2
PIN_NUMBERS_LF=6ea58482235fb43a60e89904474cec7bbf143c913a3eac835a52c5dc54be9571
PIN_NUMBERS_CRLF=6cbaff270e1a6f697939ab6f247d9e0447bbfc61adc3010275bef592912ab59e
PIN_LIBRARY=ed4c68f1fb3618f4e2eda22508239ad319df8e735112e3fd17523fc33f4312d3

passed=0
run() {   # run N "title" "command"
  local n="$1" title="$2" cmd="$3" out rc
  echo "criterion $n: $title"
  echo "  command: $cmd"
  out=$(bash -o pipefail -c "$cmd" 2>&1); rc=$?
  echo "$out" | sed 's/^/    /'
  if [ $rc -eq 0 ]; then echo "  result: pass"; passed=$((passed+1)); else echo "  result: FAIL (exit $rc)"; echo "stopped at criterion $n; $passed of ten passed before it"; exit 1; fi
  echo
}

run 1 "zero network requests to any host but the page's own origin on /launch/, /es/launch/, /pt/launch/, the page fully used; the index comes once from the same origin on the first check and never at load (browser driven: headless Chrome over the DevTools protocol)" \
  "node tests/launch_browser.mjs $DIR --out build/launch-browser.json"

run 2 "exactly two storage keys after a full run on each of the three pages (read back from the browser run above: localStorage, sessionStorage, cookies, databases, caches, service workers)" \
  "node -e '
const r = JSON.parse(require(\"fs\").readFileSync(\"build/launch-browser.json\", \"utf8\")); let bad = 0;
for (const p of r.pages) { const s = p.storage; const ok = JSON.stringify(s.local) === JSON.stringify([\"lintcha:lang\", \"lintcha:theme\"]) && !s.session.length && !s.cookie && !s.databases.length && !s.caches.length && !s.service_workers; if (!ok) bad++;
  console.log(p.page + \": at load \" + JSON.stringify(JSON.parse(p.storage_at_load).local) + \", after the full run localStorage \" + JSON.stringify(s.local) + \", sessionStorage \" + JSON.stringify(s.session) + \", cookie \" + JSON.stringify(s.cookie) + \", databases \" + JSON.stringify(s.databases) + \", caches \" + JSON.stringify(s.caches) + \", service workers \" + s.service_workers + (ok ? \"\" : \"  <- not exactly the two keys\")); }
process.exit(bad ? 1 : 0);'"

run 3 "launch-index.json holds nothing but the hash, the counts n and d, the date first and, on the two skeleton namespaces, v (the owner's additions); checked by the schema on the served file, then every distinct field name in the file listed" \
  "node -e '
import(\"./tools/launch/schema.mjs\").then(({ validate }) => {
  const fs = require(\"fs\"); const schema = JSON.parse(fs.readFileSync(\"tools/launch-index-schema.json\", \"utf8\")); const index = JSON.parse(fs.readFileSync(\"$DIR/launch-index.json\", \"utf8\"));
  const problems = validate(schema, index); console.log(\"schema: \" + (problems.length ? problems.length + \" problem(s): \" + problems.slice(0, 5).join(\"; \") : \"no problem\"));
  const ns = Object.keys(index), fields = {}, keys = { hex16: 0, other: 0 }; let entries = 0;
  for (const n of ns) for (const [k, v] of Object.entries(index[n])) { entries++; (/^[0-9a-f]{16}$/.test(k) ? keys.hex16++ : keys.other++); for (const f of Object.keys(v)) { fields[n + \".\" + f] = (fields[n + \".\" + f] || 0) + 1; if (typeof v[f] === \"object\") fields[\"NESTED \" + n + \".\" + f] = 1; } }
  console.log(\"namespaces: \" + ns.join(\" \")); console.log(\"entry keys: \" + keys.hex16 + \" of sixteen hex chars, \" + keys.other + \" other\"); console.log(\"fields per namespace: \" + JSON.stringify(fields));
  const names = new Set(Object.keys(fields).map(k => k.split(\".\").pop())); console.log(\"distinct field names in the file: \" + [...names].sort().join(\" \"));
  const allowed = [\"n\", \"d\", \"first\", \"v\"]; const extra = [...names].filter(x => !allowed.includes(x)); const vWrong = Object.keys(fields).filter(k => k.endsWith(\".v\") && !/_skeleton\\.v$/.test(k));
  process.exit(problems.length || keys.other || extra.length || vWrong.length || Object.keys(fields).some(k => k.startsWith(\"NESTED\")) ? 1 : 0); });'"

run 4 "the skeleton table lives in one file under fifty lines and every row is covered by a pair that folds and a pair that must not (pairs generated from the table itself, one folding and one non-folding pair per row, run through the engine)" \
  "printf 'lines: '; grep -c '' site/launch-skeleton.js; printf 'files defining the table: '; grep -l 'var CHARS' site/*.js | tr '\\n' ' '; echo; node -e '
const L = require(\"./site/launch.js\"), S = require(\"./site/launch-skeleton.js\"); const sk = L.normalize.skeleton; let rows = 0, pairs = 0, bad = 0;
const must = (a, b, same, row) => { pairs++; const r = sk(a) === sk(b); if (r !== same) { bad++; console.log(\"FAIL row \" + row + \": \" + JSON.stringify(a) + \" / \" + JSON.stringify(b) + (same ? \" must fold\" : \" must not fold\")); } };
for (const [k, t] of Object.entries(S.CHARS)) { rows++; must(\"x\" + k + \"x\", \"x\" + t + \"x\", true, \"CHARS \" + JSON.stringify(k)); must(\"x\" + k + \"x\", \"x\" + (t === \"q\" ? \"j\" : \"q\") + \"x\", false, \"CHARS \" + JSON.stringify(k)); }
for (const [a, b] of S.PAIRS) { rows++; must(\"x\" + a + \"x\", \"x\" + b + \"x\", true, \"PAIRS \" + a); must(\"x\" + a + \"x\", \"x\" + b + b + \"x\", false, \"PAIRS \" + a); }
const marks = [\"\\u0301\", \"\\u0327\", \"\\u036f\", \"\\u200b\", \"\\u200c\", \"\\u200d\", \"\\u2060\", \"\\ufeff\", \"\\u00ad\"];
for (const m of marks) { rows++; must(\"bo\" + m + \"b\", \"bob\", true, \"MARKS U+\" + m.charCodeAt(0).toString(16)); must(\"bo\" + m + \"b\", \"boq\", false, \"MARKS U+\" + m.charCodeAt(0).toString(16)); }
console.log(\"rows: \" + Object.keys(S.CHARS).length + \" CHARS, \" + S.PAIRS.length + \" PAIRS, \" + marks.length + \" MARKS samples; pairs run: \" + pairs + \" (\" + pairs / 2 + \" that fold, \" + pairs / 2 + \" that must not); failures: \" + bad);
const lines = require(\"fs\").readFileSync(\"site/launch-skeleton.js\", \"utf8\").split(/\\r?\\n/).filter(l => l.length).length; if (lines >= 50) { console.log(\"FAIL \" + lines + \" lines\"); bad++; }
process.exit(bad ? 1 : 0);'"

run 5 "two strings identical after normalization report shared, never lookalike (a fixture index built from the two strings' own digests, then check() on each)" \
  "node -e '
const L = require(\"./site/launch.js\"); const n = L.normalize;
(async () => { let bad = 0;
  const cases = [[\"ticker\", \"\$bob \", \"BOB\"], [\"name\", \"Bob\\u2019s  Coin\", \"bobs coin\"]];
  for (const [field, a, b] of cases) {
    const na = n[field](a), nb = n[field](b); const h = await L.digest(na), hs = await L.digest(n.skeleton(na));
    const index = {}; for (const ns of L.NAMESPACES) index[ns] = {}; index[field][h] = { n: 2, d: 2, first: \"2026-09-07\" }; index[field + \"_skeleton\"][hs] = { n: 2, d: 2, first: \"2026-09-07\", v: 1 };
    for (const s of [a, b]) { const out = await L.check({ [field]: s, links: {} }, index); const exact = field === \"ticker\" ? out.N1 : out.N2; const look = out.N3[field];
      const ok = na === nb && exact.state === \"shared\" && look.state === \"unique\"; if (!ok) bad++;
      console.log(field + \" \" + JSON.stringify(s) + \" -> normalized \" + JSON.stringify(n[field](s)) + \", exact \" + exact.state + \" (n \" + exact.n + \", d \" + exact.d + \"), lookalike row: \" + (look.state === \"lookalike\" ? \"shown\" : \"not shown\") + (ok ? \"\" : \"  <- wrong\")); } }
  const a = \"B0B\", b = \"BOB\"; const index = {}; for (const ns of L.NAMESPACES) index[ns] = {}; index.ticker_skeleton[await L.digest(n.skeleton(n.ticker(a)))] = { n: 2, d: 2, first: \"2026-09-07\", v: 2 };
  const out = await L.check({ ticker: a, links: {} }, index); const ok = out.N1.state === \"unique\" && out.N3.ticker.state === \"lookalike\" && out.N3.ticker.v === 2; if (!ok) bad++;
  console.log(\"contrast: \" + JSON.stringify(a) + \" against a group spelt two ways -> exact \" + out.N1.state + \", lookalike \" + out.N3.ticker.state + \" (v \" + out.N3.ticker.v + \")\" + (ok ? \"\" : \"  <- wrong\"));
  process.exit(bad ? 1 : 0); })();'"

run 6 "a description under twelve words reports too short to compare (eleven words against the served index, then twelve)" \
  "node -e '
const L = require(\"./site/launch.js\"); const index = JSON.parse(require(\"fs\").readFileSync(\"$DIR/launch-index.json\", \"utf8\"));
(async () => { let bad = 0;
  const w = \"one two three four five six seven eight nine ten eleven twelve thirteen\".split(\" \");
  for (const k of [11, 12]) { const d = w.slice(0, k).join(\" \"); const out = await L.check({ description: d, links: {} }, index); const want = k < L.MIN_WORDS ? \"too short to compare\" : \"compared\"; const got = out.I4.state === \"too short to compare\" ? out.I4.state : \"compared\"; if (got !== want) bad++;
    console.log(k + \" words (floor \" + L.MIN_WORDS + \"): I4 state \" + JSON.stringify(out.I4.state) + (got === want ? \"\" : \"  <- wrong\")); }
  const e = await L.check({ description: \"\", links: {} }, index); console.log(\"empty: I4 state \" + JSON.stringify(e.I4.state)); if (e.I4.state !== \"empty\") bad++;
  process.exit(bad ? 1 : 0); })();'"

run 7 "i18n coverage green in en, es and pt" \
  "cd site && node tools/i18n_check.js"

run 8 "console clean at load on every built page (browser driven: tests/console_check.sh opens every built page in headless Chrome)" \
  "bash tests/console_check.sh $DIR"

run 9 "rules.js, numbers.json, library-numbers.json byte-identical to HEAD: the working copy and the served copy against the sha256 pinned at step 1, and against the live site (HEAD as deployed), LF-normalized where the commit is LF" \
  "bad=0
lf() { tr -d '\\r' < \"\$1\" | sha256sum | cut -c1-64; }; raw() { sha256sum \"\$1\" | cut -c1-64; }
live() { curl -sS -m 20 -A 'lintcha-acceptance/0.1' \"https://lintcha.com/\$1\" | sha256sum | cut -c1-64; }
for f in rules.js numbers.json; do
  case \$f in rules.js) plf=$PIN_RULES_LF; pcrlf=$PIN_RULES_CRLF;; numbers.json) plf=$PIN_NUMBERS_LF; pcrlf=$PIN_NUMBERS_CRLF;; esac
  l=\$(live \$f); echo \"\$f: working copy raw \$(raw site/\$f | cut -c1-16) (pinned \${pcrlf:0:16}), lf \$(lf site/\$f | cut -c1-16) (pinned \${plf:0:16}); served copy raw \$(raw $DIR/\$f | cut -c1-16), lf \$(lf $DIR/\$f | cut -c1-16); live \${l:0:16}\"
  [ \"\$(raw site/\$f)\" = \"\$pcrlf\" ] && [ \"\$(lf site/\$f)\" = \"\$plf\" ] && [ \"\$(lf $DIR/\$f)\" = \"\$plf\" ] || { echo \"  \$f differs from the pinned sha\"; bad=1; }
  [ \"\$l\" = \"\$plf\" ] && echo \"  live copy equals the pinned lf sha\" || echo \"  live copy does not equal the pinned lf sha (unreachable or changed on the site)\"
done
f=library-numbers.json; l=\$(live \$f); echo \"\$f: served copy \$(raw $DIR/\$f | cut -c1-16) (pinned ${PIN_LIBRARY:0:16}); live \${l:0:16}\"
[ \"\$(raw $DIR/\$f)\" = \"$PIN_LIBRARY\" ] || { echo \"  \$f differs from the pinned sha\"; bad=1; }
[ \"\$l\" = \"$PIN_LIBRARY\" ] && echo \"  live copy equals the pinned sha\" || echo \"  live copy does not equal the pinned sha (unreachable or changed on the site)\"
exit \$bad"

run 10 "the collector runs against a public endpoint without a key; every launch in the log was read and none was lost; every retry is counted; the 429 count and the retry count are stated in launch-numbers.json and here. The number is reported, never gated. (a live smoke run now, then the shipped run and every run of the shipped window)" \
  "node tools/launch-collect.mjs --smoke --rpc $RPC --out build/launch-acceptance-smoke.json 2>&1 | grep -E '^(window|limiter|verified|six)' ; node -e '
const fs = require(\"fs\"); const read = f => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, \"utf8\")) : null; let bad = 0;
const line = (label, j) => { const l = j.limiter, v = j.verified; const lost = v.launches_in_log - v.tokens_readable; const counted = l.retries >= l.http429 + l.rpc429; if (lost || !counted) bad++;
  console.log(label + \": calls \" + l.calls + \", http 429 \" + l.http429 + \", rpc 429 \" + l.rpc429 + \", retries \" + l.retries + \", other errors \" + l.otherErrors + \", \" + l.seconds + \" s at \" + l.spacing_ms + \" ms with \" + l.in_flight + \" in flight; launches in the log \" + v.launches_in_log + \", read \" + v.tokens_readable + \", lost \" + lost + (counted ? \", every 429 retried\" : \"  <- a 429 was not retried\")); };
const smoke = read(\"build/launch-acceptance-smoke.json\"); if (!smoke) { console.log(\"FAIL: the smoke run wrote no report\"); process.exit(1); }
line(\"smoke run now (\" + smoke.window.blocks + \" blocks ending at finalised \" + smoke.window.finalized + \")\", smoke);
const ship = read(\"build/launch-day.json\"); line(\"shipped run (window \" + ship.window.from + \"..\" + ship.window.to + \")\", ship);
for (const k of [1, 2, 3, 4]) { const j = read(\"build/launch-day-v\" + k + \".json\"); if (j) line(\"run \" + k + \" of the same window\", j); }
const num = JSON.parse(fs.readFileSync(\"$DIR/launch-numbers.json\", \"utf8\")).collector; const stated = [\"http_429\", \"rpc_429\", \"retries\", \"other_errors\", \"launches_in_log\", \"tokens_readable\"].every(k => Number.isInteger(num[k]));
const agrees = num.http_429 === ship.limiter.http429 && num.rpc_429 === ship.limiter.rpc429 && num.retries === ship.limiter.retries && num.launches_in_log === num.tokens_readable; if (!stated || !agrees) bad++;
console.log(\"launch-numbers.json states: \" + JSON.stringify(num) + (stated && agrees ? \" (equal to the shipped run)\" : \"  <- not stated or not the shipped run\"));
console.log(\"endpoint: \" + \"$RPC\" + \" (no key, no query string, no header beyond a named user agent)\");
process.exit(bad ? 1 : 0);'"

echo "ten of ten criteria passed"
echo
echo "the shipped index ($DIR/launch-index.json)"
node -e '
const fs = require("fs"), z = require("zlib"), c = require("crypto"); const b = fs.readFileSync(process.argv[1]); const j = JSON.parse(b);
const br = q => z.brotliCompressSync(b, { params: { [z.constants.BROTLI_PARAM_MODE]: z.constants.BROTLI_MODE_TEXT, [z.constants.BROTLI_PARAM_QUALITY]: q } }).length;
console.log("  sha256 " + c.createHash("sha256").update(b).digest("hex")); console.log("  raw bytes " + b.length + "; gzip -9 " + z.gzipSync(b, { level: 9 }).length + ", gzip -6 " + z.gzipSync(b, { level: 6 }).length + "; brotli q11 " + br(11) + ", brotli q4 " + br(4));
const per = Object.fromEntries(Object.keys(j).map(k => [k, Object.keys(j[k]).length])); console.log("  entries " + Object.values(per).reduce((a, x) => a + x, 0) + " " + JSON.stringify(per));
const n = fs.readFileSync(process.argv[2]); console.log("  launch-numbers.json sha256 " + c.createHash("sha256").update(n).digest("hex") + ", " + n.length + " bytes");' "$DIR/launch-index.json" "$DIR/launch-numbers.json"
echo
echo "the three pages"
node -e '
const fs = require("fs"); const r = JSON.parse(fs.readFileSync("build/launch-browser.json", "utf8")); const dir = process.argv[1];
for (const p of r.pages) { const f = dir + p.page + "index.html"; console.log("  " + p.page + ": " + fs.statSync(f).size + " bytes; at load " + p.load.requests + " requests, launch-index.json fetched at load: " + (p.load.index_fetched ? "YES" : "no") + "; first check fetched it " + p.first_check.index_fetched + " time(s), second check " + p.second_check.index_fetched); }
console.log("storage keys after a full run on each page");
for (const p of r.pages) console.log("  " + p.page + ": localStorage " + JSON.stringify(p.storage.local) + ", sessionStorage " + JSON.stringify(p.storage.session) + ", cookie " + JSON.stringify(p.storage.cookie) + ", databases " + JSON.stringify(p.storage.databases) + ", caches " + JSON.stringify(p.storage.caches) + ", service workers " + p.storage.service_workers);
console.log("hosts contacted (served origin " + r.origin + ")");
for (const p of r.pages) console.log("  " + p.page + ": on load " + JSON.stringify(p.load.hosts) + ", first check " + JSON.stringify(p.first_check.hosts) + ", second check " + JSON.stringify(p.second_check.hosts) + ", controls " + JSON.stringify(p.controls.hosts));' "$DIR"
echo
echo "the extraction constraint, file by file (node tests/launch_extraction.mjs)"
node tests/launch_extraction.mjs || { echo "extraction check FAILED"; exit 1; }
echo
echo "own code only: every import or require in the launch files (node built-ins and this project's own files)"
grep -n -o -E "(import [^;]+ from |require\()\"[^\"]+\"" site/launch.js site/launch-page.js site/launch-skeleton.js site/launch-links.js tools/launch-collect.mjs tools/launch-index.mjs tools/launch/rpc.mjs tools/launch/abi.mjs tools/launch/keccak.mjs tools/launch/schema.mjs | sed 's/^/  /'
echo "launch acceptance: ten criteria passed"
