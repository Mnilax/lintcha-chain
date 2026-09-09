// lintcha-chain, the token block's three states, built and checked without touching the tree. site/token.json ships
// with every value null and stays that way until the token is really deployed (no placeholder, no zeroes, no buy link
// in the tree); this test writes a temporary token.json with an address made up at run time, builds into a temporary
// directory with --token and --out, and checks what each state renders:
//   a. all null           no contract row, no buy button, no token section, the made-up address nowhere in the page
//   b. address and pons   one filled BUY button in the header cluster, the contract row, section twelve with the pons
//                         button only, two live tiles showing a dash
//   c. pons and uniswap   both buttons, the uniswap one an outline
// Then it checks the tree's own site/token.json is all null and the tree's site/index.html carries none of it.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chain-token-"));
const address = "0x" + crypto.randomBytes(20).toString("hex");   // made up here, never written into the tree
const pons = "https://example.invalid/pons/" + crypto.randomBytes(4).toString("hex");
const uniswap = "https://example.invalid/uniswap/" + crypto.randomBytes(4).toString("hex");
function build(name, tokenJson) {
  const dir = path.join(tmp, name); fs.mkdirSync(dir, { recursive: true });
  const tokenFile = path.join(dir, "token.json"); fs.writeFileSync(tokenFile, JSON.stringify(tokenJson));
  const r = spawnSync(process.execPath, [path.join(root, "tools", "build.mjs"), "--token", tokenFile, "--out", dir], { encoding: "utf8" });
  ok(r.status === 0, `state ${name}: build exits 0 (${(r.stderr || "").trim()})`);
  return r.status === 0 ? fs.readFileSync(path.join(dir, "index.html"), "utf8") : "";
}

console.log("state a: all null");
const a = build("a", { address: null, pons: null, uniswap: null });
ok(count(a, /class="contract"/g) === 0, "no contract row");
ok(count(a, /class="buy"/g) === 0, "no buy button");
ok(count(a, /token-sec/g) === 0, "no token section");
ok(count(a, /class="out"/g) === 2, "cluster is two outbound items");
ok(!a.includes(address) && !a.includes(pons), "the made-up address and link are nowhere");

console.log("state b: address and pons");
const b = build("b", { address, pons, uniswap: null });
ok(count(b, /class="buy"/g) === 1 && b.includes(`class="buy" href="${pons}"`), "one filled buy button, to the pons link");
ok(count(b, /class="contract"/g) === 1 && count(b, /data-token-address>[^<]*</g) === 2, "the contract row and the section carry the address");
ok(count(b, /id="s12"/g) === 1, "section twelve exists");
ok(count(b, /token-btn-pons/g) === 1 && count(b, /token-btn-uni/g) === 0, "pons button only");
ok(count(b, /badge-live/g) === 2 && count(b, /class="cell-v" data-i18n="token.dash">—</g) === 2, "two live tiles, each a dash");
ok(count(b, /data-copy-address/g) === 1, "one copy button");

console.log("state c: pons and uniswap");
const c = build("c", { address, pons, uniswap });
ok(count(c, /token-btn-pons/g) === 1 && count(c, /token-btn-uni/g) === 1 && c.includes(`href="${uniswap}"`), "both buttons, the uniswap one an outline");
ok(count(c, /class="buy"/g) === 1, "still one filled button on the page");

console.log("the tree");
const treeToken = JSON.parse(fs.readFileSync(path.join(root, "site", "token.json"), "utf8"));
ok(treeToken.address === null && treeToken.pons === null && treeToken.uniswap === null, "site/token.json is all null");
const tree = fs.readFileSync(path.join(root, "site", "index.html"), "utf8");
ok(count(tree, /class="contract"|class="buy"|token-sec/g) === 0, "site/index.html carries no token block");
ok(!tree.includes(address), "the made-up address is not in the tree's page");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`chain token states: ${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
