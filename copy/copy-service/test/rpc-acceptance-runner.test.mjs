import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadFixture, fixtureProvider } from "./fixture-rpc.mjs";

const fixture = loadFixture("pons-v2-mainnet-buy");
const tool = fileURLToPath(new URL("../tools/rpc-acceptance.mjs", import.meta.url));

function serve(id) {
  const provider = fixtureProvider(id, fixture);
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      const call = JSON.parse(body);
      try {
        let result;
        if (call.method === "eth_getCode") result = "0x6001";
        else if (call.method === "eth_getLogs") result = [{}, {}];
        else if (call.method === "eth_getBlockByNumber" && call.params[0] === "latest") result = { number: fixture.block.number, hash: fixture.block.hash, timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` };
        else result = await provider.request(call.method, call.params);
        response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
      } catch (error) { response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: error.message } })); }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v2/SECRET-${id}` })));
}

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tool], { env: { ...process.env, ...env } });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("credentialed acceptance runner accepts two agreeing providers and never writes an endpoint or key to output", async () => {
  const a = await serve("alchemy");
  const b = await serve("quicknode");
  try {
    const result = await run({ COPY_RPC_PRIMARY_URL: a.url, COPY_RPC_SECONDARY_URL: b.url, COPY_ACCEPT_MAX_LAG_SECONDS: "600" });
    const output = result.stdout + result.stderr;
    assert.equal(output.includes("SECRET-"), false);
    assert.equal(output.includes("127.0.0.1"), false);
    const report = JSON.parse(result.stdout);
    assert.equal(report.accepted, true, JSON.stringify(report.checks));
    assert.equal(result.status, 0);
    assert.deepEqual(Object.keys(report.checks), ["health", "latency_alchemy", "latency_quicknode", "archive_history", "simulation_quorum", "log_range", "burst_alchemy", "burst_quicknode"]);
    const sameHost = await run({ COPY_RPC_PRIMARY_URL: a.url, COPY_RPC_SECONDARY_URL: `${a.url}-b` });
    assert.equal(sameHost.status, 2);
    assert.equal(JSON.parse(sameHost.stdout).reasons.includes("PROVIDER_HOSTS_MUST_DIFFER"), true);
  } finally {
    a.server.close(); b.server.close();
  }
});
