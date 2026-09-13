// Loads the synthetic checked-in specimen into the public form. The input is embedded by the build, so this action
// makes no request of its own; submit still fetches the shipped index and runs the unchanged vendored engine.
(function () {
  "use strict";
  var form = document.getElementById("launch-form"), read = document.getElementById("launch-read");
  var button = document.getElementById("launch-specimen"), status = document.querySelector("[data-specimen-status]");
  if (!form || !read || !button || typeof LaunchIdentity !== "object") return;
  var i18n = { strings: {}, fallback: null }, specimen = null;
  try {
    var i18nNode = document.getElementById("i18n-data");
    var specimenNode = document.getElementById("launch-specimen-data");
    if (i18nNode) i18n = JSON.parse(i18nNode.textContent);
    var parsed = specimenNode && JSON.parse(specimenNode.textContent);
    if (parsed && parsed.schema === "lintcha-chain/verified-specimen/v1" && parsed.kind === "synthetic" && parsed.input) specimen = parsed.input;
  } catch (e) {}
  function text(key) {
    var value = i18n.strings[key];
    if (typeof value !== "string" && i18n.fallback) value = i18n.fallback[key];
    return typeof value === "string" ? value : key;
  }
  function setField(name, value) {
    var field = form.elements[name];
    if (!field) return;
    field.value = typeof value === "string" ? value : "";
    try { field.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
  }
  button.disabled = !specimen;
  button.addEventListener("click", function () {
    if (!specimen || !specimen.links) return;
    setField("name", specimen.name); setField("ticker", specimen.ticker); setField("description", specimen.description);
    LaunchIdentity.LINKS.forEach(function (name) { setField(name, specimen.links[name]); });
    setField("logo", specimen.logo); setField("recipient", specimen.recipient);
    if (status) { status.textContent = text("launch.specimen.loaded"); status.hidden = false; }
    if (typeof form.requestSubmit === "function") form.requestSubmit(read); else read.click();
  });
  form.addEventListener("input", function (event) { if (status && event && event.isTrusted) status.hidden = true; });
})();
