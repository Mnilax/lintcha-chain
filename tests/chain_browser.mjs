// lintcha-chain, criteria 5 to 8 of the spec driven in a real browser, against this site's layout (owned here; the
// vendored tests/launch_browser.mjs is bound to lintcha's /launch/ pages and stays as it is). Serves the site/
// directory on a local port, opens every page given (default / and /method) in headless Chrome or Edge over the
// DevTools protocol with Node's own WebSocket and http, no dependency, and records: every request at load, whether
// launch-index.json was fetched at load, the full run on the tool page (paste every field, read, read again, clear,
// toggle theme), the index fetched once on the first read and not on the second, the storage keys after the run,
// the hosts contacted, and every console error.
//   node tests/chain_browser.mjs [served-dir] [--pages /,/method] [--out build/chain-browser.json]
// Exit 1 on: a host other than the served origin, the index fetched at load, the first read fetching it other than
// once, the second read fetching anything, a storage key outside lintcha:theme and lintcha:lang, a session key, a
// cookie, a database, a cache, a service worker, or a console error. The pasted values are made up and name nobody.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf("--" + name); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const DIR = path.resolve(positional[0] || path.join(HERE, "..", "site"));
const OUT = path.resolve(opt("out", path.join(HERE, "..", "build", "chain-browser.json")));
// default "/": passing a bare "/" on the command line under Git Bash on Windows gets rewritten into a Windows path
// (MSYS path conversion), so the acceptance script leaves the default alone; pass --pages only for a list
const PAGES = opt("pages", "/").split(",").map(s => s.trim()).filter(Boolean);
const PORT = 8796, CDP_PORT = 9332;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ALLOWED_KEYS = ["lintcha:theme", "lintcha:lang"];
const INPUT = {
  name: "pons", ticker: "pons",
  description: "a made up description of at least twelve words so that the description row is compared rather than skipped",
  twitter: "twitter.com/made_up_handle_for_this_run", telegram: "t.me/made_up_channel_for_this_run", discord: "discord.gg/madeupcode",
  website: "https://example.com/made-up/", farcaster: "warpcast.com/madeuphandle", logo: "ipfs://bafymadeupcidforthisrunonly",
  recipient: "0x" + "0".repeat(39) + "1"
};

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml" };
function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
      // the host serves method.html at /method and a directory index at its directory
      let file = path.join(DIR, p.endsWith("/") ? p + "index.html" : p);
      if (!fs.existsSync(file) && fs.existsSync(file + ".html")) file += ".html";
      if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, "127.0.0.1", () => resolve(srv));
  });
}
function findBrowser() {
  return ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(f => fs.existsSync(f));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = async url => (await fetch(url)).json();
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
  const profile = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "lintcha-chain-"));
  const proc = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-proxy-server", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let version = null;
  for (let i = 0; i < 50 && !version; i++) { try { version = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); } catch (e) { await sleep(200); } }
  if (!version) { proc.kill(); srv.close(); console.error("browser did not open its protocol port"); process.exit(2); }
  const page = (await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`)).find(t => t.type === "page");
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Network.enable"); await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Log.enable");

  let phase = "idle"; const requests = []; const consoleErrors = []; let loaded = null;
  cdp.on((method, p) => {
    if (method === "Network.requestWillBeSent") requests.push({ phase, url: p.request.url, type: p.type });
    if (method === "Network.webSocketCreated") requests.push({ phase, url: p.url, type: "WebSocket" });
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
  const rowsText = `Array.from(document.querySelectorAll("#launch-results .launch-row")).map(function (row) { return row.querySelector(".launch-check").textContent + " | " + Array.from(row.querySelectorAll(".launch-line")).map(function (l) { return l.textContent; }).join(" || "); })`;

  const report = { served: DIR, origin: ORIGIN, browser: version.Browser, pages: [] };
  const failed = [];
  for (const p of PAGES) {
    const r = { page: p, violations: [] };
    await cdp.send("Storage.clearDataForOrigin", { origin: ORIGIN, storageTypes: "all" });
    phase = "load"; const m0 = requests.length, c0 = consoleErrors.length;
    const onLoad = new Promise(res => { loaded = res; });
    await cdp.send("Page.navigate", { url: ORIGIN + p });
    await onLoad; await settle();
    const loadReqs = since(m0);
    r.load = { requests: loadReqs.length, hosts: hosts(loadReqs), urls: loadReqs.map(x => x.url.replace(ORIGIN, "")), index_fetched: indexFetches(loadReqs), title: await cdp.eval("document.title") };
    r.storage_at_load = JSON.parse(await cdp.eval("JSON.stringify({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })"));
    const hasForm = await cdp.eval(`!!document.getElementById("launch-form")`);
    const all = [...loadReqs];
    if (hasForm) {
      // the full run of criterion 6: paste, read, read again, clear, toggle theme
      phase = "first read"; const m1 = requests.length;
      await cdp.eval(`(function(){ var f = document.getElementById("launch-form"); var v = ${JSON.stringify(INPUT)}; Object.keys(v).forEach(function (k) { f.elements[k].value = v[k]; }); f.requestSubmit(); return true; })()`);
      const rendered = await waitFor(`!document.getElementById("launch-results").hidden || (!document.getElementById("launch-state").hidden && document.getElementById("launch-read").disabled === false)`);
      await settle();
      const firstReqs = since(m1);
      r.first_read = { rendered, requests: firstReqs.length, urls: firstReqs.map(x => x.url.replace(ORIGIN, "")), hosts: hosts(firstReqs), index_fetched: indexFetches(firstReqs), state: await cdp.eval(`document.getElementById("launch-state").hidden ? "" : document.getElementById("launch-state").textContent`), groups: await cdp.eval(`Array.from(document.querySelectorAll("#launch-results h3")).map(function (h) { return h.textContent; })`), lines: await cdp.eval(rowsText) };
      phase = "second read"; const m2 = requests.length;
      await cdp.eval(`(function(){ var f = document.getElementById("launch-form"); f.elements.ticker.value = "madeupticker"; f.elements.name.value = "made up name"; f.requestSubmit(); return true; })()`);
      await waitFor(`document.getElementById("launch-read").disabled === false`); await settle();
      const secondReqs = since(m2);
      r.second_read = { requests: secondReqs.length, hosts: hosts(secondReqs), index_fetched: indexFetches(secondReqs), lines: (await cdp.eval(rowsText)).slice(0, 2) };
      phase = "clear and theme"; const m3 = requests.length;
      const themeBefore = await cdp.eval(`document.documentElement.getAttribute("data-theme")`);
      await cdp.eval(`(function(){ document.getElementById("launch-clear").click(); var b = document.querySelector("[data-theme-toggle]"); if (!b) return "no theme toggle"; b.click(); return "ok"; })()`);
      await settle();
      const ctrlReqs = since(m3);
      r.controls = { requests: ctrlReqs.length, hosts: hosts(ctrlReqs), results_hidden: await cdp.eval(`document.getElementById("launch-results").hidden`), theme_before: themeBefore, theme_after: await cdp.eval(`document.documentElement.getAttribute("data-theme")`) };
      all.push(...firstReqs, ...secondReqs, ...ctrlReqs);
      if (!r.first_read.rendered) r.violations.push("first read rendered nothing");
      if (r.first_read.index_fetched !== 1) r.violations.push("first read fetched the index " + r.first_read.index_fetched + " times");
      if (r.first_read.requests !== r.first_read.index_fetched) r.violations.push("first read made a request other than the index");
      if (r.second_read.requests) r.violations.push("second read made " + r.second_read.requests + " request(s)");
      if (r.controls.requests) r.violations.push("clear or theme made " + r.controls.requests + " request(s)");
      if (r.controls.theme_before === r.controls.theme_after) r.violations.push("the theme toggle did not change the theme");
    } else {
      phase = "theme"; const m3 = requests.length;
      const themeBefore = await cdp.eval(`document.documentElement.getAttribute("data-theme")`);
      await cdp.eval(`(function(){ var b = document.querySelector("[data-theme-toggle]"); if (!b) return "no theme toggle"; b.click(); return "ok"; })()`);
      await settle();
      const ctrlReqs = since(m3);
      r.controls = { requests: ctrlReqs.length, hosts: hosts(ctrlReqs), theme_before: themeBefore, theme_after: await cdp.eval(`document.documentElement.getAttribute("data-theme")`) };
      all.push(...ctrlReqs);
      if (r.controls.requests) r.violations.push("theme made " + r.controls.requests + " request(s)");
    }
    r.storage = JSON.parse(await cdp.eval(`(async function(){ var dbs = []; try { dbs = (await indexedDB.databases()).map(function (d) { return d.name; }); } catch (e) {} var caches_ = []; try { caches_ = await caches.keys(); } catch (e) {} var sw = 0; try { sw = (await navigator.serviceWorker.getRegistrations()).length; } catch (e) {} return JSON.stringify({ local: Object.keys(localStorage).sort(), session: Object.keys(sessionStorage), cookie: document.cookie, databases: dbs, caches: caches_, service_workers: sw }); })()`));
    r.console_errors = consoleErrors.slice(c0);
    phase = "idle";
    const foreign = hosts(all).filter(h => h !== `127.0.0.1:${PORT}` && h !== "data:");
    if (foreign.length) r.violations.push("host other than the served origin: " + foreign.join(", "));
    if (r.load.index_fetched) r.violations.push("index fetched at load");
    const strange = r.storage.local.filter(k => !ALLOWED_KEYS.includes(k));
    if (strange.length) r.violations.push("storage key outside the two: " + strange.join(", "));
    if (r.storage.session.length || r.storage.cookie || r.storage.databases.length || r.storage.caches.length || r.storage.service_workers) r.violations.push("something stored beyond the two keys: " + JSON.stringify(r.storage));
    if (r.console_errors.length) r.violations.push("console: " + r.console_errors.map(e => e.text).join(" / "));
    report.pages.push(r);
    if (r.violations.length) failed.push(p);
    console.log(`page ${p}  (${r.load.title})`);
    console.log(`  load: ${r.load.requests} requests, hosts ${JSON.stringify(r.load.hosts)}, launch-index.json at load: ${r.load.index_fetched ? "yes" : "no"}`);
    console.log(`  load: ${r.load.urls.join(" ")}`);
    if (r.first_read) {
      console.log(`  first read: ${r.first_read.requests} request(s) ${JSON.stringify(r.first_read.urls)}, index fetched ${r.first_read.index_fetched} time(s), ${r.first_read.lines.length} rows in ${r.first_read.groups.length} groups`);
      for (const l of r.first_read.lines) console.log(`    ${l}`);
      console.log(`  second read: ${r.second_read.requests} request(s); ${r.second_read.lines[0] || ""}`);
      console.log(`  clear (results hidden: ${r.controls.results_hidden}), theme ${r.controls.theme_before} -> ${r.controls.theme_after}; ${r.controls.requests} request(s)`);
    } else console.log(`  theme ${r.controls.theme_before} -> ${r.controls.theme_after}; ${r.controls.requests} request(s)`);
    console.log(`  storage after the run: localStorage ${JSON.stringify(r.storage.local)}, sessionStorage ${JSON.stringify(r.storage.session)}, cookie ${JSON.stringify(r.storage.cookie)}, databases ${JSON.stringify(r.storage.databases)}, caches ${JSON.stringify(r.storage.caches)}, service workers ${r.storage.service_workers}`);
    console.log(`  console errors: ${r.console_errors.length}`);
    console.log(`  ${r.violations.length ? "FAIL " + r.violations.join("; ") : "ok"}`);
  }
  cdp.close(); proc.kill(); srv.close();
  await sleep(300); try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1) + "\n");
  const allHosts = [...new Set(report.pages.flatMap(r => [...r.load.hosts, ...(r.first_read ? r.first_read.hosts : []), ...(r.second_read ? r.second_read.hosts : []), ...r.controls.hosts]))].sort();
  console.log(`browser run: ${report.pages.length} pages in ${version.Browser}; hosts contacted ${JSON.stringify(allHosts)}; ${failed.length ? "FAIL on " + failed.join(", ") : "every page within the rules"}; report ${path.relative(process.cwd(), OUT).split(path.sep).join("/")}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(e => { console.error("browser run failed: " + (e.stack || e)); process.exit(2); });
