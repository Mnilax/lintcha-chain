// Launch identity, criteria 1 and 2 driven in a real browser (LINTCHA_12). Serves a built tree on a local port, opens
// /launch/, /es/launch/ and /pt/launch/ in headless Chrome or Edge over the DevTools protocol (no npm dependency: Node's
// own WebSocket and http), and for each page records every network request at load, fills every field, runs a check,
// runs a second check, clears, toggles the theme, changes the language, then reads what the origin stored.
//   node tests/launch_browser.mjs [served-dir] [--out build/launch-browser.json]
// Prints, per page: the hosts contacted at load and after the check, whether launch-index.json was fetched at load,
// how many times it was fetched by the first check and by the second, the storage keys after the full run, the console
// errors, and a few rendered lines as proof the page ran. Exit 1 on: a host other than the served origin, the index
// fetched at load, the first check fetching it other than once, the second check fetching anything, storage keys other
// than exactly lintcha:theme and lintcha:lang, a session key, a cookie, a database, a cache, a service worker, or a
// console error. The values pasted are made up for the run and name nobody.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const DIR = path.resolve(argv.find(a => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--out") || path.join(HERE, "..", "site", "dist"));
const OUT = path.resolve(opt("out", path.join(HERE, "..", "build", "launch-browser.json")));
const PORT = 8797, CDP_PORT = 9333;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PAGES = ["/launch/", "/es/launch/", "/pt/launch/"];
const ALLOWED_KEYS = ["lintcha:theme", "lintcha:lang"].sort();
const INDEX_FILE = "launch-index.json";
// made-up input; every field filled so every row renders; the description passes the word floor
const INPUT = {
  name: "pons", ticker: "pons",
  description: "a made up description of at least twelve words so that the description row is compared rather than skipped",
  twitter: "twitter.com/made_up_handle_for_this_run", telegram: "t.me/made_up_channel_for_this_run", discord: "discord.gg/madeupcode",
  website: "https://example.com/made-up/", farcaster: "warpcast.com/madeuphandle", logo: "ipfs://bafymadeupcidforthisrunonly",
  recipient: "0x" + "0".repeat(39) + "1"
};

// ---------------------------------------------------------------- a static server for the built tree
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml" };
function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
      if (p.endsWith("/")) p += "index.html";
      const file = path.join(DIR, p);
      if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, "127.0.0.1", () => resolve(srv));
  });
}

// ---------------------------------------------------------------- the browser and its protocol
function findBrowser() {
  const c = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return c.find(f => fs.existsSync(f));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url) { const r = await fetch(url); return r.json(); }

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = []; ws.onmessage = ev => this.onMessage(JSON.parse(ev.data)); }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); return new Cdp(ws); }
  onMessage(m) {
    if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) for (const l of this.listeners) l(m.method, m.params || {});
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  on(fn) { this.listeners.push(fn); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page script failed: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; }
  close() { this.ws.close(); }
}

async function main() {
  const browser = findBrowser();
  if (!browser) { console.error("no Chrome or Edge found"); process.exit(2); }
  const srv = await serve();
  const profile = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "lintcha-launch-"));
  const proc = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-proxy-server", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let version = null;
  for (let i = 0; i < 50 && !version; i++) { try { version = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); } catch (e) { await sleep(200); } }
  if (!version) { proc.kill(); srv.close(); console.error("browser did not open its protocol port"); process.exit(2); }
  const targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const page = targets.find(t => t.type === "page");
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Network.enable"); await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Log.enable");

  // every request and every console error is stamped with the phase it happened in
  let phase = "idle"; const requests = []; const consoleErrors = []; let loaded = null;
  cdp.on((method, p) => {
    if (method === "Network.requestWillBeSent") requests.push({ phase, url: p.request.url, method: p.request.method, type: p.type, initiator: p.initiator && p.initiator.type });
    if (method === "Network.webSocketCreated") requests.push({ phase, url: p.url, method: "WEBSOCKET", type: "WebSocket" });
    if (method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "warning")) consoleErrors.push({ phase, kind: p.type, text: p.args.map(a => a.value !== undefined ? String(a.value) : a.description || a.type).join(" ") });
    if (method === "Runtime.exceptionThrown") consoleErrors.push({ phase, kind: "exception", text: p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text });
    if (method === "Log.entryAdded" && p.entry.level === "error") consoleErrors.push({ phase, kind: "log", text: p.entry.text + (p.entry.url ? " " + p.entry.url : "") });
    if (method === "Page.loadEventFired" && loaded) loaded();
  });
  const since = mark => requests.slice(mark);
  const hosts = list => [...new Set(list.map(r => { try { const u = new URL(r.url); return u.protocol === "data:" ? "data:" : u.host; } catch (e) { return r.url; } }))].sort();
  const indexFetches = list => list.filter(r => /\/launch-index\.json(\?|$)/.test(r.url)).length;
  async function settle() { let n = requests.length; for (let i = 0; i < 20; i++) { await sleep(300); if (requests.length === n) { if (i >= 2) break; } else { n = requests.length; i = 0; } } }
  async function waitFor(expression, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cdp.eval(expression)) return true; await sleep(100); } return false; }

  const report = { served: DIR, origin: ORIGIN, browser: version.Browser, pages: [] };
  let failed = [];
  for (const p of PAGES) {
    const r = { page: p, violations: [] };
    await cdp.send("Storage.clearDataForOrigin", { origin: ORIGIN, storageTypes: "all" });
    // ---- load
    phase = "load"; const m0 = requests.length; const c0 = consoleErrors.length;
    const onLoad = new Promise(res => { loaded = res; });
    await cdp.send("Page.navigate", { url: ORIGIN + p });
    await onLoad; await settle();
    const loadReqs = since(m0);
    r.load = { requests: loadReqs.length, hosts: hosts(loadReqs), urls: loadReqs.map(x => x.url.replace(ORIGIN, "")), index_fetched: indexFetches(loadReqs) };
    r.storage_at_load = await cdp.eval("JSON.stringify({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })");
    const themeBefore = await cdp.eval(`document.documentElement.getAttribute("data-theme")`);
    // ---- first check: every field filled
    phase = "first check"; const m1 = requests.length;
    await cdp.eval(`(function(){ var f = document.getElementById("launch-form"); var v = ${JSON.stringify(INPUT)}; Object.keys(v).forEach(function (k) { f.elements[k].value = v[k]; }); f.requestSubmit(); return true; })()`);
    const rendered = await waitFor(`!document.getElementById("launch-results").hidden || (!document.getElementById("launch-state").hidden && document.getElementById("launch-state").textContent.length > 0 && document.getElementById("launch-read").disabled === false)`);
    await settle();
    const checkReqs = since(m1);
    r.first_check = { rendered, requests: checkReqs.length, hosts: hosts(checkReqs), urls: checkReqs.map(x => x.url.replace(ORIGIN, "")), index_fetched: indexFetches(checkReqs),
      state: await cdp.eval(`document.getElementById("launch-state").hidden ? "" : document.getElementById("launch-state").textContent`),
      groups: await cdp.eval(`Array.from(document.querySelectorAll("#launch-results h3")).map(function (h) { return h.textContent; })`),
      lines: await cdp.eval(`Array.from(document.querySelectorAll("#launch-results .launch-row")).map(function (row) { return row.querySelector(".launch-check").textContent + " | " + Array.from(row.querySelectorAll(".launch-line")).map(function (l) { return l.textContent; }).join(" || "); })`) };
    // ---- second check: a different ticker, nothing may be fetched
    phase = "second check"; const m2 = requests.length;
    await cdp.eval(`(function(){ var f = document.getElementById("launch-form"); f.elements.ticker.value = "madeupticker"; f.elements.name.value = "made up name"; f.requestSubmit(); return true; })()`);
    await waitFor(`document.getElementById("launch-read").disabled === false`); await settle();
    const secondReqs = since(m2);
    r.second_check = { requests: secondReqs.length, hosts: hosts(secondReqs), index_fetched: indexFetches(secondReqs),
      lines: await cdp.eval(`Array.from(document.querySelectorAll("#launch-results .launch-row")).slice(0, 2).map(function (row) { return row.querySelector(".launch-check").textContent + " | " + Array.from(row.querySelectorAll(".launch-line")).map(function (l) { return l.textContent; }).join(" || "); })`) };
    // ---- clear, theme, language: the whole surface used
    phase = "controls"; const m3 = requests.length;
    await cdp.eval(`(function(){ document.getElementById("launch-clear").click(); document.querySelector("[data-theme-toggle]").click(); var s = document.querySelector("[data-lang-select]"); if (!s) return "no language select"; s.value = s.value === "en" ? "es" : "en"; s.dispatchEvent(new Event("change", { bubbles: true })); return "ok"; })()`);
    await settle();
    const ctrlReqs = since(m3);
    r.controls = { requests: ctrlReqs.length, hosts: hosts(ctrlReqs), results_hidden: await cdp.eval(`document.getElementById("launch-results").hidden`), theme_before: themeBefore, theme: await cdp.eval(`document.documentElement.getAttribute("data-theme")`), lang: await cdp.eval(`document.documentElement.getAttribute("lang")`) };
    // ---- what the origin holds after the full run
    r.storage = JSON.parse(await cdp.eval(`(async function(){ var dbs = []; try { dbs = (await indexedDB.databases()).map(function (d) { return d.name; }); } catch (e) {} var caches_ = []; try { caches_ = await caches.keys(); } catch (e) {} var sw = 0; try { sw = (await navigator.serviceWorker.getRegistrations()).length; } catch (e) {} return JSON.stringify({ local: Object.keys(localStorage).sort(), session: Object.keys(sessionStorage), cookie: document.cookie, databases: dbs, caches: caches_, service_workers: sw }); })()`));
    r.console_errors = consoleErrors.slice(c0);
    phase = "idle";
    // ---- the rules
    const all = [...loadReqs, ...checkReqs, ...secondReqs, ...ctrlReqs];
    const foreign = hosts(all).filter(h => h !== `127.0.0.1:${PORT}` && h !== "data:");
    if (foreign.length) r.violations.push("host other than the served origin: " + foreign.join(", "));
    if (r.load.index_fetched) r.violations.push("index fetched at load");
    if (!r.first_check.rendered) r.violations.push("first check rendered nothing");
    if (r.first_check.index_fetched !== 1) r.violations.push("first check fetched the index " + r.first_check.index_fetched + " times");
    if (r.first_check.requests !== r.first_check.index_fetched) r.violations.push("first check made a request other than the index");
    if (r.second_check.requests) r.violations.push("second check made " + r.second_check.requests + " request(s)");
    if (r.controls.requests) r.violations.push("controls made " + r.controls.requests + " request(s)");
    if (JSON.stringify(r.storage.local) !== JSON.stringify(ALLOWED_KEYS)) r.violations.push("storage keys after the run: " + JSON.stringify(r.storage.local));
    if (r.storage.session.length || r.storage.cookie || r.storage.databases.length || r.storage.caches.length || r.storage.service_workers) r.violations.push("something stored beyond the two keys: " + JSON.stringify(r.storage));
    if (r.console_errors.length) r.violations.push("console: " + r.console_errors.map(e => e.text).join(" / "));
    report.pages.push(r);
    if (r.violations.length) failed.push(p);
    // ---- print
    console.log(`page ${p}`);
    console.log(`  load: ${r.load.requests} requests, hosts ${JSON.stringify(r.load.hosts)}, launch-index.json at load: ${r.load.index_fetched ? "yes" : "no"}`);
    console.log(`  load: ${r.load.urls.join(" ")}`);
    console.log(`  first check: ${r.first_check.requests} request(s) ${JSON.stringify(r.first_check.urls)}, hosts ${JSON.stringify(r.first_check.hosts)}, index fetched ${r.first_check.index_fetched} time(s), ${r.first_check.lines.length} rows in ${r.first_check.groups.length} groups`);
    for (const l of r.first_check.lines) console.log(`    ${l}`);
    console.log(`  second check: ${r.second_check.requests} request(s); ${r.second_check.lines[0] || ""}`);
    console.log(`  controls: clear (results hidden: ${r.controls.results_hidden}), theme ${r.controls.theme_before} -> ${r.controls.theme}, language -> ${r.controls.lang}; ${r.controls.requests} request(s)`);
    console.log(`  storage after the full run: localStorage ${JSON.stringify(r.storage.local)}, sessionStorage ${JSON.stringify(r.storage.session)}, cookie ${JSON.stringify(r.storage.cookie)}, databases ${JSON.stringify(r.storage.databases)}, caches ${JSON.stringify(r.storage.caches)}, service workers ${r.storage.service_workers}`);
    console.log(`  console errors: ${r.console_errors.length}`);
    console.log(`  ${r.violations.length ? "FAIL " + r.violations.join("; ") : "ok"}`);
  }
  cdp.close(); proc.kill(); srv.close();
  await sleep(300); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
  const allHosts = [...new Set(report.pages.flatMap(r => [...r.load.hosts, ...r.first_check.hosts, ...r.second_check.hosts, ...r.controls.hosts]))].sort();
  console.log(`browser run: ${report.pages.length} pages in ${version.Browser}; hosts contacted ${JSON.stringify(allHosts)}; ${failed.length ? "FAIL on " + failed.join(", ") : "every page within the rules"}; report ${path.relative(process.cwd(), OUT)}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error("browser run failed: " + (e.stack || e)); process.exit(2); });
