import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits, parseTelegramLaunch, reviewLines } from "../copy/copy-app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const html = read("copy", "index.html");
const js = read("copy", "copy-app.js");
const css = read("copy", "copy-app.css");
const headers = read("_headers");
const count = (text, pattern) => (text.match(pattern) || []).length;

test("the sheet carries an immutable 'Lintcha Copy — trading' label that the script never touches", () => {
  assert.equal(count(html, /Lintcha Copy — trading<\/span>/g), 1);
  assert.match(html, /<header class="module-label" data-module-label>/);
  assert.match(html, /It is not read-only Lintcha Core\./);
  assert.match(html, /Auto-BUY can act only inside an active bounded permission/);
  assert.equal(/data-module-label|module-name|module-boundary/.test(js), false);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /<title>Lintcha Copy — trading<\/title>/);
});

test("strict same-origin CSP, no third-party script, no storage, no analytics, no inline handlers", () => {
  assert.match(headers, /script-src 'self';/);
  assert.match(headers, /connect-src 'self';/);
  assert.match(headers, /style-src 'self';/);
  assert.match(headers, /default-src 'none'/);
  assert.match(headers, /frame-ancestors https:\/\/web\.telegram\.org/);
  assert.equal(/telegram\.org\/js|cdn\.|googleapis|unpkg|jsdelivr/.test(html + js + css), false);
  assert.equal(/(?:localStorage|sessionStorage|indexedDB|\.cookie\b|sendBeacon|analytics|gtag\s*\(|navigator\.sendBeacon)/i.test(js), false);
  assert.equal(/\son[a-z]+="/i.test(html), false);
  assert.equal(/<style|style="/.test(html), false);
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), false);
  const resources = [...html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)="([^"]+)"/gi)].map((match) => match[1]);
  assert.equal(resources.length > 0 && resources.every((url) => url.startsWith("/copy/")), true);
  assert.equal(/<(?:iframe|object|embed|form)\b/i.test(html), false);
  assert.equal(/fetchImpl\(`\$\{origin\}\$\{API\}/.test(js) && /const API = "\/copy\/api"/.test(js), true);
});

test("the page separates review, explicit confirm and cancel, and the sheet controller is the single audited copy", () => {
  assert.match(html, /data-action="confirm"/);
  assert.match(html, /data-action="cancel"/);
  assert.match(html, /Separate confirmation\./);
  assert.match(html, /SELL approval and trade are two separate manual confirmations/);
  assert.equal(read("copy", "confirm-each.mjs"), fs.readFileSync(path.join(root, "..", "secure-sheet-crypto", "src", "confirm-each.mjs"), "utf8"));
  assert.match(js, /new ExternalEip1193WalletAdapter\(provider\)/);
  assert.equal(/seed|mnemonic|privateKey/.test(js.replace(/\/\/.*$/gm, "").replace(/Seed phrases and private keys never enter/g, "")), false);
});

test("launch parsing, unit formatting and review lines are exact", () => {
  const initData = "query_id=q&user=%7B%22id%22%3A42%7D&auth_date=1&hash=ff&signature=sig&start_param=intent_abc";
  const launch = parseTelegramLaunch(`#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppPlatform=ios`);
  assert.equal(launch.userId, "42");
  assert.equal(launch.initData, initData);
  assert.equal(launch.startParam, "intent_abc");
  assert.equal(parseTelegramLaunch(""), null);
  assert.equal(parseTelegramLaunch("#tgWebAppData=user%3Dnope").userId, null);
  assert.equal(formatUnits("39322474350183024"), "0.039322");
  assert.equal(formatUnits("1000000000000000000"), "1");
  assert.equal(formatUnits("0"), "0");
  const lines = reviewLines({ label: "Lintcha Copy — trading", direction: "BUY", operation: "TRADE", chainId: 4663, token: "0x" + "3".repeat(40), amountIn: "39322474350183024", minimumOutput: "1", slippageBps: 50, target: "0x" + "2".repeat(40), selector: "0x59a87bc1", value: "39322474350183024", simulationBlock: 65697020, expiresAt: 1700000000 });
  assert.deepEqual(lines.map(([key]) => key), ["Module", "Action", "Chain", "Token", "Amount in", "Minimum out", "Slippage cap", "Target contract", "Selector", "Native value", "Simulated at block", "Expires"]);
  assert.equal(lines[4][1], "0.039322 ETH");
  assert.equal(lines[6][1], "0.50%");
});
