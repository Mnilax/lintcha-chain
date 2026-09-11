// lintcha-chain, criteria 5 to 8 of the spec driven in a real browser, against this site's layout (owned here; the
// vendored tests/launch_browser.mjs is bound to lintcha's /launch/ pages and stays as it is). Serves the site/
// directory on a local port, opens every page given (default /) in headless Chrome or Edge over the
// DevTools protocol with Node's own WebSocket and http, no dependency, and records: every request at load, whether
// launch-index.json was fetched at load, the full run on the tool page (paste every field, read, read again, clear,
// toggle theme), the index fetched once on the first read and not on the second, the storage keys after the run,
// the hosts contacted, and every console error.
//   node tests/chain_browser.mjs [served-dir] [--pages /,/live/,/deployer/,/hold/?t=MARK] [--viewport 390x844] [--port PORT] [--cdp-port PORT] [--browser PATH] [--out build/chain-browser.json]
// Exit 1 on: a host other than the served origin, the index fetched at load, the first read fetching it other than
// once, the second read fetching anything, a storage key outside lintcha:theme and lintcha:lang, a session key, a
// cookie, a database, a cache, a service worker, or a console error. The pasted values are made up and name nobody.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
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
const VIEWPORT_ARG = opt("viewport", "");
const BROWSER_ARG = opt("browser", "");
const viewportMatch = /^(\d+)x(\d+)$/.exec(VIEWPORT_ARG);
if (VIEWPORT_ARG && !viewportMatch) { console.error("viewport must be WIDTHxHEIGHT"); process.exit(2); }
const VIEWPORT = viewportMatch ? { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) } : null;
const PORT = Number(opt("port", "8796")), CDP_PORT = Number(opt("cdp-port", "9332"));
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535 || !Number.isInteger(CDP_PORT) || CDP_PORT < 1 || CDP_PORT > 65535 || PORT === CDP_PORT) {
  console.error("port and cdp-port must be distinct TCP port numbers");
  process.exit(2);
}
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ALLOWED_KEYS = ["lintcha:theme", "lintcha:lang"];
const INPUT = {
  name: "pons", ticker: "pons",
  description: "a made up description of at least twelve words so that the description row is compared rather than skipped",
  twitter: "twitter.com/made_up_handle_for_this_run", telegram: "t.me/made_up_channel_for_this_run", discord: "discord.gg/madeupcode",
  website: "https://example.com/made-up/", farcaster: "warpcast.com/madeuphandle", logo: "ipfs://bafymadeupcidforthisrunonly",
  recipient: "0x" + "0".repeat(39) + "1"
};
const RESTORED_INPUT = {
  name: '<img src=x onerror="window.__fragmentExecuted=true">',
  ticker: '<svg/onload=window.__liveTickerXss=true>'
};
const RESTORED_FRAGMENT = "#read=" + new URLSearchParams({ ...RESTORED_INPUT, index: "another-snapshot" }).toString();
const LIVE_ROWS = [
  { ...RESTORED_INPUT },
  { name: 'Ampersand & angle < quote " stay text', ticker: "$TEXT<ONLY" }
];
const HISTORY_ROWS = [
  { name: "An earlier exact declaration", ticker: "EARLIER" }
];
const LIVE_ROWS_HASH = crypto.createHash("sha256").update(JSON.stringify(LIVE_ROWS)).digest("hex");
const HISTORY_ROWS_HASH = crypto.createHash("sha256").update(JSON.stringify(HISTORY_ROWS)).digest("hex");
const LIVE_OLDER_CURSOR = "cursor_older_exact_page";
const LIVE_CURSOR = "cursor_live_exact_page";
const LIVE_BODY = {
  ok: true,
  snapshot_to_block: 900,
  gap_blocks: 2,
  watcher_to_block: 912,
  read_at: "2026-09-11T01:02:03.000Z",
  page_limit: 200,
  mode: "latest",
  older_cursor: LIVE_OLDER_CURSOR,
  live_cursor: LIVE_CURSOR,
  rows_hash: LIVE_ROWS_HASH,
  view_hash: LIVE_ROWS_HASH,
  rows: LIVE_ROWS
};
const HISTORY_BODY = {
  ...LIVE_BODY,
  mode: "before",
  older_cursor: null,
  live_cursor: null,
  rows_hash: HISTORY_ROWS_HASH,
  view_hash: HISTORY_ROWS_HASH,
  rows: HISTORY_ROWS
};
const DEPLOYER_ADDRESS = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEPLOYER_ROWS = [
  { block: 901, log_index: 2, date: "2026-09-10", name: RESTORED_INPUT.name, ticker: RESTORED_INPUT.ticker },
  { block: 912, log_index: 0, date: "2026-09-11", name: 'Ampersand & angle < quote " stay text', ticker: "$TEXT<ONLY" }
];
const DEPLOYER_ROWS_HASH = crypto.createHash("sha256").update(JSON.stringify(DEPLOYER_ROWS)).digest("hex");
const DEPLOYER_BODY = {
  ok: true,
  address: DEPLOYER_ADDRESS,
  from_block: 901,
  to_block: 912,
  read_at: "2026-09-11T01:02:03.000Z",
  launches_seen: DEPLOYER_ROWS.length,
  page_limit: 200,
  truncated: false,
  rows_hash: DEPLOYER_ROWS_HASH,
  rows: DEPLOYER_ROWS
};
const HOLD_MARK = "0123456789abcdef".repeat(2);
const HOLD_SENTENCE = "I am proving to the lintcha bot that this wallet is mine. This proof is only for https://chain.lintcha.com and one-time mark " + HOLD_MARK + ". This signature moves nothing, approves nothing and spends nothing.";
let liveWallRequests = 0;
let deployerRequests = 0;
let launchIndexRequests = 0;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml" };
function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, ORIGIN);
      let p = decodeURIComponent(requestUrl.pathname);
      if (p === "/launch-index.json") {
        launchIndexRequests++;
        if (launchIndexRequests === 1) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end("{}\n");
          return;
        }
      }
      if (p === "/api/wall") {
        liveWallRequests++;
        // The first internally consistent response carries the wrong digest. Retry and later polls carry the
        // correct one, proving that the browser withholds unverified rows before exercising their inert rendering.
        const isEarlier = requestUrl.searchParams.get("before") === LIVE_OLDER_CURSOR && [...requestUrl.searchParams.keys()].length === 1;
        const body = isEarlier
          ? HISTORY_BODY
          : { ...LIVE_BODY, rows_hash: liveWallRequests === 1 ? "0".repeat(64) : LIVE_ROWS_HASH };
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
        return;
      }
      if (p === "/api/deployer") {
        deployerRequests++;
        const exactQuery = requestUrl.searchParams.get("address") === DEPLOYER_ADDRESS && [...requestUrl.searchParams.keys()].length === 1;
        const body = exactQuery
          ? { ...DEPLOYER_BODY, rows_hash: deployerRequests === 1 ? "0".repeat(64) : DEPLOYER_ROWS_HASH }
          : { ok: false, why: "query" };
        res.writeHead(exactQuery ? 200 : 400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(body));
        return;
      }
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
  if (BROWSER_ARG) {
    const requested = path.resolve(BROWSER_ARG);
    return fs.existsSync(requested) ? requested : null;
  }
  return ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(f => fs.existsSync(f));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = async url => (await fetch(url)).json();
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.onmessage = ev => this.onMessage(JSON.parse(ev.data));
    ws.onclose = () => this.fail(new Error("browser protocol connection closed"));
    ws.onerror = () => this.fail(new Error("browser protocol connection failed"));
  }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); return new Cdp(ws); }
  fail(error) {
    for (const { rej, timer } of this.pending.values()) { clearTimeout(timer); rej(error); }
    this.pending.clear();
  }
  onMessage(m) {
    if (m.id && this.pending.has(m.id)) { const { res, rej, timer } = this.pending.get(m.id); clearTimeout(timer); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) for (const l of this.listeners) l(m.method, m.params || {});
  }
  send(method, params = {}) {
    const id = ++this.id;
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("browser protocol connection is not open"));
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new Error("browser protocol command timed out: " + method)); }, 15000);
      this.pending.set(id, { res, rej, timer });
    });
  }
  on(fn) { this.listeners.push(fn); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error("page script failed: " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text)); return r.result.value; }
  close() { this.ws.close(); }
}

async function main() {
  const browser = findBrowser();
  if (!browser) { console.error("no Chrome or Edge found"); process.exit(2); }
  const srv = await serve();
  const profile = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "lintcha-chain-"));
  const browserArgs = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-proxy-server", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`];
  if (VIEWPORT) browserArgs.push(`--window-size=${VIEWPORT.width},${VIEWPORT.height}`);
  browserArgs.push("about:blank");
  const proc = spawn(browser, browserArgs, { stdio: "ignore" });
  let version = null;
  for (let i = 0; i < 50 && !version; i++) { try { version = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); } catch (e) { await sleep(200); } }
  if (!version) { proc.kill(); srv.close(); console.error("browser did not open its protocol port"); process.exit(2); }
  const page = (await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`)).find(t => t.type === "page");
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send("Network.enable"); await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Log.enable");
  if (VIEWPORT) await cdp.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });

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

  const report = { served: DIR, origin: ORIGIN, browser: version.Browser, requested_viewport: VIEWPORT, pages: [] };
  const failed = [];
  for (const p of PAGES) {
    const r = { page: p, violations: [] };
    await cdp.send("Storage.clearDataForOrigin", { origin: ORIGIN, storageTypes: "all" });
    phase = "load"; const m0 = requests.length, c0 = consoleErrors.length;
    const onLoad = new Promise(res => { loaded = res; });
    await cdp.send("Page.navigate", { url: ORIGIN + p + (p === "/" ? RESTORED_FRAGMENT : "") });
    await onLoad; await settle();
    const loadReqs = since(m0);
    r.load = { requests: loadReqs.length, hosts: hosts(loadReqs), urls: loadReqs.map(x => x.url.replace(ORIGIN, "")), index_fetched: indexFetches(loadReqs), title: await cdp.eval("document.title") };
    r.viewport = await cdp.eval(`({ client_width: document.documentElement.clientWidth, scroll_width: document.documentElement.scrollWidth, body_scroll_width: document.body.scrollWidth })`);
    if (r.viewport.scroll_width > r.viewport.client_width || r.viewport.body_scroll_width > r.viewport.client_width) {
      r.viewport.probes = await cdp.eval(`["html","body",".topbar",".bar-in",".nav",".cluster",".strip",".page",".chart-orn",".orn"].map(function (selector) { var el = document.querySelector(selector); if (!el) return { selector: selector, missing: true }; var b = el.getBoundingClientRect(), s = getComputedStyle(el); return { selector: selector, left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width), client_width: el.clientWidth, scroll_width: el.scrollWidth, overflow_x: s.overflowX, min_width: s.minWidth, max_width: s.maxWidth }; })`);
      r.viewport.offenders = await cdp.eval(`Array.from(document.querySelectorAll("body *")).map(function (el) { var b = el.getBoundingClientRect(), s = getComputedStyle(el), p = el.parentElement; return { tag: el.tagName.toLowerCase(), id: el.id || "", class_name: typeof el.className === "string" ? el.className : "", text: (el.textContent || "").trim().slice(0, 40), parent: p && typeof p.className === "string" ? p.className : "", top: Math.round(b.top), left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width), scroll_width: el.scrollWidth, overflow_x: s.overflowX }; }).filter(function (x) { return x.right > document.documentElement.clientWidth + 1 || x.left < -1; }).slice(0, 30)`);
      r.viewport.scroll_offenders = await cdp.eval(`Array.from(document.querySelectorAll("body *")).map(function (el) { var b = el.getBoundingClientRect(), s = getComputedStyle(el); return { tag: el.tagName.toLowerCase(), id: el.id || "", class_name: typeof el.className === "string" ? el.className : "", text: (el.textContent || "").trim().slice(0, 40), top: Math.round(b.top), width: Math.round(b.width), client_width: el.clientWidth, scroll_width: el.scrollWidth, overflow_x: s.overflowX, white_space: s.whiteSpace }; }).filter(function (x) { return x.scroll_width > x.client_width + 1 && x.overflow_x === "visible"; }).slice(0, 30)`);
      r.violations.push("the document overflows its viewport horizontally: " + JSON.stringify(r.viewport));
    }
    r.storage_at_load = JSON.parse(await cdp.eval("JSON.stringify({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })"));
    const hasForm = await cdp.eval(`!!document.getElementById("launch-form")`);
    const isLive = await cdp.eval(`!!document.querySelector("[data-live-page]")`);
    const isHistory = await cdp.eval(`!!document.querySelector("[data-history-page]")`);
    const isHold = await cdp.eval(`!!document.querySelector("[data-hold-page]")`);
    if (hasForm && VIEWPORT) {
      r.viewport.hero = await cdp.eval(`(function () {
        function box(selector) {
          var el = document.querySelector(selector), b = el.getBoundingClientRect();
          return { selector: selector, left: b.left, right: b.right, client_width: el.clientWidth, scroll_width: el.scrollWidth };
        }
        return {
          text: [box(".hero-h1"), box(".hero-intro"), box(".hero-privacy")],
          actions: box(".hero-actions"),
          links: Array.from(document.querySelectorAll(".hero-actions a")).map(function (el) { var b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; })
        };
      })()`);
      const heroBoxes = [...r.viewport.hero.text, r.viewport.hero.actions];
      const heroClipped = heroBoxes.some(box => box.left < -1 || box.right > r.viewport.client_width + 1 || box.scroll_width > box.client_width + 1) ||
        r.viewport.hero.links.some(box => box.left < -1 || box.right > r.viewport.client_width + 1);
      if (heroClipped) r.violations.push("the mobile hero clips text or an action: " + JSON.stringify(r.viewport.hero));
    }
    const all = [...loadReqs];
    if (isLive) {
      r.live = {};
      const rejected = await waitFor(`document.querySelector("[data-wall-status]").textContent.includes("cannot safely display") && !document.querySelector("[data-wall-retry]").hidden`);
      r.live.bad_hash = {
        rejected,
        rows: await cdp.eval(`document.querySelectorAll("[data-wall-rows] tr").length`),
        text: await cdp.eval(`document.querySelector("[data-wall-rows]").textContent.trim()`),
        displayed_hash: await cdp.eval(`document.querySelector("[data-wall-hash]").textContent`)
      };
      if (!r.live.bad_hash.rejected || r.live.bad_hash.rows !== 1 || r.live.bad_hash.displayed_hash !== "—" || !/No rows are shown/.test(r.live.bad_hash.text)) r.violations.push("a mismatched wall hash was not withheld");

      phase = "live retry"; const m1 = requests.length;
      await cdp.eval(`document.querySelector("[data-wall-retry]").click()`);
      const verified = await waitFor(`document.querySelectorAll("[data-wall-rows] tr").length === ${LIVE_ROWS.length} && document.querySelector("[data-wall-status]").textContent.includes("verified")`);
      await settle();
      const retryReqs = since(m1);
      all.push(...retryReqs);
      r.live.verified = {
        verified,
        requests: retryReqs.filter(req => /\/api\/wall(?:\?|$)/.test(req.url)).length,
        hash: await cdp.eval(`document.querySelector("[data-wall-hash]").textContent`),
        rows: await cdp.eval(`Array.from(document.querySelectorAll("[data-wall-rows] tr")).map(function (tr) { return Array.from(tr.cells).map(function (td) { return td.textContent; }); })`),
        read_links: await cdp.eval(`Array.from(document.querySelectorAll("[data-wall-entry]")).map(function (tr) { return Array.from(tr.querySelectorAll("a.wall-read")).map(function (a) { return a.getAttribute("href"); }); })`),
        injected_elements: await cdp.eval(`document.querySelectorAll("[data-wall-rows] img, [data-wall-rows] svg, [data-wall-rows] script, [data-wall-rows] iframe").length`),
        executed: await cdp.eval(`!!window.__fragmentExecuted || !!window.__liveTickerXss`)
      };
      if (!r.live.verified.verified || r.live.verified.requests !== 1) r.violations.push("retry did not produce one verified wall read");
      if (r.live.verified.hash !== LIVE_ROWS_HASH) r.violations.push("the verified row hash was not displayed exactly");
      if (JSON.stringify(r.live.verified.rows) !== JSON.stringify(LIVE_ROWS.map(row => [row.name, row.ticker]))) r.violations.push("wall declarations did not render byte for byte as text");
      if (r.live.verified.injected_elements || r.live.verified.executed) r.violations.push("wall declaration content became executable markup");
      r.live.verified.read_links.forEach((links, rowIndex) => {
        if (links.length !== 2 || links[0] !== links[1]) {
          r.violations.push("a live declaration does not give both fields the same Read link");
          return;
        }
        try {
          const read = new URL(links[0], ORIGIN);
          const params = new URLSearchParams(read.hash.startsWith("#read=") ? read.hash.slice(6) : "");
          if (read.origin !== ORIGIN || read.pathname !== "/" || !read.hash.startsWith("#read=") ||
            [...params.keys()].sort().join(",") !== "name,ticker" || params.get("name") !== LIVE_ROWS[rowIndex].name ||
            params.get("ticker") !== LIVE_ROWS[rowIndex].ticker) {
            r.violations.push("a live Read link does not restore its exact name and ticker locally");
          }
        } catch (e) { r.violations.push("a live declaration produced no valid Read link"); }
      });

      phase = "live local filter"; const mf = requests.length;
      await cdp.eval(`(function () { var input = document.querySelector("[data-wall-search]"); input.value = "ampersand"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await settle();
      const filteredRows = await cdp.eval(`Array.from(document.querySelectorAll("[data-wall-entry]:not([hidden])")).map(function (tr) { return Array.from(tr.cells).map(function (td) { return td.textContent; }); })`);
      const orderedRows = await cdp.eval(`Array.from(document.querySelectorAll("[data-wall-entry]")).map(function (tr) { return Array.from(tr.cells).map(function (td) { return td.textContent; }); })`);
      await cdp.eval(`(function () { var input = document.querySelector("[data-wall-search]"); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      const filterReqs = since(mf);
      all.push(...filterReqs);
      r.live.filter = {
        requests: filterReqs.filter(req => /\/api\/wall(?:\?|$)/.test(req.url)).length,
        rows: filteredRows,
        order: orderedRows,
        cleared_rows: await cdp.eval(`document.querySelectorAll("[data-wall-entry]:not([hidden])").length`),
        state: await cdp.eval(`document.querySelector("[data-wall-filter-state]").textContent`)
      };
      if (r.live.filter.requests || JSON.stringify(r.live.filter.rows) !== JSON.stringify([LIVE_ROWS.map(row => [row.name, row.ticker])[1]]) ||
        JSON.stringify(r.live.filter.order) !== JSON.stringify(LIVE_ROWS.map(row => [row.name, row.ticker])) || r.live.filter.cleared_rows !== LIVE_ROWS.length) {
        r.violations.push("the local wall filter requested, reordered, lost or failed to restore rows");
      }

      phase = "live paused"; const mp = requests.length;
      await cdp.eval(`document.querySelector("[data-wall-pause]").click()`);
      const pausedState = await cdp.eval(`({ pressed: document.querySelector("[data-wall-pause]").getAttribute("aria-pressed"), label: document.querySelector("[data-wall-pause]").textContent, status: document.querySelector("[data-wall-status]").textContent })`);
      await sleep(12700);
      const pausedReqs = since(mp);
      all.push(...pausedReqs);
      r.live.paused = { requests: pausedReqs.filter(req => /\/api\/wall(?:\?|$)/.test(req.url)).length, ...pausedState };
      if (r.live.paused.requests || r.live.paused.pressed !== "true" || r.live.paused.label !== "Resume live updates" || !/no request is being made/.test(r.live.paused.status)) r.violations.push("pause did not stop polling and expose its state");

      phase = "live resumed"; const mr = requests.length;
      await cdp.eval(`document.querySelector("[data-wall-pause]").click()`);
      const resumed = await waitFor(`document.querySelector("[data-wall-pause]").getAttribute("aria-pressed") === "false" && document.querySelector("[data-wall-status]").textContent.includes("verified") && document.querySelector("[data-wall-hash]").textContent === "${LIVE_ROWS_HASH}"`);
      await settle();
      const resumedReqs = since(mr);
      all.push(...resumedReqs);
      r.live.resumed = {
        resumed,
        requests: resumedReqs.filter(req => /\/api\/wall(?:\?|$)/.test(req.url)).length,
        urls: resumedReqs.filter(req => /\/api\/wall(?:\?|$)/.test(req.url)).map(req => req.url)
      };
      if (!r.live.resumed.resumed || r.live.resumed.requests !== 1 || r.live.resumed.urls[0] !== ORIGIN + "/api/wall") r.violations.push("resume did not make exactly one immediate newest-page read");

      phase = "live earlier page"; const mh = requests.length;
      await cdp.eval(`document.querySelector("[data-wall-older]").click()`);
      const earlier = await waitFor(`document.querySelectorAll("[data-wall-entry]").length === ${HISTORY_ROWS.length} && document.querySelector("[data-wall-status]").textContent.startsWith("Earlier page verified")`);
      await settle();
      const historyReqs = since(mh);
      all.push(...historyReqs);
      r.live.history = {
        earlier,
        requests: historyReqs.filter(req => /\/api\/wall(?:\?|$)/.test(req.url)).length,
        urls: historyReqs.filter(req => /\/api\/wall(?:\?|$)/.test(req.url)).map(req => req.url),
        rows: await cdp.eval(`Array.from(document.querySelectorAll("[data-wall-entry]")).map(function (tr) { return Array.from(tr.cells).map(function (td) { return td.textContent; }); })`),
        hash: await cdp.eval(`document.querySelector("[data-wall-hash]").textContent`),
        pressed: await cdp.eval(`document.querySelector("[data-wall-pause]").getAttribute("aria-pressed")`)
      };
      if (!r.live.history.earlier || r.live.history.requests !== 1 || r.live.history.urls[0] !== ORIGIN + "/api/wall?before=" + encodeURIComponent(LIVE_OLDER_CURSOR) ||
        JSON.stringify(r.live.history.rows) !== JSON.stringify(HISTORY_ROWS.map(row => [row.name, row.ticker])) ||
        r.live.history.hash !== HISTORY_ROWS_HASH || r.live.history.pressed !== "true") {
        r.violations.push("the earlier control did not replace the page with one verified, paused history read");
      }

      phase = "live return newest"; const mn = requests.length;
      await cdp.eval(`document.querySelector("[data-wall-pause]").click()`);
      const returnedNewest = await waitFor(`document.querySelectorAll("[data-wall-entry]").length === ${LIVE_ROWS.length} && document.querySelector("[data-wall-status]").textContent.includes("Newest page verified") && document.querySelector("[data-wall-pause]").getAttribute("aria-pressed") === "false"`);
      await settle();
      const newestReqs = since(mn);
      all.push(...newestReqs);
      r.live.history_return = {
        returned: returnedNewest,
        requests: newestReqs.filter(req => /\/api\/wall(?:\?|$)/.test(req.url)).length,
        urls: newestReqs.filter(req => /\/api\/wall(?:\?|$)/.test(req.url)).map(req => req.url)
      };
      if (!r.live.history_return.returned || r.live.history_return.requests !== 1 || r.live.history_return.urls[0] !== ORIGIN + "/api/wall") r.violations.push("resuming from history did not request and restore the newest page");
      const controlReqs = [...filterReqs, ...pausedReqs, ...resumedReqs, ...historyReqs, ...newestReqs];
      r.controls = { requests: controlReqs.length, hosts: hosts(controlReqs) };
    } else if (isHistory) {
      r.history = {};
      const historyAtLoad = loadReqs.filter(req => /\/api\/deployer(?:\?|$)/.test(req.url)).length;
      r.history.at_load = historyAtLoad;
      phase = "history invalid query"; const mi = requests.length;
      await cdp.eval(`(function () { var input = document.querySelector("[data-history-address]"); input.value = "not-an-address"; document.querySelector("[data-history-form]").requestSubmit(); })()`);
      await settle();
      const invalidReqs = since(mi);
      all.push(...invalidReqs);
      r.history.invalid = {
        requests: invalidReqs.filter(req => /\/api\/deployer(?:\?|$)/.test(req.url)).length,
        status: await cdp.eval(`document.querySelector("[data-history-status]").textContent`)
      };
      if (historyAtLoad || r.history.invalid.requests || !/refused that address query/.test(r.history.invalid.status)) r.violations.push("history read before explicit valid submission");

      phase = "history bad hash"; const mb = requests.length;
      await cdp.eval(`(function () { var input = document.querySelector("[data-history-address]"); input.value = "${DEPLOYER_ADDRESS}"; document.querySelector("[data-history-form]").requestSubmit(); })()`);
      const rejected = await waitFor(`document.querySelector("[data-history-status]").textContent.includes("cannot safely display")`);
      await settle();
      const badReqs = since(mb);
      all.push(...badReqs);
      r.history.bad_hash = {
        rejected,
        requests: badReqs.filter(req => /\/api\/deployer(?:\?|$)/.test(req.url)).length,
        result_hidden: await cdp.eval(`document.querySelector("[data-history-result]").hidden`),
        table_hidden: await cdp.eval(`document.querySelector("[data-history-table-section]").hidden`),
        displayed_hash: await cdp.eval(`document.querySelector("[data-history-hash]").textContent`)
      };
      if (!r.history.bad_hash.rejected || r.history.bad_hash.requests !== 1 || !r.history.bad_hash.result_hidden || !r.history.bad_hash.table_hidden || r.history.bad_hash.displayed_hash !== "—") r.violations.push("a mismatched deployer-history hash was not withheld");

      phase = "history verified"; const mv = requests.length;
      await cdp.eval(`document.querySelector("[data-history-form]").requestSubmit()`);
      const verified = await waitFor(`document.querySelectorAll("[data-history-entry]").length === ${DEPLOYER_ROWS.length} && document.querySelector("[data-history-status]").textContent.includes("verified")`);
      await settle();
      const verifiedReqs = since(mv);
      all.push(...verifiedReqs);
      r.history.verified = {
        verified,
        requests: verifiedReqs.filter(req => /\/api\/deployer(?:\?|$)/.test(req.url)).length,
        urls: verifiedReqs.filter(req => /\/api\/deployer(?:\?|$)/.test(req.url)).map(req => req.url),
        hash: await cdp.eval(`document.querySelector("[data-history-hash]").textContent`),
        rows: await cdp.eval(`Array.from(document.querySelectorAll("[data-history-entry]")).map(function (tr) { return Array.from(tr.cells).map(function (td) { return td.textContent; }); })`),
        read_links: await cdp.eval(`Array.from(document.querySelectorAll("[data-history-entry]")).map(function (tr) { return Array.from(tr.querySelectorAll("a.wall-read")).map(function (a) { return a.getAttribute("href"); }); })`),
        injected_elements: await cdp.eval(`document.querySelectorAll("[data-history-rows] img, [data-history-rows] svg, [data-history-rows] script, [data-history-rows] iframe").length`),
        executed: await cdp.eval(`!!window.__fragmentExecuted || !!window.__liveTickerXss`)
      };
      const expectedHistoryCells = DEPLOYER_ROWS.map(row => [row.block.toLocaleString("en"), row.date, row.name, row.ticker]);
      if (!r.history.verified.verified || r.history.verified.requests !== 1 || r.history.verified.urls[0] !== ORIGIN + "/api/deployer?address=" + DEPLOYER_ADDRESS) r.violations.push("explicit history submit did not make exactly one encoded same-origin read");
      if (r.history.verified.hash !== DEPLOYER_ROWS_HASH || JSON.stringify(r.history.verified.rows) !== JSON.stringify(expectedHistoryCells)) r.violations.push("verified history rows or hash changed before display");
      if (r.history.verified.injected_elements || r.history.verified.executed) r.violations.push("history declaration content became executable markup");
      r.history.verified.read_links.forEach((links, rowIndex) => {
        if (links.length !== 2 || links[0] !== links[1]) { r.violations.push("a history row does not give both declarations the same Read link"); return; }
        try {
          const read = new URL(links[0], ORIGIN), params = new URLSearchParams(read.hash.startsWith("#read=") ? read.hash.slice(6) : "");
          if (read.origin !== ORIGIN || read.pathname !== "/" || [...params.keys()].sort().join(",") !== "name,ticker" || params.get("name") !== DEPLOYER_ROWS[rowIndex].name || params.get("ticker") !== DEPLOYER_ROWS[rowIndex].ticker) r.violations.push("a history Read link does not restore its exact declarations locally");
        } catch (e) { r.violations.push("a history row produced no valid Read link"); }
      });

      phase = "history local filter"; const mf = requests.length;
      await cdp.eval(`(function () { var input = document.querySelector("[data-history-filter]"); input.value = "ampersand"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      await settle();
      const filteredRows = await cdp.eval(`Array.from(document.querySelectorAll("[data-history-entry]:not([hidden])")).map(function (tr) { return Array.from(tr.cells).map(function (td) { return td.textContent; }); })`);
      const orderedRows = await cdp.eval(`Array.from(document.querySelectorAll("[data-history-entry]")).map(function (tr) { return Array.from(tr.cells).map(function (td) { return td.textContent; }); })`);
      await cdp.eval(`(function () { var input = document.querySelector("[data-history-filter]"); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      const filterReqs = since(mf);
      all.push(...filterReqs);
      r.history.filter = { requests: filterReqs.length, rows: filteredRows, order: orderedRows, cleared_rows: await cdp.eval(`document.querySelectorAll("[data-history-entry]:not([hidden])").length`) };
      if (r.history.filter.requests || JSON.stringify(r.history.filter.rows) !== JSON.stringify([expectedHistoryCells[1]]) || JSON.stringify(r.history.filter.order) !== JSON.stringify(expectedHistoryCells) || r.history.filter.cleared_rows !== DEPLOYER_ROWS.length) r.violations.push("the local history filter requested, reordered, lost or failed to restore rows");
      r.controls = { requests: invalidReqs.length + badReqs.length + verifiedReqs.length + filterReqs.length, hosts: hosts([...invalidReqs, ...badReqs, ...verifiedReqs, ...filterReqs]) };
    } else if (hasForm) {
      r.restored = await cdp.eval(`(function(){ var f = document.getElementById("launch-form"), n = document.querySelector("[data-share-restored]"); return { name: f.elements.name.value, ticker: f.elements.ticker.value, notice: n && !n.hidden ? n.textContent : "", fragment_executed: !!window.__fragmentExecuted || !!window.__liveTickerXss }; })()`);
      if (r.restored.name !== RESTORED_INPUT.name || r.restored.ticker !== RESTORED_INPUT.ticker) r.violations.push("the shared fragment did not restore its fields exactly");
      if (!r.restored.notice) r.violations.push("the shared fragment restored silently");
      if (r.restored.fragment_executed) r.violations.push("fragment field content executed as markup");
      if (loadReqs.some(req => req.url.includes("#read="))) r.violations.push("the shared fragment reached an HTTP request");
      phase = "altered index"; const mx = requests.length;
      await cdp.eval(`(function(){ var f = document.getElementById("launch-form"); var v = ${JSON.stringify(INPUT)}; Object.keys(v).forEach(function (k) { f.elements[k].value = v[k]; }); f.requestSubmit(); return true; })()`);
      const badIndexRejected = await waitFor(`!document.getElementById("launch-state").hidden && document.getElementById("launch-state").textContent.includes("could not be fetched") && document.getElementById("launch-read").disabled === false`);
      await settle();
      const badIndexReqs = since(mx);
      all.push(...badIndexReqs);
      r.bad_index = {
        rejected: badIndexRejected,
        requests: badIndexReqs.length,
        index_fetched: indexFetches(badIndexReqs),
        results_hidden: await cdp.eval(`document.getElementById("launch-results").hidden`),
        tools_hidden: await cdp.eval(`document.querySelector("[data-result-tools]").hidden`)
      };
      if (!r.bad_index.rejected || r.bad_index.requests !== 1 || r.bad_index.index_fetched !== 1 || !r.bad_index.results_hidden || !r.bad_index.tools_hidden) r.violations.push("altered but valid index bytes produced a reading or receipt context");
      // the full browser run: retry the exact index, read again from memory, export context, clear and toggle
      phase = "first read"; const m1 = requests.length;
      await cdp.eval(`(function(){ var f = document.getElementById("launch-form"); var v = ${JSON.stringify(INPUT)}; Object.keys(v).forEach(function (k) { f.elements[k].value = v[k]; }); f.requestSubmit(); return true; })()`);
      const rendered = await waitFor(`!document.getElementById("launch-results").hidden || (!document.getElementById("launch-state").hidden && document.getElementById("launch-read").disabled === false)`);
      await settle();
      const firstReqs = since(m1);
      r.first_read = { rendered, requests: firstReqs.length, urls: firstReqs.map(x => x.url.replace(ORIGIN, "")), hosts: hosts(firstReqs), index_fetched: indexFetches(firstReqs), state: await cdp.eval(`document.getElementById("launch-state").hidden ? "" : document.getElementById("launch-state").textContent`), groups: await cdp.eval(`Array.from(document.querySelectorAll("#launch-results h3")).map(function (h) { return h.textContent; })`), lines: await cdp.eval(rowsText) };
      phase = "fact receipt"; const mr = requests.length;
      await cdp.eval(`(function () { var field = document.getElementById("launch-form").elements.ticker; field.value = "edited after read"; field.dispatchEvent(new Event("input", { bubbles: true })); })()`);
      const captured = await cdp.eval(`(async function () {
        window.__receiptText = null;
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: function (value) { window.__receiptText = String(value); return Promise.resolve(); } } });
        document.querySelector("[data-copy-receipt]").click();
        for (var i = 0; i < 50 && typeof window.__receiptText !== "string"; i++) await new Promise(function (resolve) { setTimeout(resolve, 20); });
        var tools = document.querySelector("[data-result-tools]"), results = document.getElementById("launch-results");
        return {
          text: window.__receiptText,
          language: document.documentElement.getAttribute("lang") || "",
          snapshot: { from_block: Number(tools.getAttribute("data-window-from")), to_block: Number(tools.getAttribute("data-window-to")), from_time: tools.getAttribute("data-window-start"), to_time: tools.getAttribute("data-window-end"), index_sha256: tools.getAttribute("data-index-hash") },
          result: Array.from(results.querySelectorAll(".launch-group")).map(function (group) { return { heading: (group.querySelector("h3") || {}).textContent || "", checks: Array.from(group.querySelectorAll(".launch-row")).map(function (row) { return { check: (row.querySelector(".launch-check") || {}).textContent || "", lines: Array.from(row.querySelectorAll(".launch-line")).map(function (line) { var field = line.querySelector(".launch-field"); return { field: field ? field.textContent : null, text: line.textContent || "" }; }) }; }) }; })
        };
      })()`);
      const download = await cdp.eval(`(async function () {
        var made = null, revoked = null, filename = null, oldClick = HTMLAnchorElement.prototype.click;
        window.URL.createObjectURL = function (blob) { made = blob; return "blob:lintcha-receipt-test"; };
        window.URL.revokeObjectURL = function (url) { revoked = url; };
        HTMLAnchorElement.prototype.click = function () { filename = this.download; };
        document.querySelector("[data-download-receipt]").click();
        await new Promise(function (resolve) { setTimeout(resolve, 50); });
        HTMLAnchorElement.prototype.click = oldClick;
        return { filename: filename, text: made ? await made.text() : null, revoked: revoked };
      })()`);
      await settle();
      const receiptReqs = since(mr);
      all.push(...receiptReqs);
      let receipt = null; try { receipt = JSON.parse(captured.text); } catch (e) {}
      r.receipt = { copied: !!receipt, downloaded: download.filename, requests: receiptReqs.length, schema: receipt && receipt.schema, snapshot: receipt && receipt.snapshot, input: receipt && receipt.input };
      if (receiptReqs.length) r.violations.push("fact receipt controls made " + receiptReqs.length + " request(s)");
      if (!receipt || Object.keys(receipt).join(",") !== "schema,source,language,snapshot,input,result" || receipt.schema !== "lintcha-chain/fact-receipt/v1" || receipt.source !== ORIGIN + "/" || receipt.language !== captured.language || JSON.stringify(receipt.snapshot) !== JSON.stringify(captured.snapshot) || JSON.stringify(receipt.input) !== JSON.stringify(INPUT) || JSON.stringify(receipt.result) !== JSON.stringify(captured.result)) r.violations.push("copied fact receipt does not reproduce the exact input, rendered result and shipped snapshot context");
      if (download.filename !== "lintcha-chain-fact-receipt.json" || download.text !== captured.text || download.revoked !== "blob:lintcha-receipt-test") r.violations.push("downloaded fact receipt differs from the copied receipt or leaves its object URL active");
      phase = "share"; const ms = requests.length;
      await cdp.eval(`document.querySelector("[data-share-result]").click()`); await settle();
      const shareReqs = since(ms);
      r.result_context = await cdp.eval(`(function(){ var tools = document.querySelector("[data-result-tools]"), button = document.querySelector("[data-share-result]"); return { hidden: tools.hidden, age: document.querySelector("[data-window-age]").textContent, share_url: button.getAttribute("data-share-url") || "", index_hash: tools.getAttribute("data-index-hash"), requests: ${shareReqs.length} }; })()`);
      all.push(...shareReqs);
      if (r.result_context.hidden || !r.result_context.age.trim()) r.violations.push("the result does not carry its snapshot age");
      if (shareReqs.length) r.violations.push("sharing made " + shareReqs.length + " request(s)");
      try {
        const shared = new URL(r.result_context.share_url), params = new URLSearchParams(shared.hash.slice(6));
        if (shared.origin !== ORIGIN || !shared.hash.startsWith("#read=") || params.get("ticker") !== INPUT.ticker || params.get("index") !== r.result_context.index_hash) r.violations.push("the share link does not reproduce the fields and snapshot locally");
      } catch (e) { r.violations.push("the share control produced no valid link"); }
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
      r.controls = { requests: ctrlReqs.length, hosts: hosts(ctrlReqs), results_hidden: await cdp.eval(`document.getElementById("launch-results").hidden`), result_tools_hidden: await cdp.eval(`document.querySelector("[data-result-tools]").hidden`), theme_before: themeBefore, theme_after: await cdp.eval(`document.documentElement.getAttribute("data-theme")`) };
      all.push(...firstReqs, ...secondReqs, ...ctrlReqs);
      if (!r.first_read.rendered) r.violations.push("first read rendered nothing");
      if (r.first_read.index_fetched !== 1) r.violations.push("first read fetched the index " + r.first_read.index_fetched + " times");
      if (r.first_read.requests !== r.first_read.index_fetched) r.violations.push("first read made a request other than the index");
      if (r.second_read.requests) r.violations.push("second read made " + r.second_read.requests + " request(s)");
      if (r.controls.requests) r.violations.push("clear or theme made " + r.controls.requests + " request(s)");
      if (!r.controls.result_tools_hidden) r.violations.push("clear left the result context visible");
      if (r.controls.theme_before === r.controls.theme_after) r.violations.push("the theme toggle did not change the theme");
    } else if (isHold) {
      const pageUrl = new URL(p, ORIGIN), marks = pageUrl.searchParams.getAll("t");
      const validMark = marks.length === 1 && marks[0] === HOLD_MARK;
      r.hold = await cdp.eval(`({ sentence: document.querySelector("[data-sentence]").textContent, state: document.querySelector("[data-state]").textContent, connect_disabled: document.querySelector("[data-connect]").disabled, sign_disabled: document.querySelector("[data-sign]").disabled })`);
      phase = "holder connect without wallet"; const mh = requests.length;
      if (validMark) await cdp.eval(`document.querySelector("[data-connect]").click()`);
      await settle();
      const holdReqs = since(mh);
      all.push(...holdReqs);
      r.hold.valid_mark = validMark;
      r.hold.after = await cdp.eval(`({ state: document.querySelector("[data-state]").textContent, connect_disabled: document.querySelector("[data-connect]").disabled, sign_disabled: document.querySelector("[data-sign]").disabled })`);
      r.hold.requests = holdReqs.length;
      r.controls = { requests: holdReqs.length, hosts: hosts(holdReqs) };
      if (validMark) {
        if (r.hold.sentence !== HOLD_SENTENCE || r.hold.connect_disabled || !r.hold.sign_disabled) r.violations.push("a valid holder link did not render the exact bounded sentence and initial button state");
        if (r.hold.requests || !/cannot see a wallet/.test(r.hold.after.state) || r.hold.after.connect_disabled || !r.hold.after.sign_disabled) r.violations.push("connect without an injected wallet requested data or enabled signing");
      } else if (r.hold.sentence || !r.hold.connect_disabled || !r.hold.sign_disabled || !/missing its one time mark/.test(r.hold.state) || r.hold.requests) {
        r.violations.push("an invalid holder link did not fail closed without a request");
      }
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
    if ((isLive || isHistory || isHold) && r.storage.local.length) r.violations.push("the observer or holder page wrote localStorage: " + JSON.stringify(r.storage.local));
    if (r.console_errors.length) r.violations.push("console: " + r.console_errors.map(e => e.text).join(" / "));
    report.pages.push(r);
    if (r.violations.length) failed.push(p);
    console.log(`page ${p}  (${r.load.title})`);
    console.log(`  viewport: ${r.viewport.client_width}px client, ${r.viewport.scroll_width}px document, ${r.viewport.body_scroll_width}px body`);
    console.log(`  load: ${r.load.requests} requests, hosts ${JSON.stringify(r.load.hosts)}, launch-index.json at load: ${r.load.index_fetched ? "yes" : "no"}`);
    console.log(`  load: ${r.load.urls.join(" ")}`);
    if (r.live) {
      console.log(`  bad hash: withheld ${r.live.bad_hash.rejected}, displayed hash ${JSON.stringify(r.live.bad_hash.displayed_hash)}`);
      console.log(`  retry: ${r.live.verified.requests} wall request(s), ${r.live.verified.rows.length} inert rows, hash ${r.live.verified.hash.slice(0, 16)}`);
      console.log(`  local filter: ${r.live.filter.requests} wall request(s), ${r.live.filter.rows.length} matching row(s), original order preserved`);
      console.log(`  pause: ${r.live.paused.requests} wall request(s) across 12.7 seconds; resume: ${r.live.resumed.requests} immediate wall request(s)`);
      console.log(`  earlier: ${r.live.history.requests} cursor request(s), ${r.live.history.rows.length} row(s); return newest: ${r.live.history_return.requests} request(s)`);
    } else if (r.history) {
      console.log(`  history: load ${r.history.at_load} request(s), invalid ${r.history.invalid.requests}, bad hash withheld ${r.history.bad_hash.rejected}, verified ${r.history.verified.requests}`);
      console.log(`  history rows: ${r.history.verified.rows.length} inert row(s), local filter ${r.history.filter.requests} request(s), hash ${r.history.verified.hash.slice(0, 16)}`);
    } else if (r.hold) {
      console.log(`  holder: valid mark ${r.hold.valid_mark}, connect/sign disabled ${r.hold.after.connect_disabled}/${r.hold.after.sign_disabled}, action requests ${r.hold.requests}`);
    } else if (r.first_read) {
      console.log(`  altered index: rejected ${r.bad_index.rejected}, ${r.bad_index.index_fetched} index request(s), results hidden ${r.bad_index.results_hidden}`);
      console.log(`  first read: ${r.first_read.requests} request(s) ${JSON.stringify(r.first_read.urls)}, index fetched ${r.first_read.index_fetched} time(s), ${r.first_read.lines.length} rows in ${r.first_read.groups.length} groups`);
      for (const l of r.first_read.lines) console.log(`    ${l}`);
      console.log(`  second read: ${r.second_read.requests} request(s); ${r.second_read.lines[0] || ""}`);
      console.log(`  result context: age ${JSON.stringify(r.result_context.age)}, share requests ${r.result_context.requests}, receipt requests ${r.receipt.requests}, fragment restored ${JSON.stringify(r.restored.ticker)}`);
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
