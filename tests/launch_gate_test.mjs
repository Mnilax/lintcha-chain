// The collector's limiter (tools/launch/rpc.mjs) against a fake endpoint: spacing between request starts, the
// in-flight cap, a 429 answered with a wait and a retry (never a failure), a non-429 error rejected, and the counts.
//   node tests/launch_gate_test.mjs
import { Gate } from "../tools/launch/rpc.mjs";
let checks = 0, failures = 0;
const fail = m => { failures++; console.error("FAIL " + m); };
const ok = (cond, what) => { checks++; if (!cond) fail(what); };

const starts = []; let active = 0, peak = 0, script = [];
globalThis.fetch = async (url, init) => {
  const req = JSON.parse(init.body); starts.push({ t: Date.now(), method: req.method }); active++; peak = Math.max(peak, active);
  const step = script.shift() || { status: 200, body: { jsonrpc: "2.0", id: req.id, result: "ok:" + req.method } };
  await new Promise(r => setTimeout(r, step.delay || 20)); active--;
  return { status: step.status, text: async () => typeof step.body === "string" ? step.body : JSON.stringify(step.body) };
};

(async () => {
  // spacing and the in-flight cap
  let g = new Gate({ url: "fake", inFlight: 2, spacingMs: 60, logsSpacingMs: 150, cooldownMs: 100 });
  script = new Array(6).fill({ status: 200, body: { result: 1 }, delay: 200 });
  const t0 = Date.now();
  const r = await Promise.all(["a", "b", "c", "d", "eth_getLogs", "f"].map(m => g.call(m, [])));
  ok(r.length === 6 && r.every(x => x === 1), "six calls resolve");
  ok(peak <= 2, "never more than two in flight, peak " + peak);
  for (let i = 1; i < starts.length; i++) ok(starts[i].t - starts[i - 1].t >= 55, `starts spaced by the minimum (${starts[i].t - starts[i - 1].t} ms before ${starts[i].method})`);
  const afterLogs = starts.findIndex(s => s.method === "eth_getLogs");
  ok(afterLogs >= 0 && starts[afterLogs + 1].t - starts[afterLogs].t >= 145, "the wider spacing after eth_getLogs");
  ok(g.stats.calls === 6 && g.stats.http429 === 0 && g.stats.retries === 0, "counts: six calls, no 429, no retry");
  ok(Date.now() - t0 >= 5 * 60, "the run took at least five spacings");

  // a 429 is a wait and a retry, not a failure; the wait doubles, and a success resets it
  g = new Gate({ url: "fake", inFlight: 1, spacingMs: 10, cooldownMs: 100, maxCooldownMs: 1000, log: () => {} });
  starts.length = 0;
  script = [{ status: 429, body: "Too Many Requests" }, { status: 200, body: { error: { code: 429, message: "Too Many Requests" } } }, { status: 200, body: { result: "fine" } }];
  const t1 = Date.now(); const v = await g.call("x", []);
  ok(v === "fine", "resolves after two 429s");
  ok(g.stats.http429 === 1 && g.stats.rpc429 === 1 && g.stats.retries === 2 && g.stats.calls === 3, "counts one http 429, one rpc 429, two retries, three calls: " + JSON.stringify(g.stats));
  ok(Date.now() - t1 >= 100 + 200 - 5, "waited the first cooldown and its double");
  ok(g.backoff === 100, "a success resets the backoff");

  // a non-429 http error is retried after a cooldown; a json-rpc error other than 429 is rejected at once
  g = new Gate({ url: "fake", inFlight: 1, spacingMs: 10, cooldownMs: 50, log: () => {} });
  script = [{ status: 520, body: "<html>edge</html>" }, { status: 200, body: { result: 7 } }];
  ok(await g.call("y", []) === 7, "a 520 is retried");
  ok(g.stats.otherErrors === 1, "the 520 is counted as another error");
  script = [{ status: 200, body: { error: { code: -32000, message: "block range too wide" } } }];
  let rejected = null; try { await g.call("eth_getLogs", []); } catch (e) { rejected = e.message; }
  ok(rejected && rejected.includes("block range too wide"), "an rpc error is rejected with its message: " + rejected);

  // gives up after maxRetries, with the reason
  g = new Gate({ url: "fake", inFlight: 1, spacingMs: 1, cooldownMs: 1, maxCooldownMs: 2, maxRetries: 2, log: () => {} });
  script = new Array(5).fill({ status: 429, body: "no" });
  rejected = null; try { await g.call("z", []); } catch (e) { rejected = e.message; }
  ok(rejected && rejected.includes("gave up after 3 tries"), "gives up after the retry budget: " + rejected);

  console.log(`launch gate test: ${checks} checks, ${failures} failure(s)`);
  process.exit(failures ? 1 : 0);
})();
