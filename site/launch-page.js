// lintcha launch identity page (LINTCHA_12). Reads the form, fetches the frozen index once from this domain on the
// first check (never at load), runs LaunchIdentity.check, and renders one row per check in the reading order the
// owner set: what it calls itself (N1, N2, N3), where it points (I1, I2), who gets paid (I3, only when the recipient
// is shared across different deployers), what it wrote (I4, or one normal line under the word floor). Every
// sentence comes from the i18n island; every figure in a sentence comes from the index. Nothing is stored.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var LANG = document.body.getAttribute("data-lang") || "en";
  var ROOT = document.body.getAttribute("data-root") || "";
  var I18N = { strings: {}, fallback: null };
  try { var node = $("i18n-data"); if (node) I18N = JSON.parse(node.textContent); } catch (e) { I18N = { strings: {}, fallback: null }; }
  var nf = (typeof Intl !== "undefined" && Intl.NumberFormat) ? new Intl.NumberFormat(LANG) : { format: String };
  function t(key, vars) {
    var s = I18N.strings[key];
    if (typeof s !== "string" && I18N.fallback) s = I18N.fallback[key];
    if (typeof s !== "string") return key;
    return vars ? s.replace(/\{(\w+)\}/g, function (m, k) { return k in vars ? String(vars[k]) : m; }) : s;
  }
  var form = $("launch-form"), state = $("launch-state"), results = $("launch-results"), read = $("launch-read");
  if (!form || !results) return;

  // ---------------------------------------------------------------- the index: fetched once, on the first check; "no-cache"
  // revalidates with the server so a regenerated index is never served stale from the browser's heuristic cache
  var index = null, loading = null;
  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (!loading) loading = fetch(ROOT + "launch-index.json", { credentials: "omit", cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (j) { index = j; return j; })
      .catch(function (e) { loading = null; throw e; });
    return loading;
  }

  // ---------------------------------------------------------------- rendering
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function sentence(r, isName) {
    var vars;
    if (r.state === "shared") { vars = { n: nf.format(r.n), d: nf.format(r.d) }; return t(r.d > 1 ? "launch.row.shared_many" : "launch.row.shared_one", vars) + (r.first ? " " + t("launch.row.first", { first: r.first }) : ""); }
    if (r.state === "lookalike") { vars = { n: nf.format(r.n), v: nf.format(r.v), d: nf.format(r.d) }; return t(isName ? "launch.row.lookalike_name" : "launch.row.lookalike", vars) + (r.first ? " " + t("launch.row.first", { first: r.first }) : ""); }
    if (r.state === "unique") return t("launch.row.unique");
    if (r.state === "too short to compare") return t("launch.row.too_short");
    return t("launch.row.empty");
  }
  function row(check, lines) {
    var r = el("div", "launch-row"); r.appendChild(el("div", "launch-check", t("launch.check." + check)));
    var body = el("div");
    lines.forEach(function (l) { var p = el("p", "launch-line"); if (l.field) { p.appendChild(el("span", "launch-field", t("launch.form." + l.field))); p.appendChild(document.createTextNode(" ")); } p.appendChild(document.createTextNode(l.text)); body.appendChild(p); });
    r.appendChild(body); return r;
  }
  function group(key, rows) {
    if (!rows.length) return null;
    var g = el("section", "launch-group"); g.appendChild(el("h3", null, t("launch.group." + key)));
    rows.forEach(function (r) { g.appendChild(r); }); return g;
  }
  function render(out) {
    results.textContent = "";
    var nameRows = [row("N1", [{ text: sentence(out.N1) }]), row("N2", [{ text: sentence(out.N2) }])];
    var look = [];
    if (out.N3.ticker.state === "lookalike") look.push({ field: "ticker", text: sentence(out.N3.ticker) });
    if (out.N3.name.state === "lookalike") look.push({ field: "name", text: sentence(out.N3.name, true) });
    if (look.length) nameRows.push(row("N3", look));
    var links = LaunchIdentity.LINKS.map(function (k) { return { field: k, text: sentence(out.I1.links[k]) }; });
    var pointRows = [row("I1", links), row("I2", [{ text: sentence(out.I2) }])];
    var paidRows = out.I3.state === "shared" && out.I3.d >= 2 ? [row("I3", [{ text: sentence(out.I3) }])] : [];
    var wroteRows = [row("I4", [{ text: sentence(out.I4) }])];
    [group("name", nameRows), group("points", pointRows), group("paid", paidRows), group("wrote", wroteRows)].forEach(function (g) { if (g) results.appendChild(g); });
    results.hidden = false;
  }
  function say(key) { state.textContent = key ? t(key) : ""; state.hidden = !key; }

  // ---------------------------------------------------------------- the check
  function input() {
    var f = form.elements, v = function (n) { return f[n] ? f[n].value : ""; };
    return { name: v("name"), ticker: v("ticker"), description: v("description"), logo: v("logo"), recipient: v("recipient"),
             links: { twitter: v("twitter"), telegram: v("telegram"), discord: v("discord"), website: v("website"), farcaster: v("farcaster") } };
  }
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!(typeof crypto !== "undefined" && crypto.subtle)) { results.hidden = true; say("launch.state.no_digest"); return; }
    var data = input();
    read.disabled = true; say(index ? null : "launch.state.fetching");
    loadIndex().then(function (idx) { return LaunchIdentity.check(data, idx); })
      .then(function (out) { say(null); render(out); })
      .catch(function () { results.hidden = true; say("launch.state.fetch_failed"); })
      .then(function () { read.disabled = false; });
  });
  $("launch-clear").addEventListener("click", function () { form.reset(); results.hidden = true; results.textContent = ""; say(null); });
})();
