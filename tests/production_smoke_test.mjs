// Offline contract for tools/production-smoke.mjs. A fully injected fetch supplies every production response;
// no request leaves this process, and the fixture records the exact safe request plan for inspection.
//   node tests/production_smoke_test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  NOT_FOUND_PATH,
  PRODUCTION_ORIGIN,
  SMOKE_LIMITS,
  formatProductionSmoke,
  runProductionSmoke
} from "../tools/production-smoke.mjs";
import { tallyHash } from "../bot/src/tally.js";
import { tailPageCommitment } from "../bot/src/watch.js";

let checks = 0, failures = 0;
const ok = (value, label) => { checks++; if (!value) { failures++; console.log("  FAIL " + label); } };
const failed = (report, name, reason) => report.failures.some(item => item.name === name && item.reason === reason);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lintcha-production-smoke-"));
const site = path.join(tmp, "site");
const sha = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const DIGEST = "a".repeat(64);
const TAIL_NAMESPACES = ["link", "logo", "recipient", "description", "ticker", "name", "ticker_skeleton", "name_skeleton"];
const STATIC_HEADERS = {
  "content-security-policy": "default-src 'self'",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff"
};
const PUBLIC_HEADERS = {
  "content-type": "application/json",
  "cache-control": "public, max-age=5",
  "access-control-allow-origin": "*"
};
const EMPTY_TABLES = Object.fromEntries(TAIL_NAMESPACES.map(name => [name, {}]));
const EMPTY_ENTRIES = Object.fromEntries(TAIL_NAMESPACES.map(name => [name, 0]));
const pageHash = value => tailPageCommitment({
  snapshot: value.snapshot_to_block,
  started: value.watcher_started_block,
  startedAt: value.watcher_started_at,
  coverageFrom: value.coverage_from_block,
  from: value.from_block,
  to: value.to_block,
  upper: value.watcher_to_block,
  page: value.page,
  previous: value.previous_page_commitment,
  total: value.launches_in_tail,
  count: value.launches_in_page,
  tableHash: value.hash,
  rowsHash: value.rows_hash
});
const tailBase = {
  ok: true,
  tail_version: 1,
  engine: "site/launch.js",
  watcher_started_block: 1,
  watcher_started_at: 1,
  coverage_from_block: 2,
  from_block: 2,
  to_block: 2,
  watcher_to_block: 2,
  current_watcher_to_block: 2,
  page: 1,
  page_limit: 1000,
  previous_page_commitment: null,
  more: false,
  next_cursor: null,
  collected_at: "2026-09-11T00:00:00.000Z",
  depth_days: 7,
  snapshot_to_block: null,
  gap_blocks: null,
  launches_in_tail: 0,
  launches_in_page: 0,
  entries: EMPTY_ENTRIES,
  hash: await tallyHash(EMPTY_TABLES),
  rows_hash: sha([]),
  tables: EMPTY_TABLES,
  launches: []
};
const tailBody = { ...tailBase, page_commitment: await pageHash(tailBase) };
const emptyHashes = {
  link: [null, null, null, null, null], logo: null, recipient: null, description: null,
  ticker: null, name: null, ticker_skeleton: null, name_skeleton: null
};
const pagedLaunches = Array.from({ length: tailBody.page_limit }, (_, index) => ({
  block: tailBody.coverage_from_block + index,
  date: "2026-09-11",
  hashes: emptyHashes
}));
const pagedTailBase = {
  ...tailBody,
  to_block: tailBody.coverage_from_block + pagedLaunches.length - 1,
  watcher_to_block: tailBody.coverage_from_block + pagedLaunches.length,
  current_watcher_to_block: tailBody.coverage_from_block + pagedLaunches.length,
  more: true,
  next_cursor: null,
  launches_in_tail: pagedLaunches.length + 1,
  launches_in_page: pagedLaunches.length,
  rows_hash: sha(pagedLaunches),
  launches: pagedLaunches
};
const pagedCommitment = await pageHash(pagedTailBase);
const pagedCursorPayload = {
  v: 1,
  s: null,
  b: pagedTailBase.watcher_started_block,
  e: pagedTailBase.watcher_started_at,
  c: pagedTailBase.coverage_from_block,
  u: pagedTailBase.watcher_to_block,
  n: pagedTailBase.to_block + 1,
  p: 2,
  h: pagedCommitment
};
const pagedTailBody = {
  ...pagedTailBase,
  page_commitment: pagedCommitment,
  next_cursor: Buffer.from(JSON.stringify(pagedCursorPayload)).toString("base64url") + "." + DIGEST
};
const tailWith = async changes => {
  const value = { ...tailBody, ...changes };
  return { ...value, page_commitment: await pageHash(value) };
};
const laterTailBody = await tailWith({ page: 2, previous_page_commitment: DIGEST });
const wrongTableHashBody = await tailWith({ hash: DIGEST });
const orphanHashLaunches = [{
  block: tailBody.from_block,
  date: "2026-09-11",
  hashes: { ...emptyHashes, ticker: "b".repeat(16) }
}];
const orphanHashBody = await tailWith({
  launches_in_tail: orphanHashLaunches.length,
  launches_in_page: orphanHashLaunches.length,
  rows_hash: sha(orphanHashLaunches),
  launches: orphanHashLaunches
});
const wallBody = {
  ok: true,
  snapshot_to_block: 1,
  gap_blocks: 0,
  watcher_to_block: 2,
  read_at: "2026-09-11T00:00:00.000Z",
  page_limit: 200,
  mode: "latest",
  older_cursor: null,
  live_cursor: "live_cursor",
  rows_hash: sha([]),
  view_hash: sha([]),
  rows: []
};
const historyBody = {
  ok: true,
  address: "0x1111111111111111111111111111111111111111",
  from_block: 2,
  to_block: 2,
  read_at: "2026-09-11T00:00:00.000Z",
  launches_seen: 0,
  page_limit: 200,
  truncated: false,
  rows_hash: sha([]),
  rows: []
};
const API_BODIES = { tail: tailBody, wall: wallBody, deployer: historyBody };
const bytes = {
  root: Buffer.from("<!doctype html><title>root</title>\n"),
  missing: Buffer.from("<!doctype html><title>missing</title>\n"),
  live: Buffer.from("<!doctype html><title>live</title>\n"),
  script: Buffer.from("live();\n"),
  binary: Buffer.from([0, 1, 2, 127, 128, 255])
};
fs.mkdirSync(path.join(site, "live"), { recursive: true });
fs.writeFileSync(path.join(site, "_headers"), `/*
  Content-Security-Policy: ${STATIC_HEADERS["content-security-policy"]}
  X-Content-Type-Options: ${STATIC_HEADERS["x-content-type-options"]}
  Referrer-Policy: ${STATIC_HEADERS["referrer-policy"]}
  Permissions-Policy: ${STATIC_HEADERS["permissions-policy"]}
  Cross-Origin-Opener-Policy: ${STATIC_HEADERS["cross-origin-opener-policy"]}
`);
fs.writeFileSync(path.join(site, "index.html"), bytes.root);
fs.writeFileSync(path.join(site, "404.html"), bytes.missing);
fs.writeFileSync(path.join(site, "live", "index.html"), bytes.live);
fs.writeFileSync(path.join(site, "app.js"), bytes.script);
fs.writeFileSync(path.join(site, "asset.bin"), bytes.binary);

const served = (status, body, contentType) => ({
  status,
  body,
  headers: { ...STATIC_HEADERS, "cache-control": "public, max-age=0, must-revalidate", "content-type": contentType }
});
const staticByPath = new Map([
  ["/", served(200, bytes.root, "text/html")],
  [NOT_FOUND_PATH, served(404, bytes.missing, "text/html")],
  ["/live/", served(200, bytes.live, "text/html")],
  ["/app.js", served(200, bytes.script, "text/javascript")],
  ["/asset.bin", served(200, bytes.binary, "application/octet-stream")]
]);

function responseSpec(url, init) {
  const method = String(init.method || "GET").toUpperCase();
  if (url.protocol === "http:") return {
    key: "http:" + url.pathname, status: 308, body: null, headers: { location: PRODUCTION_ORIGIN + url.pathname + url.search }
  };
  if (staticByPath.has(url.pathname)) return {
    key: "static:" + url.pathname,
    ...staticByPath.get(url.pathname),
    headers: { ...staticByPath.get(url.pathname).headers, "content-length": String(staticByPath.get(url.pathname).body.byteLength) }
  };
  if (url.pathname === "/api/telegram") return {
    key: "api:telegram:" + method, status: method === "GET" ? 405 : 401, body: null, headers: {}
  };
  if (url.pathname === "/api/hold") return {
    key: "api:hold:" + method, status: method === "GET" ? 405 : 403, body: null, headers: {}
  };
  if (url.pathname === "/api/__lintcha_production_smoke_unknown__") return {
    key: "api:unknown:GET", status: 404, body: null, headers: {}
  };
  const api = url.pathname.slice("/api/".length);
  if (["tail", "wall", "deployer"].includes(api)) {
    if (method === "POST") return { key: `public:${api}:POST`, status: 405, body: null, headers: {} };
    const body = method === "HEAD" ? null : JSON.stringify(API_BODIES[api]);
    return {
      key: `public:${api}:${method}`,
      status: 200,
      body,
      headers: PUBLIC_HEADERS
    };
  }
  throw new Error("offline fixture has no route");
}

function fixtureNetwork(mutate = () => null) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { url, init, headers: new Headers(init.headers || {}) };
    calls.push(call);
    const original = responseSpec(url, init);
    const change = mutate({ ...original, url, init, call }) || {};
    if (change.hang) return await new Promise(() => {});
    if (change.throw) throw change.throw;
    if (change.response) return change.response;
    const spec = {
      ...original,
      ...change,
      headers: change.replaceHeaders ? { ...(change.headers || {}) } : { ...original.headers, ...(change.headers || {}) }
    };
    return new Response(spec.body, { status: spec.status, headers: spec.headers });
  };
  return { fetch, calls };
}

async function run(mutate, options = {}) {
  const network = fixtureNetwork(mutate);
  const report = await runProductionSmoke({ fetchImpl: network.fetch, siteDir: site, ...options });
  return { report, calls: network.calls };
}

try {
  const healthy = await run();
  ok(healthy.report.ok, "the complete offline production contract passes");
  ok(healthy.report.requestCount === 22 && healthy.report.plannedRequests === 22, "the request plan is fixed and complete");
  ok(healthy.report.checks.length === 26, "the healthy check count is deterministic");
  const paths = healthy.calls.map(call => call.url.pathname);
  ok(paths.includes("/") && paths.includes("/live/") && paths.includes(NOT_FOUND_PATH), "root, nested HTML and 404 use their canonical public routes");
  ok(!paths.includes("/index.html") && !paths.includes("/live/index.html") && !paths.includes("/404.html") && !paths.includes("/_headers"), "noncanonical HTML and deployment metadata are never requested");
  ok(paths.includes("/app.js") && paths.includes("/asset.bin"), "text and binary static assets are compared");
  ok(["/", "/hold/", "/api/tail"].every(route => healthy.calls.some(call =>
    call.url.protocol === "http:" && call.url.pathname === route && call.init.method === "HEAD")), "root, nested and API HTTP paths must preserve their exact HTTPS target");
  ok(["tail", "wall", "deployer"].every(route => ["GET", "HEAD", "POST"].every(method =>
    healthy.calls.some(call => call.url.pathname === "/api/" + route && call.init.method === method))), "each public API is probed with reads and one inert refused write");
  const posts = healthy.calls.filter(call => call.init.method === "POST");
  ok(posts.length === 5 && posts.every(call => call.init.body === "{}"), "the only POSTs carry the fixed inert two-byte body");
  ok(posts.every(call => !call.headers.has("origin") && !call.headers.has("authorization") && !call.headers.has("x-telegram-bot-api-secret-token")), "the probes carry no origin, authorization or Telegram secret");
  ok(healthy.calls.every(call => call.init.redirect === "manual" && call.init.credentials === "omit" && call.init.signal instanceof AbortSignal), "every request is credentialless, manual-redirect and abortable");
  ok(formatProductionSmoke(healthy.report) === "production smoke: 22/22 requests, 26 checks, 0 failure(s)", "healthy CLI output is one deterministic body-free summary");

  const wrongRedirect = await run(({ key }) => key === "http:/" ? { status: 200, body: null, replaceHeaders: true } : null);
  ok(failed(wrongRedirect.report, "HTTP redirects / to exact HTTPS URL", "unexpected_status"), "plain HTTP service fails the redirect check");
  const wrongTarget = await run(({ key }) => key === "http:/api/tail" ? { headers: { location: "https://other.example/api/tail" } } : null);
  ok(failed(wrongTarget.report, "HTTP redirects /api/tail to exact HTTPS URL", "wrong_redirect_target"), "an API redirect to another host is refused");

  const nelSecret = "https://collector.invalid/private-nel";
  const nelReporting = await run(({ key }) => key === "static:/" ? {
    headers: { nel: JSON.stringify({ report_to: nelSecret }) }
  } : null);
  const reportSecret = "https://collector.invalid/private-report-to";
  const reportToReporting = await run(({ key }) => key === "static:/" ? {
    headers: { "report-to": reportSecret }
  } : null);
  const endpointSecret = "https://collector.invalid/private-reporting-endpoint";
  const endpointReporting = await run(({ key }) => key === "static:/" ? {
    headers: { "reporting-endpoints": `default="${endpointSecret}"` }
  } : null);
  ok(failed(nelReporting.report, "browser reporting headers are absent", "forbidden_reporting_headers"), "NEL fails the aggregate header audit");
  ok(failed(reportToReporting.report, "browser reporting headers are absent", "forbidden_reporting_headers"), "Report-To fails the aggregate header audit");
  ok(failed(endpointReporting.report, "browser reporting headers are absent", "forbidden_reporting_headers"), "Reporting-Endpoints fails the aggregate header audit");
  const reportingOutput = formatProductionSmoke(nelReporting.report) + formatProductionSmoke(reportToReporting.report) + formatProductionSmoke(endpointReporting.report);
  ok(!reportingOutput.includes(nelSecret) && !reportingOutput.includes(reportSecret) && !reportingOutput.includes("report_to"), "reporting header values never enter output");
  ok(!reportingOutput.includes(endpointSecret), "Reporting-Endpoints values never enter output");
  const cookie = await run(({ key }) => key === "static:/" ? { headers: { "set-cookie": "private=value" } } : null);
  ok(failed(cookie.report, "Set-Cookie is absent", "forbidden_cookie_header") && !formatProductionSmoke(cookie.report).includes("private=value"), "an unexpected cookie fails without entering output");

  const weakHeaders = await run(({ key }) => key === "static:/app.js" ? {
    headers: { "content-security-policy": "default-src *" }
  } : null);
  ok(failed(weakHeaders.report, "static app.js", "security_headers_mismatch"), "every static response must carry the exact owned security headers");
  const wrongMime = await run(({ key }) => key === "static:/app.js" ? { headers: { "content-type": "text/plain" } } : null);
  ok(failed(wrongMime.report, "static app.js", "wrong_content_type"), "a wrong executable MIME type is refused");
  const privateCache = await run(({ key }) => key === "static:/app.js" ? { headers: { "cache-control": "private, no-store" } } : null);
  ok(failed(privateCache.report, "static app.js", "invalid_static_cache_control"), "static publication cannot silently become private or no-store");

  const wrongStaticBody = Buffer.alloc(bytes.script.byteLength, 0x78);
  const drift = await run(({ key }) => key === "static:/app.js" ? {
    body: wrongStaticBody, headers: { "content-length": String(wrongStaticBody.byteLength) }
  } : null);
  ok(failed(drift.report, "static app.js", "body_mismatch"), "same-length static byte drift is detected");
  const declaredLarge = await run(({ key }) => key === "static:/app.js" ? {
    body: null, headers: { "content-length": String(SMOKE_LIMITS.responseBodyBytes + 1) }
  } : null);
  ok(failed(declaredLarge.report, "static app.js", "body_too_large"), "an oversized declared body is refused before comparison");
  const streamedLarge = await run(({ key }) => key === "static:/app.js" ? {
    body: Buffer.alloc(bytes.script.byteLength + 1), replaceHeaders: true, headers: {}
  } : null);
  ok(failed(streamedLarge.report, "static app.js", "body_too_large"), "an oversized streamed body is refused without relying on Content-Length");
  const bad404 = await run(({ key }) => key === "static:" + NOT_FOUND_PATH ? { status: 200 } : null);
  ok(failed(bad404.report, "static 404.html", "unexpected_status"), "the canonical missing path must retain status 404");

  for (const [key, name] of [
    ["api:telegram:GET", "GET telegram is method-closed"],
    ["api:hold:GET", "GET hold is method-closed"],
    ["api:unknown:GET", "unknown API is closed"],
    ["api:telegram:POST", "unauthenticated telegram POST is closed"],
    ["api:hold:POST", "no-Origin JSON holder POST is closed"],
    ["public:tail:POST", "public POST tail is method-closed"],
    ["public:wall:POST", "public POST wall is method-closed"],
    ["public:deployer:POST", "public POST deployer is method-closed"]
  ]) {
    const open = await run(item => item.key === key ? { status: 200 } : null);
    ok(failed(open.report, name, "unexpected_status"), name + " rejects an accidental success");
  }
  const bodyOnRefusal = await run(({ key }) => key === "api:telegram:GET" ? { body: "not empty" } : null);
  ok(failed(bodyOnRefusal.report, "GET telegram is method-closed", "unexpected_body"), "a fixed method refusal cannot carry a body");

  const placeholder = await run(({ key }) => key === "public:tail:GET" ? {
    body: JSON.stringify({ ok: true, from: "api-worker", path: "/api/tail" })
  } : null);
  ok(failed(placeholder.report, "public GET tail", "placeholder_echo"), "a public GET cannot pass with the old placeholder echo");
  const placeholderHead = await run(({ key }) => key === "public:tail:HEAD" ? {
    status: 200, body: null, replaceHeaders: true, headers: { "content-type": "application/json" }
  } : null);
  ok(failed(placeholderHead.report, "public HEAD tail", "missing_public_api_headers"), "a placeholder-like HEAD without the public cache/CORS contract is refused");
  const genericSuccess = await run(({ key }) => key === "public:tail:GET" ? {
    body: JSON.stringify({ ok: true })
  } : null);
  ok(failed(genericSuccess.report, "public GET tail", "invalid_public_success"), "a generic success cannot impersonate the exact tail schema");
  const pagedTail = await run(({ key }) => key === "public:tail:GET" ? {
    body: JSON.stringify(pagedTailBody)
  } : null);
  ok(pagedTail.report.ok, "a coherent bounded first page and signed tail cursor pass when more rows remain");
  const laterTailPage = await run(({ key }) => key === "public:tail:GET" ? {
    body: JSON.stringify(laterTailBody)
  } : null);
  ok(failed(laterTailPage.report, "public GET tail", "invalid_public_success"), "the fixed bare tail URL cannot impersonate a later cursor page");
  const wrongTailTableHash = await run(({ key }) => key === "public:tail:GET" ? {
    body: JSON.stringify(wrongTableHashBody)
  } : null);
  ok(failed(wrongTailTableHash.report, "public GET tail", "invalid_public_success"), "tail tables must reproduce their published artifact hash");
  const wrongTailPageHash = await run(({ key }) => key === "public:tail:GET" ? {
    body: JSON.stringify({ ...tailBody, page_commitment: DIGEST })
  } : null);
  ok(failed(wrongTailPageHash.report, "public GET tail", "invalid_public_success"), "tail metadata must reproduce its page commitment");
  const orphanTailHash = await run(({ key }) => key === "public:tail:GET" ? {
    body: JSON.stringify(orphanHashBody)
  } : null);
  ok(failed(orphanTailHash.report, "public GET tail", "invalid_public_success"), "every visible launch hash must be counted in its tail table");
  const longWallCursor = await run(({ key }) => key === "public:wall:GET" ? {
    body: JSON.stringify({ ...wallBody, live_cursor: "a".repeat(257) })
  } : null);
  ok(failed(longWallCursor.report, "public GET wall", "invalid_public_success"), "a wall cursor beyond the reader's bound is refused");
  const openError = await run(({ key }) => key === "public:wall:GET" ? {
    status: 503, body: JSON.stringify({ ok: true }), replaceHeaders: true,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  } : null);
  ok(failed(openError.report, "public GET wall", "non_fail_closed_error"), "a public error must describe a closed JSON state");
  const closedError = await run(({ key }) => key === "public:wall:GET" ? {
    status: 503, body: JSON.stringify({ ok: false, why: "no_watcher" }), replaceHeaders: true,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  } : null);
  ok(closedError.report.ok, "an exact documented unavailable state remains a healthy fail-closed API response");
  const broadStatus = await run(({ key }) => key === "public:tail:GET" ? {
    status: 400, body: JSON.stringify({ ok: false, why: "query" }), replaceHeaders: true,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  } : null);
  ok(failed(broadStatus.report, "public GET tail", "unexpected_status"), "a query regression on the fixed bare tail URL is not accepted");

  const sensitiveBody = "telegram-token-looking-response";
  const secretResponse = await run(({ key }) => key === "static:/app.js" ? {
    body: sensitiveBody, replaceHeaders: true, headers: {}
  } : null);
  ok(!formatProductionSmoke(secretResponse.report).includes(sensitiveBody), "response bodies are never printed in failure output");
  const sensitiveError = "fetch failed with private response text";
  const secretException = await run(({ key }) => key === "static:/app.js" ? { throw: new Error(sensitiveError) } : null);
  ok(failed(secretException.report, "static app.js", "request_failed") && !formatProductionSmoke(secretException.report).includes(sensitiveError), "fetch exception text is reduced to a safe category");

  const timeout = await run(({ key }) => key === "http:/" ? { hang: true } : null, { requestTimeoutMs: 10, runTimeoutMs: 1_000 });
  ok(failed(timeout.report, "HTTP redirects / to exact HTTPS URL", "request_timeout"), "a fetch that ignores AbortSignal remains deadline-bounded");
  const hangingReader = {
    status: 200,
    headers: new Headers(),
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => Promise.resolve() }) }
  };
  const bodyTimeout = await run(({ key }) => key === "static:/app.js" ? { response: hangingReader } : null, { requestTimeoutMs: 10, runTimeoutMs: 1_000 });
  ok(failed(bodyTimeout.report, "static app.js", "request_timeout"), "a body stream that ignores cancellation remains deadline-bounded");

  const oversizedPath = path.join(site, "oversized.bin");
  fs.writeFileSync(oversizedPath, "");
  fs.truncateSync(oversizedPath, SMOKE_LIMITS.responseBodyBytes + 1);
  const boundedLocalNetwork = fixtureNetwork();
  const boundedLocal = await runProductionSmoke({ fetchImpl: boundedLocalNetwork.fetch, siteDir: site });
  ok(failed(boundedLocal, "local static manifest", "static_file_too_large") && boundedLocalNetwork.calls.length === 0,
    "a locally oversized file is refused from stat before any production request");
  fs.rmSync(oversizedPath);

  const noNetwork = fixtureNetwork();
  const invalidLimit = await runProductionSmoke({
    fetchImpl: noNetwork.fetch,
    siteDir: site,
    requestTimeoutMs: SMOKE_LIMITS.requestTimeoutMs + 1
  });
  ok(failed(invalidLimit, "configuration", "invalid_request_timeout") && noNetwork.calls.length === 0, "runtime knobs cannot enlarge the authored hard deadline");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`production smoke test: ${checks} checks, ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
