/* Page-switch flight, adapted from marketing/site-teaser-remotion/src/SiteTeaser.tsx.
   The same deterministic seed keeps the teaser's rhythm without storing navigation state. */
(function () {
  "use strict";

  var media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var nav = document.querySelector(".page-switch");
  if (!nav) return;

  function seeded(index, salt) {
    return ((index * 193 + salt * 389 + 97) % 997) / 997;
  }

  function buildSwarm() {
    var layer = document.createElement("div");
    layer.className = "bat-swarm";
    layer.setAttribute("aria-hidden", "true");

    var veil = document.createElement("div");
    veil.className = "bat-swarm-veil";
    layer.appendChild(veil);

    var flash = document.createElement("div");
    flash.className = "bat-swarm-flash";
    layer.appendChild(flash);

    var narrow = window.innerWidth < 640;
    var count = narrow ? 24 : 42;
    for (var index = 0; index < count; index += 1) {
      var bat = document.createElement("span");
      var image = document.createElement("img");
      var reverse = index % 4 === 0;
      var duration = 420 + Math.floor(seeded(index, 2) * 230);
      var size = (narrow ? 28 : 38) + seeded(index, 4) * (narrow ? 74 : 126);
      var wave = -42 + seeded(index, 5) * 84;
      var rotation = -20 + seeded(index, 6) * 40;

      bat.className = "bat-swarm-item";
      bat.setAttribute("data-reverse", reverse ? "true" : "false");
      bat.style.setProperty("--bat-delay", Math.floor(seeded(index, 1) * 170) + "ms");
      bat.style.setProperty("--bat-duration", duration + "ms");
      bat.style.setProperty("--bat-y", Math.round(2 + seeded(index, 3) * 90) + "vh");
      bat.style.setProperty("--bat-size", Math.round(size) + "px");
      bat.style.setProperty("--bat-wave", Math.round(wave) + "px");
      bat.style.setProperty("--bat-rotation", rotation.toFixed(2) + "deg");

      image.src = "/brand/echo-bat-side.png";
      image.alt = "";
      image.width = 246;
      image.height = 160;
      image.decoding = "async";
      image.draggable = false;
      bat.appendChild(image);
      layer.appendChild(bat);
    }
    return layer;
  }

  var leaving = false;
  nav.addEventListener("click", function (event) {
    var link = event.target.closest && event.target.closest("a[href]");
    if (!link || leaving || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (link.target && link.target.toLowerCase() === "_blank") return;

    var target;
    try { target = new URL(link.href, window.location.href); } catch (error) { return; }
    if (target.origin !== window.location.origin || (target.pathname === window.location.pathname && target.search === window.location.search)) return;
    if (media && media.matches) return;

    event.preventDefault();
    leaving = true;
    document.body.appendChild(buildSwarm());
    window.setTimeout(function () { window.location.assign(target.href); }, 620);
  });
})();
