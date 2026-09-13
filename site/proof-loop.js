// User-controlled, explanatory playback for the five proof stages authored in the page.
// All visible copy comes from translated data attributes in the markup; this controller adds no claims.
(function () {
  "use strict";

  var roots = Array.prototype.slice.call(document.querySelectorAll("[data-proof-loop]"));
  roots.forEach(function (root) {
    var steps = Array.prototype.slice.call(root.querySelectorAll("[data-proof-step]"));
    var button = root.querySelector("[data-proof-play]");
    var status = root.querySelector("[data-proof-status]");
    if (steps.length !== 5 || !button || !status) return;

    var labels = {
      play: button.getAttribute("data-label-play"),
      pause: button.getAttribute("data-label-pause"),
      resume: button.getAttribute("data-label-resume"),
      replay: button.getAttribute("data-label-replay")
    };
    var stepLabels = steps.map(function (step) { return step.getAttribute("data-proof-label"); });
    if (!labels.play || !labels.pause || !labels.resume || !labels.replay || stepLabels.some(function (label) { return !label; })) return;

    var delay = Number(root.getAttribute("data-proof-delay"));
    if (!Number.isFinite(delay) || delay < 250 || delay > 5000) delay = 900;
    var media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    var state = "idle", index = -1, timer = null;

    if (!button.getAttribute("type")) button.setAttribute("type", "button");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");

    function label(value) {
      button.textContent = labels[value];
      button.setAttribute("aria-label", labels[value]);
    }

    function setState(value) {
      state = value;
      root.setAttribute("data-proof-state", value);
      label(value === "running" ? "pause" : value === "paused" ? "resume" : value === "complete" ? "replay" : "play");
    }

    function clearTimer() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    }

    function activate(next) {
      index = next;
      steps.forEach(function (step, at) {
        var active = at === index;
        step.setAttribute("data-proof-active", active ? "true" : "false");
        if (at <= index) step.setAttribute("data-proof-seen", "true");
        else step.removeAttribute("data-proof-seen");
        if (active) step.setAttribute("aria-current", "step");
        else step.removeAttribute("aria-current");
      });
      status.textContent = stepLabels[index];
    }

    function completeReduced() {
      while (index < steps.length - 1) activate(index + 1);
      setState("complete");
    }

    function advance() {
      timer = null;
      if (state !== "running") return;
      activate(index + 1);
      if (index === steps.length - 1) {
        setState("complete");
        return;
      }
      timer = window.setTimeout(advance, delay);
    }

    function start() {
      clearTimer();
      index = -1;
      steps.forEach(function (step) {
        step.setAttribute("data-proof-active", "false");
        step.removeAttribute("data-proof-seen");
        step.removeAttribute("aria-current");
      });
      setState("running");
      if (media && media.matches) completeReduced();
      else advance();
    }

    button.addEventListener("click", function () {
      if (state === "running") {
        clearTimer();
        setState("paused");
      } else if (state === "paused") {
        setState("running");
        if (media && media.matches) completeReduced();
        else timer = window.setTimeout(advance, delay);
      } else {
        start();
      }
    });

    function motionChanged(event) {
      if (event.matches && state === "running") {
        clearTimer();
        completeReduced();
      }
    }
    if (media && typeof media.addEventListener === "function") media.addEventListener("change", motionChanged);
    else if (media && typeof media.addListener === "function") media.addListener(motionChanged);

    setState("idle");
  });
})();
