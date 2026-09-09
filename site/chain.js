/* lintcha-chain, the page script of the shell (owned here; the vendored ui-controls.js, launch.js and launch-page.js are
   not edited and not called). It paints nothing that is data and stores nothing. What it does, in order:
     - publishes the real height of the sticky bar as --topbar-h, so an anchor never lands under the bar
     - lays out the process diagram from measurement (the boundary notch is bound to the index card's own box) and
       redraws it on resize; cycles the stage highlight
     - moves the nav underline and lights the section number of the section being read (IntersectionObserver)
     - draws the chart bars once, on first view, staggered by row
     - shows a blinking caret in the empty ticker field, sweeps one rule across the results block when a read completes
     - adds the state marker (a word and a shape) to each result line that carries a data-state attribute from
       lintcha's renderer; a line without the attribute gets no marker, and no state is ever read back from a sentence
     - the two copy buttons (the command, the contract address)
   Everything that moves stops under prefers-reduced-motion. */
(function () {
  "use strict";
  var doc = document, root = doc.documentElement;
  var reduced = false; try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
  var I18N = { strings: {}, fallback: null };
  try { var node = doc.getElementById("i18n-data"); if (node) I18N = JSON.parse(node.textContent); } catch (e) {}
  function t(key) { var s = I18N.strings[key]; if (typeof s !== "string" && I18N.fallback) s = I18N.fallback[key]; return typeof s === "string" ? s : key; }
  function q(sel, el) { return Array.prototype.slice.call((el || doc).querySelectorAll(sel)); }
  function one(sel, el) { return (el || doc).querySelector(sel); }
  var timers = [];
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }

  /* ---------------------------------------------------------------- the bar's height, for scroll-padding and scroll-margin */
  function topbar() {
    var bar = one("[data-topbar]");
    if (!bar) return;
    var publish = function () { root.style.setProperty("--topbar-h", bar.offsetHeight + "px"); };
    publish();
    if (typeof ResizeObserver === "function") new ResizeObserver(publish).observe(bar); else window.addEventListener("resize", publish);
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(publish);
  }

  /* ---------------------------------------------------------------- the process diagram (section one) */
  function layoutDiagram() {
    var wrap = one("[data-diagram]"), col = one("[data-idxcol]"), card = one('[data-stage="2"]'), box = one("[data-boundary]");
    var el = one("[data-edge-left]"), er = one("[data-edge-right]"), vt = one("[data-edge-vtop]"), vb = one("[data-edge-vbot]");
    if (!wrap || !col || !card || !box || !el || !er || !vt || !vb) return;
    var inside = ["0", "1", "3"].map(function (k) { return one('[data-stage="' + k + '"]'); }).filter(Boolean);
    if (inside.length < 3) return;
    col.style.transform = "none";
    wrap.style.paddingBottom = "0px";
    var w0 = wrap.getBoundingClientRect();
    var narrow = w0.width < 620;   // one item per line below this width
    var inset = narrow ? Math.round(w0.width * 0.42) : 0;
    q("[data-diagram] > .dg-stages > *").forEach(function (it) { it.style.flexBasis = narrow ? "100%" : "120px"; });
    inside.forEach(function (s) { s.style.maxWidth = narrow ? Math.max(150, w0.width - inset - 40) + "px" : "420px"; });
    col.style.flexBasis = narrow ? "100%" : "120px";
    col.style.maxWidth = narrow ? "none" : "420px";
    box.style.right = inset + "px";
    vt.style.right = vb.style.right = inset + "px";
    var inb = one("[data-inbound]"), inp = one("[data-inpath]");
    if (inb) inb.style.display = narrow ? "none" : "block";
    q("[data-inlabel]").forEach(function (p) { p.style.textAlign = "center"; p.style.maxWidth = ""; p.style.marginLeft = ""; p.style.marginRight = ""; });
    if (inp && !narrow) inp.setAttribute("d", "");
    var w = wrap.getBoundingClientRect();
    var bp = one("[data-bpath]");
    if (!narrow) {
      // wide: one baseline, and the boundary's bottom edge steps up around the index card so the card sits in the
      // notch with its lower half outside the browser
      var cr = card.getBoundingClientRect();
      var edgeY = Math.max.apply(null, inside.map(function (s) { return s.getBoundingClientRect().bottom - w.top; })) + 22;
      var notchY = Math.round(cr.top - w.top + cr.height / 2);
      var nl = Math.round(cr.left - w.left - 12), nr = Math.round(cr.right - w.left + 12);
      box.style.height = Math.round(edgeY + 16) + "px";
      box.style.borderRightWidth = "1px";
      el.style.display = er.style.display = vt.style.display = vb.style.display = "none";
      if (bp) bp.setAttribute("d", "M 0 " + Math.round(edgeY) + " H " + nl + " V " + notchY + " H " + nr + " V " + Math.round(edgeY) + " H " + Math.round(w.width));
      var colBottom = col.getBoundingClientRect().bottom - w.top;
      wrap.style.paddingBottom = Math.round(Math.max(0, colBottom - edgeY) + 34) + "px";
    } else {
      // stacked: the boundary is inset on the right and the full-width index card crosses it
      if (bp) bp.setAttribute("d", "");
      var cr2 = card.getBoundingClientRect();
      var bottom = Math.round(col.getBoundingClientRect().bottom - w.top);
      var h = Math.max(bottom, Math.round(Math.max.apply(null, inside.map(function (s) { return s.getBoundingClientRect().bottom - w.top; })))) + 20;
      var bottomY = Math.round(h + 16);
      box.style.height = bottomY + 16 + "px";
      box.style.borderRightWidth = "0px";
      el.style.display = "block"; er.style.display = "none";
      el.style.top = bottomY + "px";
      el.style.width = Math.max(0, Math.round(w.width - inset)) + "px";
      var top = Math.round(cr2.top - w.top);
      vt.style.display = vb.style.display = "block";
      vt.style.top = "-16px";
      vt.style.height = Math.max(0, top - 12 + 16) + "px";
      vb.style.top = Math.round(cr2.bottom - w.top + 12) + "px";
      vb.style.height = Math.max(0, bottomY - Math.round(cr2.bottom - w.top + 12)) + "px";
      if (inp) {
        var x = Math.round(cr2.right - w.left - 8), yTop = Math.round(cr2.bottom - w.top);
        inp.setAttribute("d", "M " + x + " " + (yTop + 62) + " V " + yTop);
        q("[data-inlabel]").forEach(function (p) { p.style.maxWidth = Math.max(120, Math.round(x - (cr2.left - w.left) - 18)) + "px"; p.style.marginLeft = "0"; p.style.marginRight = "auto"; p.style.textAlign = "left"; });
      }
      wrap.style.paddingBottom = "44px";
    }
    drawLinks(wrap, narrow);
  }
  function drawLinks(wrap, narrow) {
    var w = wrap.getBoundingClientRect();
    var boxes = ["0", "1", "2", "3"].map(function (k) { return one('[data-stage="' + k + '"]'); });
    var paths = q("[data-link]");
    if (boxes.some(function (b) { return !b; }) || paths.length < 3) return;
    var r = function (el) { var b = el.getBoundingClientRect(); return { l: b.left - w.left, r: b.right - w.left, t: b.top - w.top, b: b.bottom - w.top, cx: b.left - w.left + b.width / 2, cy: b.top - w.top + b.height / 2 }; };
    for (var i = 0; i < 3; i++) {
      var a = r(boxes[i]), z = r(boxes[i + 1]), d;
      if (narrow && i === 2) {
        var colEl = one("[data-idxcol]"), cb = colEl ? colEl.getBoundingClientRect().bottom - w.top : a.b, x = Math.max(6, a.l - 20);
        d = "M " + a.l + " " + a.cy + " H " + x + " V " + (cb + 14) + " H " + z.cx + " V " + z.t;
      } else if (narrow) {
        var my = (a.b + z.t) / 2;
        d = "M " + a.cx + " " + a.b + " V " + my + " H " + z.cx + " V " + z.t;
      } else if (Math.abs(a.cy - z.cy) < 4) {
        d = "M " + a.r + " " + a.cy + " H " + z.l;
      } else {
        var mx = (a.r + z.l) / 2;
        d = "M " + a.r + " " + a.cy + " H " + mx + " V " + z.cy + " H " + z.l;
      }
      paths[i].setAttribute("d", d);
    }
    if (!reduced) q("[data-links] animateMotion").forEach(function (m) { try { m.beginElement(); } catch (e) {} });
  }
  function stageLoop(i) {
    var stages = q("[data-stage]");
    if (!stages.length || reduced) return;
    stages.forEach(function (s, k) { s.classList.toggle("is-on", k === i); });
    later(function () { stageLoop((i + 1) % stages.length); }, i === stages.length - 1 ? 5500 : 3500);
  }
  function diagram() {
    if (!one("[data-diagram]")) return;
    layoutDiagram();
    var rz; window.addEventListener("resize", function () { clearTimeout(rz); rz = setTimeout(layoutDiagram, 120); });
    later(layoutDiagram, 900);   // after the webfonts settle
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(layoutDiagram);
    stageLoop(0);
  }

  /* ---------------------------------------------------------------- the section being read: its number, the nav underline */
  var active = null;
  function setActive(id) {
    if (id === active) return;
    active = id;
    q("[data-num]").forEach(function (n) { n.classList.toggle("is-active", n.getAttribute("data-num") === id); });
    var items = q("[data-nav]"), target = null;
    items.forEach(function (a) { if (a.getAttribute("data-nav") <= id) target = a; });
    if (!target) target = items[0];
    var bar = one("[data-navbar]");
    if (target && bar && target.offsetParent) { bar.style.opacity = "1"; bar.style.width = target.offsetWidth + "px"; bar.style.transform = "translateX(" + target.offsetLeft + "px)"; }
  }
  function sections() {
    var secs = q("section[data-sec]");
    if (!secs.length || !("IntersectionObserver" in window)) return;
    var obs = new IntersectionObserver(function (entries) { entries.forEach(function (e) { if (e.isIntersecting) setActive(e.target.getAttribute("data-sec")); }); }, { rootMargin: "-140px 0px -55% 0px", threshold: 0 });
    secs.forEach(function (s) { obs.observe(s); });
  }

  /* ---------------------------------------------------------------- the charts: bars draw once, on first view */
  function charts() {
    var cards = q("[data-chart]");
    if (!cards.length) return;
    if (reduced || !("IntersectionObserver" in window)) return;   // the bars are full width in the markup; nothing to do
    q("[data-bar]").forEach(function (b) { b.style.transform = "scaleX(0)"; });
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        q("[data-bar]", e.target).forEach(function (bar, i) { bar.style.transitionDelay = (i * 55) + "ms"; bar.style.transform = "scaleX(1)"; });
        obs.unobserve(e.target);
      });
    }, { threshold: 0.2 });
    cards.forEach(function (c) { obs.observe(c); });
    later(function () { q("[data-bar]").forEach(function (b) { b.style.transform = "scaleX(1)"; }); }, 2400);   // never leave a bar invisible
  }

  /* ---------------------------------------------------------------- the tool: caret, sweep, state markers */
  function caret() {
    var input = one('#launch-form input[name="ticker"]');
    if (!input || reduced) return;
    var label = input.closest("label"); if (!label) return;
    var c = doc.createElement("span"); c.className = "caret"; c.setAttribute("aria-hidden", "true"); label.appendChild(c);
    var place = function () { c.style.left = (input.offsetLeft + 15) + "px"; c.style.top = (input.offsetTop + 12) + "px"; };
    var show = function () { c.hidden = !!input.value || doc.activeElement === input; place(); };
    place(); show();
    input.addEventListener("focus", show); input.addEventListener("blur", show); input.addEventListener("input", show);
    var form = one("#launch-form"); if (form) form.addEventListener("reset", function () { later(show, 0); });
    window.addEventListener("resize", place);
    if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(place);
  }
  var SHAPES = {
    shared: '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><rect width="8" height="8" fill="currentColor"></rect></svg>',
    look: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="2" y="2" width="6" height="6" transform="rotate(45 5 5)" fill="none" stroke="currentColor" stroke-width="1.4"></rect></svg>',
    unique: '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"></circle></svg>',
    none: ""
  };
  function marker(kind, word) {
    var s = doc.createElement("span"); s.className = "st st-" + kind; s.innerHTML = SHAPES[kind];
    s.appendChild(doc.createTextNode(word)); return s;
  }
  // The state markers (a word and a shape per result) are read from a data-state attribute that lintcha's renderer
  // writes on each result line, with the engine's own state names: shared, lookalike, unique, too short to compare,
  // empty. RULE (the owner's, 2026-09-09): never derive a state by reading our own sentences back; until the attribute
  // lands in lintcha and is copied here with its VENDOR row, the rows ship without markers. A line without the
  // attribute gets nothing. One marker per line, never one for a row of several lines: that would rank them.
  var STATES = { "shared": ["shared", "state.shared"], "lookalike": ["look", "state.lookalike"], "unique": ["unique", "state.unique"], "too short to compare": ["none", "state.not_compared"] };
  function markResults() {
    var results = one("#launch-results");
    if (!results) return;
    q(".launch-line[data-state]", results).forEach(function (line) {
      if (line.getAttribute("data-marked")) return;
      line.setAttribute("data-marked", "1");
      var st = STATES[line.getAttribute("data-state")];
      if (st) line.insertBefore(marker(st[0], t(st[1])), line.firstChild);
    });
  }
  function sweep(results) {
    if (reduced) return;
    var s = doc.createElement("span"); s.className = "sweep"; s.setAttribute("aria-hidden", "true");
    results.insertBefore(s, results.firstChild);
    later(function () { if (s.parentNode) s.parentNode.removeChild(s); }, 1000);
  }
  function results() {
    var res = one("#launch-results");
    if (!res || typeof MutationObserver !== "function") return;
    new MutationObserver(function (muts) {
      if (res.hidden || !res.children.length) return;
      // the vendored renderer empties the block, appends the rows and unhides it in one run: one batch, one read, one sweep
      var notSweep = function (n) { return !(n.classList && n.classList.contains("sweep")); };
      var fresh = muts.some(function (m) { return m.type === "attributes" || (m.type === "childList" && Array.prototype.some.call(m.addedNodes, notSweep)); });
      markResults();
      if (fresh) sweep(res);
    }).observe(res, { attributes: true, attributeFilter: ["hidden"], childList: true });
  }

  /* ---------------------------------------------------------------- copy buttons: the command, the contract address */
  function copyButtons() {
    q("[data-copy-verify], [data-copy-address]").forEach(function (btn) {
      var face = one("[data-copy-label]", btn), was = face ? face.textContent : "";
      btn.addEventListener("click", function () {
        var text = btn.hasAttribute("data-copy-verify") ? (one(".cmd-code") || {}).textContent : (one("[data-token-address]") || {}).textContent;
        if (text && navigator.clipboard) { try { navigator.clipboard.writeText(text.trim()); } catch (e) {} }
        if (face) { face.textContent = btn.getAttribute("data-label-copied") || was; later(function () { face.textContent = was; }, 1600); }
      });
    });
  }

  function init() { topbar(); diagram(); sections(); charts(); caret(); results(); copyButtons(); }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", init); else init();
})();
