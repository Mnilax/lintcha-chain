// Drives the real collector against a local JSON-RPC surface. The endpoint exists only in the environment and every
// identity read must use the one numeric finalized block captured before those reads, in both aggregate and direct
// fallback modes. No network is used.
//   node tests/launch_collector_state_test.mjs
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AGGREGATE3_RESULT, LAUNCHED_TOKEN, TOKEN_INFO, TOKEN_PARAMS, T, calldata, encode } from "../tools/launch/abi.mjs";
import { hex, selector, topic } from "../tools/launch/keccak.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collector = path.join(root, "tools", "launch-collect.mjs");
const source = fs.readFileSync(collector, "utf8");
const fact = pattern => { const found = pattern.exec(source); if (!found) throw new Error("collector source fact is missing"); return found[1]; };
const factory = fact(/const FACTORY = "(0x[0-9a-f]{40})";/);
const multicall = fact(/const MULTICALL3 = "(0x[0-9a-f]{40})";/);
const stateNumber = 1000, stateTag = "0x" + stateNumber.toString(16), stateHash = "0x" + "8".repeat(64);
const address = byte => "0x" + byte.repeat(20), word = value => value.replace(/^0x/, "").padStart(64, "0");
const quantity = value => "0x" + value.toString(16), encoded = value => "0x" + hex(value);
const token = address("11"), curve = address("22"), deployer = address("33"), pair = address("44"), recipient = address("77");
const txHash = "0x" + "5".repeat(64), eventHash = "0x" + "6".repeat(64);
const eventTopic = topic("TokenLaunched(address,address,address,address,uint256,uint256)");
const nameSelector = selector("name()"), symbolSelector = selector("symbol()"), infoSelector = selector("getTokenInfo()"), launchedSelector = selector("getLaunchedToken(address)");
const nameReturn = encoded(encode(T.tuple(T.string), ["Example name"]));
const symbolReturn = encoded(encode(T.tuple(T.string), ["EXAMPLE"]));
const socials = ["@one", "", "", "https://example.test", ""];
const infoReturn = encoded(encode(T.tuple(...TOKEN_INFO), [deployer, "ipfs://example", "a valid description", socials]));
const recordReturn = encoded(encode(LAUNCHED_TOKEN, [token, curve, deployer, recipient, pair, 2n, 2n, 3n, 4n, false, 5n, 6n, 7n, 8n, true]));
const aggregateReturn = encoded(encode(T.tuple(AGGREGATE3_RESULT), [[[true, nameReturn], [true, symbolReturn], [true, infoReturn], [true, recordReturn]]]));
const tokenParams = ["Example name", "EXAMPLE", "ipfs://example", "a valid description", socials, recipient, 100n, false, "0x" + "0".repeat(64), "0x" + "1".repeat(64)];
const txInput = calldata("0x12345678", [TOKEN_PARAMS], [tokenParams]);
const launchLog = {
  address: factory, removed: false,
  topics: [eventTopic, "0x" + word(token), "0x" + word(curve), "0x" + word(deployer)],
  data: "0x" + word(pair) + word("1") + word("2"), blockNumber: quantity(1), transactionIndex: "0x0", logIndex: "0x0",
  transactionHash: txHash, blockHash: eventHash
};
const changedStateHash = "0x" + "9".repeat(64);
let numericStateHash = stateHash, driftStateAfterIdentity = false, identityReadSeen = false;
const block = number => ({ number: quantity(number), timestamp: quantity(number), hash: number === stateNumber ? (driftStateAfterIdentity && identityReadSeen ? changedStateHash : numericStateHash) : eventHash });

let mode = "aggregate", calls = [], currentFinalizedNumber = stateNumber;
const rpc = http.createServer((request, response) => {
  let text = "";
  request.setEncoding("utf8"); request.on("data", chunk => { text += chunk; });
  request.on("end", () => {
    const item = JSON.parse(text); calls.push({ method: item.method, params: item.params });
    let result;
    if (item.method === "eth_chainId") result = quantity(4663);
    else if (item.method === "eth_getBlockByNumber" && item.params[0] === "finalized") result = block(currentFinalizedNumber);
    else if (item.method === "eth_getBlockByNumber") result = block(Number(BigInt(item.params[0])));
    else if (item.method === "eth_getCode") result = "0x01";
    else if (item.method === "eth_getLogs") result = [launchLog];
    else if (item.method === "eth_getTransactionByHash") result = { input: txInput, from: deployer, to: factory };
    else if (item.method === "eth_call" && (mode === "aggregate" || mode === "pinned" || mode === "postdrift") && item.params[0].to === multicall) { identityReadSeen = true; result = aggregateReturn; }
    else if (item.method === "eth_call" && mode === "direct") {
      identityReadSeen = true;
      const target = item.params[0].to, data = item.params[0].data;
      if (target === token && data === nameSelector) result = nameReturn;
      else if (target === token && data === symbolSelector) result = symbolReturn;
      else if (target === token && data === infoSelector) result = infoReturn;
      else if (target === factory && data.startsWith(launchedSelector)) result = recordReturn;
      else throw new Error("unexpected direct identity call");
    } else throw new Error("unexpected RPC call " + item.method);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: item.id, result }));
  });
});

await new Promise(resolve => rpc.listen(0, "127.0.0.1", resolve));
const port = rpc.address().port, secret = "collector-secret-sentinel";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lintcha-collector-state-"));
let checks = 0, failures = 0;
const ok = (condition, label) => { checks++; if (!condition) { failures++; console.error("FAIL " + label); } };
const run = (windowArgs, extra) => new Promise(resolve => {
  const output = path.join(tmp, mode + ".json"), env = { ...process.env, LINTCHA_CHAIN_RPC_URL: "http://127.0.0.1:" + port + "/" + secret };
  const child = spawn(process.execPath, [collector, ...windowArgs, "--chunk", "50000", "--spacing", "1", "--logs-spacing", "1", "--in-flight", "1", "--sample", "1", "--out", output, ...extra], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let combined = ""; child.stdout.on("data", chunk => { combined += chunk; }); child.stderr.on("data", chunk => { combined += chunk; });
  child.on("close", code => resolve({ code, combined, report: code === 0 ? JSON.parse(fs.readFileSync(output, "utf8")) : null }));
});

for (const [nextMode, extra] of [["aggregate", []], ["direct", ["--no-multicall"]]]) {
  mode = nextMode; calls = []; currentFinalizedNumber = stateNumber; numericStateHash = stateHash; driftStateAfterIdentity = false; identityReadSeen = false;
  const result = await run(["--smoke"], extra);
  ok(result.code === 0, nextMode + " collector run succeeds: " + result.combined.trim());
  ok(result.report && result.report.identity_state.number === stateNumber && result.report.identity_state.hash === stateHash, nextMode + " report records the captured finalized number and hash");
  ok(calls.filter(call => call.method === "eth_getBlockByNumber" && call.params[0] === "finalized").length === 1, nextMode + " captures finalized exactly once");
  const identityCalls = calls.filter(call => call.method === "eth_getCode" || call.method === "eth_call");
  ok(identityCalls.length > 0 && identityCalls.every(call => call.params[1] === stateTag), nextMode + " code and identity calls all use the captured numeric tag");
  ok(!identityCalls.some(call => call.params[1] === "latest"), nextMode + " identity path never reads latest");
  ok(!result.combined.includes(secret), nextMode + " output never prints the environment endpoint secret");
}

mode = "pinned"; calls = []; currentFinalizedNumber = stateNumber + 1; numericStateHash = stateHash; driftStateAfterIdentity = false; identityReadSeen = false;
const pinned = await run(["--from", "1", "--to", "1"], ["--identity-state-number", String(stateNumber), "--identity-state-hash", stateHash]);
ok(pinned.code === 0, "pinned historical collector run succeeds: " + pinned.combined.trim());
ok(pinned.report && pinned.report.identity_state.number === stateNumber && pinned.report.identity_state.hash === stateHash && pinned.report.window.finalized === stateNumber, "pinned report preserves the supplied canonical state rather than the newer finalized head");
ok(calls.filter(call => call.method === "eth_getBlockByNumber" && call.params[0] === "finalized").length === 1, "pinned run checks the current finalized floor exactly once");
const pinnedIdentityCalls = calls.filter(call => call.method === "eth_getCode" || call.method === "eth_call");
ok(pinnedIdentityCalls.length > 0 && pinnedIdentityCalls.every(call => call.params[1] === stateTag), "pinned run keeps every code and identity read on the published numeric tag");
ok(!pinnedIdentityCalls.some(call => call.params[1] === "latest"), "pinned identity path never reads latest");
ok(!pinned.combined.includes(secret), "pinned output never prints the environment endpoint secret");

mode = "mismatch"; calls = []; currentFinalizedNumber = stateNumber; numericStateHash = stateHash; driftStateAfterIdentity = false; identityReadSeen = false;
const mismatch = await run(["--from", "1", "--to", "1"], ["--identity-state-number", String(stateNumber), "--identity-state-hash", "0x" + "9".repeat(64)]);
ok(mismatch.code !== 0 && mismatch.combined.includes("contradicts"), "pinned run fails closed when current finality contradicts the published hash at the same height");
ok(!calls.some(call => call.method === "eth_getCode" || call.method === "eth_call"), "pinned hash mismatch fails before any identity read");
ok(!mismatch.combined.includes(secret), "pinned mismatch output never prints the environment endpoint secret");

mode = "historical-mismatch"; calls = []; currentFinalizedNumber = stateNumber + 1; numericStateHash = changedStateHash; driftStateAfterIdentity = false; identityReadSeen = false;
const historicalMismatch = await run(["--from", "1", "--to", "1"], ["--identity-state-number", String(stateNumber), "--identity-state-hash", stateHash]);
ok(historicalMismatch.code !== 0 && historicalMismatch.combined.includes("not canonical"), "pinned run fails when the historical numeric header differs from the published hash below a newer finalized head");
ok(!calls.some(call => call.method === "eth_getCode" || call.method === "eth_call"), "historical numeric-header mismatch fails before any identity read");

mode = "postdrift"; calls = []; currentFinalizedNumber = stateNumber; numericStateHash = stateHash; driftStateAfterIdentity = true; identityReadSeen = false;
const postDrift = await run(["--smoke"], []);
ok(postDrift.code !== 0 && postDrift.combined.includes("changed during identity reads"), "collector fails when the numeric state hash changes after identity reads");
const lastIdentityCall = calls.map((call, index) => ({ call, index })).filter(item => item.call.method === "eth_call").at(-1)?.index ?? -1;
ok(lastIdentityCall >= 0 && calls.slice(lastIdentityCall + 1).some(call => call.method === "eth_getBlockByNumber" && call.params[0] === stateTag), "collector rechecks the numeric state header after its last identity call");

await new Promise(resolve => rpc.close(resolve));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`launch collector state test: ${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
