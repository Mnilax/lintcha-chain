// One activation contract is shared by the static build and Worker; unsafe or ambiguous configuration closes.
import { tokenConfigOf, tokenConfigBytesOf, linksConfigOf, requiredHttpsUrlOf, TOKEN_CONFIG_BODY_LIMIT } from "../lib/config-contract.mjs";

let checks = 0, failures = 0;
const ok = (value, label) => { checks++; if (!value) { failures++; console.log("  FAIL " + label); } };
const address = "0x" + "aB".repeat(20);
const canonical = address.toLowerCase();

ok(JSON.stringify(tokenConfigOf({ address: null, pons: null, uniswap: null })) === JSON.stringify({ address: null, pons: null, uniswap: null }), "the explicit all-null pre-launch state is valid");
ok(JSON.stringify(tokenConfigOf({ address, pons: "https://example.invalid/pons", uniswap: "https://example.invalid/pool" })) === JSON.stringify({ address: canonical, pons: "https://example.invalid/pons", uniswap: "https://example.invalid/pool" }), "an active state canonicalizes one address and two HTTPS destinations");
ok(tokenConfigOf({ address: canonical, pons: "https://example.invalid/pons", uniswap: null }).address === canonical, "the primary-link-only active state is valid");
const encodedToken = value => new TextEncoder().encode(JSON.stringify(value));
ok(tokenConfigBytesOf(encodedToken({ address, pons: "https://example.invalid/pons", uniswap: null })).address === canonical,
  "the shared byte reader accepts the same complete UTF-8 activation document");
const longToken = { address: canonical, pons: "https://example.invalid/" + "a".repeat(TOKEN_CONFIG_BODY_LIMIT), uniswap: null };
ok(encodedToken(longToken).byteLength > TOKEN_CONFIG_BODY_LIMIT && tokenConfigOf(longToken) === null && tokenConfigBytesOf(encodedToken(longToken)) === null,
  "an activation object whose canonical document cannot fit the shared ceiling is refused everywhere");
const paddedToken = new TextEncoder().encode(JSON.stringify({ address, pons: "https://example.invalid/pons", uniswap: null }) + " ".repeat(TOKEN_CONFIG_BODY_LIMIT));
ok(paddedToken.byteLength > TOKEN_CONFIG_BODY_LIMIT && tokenConfigBytesOf(paddedToken) === null,
  "an otherwise valid document cannot cross the shared raw-byte ceiling with trailing whitespace");
ok(tokenConfigBytesOf(Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])) === null,
  "invalid UTF-8 cannot be repaired into activation input");

for (const [label, value] of [
  ["missing key", { address: null, pons: null }],
  ["extra key", { address: null, pons: null, uniswap: null, other: null }],
  ["malformed address", { address: "not-an-address", pons: "https://example.invalid/pons", uniswap: null }],
  ["zero address", { address: "0x" + "0".repeat(40), pons: "https://example.invalid/pons", uniswap: null }],
  ["address without primary link", { address: canonical, pons: null, uniswap: null }],
  ["link before address", { address: null, pons: "https://example.invalid/pons", uniswap: null }],
  ["empty link", { address: canonical, pons: "", uniswap: null }],
  ["link whitespace", { address: canonical, pons: " https://example.invalid/pons", uniswap: null }],
  ["non-HTTPS link", { address: canonical, pons: "http://example.invalid/pons", uniswap: null }],
  ["script link", { address: canonical, pons: "javascript:alert(1)", uniswap: null }],
  ["credential link", { address: canonical, pons: "https://name:secret@example.invalid/pons", uniswap: null }]
]) ok(tokenConfigOf(value) === null, "token rejects " + label);

ok(JSON.stringify(linksConfigOf({ x: null, telegram: null })) === JSON.stringify({ x: null, telegram: null }), "the explicit no-account state is valid");
const publicX = [
  { href: "https://x.com/mnilax", label: "@mnilax" },
  { href: "https://x.com/lintchadotcom", label: "@lintchadotcom" }
];
ok(JSON.stringify(linksConfigOf({ x: publicX, telegram: "https://example.invalid/tg" })) === JSON.stringify({ x: publicX, telegram: "https://example.invalid/tg" }), "labelled HTTPS X accounts and one Telegram account are valid");
ok(requiredHttpsUrlOf("https://example.invalid/path") === "https://example.invalid/path" && requiredHttpsUrlOf("javascript:alert(1)") === null, "a required runtime link is either canonical HTTPS or absent");
for (const [label, value] of [
  ["missing account key", { x: null }],
  ["extra account key", { x: null, telegram: null, other: null }],
  ["string instead of X account list", { x: "https://x.com/mnilax", telegram: null }],
  ["empty X account list", { x: [], telegram: null }],
  ["duplicate X destination", { x: [publicX[0], publicX[0]], telegram: null }],
  ["missing X label", { x: [{ href: "https://x.com/mnilax" }], telegram: null }],
  ["empty X label", { x: [{ href: "https://x.com/mnilax", label: "" }], telegram: null }],
  ["unsafe X destination", { x: [{ href: "javascript:alert(1)", label: "@mnilax" }], telegram: null }],
  ["empty account", { x: "", telegram: null }],
  ["non-HTTPS account", { x: "http://example.invalid/x", telegram: null }],
  ["script account", { x: null, telegram: "javascript:alert(1)" }]
]) ok(linksConfigOf(value) === null, "links reject " + label);

console.log(`config contract: ${checks} checks, ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
