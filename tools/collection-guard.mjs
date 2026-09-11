#!/usr/bin/env node
// Owned publication guard around the vendored launch collector.
//
// The collector deliberately remains byte-for-byte pinned by VENDOR.md. This guard checks the facts it wrote
// before the index writer may consume them, then re-reads the factory log and every identity return at the exact
// finalized identity-state number/hash recorded by the collector. The log read uses two derived layouts whose page boundaries differ from the collector and from
// each other. This catches deterministic per-query truncation and boundary omissions, but is deliberately not called
// an independent-provider proof: all layouts use the configured endpoint unless an operator supplies another source.
// The second read catches duplicate/malformed rows and rebuilds the exact tables and summaries
// from strict ABI values after the collector has discarded raw events. It uses the vendored Gate and extracts every
// address, event/view signature and limiter ceiling from the collector's pinned source rather than copying them
// here. When a sampled outer transaction directly targets the factory or launch forwarder, its calldata is also
// bound to that destination's exact-match ABI. Other wallet/router envelopes are classified but never interpreted
// as launch ABIs; their shallow collector counters are reproduced only as report provenance:
//   https://sourcify.dev/server/v2/contract/4663/0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e?fields=abi
//   https://sourcify.dev/server/v2/contract/4663/0xe33E9E479dF8802cb0866d5d05258bEc4cF62948?fields=abi
//
//   node tools/collection-guard.mjs --in FILE --published site/launch-numbers.json --audit-logs
//   node tools/collection-guard.mjs --in FILE --published site/launch-numbers.json --diagnose-semantic
//
// The diagnostic command is deliberately not a publication gate. It skips historical transaction proof and block-
// header replay, but it still binds every identity call to the collector's recorded numeric state and checks that
// block's canonical hash before and after the read. A clean diagnostic proves only that semantic reconstruction;
// publication still requires the strict event-header and sampled-transaction checks.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Gate } from "./launch/rpc.mjs";
import { selector, topic } from "./launch/keccak.mjs";
import { AGGREGATE3_CALL, TOKEN_PARAMS, T, calldata, decodeParams } from "./launch/abi.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const COLLECTOR = path.join(here, "launch-collect.mjs");
const require = createRequire(import.meta.url);
const L = require(path.join(root, "site", "launch.js"));

const TOKEN_PARAMS_SIGNATURE = "(string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32)";
export const RPC_ENV = "LINTCHA_CHAIN_RPC_URL";
// Exact-match source and ABI are pinned to this address. If the factory owner rotates launchForwarder, the new
// implementation must be verified and reviewed before this guard will accept its outer calldata.
const VERIFIED_FORWARDER = "0xe33e9e479df8802cb0866d5d05258bec4cf62948";
// Authored request ceiling for block headers. A live public-RPC probe is kept outside the product data path; the
// guard still bounds, times, validates and retries every batch, and every reply remains one exact numbered header.
const EVENT_HEADER_BATCH = 100;
const VERIFIED_LAUNCH_CALLS = [
  { name: "launchToken", signature: "launchToken(" + TOKEN_PARAMS_SIGNATURE + ",uint256,address)", destination: "factory", headWords: 3, pairWord: 2, arrayWord: null, addressWords: [] },
  { name: "launchTokenWithExemptions", signature: "launchToken(" + TOKEN_PARAMS_SIGNATURE + ",uint256,address,address[])", destination: "factory", headWords: 4, pairWord: 2, arrayWord: 3, addressWords: [] },
  { name: "launchAndBuy", signature: "launchAndBuy(" + TOKEN_PARAMS_SIGNATURE + ",uint256,address,uint256,uint256,address,address[])", destination: "forwarder", headWords: 7, pairWord: 2, arrayWord: 6, addressWords: [5] }
];

const object = value => value && typeof value === "object" && !Array.isArray(value);
const safe = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const canonicalQuantity = value => typeof value === "string" && /^(?:0x0|0x[1-9a-f][0-9a-f]*)$/.test(value);
const hexBytes = (value, bytes) => typeof value === "string" && new RegExp("^0x[0-9a-f]{" + (bytes * 2) + "}$").test(value);
const addressWordShape = value => hexBytes(value, 32) && /^0x0{24}[0-9a-f]{40}$/.test(value);
const addressTopic = value => addressWordShape(value) && !/^0x0{64}$/.test(value);
const iso = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const date = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return new Date(value + "T00:00:00.000Z").toISOString().slice(0, 10) === value; } catch { return false; }
};
export const rpcOverrideAllowed = value => {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
};
const quantityNumber = value => {
  if (!canonicalQuantity(value)) return null;
  const n = Number(BigInt(value));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

export function exactIdentityState(document, label = "artifact") {
  const state = object(document) ? document.identity_state : null;
  const refresh = label + " has no exact finalized identity_state; run a new guarded refresh";
  if (!object(state)) throw new Error(refresh);
  if (Object.keys(state).sort().join(",") !== "hash,number" || !safe(state.number) || !hexBytes(state.hash, 32) || /^0x0{64}$/.test(state.hash)) {
    throw new Error(label + " has a malformed exact finalized identity_state; run a new guarded refresh");
  }
  return { number: state.number, hash: state.hash };
}

export function collectorContract(source) {
  if (typeof source !== "string") return null;
  const chain = /const CHAIN_ID = ([1-9][0-9]*)n;/.exec(source);
  const factory = /const FACTORY = "(0x[0-9a-f]{40})";/.exec(source);
  const multicall = /const MULTICALL3 = "(0x[0-9a-f]{40})";/.exec(source);
  const event = /const TOKEN_LAUNCHED = topic\("([^"]+)"\);/.exec(source);
  const rpc = /const DEFAULT_RPC = "(https:\/\/[^"\s]+)";/.exec(source) || /const RPC = opt\("rpc", "(https:\/\/[^"\s]+)"\);/.exec(source);
  const signatures = {};
  for (const name of ["name", "symbol", "info", "launched", "aggregate3"]) {
    const found = new RegExp("\\b" + name + ": selector\\(\\\"([^\\\"]+)\\\"\\)").exec(source);
    if (!found) return null;
    signatures[name] = found[1];
  }
  const batch = /const per = ([1-9][0-9]*);\s+\/\/ tokens per aggregate3/.exec(source);
  const chunk = /const CHUNK = Number\(opt\("chunk", ([1-9][0-9]*)\)\);/.exec(source);
  const sample = /const SAMPLE = Number\(opt\("sample", flag\("smoke"\) \? ([1-9][0-9]*) : ([1-9][0-9]*)\)\);/.exec(source);
  const gate = /new Gate\(\{ url: RPC, inFlight: Number\(opt\("in-flight", ([1-9][0-9]*)\)\), spacingMs: Number\(opt\("spacing", ([1-9][0-9]*)\)\), logsSpacingMs: Number\(opt\("logs-spacing", ([1-9][0-9]*)\)\)/.exec(source);
  if (!chain || !factory || !multicall || !event || !rpc || !batch || !chunk || !sample || !gate) return null;
  const chainId = Number(chain[1]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  return {
    chainId,
    factory: factory[1],
    multicall: multicall[1],
    event: event[1],
    eventTopic: topic(event[1]),
    rpc: rpc[1],
    batch: Number(batch[1]),
    chunk: Number(chunk[1]),
    sample: { smoke: Number(sample[1]), regular: Number(sample[2]) },
    limiter: { inFlight: Number(gate[1]), spacingMs: Number(gate[2]), logsSpacingMs: Number(gate[3]) },
    forwarder: VERIFIED_FORWARDER,
    launchCalls: VERIFIED_LAUNCH_CALLS.map(call => ({ ...call, selector: selector(call.signature) })),
    signatures,
    selectors: Object.fromEntries(Object.entries(signatures).map(([name, signature]) => [name, selector(signature)]))
  };
}

export function validateCollection(report, published, contract) {
  const problems = [];
  const fail = text => problems.push(text);
  if (!report || typeof report !== "object" || Array.isArray(report)) return ["collection is not an object"];
  if (!contract || !positive(contract.chainId) || !/^0x[0-9a-f]{40}$/.test(contract.factory || "") || !/^0x[0-9a-f]{40}$/.test(contract.multicall || "") || !/^0x[0-9a-f]{40}$/.test(contract.forwarder || "") || !hexBytes(contract.eventTopic, 32) || !positive(contract.batch) || !positive(contract.chunk) || !object(contract.sample) || !positive(contract.sample.smoke) || !positive(contract.sample.regular) || !object(contract.limiter) || !positive(contract.limiter.inFlight) || !positive(contract.limiter.spacingMs) || !positive(contract.limiter.logsSpacingMs) || !object(contract.selectors) || Object.values(contract.selectors).some(value => !hexBytes(value, 4)) || !Array.isArray(contract.launchCalls) || contract.launchCalls.length !== VERIFIED_LAUNCH_CALLS.length || contract.launchCalls.some(call => !hexBytes(call.selector, 4))) {
    return ["collector source contract is unreadable"];
  }
  const w = report.window, v = report.verified, six = report.six, also = report.also, limiter = report.limiter, tables = report.tables;
  let identityState = null;
  try { identityState = exactIdentityState(report, "collection"); }
  catch (error) { fail(error.message); }
  if (!object(w)) fail("window is unreadable");
  else {
    if (!["day", "explicit", "smoke"].includes(w.kind)) fail("window kind is unknown");
    if (!safe(w.from) || !safe(w.to) || w.to <= w.from) fail("window block range is empty or invalid");
    if (!positive(w.blocks) || w.blocks !== w.to - w.from + 1) fail("window block count does not match its range");
    if (!safe(w.finalized) || w.finalized < w.to) fail("window is not bounded by its stated finalized head");
    if (identityState && (w.finalized !== identityState.number || identityState.number < w.to)) fail("collection identity_state does not exactly bind its finalized window");
    if (w.chain_id !== contract.chainId) fail("collection chain id does not match the pinned collector source");
    for (const key of ["from_time", "to_time"]) {
      const value = w[key];
      if (!iso(value)) fail("window " + key + " is not a canonical UTC instant");
    }
    if (typeof w.from_time === "string" && typeof w.to_time === "string" && !(Date.parse(w.to_time) > Date.parse(w.from_time))) fail("window times are not increasing");
  }
  if (!object(v)) fail("verification facts are unreadable");
  if (!object(six)) fail("summary facts are unreadable");
  if (!object(also)) fail("additional summary facts are unreadable");
  if (object(v) && object(six)) {
    const total = v.launches_in_log, readable = v.tokens_readable, scanned = six.launches_scanned;
    if (!positive(total) || !positive(readable) || !positive(scanned)) fail("collection contains no positive launch count");
    if (total !== readable || total !== scanned) fail("not every launch log row was read exactly once into the summary");
    for (const key of ["getTokenInfo_deployer_equals_event_deployer", "factory_record_exists", "factory_record_deployer_equals_event_deployer"]) {
      if (v[key] !== readable) fail(key + " does not cover every readable launch");
    }
    if (v.multicall3_has_code !== true) fail("the run did not prove Multicall3 code before using it");
    const sampled = v.sampled_transactions, decoded = v.calldata_decoded_as_TokenParams;
    if (!positive(sampled) || sampled > readable) fail("sampled transaction count is invalid");
    if (!safe(decoded) || decoded > sampled) fail("calldata decoded count is invalid");
    for (const key of ["calldata_name_symbol_equal_onchain", "calldata_socials_equal_onchain", "tx_from_equals_deployer"]) {
      if (!safe(v[key]) || v[key] > decoded) fail(key + " exceeds decoded sampled transactions");
    }
    if (!safe(v.calldata_recipient_equals_factory_record_when_consistent) || v.calldata_recipient_equals_factory_record_when_consistent > v.calldata_name_symbol_equal_onchain) fail("calldata recipient consistency count is invalid");
    if (!safe(v.fee_recipient_set) || v.fee_recipient_set > readable) fail("fee recipient count is invalid");
    if (!safe(v.tx_to_distinct) || v.tx_to_distinct > decoded || (decoded > 0 && v.tx_to_distinct === 0)) fail("sampled transaction destination count is invalid");
    if (v.chunk_blocks !== contract.chunk) fail("collector log chunk size differs from the pinned default");
    if (!Array.isArray(v.day_boundaries) || v.day_boundaries.some((n, i, a) => !positive(n) || (object(w) && (n < w.from || n > w.to)) || (i && n <= a[i - 1]))) fail("day boundary list is invalid");

    const linkCount = six.launches_with_a_link && six.launches_with_a_link.count;
    const linkShare = six.launches_with_a_link && six.launches_with_a_link.share;
    if (!safe(linkCount) || linkCount > readable || typeof linkShare !== "number" || !Number.isFinite(linkShare) || linkShare !== Math.round(1000 * linkCount / readable) / 10) fail("launch link count or share is invalid");
    for (const key of ["distinct_link_values", "link_values_by_more_than_one_deployer"]) {
      if (!object(six[key]) || !safe(six[key].folded) || !safe(six[key].raw)) fail(key + " is invalid");
    }
    if (object(six.distinct_link_values) && object(six.link_values_by_more_than_one_deployer) && (six.link_values_by_more_than_one_deployer.folded > six.distinct_link_values.folded || six.link_values_by_more_than_one_deployer.raw > six.distinct_link_values.raw)) fail("shared link counts exceed distinct link counts");
    if (!safe(six.tickers_by_more_than_one_deployer) || !object(six.lookalike_ticker_pairs) || !safe(six.lookalike_ticker_pairs.pairs) || !safe(six.lookalike_ticker_pairs.skeleton_groups)) fail("ticker summary facts are invalid");
  }
  if (object(also)) for (const key of ["names_by_more_than_one_deployer", "logos_by_more_than_one_deployer", "recipients_by_more_than_one_deployer", "descriptions_compared", "descriptions_by_more_than_one_deployer", "lookalike_name_groups", "lookalike_ticker_groups_v"]) {
    if (!safe(also[key])) fail(key + " is invalid");
  }
  if (!object(limiter) || !positive(limiter.calls) || !safe(limiter.http429) || !safe(limiter.rpc429) || !safe(limiter.retries) || !safe(limiter.otherErrors) || !positive(limiter.in_flight) || !positive(limiter.spacing_ms) || !positive(limiter.logs_spacing_ms) || !safe(limiter.seconds)) {
    fail("collector limiter counters are invalid");
  } else {
    if (limiter.in_flight !== contract.limiter.inFlight || limiter.spacing_ms !== contract.limiter.spacingMs || limiter.logs_spacing_ms !== contract.limiter.logsSpacingMs) fail("collector limiter differs from the pinned defaults");
    if (!object(limiter.byMethod) || Object.keys(limiter.byMethod).length === 0 || Object.values(limiter.byMethod).some(n => !positive(n)) || Object.values(limiter.byMethod).reduce((a, b) => a + b, 0) !== limiter.calls) fail("collector method call counts do not add up");
    if (!positive(limiter.firstAt) || !positive(limiter.lastAt) || limiter.lastAt < limiter.firstAt) fail("collector call timestamps are invalid");
  }
  if (!object(tables) || Object.keys(tables).sort().join(",") !== [...L.NAMESPACES].sort().join(",")) fail("collector tables do not name the exact engine namespaces");
  else if (object(v) && positive(v.tokens_readable) && object(w) && iso(w.from_time) && iso(w.to_time)) {
    const firstDate = w.from_time.slice(0, 10), lastDate = w.to_time.slice(0, 10);
    for (const ns of L.NAMESPACES) {
      if (!object(tables[ns])) { fail(ns + " table is unreadable"); continue; }
      for (const [hash, entry] of Object.entries(tables[ns])) {
        if (!/^[0-9a-f]{16}$/.test(hash) || !object(entry) || !positive(entry.n) || entry.n > v.tokens_readable || !positive(entry.d) || entry.d > entry.n || !date(entry.first) || entry.first < firstDate || entry.first > lastDate) {
          fail(ns + " table contains an invalid counted hash");
          break;
        }
        if (ns.endsWith("_skeleton") ? (!positive(entry.v) || entry.v > entry.n) : Object.prototype.hasOwnProperty.call(entry, "v")) {
          fail(ns + " table has an invalid spelling count");
          break;
        }
      }
    }
  }
  if (!object(published) || published.chain_id !== contract.chainId) fail("published chain id baseline is missing or invalid");
  const baseline = published && published.launches_scanned;
  if (!positive(baseline)) fail("published launches_scanned baseline is missing or invalid");
  else if (v && positive(v.launches_in_log) && v.launches_in_log / baseline < 0.5) fail("collection is below half of the published launch count");
  return problems;
}

export function validateLaunchLogs(logs, contract, from, to, expected) {
  const problems = [];
  if (!Array.isArray(logs)) return ["factory log result is not an array"];
  const positions = new Set(), tokens = new Set(), blockHashes = new Map(), hashBlocks = new Map();
  let previousBlock = null, previousIndex = null;
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i], at = "log[" + i + "]";
    if (!log || typeof log !== "object" || Array.isArray(log)) { problems.push(at + " is not an object"); continue; }
    if (log.address !== contract.factory || log.removed !== false) problems.push(at + " has the wrong factory address or removed state");
    if (!Array.isArray(log.topics) || log.topics.length !== 4 || log.topics[0] !== contract.eventTopic || !addressTopic(log.topics[1]) || !addressTopic(log.topics[2]) || !addressTopic(log.topics[3])) {
      problems.push(at + " has a malformed event topic shape");
      continue;
    }
    const pairWord = typeof log.data === "string" ? log.data.slice(0, 66) : "";
    if (!hexBytes(log.data, 96) || !addressWordShape(pairWord)) problems.push(at + " has malformed event data");
    if (!canonicalQuantity(log.blockNumber) || !canonicalQuantity(log.transactionIndex) || !canonicalQuantity(log.logIndex) || !hexBytes(log.transactionHash, 32) || /^0x0{64}$/.test(log.transactionHash) || !hexBytes(log.blockHash, 32) || /^0x0{64}$/.test(log.blockHash)) {
      problems.push(at + " has malformed factory position");
      continue;
    }
    const block = quantityNumber(log.blockNumber), index = quantityNumber(log.logIndex);
    if (block === null || block < from || block > to) problems.push(at + " falls outside the collected block range");
    if (block !== null && index !== null) {
      const knownHash = blockHashes.get(block);
      if (knownHash && knownHash !== log.blockHash) problems.push(at + " disagrees on the block hash for its block number");
      else if (!knownHash) blockHashes.set(block, log.blockHash);
      const knownBlock = hashBlocks.get(log.blockHash);
      if (knownBlock !== undefined && knownBlock !== block) problems.push(at + " reuses one block hash for another block number");
      else if (knownBlock === undefined) hashBlocks.set(log.blockHash, block);
      if (previousBlock !== null && (block < previousBlock || (block === previousBlock && index <= previousIndex))) problems.push(at + " is not in canonical ascending block/log order");
      previousBlock = block; previousIndex = index;
    }
    const position = log.blockNumber + ":" + log.logIndex;
    if (positions.has(position)) problems.push(at + " repeats a factory log position");
    positions.add(position);
    const tokenAddress = log.topics[1].slice(26);
    if (tokens.has(tokenAddress)) problems.push(at + " repeats a launched token address");
    tokens.add(tokenAddress);
  }
  if (!safe(expected) || logs.length !== expected) problems.push("audited factory log count does not match collector launches_in_log");
  return problems;
}

// The collector's page size is source-pinned. Its guard must not repeat those boundaries: otherwise an endpoint that
// deterministically truncates one page can hand both programs the same incomplete answer. Both layouts are derived
// from that pinned value, so a collector change automatically changes the audit without introducing another magic
// network constant. The shifted layout starts with a shorter page and therefore probes every aligned boundary from
// the other side.
export function auditLogLayouts(from, to, collectorChunk) {
  if (!safe(from) || !safe(to) || to < from || !positive(collectorChunk)) throw new Error("factory log audit range is invalid");
  const size = Math.max(1, Math.floor(collectorChunk / 2));
  const shift = Math.max(1, Math.floor(size / 2));
  const make = firstSize => {
    const ranges = [];
    let at = from, width = firstSize;
    while (at <= to) {
      const end = Math.min(to, at + width - 1);
      ranges.push({ from: at, to: end });
      at = end + 1;
      width = size;
    }
    return ranges;
  };
  return { size, aligned: make(size), shifted: make(shift) };
}

const canonicalLogRow = log => [
  log.address,
  log.topics,
  log.data,
  log.blockNumber,
  log.transactionIndex,
  log.logIndex,
  log.transactionHash,
  log.blockHash,
  log.removed
];

export function validatePartitionPage(page, baseline, contract, from, to) {
  const expected = Array.isArray(baseline)
    ? baseline.filter(log => {
      const block = object(log) ? quantityNumber(log.blockNumber) : null;
      return block !== null && block >= from && block <= to;
    })
    : null;
  const problems = validateLaunchLogs(page, contract, from, to, expected ? expected.length : -1);
  if (!problems.length && expected && JSON.stringify(page.map(canonicalLogRow)) !== JSON.stringify(expected.map(canonicalLogRow))) {
    problems.push("alternate factory log page differs from the canonical baseline projection");
  }
  return problems;
}

const byteString = value => {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) return null;
  return Uint8Array.from(value.slice(2).match(/../g) || [], pair => Number.parseInt(pair, 16));
};
const uintWord = (bytes, at) => {
  if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(at) || at < 0 || at + 32 > bytes.length) return null;
  let value = 0n;
  for (let i = 0; i < 32; i++) value = (value << 8n) | BigInt(bytes[at + i]);
  return value;
};
const uintNumber = (bytes, at) => {
  const value = uintWord(bytes, at);
  if (value === null || value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(value);
};
const abiAddress = (bytes, at) => {
  const value = uintWord(bytes, at);
  return value !== null && value >> 160n === 0n ? "0x" + value.toString(16).padStart(40, "0") : null;
};
const padded = size => Math.ceil(size / 32) * 32;
const dynamicBytes = (bytes, at, label) => {
  const size = uintNumber(bytes, at);
  if (size === null) throw new Error(label + " has an invalid dynamic length");
  const start = at + 32, end = start + size, paddedEnd = start + padded(size);
  if (end > bytes.length || paddedEnd > bytes.length) throw new Error(label + " is truncated");
  for (let i = end; i < paddedEnd; i++) if (bytes[i] !== 0) throw new Error(label + " has non-zero ABI padding");
  return { value: bytes.slice(start, end), end: paddedEnd };
};
const textAt = (bytes, at, label) => {
  const part = dynamicBytes(bytes, at, label);
  try { return { value: new TextDecoder("utf-8", { fatal: true }).decode(part.value), end: part.end }; }
  catch { throw new Error(label + " is not valid UTF-8"); }
};
const textReturn = (bytes, label) => {
  if (uintNumber(bytes, 0) !== 32) throw new Error(label + " has a non-canonical return offset");
  const parsed = textAt(bytes, 32, label);
  if (parsed.end !== bytes.length) throw new Error(label + " has trailing or overlapping ABI bytes");
  return parsed.value;
};
const tokenInfoReturn = (bytes, label) => {
  if (!(bytes instanceof Uint8Array) || bytes.length < 128) throw new Error(label + " is shorter than its ABI head");
  const deployer = abiAddress(bytes, 0);
  if (!deployer || /^0x0{40}$/.test(deployer)) throw new Error(label + " has a malformed deployer word");
  const logoAt = uintNumber(bytes, 32), descriptionAt = uintNumber(bytes, 64), socialsAt = uintNumber(bytes, 96);
  if (logoAt !== 128) throw new Error(label + " has a non-canonical logo offset");
  const logo = textAt(bytes, logoAt, label + " logo");
  if (descriptionAt !== logo.end) throw new Error(label + " has a non-canonical description offset");
  const description = textAt(bytes, descriptionAt, label + " description");
  if (socialsAt !== description.end || socialsAt + 160 > bytes.length) throw new Error(label + " has a non-canonical socials offset");
  const socials = [];
  let cursor = socialsAt + 160;
  for (let i = 0; i < 5; i++) {
    const offset = uintNumber(bytes, socialsAt + i * 32);
    if (offset === null || socialsAt + offset !== cursor) throw new Error(label + " has a non-canonical social offset");
    const social = textAt(bytes, cursor, label + " social " + i);
    socials.push(social.value);
    cursor = social.end;
  }
  if (cursor !== bytes.length) throw new Error(label + " has trailing or overlapping ABI bytes");
  return { deployer, logo: logo.value, description: description.value, socials };
};
const addressReturn = (value, label) => {
  const bytes = byteString(value), address = bytes && bytes.length === 32 ? abiAddress(bytes, 0) : null;
  if (!address) throw new Error(label + " is not one canonical address word");
  return address;
};
const addressArrayAt = (bytes, at, label) => {
  const count = uintNumber(bytes, at), start = at + 32;
  if (count === null || count > Math.floor((bytes.length - start) / 32)) throw new Error(label + " has an invalid array length");
  const values = [];
  for (let i = 0; i < count; i++) {
    const address = abiAddress(bytes, start + i * 32);
    if (!address) throw new Error(label + " has a non-canonical address at " + i);
    values.push(address);
  }
  return { values, end: start + count * 32 };
};
const transactionParams = (transaction, event, label, contract) => {
  if (!object(transaction) || transaction.hash !== event.transactionHash || quantityNumber(transaction.blockNumber) !== event.block || transaction.blockHash !== event.blockHash) throw new Error(label + " does not identify the sampled factory transaction and block");
  const from = typeof transaction.from === "string" && /^0x[0-9a-f]{40}$/.test(transaction.from) ? transaction.from : null;
  const to = typeof transaction.to === "string" && /^0x[0-9a-f]{40}$/.test(transaction.to) && !/^0x0{40}$/.test(transaction.to) ? transaction.to : null;
  if (!from || from !== event.deployer || !to) throw new Error(label + " has a malformed or mismatched sender/destination");
  const input = byteString(transaction.input);
  if (!input || input.length < 4 + 32) throw new Error(label + " input is truncated or malformed");
  if (!contract || !Array.isArray(contract.launchCalls)) throw new Error(label + " has no verified launch ABI contract");
  const callSelector = transaction.input.slice(0, 10).toLowerCase();
  const call = contract.launchCalls.find(candidate => candidate.selector === callSelector);
  if (!call) throw new Error(label + " selector is not a verified outer launch call");
  const expectedDestination = call.destination === "factory" ? contract.factory : contract.forwarder;
  if (!expectedDestination || to !== expectedDestination) throw new Error(label + " destination does not match the verified " + call.destination);
  const body = input.slice(4), tupleAt = uintNumber(body, 0), headBytes = 10 * 32;
  if (body.length % 32) throw new Error(label + " input body is not ABI-word-aligned");
  if (tupleAt !== call.headWords * 32 || tupleAt + headBytes > body.length) throw new Error(label + " has a non-canonical top-level head or TokenParams offset");
  const pairToken = abiAddress(body, call.pairWord * 32);
  if (!pairToken || pairToken !== event.pairToken) throw new Error(label + " pairToken is non-canonical or differs from the factory event");
  const launchConfigId = uintWord(body, 32);
  if (launchConfigId === null || typeof event.launchConfigId !== "bigint" || launchConfigId !== event.launchConfigId) throw new Error(label + " launchConfigId differs from the factory event");
  for (const wordIndex of call.addressWords) if (!abiAddress(body, wordIndex * 32)) throw new Error(label + " has a non-canonical top-level address");
  const dynamicOffsets = new Array(5).fill(null).map((_, i) => uintNumber(body, tupleAt + i * 32));
  let cursor = tupleAt + headBytes;
  const strings = [];
  for (let i = 0; i < 4; i++) {
    if (dynamicOffsets[i] === null || tupleAt + dynamicOffsets[i] !== cursor) throw new Error(label + " has a non-canonical TokenParams string offset");
    const parsed = textAt(body, cursor, label + " TokenParams string " + i);
    strings.push(parsed.value); cursor = parsed.end;
  }
  if (dynamicOffsets[4] === null || tupleAt + dynamicOffsets[4] !== cursor || cursor + 5 * 32 > body.length) throw new Error(label + " has a non-canonical TokenParams socials offset");
  const socialsAt = cursor, socials = [];
  cursor = socialsAt + 5 * 32;
  for (let i = 0; i < 5; i++) {
    const offset = uintNumber(body, socialsAt + i * 32);
    if (offset === null || socialsAt + offset !== cursor) throw new Error(label + " has a non-canonical TokenParams social offset");
    const parsed = textAt(body, cursor, label + " TokenParams social " + i);
    socials.push(parsed.value); cursor = parsed.end;
  }
  const recipient = abiAddress(body, tupleAt + 5 * 32), creatorTaxBps = uintWord(body, tupleAt + 6 * 32), buybackEnabled = uintWord(body, tupleAt + 7 * 32);
  if (!recipient || creatorTaxBps === null || creatorTaxBps > 0xffffn || (buybackEnabled !== 0n && buybackEnabled !== 1n)) throw new Error(label + " has a non-canonical TokenParams address, uint16 or boolean");
  if (call.arrayWord === null) {
    if (cursor !== body.length) throw new Error(label + " has trailing bytes after its verified launch call");
  } else {
    const arrayAt = uintNumber(body, call.arrayWord * 32);
    if (arrayAt !== cursor) throw new Error(label + " has a non-canonical exemptions offset");
    const exemptions = addressArrayAt(body, cursor, label + " exemptions");
    if (exemptions.end !== body.length) throw new Error(label + " has trailing bytes after its exemptions array");
  }
  const effectiveRecipient = /^0x0{40}$/.test(recipient) ? event.deployer : recipient;
  return { name: strings[0], symbol: strings[1], logo: strings[2], description: strings[3], socials, recipient, effectiveRecipient, pairToken, launchConfigId, from, to, call: call.name, creatorTaxBps, buybackEnabled: buybackEnabled === 1n };
};

export function decodeSampleTransaction(transaction, row, contract) {
  try { return { value: transactionParams(transaction, row, "sampled transaction", contract), problems: [] }; }
  catch (error) { return { value: null, problems: [error.message] }; }
}
const strictAggregateResult = (value, expected) => {
  const bytes = byteString(value);
  if (!bytes || uintNumber(bytes, 0) !== 32 || uintNumber(bytes, 32) !== expected) throw new Error("aggregate3 returned a malformed array head");
  const base = 64, headEnd = base + expected * 32;
  if (!Number.isSafeInteger(headEnd) || headEnd > bytes.length) throw new Error("aggregate3 returned a truncated offset table");
  const values = [];
  let cursor = headEnd;
  for (let i = 0; i < expected; i++) {
    const offset = uintNumber(bytes, base + i * 32);
    if (offset === null || base + offset !== cursor) throw new Error("aggregate3 returned a non-canonical element offset at " + i);
    const success = uintWord(bytes, cursor), bytesOffset = uintNumber(bytes, cursor + 32);
    if (success !== 1n || bytesOffset !== 64) throw new Error("aggregate3 call " + i + " failed or has a malformed tuple head");
    const part = dynamicBytes(bytes, cursor + 64, "aggregate3 call " + i);
    values.push(part.value);
    cursor = part.end;
  }
  if (cursor !== bytes.length) throw new Error("aggregate3 returned trailing or overlapping bytes");
  return values;
};
const eventRow = log => {
  const data = byteString(log.data);
  return {
    token: "0x" + log.topics[1].slice(26),
    curve: "0x" + log.topics[2].slice(26),
    deployer: "0x" + log.topics[3].slice(26),
    pairToken: abiAddress(data, 0),
    launchConfigId: uintWord(data, 32),
    graduationThreshold: uintWord(data, 64),
    block: quantityNumber(log.blockNumber),
    blockHash: log.blockHash,
    transactionHash: log.transactionHash
  };
};
const launchRecord = (bytes, event, label) => {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 15 * 32) throw new Error(label + " is not exactly fifteen words");
  const addresses = new Array(5).fill(null).map((_, i) => abiAddress(bytes, i * 32));
  if (addresses.some(value => !value)) throw new Error(label + " has a non-canonical address word");
  const [token, curve, deployer, creatorFeeRecipient, pairToken] = addresses;
  if (token !== event.token || curve !== event.curve || deployer !== event.deployer || pairToken !== event.pairToken) throw new Error(label + " is not bound to the factory event");
  if (typeof event.graduationThreshold !== "bigint" || uintWord(bytes, 5 * 32) !== event.graduationThreshold) throw new Error(label + " graduation threshold differs from the factory event");
  if (/^0x0{40}$/.test(curve) || /^0x0{40}$/.test(deployer)) throw new Error(label + " carries a zero required address");
  const buybackEnabled = uintWord(bytes, 9 * 32), exists = uintWord(bytes, 14 * 32);
  if ((buybackEnabled !== 0n && buybackEnabled !== 1n) || exists !== 1n) throw new Error(label + " has a non-canonical boolean or is not an existing launch");
  return { creatorFeeRecipient };
};

export function decodeAuditBatch(result, logs, contract) {
  const rows = [], problems = [];
  if (!Array.isArray(logs) || !logs.length) return { rows, problems: ["audit batch has no factory logs"] };
  try {
    const values = strictAggregateResult(result, logs.length * 4);
    for (let i = 0; i < logs.length; i++) {
      const event = eventRow(logs[i]), label = "audit row " + i;
      const name = textReturn(values[i * 4], label + " name");
      const symbol = textReturn(values[i * 4 + 1], label + " symbol");
      const info = tokenInfoReturn(values[i * 4 + 2], label + " token info");
      if (info.deployer !== event.deployer) throw new Error(label + " token info deployer differs from the factory event");
      const record = launchRecord(values[i * 4 + 3], event, label + " factory record");
      rows.push({ ...event, name, symbol, logo: info.logo, description: info.description, socials: info.socials, recipient: record.creatorFeeRecipient });
    }
  } catch (error) { problems.push(error.message); }
  return { rows: problems.length ? [] : rows, problems };
}

class AuditCounter {
  constructor() { this.tables = Object.fromEntries(L.NAMESPACES.map(namespace => [namespace, new Map()])); }
  async add(namespace, value, first, deployer, spelling) {
    if (!value) return;
    const digest = await L.digest(value), table = this.tables[namespace];
    const entry = table.get(digest) || { n: 0, first, deployers: new Set(), spellings: namespace.endsWith("_skeleton") ? new Set() : null };
    entry.n++;
    if (first < entry.first) entry.first = first;
    entry.deployers.add(deployer);
    if (entry.spellings) entry.spellings.add(spelling);
    table.set(digest, entry);
  }
  frozen() {
    return Object.fromEntries(L.NAMESPACES.map(namespace => [namespace, Object.fromEntries([...this.tables[namespace]].sort().map(([digest, entry]) => [digest, entry.spellings ? { n: entry.n, first: entry.first, d: entry.deployers.size, v: entry.spellings.size } : { n: entry.n, first: entry.first, d: entry.deployers.size }]))]));
  }
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export async function buildSemanticAudit(rows, boundaryDates) {
  const counter = new AuditCounter(), rawLinks = new Map(), skeletonGroups = new Map();
  let withLink = 0, recipientSet = 0;
  const dateOfBlock = block => {
    let result = boundaryDates.first;
    for (const boundary of boundaryDates.boundaries) if (block >= boundary.block) result = boundary.date;
    return result;
  };
  for (const row of rows) {
    const first = dateOfBlock(row.block), socials = Object.fromEntries(L.LINKS.map((key, i) => [key, row.socials[i] || ""]));
    if (L.LINKS.some(key => socials[key].trim())) withLink++;
    for (const key of L.LINKS) {
      await counter.add("link", L.normalize.link(socials[key], key), first, row.deployer);
      const raw = L.normalize.linkRaw(socials[key], key);
      if (raw) {
        const entry = rawLinks.get(raw) || { n: 0, deployers: new Set() };
        entry.n++; entry.deployers.add(row.deployer); rawLinks.set(raw, entry);
      }
    }
    await counter.add("logo", L.normalize.logo(row.logo), first, row.deployer);
    const recipient = L.normalize.recipient(row.recipient);
    if (recipient.state === "ok") { recipientSet++; await counter.add("recipient", recipient.value, first, row.deployer); }
    const description = L.normalize.description(row.description);
    if (description && L.words(description) >= L.MIN_WORDS) await counter.add("description", description, first, row.deployer);
    const ticker = L.normalize.ticker(row.symbol), name = L.normalize.name(row.name);
    await counter.add("ticker", ticker, first, row.deployer);
    await counter.add("name", name, first, row.deployer);
    await counter.add("ticker_skeleton", L.normalize.skeleton(ticker), first, row.deployer, ticker);
    await counter.add("name_skeleton", L.normalize.skeleton(name), first, row.deployer, name);
    if (ticker) {
      const skeleton = L.normalize.skeleton(ticker);
      if (!skeletonGroups.has(skeleton)) skeletonGroups.set(skeleton, new Set());
      skeletonGroups.get(skeleton).add(ticker);
    }
  }
  const tables = counter.frozen(), multi = namespace => Object.values(tables[namespace]).filter(entry => entry.d > 1).length;
  let pairs = 0, groups = 0;
  for (const spellings of skeletonGroups.values()) if (spellings.size > 1) { groups++; pairs += spellings.size * (spellings.size - 1) / 2; }
  return {
    tables,
    six: {
      launches_scanned: rows.length,
      launches_with_a_link: { count: withLink, share: rows.length ? Math.round(1000 * withLink / rows.length) / 10 : 0 },
      distinct_link_values: { folded: Object.keys(tables.link).length, raw: rawLinks.size },
      link_values_by_more_than_one_deployer: { folded: multi("link"), raw: [...rawLinks.values()].filter(entry => entry.deployers.size > 1).length },
      tickers_by_more_than_one_deployer: multi("ticker"),
      lookalike_ticker_pairs: { pairs, skeleton_groups: groups }
    },
    also: {
      names_by_more_than_one_deployer: multi("name"),
      logos_by_more_than_one_deployer: multi("logo"),
      recipients_by_more_than_one_deployer: multi("recipient"),
      descriptions_compared: Object.keys(tables.description).length,
      descriptions_by_more_than_one_deployer: multi("description"),
      lookalike_name_groups: Object.values(tables.name_skeleton).filter(entry => entry.v >= 2).length,
      lookalike_ticker_groups_v: Object.values(tables.ticker_skeleton).filter(entry => entry.v >= 2).length
    },
    recipientSet
  };
}

export function validateSemanticAudit(audit, report) {
  const problems = [];
  if (!object(audit)) return ["semantic chain audit is unreadable"];
  if (!same(audit.tables, report.tables)) {
    const namespaces = Array.from(new Set([
      ...Object.keys(object(audit.tables) ? audit.tables : {}),
      ...Object.keys(object(report.tables) ? report.tables : {})
    ])).filter(namespace => !same(audit.tables && audit.tables[namespace], report.tables && report.tables[namespace])).sort();
    problems.push("chain identity re-read produced different counted identity tables" + (namespaces.length ? " (" + namespaces.join(", ") + ")" : ""));
  }
  if (!same(audit.six, report.six)) problems.push("chain identity re-read produced different six-line facts");
  if (!same(audit.also, report.also)) problems.push("chain identity re-read produced different additional facts");
  if (audit.recipientSet !== report.verified.fee_recipient_set) problems.push("chain identity re-read produced a different fee recipient count");
  return problems;
}

export function validateIdentityAuditAnchor(context, report, contract) {
  const problems = [], fail = text => problems.push(text);
  if (!object(context)) return ["audited identity-state anchor is unreadable"];
  let identityState = null;
  try { identityState = exactIdentityState(report, "collection"); }
  catch (error) { fail(error.message); }
  const chainId = quantityNumber(context.chainId);
  if (chainId !== contract.chainId) fail("audited RPC chain id does not match the pinned collector source");
  const finalized = object(context.finalizedBlock) ? quantityNumber(context.finalizedBlock.number) : null;
  if (finalized === null || !identityState || finalized < identityState.number || finalized < report.window.to) fail("audited current finalized head is behind the recorded identity state or collected range");
  const finalizedHash = object(context.finalizedBlock) ? context.finalizedBlock.hash : null;
  if (!hexBytes(finalizedHash, 32) || /^0x0{64}$/.test(finalizedHash)) fail("audited current finalized head has no canonical block hash");
  else if (identityState && finalized === identityState.number && finalizedHash !== identityState.hash) fail("audited current finalized head contradicts the recorded identity_state hash at the same height");
  problems.push(...validateIdentityStateHeader(context.identityStateBlock, report, "audited identity-state"));
  return problems;
}

export function validateIdentityStateAvailability(context, { requireHistorical = true } = {}) {
  const problems = [];
  const multicallCode = object(context) ? byteString(context.multicallCode) : null;
  if (!multicallCode || multicallCode.length === 0) problems.push("audited Multicall3 has no canonical bytecode at the recorded identity state");
  const identityFactoryCode = object(context) ? byteString(context.identityFactoryCode) : null;
  if (!identityFactoryCode || identityFactoryCode.length === 0) problems.push("audited factory has no canonical bytecode at the recorded identity state");
  if (requireHistorical) {
    const historicalFactoryCode = object(context) ? byteString(context.historicalFactoryCode) : null;
    if (!historicalFactoryCode || historicalFactoryCode.length === 0) problems.push("audited RPC has no canonical historical factory state at the collected window head");
  }
  return problems;
}

export function validateAuditContext(context, report, contract, { requireHistorical = true } = {}) {
  const problems = [...validateIdentityAuditAnchor(context, report, contract), ...validateIdentityStateAvailability(context, { requireHistorical })], fail = text => problems.push(text);
  if (!object(context)) return problems;
  const checkBlock = (block, expectedNumber, expectedTime, label) => {
    if (!object(block) || quantityNumber(block.number) !== expectedNumber || quantityNumber(block.timestamp) === null) {
      fail("audited " + label + " block is malformed or has the wrong number");
      return;
    }
    const millis = quantityNumber(block.timestamp) * 1000;
    let got = null;
    try { got = new Date(millis).toISOString(); } catch {}
    if (expectedTime && got !== expectedTime) fail("audited " + label + " block timestamp differs from the collection");
  };
  checkBlock(context.fromBlock, report.window.from, report.window.from_time, "first");
  checkBlock(context.toBlock, report.window.to, report.window.to_time, "last");
  const fromTimestamp = object(context.fromBlock) ? quantityNumber(context.fromBlock.timestamp) : null;
  const toTimestamp = object(context.toBlock) ? quantityNumber(context.toBlock.timestamp) : null;
  const firstDay = fromTimestamp === null ? null : Math.ceil(fromTimestamp / 86400);
  const lastDay = toTimestamp === null ? null : Math.floor(toTimestamp / 86400);
  const expectedCount = firstDay === null || lastDay === null || lastDay < firstDay ? 0 : lastDay - firstDay + 1;
  const reportedBoundaries = report.verified.day_boundaries;
  if (!Array.isArray(context.boundaries) || context.boundaries.length !== expectedCount) fail("audited day boundary count differs from the endpoint timestamps");
  else for (let i = 0; i < expectedCount; i++) {
    const item = context.boundaries[i], target = (firstDay + i) * 86400;
    const number = object(item) ? item.number : null;
    if (!Array.isArray(reportedBoundaries) || reportedBoundaries[i] !== number) fail("collection day boundary " + i + " differs from the independently derived block");
    if (!object(item) || item.target !== target || !positive(number) || !object(item.block) || !object(item.previous) || quantityNumber(item.block.number) !== number || quantityNumber(item.previous.number) !== number - 1) {
      fail("audited day boundary " + i + " has the wrong adjacent blocks");
      continue;
    }
    const now = quantityNumber(item.block.timestamp), before = quantityNumber(item.previous.timestamp);
    if (now === null || before === null || before > now) { fail("audited day boundary " + i + " has malformed timestamps"); continue; }
    if (now < target || before >= target) fail("audited day boundary " + i + " is not the first block at or after the required UTC midnight");
  }
  if (Array.isArray(reportedBoundaries) && reportedBoundaries.length !== expectedCount) fail("collection day boundary count differs from the endpoint timestamps");
  return problems;
}

export function validateIdentityStateHeader(block, report, label = "identity-state") {
  const problems = [];
  let state;
  try { state = exactIdentityState(report, "collection"); }
  catch (error) { return [error.message]; }
  const number = object(block) ? quantityNumber(block.number) : null;
  const hash = object(block) ? block.hash : null;
  if (number !== state.number || !hexBytes(hash, 32) || /^0x0{64}$/.test(hash)) problems.push(label + " block is malformed or has the wrong number/hash shape");
  else if (hash !== state.hash) problems.push(label + " block hash differs from the collector's recorded identity_state");
  return problems;
}

const argValue = (argv, name) => {
  const at = argv.indexOf("--" + name);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : null;
};
const flag = (argv, name) => argv.includes("--" + name);

export function resolveRpcEndpoint(argv, fallback, env = process.env) {
  const cli = argValue(argv, "rpc"), fromEnv = env && typeof env[RPC_ENV] === "string" && env[RPC_ENV] ? env[RPC_ENV] : null;
  if (cli && fromEnv) throw new Error("choose either --rpc or " + RPC_ENV + ", not both");
  const url = cli || fromEnv || fallback;
  if (!rpcOverrideAllowed(url)) throw new Error("RPC endpoint must be HTTPS with no userinfo, query or fragment (plain HTTP is accepted only on loopback)");
  return { url, source: cli ? "cli" : fromEnv ? "environment" : "default" };
}

export function redactRpcEndpoint(text, url) {
  let output = String(text);
  const secrets = [String(url)];
  try {
    const parsed = new URL(url);
    secrets.push(parsed.origin, parsed.host, parsed.hostname);
    if (parsed.pathname && parsed.pathname !== "/") {
      secrets.push(parsed.pathname);
      try { secrets.push(decodeURIComponent(parsed.pathname)); } catch {}
    }
    for (const segment of parsed.pathname.split("/")) if (segment) {
      secrets.push(segment);
      try { secrets.push(decodeURIComponent(segment)); } catch {}
    }
  } catch {}
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) output = output.split(secret).join("<redacted-rpc>");
  return output;
}

/**
 * Bind every event row—not only the transaction sample—to the finalized endpoint's block header. A JSON-RPC
 * batch keeps this complete check practical over the full historical window; the authored header-batch ceiling is
 * independent of the collector's heavier eth_call batch and every response is still bounded and checked by id.
 */
const cancelBestEffort = target => {
  try {
    const pending = target && typeof target.cancel === "function" ? target.cancel() : null;
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {}
};
const deadlineError = () => {
  const error = new Error("response deadline exceeded");
  error.name = "TimeoutError";
  return error;
};
const withAbort = async (promise, signal) => {
  if (!signal) return await promise;
  if (signal.aborted) throw deadlineError();
  let onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(deadlineError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([promise, stopped]); }
  finally { signal.removeEventListener("abort", onAbort); }
};
const boundedResponseText = async (response, limit, signal = null) => {
  if (!response || !positive(limit)) throw new Error("response bound is invalid");
  const stated = response.headers && typeof response.headers.get === "function" ? response.headers.get("content-length") : null;
  if (stated !== null && (!/^(?:0|[1-9][0-9]*)$/.test(stated) || BigInt(stated) > BigInt(limit))) {
    cancelBestEffort(response.body);
    throw new Error("response content-length exceeds its bound");
  }
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader(), chunks = [];
    let total = 0;
    try {
      while (true) {
        const part = await withAbort(reader.read(), signal);
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw new Error("response stream yielded non-byte data");
        total += part.value.length;
        if (total > limit) { cancelBestEffort(reader); throw new Error("response body exceeds its bound"); }
        chunks.push(part.value);
      }
    } catch (error) {
      cancelBestEffort(reader);
      throw error;
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  // A response-like fallback exists only for the local injected test surface; the real Fetch Response streams.
  if (typeof response.text !== "function") throw new Error("response body is unreadable");
  const text = await withAbort(response.text(), signal);
  if (new TextEncoder().encode(text).length > limit) throw new Error("response body exceeds its bound");
  return text;
};

export async function auditEventBlockHeaders(logs, contract, url, spacingMs, fetchImpl = fetch, retryPolicy = null) {
  if (!Array.isArray(logs) || !contract || !positive(contract.batch) || !rpcOverrideAllowed(url) || !positive(spacingMs) || typeof fetchImpl !== "function" ||
      !object(retryPolicy) || !positive(retryPolicy.cooldownMs) || !positive(retryPolicy.maxCooldownMs) || !positive(retryPolicy.maxRetries)) {
    throw new Error("event block-header audit configuration is invalid");
  }
  const expected = new Map(), expectedNumbers = new Map();
  for (const [index, log] of logs.entries()) {
    const number = object(log) ? quantityNumber(log.blockNumber) : null;
    const hash = object(log) && hexBytes(log.blockHash, 32) && !/^0x0{64}$/.test(log.blockHash) ? log.blockHash : null;
    if (number === null || !hash) throw new Error("event block-header audit received malformed log[" + index + "]");
    const known = expected.get(number);
    if (known && known !== hash) throw new Error("event logs disagree on the hash for block " + number);
    expected.set(number, hash);
    const knownNumber = expectedNumbers.get(hash);
    if (knownNumber !== undefined && knownNumber !== number) throw new Error("event logs reuse one hash for different block numbers");
    expectedNumbers.set(hash, number);
  }
  const blocks = [...expected.entries()].map(([number, hash]) => ({ number, hash }));
  let batches = 0, retries = 0, lastStart = 0;
  for (let start = 0; start < blocks.length; start += EVENT_HEADER_BATCH) {
    const part = blocks.slice(start, start + EVENT_HEADER_BATCH);
    const requests = part.map((block, index) => ({
      jsonrpc: "2.0", id: index + 1, method: "eth_getBlockByNumber", params: ["0x" + block.number.toString(16), false]
    }));
    let payload = null, attempt = 0, cooldown = retryPolicy.cooldownMs;
    while (payload === null) {
      const delay = Math.max(0, lastStart + spacingMs - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      lastStart = Date.now();
      let response = null, retryWhy = null;
      const signal = AbortSignal.timeout(retryPolicy.maxCooldownMs);
      try {
        response = await withAbort(fetchImpl(url, {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json", "user-agent": "lintcha-chain-collection-guard/0.1 (+https://lintcha.com)" },
          body: JSON.stringify(requests),
          signal
        }), signal);
      } catch {
        retryWhy = "network or response timeout";
      }
      batches++;
      if (response && (response.status === 429 || response.status >= 500)) {
        cancelBestEffort(response.body);
        retryWhy = "HTTP " + response.status;
      }
      else if (response && response.status !== 200) {
        cancelBestEffort(response.body);
        throw new Error("event block-header batch returned HTTP " + response.status);
      }
      else if (response) {
        let parsed;
        try { parsed = JSON.parse(await boundedResponseText(response, EVENT_HEADER_BATCH * 65536, signal)); }
        catch (error) {
          if (error && (error.name === "AbortError" || error.name === "TimeoutError")) retryWhy = "response timeout";
          else throw new Error("event block-header batch body was refused: " + error.message);
        }
        if (!retryWhy) {
          const rpcLimited = (object(parsed) && object(parsed.error) && Number(parsed.error.code) === 429) ||
            (Array.isArray(parsed) && parsed.some(reply => object(reply) && object(reply.error) && Number(reply.error.code) === 429));
          if (rpcLimited) retryWhy = "JSON-RPC 429";
          else payload = parsed;
        }
      }
      if (retryWhy) {
        if (++attempt > retryPolicy.maxRetries) throw new Error("event block-header batch gave up after " + attempt + " tries (" + retryWhy + ")");
        retries++;
        await new Promise(resolve => setTimeout(resolve, cooldown));
        cooldown = Math.min(cooldown * 2, retryPolicy.maxCooldownMs);
      }
    }
    if (!Array.isArray(payload) || payload.length !== part.length) throw new Error("event block-header batch returned an incomplete JSON-RPC response");
    const replies = new Map();
    for (const reply of payload) {
      if (!object(reply) || Object.keys(reply).sort().join(",") !== "id,jsonrpc,result" || reply.jsonrpc !== "2.0" || !Number.isSafeInteger(reply.id) || reply.id < 1 || reply.id > part.length || replies.has(reply.id)) {
        throw new Error("event block-header batch returned a malformed or duplicate reply");
      }
      replies.set(reply.id, reply.result);
    }
    for (let index = 0; index < part.length; index++) {
      const wanted = part[index], header = replies.get(index + 1);
      if (!object(header) || quantityNumber(header.number) !== wanted.number || !hexBytes(header.hash, 32) || /^0x0{64}$/.test(header.hash)) {
        throw new Error("event block-header batch returned a malformed header for block " + wanted.number);
      }
      if (header.hash !== wanted.hash) throw new Error("event log hash differs from the finalized endpoint header for block " + wanted.number);
    }
  }
  return { blocks: blocks.length, batches, retries };
}

async function auditLogs(report, contract, rpcUrl, { requireHistorical = true, auditHeaders = true } = {}) {
  const endpoint = rpcUrl || contract.rpc, identityState = exactIdentityState(report, "collection");
  const stateTag = "0x" + identityState.number.toString(16);
  const gate = new Gate({
    url: endpoint,
    inFlight: report.limiter.in_flight,
    spacingMs: report.limiter.spacing_ms,
    logsSpacingMs: report.limiter.logs_spacing_ms,
    log: text => console.error("  collection guard: " + redactRpcEndpoint(text, endpoint))
  });
  const gateCall = gate.call.bind(gate);
  gate.call = (method, params) => gateCall(method, params).catch(error => { throw new Error(redactRpcEndpoint(error && error.message ? error.message : "RPC request failed", endpoint)); });
  const context = { boundaries: [] };
  context.chainId = await gate.call("eth_chainId", []);
  context.finalizedBlock = await gate.call("eth_getBlockByNumber", ["finalized", false]);
  context.identityStateBlock = await gate.call("eth_getBlockByNumber", [stateTag, false]);
  const anchorProblems = validateIdentityAuditAnchor(context, report, contract);
  if (anchorProblems.length) throw new Error("identity-state anchor refused before any identity read:\n  " + anchorProblems.join("\n  "));
  context.fromBlock = await gate.call("eth_getBlockByNumber", ["0x" + report.window.from.toString(16), false]);
  context.toBlock = await gate.call("eth_getBlockByNumber", ["0x" + report.window.to.toString(16), false]);
  context.multicallCode = await gate.call("eth_getCode", [contract.multicall, stateTag]);
  context.identityFactoryCode = await gate.call("eth_getCode", [contract.factory, stateTag]);
  if (requireHistorical) {
    try {
      context.historicalFactoryCode = await gate.call("eth_getCode", [contract.factory, "0x" + report.window.to.toString(16)]);
    } catch (error) {
      throw new Error("audited RPC cannot read historical factory state at block " + report.window.to + ": " + error.message);
    }
  }
  const availabilityProblems = validateIdentityStateAvailability(context, { requireHistorical });
  if (availabilityProblems.length) throw new Error("fixed-state availability refused before the factory log scan:\n  " + availabilityProblems.join("\n  "));
  const blockCache = new Map([[report.window.from, context.fromBlock], [report.window.to, context.toBlock]]);
  const blockAt = async number => {
    if (!blockCache.has(number)) blockCache.set(number, await gate.call("eth_getBlockByNumber", ["0x" + number.toString(16), false]));
    const block = blockCache.get(number);
    if (!object(block) || quantityNumber(block.number) !== number || quantityNumber(block.timestamp) === null) throw new Error("day-boundary search received a malformed block");
    return block;
  };
  const fromTimestamp = quantityNumber(context.fromBlock && context.fromBlock.timestamp), toTimestamp = quantityNumber(context.toBlock && context.toBlock.timestamp);
  if (fromTimestamp === null || toTimestamp === null || toTimestamp < fromTimestamp) throw new Error("endpoint blocks have malformed or decreasing timestamps");
  let lower = report.window.from;
  for (let day = Math.ceil(fromTimestamp / 86400); day <= Math.floor(toTimestamp / 86400); day++) {
    const target = day * 86400;
    let lo = lower, hi = report.window.to;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2), block = await blockAt(mid);
      if (quantityNumber(block.timestamp) < target) lo = mid + 1;
      else hi = mid;
    }
    const number = lo;
    context.boundaries.push({ target, number, block: await blockAt(number), previous: await blockAt(number - 1) });
    lower = number;
  }
  const all = [], layouts = auditLogLayouts(report.window.from, report.window.to, report.verified.chunk_blocks);
  for (const { from, to } of layouts.aligned) {
    const page = await gate.call("eth_getLogs", [{ address: contract.factory, topics: [contract.eventTopic], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
    if (!Array.isArray(page)) throw new Error("factory log page is not an array");
    const pageProblems = validateLaunchLogs(page, contract, from, to, page.length);
    if (pageProblems.length) throw new Error("factory log aligned page refused: " + pageProblems.join("; "));
    for (const log of page) {
      if (all.length >= report.verified.launches_in_log) throw new Error("factory log pages exceed the collector's complete launch count");
      all.push(log);
    }
  }
  const logProblems = validateLaunchLogs(all, contract, report.window.from, report.window.to, report.verified.launches_in_log);
  if (logProblems.length) throw new Error("factory log audit refused before header reads: " + logProblems.join("; "));
  for (const { from, to } of layouts.shifted) {
    const page = await gate.call("eth_getLogs", [{ address: contract.factory, topics: [contract.eventTopic], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
    if (!Array.isArray(page)) throw new Error("alternate factory log page is not an array");
    const pageProblems = validatePartitionPage(page, all, contract, from, to);
    if (pageProblems.length) throw new Error("factory log shifted page refused: " + pageProblems.join("; "));
  }
  const headers = auditHeaders ? await auditEventBlockHeaders(all, contract, gate.url, report.limiter.spacing_ms, fetch, gate) : null;
  return { logs: all, context, gate, headers, layouts, stateTag, stats: gate.stats };
}

async function auditIdentities(logs, contract, gate, stateTag) {
  if (!canonicalQuantity(stateTag) || quantityNumber(stateTag) === null) throw new Error("identity audit requires one canonical numeric block tag");
  const rows = [];
  for (let i = 0; i < logs.length; i += contract.batch) {
    const batch = logs.slice(i, i + contract.batch), calls = [];
    for (const log of batch) {
      const event = eventRow(log), addressWord = event.token.slice(2).padStart(64, "0");
      calls.push(
        [event.token, true, contract.selectors.name],
        [event.token, true, contract.selectors.symbol],
        [event.token, true, contract.selectors.info],
        [contract.factory, true, contract.selectors.launched + addressWord]
      );
    }
    const data = calldata(contract.selectors.aggregate3, [T.array(AGGREGATE3_CALL)], [calls]);
    // Both strict publication and diagnostic reconstruction use the collector's recorded numeric state. Neither
    // path is allowed to substitute `latest`, so every batch belongs to the same canonical snapshot.
    const result = await gate.call("eth_call", [{ to: contract.multicall, data }, stateTag]);
    const decoded = decodeAuditBatch(result, batch, contract);
    if (decoded.problems.length) throw new Error("identity batch at log " + i + " refused: " + decoded.problems.join("; "));
    rows.push(...decoded.rows);
  }
  return rows;
}

export async function auditTransactions(rows, contract, gate, kind) {
  const every = kind === "smoke" ? contract.sample.smoke : contract.sample.regular;
  const selected = new Map();
  for (let i = 0; i < rows.length; i += every) if (!selected.has(rows[i].transactionHash)) {
    selected.set(rows[i].transactionHash, await gate.call("eth_getTransactionByHash", [rows[i].transactionHash]));
  }
  const destinations = new Set();
  let sampled = 0, decodedCount = 0, nameSymbolMatches = 0, rawRecipientMatches = 0,
    socialsMatches = 0, senderMatches = 0, strictSupported = 0, unsupportedOuterCalls = 0;
  for (const row of rows) if (selected.has(row.transactionHash)) {
    sampled++;
    const transaction = selected.get(row.transactionHash), label = "transaction for " + row.transactionHash;
    if (!object(transaction) || transaction.hash !== row.transactionHash || quantityNumber(transaction.blockNumber) !== row.block || transaction.blockHash !== row.blockHash) {
      throw new Error(label + " does not identify the sampled factory event and block");
    }
    const from = typeof transaction.from === "string" && /^0x[0-9a-f]{40}$/.test(transaction.from) ? transaction.from : null;
    const to = typeof transaction.to === "string" && /^0x[0-9a-f]{40}$/.test(transaction.to) && !/^0x0{40}$/.test(transaction.to) ? transaction.to : null;
    if (!from || !to || typeof transaction.input !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(transaction.input) || transaction.input.length < 10) {
      throw new Error(label + " has malformed sender, destination or calldata");
    }

    // Reproduce the pinned collector's deliberately shallow counter pass exactly. These counters describe how
    // often the first calldata value happened to decode as TokenParams; they are not used as product facts.
    let raw = null;
    try { raw = decodeParams([TOKEN_PARAMS], "0x" + transaction.input.slice(10))[0]; } catch {}
    if (raw) {
      decodedCount++;
      destinations.add(to);
      const consistent = raw[0] === row.name && raw[1] === row.symbol;
      if (consistent) {
        nameSymbolMatches++;
        if (String(raw[5]).toLowerCase() === row.recipient) rawRecipientMatches++;
      }
      if (JSON.stringify(raw[4]) === JSON.stringify(row.socials)) socialsMatches++;
      if (from === row.deployer) senderMatches++;
    }

    const selectorValue = transaction.input.slice(0, 10), knownSelector = contract.launchCalls.some(call => call.selector === selectorValue);
    const knownDestination = to === contract.factory || to === contract.forwarder;
    if (knownSelector || knownDestination) {
      const decoded = decodeSampleTransaction(transaction, row, contract);
      if (decoded.problems.length) throw new Error(label + " refused: " + decoded.problems.join("; "));
      const params = decoded.value;
      if (params.name !== row.name || params.symbol !== row.symbol) throw new Error("sampled direct transaction name or symbol differs from the strict token return");
      if (params.logo !== row.logo || params.description !== row.description) throw new Error("sampled direct transaction logo or description differs from the strict token return");
      if (JSON.stringify(params.socials) !== JSON.stringify(row.socials)) throw new Error("sampled direct transaction socials differ from the strict token return");
      // creatorFeeRecipient is mutable after launch, so even the exact finalized snapshot used by the collector may
      // be later than the event and cannot prove what TokenParams established. Re-read the record at the canonical
      // event block for exact direct calls.
      const historicalCall = contract.selectors.launched + row.token.slice(2).padStart(64, "0");
      const historicalBytes = byteString(await gate.call("eth_call", [{ to: contract.factory, data: historicalCall }, "0x" + row.block.toString(16)]));
      const historicalRecord = launchRecord(historicalBytes, row, "historical factory record for " + row.transactionHash);
      if (params.effectiveRecipient !== historicalRecord.creatorFeeRecipient) throw new Error("sampled direct transaction effective recipient differs from its launch-block factory record");
      strictSupported++;
    } else {
      unsupportedOuterCalls++;
    }
  }
  return {
    sampled_transactions: sampled,
    calldata_decoded_as_TokenParams: decodedCount,
    calldata_name_symbol_equal_onchain: nameSymbolMatches,
    calldata_recipient_equals_factory_record_when_consistent: rawRecipientMatches,
    calldata_socials_equal_onchain: socialsMatches,
    tx_from_equals_deployer: senderMatches,
    tx_to_distinct: destinations.size,
    strict_supported_outer_calls: strictSupported,
    classified_unsupported_outer_calls: unsupportedOuterCalls
  };
}

export function validateTransactionAudit(audit, report) {
  const problems = [];
  for (const key of ["sampled_transactions", "calldata_decoded_as_TokenParams", "calldata_name_symbol_equal_onchain", "calldata_recipient_equals_factory_record_when_consistent", "calldata_socials_equal_onchain", "tx_from_equals_deployer", "tx_to_distinct"]) {
    if (!object(audit) || audit[key] !== report.verified[key]) problems.push("strict transaction re-read disagrees on " + key);
  }
  if (object(audit) && (!safe(audit.strict_supported_outer_calls) || !safe(audit.classified_unsupported_outer_calls) || audit.strict_supported_outer_calls + audit.classified_unsupported_outer_calls !== audit.sampled_transactions)) problems.push("transaction outer-call classification is incomplete");
  return problems;
}

async function main(argv) {
  const allowed = new Set(["--in", "--published", "--audit-logs", "--diagnose-semantic", "--rpc"]);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (!allowed.has(argv[i])) throw new Error("unknown argument " + argv[i]);
    if (seen.has(argv[i])) throw new Error("duplicate argument " + argv[i]);
    seen.add(argv[i]);
    if (argv[i] === "--in" || argv[i] === "--published" || argv[i] === "--rpc") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(argv[i] + " needs a value");
      i++;
    }
  }
  const input = argValue(argv, "in"), publishedPath = argValue(argv, "published");
  if (!input || !publishedPath) throw new Error("usage: --in FILE --published FILE (--audit-logs | --diagnose-semantic) [--rpc URL]; credential-bearing endpoints belong in " + RPC_ENV);
  const strictMode = flag(argv, "audit-logs"), diagnosticMode = flag(argv, "diagnose-semantic");
  if (strictMode === diagnosticMode) throw new Error("exactly one of --audit-logs or --diagnose-semantic is required");
  const source = fs.readFileSync(COLLECTOR, "utf8"), contract = collectorContract(source);
  const report = JSON.parse(fs.readFileSync(path.resolve(input), "utf8"));
  const published = JSON.parse(fs.readFileSync(path.resolve(publishedPath), "utf8"));
  const problems = validateCollection(report, published, contract);
  if (problems.length) throw new Error("collection facts refused:\n  " + problems.join("\n  "));
  const rpc = resolveRpcEndpoint(argv, contract.rpc);
  if (rpc.source === "cli") console.error("  collection guard: warning: --rpc is visible in the process argument list; use " + RPC_ENV + " for a credential-bearing endpoint");
  console.log("collection facts: the collector reports a complete log and matching record/transaction checks");
  if (diagnosticMode) {
    const audited = await auditLogs(report, contract, rpc.url, { requireHistorical: false, auditHeaders: false });
    const contextProblems = validateAuditContext(audited.context, report, contract, { requireHistorical: false });
    if (contextProblems.length) throw new Error("diagnostic chain context refused:\n  " + contextProblems.join("\n  "));
    const logProblems = validateLaunchLogs(audited.logs, contract, report.window.from, report.window.to, report.verified.launches_in_log);
    if (logProblems.length) throw new Error("diagnostic factory log read refused:\n  " + logProblems.join("\n  "));
    const rows = await auditIdentities(audited.logs, contract, audited.gate, audited.stateTag);
    const stateAfter = await audited.gate.call("eth_getBlockByNumber", [audited.stateTag, false]);
    const stateProblems = validateIdentityStateHeader(stateAfter, report, "diagnostic post-read identity-state");
    if (stateProblems.length) throw new Error("diagnostic identity-state recheck refused:\n  " + stateProblems.join("\n  "));
    const boundaryDates = {
      first: report.window.from_time.slice(0, 10),
      boundaries: audited.context.boundaries.map(item => ({ block: item.number, date: new Date(quantityNumber(item.block.timestamp) * 1000).toISOString().slice(0, 10) }))
    };
    const semantic = await buildSemanticAudit(rows, boundaryDates);
    const semanticProblems = validateSemanticAudit(semantic, report);
    const state = exactIdentityState(report, "collection");
    console.log("diagnostic identity read: exact recorded finalized state " + state.number + " / " + state.hash + "; " + audited.logs.length + " canonical launch rows; calls " + audited.stats.calls);
    if (semanticProblems.length) throw new Error("diagnostic-only exact recorded identity read differs from the collector:\n  " + semanticProblems.join("\n  "));
    console.log("diagnostic-only identity reconstruction matches the report; this is not publication proof because event-header batches and sampled transactions were skipped");
  }
  if (strictMode) {
    const audited = await auditLogs(report, contract, rpc.url);
    const contextProblems = validateAuditContext(audited.context, report, contract);
    if (contextProblems.length) throw new Error("chain context audit refused:\n  " + contextProblems.join("\n  "));
    const logProblems = validateLaunchLogs(audited.logs, contract, report.window.from, report.window.to, report.verified.launches_in_log);
    if (logProblems.length) throw new Error("factory log audit refused:\n  " + logProblems.join("\n  "));
    const rows = await auditIdentities(audited.logs, contract, audited.gate, audited.stateTag);
    const stateAfter = await audited.gate.call("eth_getBlockByNumber", [audited.stateTag, false]);
    const stateProblems = validateIdentityStateHeader(stateAfter, report, "strict post-read identity-state");
    if (stateProblems.length) throw new Error("strict identity-state recheck refused:\n  " + stateProblems.join("\n  "));
    const boundaryDates = {
      first: report.window.from_time.slice(0, 10),
      boundaries: audited.context.boundaries.map(item => ({ block: item.number, date: new Date(quantityNumber(item.block.timestamp) * 1000).toISOString().slice(0, 10) }))
    };
    const semantic = await buildSemanticAudit(rows, boundaryDates);
    const semanticProblems = validateSemanticAudit(semantic, report);
    let transactions = null, transactionProblems = [];
    try {
      transactions = await auditTransactions(rows, contract, audited.gate, report.window.kind);
      transactionProblems = validateTransactionAudit(transactions, report);
    } catch (error) {
      transactionProblems.push("transaction audit could not complete: " + error.message);
    }
    const strictProblems = [
      ...semanticProblems.map(problem => "semantic: " + problem),
      ...transactionProblems.map(problem => "transaction: " + problem)
    ];
    if (strictProblems.length) throw new Error("strict chain audit refused:\n  " + strictProblems.join("\n  "));
    console.log("chain context audit: chain, endpoint block timestamps, current finalized floor and recorded identity-state number/hash agree");
    console.log("factory log audit: " + audited.logs.length + " unique, canonical rows over the collected range; same endpoint with " + audited.layouts.aligned.length + " aligned and " + audited.layouts.shifted.length + " shifted alternate-partition pages (not an independent provider); calls " + audited.stats.calls + "; headers " + audited.headers.blocks + " in " + audited.headers.batches + " batches, retries " + audited.headers.retries);
    console.log("identity audit: every strict token return and factory record rebuilds the collected tables and summary");
    console.log("transaction audit: " + transactions.sampled_transactions + " sampled transaction identities reproduce the collector counters; " + transactions.strict_supported_outer_calls + " exact verified outer calls strictly match the event, token return and launch-block factory record; " + transactions.classified_unsupported_outer_calls + " other outer calls are classified, not interpreted");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error("collection guard: " + error.message); process.exit(1); });
}
