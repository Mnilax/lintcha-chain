// Static deployer-history contract: user-triggered same-origin read, strict response, pre-render hash and inert text.
//   node tests/deployer_history_test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "site", "deployer", "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "site", "deployer", "deployer.js"), "utf8");
const sitemap = fs.readFileSync(path.join(root, "site", "sitemap.xml"), "utf8");
let checks = 0, failures = 0;
const ok = (value, label) => { checks++; if (!value) { failures++; console.log("  FAIL " + label); } };

ok(/<link rel="canonical" href="https:\/\/chain\.lintcha\.com\/deployer\/">/.test(html), "canonical points at the public deployer page");
ok(/data-history-form/.test(html) && /data-history-address/.test(html) && /type="submit"[^>]*data-history-read/.test(html), "one labelled, explicit-submit address form exists");
ok(/Nothing has been requested\./.test(html), "loading the page claims no lookup and starts from a no-request state");
ok(/not an all-time wallet profile/i.test(html) && /exact block range/i.test(html), "the visible copy bounds the product instead of claiming all-time history");
ok(/factory-log chronology; this is not a ranking/i.test(html), "the visible order is identified as chronology rather than evaluative ranking");
ok(/exposes no token address or transaction/i.test(html) && /no verdict/i.test(html), "the public projection and non-judgment boundary are visible");
ok(/data-history-from/.test(html) && /data-history-to/.test(html) && /data-history-count/.test(html) && /data-history-freshness/.test(html), "coverage, count and freshness have separate visible fields");
ok(/data-history-hash/.test(html) && /page rows sha-256/.test(html), "the exact page-row hash has a visible slot");
ok(/<script src="\/deployer\/deployer\.js"><\/script>/.test(html) && !/<script(?![^>]*\ssrc=)/.test(html), "the page has one external script and no inline script");
ok(/<meta property="og:url" content="https:\/\/chain\.lintcha\.com\/deployer\/">/.test(html) && /<meta property="og:image" content="https:\/\/chain\.lintcha\.com\/og\.png">/.test(html) && /<link rel="manifest" href="\/manifest\.webmanifest">/.test(html), "social preview and manifest metadata remain same-origin");

ok(/form\.addEventListener\("submit"[\s\S]*fetch\("\/api\/deployer\?" \+ params\.toString\(\)/.test(js), "the endpoint is reached only inside explicit form submission");
ok(/params = new URLSearchParams\(\)/.test(js) && /params\.set\("address", address\)/.test(js), "the address query is encoded by URLSearchParams");
ok(/credentials: "omit"/.test(js) && /cache: "no-store"/.test(js), "the read sends no credentials and asks no stale cache");
ok(/SUCCESS_KEYS = \["ok", "address", "from_block", "to_block", "read_at", "launches_seen", "page_limit", "truncated", "rows_hash", "rows"\]/.test(js), "the browser accepts one exact success shape");
ok(/FAILURE_KEYS = \["ok", "why"\]/.test(js) && /exactKeys\(body, FAILURE_KEYS\)/.test(js), "failures are also bounded to one exact shape");
ok(/Date\.parse\(value \+ "T00:00:00\.000Z"\)/.test(js) && /toISOString\(\)\.slice\(0, 10\) === value/.test(js), "row dates must be real canonical calendar dates");
ok(/row\.block >= body\.from_block && row\.block <= body\.to_block/.test(js) && /body\.rows\.length === body\.page_limit/.test(js), "row coverage and a truncated full page are checked before rendering");
ok(/await sha256\(JSON\.stringify\(answer\.body\.rows\)\)[\s\S]*hash !== answer\.body\.rows_hash[\s\S]*renderRows\(answer\.body\.rows\)/.test(js), "rows are hash-verified before any rendering call");
ok(/textContent = value/.test(js) && /document\.createElement\("bdi"\)/.test(js) && !/innerHTML|insertAdjacentHTML|document\.write/.test(js), "on-chain declarations enter isolated text nodes, never markup sinks");
ok(/params\.set\("name", row\.name\); params\.set\("ticker", row\.ticker\)/.test(js), "a row restores both exact declarations in Read");
ok(/filterInput\.addEventListener\("input", applyFilter\)/.test(js) && /makes no request/.test(js), "the loaded-page filter is local and says so");
ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(js), "the page persists no searched address");
ok(!/https?:\/\//.test(js) && !/fetch\([^)]*https?:/.test(js), "the page script names no third-party endpoint");
ok(/<loc>https:\/\/chain\.lintcha\.com\/deployer\/<\/loc>/.test(sitemap), "the generated sitemap advertises the existing public page");

console.log(`deployer history static: ${checks} checks, ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
