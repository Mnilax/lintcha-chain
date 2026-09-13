// Focused contract test for the user-controlled five-stage explanatory proof loop.
//   node tests/proof_loop_test.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const source = fs.readFileSync(path.resolve(__dirname, "..", "site", "proof-loop.js"), "utf8");
const shell = fs.readFileSync(path.resolve(__dirname, "..", "src", "templates", "shell.html"), "utf8");
const css = fs.readFileSync(path.resolve(__dirname, "..", "site", "proof.css"), "utf8");

let checks = 0, failures = 0;
const ok = (value, label) => { checks++; if (!value) { failures++; console.log("  FAIL " + label); } };

class Element {
  constructor(attrs = {}) {
    this.attrs = new Map(Object.entries(attrs));
    this.listeners = Object.create(null);
    this._text = "";
    this.textHistory = [];
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
  dispatch(name) { for (const fn of this.listeners[name] || []) fn({ type: name }); }
  set textContent(value) { this._text = String(value); this.textHistory.push(this._text); }
  get textContent() { return this._text; }
}

function harness({ reduced = false, count = 5, delay = "310" } = {}) {
  const stepLabels = Array.from({ length: count }, (_, index) => `translated-stage-${index + 1}-\u03bb`);
  const steps = stepLabels.map(label => new Element({ "data-proof-step": "", "data-proof-label": label }));
  const button = new Element({
    "data-proof-play": "",
    "data-label-play": "translated-play",
    "data-label-pause": "translated-pause",
    "data-label-resume": "translated-resume",
    "data-label-replay": "translated-replay"
  });
  const status = new Element({ "data-proof-status": "" });
  const root = new Element({ "data-proof-loop": "", "data-proof-delay": delay });
  root.querySelectorAll = selector => selector === "[data-proof-step]" ? steps : [];
  root.querySelector = selector => selector === "[data-proof-play]" ? button : selector === "[data-proof-status]" ? status : null;

  let nextTimer = 1;
  const timers = new Map();
  const scheduledDelays = [];
  const mediaListeners = [];
  const media = {
    matches: reduced,
    addEventListener(name, fn) { if (name === "change") mediaListeners.push(fn); }
  };
  const fakeWindow = {
    matchMedia(query) { ok(query === "(prefers-reduced-motion: reduce)", "the standard reduced-motion query is used"); return media; },
    setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, fn); scheduledDelays.push(ms); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const document = { querySelectorAll: selector => selector === "[data-proof-loop]" ? [root] : [] };
  vm.runInNewContext(source, { document, window: fakeWindow, Number, Array }, { filename: "proof-loop.js" });

  function runNext() {
    const entry = timers.entries().next().value;
    if (!entry) return false;
    timers.delete(entry[0]);
    entry[1]();
    return true;
  }
  return { root, steps, button, status, timers, scheduledDelays, stepLabels, media, mediaListeners, runNext };
}

ok(!/fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(source), "the controller is network-silent");
ok(!/addEventListener\(\s*["']key(?:down|up|press)/.test(source), "native button keyboard behavior is not replaced");
ok(!/Lintcha|snapshot|compare|verdict|score|rating|price|market cap/i.test(source), "the controller hard-codes no product or marketing claim");
ok((shell.match(/data-proof-step(?:>|\s)/g) || []).length === 5 && shell.includes("data-proof-loop") && shell.includes("data-proof-play"), "the page authors exactly one five-stage proof loop with one native control");
ok(shell.includes("proof.note") && shell.indexOf("proof-loop.js") < shell.indexOf("chain.js"), "the page carries translated disclosure copy and loads its local controller");
ok(css.includes("prefers-reduced-motion:reduce") && !/url\s*\(/i.test(css), "the owned presentation removes motion on request and loads no external asset");

const run = harness();
ok(run.root.getAttribute("data-proof-state") === "idle", "the loop starts idle");
ok(run.button.textContent === "translated-play" && run.button.getAttribute("aria-label") === "translated-play", "the initial action uses translated markup copy");
ok(run.button.getAttribute("type") === "button", "the control is a native non-submit button");
ok(run.status.getAttribute("aria-live") === "polite" && run.status.getAttribute("aria-atomic") === "true", "progress is exposed as one polite live update");
ok(run.timers.size === 0 && run.status.textHistory.length === 0, "initialization does not autoplay or invent status text");

run.button.dispatch("click");
ok(run.root.getAttribute("data-proof-state") === "running", "the first click starts one run");
ok(run.status.textContent === run.stepLabels[0] && run.steps[0].getAttribute("aria-current") === "step", "stage one is first and current");
ok(run.button.textContent === "translated-pause" && run.timers.size === 1, "a running loop offers pause and owns one timer");
ok(run.scheduledDelays[0] === 310, "the bounded markup delay is honored");

run.button.dispatch("click");
ok(run.root.getAttribute("data-proof-state") === "paused" && run.timers.size === 0, "a mid-run click pauses without advancing");
ok(run.button.textContent === "translated-resume" && run.status.textContent === run.stepLabels[0], "pause preserves the exact stage and translated status");
run.button.dispatch("click");
ok(run.root.getAttribute("data-proof-state") === "running" && run.button.textContent === "translated-pause" && run.timers.size === 1, "the next click resumes from that stage");

while (run.runNext()) {}
ok(run.root.getAttribute("data-proof-state") === "complete", "the ordered run completes");
ok(run.status.textHistory.join("|") === run.stepLabels.join("|"), "all five translated stages are visited exactly once and in order");
ok(run.steps.every(step => step.getAttribute("data-proof-seen") === "true"), "all completed stages remain visibly marked as seen");
ok(run.steps[4].getAttribute("aria-current") === "step" && run.button.textContent === "translated-replay", "the fifth stage remains current and the action becomes replay");
ok(run.timers.size === 0, "completion leaves no timer running");

run.button.dispatch("click");
ok(run.status.textContent === run.stepLabels[0] && run.status.textHistory.length === 6, "replay begins a fresh ordered run at stage one");
ok(run.steps[0].getAttribute("data-proof-seen") === "true" && !run.steps[1].getAttribute("data-proof-seen"), "replay clears later progress before advancing");

const reduced = harness({ reduced: true });
reduced.button.dispatch("click");
ok(reduced.root.getAttribute("data-proof-state") === "complete" && reduced.timers.size === 0, "reduced motion completes without timed animation");
ok(reduced.status.textHistory.join("|") === reduced.stepLabels.join("|"), "reduced motion still processes the five stages in order");

const changed = harness();
changed.button.dispatch("click");
changed.media.matches = true;
changed.mediaListeners[0]({ matches: true });
ok(changed.root.getAttribute("data-proof-state") === "complete" && changed.timers.size === 0, "enabling reduced motion during playback removes pending animation");
ok(changed.status.textHistory.join("|") === changed.stepLabels.join("|"), "a motion-preference change preserves ordered completion");

const malformed = harness({ count: 4 });
malformed.button.dispatch("click");
ok(malformed.root.getAttribute("data-proof-state") === null && malformed.timers.size === 0, "a surface without exactly five stages is left inert");

const bounded = harness({ delay: "999999" });
bounded.button.dispatch("click");
ok(bounded.scheduledDelays[0] === 900, "an out-of-range delay falls back to the bounded default");

console.log(`proof loop: ${checks} checks, ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
