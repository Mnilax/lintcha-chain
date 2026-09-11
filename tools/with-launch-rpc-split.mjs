#!/usr/bin/env node
// Run one launch-refresh command behind a loopback-only JSON-RPC router. The checked-in public Robinhood
// endpoint serves only eth_getLogs; the credential-bearing endpoint from LINTCHA_CHAIN_RPC_URL serves every
// state, transaction and block-header request. The child sees only the loopback URL, and neither endpoint nor
// any upstream response body is written to stdout/stderr by this process.
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RPC_ENV = "LINTCHA_CHAIN_RPC_URL";
export const PUBLIC_LOG_RPC = "https://rpc.mainnet.chain.robinhood.com";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60000;
const READY_TIMEOUT_MS = 5000;

const loopback = hostname => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname);

export function upstreamUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(label + " is not a URL"); }
  if (url.username || url.password || url.search || url.hash) throw new Error(label + " must not contain userinfo, a query or a fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) {
    throw new Error(label + " must use HTTPS (plain HTTP is accepted only on loopback)");
  }
  return url.href;
}

const requestRoute = body => {
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { throw new Error("request body is not valid UTF-8 JSON"); }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  if (!requests.length || requests.some(item => !item || typeof item !== "object" || Array.isArray(item) || typeof item.method !== "string" || !item.method)) {
    throw new Error("request body is not a JSON-RPC request or nonempty batch");
  }
  const routes = new Set(requests.map(item => item.method === "eth_getLogs" ? "logs" : "archive"));
  // No current launch-refresh call mixes logs with another method. Refusing that new shape keeps every accepted
  // batch byte-for-byte intact instead of silently splitting and reordering it.
  if (routes.size !== 1) throw new Error("mixed eth_getLogs/non-log batches are not supported");
  return routes.values().next().value;
};

const boundedRequestBody = async request => {
  const stated = request.headers["content-length"];
  if (stated !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(stated) || BigInt(stated) > BigInt(MAX_REQUEST_BYTES))) {
    throw Object.assign(new Error("request body exceeds its bound"), { statusCode: 413 });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) throw Object.assign(new Error("request body exceeds its bound"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
};

const boundedResponseBody = async response => {
  const stated = response.headers.get("content-length");
  if (stated !== null && (!/^(?:0|[1-9][0-9]*)$/.test(stated) || BigInt(stated) > BigInt(MAX_RESPONSE_BYTES))) {
    try { await response.body?.cancel(); } catch {}
    throw new Error("upstream response exceeds its bound");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new Error("upstream response exceeds its bound");
      }
      chunks.push(Buffer.from(part.value));
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  }
  return Buffer.concat(chunks, total);
};

const endpointSecrets = endpoint => {
  const parsed = new URL(endpoint), values = [endpoint];
  values.push(parsed.origin, parsed.host, parsed.hostname);
  if (parsed.pathname && parsed.pathname !== "/") {
    values.push(parsed.pathname);
    try { values.push(decodeURIComponent(parsed.pathname)); } catch {}
  }
  for (const segment of parsed.pathname.split("/")) if (segment) {
    values.push(segment);
    try { values.push(decodeURIComponent(segment)); } catch {}
  }
  return [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length);
};

const protectedUpstreamBody = (bytes, secrets = []) => {
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return null; }
  let changed = false;
  const redactString = value => {
    let output = value;
    for (const secret of secrets) output = output.split(secret).join("<redacted-rpc>");
    if (output !== value) changed = true;
    return output;
  };
  const redactValue = value => {
    if (typeof value === "string") return redactString(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactString(key), redactValue(item)]));
  };
  const protectedValue = redactValue(parsed);
  return changed ? Buffer.from(JSON.stringify(protectedValue), "utf8") : bytes;
};

const sendText = (response, statusCode, text) => {
  const body = Buffer.from(text, "utf8");
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store"
  });
  response.end(body);
};

const closeServer = server => new Promise((resolve, reject) => {
  if (!server.listening) { resolve(); return; }
  server.close(error => error ? reject(error) : resolve());
  server.closeAllConnections?.();
});

export async function startSplitRpcProxy({ archiveUrl, logUrl = PUBLIC_LOG_RPC, fetchImpl = fetch } = {}) {
  const archive = upstreamUrl(archiveUrl, "archive RPC"), logs = upstreamUrl(logUrl, "public log RPC");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  const upstreamControllers = new Set();
  const server = http.createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    if (request.method === "GET" && request.url === "/ready") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== "POST" || request.url !== "/") {
      sendText(response, 404, "not found");
      return;
    }
    let upstreamController = null, upstreamTimer = null;
    try {
      const body = await boundedRequestBody(request);
      const route = requestRoute(body), target = route === "logs" ? logs : archive;
      upstreamController = new AbortController();
      upstreamControllers.add(upstreamController);
      upstreamTimer = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
      upstreamTimer.unref?.();
      const upstream = await fetchImpl(target, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "user-agent": "lintcha-chain-launch-rpc-split/0.1 (+https://lintcha.com)"
        },
        body,
        signal: upstreamController.signal
      });
      if (upstream.status !== 200) {
        try { await upstream.body?.cancel(); } catch {}
        sendText(response, upstream.status === 429 ? 429 : 502, "upstream RPC request failed");
        return;
      }
      const upstreamBody = protectedUpstreamBody(await boundedResponseBody(upstream), route === "archive" ? endpointSecrets(archive) : []);
      if (!upstreamBody) {
        sendText(response, 502, "upstream RPC returned an invalid body");
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(upstreamBody.length),
        "cache-control": "no-store"
      });
      response.end(upstreamBody);
    } catch (error) {
      const status = error && error.statusCode === 413 ? 413 : error && /^request body|^mixed /.test(error.message || "") ? 400 : 502;
      sendText(response, status, status === 502 ? "upstream RPC request failed" : error.message);
    } finally {
      if (upstreamTimer) clearTimeout(upstreamTimer);
      if (upstreamController) upstreamControllers.delete(upstreamController);
    }
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  await new Promise((resolve, reject) => {
    const onError = error => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LOOPBACK_HOST);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("loopback proxy did not acquire a TCP port");
  }
  let closed = false;
  return {
    url: `http://${LOOPBACK_HOST}:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      for (const controller of upstreamControllers) controller.abort();
      await closeServer(server);
    }
  };
}

export async function waitForSplitRpcProxy(url, { fetchImpl = fetch, timeoutMs = READY_TIMEOUT_MS } = {}) {
  const ready = new URL("/ready", url).href, deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(ready, { redirect: "error", signal: AbortSignal.timeout(Math.min(500, timeoutMs)) });
      if (response.status === 204) return;
      try { await response.body?.cancel(); } catch {}
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("loopback RPC proxy was not ready");
}

export async function runThroughSplitRpc(argv, env = process.env) {
  const separator = argv.indexOf("--"), command = separator >= 0 ? argv[separator + 1] : null;
  const args = separator >= 0 ? argv.slice(separator + 2) : [];
  if (separator !== 0 || !command) throw new Error("usage: node tools/with-launch-rpc-split.mjs -- COMMAND [ARG ...]");
  const archive = env[RPC_ENV];
  if (!archive) throw new Error(RPC_ENV + " is required for the archive/state upstream");
  const proxy = await startSplitRpcProxy({ archiveUrl: archive });
  let child = null;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const forward = signal => { if (child && child.exitCode === null && child.signalCode === null) child.kill(signal); };
  const handlers = new Map(signals.map(signal => [signal, () => forward(signal)]));
  try {
    await waitForSplitRpcProxy(proxy.url);
    const childEnv = { ...env, [RPC_ENV]: proxy.url };
    child = spawn(command, args, { env: childEnv, stdio: "inherit", shell: false });
    for (const [signal, handler] of handlers) process.on(signal, handler);
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await proxy.close();
  }
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokedPath) {
  runThroughSplitRpc(process.argv.slice(2)).then(result => {
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }
    process.exitCode = result.code;
  }).catch(error => {
    console.error("launch RPC split: " + (error && error.message ? error.message : "failed"));
    process.exitCode = 1;
  });
}
