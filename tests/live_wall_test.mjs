// The static contract of /live/: one same-origin, hash-verified response rendered as two inert text fields,
// with explicit coverage, pause/resume and retry controls, and no browser persistence.
//   node tests/live_wall_test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "site", "live", "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "site", "live", "live.js"), "utf8");
let checks = 0, failures = 0;
const ok = (condition, what) => {
  checks++;
  if (!condition) { failures++; console.error("  FAIL " + what); }
};
const count = (text, pattern) => (text.match(pattern) || []).length;

// The page is a static, semantic two-column wall. Nothing executable is inline.
ok(/<main\b[^>]*data-wall\b[^>]*aria-busy="true"/.test(html), "the wall is the page main and begins busy");
ok(/<table\b[\s\S]*?<caption\b[\s\S]*?<thead><tr><th scope="col">Self-declared name<\/th><th scope="col">Self-declared ticker<\/th><\/tr><\/thead>[\s\S]*?<tbody data-wall-rows>/.test(html), "the declarations are a captioned two-column table");
ok(count(html, /<th scope="col">/g) === 2, "there are exactly two public row fields");
ok(/data-wall-status[^>]*>/.test(html) && /role="status"/.test(html) && /aria-live="polite"/.test(html) && /aria-atomic="true"/.test(html), "state changes have one polite atomic announcement");
ok(/data-wall-pause/.test(html) && /aria-pressed="false"/.test(html) && /data-wall-retry/.test(html) && /data-wall-older/.test(html), "pause/resume, retry and earlier-page actions are native button controls");
ok(/type="search"[^>]*data-wall-search/.test(html) && /data-wall-filter-state/.test(html), "the current verified page has a labelled local filter and its own status");
ok(["data-wall-snapshot", "data-wall-watcher", "data-wall-gap", "data-wall-freshness", "data-wall-hash"].every(marker => html.includes(marker)), "snapshot, watcher, gap, freshness and row hash each have a visible slot");
ok(count(html, /<script\b/g) === 1 && /<script src="\/live\/live\.js"><\/script>/.test(html), "the only script is the page's same-origin external script");
ok(/Factory-log chronology[\s\S]*not a ranking/.test(html), "factory chronology is explicitly not presented as a ranking");
ok(/<meta property="og:url" content="https:\/\/chain\.lintcha\.com\/live\/">/.test(html) && /<meta property="og:image" content="https:\/\/chain\.lintcha\.com\/og\.png">/.test(html) && /<link rel="manifest" href="\/manifest\.webmanifest">/.test(html), "social preview and manifest metadata remain same-origin");
ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "there is no inline script");
ok(!/<(?:iframe|object|embed)\b/i.test(html), "there is no embedded third-party surface");
const resourceUrls = [...html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)="([^"]+)"/gi)].map(match => match[1]);
ok(resourceUrls.length > 0 && resourceUrls.every(url => url.startsWith("/") || url.startsWith("https://chain.lintcha.com/")), "every script, stylesheet, icon, image and canonical resource is same-origin");

// The response shape is exact and data never becomes markup or an attribute.
ok(/SUCCESS_KEYS\s*=\s*\["ok", "snapshot_to_block", "gap_blocks", "watcher_to_block", "read_at", "page_limit", "mode", "older_cursor", "live_cursor", "rows_hash", "view_hash", "rows"\]/.test(js), "the exact bounded page and delta success contract is pinned");
ok(/FAILURE_KEYS\s*=\s*\["ok", "why"\]/.test(js), "the exact two-key failure contract is pinned");
ok(/Object\.keys\(object\)\.length === keys\.length/.test(js) && /keys\.every/.test(js), "extra or missing response keys are rejected");
ok(/exactKeys\(row, \["name", "ticker"\]\)/.test(js), "a public row has exactly name and ticker");
ok(/return "\/api\/wall"/.test(js) && /"\/api\/wall\?" \+ mode \+ "=" \+ encodeURIComponent\(value\)/.test(js) && count(js, /\bfetch\s*\(/g) === 1, "the only fetch is the fixed same-origin wall path with one encoded cursor parameter");
ok(/sha256\(JSON\.stringify\(body\.rows\)\)/.test(js) && /pageHash !== body\.rows_hash/.test(js), "every response page or delta is hashed canonically and a mismatch is refused");
ok(/visibleRows\.concat\(body\.rows\)\.slice\(-body\.page_limit\)/.test(js) && /viewHash !== body\.view_hash/.test(js), "a delta's resulting bounded view hash is checked before the DOM changes");
ok(/name\.textContent = row\.name/.test(js) && /ticker\.textContent = row\.ticker/.test(js), "both declarations enter the DOM through textContent");
ok(/document\.createElement\("bdi"\)/.test(js) && /\.dir = "auto"/.test(js), "untrusted declarations are isolated in bidirectional text elements");
ok(/new URLSearchParams\(\)/.test(js) && /params\.set\("name", row\.name\)/.test(js) && /params\.set\("ticker", row\.ticker\)/.test(js), "row links encode both exact declarations into the existing network-silent Read fragment");
ok(!/\.innerHTML\b|insertAdjacentHTML|outerHTML\s*=|document\.write/.test(js), "no markup-producing DOM sink is used");
ok(!/setAttribute\([^\n]*(?:row\.|body\.)/.test(js), "response strings are never written into attributes");
ok(!/row\.(?:address|price|score|contract|date|block|deployer|transaction|link)\b/.test(js), "rows expose no address, price, score, contract, date, block, deployer, transaction or link");
ok(/value\.length <= MAX_WALL_TEXT/.test(js) && /!\/\\p\{C\}\/u\.test\(value\)/.test(js), "row text is bounded and Unicode control characters are refused");

// Controls stop work rather than merely changing their label, and failures never leave stale rows looking live.
ok(/if \(request\) request\.abort\(\)/.test(js) && /window\.clearTimeout\(timer\)/.test(js), "pause cancels both the in-flight request and the poll timer");
ok(/setPaused\(true\)[\s\S]*?cancel\(\)/.test(js) && /setPaused\(false\);\s*newest\(\)/.test(js), "pause cancels work and resume returns immediately to a bounded newest page");
ok(/retryBtn\.addEventListener\("click", function \(\) \{ setPaused\(false\); newest\(\); \}\)/.test(js), "retry starts a fresh bounded read");
ok(/olderBtn\.addEventListener[\s\S]*?requestPage\("before", olderCursor\)/.test(js) && /pageMode = "history"/.test(js), "loading earlier declarations uses its opaque cursor and switches off live polling");
ok(/function showFailure[\s\S]*?emptyRows\("No rows are shown/.test(js), "a failed or unverifiable response clears the public rows");
ok(/function appendDelta[\s\S]*?rowsOut\.appendChild\(rowNode\(row\)\)/.test(js) && /removeChild\(rowsOut\.querySelector\("\[data-wall-entry\]"\)\)/.test(js), "verified deltas append and trim the bounded table instead of rebuilding the full suffix");
ok(/searchInput\.addEventListener\("input", applyFilter\)/.test(js) && /tr\.hidden = !!query/.test(js), "the page filter only hides loaded rows in place");

// No analytics, beacon or persistence API belongs to this page.
ok(!/localStorage|sessionStorage|indexedDB|\.cookie\b|caches\.|serviceWorker|sendBeacon|\banalytics\b|gtag\s*\(/i.test(js), "the script uses no storage, service worker, analytics or beacon API");
ok(!/<form\b/i.test(html), "the wall submits no form");

console.log(`live wall test: ${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
