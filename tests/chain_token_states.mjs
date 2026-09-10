// lintcha-chain, the token block's three states and the header cluster's links, built and checked without touching the
// tree. site/token.json and site/links.json ship with every value null and stay that way until the token is really
// deployed and the accounts really exist (no placeholder, no zeroes, no buy link, no empty slot in the tree); this test
// writes a temporary token.json with an address made up at run time, builds into a temporary directory with --token and
// --out, and checks what each state renders:
//   a. all null           no contract row, no buy button, no token section, no launch band, the cluster is GITHUB and
//                         X only, X on the default account, the made-up address nowhere in the page
//   b. address and pons   one filled BUY button in the header cluster, the contract row, section fifteen with the pons
//                         button only, two live tiles showing a dash, the launch band under the footer
//   c. pons and uniswap   both buttons, the uniswap one an outline
// A fourth build takes a temporary links.json with both accounts filled and checks the cluster: three outbound items,
// GITHUB then X then TELEGRAM, X on the substituted address. States a, b and c pass no --links, so they render against
// the tree's own site/links.json and the shipped default is what is under test there.
//
// The address appears three times on a built page with an address, and two of those places carry a copy button:
//   data-token-address   3   the contract row under the status strip, section fifteen, the launch band under the footer
//   data-copy-address    2   the contract row's button and the band's; section fifteen prints the address without one
// Both numbers are the count of places the build renders, not a number fitted to the output: the band added one address
// and one button to the two addresses and one button the page carried before it.
//
// Then it checks the tree's own site/token.json is all null, site/links.json is both null, and the tree's
// site/index.html carries none of it.
//   node tests/chain_token_states.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0, failures = 0;
const ok = (cond, what) => { checks++; if (!cond) { failures++; console.log("  FAIL " + what); } };
const count = (html, re) => (html.match(re) || []).length;
// the hrefs of the cluster's outbound items, in the order the build renders them
const outHrefs = html => (html.match(/class="out" href="[^"]*"/g) || []).map(m => m.slice('class="out" href="'.length, -1));
// the cluster's own markup: outbound anchors only, no nested div, so the first closing tag ends it
const clusterOf = html => { const m = /<div class="cluster">([\s\S]*?)<\/div>/.exec(html); return m ? m[1] : ""; };
// the text inside one named address slot, or null when that slot is not on the page
const slot = (html, cls) => { const m = new RegExp('class="' + cls + '" data-token-address>([^<]*)<').exec(html); return m ? m[1] : null; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chain-token-"));
const address = "0x" + crypto.randomBytes(20).toString("hex");   // made up here, never written into the tree
const pons = "https://example.invalid/pons/" + crypto.randomBytes(4).toString("hex");
const uniswap = "https://example.invalid/uniswap/" + crypto.randomBytes(4).toString("hex");
const xAccount = "https://example.invalid/x/" + crypto.randomBytes(4).toString("hex");
const telegram = "https://example.invalid/telegram/" + crypto.randomBytes(4).toString("hex");
const X_DEFAULT = "https://x.com/mnilax";   // the account the vendored footer links; the build falls back to it when links.json carries no x
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
ok(count(a, /class="contract"/g) === 0, "no contract row");
ok(count(a, /class="buy"/g) === 0, "no buy button");
ok(count(a, /token-sec/g) === 0, "no token section");
ok(count(a, /class="band"/g) === 0 && count(a, /band-address|band-copy/g) === 0, "no launch band, not even an empty one");
ok(count(a, /data-token-address/g) === 0 && count(a, /data-copy-address/g) === 0, "no address slot and no copy button for one");
ok(count(a, /class="out"/g) === 2, "cluster is two outbound items");
ok(count(a, /data-i18n="nav\.telegram"/g) === 0 && count(a, /class="out"/g) === 2, "no telegram item, no stub and no empty slot");
ok(outHrefs(a).length === 2 && outHrefs(a)[1] === X_DEFAULT, "X points at the default account");
ok(!a.includes(address) && !a.includes(pons), "the made-up address and link are nowhere");
ok(!a.includes(xAccount) && !a.includes(telegram), "the made-up accounts are nowhere");

console.log("state b: address and pons");
const b = build("b", { address, pons, uniswap: null });
ok(count(b, /class="buy"/g) === 1 && b.includes(`class="buy" href="${pons}"`), "one filled buy button, to the pons link");
// three address slots: the contract row, section fifteen, the band; two copy buttons: the row's and the band's
ok(count(b, /class="contract"/g) === 1 && count(b, /data-token-address>[^<]*</g) === 3, "the contract row, the section and the band carry the address");
// the token section is numbered one past the last section of the page: the order in tools/build.mjs carries
// fourteen sections and none is pending, so String(ORDER.length + 1) makes the token section fifteen. The
// shipped test pinned s12, from an order three sections shorter; that assertion was already failing before
// the band arrived and is corrected here from the order, not fitted to the output.
ok(count(b, /class="sec token-sec" id="s15"/g) === 1, "the token section is section fifteen");
ok(count(b, /data-sec="14"/g) === 1 && count(b, /data-sec="15"/g) === 1 && count(b, /data-sec="16"/g) === 0, "numbered straight after the last section of the page, no gap");
ok(count(b, /token-btn-pons/g) === 1 && count(b, /token-btn-uni/g) === 0, "pons button only");
ok(count(b, /badge-live/g) === 2 && count(b, /class="cell-v" data-i18n="token.dash">—</g) === 2, "two live tiles, each a dash");
ok(count(b, /data-copy-address/g) === 2, "two copy buttons: the contract row's and the band's");
ok(count(b, /class="band"/g) === 1 && count(b, /class="band-copy"/g) === 1, "one launch band, with one copy button");
ok(slot(b, "band-address") === address && slot(b, "band-address") === slot(b, "contract-address"), "the band carries the contract row's address");
ok(b.indexOf('class="band"') > b.indexOf("</footer>"), "the band sits under the footer");
ok(count(b, /class="out"/g) === 2 && outHrefs(b)[1] === X_DEFAULT, "the cluster is unchanged by the token: two items, X on the default account");

console.log("state c: pons and uniswap");
const c = build("c", { address, pons, uniswap });
ok(count(c, /token-btn-pons/g) === 1 && count(c, /token-btn-uni/g) === 1 && c.includes(`href="${uniswap}"`), "both buttons, the uniswap one an outline");
ok(count(c, /class="buy"/g) === 1, "still one filled button on the page");
ok(count(c, /class="band"/g) === 1 && slot(c, "band-address") === address, "one band, the same address");

console.log("links: both accounts filled");
const l = build("links", { address, pons, uniswap: null }, { x: xAccount, telegram });
const hrefs = outHrefs(l);
ok(count(l, /class="out"/g) === 3, "cluster is three outbound items");
ok(hrefs.length === 3 && hrefs[0] === "https://github.com/Mnilax/lintcha-chain" && hrefs[1] === xAccount && hrefs[2] === telegram, "github, then X on the substituted account, then telegram");
ok(count(clusterOf(l), /class="arrow"/g) === 3, "each of the three carries the arrow");
ok(count(l, /data-i18n="nav\.telegram"/g) === 1, "the telegram item is keyed nav.telegram");
ok(!l.includes(X_DEFAULT), "the default X account is not on the page once links.json names one");

console.log("the tree");
const treeToken = JSON.parse(fs.readFileSync(path.join(root, "site", "token.json"), "utf8"));
ok(treeToken.address === null && treeToken.pons === null && treeToken.uniswap === null, "site/token.json is all null");
const treeLinks = JSON.parse(fs.readFileSync(path.join(root, "site", "links.json"), "utf8"));
ok(treeLinks.x === null && treeLinks.telegram === null, "site/links.json is both null");
const tree = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
ok(count(tree, /class="contract"|class="buy"|token-sec|class="band"/g) === 0, "site/index.html carries no token block and no band");
ok(!tree.includes(address), "the made-up address is not in the tree's page");
ok(!tree.includes(xAccount) && !tree.includes(telegram), "the made-up accounts are not in the tree's page");
ok(count(tree, /class="out"/g) === 2 && outHrefs(tree)[1] === X_DEFAULT, "the tree's page links the default X account and carries no telegram item");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`chain token states: ${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
