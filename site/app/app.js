// Compact Telegram WebView shell. It adds navigation only and reuses the site's existing clients unchanged.
(function () {
  "use strict";
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[data-app-tab]"));
  var panels = Array.prototype.slice.call(document.querySelectorAll("[data-app-panel]"));
  var liveLoaded = false;

  function loadLive() {
    if (liveLoaded) return;
    liveLoaded = true;
    var script = document.createElement("script");
    script.src = "/live/live.js";
    script.async = true;
    script.addEventListener("error", function () {
      var status = document.querySelector("[data-wall-status]");
      if (status) status.textContent = "The live client could not be loaded. Retry after reopening the app.";
    });
    document.body.appendChild(script);
  }

  function select(name, focus) {
    tabs.forEach(function (tab) {
      var selected = tab.getAttribute("data-app-tab") === name;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    });
    panels.forEach(function (panel) { panel.hidden = panel.getAttribute("data-app-panel") !== name; });
    if (name === "live") loadLive();
    window.scrollTo(0, 0);
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () { select(tab.getAttribute("data-app-tab"), false); });
    tab.addEventListener("keydown", function (event) {
      var next = null;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next === null) return;
      event.preventDefault();
      select(tabs[next].getAttribute("data-app-tab"), true);
    });
  });
})();
