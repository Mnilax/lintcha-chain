#!/usr/bin/env node
// Credentialed RPC acceptance for Lintcha Copy. Reads the two endpoint URLs from the environment only, never
// prints, logs or persists them, and refuses to run with fewer than two independent vendors. Read-only JSON-RPC
// only: no signing, no broadcast, no wallet. Exit code 2 = not accepted; the JSON report says why.
//
//   COPY_RPC_PRIMARY_URL / COPY_RPC_SECONDARY_URL        (secrets; from the owner's secret store, not from chat)
//   COPY_RPC_PRIMARY_PROVIDER / COPY_RPC_SECONDARY_PROVIDER  vendor ids (default alchemy / quicknode)
//   COPY_ACCEPT_MAX_LATENCY_MS (default 1500), COPY_ACCEPT_MAX_LAG_SECONDS (default 30), COPY_ACCEPT_BURST (default 20)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ReadOnlyJsonRpcProvider, RpcPool } from "../src/rpc-pool.mjs";
import { SimulationQuorum } from "../src/simulation.mjs";

const env = process.env;
const urls = [env.COPY_RPC_PRIMARY_URL, env.COPY_RPC_SECONDARY_URL];
const ids = [env.COPY_RPC_PRIMARY_PROVIDER || "alchemy", env.COPY_RPC_SECONDARY_PROVIDER || "quicknode"];
const thresholds = { maxLatencyMs: Number(env.COPY_ACCEPT_MAX_LATENCY_MS || 1500), maxLagSeconds: Number(env.COPY_ACCEPT_MAX_LAG_SECONDS || 30), burst: Number(env.COPY_ACCEPT_BURST || 20) };
const reasons = [];
const report = { schemaVersion: 1, capturedAtUtc: new Date().toISOString(), chainId: 4663, providerIds: ids, thresholds, checks: {} };

/** Anything that could carry an endpoint or key is stripped before output, whatever produced it. */
function sanitize(value) {
  if (typeof value === "string") return urls.some((url) => url && value.includes(url)) || /https?:\/\/|wss?:\/\//i.test(value) ? "[redacted]" : value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  return value;
}
function fail(code) { if (!reasons.includes(code)) reasons.push(code); }
function finish() {
  report.accepted = reasons.length === 0;
  report.reasons = reasons;
  process.stdout.write(`${JSON.stringify(sanitize(report), null, 2)}\n`);
  process.exitCode = report.accepted ? 0 : 2;
}

if (urls.some((url) => !url)) { fail("TWO_RPC_ENDPOINTS_REQUIRED"); finish(); process.exit(); }
if (ids[0] === ids[1]) { fail("INDEPENDENT_RPC_PROVIDERS_REQUIRED"); finish(); process.exit(); }
if (urls[0] === urls[1]) { fail("PROVIDER_ENDPOINTS_MUST_DIFFER"); finish(); process.exit(); }
try { if (new URL(urls[0]).host === new URL(urls[1]).host) fail("PROVIDER_HOSTS_MUST_DIFFER"); } catch { fail("PROVIDER_URL_INVALID"); }

const providers = urls.map((url, index) => new ReadOnlyJsonRpcProvider({ id: ids[index], url, timeoutMs: 10_000 }));
const pool = new RpcPool({ providers, chainId: 4663, maxHeadSkewBlocks: 2 });
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../test/fixtures/pons-v2-mainnet-buy.json", import.meta.url)), "utf8"));

async function timed(label, fn) {
  const started = performance.now();
  try { const result = await fn(); report.checks[label] = { ok: true, ms: Math.ceil(performance.now() - started), ...(result || {}) }; return result; }
  catch (error) { report.checks[label] = { ok: false, ms: Math.ceil(performance.now() - started), error: String(error?.message || "failed").slice(0, 80) }; fail(`${label.toUpperCase()}_FAILED`); return null; }
}

// 1. Health: chain id, finality tags, head skew, common block hash.
const health = await timed("health", async () => { const h = await pool.healthCheck(); return { referenceBlock: h.referenceBlock, safeBlock: h.safeBlock, finalizedBlock: h.finalizedBlock, providers: h.providers.map(({ id, head, safeNumber, finalizedNumber }) => ({ id, head, safeNumber, finalizedNumber })) }; });

// 2. Per-provider latency and wall-clock lag of the latest block.
for (const provider of providers) {
  await timed(`latency_${provider.id}`, async () => {
    const started = performance.now();
    const block = await provider.request("eth_getBlockByNumber", ["latest", false]);
    const ms = Math.ceil(performance.now() - started);
    const lag = Math.floor(Date.now() / 1000) - Number(BigInt(block.timestamp));
    if (ms > thresholds.maxLatencyMs) fail(`LATENCY_EXCEEDED_${provider.id.toUpperCase()}`);
    if (lag > thresholds.maxLagSeconds) fail(`WALL_LAG_EXCEEDED_${provider.id.toUpperCase()}`);
    return { latencyMs: ms, wallLagSeconds: lag };
  });
}

// 3. Archive read: the recorded Pons V2 transaction and a historical eth_getCode at its block.
await timed("archive_history", async () => {
  const tx = await pool.quorumRead("eth_getTransactionByHash", [fixture.transaction.hash]);
  if (!tx || tx.to.toLowerCase() !== fixture.transaction.to) throw new Error("RECORDED_TRANSACTION_MISMATCH");
  const code = await pool.quorumRead("eth_getCode", [fixture.transaction.to, fixture.block.number]);
  if (!code || code === "0x") throw new Error("HISTORICAL_CODE_UNAVAILABLE");
  return { codeBytes: (code.length - 2) / 2 };
});

// 4. Current-state simulation agreement on a tiny read-only call (no value, no signature): balanceOf on the curve token.
await timed("simulation_quorum", async () => {
  const simulator = new SimulationQuorum({ rpcPool: pool });
  const result = await simulator.simulate({ from: fixture.transaction.from, transaction: { chainId: 4663, to: fixture.source.token, value: "0", data: `0x70a08231${fixture.transaction.from.slice(2).padStart(64, "0")}` } });
  return { blockNumber: result.blockNumber, gasSkewBps: result.gasSkewBps };
});

// 5. Log range: 2000-block eth_getLogs window on the factory must be served by both.
await timed("log_range", async () => {
  if (!health) throw new Error("NO_HEALTH");
  const to = health.referenceBlock;
  const from = Math.max(0, to - 1999);
  const logs = await Promise.all(providers.map((provider) => provider.request("eth_getLogs", [{ address: fixture.source.factory, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }])));
  if (logs[0].length !== logs[1].length) throw new Error("LOG_COUNT_DISAGREEMENT");
  return { blocks: to - from + 1, logs: logs[0].length };
});

// 6. Burst: N parallel head reads per provider without a rate-limit failure.
for (const provider of providers) {
  await timed(`burst_${provider.id}`, async () => {
    const settled = await Promise.allSettled(Array.from({ length: thresholds.burst }, () => provider.request("eth_blockNumber")));
    const failures = settled.filter((item) => item.status === "rejected").length;
    if (failures) throw new Error(`RATE_LIMITED_${failures}_OF_${thresholds.burst}`);
    return { requests: thresholds.burst };
  });
}

report.notes = [
  "Read-only probes only. No transaction was signed or broadcast.",
  "Contractual SLA, data retention and Robinhood production coverage are procurement facts and are not provable from here.",
];
finish();
