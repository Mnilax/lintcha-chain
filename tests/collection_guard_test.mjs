// The owned publication guard around the pinned collector: it refuses partial/malformed facts, malformed or
// duplicated factory logs, and a second RPC read that does not agree on chain, blocks, timestamps and finality.
// No network is used here; the collector source supplies the contract instead of fixtures copying its constants.
//   node tests/collection_guard_test.mjs
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { AGGREGATE3_RESULT, T, TOKEN_INFO, TOKEN_PARAMS, calldata, encode } from "../tools/launch/abi.mjs";
import { hex } from "../tools/launch/keccak.mjs";
import { Gate } from "../tools/launch/rpc.mjs";
import { RPC_ENV, auditEventBlockHeaders, auditLogLayouts, auditTransactions, buildSemanticAudit, collectorContract, decodeAuditBatch, decodeSampleTransaction, exactIdentityState, redactRpcEndpoint, resolveRpcEndpoint, rpcOverrideAllowed, validateAuditContext, validateCollection, validateIdentityStateHeader, validateLaunchLogs, validatePartitionPage, validateSemanticAudit, validateTransactionAudit } from "../tools/collection-guard.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, "..");
const require = createRequire(import.meta.url), L = require(path.join(root, "site", "launch.js"));
let checks = 0, failures = 0;
const ok = (condition, what) => { checks++; if (!condition) { failures++; console.error("FAIL " + what); } };
const has = (problems, text, what) => ok(problems.some(problem => problem.includes(text)), what + ": " + JSON.stringify(problems));
const clone = value => structuredClone(value);
const source = fs.readFileSync(path.join(root, "tools", "launch-collect.mjs"), "utf8");
const contract = collectorContract(source);

ok(contract && Number.isSafeInteger(contract.chainId), "reads the chain id from the pinned collector source");
ok(contract && /^0x[0-9a-f]{40}$/.test(contract.factory), "reads the factory from the pinned collector source");
ok(contract && /^0x[0-9a-f]{40}$/.test(contract.forwarder), "pins the exact-match launch forwarder instead of trusting an owner-rotatable latest getter");
ok(contract && /^0x[0-9a-f]{64}$/.test(contract.eventTopic), "derives the event topic from the pinned signature");
ok(contract && new URL(contract.rpc).protocol === "https:", "reads the public RPC from the pinned collector source");
ok(contract && contract.batch > 0 && contract.chunk > 0 && contract.sample.regular > 0 && contract.limiter.spacingMs > 0, "reads batch, chunk, sample and limiter bounds from the pinned collector source");
ok(collectorContract(source.replace("const CHAIN_ID", "const WRONG_CHAIN_ID")) === null, "refuses collector source whose contract cannot be extracted exactly");
const sourceWithEnvironmentRpc = source.replace(/const RPC = opt\("rpc", "https:\/\/[^"\s]+"\);/, `const DEFAULT_RPC = "${contract.rpc}";`);
ok(sourceWithEnvironmentRpc.includes("const DEFAULT_RPC") && collectorContract(sourceWithEnvironmentRpc)?.rpc === contract.rpc, "reads the default endpoint from the source-first environment-RPC collector shape");
ok(rpcOverrideAllowed("https://rpc.example.invalid") && rpcOverrideAllowed("http://127.0.0.1:8545"), "accepts HTTPS RPC and exact loopback HTTP for the local harness");
ok(!rpcOverrideAllowed("http://rpc.example.invalid") && !rpcOverrideAllowed("https://user:secret@rpc.example.invalid"), "refuses plaintext remote RPC and credential-bearing URLs");
ok(!rpcOverrideAllowed("https://rpc.example.invalid/?api_key=secret") && !rpcOverrideAllowed("https://rpc.example.invalid/#secret"), "refuses RPC overrides whose query or fragment could expose a secret in process output");
const environmentSecret = "environment-secret-sentinel";
const selectedEnvironment = resolveRpcEndpoint([], contract.rpc, { [RPC_ENV]: "https://rpc.example.invalid/" + environmentSecret });
ok(selectedEnvironment.source === "environment" && selectedEnvironment.url.endsWith(environmentSecret), "selects a credential-bearing endpoint from the dedicated environment variable");
let conflictingRpc = false;
try { resolveRpcEndpoint(["--rpc", contract.rpc], contract.rpc, { [RPC_ENV]: "https://rpc.example.invalid/" + environmentSecret }); } catch (error) { conflictingRpc = error.message.includes("either"); }
ok(conflictingRpc, "refuses ambiguous simultaneous CLI and environment endpoints");
ok(!redactRpcEndpoint("transport exposed https://rpc.example.invalid/" + environmentSecret, selectedEnvironment.url).includes(environmentSecret), "redacts the endpoint and its path credential from diagnostics");
ok(!redactRpcEndpoint("provider reflected /ab/cd", "https://rpc.example.invalid/ab/cd").includes("/ab/cd"), "redacts a complete credential path even when each segment is short");
ok(!redactRpcEndpoint("provider reflected endpoint-secret-sentinel.example.invalid", "https://endpoint-secret-sentinel.example.invalid/").includes("endpoint-secret-sentinel"), "redacts a credential-bearing endpoint hostname from diagnostics");

const tables = Object.fromEntries(L.NAMESPACES.map(namespace => [namespace, {}]));
tables.ticker["a".repeat(16)] = { n: 2, d: 2, first: "2026-09-10" };
tables.ticker_skeleton["b".repeat(16)] = { n: 2, d: 2, first: "2026-09-10", v: 2 };
const report = {
  identity_state: { number: 12, hash: "0x" + "7".repeat(64) },
  window: { kind: "day", from: 10, to: 12, blocks: 3, from_time: "2026-09-10T00:00:01.000Z", to_time: "2026-09-10T00:00:03.000Z", finalized: 12, chain_id: contract.chainId },
  six: {
    launches_scanned: 2,
    launches_with_a_link: { count: 1, share: 50 },
    distinct_link_values: { folded: 1, raw: 1 },
    link_values_by_more_than_one_deployer: { folded: 0, raw: 0 },
    tickers_by_more_than_one_deployer: 1,
    lookalike_ticker_pairs: { pairs: 1, skeleton_groups: 1 }
  },
  also: {
    names_by_more_than_one_deployer: 0,
    logos_by_more_than_one_deployer: 0,
    recipients_by_more_than_one_deployer: 0,
    descriptions_compared: 0,
    descriptions_by_more_than_one_deployer: 0,
    lookalike_name_groups: 0,
    lookalike_ticker_groups_v: 1
  },
  verified: {
    multicall3_has_code: true,
    launches_in_log: 2,
    tokens_readable: 2,
    getTokenInfo_deployer_equals_event_deployer: 2,
    factory_record_exists: 2,
    factory_record_deployer_equals_event_deployer: 2,
    fee_recipient_set: 1,
    sampled_transactions: 1,
    calldata_decoded_as_TokenParams: 1,
    calldata_name_symbol_equal_onchain: 1,
    calldata_recipient_equals_factory_record_when_consistent: 1,
    calldata_socials_equal_onchain: 1,
    tx_from_equals_deployer: 1,
    tx_to_distinct: 1,
    day_boundaries: [],
    chunk_blocks: contract.chunk
  },
  limiter: {
    calls: 13, http429: 0, rpc429: 0, retries: 0, otherErrors: 0,
    byMethod: { eth_chainId: 1, eth_getLogs: 2, eth_call: 10 },
    firstAt: 1, lastAt: 2, in_flight: contract.limiter.inFlight, spacing_ms: contract.limiter.spacingMs, logs_spacing_ms: contract.limiter.logsSpacingMs, seconds: 1
  },
  tables
};
const published = { chain_id: contract.chainId, launches_scanned: 2 };
ok(validateCollection(report, published, contract).length === 0, "accepts one internally complete collection fixture");
ok(exactIdentityState(report, "fixture").number === report.window.finalized, "reads the report's exact finalized identity state");

const collectionCase = (what, change, phrase) => {
  const value = clone(report), baseline = clone(published);
  change(value, baseline);
  has(validateCollection(value, baseline, contract), phrase, what);
};
collectionCase("refuses an empty range", value => { value.window.to = value.window.from; value.window.blocks = 1; }, "range");
collectionCase("refuses a chain mismatch", value => { value.window.chain_id++; }, "chain id");
collectionCase("refuses a claimed unfinalized range", value => { value.window.finalized = value.window.to - 1; }, "finalized");
collectionCase("refuses a legacy report without an identity state", value => { delete value.identity_state; }, "new guarded refresh");
collectionCase("refuses a zero identity-state hash", value => { value.identity_state.hash = "0x" + "0".repeat(64); }, "malformed exact finalized");
collectionCase("refuses an identity state that differs from the stated finalized head", value => { value.identity_state.number++; }, "exactly bind");
collectionCase("refuses a partial token read", value => { value.verified.tokens_readable--; }, "exactly once");
collectionCase("refuses a record that was not proved for every launch", value => { value.verified.factory_record_exists--; }, "factory_record_exists");
const partialCounters = clone(report);
Object.assign(partialCounters.verified, { calldata_name_symbol_equal_onchain: 0, calldata_recipient_equals_factory_record_when_consistent: 0, calldata_socials_equal_onchain: 0, tx_from_equals_deployer: 0 });
ok(validateCollection(partialCounters, published, contract).length === 0, "accepts truthful partial transaction counters instead of asserting every outer call is direct");
collectionCase("refuses decoded calldata above the sample", value => { value.verified.calldata_decoded_as_TokenParams = 2; }, "decoded count");
collectionCase("refuses a recipient consistency count above matching names", value => { value.verified.calldata_name_symbol_equal_onchain = 0; }, "recipient consistency");
collectionCase("refuses a deployer counter above decoded calldata", value => { value.verified.calldata_decoded_as_TokenParams = 0; }, "tx_from");
collectionCase("refuses an invalid sample destination count", value => { value.verified.tx_to_distinct = 2; }, "destination");
collectionCase("refuses a forged link share", value => { value.six.launches_with_a_link.share = 49; }, "link count or share");
collectionCase("refuses shared link counts above distinct", value => { value.six.link_values_by_more_than_one_deployer.raw = 2; }, "exceed");
collectionCase("refuses zero request spacing", value => { value.limiter.spacing_ms = 0; }, "limiter");
collectionCase("refuses concurrency above the pinned default", value => { value.limiter.in_flight = contract.limiter.inFlight + 1; }, "differs");
collectionCase("refuses ordinary spacing below the pinned default", value => { value.limiter.spacing_ms = contract.limiter.spacingMs - 1; }, "differs");
collectionCase("refuses an overflowing timer presented as tighter spacing", value => { value.limiter.spacing_ms = Number.MAX_SAFE_INTEGER; }, "differs");
collectionCase("refuses a log chunk above the pinned default", value => { value.verified.chunk_blocks = contract.chunk + 1; }, "chunk size");
collectionCase("refuses call counts that do not add up", value => { value.limiter.byMethod.eth_call--; }, "do not add up");
collectionCase("refuses a normalized but impossible UTC date", value => { value.window.from_time = "2026-02-30T00:00:00.000Z"; }, "canonical UTC");
collectionCase("refuses a table outside the engine namespace set", value => { value.tables.extra = {}; }, "exact engine namespaces");
collectionCase("refuses a malformed counted hash", value => { value.tables.ticker.short = value.tables.ticker["a".repeat(16)]; }, "invalid counted hash");
collectionCase("refuses a count above readable launches", value => { value.tables.ticker["a".repeat(16)].n = 3; }, "invalid counted hash");
collectionCase("refuses v outside a skeleton table", value => { value.tables.ticker["a".repeat(16)].v = 1; }, "spelling count");
collectionCase("refuses an invalid published chain baseline", (value, baseline) => { baseline.chain_id++; }, "published chain id");
collectionCase("refuses a run below the existing collection floor", (value, baseline) => { baseline.launches_scanned = 5; }, "below half");

const word = hex => hex.replace(/^0x/, "").padStart(64, "0");
const address = byte => "0x" + byte.repeat(20);
const addressWord = value => "0x" + word(value);
const quantity = value => "0x" + value.toString(16);
const makeLog = (token, block = 10, index = 0) => ({
  address: contract.factory,
  removed: false,
  topics: [contract.eventTopic, addressWord(token), addressWord(address("22")), addressWord(address("33"))],
  data: "0x" + word(address("44")) + word("1") + word("2"),
  blockNumber: quantity(block),
  transactionIndex: quantity(index),
  logIndex: quantity(index),
  transactionHash: address("55") + "55".repeat(12),
  blockHash: address("66") + "66".repeat(12)
});
const log = makeLog(address("11"));
ok(validateLaunchLogs([log], contract, 10, 12, 1).length === 0, "accepts one canonical factory event row");
has(validateLaunchLogs([log, clone(log)], contract, 10, 12, 2), "repeats a factory log position", "refuses a repeated log position");
has(validateLaunchLogs([log, makeLog(address("11"), 11, 0)], contract, 10, 12, 2), "repeats a launched token", "refuses the same token at another position");
has(validateLaunchLogs([makeLog(address("12"), 11, 0), log], contract, 10, 12, 2), "canonical ascending", "refuses logs returned out of canonical block/log order");
const forkedSameBlock = makeLog(address("12"), 10, 1); forkedSameBlock.blockHash = "0x" + "7".repeat(64);
has(validateLaunchLogs([log, forkedSameBlock], contract, 10, 12, 2), "block hash", "refuses mixed-fork hashes within one event block");
has(validateLaunchLogs([log, makeLog(address("12"), 11, 0)], contract, 10, 12, 2), "reuses one block hash", "refuses one block hash reused for two block numbers");
const wrongFactory = clone(log); wrongFactory.address = address("77");
has(validateLaunchLogs([wrongFactory], contract, 10, 12, 1), "wrong factory", "refuses a log from another address");
const wrongTopic = clone(log); wrongTopic.topics[0] = "0x" + "0".repeat(64);
has(validateLaunchLogs([wrongTopic], contract, 10, 12, 1), "topic shape", "refuses another event topic");
const zeroPair = clone(log); zeroPair.data = "0x" + word("0") + word("1") + word("2");
ok(validateLaunchLogs([zeroPair], contract, 10, 12, 1).length === 0, "accepts the canonical zero address used for a native pair token");
const highPair = clone(log); highPair.data = "0x" + "1".repeat(64) + word("1") + word("2");
has(validateLaunchLogs([highPair], contract, 10, 12, 1), "event data", "refuses high bits in a pair-token address word");
const noBlockHash = clone(log); noBlockHash.blockHash = "0x" + "0".repeat(64);
has(validateLaunchLogs([noBlockHash], contract, 10, 12, 1), "factory position", "refuses a zero block hash");
const noTransactionIndex = clone(log); delete noTransactionIndex.transactionIndex;
has(validateLaunchLogs([noTransactionIndex], contract, 10, 12, 1), "factory position", "refuses a missing transaction index before canonical comparison");
has(validateLaunchLogs([makeLog(address("11"), 13)], contract, 10, 12, 1), "outside", "refuses a log outside the collected range");
has(validateLaunchLogs([log], contract, 10, 12, 2), "count", "refuses a second-read count mismatch");
const layouts = auditLogLayouts(report.window.from, report.window.from + contract.chunk * 2, contract.chunk);
ok(layouts.size === Math.floor(contract.chunk / 2), "derives a smaller audit page from the collector's pinned page size");
ok(layouts.aligned[0].to !== layouts.shifted[0].to && layouts.aligned[1].from !== layouts.shifted[1].from, "shifts the second audit layout across aligned page boundaries");
let badLayoutRejected = false;
try { auditLogLayouts(report.window.to, report.window.from, contract.chunk); } catch { badLayoutRejected = true; }
ok(badLayoutRejected, "refuses an inverted alternate-partition range");
const nextLog = makeLog(address("12"), 10, 1), partitionBaseline = [log, nextLog];
ok(validatePartitionPage(clone(partitionBaseline), partitionBaseline, contract, 10, 10).length === 0, "accepts an exact canonical alternate-partition page");
has(validatePartitionPage([log], partitionBaseline, contract, 10, 10), "count", "detects an omission at an alternate page boundary");
has(validatePartitionPage([...partitionBaseline, makeLog(address("13"), 10, 2)], partitionBaseline, contract, 10, 10), "count", "detects an extra row in an alternate page");
has(validatePartitionPage([nextLog, log], partitionBaseline, contract, 10, 10), "canonical ascending", "detects reordered alternate rows before comparing sets");
has(validatePartitionPage([log, clone(log)], partitionBaseline, contract, 10, 10), "repeats", "detects duplicate alternate rows before comparing sets");
const driftedPartition = clone(partitionBaseline); driftedPartition[1].data = "0x" + word(address("44")) + word("1") + word("3");
has(validatePartitionPage(driftedPartition, partitionBaseline, contract, 10, 10), "projection", "detects event-data drift even when position and token identities still match");
const retopicedPartition = clone(partitionBaseline); retopicedPartition[1].topics[2] = addressWord(address("77"));
has(validatePartitionPage(retopicedPartition, partitionBaseline, contract, 10, 10), "projection", "detects topic drift even when position and token identities still match");
const reindexedPartition = clone(partitionBaseline); reindexedPartition[1].transactionIndex = quantity(2);
has(validatePartitionPage(reindexedPartition, partitionBaseline, contract, 10, 10), "projection", "detects transaction-position drift even when the token and log index still match");
let headerRedirectPolicy = null;
const headerResponse = hash => async (_url, options) => ({ status: 200, text: async () => {
  headerRedirectPolicy = options.redirect;
  const requests = JSON.parse(options.body);
  return JSON.stringify(requests.map(request => ({ jsonrpc: "2.0", id: request.id, result: { number: request.params[0], hash } })));
} });
const headerRetryPolicy = new Gate({ url: "http://127.0.0.1:1" });
const headerAudit = await auditEventBlockHeaders([log], contract, "http://127.0.0.1:1", report.limiter.spacing_ms, headerResponse(log.blockHash), headerRetryPolicy);
ok(headerAudit.blocks === 1 && headerAudit.batches === 1 && headerAudit.retries === 0, "binds every unique event block to an exact header batch reply");
ok(headerRedirectPolicy === "error", "event header batches refuse redirects for an endpoint that may carry a path credential");
let headerAttempts = 0, cancelledHeaderBodies = 0;
const retryingHeaderResponse = async (url, options) => ++headerAttempts === 1 ? { status: 429, body: { cancel: () => { cancelledHeaderBodies++; return new Promise(() => {}); } } } : headerResponse(log.blockHash)(url, options);
const retryAudit = await auditEventBlockHeaders([log], contract, "http://127.0.0.1:1", report.limiter.spacing_ms, retryingHeaderResponse, {
  cooldownMs: report.limiter.firstAt, maxCooldownMs: report.limiter.lastAt, maxRetries: report.limiter.firstAt
});
ok(retryAudit.blocks === 1 && retryAudit.batches === 2 && retryAudit.retries === 1 && cancelledHeaderBodies === 1, "a never-settling cancellation cannot block retrying a rate-limited header batch within the pinned gate policy");
const manyHeaderLogs = Array.from({ length: 101 }, (_, index) => {
  const row = makeLog("0x" + (index + 1).toString(16).padStart(40, "0"), index + 10, 0);
  row.blockHash = "0x" + (index + 10).toString(16).padStart(64, "0");
  return row;
});
const manyHashes = new Map(manyHeaderLogs.map(row => [row.blockNumber, row.blockHash]));
const manyHeaderResponse = async (_url, options) => ({ status: 200, text: async () => JSON.stringify(JSON.parse(options.body).map(request => ({
  jsonrpc: "2.0", id: request.id, result: { number: request.params[0], hash: manyHashes.get(request.params[0]) }
}))) });
const manyHeaderAudit = await auditEventBlockHeaders(manyHeaderLogs, contract, "http://127.0.0.1:1", report.limiter.firstAt, manyHeaderResponse, headerRetryPolicy);
ok(manyHeaderAudit.blocks === 101 && manyHeaderAudit.batches === 2, "keeps a complete header audit inside the authored batch ceiling");
await (async () => {
  try { await auditEventBlockHeaders([log], contract, "http://127.0.0.1:1", report.limiter.spacing_ms, headerResponse("0x" + "7".repeat(64)), headerRetryPolicy); ok(false, "refuses an event hash from another canonical header"); }
  catch (error) { ok(error.message.includes("differs"), "refuses an event hash from another canonical header"); }
})();
await (async () => {
  const wrongVersion = async (_url, options) => ({ status: 200, text: async () => JSON.stringify(JSON.parse(options.body).map(request => ({ jsonrpc: "1.0", id: request.id, result: { number: request.params[0], hash: log.blockHash } }))) });
  try { await auditEventBlockHeaders([log], contract, "http://127.0.0.1:1", report.limiter.spacing_ms, wrongVersion, headerRetryPolicy); ok(false, "refuses a non-v2 JSON-RPC header envelope"); }
  catch (error) { ok(error.message.includes("malformed"), "refuses a non-v2 JSON-RPC header envelope"); }
})();
await (async () => {
  const oversized = async () => ({ status: 200, headers: { get: () => String(Number.MAX_SAFE_INTEGER) }, text: async () => "[]" });
  try { await auditEventBlockHeaders([log], contract, "http://127.0.0.1:1", report.limiter.spacing_ms, oversized, headerRetryPolicy); ok(false, "refuses an oversized declared header response before parsing it"); }
  catch (error) { ok(error.message.includes("content-length"), "refuses an oversized declared header response before parsing it"); }
})();
await (async () => {
  const hangingFetch = async () => new Promise(() => {});
  const shortPolicy = { cooldownMs: 1, maxCooldownMs: 1, maxRetries: 1 };
  const keepAlive = setTimeout(() => {}, 100);
  try { await auditEventBlockHeaders([log], contract, "http://127.0.0.1:1", report.limiter.firstAt, hangingFetch, shortPolicy); ok(false, "times out a header fetch that ignores its abort signal"); }
  catch (error) { ok(error.message.includes("gave up"), "a request deadline releases the audit even when fetch ignores its abort signal"); }
  finally { clearTimeout(keepAlive); }
})();
await (async () => {
  let cancelled = 0;
  const overflowing = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(6553601)); },
    cancel() { cancelled++; return new Promise(() => {}); }
  }), { status: 200 });
  try { await auditEventBlockHeaders([log], contract, "http://127.0.0.1:1", report.limiter.spacing_ms, overflowing, headerRetryPolicy); ok(false, "refuses a streamed header response above its bound"); }
  catch (error) { ok(error.message.includes("exceeds") && cancelled === 1, "a never-settling stream cancellation cannot block refusing an oversized header response"); }
})();
await (async () => {
  let cancelled = 0;
  const hanging = async () => new Response(new ReadableStream({
    start() {},
    cancel() { cancelled++; return new Promise(() => {}); }
  }), { status: 200 });
  const shortPolicy = { cooldownMs: 1, maxCooldownMs: 1, maxRetries: 1 };
  const keepAlive = setTimeout(() => {}, 100);
  try { await auditEventBlockHeaders([log], contract, "http://127.0.0.1:1", report.limiter.firstAt, hanging, shortPolicy); ok(false, "times out a header response body that never settles"); }
  catch (error) { ok(error.message.includes("gave up") && cancelled === 2, "a response-body deadline releases the audit even when cancellation never settles"); }
  finally { clearTimeout(keepAlive); }
})();

const encoded = value => "0x" + hex(value);
const event = { token: address("11"), curve: address("22"), deployer: address("33"), pairToken: address("44"), launchConfigId: 1n, graduationThreshold: 2n };
const recordWords = [event.token, event.curve, event.deployer, address("77"), event.pairToken, "2", "2", "3", "4", "0", "5", "6", "7", "8", "1"].map(word).join("");
const nameReturn = encoded(encode(T.tuple(T.string), ["Example name"]));
const symbolReturn = encoded(encode(T.tuple(T.string), ["EXAMPLE"]));
const infoReturn = encoded(encode(T.tuple(...TOKEN_INFO), [event.deployer, "ipfs://example", "a valid description", ["@one", "", "", "https://example.test", ""]]));
const recordReturn = "0x" + recordWords;
const aggregateOf = parts => encoded(encode(T.tuple(AGGREGATE3_RESULT), [parts.map(value => [true, value])]));
const aggregate = aggregateOf([nameReturn, symbolReturn, infoReturn, recordReturn]);
const changedNameReturn = encoded(encode(T.tuple(T.string), ["Different example name"]));
const changedNameAggregate = aggregateOf([changedNameReturn, symbolReturn, infoReturn, recordReturn]);
const decoded = decodeAuditBatch(aggregate, [log], contract);
ok(decoded.problems.length === 0 && decoded.rows.length === 1, "strictly decodes the four returns for the exact factory event");
ok(decoded.rows[0] && decoded.rows[0].name === "Example name" && decoded.rows[0].symbol === "EXAMPLE" && decoded.rows[0].deployer === event.deployer, "binds strict token metadata to the event deployer");
const zeroPairRecord = [event.token, event.curve, event.deployer, address("77"), address("00"), "2", "2", "3", "4", "0", "5", "6", "7", "8", "1"].map(word).join("");
ok(decodeAuditBatch(aggregateOf([nameReturn, symbolReturn, infoReturn, "0x" + zeroPairRecord]), [zeroPair], contract).problems.length === 0, "binds a native zero pair consistently across the event and factory record");
const otherRecord = [address("99"), ...[event.curve, event.deployer, address("77"), event.pairToken, "2", "2", "3", "4", "0", "5", "6", "7", "8", "1"]].map(word).join("");
has(decodeAuditBatch(aggregateOf([nameReturn, symbolReturn, infoReturn, "0x" + otherRecord]), [log], contract).problems, "not bound", "refuses a factory record for another token");
const highAddressRecord = ["1".repeat(64), event.curve, event.deployer, address("77"), event.pairToken, "2", "2", "3", "4", "0", "5", "6", "7", "8", "1"].map(word).join("");
has(decodeAuditBatch(aggregateOf([nameReturn, symbolReturn, infoReturn, "0x" + highAddressRecord]), [log], contract).problems, "address word", "refuses high bits in a record address");
const badBoolRecord = [event.token, event.curve, event.deployer, address("77"), event.pairToken, "2", "2", "3", "4", "2", "5", "6", "7", "8", "1"].map(word).join("");
has(decodeAuditBatch(aggregateOf([nameReturn, symbolReturn, infoReturn, "0x" + badBoolRecord]), [log], contract).problems, "boolean", "refuses a non-canonical record boolean");
const wrongThresholdRecord = [event.token, event.curve, event.deployer, address("77"), event.pairToken, "3", "2", "3", "4", "0", "5", "6", "7", "8", "1"].map(word).join("");
has(decodeAuditBatch(aggregateOf([nameReturn, symbolReturn, infoReturn, "0x" + wrongThresholdRecord]), [log], contract).problems, "graduation threshold", "binds the factory record graduation threshold to the launch event");
const wrongInfo = encoded(encode(T.tuple(...TOKEN_INFO), [address("99"), "", "", ["", "", "", "", ""]]));
has(decodeAuditBatch(aggregateOf([nameReturn, symbolReturn, wrongInfo, recordReturn]), [log], contract).problems, "token info deployer", "refuses token info for another deployer");
const invalidUtf8Name = "0x" + word("20") + word("1") + "ff".padEnd(64, "0");
has(decodeAuditBatch(aggregateOf([invalidUtf8Name, symbolReturn, infoReturn, recordReturn]), [log], contract).problems, "UTF-8", "refuses replacement-decoded token text");
const trailingName = nameReturn + "00".repeat(32);
has(decodeAuditBatch(aggregateOf([trailingName, symbolReturn, infoReturn, recordReturn]), [log], contract).problems, "trailing", "refuses non-canonical trailing token text words");
const failedAggregate = encoded(encode(T.tuple(AGGREGATE3_RESULT), [[[false, nameReturn], [true, symbolReturn], [true, infoReturn], [true, recordReturn]]]));
has(decodeAuditBatch(failedAggregate, [log], contract).problems, "failed", "refuses an allowFailure result instead of dropping a token");

const tokenParams = ["Example name", "EXAMPLE", "ipfs://example", "a valid description", ["@one", "", "", "https://example.test", ""], address("77"), 100n, false, "0x" + "00".repeat(32), "0x" + "01".repeat(32)];
const forwarderCall = contract.launchCalls.find(call => call.name === "launchAndBuy");
const directCall = contract.launchCalls.find(call => call.name === "launchToken");
const transactionInput = calldata(forwarderCall.selector, [TOKEN_PARAMS, T.uint, T.address, T.uint, T.uint, T.address, T.array(T.address)], [tokenParams, event.launchConfigId, event.pairToken, 5n, 4n, address("77"), [address("66")]]);
const transaction = { hash: log.transactionHash, blockHash: log.blockHash, blockNumber: log.blockNumber, from: event.deployer, to: contract.forwarder, input: transactionInput };
const decodedTransaction = decodeSampleTransaction(transaction, decoded.rows[0], contract);
ok(decodedTransaction.problems.length === 0 && decodedTransaction.value.name === tokenParams[0] && decodedTransaction.value.recipient === tokenParams[5], "strictly decodes and binds a sampled TokenParams transaction");
const directInput = calldata(directCall.selector, [TOKEN_PARAMS, T.uint, T.address], [tokenParams, event.launchConfigId, event.pairToken]);
ok(decodeSampleTransaction({ ...transaction, to: contract.factory, input: directInput }, decoded.rows[0], contract).problems.length === 0, "accepts the exact direct factory launch ABI without an exemptions tail");
const wrongConfigInput = transactionInput.slice(0, 74) + word("2") + transactionInput.slice(138);
has(decodeSampleTransaction({ ...transaction, input: wrongConfigInput }, decoded.rows[0], contract).problems, "launchConfigId", "binds the sampled launch configuration to the factory event");
const zeroRecipientParams = [...tokenParams]; zeroRecipientParams[5] = address("00");
const zeroRecipientInput = calldata(forwarderCall.selector, [TOKEN_PARAMS, T.uint, T.address, T.uint, T.uint, T.address, T.array(T.address)], [zeroRecipientParams, event.launchConfigId, event.pairToken, 5n, 4n, address("77"), [address("66")]]);
const zeroRecipientTransaction = { ...transaction, input: zeroRecipientInput };
const zeroRecipientRecord = [event.token, event.curve, event.deployer, event.deployer, event.pairToken, "2", "2", "3", "4", "0", "5", "6", "7", "8", "1"].map(word).join("");
const zeroRecipientRow = decodeAuditBatch(aggregateOf([nameReturn, symbolReturn, infoReturn, "0x" + zeroRecipientRecord]), [log], contract).rows[0];
const decodedZeroRecipient = decodeSampleTransaction(zeroRecipientTransaction, zeroRecipientRow, contract);
ok(decodedZeroRecipient.problems.length === 0 && decodedZeroRecipient.value.recipient === address("00") && decodedZeroRecipient.value.effectiveRecipient === event.deployer, "resolves the verified zero-recipient fallback to the event deployer");
const auditGate = (tx, historical = recordReturn) => ({ call: async method => method === "eth_getTransactionByHash" ? tx : historical });
const zeroRecipientAudit = await auditTransactions([zeroRecipientRow], contract, auditGate(zeroRecipientTransaction, "0x" + zeroRecipientRecord), "smoke");
ok(zeroRecipientAudit.sampled_transactions === 1 && zeroRecipientAudit.calldata_recipient_equals_factory_record_when_consistent === 0, "accepts the valid zero fallback while reproducing the collector's raw-recipient counter");
const wrappedTransaction = { ...transaction, to: address("99"), input: "0xdeadbeef" + directInput.slice(10) };
const wrappedAudit = await auditTransactions([decoded.rows[0]], contract, auditGate(wrappedTransaction), "smoke");
ok(wrappedAudit.calldata_decoded_as_TokenParams === 1 && wrappedAudit.strict_supported_outer_calls === 0 && wrappedAudit.classified_unsupported_outer_calls === 1, "reproduces shallow collector counters for an external wrapper without claiming its ABI was verified");
await (async () => {
  try { await auditTransactions([decoded.rows[0]], contract, auditGate({ ...transaction, to: address("99") }), "smoke"); ok(false, "refuses a known launch selector at an unverified destination"); }
  catch (error) { ok(error.message.includes("destination"), "refuses a known launch selector at an unverified destination"); }
})();
ok(decodeSampleTransaction({ ...transaction, to: contract.factory, input: calldata(directCall.selector, [TOKEN_PARAMS, T.uint, T.address], [zeroRecipientParams, event.launchConfigId, event.pairToken]) }, zeroRecipientRow, contract).value.effectiveRecipient === event.deployer, "applies the zero-recipient fallback on the direct factory launch path");
const changedLogoParams = [...tokenParams]; changedLogoParams[2] = "ipfs://different";
const changedLogoInput = calldata(forwarderCall.selector, [TOKEN_PARAMS, T.uint, T.address, T.uint, T.uint, T.address, T.array(T.address)], [changedLogoParams, event.launchConfigId, event.pairToken, 5n, 4n, address("77"), [address("66")]]);
await (async () => {
  try { await auditTransactions([decoded.rows[0]], contract, auditGate({ ...transaction, input: changedLogoInput }), "smoke"); ok(false, "refuses sampled logo drift"); }
  catch (error) { ok(error.message.includes("logo or description"), "refuses sampled logo drift"); }
})();
const changedDescriptionParams = [...tokenParams]; changedDescriptionParams[3] = "a different valid description";
const changedDescriptionInput = calldata(forwarderCall.selector, [TOKEN_PARAMS, T.uint, T.address, T.uint, T.uint, T.address, T.array(T.address)], [changedDescriptionParams, event.launchConfigId, event.pairToken, 5n, 4n, address("77"), [address("66")]]);
await (async () => {
  try { await auditTransactions([decoded.rows[0]], contract, auditGate({ ...transaction, input: changedDescriptionInput }), "smoke"); ok(false, "refuses sampled description drift"); }
  catch (error) { ok(error.message.includes("logo or description"), "refuses sampled description drift"); }
})();
const rotatedCurrentRow = { ...decoded.rows[0], recipient: address("99") };
const rotatedAudit = await auditTransactions([rotatedCurrentRow], contract, auditGate(transaction), "smoke");
ok(rotatedAudit.sampled_transactions === 1 && rotatedAudit.calldata_recipient_equals_factory_record_when_consistent === 0, "uses the launch-block record for proof while reproducing a later recipient rotation in the raw counter");
const wrongHistoricalRecipient = [event.token, event.curve, event.deployer, address("99"), event.pairToken, "2", "2", "3", "4", "0", "5", "6", "7", "8", "1"].map(word).join("");
await (async () => {
  try { await auditTransactions([decoded.rows[0]], contract, auditGate(transaction, "0x" + wrongHistoricalRecipient), "smoke"); ok(false, "refuses a launch-block recipient mismatch"); }
  catch (error) { ok(error.message.includes("launch-block factory record"), "refuses a launch-block recipient mismatch"); }
})();
const tupleOffset = Number(BigInt("0x" + transactionInput.slice(10, 74))), taxAt = 10 + (tupleOffset + 6 * 32) * 2, boolAt = 10 + (tupleOffset + 7 * 32) * 2;
const badTaxInput = transactionInput.slice(0, taxAt) + word("10000") + transactionInput.slice(taxAt + 64);
has(decodeSampleTransaction({ ...transaction, input: badTaxInput }, decoded.rows[0], contract, transaction.to).problems, "uint16", "refuses creatorTaxBps outside its verified uint16 ABI width");
const badBoolInput = transactionInput.slice(0, boolAt) + word("2") + transactionInput.slice(boolAt + 64);
has(decodeSampleTransaction({ ...transaction, input: badBoolInput }, decoded.rows[0], contract, transaction.to).problems, "boolean", "refuses bool word two in sampled TokenParams");
has(decodeSampleTransaction({ ...transaction, input: transactionInput + "00" }, decoded.rows[0], contract, transaction.to).problems, "word-aligned", "refuses trailing bytes outside an ABI word in sampled calldata");
has(decodeSampleTransaction({ ...transaction, input: transactionInput + word("0") }, decoded.rows[0], contract, transaction.to).problems, "trailing bytes", "refuses a word-aligned tail outside the verified full launch ABI");
has(decodeSampleTransaction({ ...transaction, input: "0xdeadbeef" + transactionInput.slice(10) }, decoded.rows[0], contract, transaction.to).problems, "selector", "refuses an arbitrary selector wrapped around valid TokenParams bytes");
has(decodeSampleTransaction({ ...transaction, to: contract.factory }, decoded.rows[0], contract, transaction.to).problems, "destination", "binds the router selector to the live factory forwarder");
has(decodeSampleTransaction({ ...transaction, from: address("99") }, decoded.rows[0], contract, transaction.to).problems, "sender", "refuses a sampled transaction from another deployer");
has(decodeSampleTransaction({ ...transaction, blockNumber: quantity(11) }, decoded.rows[0], contract, transaction.to).problems, "identify", "refuses a sampled transaction from another block");
has(decodeSampleTransaction({ ...transaction, blockHash: "0x" + "9".repeat(64) }, decoded.rows[0], contract, transaction.to).problems, "transaction and block", "refuses a sampled transaction attached to another block hash");
has(validateTransactionAudit({ sampled_transactions: 0 }, { verified: report.verified }), "sampled_transactions", "refuses transaction audit counters that do not match the collector report");

const timestamp = text => Math.floor(Date.parse(text) / 1000);
const context = {
  chainId: quantity(contract.chainId),
  fromBlock: { number: quantity(report.window.from), timestamp: quantity(timestamp(report.window.from_time)) },
  toBlock: { number: quantity(report.window.to), timestamp: quantity(timestamp(report.window.to_time)) },
  finalizedBlock: { number: quantity(report.window.finalized + 1), timestamp: quantity(timestamp(report.window.to_time) + 1), hash: "0x" + "8".repeat(64) },
  identityStateBlock: { number: quantity(report.identity_state.number), timestamp: quantity(timestamp(report.window.to_time)), hash: report.identity_state.hash },
  multicallCode: "0x01",
  identityFactoryCode: "0x01",
  historicalFactoryCode: "0x01",
  boundaries: []
};
ok(validateAuditContext(context, report, contract).length === 0, "accepts a second RPC context bound to the report");
const wrongChain = clone(context); wrongChain.chainId = quantity(contract.chainId + 1);
has(validateAuditContext(wrongChain, report, contract), "chain id", "refuses a second RPC on another chain");
const wrongFirst = clone(context); wrongFirst.fromBlock.number = quantity(report.window.from + 1);
has(validateAuditContext(wrongFirst, report, contract), "first block", "refuses a substituted first block");
const wrongTime = clone(context); wrongTime.toBlock.timestamp = quantity(timestamp(report.window.to_time) + 1);
has(validateAuditContext(wrongTime, report, contract), "timestamp", "refuses a substituted block timestamp");
const staleFinality = clone(context); staleFinality.finalizedBlock.number = quantity(report.identity_state.number - 1);
has(validateAuditContext(staleFinality, report, contract), "finalized", "refuses a finalized head behind the collected range");
const contradictorySameHeightFinality = clone(context); contradictorySameHeightFinality.finalizedBlock.number = quantity(report.identity_state.number);
has(validateAuditContext(contradictorySameHeightFinality, report, contract), "contradicts", "refuses a different finalized hash at the recorded identity-state height");
const invalidFinalizedHash = clone(context); invalidFinalizedHash.finalizedBlock.hash = "0x01";
has(validateAuditContext(invalidFinalizedHash, report, contract), "block hash", "refuses a finalized head without a canonical hash");
const wrongIdentityHash = clone(context); wrongIdentityHash.identityStateBlock.hash = "0x" + "9".repeat(64);
has(validateAuditContext(wrongIdentityHash, report, contract), "differs", "refuses a canonical header hash that differs from the recorded identity state");
has(validateIdentityStateHeader(wrongIdentityHash.identityStateBlock, report, "recheck"), "differs", "the standalone post-read validator refuses identity-state hash drift");
const noIdentityFactoryState = clone(context); noIdentityFactoryState.identityFactoryCode = null;
has(validateAuditContext(noIdentityFactoryState, report, contract), "recorded identity state", "refuses an endpoint without factory code at the recorded identity state");
const noHistoricalState = clone(context); noHistoricalState.historicalFactoryCode = null;
has(validateAuditContext(noHistoricalState, report, contract), "historical factory state", "refuses an audit endpoint without the archive state required by strict transaction checks");
ok(validateAuditContext(noHistoricalState, report, contract, { requireHistorical: false }).length === 0, "allows an explicitly diagnostic context without historical state");
const boundaryReport = clone(report);
boundaryReport.window.from_time = "2026-09-09T23:59:59.000Z";
boundaryReport.verified.day_boundaries = [11];
const boundaryContext = clone(context);
boundaryContext.fromBlock.timestamp = quantity(timestamp(boundaryReport.window.from_time));
boundaryContext.boundaries = [{ target: timestamp("2026-09-10T00:00:00.000Z"), number: 11, previous: { number: quantity(10), timestamp: quantity(timestamp("2026-09-09T23:59:59.000Z")) }, block: { number: quantity(11), timestamp: quantity(timestamp("2026-09-10T00:00:00.000Z")) } }];
ok(validateAuditContext(boundaryContext, boundaryReport, contract).length === 0, "accepts a boundary only when adjacent blocks cross a UTC date");
const falseBoundary = clone(boundaryContext); falseBoundary.boundaries[0].previous.timestamp = quantity(timestamp("2026-09-10T00:00:00.000Z"));
has(validateAuditContext(falseBoundary, boundaryReport, contract), "first block", "refuses a reported boundary whose previous block is already at the required UTC date");
const omittedBoundary = clone(boundaryReport); omittedBoundary.verified.day_boundaries = [];
has(validateAuditContext(boundaryContext, omittedBoundary, contract), "collection day boundary", "refuses an omitted collector boundary found independently from endpoint timestamps");
const missingAuditBoundary = clone(boundaryContext); missingAuditBoundary.boundaries = [];
has(validateAuditContext(missingAuditBoundary, boundaryReport, contract), "endpoint timestamps", "refuses a second read that skips an independently required UTC boundary");

const semanticRow = decoded.rows[0];
const semantic = await buildSemanticAudit([semanticRow, { ...semanticRow, token: address("12"), block: 11 }], { first: "2026-09-10", boundaries: [] });
const semanticReport = { ...report, tables: semantic.tables, six: semantic.six, also: semantic.also, verified: { ...report.verified, fee_recipient_set: semantic.recipientSet } };
ok(validateSemanticAudit(semantic, semanticReport).length === 0, "rebuilds the collector's identity tables and summaries from strict returns");
const changedSemantic = clone(semanticReport); changedSemantic.six.launches_scanned++;
has(validateSemanticAudit(semantic, changedSemantic), "six-line", "refuses a same-size report whose semantic summary differs");
const changedTable = clone(semanticReport); changedTable.tables.ticker[Object.keys(changedTable.tables.ticker)[0]].n++;
has(validateSemanticAudit(semantic, changedTable), "identity tables", "refuses a report whose counted identities differ");
const dated = await buildSemanticAudit([semanticRow, { ...semanticRow, token: address("12"), symbol: "SECOND", block: 11 }], { first: "2026-09-10", boundaries: [{ block: 11, date: "2026-09-11" }] });
const secondDigest = await L.digest(L.normalize.ticker("SECOND"));
ok(dated.tables.ticker[secondDigest].first === "2026-09-11", "semantic reconstruction applies the independently checked boundary date");

// Drive the CLI through its real Gate and strict second-read path against a local JSON-RPC surface. This proves
// that the production orchestration uses the validators above; the server gives only the exact calls it expects.
const one = await buildSemanticAudit([semanticRow], { first: "2026-09-10", boundaries: [] });
const integrationReport = clone(report);
integrationReport.six = one.six;
integrationReport.also = one.also;
integrationReport.tables = one.tables;
Object.assign(integrationReport.verified, {
  launches_in_log: 1, tokens_readable: 1, getTokenInfo_deployer_equals_event_deployer: 1,
  factory_record_exists: 1, factory_record_deployer_equals_event_deployer: 1,
  fee_recipient_set: one.recipientSet, sampled_transactions: 1,
  calldata_decoded_as_TokenParams: 1, calldata_name_symbol_equal_onchain: 1,
  calldata_recipient_equals_factory_record_when_consistent: 1, calldata_socials_equal_onchain: 1,
  tx_from_equals_deployer: 1, tx_to_distinct: 1, chunk_blocks: contract.chunk
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lintcha-collection-guard-test-"));
const reportPath = path.join(tmp, "report.json"), publishedPath = path.join(tmp, "published.json");
fs.writeFileSync(reportPath, JSON.stringify(integrationReport));
fs.writeFileSync(publishedPath, JSON.stringify({ chain_id: contract.chainId, launches_scanned: 1 }));
const currentFinalizedNumber = integrationReport.identity_state.number + 1;
const currentFinalizedTime = new Date(Date.parse(integrationReport.window.to_time) + 1000).toISOString();
const currentFinalizedHash = "0x" + "8".repeat(64), changedIdentityHash = "0x" + "9".repeat(64);
const block = (number, time, hash) => ({ number: quantity(number), timestamp: quantity(timestamp(time)), hash });
const rpcCalls = { strict: [], diagnostic: [], mismatch: [], reorg: [], badanchor: [], badcode: [] }, rpcBatchBodies = { strict: [], diagnostic: [], mismatch: [], reorg: [], badanchor: [], badcode: [] };
const identityReadSeen = { strict: false, diagnostic: false, mismatch: false, reorg: false, badanchor: false, badcode: false };
let rpcMode = "strict";
const rpc = http.createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    let call;
    try {
      call = JSON.parse(body);
      rpcBatchBodies[rpcMode].push(Array.isArray(call));
      const answer = item => {
        rpcCalls[rpcMode].push({ method: item.method, params: item.params });
        let result;
        if (item.method === "eth_chainId") result = quantity(contract.chainId);
        else if (item.method === "eth_getBlockByNumber" && item.params[0] === "finalized") result = block(currentFinalizedNumber, currentFinalizedTime, currentFinalizedHash);
        else if (item.method === "eth_getBlockByNumber" && item.params[0] === quantity(integrationReport.window.from)) result = block(integrationReport.window.from, integrationReport.window.from_time, log.blockHash);
        else if (item.method === "eth_getBlockByNumber" && item.params[0] === quantity(integrationReport.identity_state.number)) result = block(integrationReport.identity_state.number, integrationReport.window.to_time, rpcMode === "badanchor" || (rpcMode === "reorg" && identityReadSeen.reorg) ? changedIdentityHash : integrationReport.identity_state.hash);
        else if (item.method === "eth_getCode" && [contract.factory, contract.multicall].includes(item.params[0]) && item.params[1] === quantity(integrationReport.identity_state.number)) result = rpcMode === "badcode" ? "0x" : "0x01";
        else if (item.method === "eth_getLogs") result = [log];
        else if (item.method === "eth_call" && item.params[0].to === contract.factory && item.params[0].data.startsWith(contract.selectors.launched) && item.params[1] === quantity(integrationReport.window.from)) result = recordReturn;
        else if (item.method === "eth_call" && item.params[0].to === contract.multicall && item.params[1] === quantity(integrationReport.identity_state.number)) {
          identityReadSeen[rpcMode] = true;
          result = rpcMode === "mismatch" ? changedNameAggregate : aggregate;
        }
        else if (item.method === "eth_getTransactionByHash" && item.params[0] === log.transactionHash) result = transaction;
        else throw new Error("unexpected method " + item.method + " " + JSON.stringify(item.params));
        return { jsonrpc: "2.0", id: item.id, result };
      };
      const result = Array.isArray(call) ? call.map(answer) : answer(call);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: call && call.id, error: { code: -32602, message: error.message } }));
    }
  });
});
await new Promise(resolve => rpc.listen(0, "127.0.0.1", resolve));
const port = rpc.address().port;
const runGuard = args => new Promise(resolve => {
  const child = spawn(process.execPath, [path.join(root, "tools", "collection-guard.mjs"), "--in", reportPath, "--published", publishedPath, ...args, "--rpc", "http://127.0.0.1:" + port], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("close", code => resolve({ code, output }));
});
const strictCli = await runGuard(["--audit-logs"]), cliCode = strictCli.code, cliOutput = strictCli.output;
rpcMode = "diagnostic";
const diagnosticCli = await runGuard(["--diagnose-semantic"]);
rpcMode = "mismatch";
const mismatchCli = await runGuard(["--diagnose-semantic"]);
rpcMode = "reorg";
const reorgCli = await runGuard(["--diagnose-semantic"]);
rpcMode = "badanchor";
const badAnchorCli = await runGuard(["--diagnose-semantic"]);
rpcMode = "badcode";
const badCodeCli = await runGuard(["--diagnose-semantic"]);
const callsBeforeMissingMode = Object.values(rpcCalls).flat().length;
const missingModeCli = await runGuard([]);
const callsAfterMissingMode = Object.values(rpcCalls).flat().length;
const legacyFlagCli = await runGuard(["--diagnose-semantic", "--allow-unpinned-latest"]);
await new Promise(resolve => rpc.close(resolve));
fs.rmSync(tmp, { recursive: true, force: true });
ok(cliCode === 0, "the CLI's real second-read path accepts the strict matching RPC fixture: " + cliOutput.trim());
ok(cliOutput.includes("identity audit:"), "the CLI reached semantic reconstruction rather than stopping after report counters");
ok(cliOutput.includes("transaction audit:"), "the CLI reached strict sampled-transaction reconstruction");
ok(diagnosticCli.code === 0 && diagnosticCli.output.includes("diagnostic identity read: exact recorded finalized state"), "the diagnostic CLI binds a matching identity read to the report's exact state: " + diagnosticCli.output.trim());
ok(diagnosticCli.output.includes("not publication proof") && diagnosticCli.output.includes("event-header batches and sampled transactions were skipped"), "the fixed diagnostic success states exactly which publication proofs it skips");
const diagnosticIdentityCalls = rpcCalls.diagnostic.filter(item => item.method === "eth_call" && item.params[0].to === contract.multicall);
ok(diagnosticIdentityCalls.length === 1 && diagnosticIdentityCalls.every(item => item.params[1] === quantity(integrationReport.identity_state.number)), "the fixed diagnostic never substitutes latest for its identity state tag");
ok(!rpcBatchBodies.diagnostic.some(Boolean) && !rpcCalls.diagnostic.some(item => item.method === "eth_getTransactionByHash"), "the diagnostic skips header batches and transaction proof instead of resembling the publication gate");
ok(missingModeCli.code !== 0 && missingModeCli.output.includes("exactly one") && callsAfterMissingMode === callsBeforeMissingMode, "the CLI cannot succeed as a guard without explicitly selecting strict proof or diagnostic reconstruction");
ok(mismatchCli.code !== 0 && mismatchCli.output.includes("name, name_skeleton"), "the diagnostic exits nonzero and names the differing identity namespaces: " + mismatchCli.output.trim());
ok(reorgCli.code !== 0 && reorgCli.output.includes("post-read identity-state") && reorgCli.output.includes("differs"), "the diagnostic fails when the numeric state's canonical hash changes after identity reads: " + reorgCli.output.trim());
ok(badAnchorCli.code !== 0 && badAnchorCli.output.includes("before any identity read") && !rpcCalls.badanchor.some(item => item.method === "eth_getCode" || item.method === "eth_call" || item.method === "eth_getLogs"), "the guard rejects the initial state hash before any code, identity or log read: " + badAnchorCli.output.trim());
ok(badCodeCli.code !== 0 && badCodeCli.output.includes("before the factory log scan") && !rpcCalls.badcode.some(item => item.method === "eth_call" || item.method === "eth_getLogs"), "the guard rejects missing fixed-state bytecode before the expensive factory log scan: " + badCodeCli.output.trim());
ok(legacyFlagCli.code !== 0 && legacyFlagCli.output.includes("unknown argument --allow-unpinned-latest"), "the removed moving-latest escape hatch cannot be requested");
for (const mode of ["strict", "diagnostic", "mismatch", "reorg"]) {
  const identityCalls = rpcCalls[mode].filter(item => (item.method === "eth_call" && item.params[0].to === contract.multicall) || item.method === "eth_getCode");
  ok(identityCalls.length > 0 && identityCalls.every(item => item.params[1] === quantity(integrationReport.identity_state.number)), mode + " keeps every identity/code read on the recorded numeric block tag");
  ok(!rpcCalls[mode].some(item => item.params.includes("latest")), mode + " never issues an unpinned latest read");
}
const strictIdentityAt = rpcCalls.strict.findIndex(item => item.method === "eth_call" && item.params[0].to === contract.multicall);
ok(rpcCalls.strict.slice(strictIdentityAt + 1).some(item => item.method === "eth_getBlockByNumber" && item.params[0] === quantity(integrationReport.identity_state.number)), "strict publication rechecks the exact state header after the identity batches");

// Drive verify-index in a disposable fake tree. Its child collector/guard/writer are tiny local fixtures: this checks
// orchestration and fail-closed state/window binding without touching the shipped artifacts or any network.
const verifyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lintcha-verify-index-test-"));
const verifyTools = path.join(verifyRoot, "tools"), verifySite = path.join(verifyRoot, "site"), verifyScratch = path.join(verifyRoot, "scratch");
fs.mkdirSync(verifyTools, { recursive: true }); fs.mkdirSync(verifySite); fs.mkdirSync(verifyScratch);
fs.copyFileSync(path.join(root, "tools", "verify-index.mjs"), path.join(verifyTools, "verify-index.mjs"));
fs.writeFileSync(path.join(verifyTools, "collection-guard.mjs"), [
  'export const RPC_ENV = "LINTCHA_CHAIN_RPC_URL";',
  'export const rpcOverrideAllowed = value => { try { const u = new URL(value); return !u.username && !u.password && !u.search && !u.hash && (u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))); } catch { return false; } };',
  'export function exactIdentityState(value, label) { const s = value && value.identity_state; if (!s || !Number.isSafeInteger(s.number) || !/^0x[0-9a-f]{64}$/.test(s.hash) || /^0x0{64}$/.test(s.hash)) throw new Error(label + " has no exact finalized identity_state; run a new guarded refresh"); return { number: s.number, hash: s.hash }; }'
].join("\n"));
fs.writeFileSync(path.join(verifyTools, "launch-collect.mjs"), [
  'import fs from "node:fs";',
  'const a = process.argv.slice(2), opt = name => { const i = a.indexOf("--" + name); return a[i + 1]; };',
  'const state = { number: Number(opt("identity-state-number")), hash: opt("identity-state-hash") };',
  'const window = { from: Number(opt("from")), to: Number(opt("to")) };',
  'if (process.env.FAKE_COLLECTOR_WINDOW_DRIFT) window.from++;',
  'fs.writeFileSync(opt("out"), JSON.stringify({ identity_state: state, window }));'
].join("\n"));
fs.writeFileSync(path.join(verifyTools, "launch-index.mjs"), [
  'import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";',
  'const a = process.argv.slice(2), opt = name => { const i = a.indexOf("--" + name); return a[i + 1]; };',
  'const collected = JSON.parse(fs.readFileSync(opt("in"), "utf8")), site = opt("site"), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");',
  'const state = { ...collected.identity_state }, window = { from_block: collected.window.from, to_block: collected.window.to };',
  'if (process.env.FAKE_WRITER_STATE_DRIFT) state.hash = "0x" + "9".repeat(64);',
  'if (process.env.FAKE_WRITER_WINDOW_DRIFT) window.from_block++;',
  'fs.mkdirSync(site, { recursive: true }); fs.copyFileSync(path.join(root, "site", "launch-index.json"), path.join(site, "launch-index.json"));',
  'fs.writeFileSync(path.join(site, "launch-numbers.json"), JSON.stringify({ chain_id: 1, identity_state: state, window, launches_scanned: 1, index: { entries_total: 0 } }));'
].join("\n"));
const verifyNumbers = { chain_id: 1, identity_state: clone(report.identity_state), window: { from_block: 10, to_block: 11, blocks: 2, from_time: report.window.from_time, to_time: report.window.to_time }, launches_scanned: 1, index: { entries_total: 0 } };
fs.writeFileSync(path.join(verifySite, "launch-index.json"), "{}\n"); fs.writeFileSync(path.join(verifySite, "launch-numbers.json"), JSON.stringify(verifyNumbers));
const runVerify = extraEnv => new Promise(resolve => {
  const env = { ...process.env, TEMP: verifyScratch, TMP: verifyScratch, TMPDIR: verifyScratch, ...extraEnv };
  delete env.FAKE_COLLECTOR_WINDOW_DRIFT; delete env.FAKE_WRITER_STATE_DRIFT; delete env.FAKE_WRITER_WINDOW_DRIFT;
  Object.assign(env, extraEnv); if (!Object.prototype.hasOwnProperty.call(extraEnv, RPC_ENV)) delete env[RPC_ENV];
  const child = spawn(process.execPath, [path.join(verifyTools, "verify-index.mjs")], { cwd: verifyRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  child.on("close", code => resolve({ code, output }));
});
const verifySuccess = await runVerify({ [RPC_ENV]: "http://127.0.0.1:1/ab/cd" });
ok(verifySuccess.code === 0 && verifySuccess.output.includes("match: yes") && !verifySuccess.output.includes("/ab/cd"), "verify-index passes the exact published state/window to its children without printing the environment endpoint: " + verifySuccess.output.trim());
const verifyCollectorDrift = await runVerify({ FAKE_COLLECTOR_WINDOW_DRIFT: "1" });
ok(verifyCollectorDrift.code === 2 && verifyCollectorDrift.output.includes("did not preserve the published block window"), "verify-index fails before the guard when the re-collected window drifts");
const verifyWriterStateDrift = await runVerify({ FAKE_WRITER_STATE_DRIFT: "1" });
ok(verifyWriterStateDrift.code === 2 && verifyWriterStateDrift.output.includes("writer did not preserve the published identity_state"), "verify-index refuses a writer that drops or changes the published state even when the index hash matches");
const verifyWriterWindowDrift = await runVerify({ FAKE_WRITER_WINDOW_DRIFT: "1" });
ok(verifyWriterWindowDrift.code === 2 && verifyWriterWindowDrift.output.includes("writer did not preserve the published block window"), "verify-index refuses a writer that changes the published window even when the index hash matches");
fs.rmSync(verifyRoot, { recursive: true, force: true });

console.log(`collection guard test: ${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
