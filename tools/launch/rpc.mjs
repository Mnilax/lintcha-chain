// The limiter for the public RPC, written for the launch collector: one gate for every request, a few in flight,
// a minimum spacing between request starts (wider for eth_getLogs), and on a 429 (http or json-rpc) a wait that
// doubles, never a failure. Every call is counted so the run can report its call count and its 429 count. Collector
// request shapes are batch-bounded; every response body has a hard bound, cancellation is best effort and never
// awaited, and a successful reply must be JSON-RPC 2.0 with the exact request id. The request names itself in its user agent: the endpoint's
// edge refuses anonymous library signatures (Cloudflare 1010).
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;

const timeoutError = () => {
  const error = new Error("request deadline exceeded");
  error.name = "TimeoutError";
  return error;
};

const withAbort = async (promise, signal) => {
  if (signal.aborted) throw timeoutError();
  let onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(timeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([promise, stopped]); }
  finally { signal.removeEventListener("abort", onAbort); }
};

const cancelBestEffort = target => {
  try {
    const pending = target && typeof target.cancel === "function" ? target.cancel() : null;
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {}
};

const boundedText = async (response, limit, signal) => {
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
        if (total > limit) throw new Error("response body exceeds its bound");
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
  // Response-like objects without a byte stream exist only on the injected test surface.
  if (typeof response.text !== "function") throw new Error("response body is unreadable");
  const text = await withAbort(response.text(), signal);
  if (typeof text !== "string") throw new Error("response body is not text");
  if (new TextEncoder().encode(text).length > limit) throw new Error("response body exceeds its bound");
  return text;
};

const envelope = (body, id) => {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0" || body.id !== id) return null;
  const keys = Object.keys(body).sort().join(",");
  if (keys === "id,jsonrpc,result") return { kind: "result", value: body.result };
  if (keys !== "error,id,jsonrpc" || !body.error || typeof body.error !== "object" || Array.isArray(body.error) ||
      !Number.isSafeInteger(body.error.code) || typeof body.error.message !== "string") return null;
  const errorKeys = Object.keys(body.error);
  if (errorKeys.some(key => !["code", "data", "message"].includes(key)) || !errorKeys.includes("code") || !errorKeys.includes("message")) return null;
  return { kind: "error", value: body.error };
};

const safeFailure = error => {
  const message = error && typeof error.message === "string" ? error.message : "";
  if (error && error.name === "TimeoutError") return "request deadline exceeded";
  if ([
    "response content-length exceeds its bound",
    "response stream yielded non-byte data",
    "response body exceeds its bound",
    "response body is unreadable",
    "response body is not text"
  ].includes(message)) return message;
  // Fetch implementations may include their input URL in a transport error. Endpoint credentials belong in the
  // environment, so transport diagnostics stay categorical and can never echo that URL through the gate log.
  return "request failed";
};

const redactEndpoint = (text, url) => {
  let output = String(text), parsed;
  const secrets = [String(url)];
  try { parsed = new URL(url); } catch { parsed = null; }
  if (parsed) {
    secrets.push(parsed.origin, parsed.host, parsed.hostname);
    if (parsed.pathname && parsed.pathname !== "/") {
      secrets.push(parsed.pathname);
      try { secrets.push(decodeURIComponent(parsed.pathname)); } catch {}
    }
    for (const segment of parsed.pathname.split("/")) if (segment) {
      secrets.push(segment);
      try { secrets.push(decodeURIComponent(segment)); } catch {}
    }
  }
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) output = output.split(secret).join("<redacted-rpc>");
  return output;
};

export class Gate {
  constructor({ url, inFlight = 2, spacingMs = 600, logsSpacingMs = 1500, cooldownMs = 3000, maxCooldownMs = 60000, maxRetries = 10, requestTimeoutMs = 60000, maxResponseBytes = 64 * 1024 * 1024, log = () => {} } = {}) {
    if (typeof url !== "string" || !url || !positive(inFlight) || !nonnegative(spacingMs) || !nonnegative(logsSpacingMs) || !positive(cooldownMs) || !positive(maxCooldownMs) || !Number.isSafeInteger(maxRetries) || maxRetries < 0 || !positive(requestTimeoutMs) || !positive(maxResponseBytes) || typeof log !== "function") {
      throw new Error("RPC gate configuration is invalid");
    }
    Object.assign(this, { url, inFlight, spacingMs, logsSpacingMs, cooldownMs, maxCooldownMs, maxRetries, requestTimeoutMs, maxResponseBytes, log });
    this.queue = []; this.active = 0; this.nextAt = 0; this.cooldownUntil = 0; this.backoff = cooldownMs; this.id = 0;
    this.stats = { calls: 0, http429: 0, rpc429: 0, retries: 0, otherErrors: 0, byMethod: {}, firstAt: 0, lastAt: 0 };
    this.timer = null;
  }
  call(method, params) {
    return new Promise((resolve, reject) => { this.queue.push({ method, params, resolve, reject, tries: 0 }); this.pump(); });
  }
  pump() {
    if (this.timer) return;
    const now = Date.now(), at = Math.max(this.nextAt, this.cooldownUntil);
    if (this.active >= this.inFlight || !this.queue.length) return;
    if (now < at) { this.timer = setTimeout(() => { this.timer = null; this.pump(); }, at - now); return; }
    const task = this.queue.shift();
    this.nextAt = now + (task.method === "eth_getLogs" ? this.logsSpacingMs : this.spacingMs);
    this.active++;
    this.send(task).finally(() => { this.active--; this.pump(); });
    this.pump();
  }
  async send(task) {
    const s = this.stats; s.calls++; s.byMethod[task.method] = (s.byMethod[task.method] || 0) + 1;
    if (!s.firstAt) s.firstAt = Date.now(); s.lastAt = Date.now();
    let status = 0, body = null, failure = "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const id = ++this.id;
      const r = await withAbort(fetch(this.url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", "user-agent": "lintcha-launch-collector/0.1 (+https://lintcha.com)" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: task.method, params: task.params }), signal: controller.signal }), controller.signal);
      status = r.status;
      if (status === 429) cancelBestEffort(r.body);
      else {
        const text = await boundedText(r, this.maxResponseBytes, controller.signal);
        try { body = JSON.parse(text); } catch { failure = "response is not valid JSON"; }
        if (!failure) {
          const parsed = envelope(body, id);
          if (!parsed) failure = "response has a malformed JSON-RPC envelope";
          else body = parsed;
        }
      }
    } catch (error) { failure = safeFailure(error); }
    finally { clearTimeout(timer); }
    const limited = status === 429 || (body && body.kind === "error" && body.value.code === 429);
    if (limited) {
      if (status === 429) s.http429++; else s.rpc429++;
      this.cooldownUntil = Date.now() + this.backoff; this.log(`429 on ${task.method}: waiting ${this.backoff} ms`);
      this.backoff = Math.min(this.backoff * 2, this.maxCooldownMs);
      return this.again(task, "429");
    }
    if (status === 200 && body && body.kind === "result") { this.backoff = this.cooldownMs; task.resolve(body.value); return; }
    if (body && body.kind === "error") { task.reject(new Error(`${task.method}: rpc error ${body.value.code} ${redactEndpoint(body.value.message, this.url)}`)); return; }
    s.otherErrors++; this.cooldownUntil = Date.now() + this.backoff; this.log(`http ${status} or invalid response on ${task.method}: ${failure || "unexpected status"}; waiting ${this.backoff} ms`);
    this.backoff = Math.min(this.backoff * 2, this.maxCooldownMs);
    return this.again(task, failure || `http ${status}`);
  }
  again(task, why) {
    if (++task.tries > this.maxRetries) { task.reject(new Error(`${task.method}: gave up after ${task.tries} tries (${why})`)); return; }
    this.stats.retries++; this.queue.unshift(task);
  }
}
