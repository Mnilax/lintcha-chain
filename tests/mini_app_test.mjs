// Static Telegram Mini App contract: one compact, noindex presentation of the existing comparison, wall,
// deployer history and token state. It adds no Telegram identity, wallet path, persistence or third-party surface.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "site", "app", "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "site", "app", "app.js"), "utf8");
const headers = fs.readFileSync(path.join(root, "site", "_headers"), "utf8");
const sitemap = fs.readFileSync(path.join(root, "site", "sitemap.xml"), "utf8");
let checks = 0, failures = 0;
const ok = (value, label) => { checks++; if (!value) { failures++; console.log("  FAIL " + label); } };
const count = (text, pattern) => (text.match(pattern) || []).length;

ok(/<meta name="robots" content="noindex,nofollow">/.test(html) && !sitemap.includes("/app/"), "the duplicate Telegram surface is noindex and absent from the public sitemap");
ok(count(html, /data-hero-lockup/g) === 1 && /class="hero-lockup-bat"[^>]+echo-bat-front\.png/.test(html) && /class="hero-lockup-word"[^>]*>LINTCHA</.test(html), "the compact surface carries the same Echo Bat hero lockup");
ok(count(html, /role="tab"/g) === 4 && count(html, /role="tabpanel"/g) === 4, "read, live, deployer and token are exactly four accessible tabs and panels");
ok(/data-app-tab="read"[\s\S]*data-app-tab="live"[\s\S]*data-app-tab="deployer"[\s\S]*data-app-tab="token"/.test(html), "the compact navigation keeps the agreed feature order");
ok(["name", "ticker", "description", "twitter", "telegram", "discord", "website", "farcaster", "logo", "recipient"].every(name => html.includes(`name="${name}"`)), "Read carries the existing identity fields");
ok(/data-result-tools[^>]*data-index-hash="[0-9a-f]{64}"/.test(html) && /src="\/launch-page\.js"/.test(html) && /src="\/chain\.js"/.test(html), "Read reuses the hash-bound comparison client");
ok(["data-wall", "data-wall-rows", "data-wall-snapshot", "data-wall-watcher", "data-wall-hash"].every(value => html.includes(value)), "Live reuses the wall contract and coverage slots");
ok(["data-history", "data-history-form", "data-history-address", "data-history-rows", "data-history-hash"].every(value => html.includes(value)), "Deployer reuses the retained-history contract");
ok(/script\.src = "\/live\/live\.js"/.test(js) && /if \(name === "live"\) loadLive\(\)/.test(js), "the existing live client loads only when Live is opened");
ok(/ArrowRight/.test(js) && /ArrowLeft/.test(js) && /event\.key === "Home"/.test(js) && /event\.key === "End"/.test(js), "the tab list supports keyboard navigation");
ok(!/(?:localStorage|sessionStorage|indexedDB|\.cookie\b|sendBeacon|analytics|gtag\s*\()/i.test(js), "the shell stores and reports nothing");
ok(!/(?:Telegram\.WebApp|telegram-web-app|initData|window\.ethereum|\/api\/hold)/i.test(html + js), "the first Mini App adds no Telegram identity or holder-wallet path");
ok(!/<(?:iframe|object|embed)\b/i.test(html), "the Mini App embeds no external surface");
const resourceUrls = [...html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)="([^"]+)"/gi)].map(match => match[1]);
ok(resourceUrls.length > 0 && resourceUrls.every(url => url.startsWith("/")), "every static dependency is same-origin");
ok(/script-src 'self'/.test(headers) && /connect-src 'self'/.test(headers) && !/telegram\.org/.test(headers), "the strict same-origin CSP is unchanged");
ok(!/data-token-address|data-copy-address/.test(html) && /The token is not published yet\./.test(html), "the dormant build exposes no empty contract slot or token action");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chain-app-"));
const tokenFile = path.join(temp, "token.json");
const out = path.join(temp, "out");
const address = "0x" + crypto.randomBytes(20).toString("hex");
const pons = "https://example.invalid/pons/" + crypto.randomBytes(4).toString("hex");
const uniswap = "https://example.invalid/uniswap/" + crypto.randomBytes(4).toString("hex");
fs.writeFileSync(tokenFile, JSON.stringify({ address, pons, uniswap }));
const built = spawnSync(process.execPath, [path.join(root, "tools", "build.mjs"), "--token", tokenFile, "--out", out], { encoding: "utf8" });
ok(built.status === 0, `an active-state app build succeeds (${(built.stderr || "").trim()})`);
const active = built.status === 0 ? fs.readFileSync(path.join(out, "app", "index.html"), "utf8") : "";
ok(count(active, new RegExp(address, "g")) === 1 && active.includes(`href="${pons}"`) && active.includes(`href="${uniswap}"`), "token activation projects the one verified token state into the Mini App");

console.log(`mini app static: ${checks} checks, ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
