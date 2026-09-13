// An accessible, network-silent switcher for five existing Lintcha boundaries. The panels are authored in the
// page and remain readable without JavaScript; this file only lets one case occupy the proof surface at a time.
(function () {
  "use strict";
  var root = document.querySelector("[data-refusal-gallery]");
  if (!root) return;
  var tabs = Array.prototype.slice.call(root.querySelectorAll("[data-refusal-tab]"));
  var panels = Array.prototype.slice.call(root.querySelectorAll("[data-refusal-panel]"));
  if (!tabs.length || tabs.length !== panels.length) return;

  function select(index, focus) {
    tabs.forEach(function (tab, at) {
      var active = at === index;
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
      panels[at].hidden = !active;
    });
    if (focus) tabs[index].focus();
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () { select(index, false); });
    tab.addEventListener("keydown", function (event) {
      var next = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + tabs.length - 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next === null) return;
      event.preventDefault(); select(next, true);
    });
  });
  select(0, false);
})();
