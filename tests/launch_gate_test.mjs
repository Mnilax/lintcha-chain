// The collector RPC gate against an injected endpoint: scheduling/retry counters remain exact, while request time,
// response bytes and JSON-RPC correlation are all bounded and cancellation can never stall the queue.
//   node tests/launch_gate_test.mjs
import { Gate } from "../tools/launch/rpc.mjs";

let checks = 0, failures = 0;
const ok = (condition, label) => { checks++; if (!condition) { failures++; console.error("FAIL " + label); } };
const rejected = async promise => { try { await promise; return ""; } catch (error) { return error.message; } };
const base = { url: "https://rpc.example.invalid", inFlight: 1, spacingMs: 1, logsSpacingMs: 1, cooldownMs: 1, maxCooldownMs: 2, requestTimeoutMs: 50, maxResponseBytes: 1024, log: () => {} };
const replies = [];

globalThis.fetch = async (_url, init) => {
  const request = JSON.parse(init.body), next = replies.shift();
  if (typeof next === "function") return await next(request, init);
  const spec = next || { status: 200, result: "ok" };
  const body = Object.prototype.hasOwnProperty.call(spec, "body") ? spec.body : Object.prototype.hasOwnProperty.call(spec, "error")
    ? { jsonrpc: "2.0", id: request.id, error: spec.error }
    : { jsonrpc: "2.0", id: request.id, result: spec.result };
  return { status: spec.status ?? 200, headers: spec.headers, body: spec.stream, text: async () => typeof body === "string" ? body : JSON.stringify(body) };
};

// A normal result is accepted only through its exact JSON-RPC envelope.
let gate = new Gate(base);
replies.push({ result: 7 });
ok(await gate.call("eth_blockNumber", []) === 7, "accepts an exact JSON-RPC 2.0 result");
ok(gate.stats.calls === 1 && gate.stats.retries === 0 && gate.stats.otherErrors === 0, "a valid result preserves success accounting");

let redirectPolicy = null;
gate = new Gate(base);
replies.push((_request, init) => { redirectPolicy = init.redirect; return { status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }) }; });
ok(await gate.call("eth_blockNumber", []) === "ok" && redirectPolicy === "error", "refuses to follow redirects for an endpoint that may carry a path credential");

gate = new Gate({ ...base, spacingMs: 0, logsSpacingMs: 0 });
replies.push({ result: "zero-spacing" });
ok(await gate.call("eth_blockNumber", []) === "zero-spacing", "accepts an intentional zero spacing while every request remains concurrency-bound");

for (const [label, body] of [
  ["wrong version", { jsonrpc: "1.0", id: 1, result: 7 }],
  ["wrong id", { jsonrpc: "2.0", id: 2, result: 7 }],
  ["extra envelope field", { jsonrpc: "2.0", id: 1, result: 7, extra: true }],
  ["invalid JSON", "{"],
  ["array envelope", [{ jsonrpc: "2.0", id: 1, result: 7 }]]
]) {
  gate = new Gate({ ...base, maxRetries: 0 });
  replies.push({ body });
  const message = await rejected(gate.call("eth_blockNumber", []));
  ok(message.includes("gave up after 1 tries") && gate.stats.otherErrors === 1, "refuses " + label + " and counts the invalid response");
}

// A provider RPC error is rejected immediately; a JSON-RPC 429 still follows the old retry path.
gate = new Gate({ ...base, maxRetries: 1 });
replies.push({ error: { code: -32000, message: "range too wide" } });
ok((await rejected(gate.call("eth_getLogs", []))).includes("range too wide") && gate.stats.retries === 0, "rejects a non-429 RPC error without retrying");
gate = new Gate({ ...base, maxRetries: 1 });
replies.push({ status: 400, error: { code: -32602, message: "invalid params" } });
ok((await rejected(gate.call("eth_call", []))).includes("invalid params") && gate.stats.calls === 1 && gate.stats.retries === 0, "preserves immediate non-429 RPC errors carried by a non-200 HTTP reply");
gate = new Gate({ ...base, maxRetries: 1 });
replies.push({ error: { code: 429, message: "limited" } }, { result: "fine" });
ok(await gate.call("eth_call", []) === "fine", "retries a strict JSON-RPC 429");
ok(gate.stats.rpc429 === 1 && gate.stats.retries === 1 && gate.stats.calls === 2, "preserves JSON-RPC 429 accounting");

// An HTTP 429 body can expose a cancellation that never settles; the retry must still run.
let cancelled = 0;
gate = new Gate({ ...base, maxRetries: 1 });
replies.push(
  () => ({ status: 429, body: { cancel: () => { cancelled++; return new Promise(() => {}); } } }),
  { result: "after-http-429" }
);
ok(await gate.call("eth_call", []) === "after-http-429" && cancelled === 1, "nonblocking cancellation cannot stall an HTTP 429 retry");
ok(gate.stats.http429 === 1 && gate.stats.retries === 1 && gate.stats.calls === 2, "preserves HTTP 429 accounting");

// Both a declared oversized body and a streamed oversized body fail inside the byte bound.
cancelled = 0;
gate = new Gate({ ...base, maxRetries: 0, maxResponseBytes: 8 });
replies.push(() => ({ status: 200, headers: { get: () => "9" }, body: { cancel: () => { cancelled++; return new Promise(() => {}); } }, text: async () => "ignored" }));
let message = await rejected(gate.call("eth_call", []));
ok(message.includes("content-length exceeds") && cancelled === 1, "refuses an oversized declared response without awaiting cancellation");

cancelled = 0;
gate = new Gate({ ...base, maxRetries: 0, maxResponseBytes: 8 });
replies.push(() => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(9)); },
  cancel() { cancelled++; return new Promise(() => {}); }
}), { status: 200 }));
message = await rejected(gate.call("eth_call", []));
ok(message.includes("response body exceeds") && cancelled === 1, "refuses an oversized stream without awaiting cancellation");

// The same deadline bounds a fetch that never returns and a body that never finishes.
gate = new Gate({ ...base, maxRetries: 0, requestTimeoutMs: 5 });
replies.push(() => new Promise(() => {}));
message = await rejected(gate.call("eth_call", []));
ok(message.includes("request deadline exceeded"), "bounds a fetch that ignores abort");
gate = new Gate({ ...base, maxRetries: 0, requestTimeoutMs: 5 });
replies.push(() => ({ status: 200, text: () => new Promise(() => {}) }));
message = await rejected(gate.call("eth_call", []));
ok(message.includes("request deadline exceeded"), "bounds a response body that never settles");

const endpointSecret = "endpoint-secret-sentinel";
gate = new Gate({ ...base, url: "https://rpc.example.invalid/" + endpointSecret, maxRetries: 0 });
replies.push(() => { throw new Error("transport refused https://rpc.example.invalid/" + endpointSecret); });
message = await rejected(gate.call("eth_call", []));
ok(message.includes("request failed") && !message.includes(endpointSecret), "never echoes a credential-bearing endpoint from a transport exception");
gate = new Gate({ ...base, url: "https://rpc.example.invalid/" + endpointSecret, maxRetries: 0 });
replies.push({ error: { code: -32000, message: "provider rejected /" + endpointSecret } });
message = await rejected(gate.call("eth_call", []));
ok(message.includes("rpc error -32000") && !message.includes(endpointSecret), "redacts an endpoint path credential reflected by a provider RPC error");
gate = new Gate({ ...base, url: "https://rpc.example.invalid/ab/cd", maxRetries: 0 });
replies.push({ error: { code: -32000, message: "provider rejected /ab/cd" } });
message = await rejected(gate.call("eth_call", []));
ok(message.includes("rpc error -32000") && !message.includes("/ab/cd"), "redacts a complete credential path even when every segment is short");
gate = new Gate({ ...base, url: "https://endpoint-secret-sentinel.example.invalid/", maxRetries: 0 });
replies.push({ error: { code: -32000, message: "provider rejected endpoint-secret-sentinel.example.invalid" } });
message = await rejected(gate.call("eth_call", []));
ok(message.includes("rpc error -32000") && !message.includes("endpoint-secret-sentinel"), "redacts a credential-bearing endpoint hostname reflected by a provider RPC error");

let badConfig = false;
try { new Gate({ ...base, requestTimeoutMs: 0 }); } catch (error) { badConfig = error.message.includes("configuration"); }
ok(badConfig, "refuses an unbounded request deadline");
badConfig = false;
try { new Gate({ ...base, spacingMs: -1 }); } catch (error) { badConfig = error.message.includes("configuration"); }
ok(badConfig, "refuses a negative request spacing");

console.log(`launch gate test: ${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
