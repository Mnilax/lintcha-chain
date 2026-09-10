// The limiter for the public RPC, written for the launch collector: one gate for every request, a few in flight,
// a minimum spacing between request starts (wider for eth_getLogs), and on a 429 (http or json-rpc) a wait that
// doubles, never a failure. Every call is counted so the run can report its call count and its 429 count. The
// request names itself in its user agent: the endpoint's edge refuses anonymous library signatures (Cloudflare 1010).
export class Gate {
  constructor({ url, inFlight = 2, spacingMs = 600, logsSpacingMs = 1500, cooldownMs = 3000, maxCooldownMs = 60000, maxRetries = 10, log = () => {} } = {}) {
    Object.assign(this, { url, inFlight, spacingMs, logsSpacingMs, cooldownMs, maxCooldownMs, maxRetries, log });
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
    let status = 0, body = null, text = "";
    try {
      const r = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "lintcha-launch-collector/0.1 (+https://lintcha.com)" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: task.method, params: task.params }) });
      status = r.status; text = await r.text();
      try { body = JSON.parse(text); } catch { body = null; }
    } catch (e) { text = String(e); }
    const limited = status === 429 || (body && body.error && Number(body.error.code) === 429);
    if (limited) {
      if (status === 429) s.http429++; else s.rpc429++;
      this.cooldownUntil = Date.now() + this.backoff; this.log(`429 on ${task.method}: waiting ${this.backoff} ms`);
      this.backoff = Math.min(this.backoff * 2, this.maxCooldownMs);
      return this.again(task, "429");
    }
    if (status === 200 && body && "result" in body) { this.backoff = this.cooldownMs; task.resolve(body.result); return; }
    if (body && body.error) { task.reject(new Error(`${task.method}: rpc error ${body.error.code} ${body.error.message}`)); return; }
    s.otherErrors++; this.cooldownUntil = Date.now() + this.backoff; this.log(`http ${status} on ${task.method}: ${text.slice(0, 120)}; waiting ${this.backoff} ms`);
    this.backoff = Math.min(this.backoff * 2, this.maxCooldownMs);
    return this.again(task, `http ${status}`);
  }
  again(task, why) {
    if (++task.tries > this.maxRetries) { task.reject(new Error(`${task.method}: gave up after ${task.tries} tries (${why})`)); return; }
    this.stats.retries++; this.queue.unshift(task);
  }
}
