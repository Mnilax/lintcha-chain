#!/usr/bin/env node
// Rebuild one bounded tail page's block range with the collector, and compare.
//
// This is the other half of the promise the snapshot keeps. The index the page reads is collected up to a
// block, hashed, and rebuilt by a command; the tail moves, so each committed page hands out its own block range
// and hash instead, and this is the command that checks them. Two steps, and neither edits anything:
//
//     node tools/launch-collect.mjs --from <from_block> --to <to_block> --out build/tail-range.json
//     node bot/tools/verify-tail.mjs --in build/tail-range.json
//
// The block numbers come from the tail itself: curl https://chain.lintcha.com/api/tail and read from_block and
// to_block. The tool fetches that first page again unless --tail <file> hands it one. For a later page, pass
// its opaque --cursor; after a successful check this tool prints the next cursor when one remains.
//
// Why this lives in bot/ and not in tools/. tools/verify-vendor.mjs walks site/ src/ tests/ tools/ and reports
// any file there that is neither in VENDOR.md's table nor in its owned-here list, and VENDOR.md belongs to
// somebody else. A new file under tools/ would break `npm test` at its first step until that list gained a
// row. Under bot/ it needs nobody's permission, and it is the bot's tail it verifies.
//
// What is compared is the canonical text of the counted tables, defined once in bot/src/tally.js and used by
// both sides, so this tool does not get to decide what equal means.
//
//   node bot/tools/verify-tail.mjs --in build/tail-range.json [--tail build/tail.json] [--cursor ...] [--url https://…]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tallyText, tallyHash, entryCounts } from "../src/tally.js";
import { NAMESPACES } from "../src/engine.js";
import {
  TAIL_VERSION,
  tailPageCommitment,
  MAX_PUBLISHED_FILE_BYTES,
  PUBLISHED_RESPONSE_TIMEOUT_MS
} from "../src/watch.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

export const VERIFY_TAIL_RESPONSE_LIMIT = MAX_PUBLISHED_FILE_BYTES;
export const VERIFY_TAIL_TIMEOUT_MS = PUBLISHED_RESPONSE_TIMEOUT_MS;
const TAIL_DEADLINE = Symbol("tail response deadline");
const VERIFY_ERROR = "VerifyTailResponseError";

const verifyError = message => {
  const error = new Error(message);
  error.name = VERIFY_ERROR;
  return error;
};

const cancelBestEffort = target => {
  try {
    const pending = target && typeof target.cancel === "function" ? target.cancel() : null;
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {}
};

/** One bounded, deadline-fenced read of the public tail response used by this verification CLI. */
export async function fetchTailJson(url, {
  fetchImpl = globalThis.fetch,
  limit = VERIFY_TAIL_RESPONSE_LIMIT,
  timeoutMs = VERIFY_TAIL_TIMEOUT_MS,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout
} = {}) {
  if (typeof fetchImpl !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function" ||
      !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw verifyError("the tail response bound is invalid");
  }
  const controller = new AbortController();
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimer(() => {
      controller.abort();
      resolve(TAIL_DEADLINE);
    }, timeoutMs);
  });
  let response = null;
  let reader = null;
  try {
    const pendingFetch = Promise.resolve().then(() => fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "lintcha-chain-verify-tail" },
      signal: controller.signal
    }));
    pendingFetch.then(value => {
      if (controller.signal.aborted && value && value.body) cancelBestEffort(value.body);
    }, () => {});
    response = await Promise.race([pendingFetch, deadline]);
    if (response === TAIL_DEADLINE) throw verifyError("the tail response deadline expired");
    if (!response || typeof response.ok !== "boolean") throw verifyError("the tail response is unavailable");
    if (!response.ok) {
      cancelBestEffort(response.body);
      throw verifyError("the tail answered " + response.status);
    }
    const declaredRaw = response.headers && typeof response.headers.get === "function"
      ? response.headers.get("content-length")
      : null;
    let declared = null;
    if (declaredRaw !== null) {
      const maximum = String(limit);
      if (typeof declaredRaw !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(declaredRaw) ||
          declaredRaw.length > maximum.length || (declaredRaw.length === maximum.length && declaredRaw > maximum)) {
        cancelBestEffort(response.body);
        throw verifyError("the tail response content-length is invalid");
      }
      declared = Number(declaredRaw);
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw verifyError("the tail response body is unavailable");
    }
    reader = response.body.getReader();
    const bytes = new Uint8Array(limit);
    let size = 0;
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part === TAIL_DEADLINE) throw verifyError("the tail response deadline expired");
      if (!part || part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > limit - size) {
        throw verifyError("the tail response body exceeds its bound");
      }
      bytes.set(part.value, size);
      size += part.value.byteLength;
    }
    if (declared !== null && declared !== size) {
      throw verifyError("the tail response content-length does not match its body");
    }
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)); }
    catch { throw verifyError("the tail response is not valid UTF-8"); }
    try { return JSON.parse(text); }
    catch { throw verifyError("the tail response is not valid JSON"); }
  } catch (error) {
    if (reader) cancelBestEffort(reader);
    else if (response && response.body) cancelBestEffort(response.body);
    if (error && error.name === VERIFY_ERROR) throw error;
    if (controller.signal.aborted) throw verifyError("the tail response deadline expired");
    throw verifyError("the tail response could not be read");
  } finally {
    clearTimer(timer);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

const IN = path.resolve(root, opt("in", path.join("build", "tail-range.json")));
const TAIL_FILE = opt("tail", null);
const URL_ = opt("url", "https://chain.lintcha.com/api/tail");
const CURSOR = opt("cursor", null);

const say = (label, value) => console.log(label.padEnd(38) + value);

async function readTail() {
  if (TAIL_FILE) return JSON.parse(fs.readFileSync(path.resolve(root, TAIL_FILE), "utf8"));
  const url = new URL(URL_);
  if (CURSOR) url.searchParams.set("cursor", CURSOR);
  return await fetchTailJson(url);
}

if (!fs.existsSync(IN)) {
  console.error("no collector output at " + IN + "\n\nRun the collector over the tail's own range first:\n" +
    "  node tools/launch-collect.mjs --from <from_block> --to <to_block> --out " + path.relative(root, IN).split(path.sep).join("/"));
  process.exit(1);
}

const collected = JSON.parse(fs.readFileSync(IN, "utf8"));
const tail = await readTail();

const problems = [];

// ---------------------------------------------------------------- the page authenticates its own bounded position
if (tail.ok !== true || tail.tail_version !== TAIL_VERSION) problems.push("the tail is not a supported successful page");
const rowBytes = new TextEncoder().encode(JSON.stringify(Array.isArray(tail.launches) ? tail.launches : null));
const rowDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", rowBytes)), byte => byte.toString(16).padStart(2, "0")).join("");
if (tail.rows_hash !== rowDigest) problems.push("the tail's rows_hash does not commit its ordered launch rows");
const commitment = await tailPageCommitment({
  snapshot: tail.snapshot_to_block,
  started: tail.watcher_started_block,
  startedAt: tail.watcher_started_at,
  coverageFrom: tail.coverage_from_block,
  from: tail.from_block,
  to: tail.to_block,
  upper: tail.watcher_to_block,
  page: tail.page,
  previous: tail.previous_page_commitment,
  total: tail.launches_in_tail,
  count: tail.launches_in_page,
  tableHash: tail.hash,
  rowsHash: tail.rows_hash
});
if (!commitment || commitment !== tail.page_commitment) problems.push("the tail's page commitment does not match its public metadata");
if (!Array.isArray(tail.launches) || tail.launches.length !== tail.launches_in_page) problems.push("launches_in_page does not match the bounded row list");
if (tail.more !== (typeof tail.next_cursor === "string" && tail.next_cursor.length > 0)) problems.push("more and next_cursor disagree");

// ---------------------------------------------------------------- the same blocks, or nothing else matters
say("tail from_block", tail.from_block);
say("tail to_block", tail.to_block);
say("collector from", collected.window.from);
say("collector to", collected.window.to);
if (Number(collected.window.from) !== Number(tail.from_block)) problems.push("the collector's window starts at " + collected.window.from + " and the tail's at " + tail.from_block);
if (Number(collected.window.to) !== Number(tail.to_block)) problems.push("the collector's window ends at " + collected.window.to + " and the tail's at " + tail.to_block);

// ---------------------------------------------------------------- the same table
const mine = tallyText(collected.tables);
const theirs = tallyText(tail.tables);
const myHash = await tallyHash(collected.tables);
const theirHash = await tallyHash(tail.tables);

say("collector hash", myHash);
say("tail hash", theirHash);
say("tail's own claim", tail.hash);
if (tail.hash !== theirHash) problems.push("the tail's hash does not match its own table: it says " + tail.hash + " and its table hashes to " + theirHash);
if (myHash !== theirHash) problems.push("the collector's table and the tail's table are not the same table");

// ---------------------------------------------------------------- and where they differ, say where
if (mine !== theirs) {
  const a = entryCounts(collected.tables), b = entryCounts(tail.tables);
  for (const ns of NAMESPACES) {
    const left = Object.keys(collected.tables[ns] || {}), right = Object.keys(tail.tables[ns] || {});
    if (a[ns] !== b[ns]) say("  " + ns + " entries", "collector " + a[ns] + ", tail " + b[ns]);
    const onlyMine = left.filter(h => !right.includes(h)), onlyTheirs = right.filter(h => !left.includes(h));
    for (const h of onlyMine.slice(0, 5)) say("  " + ns + " only in the collector", h);
    for (const h of onlyTheirs.slice(0, 5)) say("  " + ns + " only in the tail", h);
    for (const h of left.filter(x => right.includes(x))) {
      const x = collected.tables[ns][h], y = tail.tables[ns][h];
      if (x.n !== y.n || x.first !== y.first || x.d !== y.d || x.v !== y.v) {
        say("  " + ns + " differs at " + h, JSON.stringify(x) + " against " + JSON.stringify(y));
      }
    }
  }
}

console.log("");
if (problems.length) {
  console.error("the tail does not reproduce:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("the tail reproduces: same blocks, same table, same hash.");
if (tail.more) {
  console.log("This was one committed page. Rebuild the next page after fetching it with:");
  console.log("  node bot/tools/verify-tail.mjs --cursor " + tail.next_cursor + " --in <collector-output-for-that-page>");
}
}
