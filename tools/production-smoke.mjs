// Read-only production smoke for chain.lintcha.com. The target and probes are fixed deliberately: this tool
// never reads credentials, never follows a redirect, and its only POST bodies are the inert two-byte JSON object
// used to prove that every public route rejects a write before reaching stateful work.
//
// Every fetch and body read shares a per-request deadline, the whole run has a deadline and request ceiling, and
// static bytes are bounded both per file and in aggregate. Response bodies are used only for comparison/shape
// checks; neither this module nor its CLI puts them (or fetch exception text) in a report.
//   node tools/production-smoke.mjs
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PRODUCTION_ORIGIN = "https://chain.lintcha.com";
export const PRODUCTION_HTTP_ORIGIN = "http://chain.lintcha.com";
export const NOT_FOUND_PATH = "/__lintcha_production_smoke_missing__";

export const SMOKE_LIMITS = Object.freeze({
  requests: 160,
  requestBodyBytes: 2,
  responseBodyBytes: 4 * 1024 * 1024,
  apiBodyBytes: 4 * 1024 * 1024,
  staticFiles: 128,
  staticTotalBytes: 8 * 1024 * 1024,
  staticDepth: 8,
  requestTimeoutMs: 15_000,
  runTimeoutMs: 120_000
});

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_RUN_TIMEOUT_MS = 90_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const defaultSiteDir = path.resolve(here, "..", "site");
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HISTORY_ADDRESS = "0x" + "1".repeat(40);
const REDIRECT_PATHS = Object.freeze(["/", "/hold/", "/api/tail"]);
const STATIC_CONTENT_TYPES = Object.freeze({
  ".bin": "application/octet-stream",
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".xml": "application/xml"
});
const REQUIRED_STATIC_HEADERS = Object.freeze([
  "content-security-policy",
  "cross-origin-opener-policy",
  "permissions-policy",
  "referrer-policy",
  "x-content-type-options"
]);
const TAIL_NAMESPACES = Object.freeze([
  "link", "logo", "recipient", "description", "ticker", "name", "ticker_skeleton", "name_skeleton"
]);
const TAIL_SUCCESS_KEYS = Object.freeze([
  "ok", "tail_version", "engine", "watcher_started_block", "watcher_started_at", "coverage_from_block",
  "from_block", "to_block", "watcher_to_block", "current_watcher_to_block", "page", "page_limit",
  "previous_page_commitment", "page_commitment", "more", "next_cursor", "collected_at", "depth_days",
  "snapshot_to_block", "gap_blocks", "launches_in_tail", "launches_in_page", "entries", "hash", "rows_hash",
  "tables", "launches"
]);
const WALL_SUCCESS_KEYS = Object.freeze([
  "ok", "snapshot_to_block", "gap_blocks", "watcher_to_block", "read_at", "page_limit", "mode",
  "older_cursor", "live_cursor", "rows_hash", "view_hash", "rows"
]);
const HISTORY_SUCCESS_KEYS = Object.freeze([
  "ok", "address", "from_block", "to_block", "read_at", "launches_seen", "page_limit", "truncated",
  "rows_hash", "rows"
]);
const WALL_FAILURES = new Set([
  "snapshot", "watcher", "stale", "behind", "backlog", "snapshot_regressed", "unreadable", "backfill",
  "migrating", "state_changed", "no_watcher", "no_wall", "rate_limited"
]);
const HISTORY_FAILURES = new Set([
  "not_started", "stale", "backlog", "watcher", "unreadable", "backfill", "migrating", "state_changed",
  "no_watcher", "no_history", "rate_limited"
]);
const PUBLIC_APIS = Object.freeze([
  { name: "tail", path: "/api/tail", statuses: [200, 429, 503] },
  { name: "wall", path: "/api/wall", statuses: [200, 429, 503] },
  {
    name: "deployer",
    path: "/api/deployer?address=" + HISTORY_ADDRESS,
    statuses: [200, 429, 503]
  }
]);

class SmokeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = code => { throw new SmokeFailure(code); };
const positiveBound = (value, ceiling, code) => {
  if (!Number.isInteger(value) || value < 1 || value > ceiling) fail(code);
  return value;
};
const posix = value => value.split(path.sep).join("/");
const routePath = relative => "/" + relative.split("/").map(encodeURIComponent).join("/");
const sameBytes = (left, right) => left.byteLength === right.byteLength &&
  Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(Buffer.from(right.buffer, right.byteOffset, right.byteLength));
const plainObject = value => !!value && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const exactKeys = (value, keys) => plainObject(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
const whole = value => Number.isSafeInteger(value) && value >= 0;
const positiveWhole = value => Number.isSafeInteger(value) && value > 0;
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const shortDigest = value => value === null || (typeof value === "string" && /^[0-9a-f]{16}$/.test(value));
const cursor = value => value === null || (typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value));
const tailCursor = value => value === null ||
  (typeof value === "string" && /^[A-Za-z0-9_-]{1,448}\.[0-9a-f]{64}$/.test(value));
const isoTime = value => {
  if (typeof value !== "string") return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
};
const calendarDate = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(value + "T00:00:00.000Z");
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
};
const safePublicText = value => typeof value === "string" && value.length > 0 && value.length <= 200 &&
  !!value.trim() && !/\p{C}/u.test(value);
const sha256Text = value => createHash("sha256").update(value).digest("hex");
const sha256Json = value => sha256Text(JSON.stringify(value));

function localFileStat(absolute) {
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch { fail("static_manifest_unreadable"); }
  if (stat.isSymbolicLink()) fail("static_symlink_refused");
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) fail("static_entry_refused");
  return stat;
}

function readLocalFileAtSize(absolute, expected) {
  let bytes;
  try { bytes = fs.readFileSync(absolute); }
  catch { fail("static_manifest_unreadable"); }
  if (bytes.byteLength !== expected) fail("static_file_changed");
  return bytes;
}

function canonicalRoute(relative) {
  if (relative === "_headers") return null;
  if (relative === "404.html") return NOT_FOUND_PATH;
  if (relative === "index.html") return "/";
  if (relative.endsWith("/index.html")) return routePath(relative.slice(0, -"index.html".length));
  if (relative.endsWith(".html")) return routePath(relative.slice(0, -".html".length));
  return routePath(relative);
}

/** The owned global _headers block is the deployment header source of truth. */
function loadStaticHeaderContract(siteDir) {
  const absolute = path.join(path.resolve(siteDir), "_headers");
  const stat = localFileStat(absolute);
  if (stat.size > SMOKE_LIMITS.responseBodyBytes) fail("static_headers_too_large");
  let text;
  try { text = decoder.decode(readLocalFileAtSize(absolute, stat.size)); }
  catch (error) {
    if (error instanceof SmokeFailure) throw error;
    fail("static_headers_unreadable");
  }
  let global = false, blocks = 0;
  const headers = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) {
      global = line.trim() === "/*";
      if (global) blocks++;
      continue;
    }
    if (!global) continue;
    const match = /^\s+([!#$%&'*+.^_`|~0-9A-Za-z-]+):\s*(\S(?:.*\S)?)\s*$/.exec(line);
    if (!match) fail("static_headers_invalid");
    const name = match[1].toLowerCase();
    if (headers.has(name) || name === "set-cookie" || name === "nel" || name === "report-to" || name === "reporting-endpoints") {
      fail("static_headers_invalid");
    }
    headers.set(name, match[2]);
  }
  if (blocks !== 1 || REQUIRED_STATIC_HEADERS.some(name => !headers.has(name))) fail("static_headers_incomplete");
  return headers;
}

/** Read the local publication once and map HTML to the URLs Workers Assets treats as canonical. */
export function loadStaticManifest(siteDir = defaultSiteDir) {
  const root = path.resolve(siteDir);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > SMOKE_LIMITS.staticDepth) fail("static_depth_limit");
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { fail("static_manifest_unreadable"); }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.isSymbolicLink()) fail("static_symlink_refused");
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else if (entry.isFile()) {
        found.push({ absolute, relative: posix(path.relative(root, absolute)) });
        if (found.length > SMOKE_LIMITS.staticFiles) fail("static_file_limit");
      } else fail("static_entry_refused");
    }
  };
  walk(root, 0);

  const files = [];
  let total = 0;
  for (const item of found.sort((a, b) => a.relative.localeCompare(b.relative, "en"))) {
    const stat = localFileStat(item.absolute);
    if (stat.size > SMOKE_LIMITS.responseBodyBytes) fail("static_file_too_large");
    total += stat.size;
    if (total > SMOKE_LIMITS.staticTotalBytes) fail("static_total_limit");
    const bytes = readLocalFileAtSize(item.absolute, stat.size);
    const route = canonicalRoute(item.relative);
    if (route !== null) {
      const contentType = STATIC_CONTENT_TYPES[path.posix.extname(item.relative).toLowerCase()];
      if (!contentType) fail("static_content_type_unknown");
      files.push({ relative: item.relative, route, bytes, contentType });
    }
  }

  if (!files.some(file => file.relative === "index.html")) fail("static_root_missing");
  if (!files.some(file => file.relative === "404.html")) fail("static_404_missing");
  const routes = new Set();
  for (const file of files) {
    if (routes.has(file.route)) fail("static_route_collision");
    routes.add(file.route);
  }
  return files;
}

function abortable(value, signal) {
  if (signal.aborted) return Promise.reject(new SmokeFailure("request_timeout"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new SmokeFailure("request_timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      result => { signal.removeEventListener("abort", onAbort); resolve(result); },
      () => {
        signal.removeEventListener("abort", onAbort);
        reject(new SmokeFailure(signal.aborted ? "request_timeout" : "request_failed"));
      }
    );
  });
}

function cancelBestEffort(reader) {
  try {
    const cancelled = reader && reader.cancel();
    if (cancelled && typeof cancelled.catch === "function") cancelled.catch(() => {});
  } catch {}
}

function declaredLength(headers) {
  const value = headers.get("content-length");
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) fail("invalid_content_length");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) fail("invalid_content_length");
  return number;
}

async function readBoundedBody(response, limit, declaredLimit, signal, ignoreDeclaredLength) {
  const declared = declaredLength(response.headers);
  if (!ignoreDeclaredLength && declared !== null && declared > declaredLimit) fail("body_too_large");
  if (response.body === null || response.body === undefined) return new Uint8Array(0);

  if (typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const part = await abortable(reader.read(), signal);
        if (!part || typeof part.done !== "boolean") fail("invalid_response_body");
        if (part.done) break;
        if (!ArrayBuffer.isView(part.value)) fail("invalid_response_body");
        const chunk = new Uint8Array(part.value.buffer, part.value.byteOffset, part.value.byteLength);
        if (size + chunk.byteLength > limit) {
          cancelBestEffort(reader);
          fail("body_too_large");
        }
        chunks.push(Uint8Array.from(chunk));
        size += chunk.byteLength;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    } catch (error) {
      cancelBestEffort(reader);
      throw error;
    }
  }

  if (typeof response.arrayBuffer !== "function") fail("invalid_response_body");
  const buffer = await abortable(response.arrayBuffer(), signal);
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > limit) fail("body_too_large");
  return new Uint8Array(buffer);
}

async function boundedRequest(context, url, init, bodyLimit, ignoreDeclaredLength = false, declaredLimit = bodyLimit) {
  if (context.requestCount >= SMOKE_LIMITS.requests) fail("request_limit");
  const remaining = context.deadline - Date.now();
  if (remaining <= 0) fail("run_timeout");
  const requestTimeout = Math.min(context.requestTimeoutMs, remaining);
  const method = String(init.method || "GET").toUpperCase();
  if (!new Set(["GET", "HEAD", "POST"]).has(method)) fail("unsafe_method_refused");
  const requestBody = init.body === undefined || init.body === null ? new Uint8Array(0) :
    typeof init.body === "string" ? encoder.encode(init.body) : init.body;
  if (!ArrayBuffer.isView(requestBody) || requestBody.byteLength > SMOKE_LIMITS.requestBodyBytes) fail("request_body_limit");

  context.requestCount++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout);
  let response;
  try {
    let pending;
    try {
      pending = context.fetchImpl(url, {
        ...init,
        method,
        signal: controller.signal,
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store"
      });
    } catch {
      fail("request_failed");
    }
    response = await abortable(pending, controller.signal);
    if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599 ||
        !response.headers || typeof response.headers.get !== "function") fail("invalid_response");
    context.responseCount++;
    if (response.headers.get("nel") !== null || response.headers.get("report-to") !== null ||
        response.headers.get("reporting-endpoints") !== null) context.reportingHeaders++;
    if (response.headers.get("set-cookie") !== null) context.cookieHeaders++;
    const bytes = await readBoundedBody(response, bodyLimit, declaredLimit, controller.signal, ignoreDeclaredLength);
    return { status: response.status, headers: response.headers, bytes };
  } catch (error) {
    if (error instanceof SmokeFailure) throw error;
    fail(controller.signal.aborted ? "request_timeout" : "request_failed");
  } finally {
    clearTimeout(timer);
  }
}

const jsonObject = bytes => {
  try {
    const value = JSON.parse(decoder.decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
};
const isPlaceholderEcho = value => !!value && value.ok === true && value.from === "api-worker" && typeof value.path === "string";
const jsonContentType = headers => String(headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase() === "application/json";
const contentTypeOf = headers => String(headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
const successfulPublicHeaders = headers => jsonContentType(headers) &&
  /^public,\s*max-age=(?:0|[1-9][0-9]*)$/i.test(String(headers.get("cache-control") || "").trim()) &&
  headers.get("access-control-allow-origin") === "*";
const closedPublicHeaders = headers => jsonContentType(headers) &&
  String(headers.get("cache-control") || "").trim().toLowerCase() === "no-store";

function validTailRow(row) {
  if (!exactKeys(row, ["block", "date", "hashes"]) || !whole(row.block) || !calendarDate(row.date) ||
      !exactKeys(row.hashes, TAIL_NAMESPACES) || !Array.isArray(row.hashes.link) || row.hashes.link.length !== 5 ||
      !row.hashes.link.every(shortDigest)) return false;
  return TAIL_NAMESPACES.filter(name => name !== "link").every(name => shortDigest(row.hashes[name]));
}

function validTailTables(tables, entries) {
  if (!exactKeys(tables, TAIL_NAMESPACES) || !exactKeys(entries, TAIL_NAMESPACES)) return false;
  for (const namespace of TAIL_NAMESPACES) {
    const table = tables[namespace];
    if (!plainObject(table) || !whole(entries[namespace]) || Object.keys(table).length !== entries[namespace]) return false;
    for (const [hash, entry] of Object.entries(table)) {
      const skeleton = namespace.endsWith("_skeleton");
      const keys = skeleton ? ["n", "first", "d", "v"] : ["n", "first", "d"];
      if (!/^[0-9a-f]{16}$/.test(hash) || !exactKeys(entry, keys) || !positiveWhole(entry.n) || !positiveWhole(entry.d) ||
          entry.d > entry.n || !calendarDate(entry.first) || (skeleton && (!positiveWhole(entry.v) || entry.v > entry.n))) return false;
    }
  }
  return true;
}

// The Watch hashes a canonical table serialization rather than relying on object insertion order. Rebuild those
// exact bytes here so a production response cannot pair well-shaped tables with an unrelated artifact hash.
function tailTableHash(tables) {
  const namespaces = TAIL_NAMESPACES.map(namespace => {
    const rows = Object.keys(tables[namespace]).sort().map(hash => {
      const entry = tables[namespace][hash];
      const fields = [`"n":${entry.n}`, `"first":${JSON.stringify(entry.first)}`, `"d":${entry.d}`];
      if (namespace.endsWith("_skeleton")) fields.push(`"v":${entry.v}`);
      return `${JSON.stringify(hash)}:{${fields.join(",")}}`;
    });
    return `${JSON.stringify(namespace)}:{${rows.join(",")}}`;
  });
  return sha256Text(`{${namespaces.join(",")}}`);
}

function tailPageHash(value) {
  return sha256Json({
    v: value.tail_version,
    s: value.snapshot_to_block,
    b: value.watcher_started_block,
    e: value.watcher_started_at,
    c: value.coverage_from_block,
    f: value.from_block,
    t: value.to_block,
    u: value.watcher_to_block,
    p: value.page,
    q: value.previous_page_commitment,
    n: value.launches_in_tail,
    z: value.launches_in_page,
    h: value.hash,
    r: value.rows_hash
  });
}

function validVisibleTailTallies(value) {
  const visible = Object.fromEntries(TAIL_NAMESPACES.map(namespace => [namespace, new Map()]));
  const add = (namespace, hash, date, spelling = null) => {
    if (hash === null) return;
    const prior = visible[namespace].get(hash) || { n: 0, first: date, spellings: new Set() };
    prior.n++;
    if (date < prior.first) prior.first = date;
    if (spelling !== null) prior.spellings.add(spelling);
    visible[namespace].set(hash, prior);
  };
  for (const row of value.launches) {
    for (const hash of row.hashes.link) add("link", hash, row.date);
    for (const namespace of ["logo", "recipient", "description", "ticker", "name"]) {
      add(namespace, row.hashes[namespace], row.date);
    }
    add("ticker_skeleton", row.hashes.ticker_skeleton, row.date, row.hashes.ticker);
    add("name_skeleton", row.hashes.name_skeleton, row.date, row.hashes.name);
  }
  for (const namespace of TAIL_NAMESPACES) {
    const table = value.tables[namespace];
    if (Object.keys(table).length !== visible[namespace].size) return false;
    for (const [hash, counted] of visible[namespace]) {
      const entry = table[hash];
      if (!entry || entry.n !== counted.n || entry.first !== counted.first ||
          (namespace.endsWith("_skeleton") && entry.v !== counted.spellings.size)) return false;
    }
  }
  return true;
}

function validTailSuccess(value) {
  if (!exactKeys(value, TAIL_SUCCESS_KEYS) || value.ok !== true || value.tail_version !== 1 ||
      value.engine !== "site/launch.js" || !whole(value.watcher_started_block) || !whole(value.watcher_started_at) ||
      !whole(value.coverage_from_block) || !whole(value.from_block) || !whole(value.to_block) ||
      !whole(value.watcher_to_block) || !whole(value.current_watcher_to_block) || !positiveWhole(value.page) ||
      !positiveWhole(value.page_limit) || value.page_limit !== 1000 ||
      !(value.previous_page_commitment === null || digest(value.previous_page_commitment)) || !digest(value.page_commitment) ||
      typeof value.more !== "boolean" || !tailCursor(value.next_cursor) || !isoTime(value.collected_at) ||
      !positiveWhole(value.depth_days) || !(value.snapshot_to_block === null || whole(value.snapshot_to_block)) ||
      !(value.gap_blocks === null || whole(value.gap_blocks)) || !whole(value.launches_in_tail) ||
      !whole(value.launches_in_page) || !digest(value.hash) || !digest(value.rows_hash) || !Array.isArray(value.launches)) return false;
  if (!validTailTables(value.tables, value.entries) || value.hash !== tailTableHash(value.tables) ||
      value.page_commitment !== tailPageHash(value) || value.launches.length !== value.launches_in_page ||
      value.launches_in_page > value.page_limit || value.launches_in_tail < value.launches_in_page ||
      !value.launches.every(validTailRow) || !validVisibleTailTallies(value) ||
      value.rows_hash !== sha256Json(value.launches)) return false;
  if (value.coverage_from_block <= value.watcher_started_block || value.from_block !== value.coverage_from_block ||
      value.from_block > value.to_block + 1 || value.to_block > value.watcher_to_block ||
      value.watcher_to_block !== value.current_watcher_to_block || value.page !== 1 ||
      value.previous_page_commitment !== null ||
      value.launches.some((row, index) => row.block < value.from_block || row.block > value.to_block ||
        (index > 0 && row.block < value.launches[index - 1].block))) return false;
  if (value.snapshot_to_block === null ? value.gap_blocks !== null :
      value.gap_blocks !== Math.max(0, value.coverage_from_block - 1 - value.snapshot_to_block)) return false;
  if (value.more !== (value.to_block < value.watcher_to_block)) return false;
  return value.more
    ? typeof value.next_cursor === "string" && value.launches_in_page > 0 &&
      value.launches_in_tail > value.page_limit && value.launches_in_tail > value.launches_in_page
    : value.next_cursor === null && value.launches_in_tail === value.launches_in_page;
}

function validWallSuccess(value) {
  if (!exactKeys(value, WALL_SUCCESS_KEYS) || value.ok !== true || !whole(value.snapshot_to_block) ||
      !whole(value.gap_blocks) || !whole(value.watcher_to_block) || value.watcher_to_block < value.snapshot_to_block ||
      !isoTime(value.read_at) || !positiveWhole(value.page_limit) || value.page_limit > 1000 || value.mode !== "latest" ||
      !cursor(value.older_cursor) || !cursor(value.live_cursor) || value.live_cursor === null || !digest(value.rows_hash) ||
      !digest(value.view_hash) || !Array.isArray(value.rows) || value.rows.length > value.page_limit) return false;
  if (!value.rows.every(row => exactKeys(row, ["name", "ticker"]) && safePublicText(row.name) && safePublicText(row.ticker))) return false;
  const rowsHash = sha256Json(value.rows);
  return value.rows_hash === rowsHash && value.view_hash === rowsHash;
}

function validHistorySuccess(value) {
  if (!exactKeys(value, HISTORY_SUCCESS_KEYS) || value.ok !== true || value.address !== HISTORY_ADDRESS ||
      !whole(value.from_block) || !whole(value.to_block) || value.from_block > value.to_block + 1 || !isoTime(value.read_at) ||
      !whole(value.launches_seen) || !positiveWhole(value.page_limit) || value.page_limit > 1000 ||
      typeof value.truncated !== "boolean" || !digest(value.rows_hash) || !Array.isArray(value.rows) ||
      value.rows.length > value.page_limit) return false;
  let previous = null;
  for (const row of value.rows) {
    if (!exactKeys(row, ["block", "log_index", "date", "name", "ticker"]) || !whole(row.block) || !whole(row.log_index) ||
        !calendarDate(row.date) || !(row.name === null || safePublicText(row.name)) ||
        !(row.ticker === null || safePublicText(row.ticker)) || row.block < value.from_block || row.block > value.to_block ||
        (previous && (previous.block > row.block || (previous.block === row.block && previous.log_index >= row.log_index)))) return false;
    previous = row;
  }
  if (value.rows_hash !== sha256Json(value.rows)) return false;
  return value.truncated
    ? value.rows.length === value.page_limit && value.launches_seen > value.rows.length
    : value.launches_seen === value.rows.length;
}

function validApiFailure(api, value) {
  if (api.name === "tail" && exactKeys(value, ["ok", "why", "block", "page_limit"])) {
    return value.ok === false && value.why === "capacity" && whole(value.block) && value.page_limit === 1000;
  }
  if (!exactKeys(value, ["ok", "why"]) || value.ok !== false || typeof value.why !== "string") return false;
  if (api.name === "tail") return value.why === "unreadable" || value.why === "state_changed";
  return (api.name === "wall" ? WALL_FAILURES : HISTORY_FAILURES).has(value.why);
}

function validApiSuccess(api, value) {
  if (api.name === "tail") return validTailSuccess(value);
  if (api.name === "wall") return validWallSuccess(value);
  return validHistorySuccess(value);
}

function publicGetProblem(response, api) {
  if (!api.statuses.includes(response.status)) return "unexpected_status";
  const value = response.bytes.byteLength ? jsonObject(response.bytes) : null;
  if (isPlaceholderEcho(value)) return "placeholder_echo";
  if (response.status === 200) {
    if (!successfulPublicHeaders(response.headers)) return "missing_public_api_headers";
    return validApiSuccess(api, value) ? null : "invalid_public_success";
  }
  if (response.bytes.byteLength === 0 && response.status === 429) return null;
  if (!closedPublicHeaders(response.headers) || !validApiFailure(api, value)) return "non_fail_closed_error";
  return null;
}

function publicHeadProblem(response, api) {
  if (!api.statuses.includes(response.status)) return "unexpected_status";
  if (response.bytes.byteLength !== 0) return "head_returned_body";
  if (response.status === 200 && !successfulPublicHeaders(response.headers)) return "missing_public_api_headers";
  if (response.status !== 200 && response.status !== 429 && !closedPublicHeaders(response.headers)) return "missing_closed_api_headers";
  return null;
}

const baseHeaders = accept => ({ accept });
const fixedEmptyStatus = wanted => response => response.status !== wanted
  ? "unexpected_status"
  : response.bytes.byteLength === 0 ? null : "unexpected_body";
const staticBytes = (wantedStatus, file, expectedHeaders) => response => {
  if (response.status !== wantedStatus) return "unexpected_status";
  if (!sameBytes(response.bytes, file.bytes)) return "body_mismatch";
  if (contentTypeOf(response.headers) !== file.contentType) return "wrong_content_type";
  if (!/^public,\s*max-age=(?:0|[1-9][0-9]*)(?:,\s*must-revalidate)?$/i.test(String(response.headers.get("cache-control") || "").trim())) {
    return "invalid_static_cache_control";
  }
  for (const [name, value] of expectedHeaders) {
    if (response.headers.get(name) !== value) return "security_headers_mismatch";
  }
  return null;
};

/** Run the fixed smoke plan. fetchImpl is injectable solely so the complete network contract can be tested offline. */
export async function runProductionSmoke({
  fetchImpl = globalThis.fetch,
  siteDir = defaultSiteDir,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS
} = {}) {
  const report = { ok: false, requestCount: 0, plannedRequests: 0, checks: [], failures: [] };
  const add = (name, reason = null) => report.checks.push({ name, ok: reason === null, ...(reason === null ? {} : { reason }) });
  if (typeof fetchImpl !== "function") {
    add("configuration", "fetch_unavailable");
    report.failures = report.checks.filter(check => !check.ok);
    return report;
  }

  try {
    positiveBound(requestTimeoutMs, SMOKE_LIMITS.requestTimeoutMs, "invalid_request_timeout");
    positiveBound(runTimeoutMs, SMOKE_LIMITS.runTimeoutMs, "invalid_run_timeout");
  } catch (error) {
    add("configuration", error instanceof SmokeFailure ? error.code : "invalid_configuration");
    report.failures = report.checks.filter(check => !check.ok);
    return report;
  }

  let staticFiles, staticHeaders;
  try {
    staticHeaders = loadStaticHeaderContract(siteDir);
    staticFiles = loadStaticManifest(siteDir);
    add("local static manifest");
  } catch (error) {
    add("local static manifest", error instanceof SmokeFailure ? error.code : "static_manifest_unreadable");
    report.failures = report.checks.filter(check => !check.ok);
    return report;
  }

  const fixed = [
    ["GET telegram is method-closed", "/api/telegram", { method: "GET", headers: baseHeaders("application/json") }, 405],
    ["GET hold is method-closed", "/api/hold", { method: "GET", headers: baseHeaders("application/json") }, 405],
    ["unknown API is closed", "/api/__lintcha_production_smoke_unknown__", { method: "GET", headers: baseHeaders("application/json") }, 404],
    ["unauthenticated telegram POST is closed", "/api/telegram", {
      method: "POST", headers: { ...baseHeaders("application/json"), "content-type": "application/json" }, body: "{}"
    }, 401],
    ["no-Origin JSON holder POST is closed", "/api/hold", {
      method: "POST", headers: { ...baseHeaders("application/json"), "content-type": "application/json" }, body: "{}"
    }, 403],
    ...PUBLIC_APIS.map(api => [`public POST ${api.name} is method-closed`, api.path, {
      method: "POST", headers: { ...baseHeaders("application/json"), "content-type": "application/json" }, body: "{}"
    }, 405])
  ];

  // Representative root, nested and API redirects; one request per static representation; exact fail-closed
  // route probes; and GET+HEAD for every public API. The equality is checked again at the end.
  report.plannedRequests = REDIRECT_PATHS.length + staticFiles.length + fixed.length + PUBLIC_APIS.length * 2;
  if (report.plannedRequests > SMOKE_LIMITS.requests) {
    add("request plan", "request_limit");
    report.failures = report.checks.filter(check => !check.ok);
    return report;
  }

  const context = {
    fetchImpl,
    requestTimeoutMs,
    deadline: Date.now() + runTimeoutMs,
    requestCount: 0,
    responseCount: 0,
    reportingHeaders: 0,
    cookieHeaders: 0
  };
  const probe = async (name, url, init, bodyLimit, validator, ignoreDeclaredLength = false, declaredLimit = bodyLimit) => {
    try {
      const response = await boundedRequest(context, url, init, bodyLimit, ignoreDeclaredLength, declaredLimit);
      add(name, validator(response));
    } catch (error) {
      add(name, error instanceof SmokeFailure ? error.code : "request_failed");
    }
  };

  for (const route of REDIRECT_PATHS) {
    const httpUrl = PRODUCTION_HTTP_ORIGIN + route;
    const httpsUrl = PRODUCTION_ORIGIN + route;
    await probe(`HTTP redirects ${route} to exact HTTPS URL`, httpUrl, {
      method: "HEAD", headers: baseHeaders("*/*")
    }, 0, response => {
      if (response.status !== 301 && response.status !== 308) return "unexpected_status";
      const location = response.headers.get("location");
      if (!location) return "missing_location";
      try { return new URL(location, httpUrl).href === httpsUrl ? null : "wrong_redirect_target"; }
      catch { return "wrong_redirect_target"; }
    }, true);
  }

  for (const file of staticFiles) {
    const is404 = file.relative === "404.html";
    await probe(`static ${file.relative}`, PRODUCTION_ORIGIN + file.route, {
      method: "GET", headers: baseHeaders("*/*")
    }, file.bytes.byteLength, staticBytes(is404 ? 404 : 200, file, staticHeaders), false, SMOKE_LIMITS.responseBodyBytes);
  }

  for (const [name, route, init, status] of fixed) {
    await probe(name, PRODUCTION_ORIGIN + route, init, SMOKE_LIMITS.apiBodyBytes, fixedEmptyStatus(status));
  }

  for (const api of PUBLIC_APIS) {
    await probe(`public GET ${api.name}`, PRODUCTION_ORIGIN + api.path, {
      method: "GET", headers: baseHeaders("application/json")
    }, SMOKE_LIMITS.apiBodyBytes, response => publicGetProblem(response, api));
    await probe(`public HEAD ${api.name}`, PRODUCTION_ORIGIN + api.path, {
      method: "HEAD", headers: baseHeaders("application/json")
    }, 0, response => publicHeadProblem(response, api), true);
  }

  report.requestCount = context.requestCount;
  add("request plan completed", context.requestCount === report.plannedRequests ? null : "incomplete_request_plan");
  add("browser reporting headers are absent", context.responseCount === report.plannedRequests
    ? context.reportingHeaders === 0 ? null : "forbidden_reporting_headers"
    : "incomplete_header_audit");
  add("Set-Cookie is absent", context.responseCount === report.plannedRequests
    ? context.cookieHeaders === 0 ? null : "forbidden_cookie_header"
    : "incomplete_header_audit");
  report.failures = report.checks.filter(check => !check.ok);
  report.ok = report.failures.length === 0;
  return report;
}

export function formatProductionSmoke(report) {
  const lines = [`production smoke: ${report.requestCount}/${report.plannedRequests} requests, ${report.checks.length} checks, ${report.failures.length} failure(s)`];
  for (const problem of report.failures) lines.push(`  FAIL ${problem.name}: ${problem.reason}`);
  return lines.join("\n");
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  if (process.argv.length !== 2) {
    console.error("usage: node tools/production-smoke.mjs");
    process.exitCode = 2;
  } else {
    const report = await runProductionSmoke();
    console.log(formatProductionSmoke(report));
    process.exitCode = report.ok ? 0 : 1;
  }
}
