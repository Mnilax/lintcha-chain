#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runThroughSplitRpc, startSplitRpcProxy, waitForSplitRpcProxy } from "../tools/with-launch-rpc-split.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
let passed = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  passed++;
  console.log("ok " + passed + " - " + label);
};

const bodyOf = async request => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const startServer = handler => new Promise((resolve, reject) => {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(error => {
      response.statusCode = 500;
      response.end(error.message);
    });
  });
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve({
      url: `http://127.0.0.1:${address.port}`,
      close: () => new Promise((done, fail) => {
        server.close(error => error ? fail(error) : done());
        server.closeAllConnections?.();
      })
    });
  });
});

let archiveMode = "normal", archiveUrl = "";
const archiveBodies = [], logBodies = [];
const archive = await startServer(async (request, response) => {
  const body = await bodyOf(request);
  archiveBodies.push(body);
  if (archiveMode === "failure") {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end("failed at " + archiveUrl);
    return;
  }
  if (archiveMode === "limited") {
    response.writeHead(429, { "content-type": "text/plain" });
    response.end("limited at " + archiveUrl);
    return;
  }
  if (archiveMode === "invalid") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not-json " + archiveUrl);
    return;
  }
  if (archiveMode === "rpc-secret") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 9, error: { code: -32000, message: "failed at " + archiveUrl, data: { endpoint: archiveUrl } } }));
    return;
  }
  if (body.startsWith("[")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('[ {"jsonrpc":"2.0","id":2,"result":{"number":"0x2"}}, {"jsonrpc":"2.0","id":1,"result":{"number":"0x1"}} ]\n');
    return;
  }
  const id = JSON.parse(body).id;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x1237" }));
});
archiveUrl = archive.url + "/v2/archive-secret-value";

const logs = await startServer(async (request, response) => {
  const body = await bodyOf(request);
  logBodies.push(body);
  const id = JSON.parse(body).id;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result: [{ route: "public-logs" }] }));
});

const proxy = await startSplitRpcProxy({ archiveUrl, logUrl: logs.url + "/public" });
try {
  await waitForSplitRpcProxy(proxy.url);
  check(true, "loopback readiness succeeds before a child can start");

  const logRequest = '{ "jsonrpc": "2.0", "id": 7, "method": "eth_getLogs", "params": [{"fromBlock":"0x1","toBlock":"0x2"}] }';
  const logReply = await fetch(proxy.url, { method: "POST", headers: { "content-type": "application/json" }, body: logRequest });
  check(logReply.status === 200 && (await logReply.json()).result[0].route === "public-logs", "eth_getLogs is routed only to the public upstream");
  check(logBodies.at(-1) === logRequest && archiveBodies.length === 0, "the public request body is preserved byte for byte");

  const batchRequest = '[ {"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x1",false]},\n {"jsonrpc":"2.0","id":2,"method":"eth_getBlockByNumber","params":["0x2",false]} ]';
  const expectedBatchReply = '[ {"jsonrpc":"2.0","id":2,"result":{"number":"0x2"}}, {"jsonrpc":"2.0","id":1,"result":{"number":"0x1"}} ]\n';
  const batchReply = await fetch(proxy.url, { method: "POST", headers: { "content-type": "application/json" }, body: batchRequest });
  check(batchReply.status === 200 && await batchReply.text() === expectedBatchReply, "a non-log JSON-RPC batch response is preserved byte for byte");
  check(archiveBodies.at(-1) === batchRequest && logBodies.length === 1, "the complete non-log batch is routed intact to the archive upstream");

  const mixedBefore = archiveBodies.length + logBodies.length;
  const mixed = await fetch(proxy.url, { method: "POST", headers: { "content-type": "application/json" }, body: '[{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[]},{"jsonrpc":"2.0","id":2,"method":"eth_chainId","params":[]}]' });
  check(mixed.status === 400 && archiveBodies.length + logBodies.length === mixedBefore, "mixed batches are refused rather than split or reordered");

  archiveMode = "failure";
  const failed = await fetch(proxy.url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":8,"method":"eth_chainId","params":[]}' });
  const failedBody = await failed.text();
  check(failed.status === 502 && failedBody === "upstream RPC request failed" && !failedBody.includes("archive-secret-value"), "upstream HTTP failures are categorical and do not expose the secret endpoint");

  archiveMode = "limited";
  const limited = await fetch(proxy.url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":8,"method":"eth_chainId","params":[]}' });
  check(limited.status === 429 && await limited.text() === "upstream RPC request failed", "an upstream 429 remains a 429 for the existing Gate retry accounting");

  archiveMode = "invalid";
  const invalid = await fetch(proxy.url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":8,"method":"eth_chainId","params":[]}' });
  const invalidBody = await invalid.text();
  check(invalid.status === 502 && invalidBody === "upstream RPC returned an invalid body" && !invalidBody.includes("archive-secret-value"), "an invalid upstream body is refused without echoing it");

  archiveMode = "rpc-secret";
  const rpcError = await fetch(proxy.url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":9,"method":"eth_getCode","params":[]}' });
  const rpcErrorBody = await rpcError.text();
  check(rpcError.status === 200 && rpcErrorBody.includes("<redacted-rpc>") && !rpcErrorBody.includes("archive-secret-value"), "a JSON-RPC error cannot reflect the secret endpoint into child logs");

  const reflectedEndpoint = "https://api-key-host.example/v2/path-secret";
  const reflectedProxy = await startSplitRpcProxy({
    archiveUrl: reflectedEndpoint,
    logUrl: logs.url,
    fetchImpl: async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      result: {
        endpoint: reflectedEndpoint,
        origin: "https://api-key-host.example",
        host: "api-key-host.example",
        path: "/v2/path-secret",
        nested: ["path-secret", { "api-key-host.example": "kept out" }]
      }
    }), { status: 200, headers: { "content-type": "application/json" } })
  });
  try {
    const reflected = await fetch(reflectedProxy.url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":10,"method":"eth_chainId","params":[]}' });
    const reflectedBody = await reflected.text();
    check(reflected.status === 200 && reflectedBody.includes("<redacted-rpc>") && !reflectedBody.includes("api-key-host") && !reflectedBody.includes("path-secret"), "credential-bearing host and path components are redacted from every successful JSON result field and key");
  } finally { await reflectedProxy.close(); }

  const transportProxy = await startSplitRpcProxy({
    archiveUrl,
    logUrl: logs.url,
    fetchImpl: async () => { throw new Error("transport failed at " + archiveUrl); }
  });
  try {
    const transport = await fetch(transportProxy.url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":11,"method":"eth_chainId","params":[]}' });
    const transportBody = await transport.text();
    check(transport.status === 502 && transportBody === "upstream RPC request failed" && !transportBody.includes("archive-secret-value"), "an upstream transport failure cannot expose its endpoint");
  } finally { await transportProxy.close(); }

  let markUpstreamStarted;
  const upstreamStarted = new Promise(resolve => { markUpstreamStarted = resolve; });
  let upstreamAborted = false;
  const abortProxy = await startSplitRpcProxy({
    archiveUrl,
    logUrl: logs.url,
    fetchImpl: async (_url, init) => await new Promise((_resolve, reject) => {
      markUpstreamStarted();
      init.signal.addEventListener("abort", () => {
        upstreamAborted = true;
        reject(new Error("aborted"));
      }, { once: true });
    })
  });
  const abandonedRequest = fetch(abortProxy.url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":12,"method":"eth_chainId","params":[]}' }).catch(() => null);
  await upstreamStarted;
  const closeStarted = Date.now();
  await abortProxy.close();
  await abandonedRequest;
  check(upstreamAborted && Date.now() - closeStarted < 1000, "shutdown aborts an in-flight upstream request instead of waiting for its deadline");

  archiveMode = "normal";
  const child = await runThroughSplitRpc([
    "--", process.execPath, "-e",
    'const u=process.env.LINTCHA_CHAIN_RPC_URL||"";process.exit(/^http:\\/\\/127\\.0\\.0\\.1:[0-9]+$/.test(u)&&!u.includes("archive-secret-value")?0:9)'
  ], { ...process.env, LINTCHA_CHAIN_RPC_URL: archiveUrl });
  check(child.code === 0 && child.signal === null, "the wrapped child receives only a loopback RPC URL");

  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "launch-refresh.yml"), "utf8");
  check(/\n  refresh:\r?\n    runs-on: ubuntu-latest\r?\n    environment: launch-refresh\r?\n/.test(workflow), "the whole refresh job is bound to its protected GitHub Environment");
  check((workflow.match(/LINTCHA_CHAIN_RPC_URL: \$\{\{ secrets\.LINTCHA_CHAIN_RPC_URL \}\}/g) || []).length === 2, "the archive secret is scoped to exactly the two RPC-reading workflow steps");
  check((workflow.match(/node tools\/with-launch-rpc-split\.mjs -- node tools\/(?:launch-collect|collection-guard)\.mjs/g) || []).length === 2, "both and only the collector and strict guard run through the split wrapper");
  check(workflow.indexOf("Pin this run to the exact clean main revision") < workflow.indexOf("secrets.LINTCHA_CHAIN_RPC_URL"), "the workflow refuses a non-main or moved revision before either secret-bearing step");
} finally {
  await proxy.close();
  await archive.close();
  await logs.close();
}

let stopped = false;
try { await fetch(proxy.url + "/ready"); } catch { stopped = true; }
check(stopped, "shutdown closes the loopback listener");
await proxy.close();
check(true, "shutdown is idempotent");

console.log(`${passed} launch RPC split checks passed`);
