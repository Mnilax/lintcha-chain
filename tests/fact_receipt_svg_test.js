// The visual fact-receipt renderer is pure and network-silent. Its SVG carries the exact receipt text and full
// snapshot context without links, remote assets, scripts, a canvas or state-dependent presentation.
//   node tests/fact_receipt_svg_test.js
"use strict";
const path = require("path");
const fs = require("fs");
const V = require(path.resolve(__dirname, "..", "site", "fact-receipt-svg.js"));

let checks = 0, failures = 0;
const ok = (value, label) => { checks++; if (!value) { failures++; console.log("  FAIL " + label); } };
const copy = value => JSON.parse(JSON.stringify(value));
const hash = "18cd4c4d6a3255f58b359f7d2c802888bb9d78f8f515f8b1c4d7013fb16ed665";
const fixture = () => ({
  schema: "lintcha-chain/fact-receipt/v1",
  source: "https://chain.lintcha.com/",
  language: "en",
  snapshot: {
    from_block: 59793981,
    to_block: 60643336,
    from_time: "2026-09-10T23:24:55.000Z",
    to_time: "2026-09-11T23:24:55.000Z",
    index_sha256: hash
  },
  input: {
    name: "L<BOB & Friends>",
    ticker: "YOINK\"",
    description: "first line\n<script>alert('receipt')</script>",
    twitter: "",
    telegram: "",
    discord: "",
    website: "https://example.invalid/?one=<two>&three=\"four\"",
    farcaster: "",
    logo: "",
    recipient: "0xabababababababababababababababababababab"
  },
  result: [{
    heading: "What it calls <itself>",
    checks: [{
      check: "Ticker, exact & literal",
      lines: [{ field: "ticker", text: "<script> is plain receipt text, not markup & not a verdict" }]
    }]
  }]
});

const receipt = fixture();
const svg = V.render(receipt);
ok(V.receiptOf(receipt) === receipt, "an exact bounded v1 receipt is accepted without rewriting it");
ok(typeof svg === "string" && svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), "one standalone SVG is returned");
ok(svg === V.render(receipt), "rendering is deterministic");
ok(svg.includes("strings only · no verdict") && svg.includes("portable context, not independent proof"), "both product boundaries are printed verbatim");
ok(svg.includes("59793981 — 60643336") && svg.includes("2026-09-10T23:24:55.000Z — 2026-09-11T23:24:55.000Z") && svg.includes(hash.slice(0, 32)) && svg.includes(hash.slice(32)), "the exact block window, time window and full digest are visible");
ok(svg.includes("L&lt;BOB &amp; Friends&gt;") && svg.includes("&lt;script&gt; is plain receipt text") && svg.includes("&lt;script&gt;alert(&apos;receipt&apos;)&lt;/script&gt;"), "untrusted input and result strings are escaped, not dropped");
ok(!svg.includes("<script") && !/<(?:a|image|foreignObject|iframe|canvas)\b/i.test(svg), "the SVG contains no active or externally loaded element");
ok(!/\b(?:href|src)=/i.test(svg) && !/url\s*\(/i.test(svg), "the SVG contains no link, source attribute or CSS URL");
ok(!svg.includes(receipt.source), "the receipt source is validated but never emitted as a live or visible URL");
ok(!/data-state|st-shared|st-look|st-unique|#(?:f00|0f0|ff0000|00ff00)\b/i.test(svg), "no state is interpreted into a color or class");
ok(/width="1600" height="\d+" viewBox="0 0 1600 \d+"/.test(svg), "the bounded dimensions are explicit");

const shell = fs.readFileSync(path.resolve(__dirname, "..", "src", "templates", "shell.html"), "utf8");
const page = fs.readFileSync(path.resolve(__dirname, "..", "site", "chain.js"), "utf8");
ok(shell.includes('data-download-receipt-svg') && shell.indexOf('fact-receipt-svg.js') < shell.indexOf('chain.js'), "the page loads the pure renderer before wiring its SVG download control");
ok(page.includes('renderer.render(receipt)') && page.includes('lintcha-chain-fact-receipt.svg') && page.includes('image/svg+xml;charset=utf-8'), "the control exports the current exact receipt as a local SVG file");

let changed = copy(receipt); changed.extra = true;
ok(V.render(changed) === null, "an extra root field is refused");
changed = copy(receipt); changed.snapshot.extra = true;
ok(V.render(changed) === null, "an extra snapshot field is refused");
changed = copy(receipt); changed.input.extra = "value";
ok(V.render(changed) === null, "an extra input field is refused");
changed = copy(receipt); changed.result[0].checks[0].lines[0].extra = "value";
ok(V.render(changed) === null, "an extra result-line field is refused");
changed = copy(receipt); changed.schema = "lintcha-chain/fact-receipt/v2";
ok(V.render(changed) === null, "an unknown schema is refused");
changed = copy(receipt); changed.snapshot.index_sha256 = "not-a-digest";
ok(V.render(changed) === null, "a malformed digest is refused");
changed = copy(receipt); changed.snapshot.to_block = changed.snapshot.from_block - 1;
ok(V.render(changed) === null, "a reversed block window is refused");
changed = copy(receipt); changed.snapshot.to_time = "2026-09-09T23:24:55.000Z";
ok(V.render(changed) === null, "a reversed time window is refused");
changed = copy(receipt); changed.snapshot.from_block = Number.MAX_SAFE_INTEGER + 1;
ok(V.render(changed) === null, "an unsafe block number is refused");
changed = copy(receipt); changed.language = "not a language/value";
ok(V.render(changed) === null, "an unbounded language value is refused");
changed = copy(receipt); changed.input.name = "x".repeat(4097);
ok(V.render(changed) === null, "an oversized pasted value is refused instead of truncated");
changed = copy(receipt); changed.result[0].checks[0].lines[0].text = "bad\u0000xml";
ok(V.render(changed) === null, "text that cannot form XML is refused");
changed = copy(receipt); changed.result = Array.from({ length: 9 }, () => copy(receipt.result[0]));
ok(V.render(changed) === null, "too many result groups are refused");
changed = copy(receipt); changed.result[0].checks[0].lines = Array.from({ length: 129 }, () => ({ field: null, text: "line" }));
ok(V.render(changed) === null, "too many rendered lines are refused");

console.log(`fact receipt svg: ${checks} checks, ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
