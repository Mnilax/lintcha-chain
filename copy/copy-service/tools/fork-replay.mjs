#!/usr/bin/env node
// Local mainnet-fork replay for Lintcha Copy fixtures. Runs only when COPY_FORK_RPC_URL points at a local fork
// (for example anvil --fork-url <owner-provided endpoint>); otherwise it reports SKIPPED and exits 0 so CI stays
// credential-free. It performs eth_call / eth_estimateGas of the recorded calldata from the recorded sender at
// the fork head. No signature, no broadcast, no impersonation-based sends.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const url = process.env.COPY_FORK_RPC_URL;
const dir = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
const fixtures = readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => ({ name, ...JSON.parse(readFileSync(dir + name, "utf8")) }));
if (!url) { console.log(JSON.stringify({ status: "SKIPPED", reason: "COPY_FORK_RPC_URL not set", fixtures: fixtures.map((f) => f.name) })); process.exit(0); }
if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?$/.test(url)) { console.log(JSON.stringify({ status: "REFUSED", reason: "fork replay accepts a local fork only; a remote endpoint is not a fork" })); process.exit(2); }

let counter = 0;
async function rpc(method, params) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++counter, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`.slice(0, 160));
  return body.result;
}

const chainId = Number(BigInt(await rpc("eth_chainId", [])));
const results = [];
for (const fixture of fixtures) {
  const call = { from: fixture.transaction.from, to: fixture.transaction.to, data: fixture.transaction.input, value: `0x${BigInt(fixture.transaction.value).toString(16)}` };
  const entry = { fixture: fixture.name, direction: fixture.name.includes("sell") ? "SELL" : "BUY" };
  try {
    entry.output = await rpc("eth_call", [call, "latest"]);
    entry.gas = Number(BigInt(await rpc("eth_estimateGas", [call, "latest"])));
    entry.status = "OK";
  } catch (error) {
    // A curve that has graduated or a sender without balance on the fork reverts; that is a finding, not a failure of the harness.
    entry.status = "REVERTED_OR_UNAVAILABLE";
    entry.error = error.message;
  }
  results.push(entry);
}
console.log(JSON.stringify({ status: chainId === 4663 ? "RAN" : "WRONG_CHAIN", chainId, results }, null, 2));
process.exitCode = chainId === 4663 ? 0 : 2;
