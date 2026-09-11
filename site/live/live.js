// The live wall. One same-origin endpoint, bounded verified pages and deltas, no storage or third-party request.
(function () {
  "use strict";

  var POLL_MS = 12000;
  var MAX_WALL_TEXT = 200;
  var MAX_PAGE_ROWS = 1000;
  var SUCCESS_KEYS = ["ok", "snapshot_to_block", "gap_blocks", "watcher_to_block", "read_at", "page_limit", "mode", "older_cursor", "live_cursor", "rows_hash", "view_hash", "rows"];
  var FAILURE_KEYS = ["ok", "why"];
  var root = document.querySelector("[data-wall]");
  var rowsOut = document.querySelector("[data-wall-rows]");
  var badge = document.querySelector("[data-wall-badge]");
  var statusOut = document.querySelector("[data-wall-status]");
  var snapshotOut = document.querySelector("[data-wall-snapshot]");
  var watcherOut = document.querySelector("[data-wall-watcher]");
  var gapOut = document.querySelector("[data-wall-gap]");
  var freshnessOut = document.querySelector("[data-wall-freshness]");
  var gapNote = document.querySelector("[data-wall-gap-note]");
  var hashOut = document.querySelector("[data-wall-hash]");
  var pauseBtn = document.querySelector("[data-wall-pause]");
  var retryBtn = document.querySelector("[data-wall-retry]");
  var olderBtn = document.querySelector("[data-wall-older]");
  var searchInput = document.querySelector("[data-wall-search]");
  var filterState = document.querySelector("[data-wall-filter-state]");
  var timer = null;
  var request = null;
  var paused = false;
  var pageMode = "none";
  var snapshotBoundary = null;
  var pageLimit = null;
  var olderCursor = null;
  var liveCursor = null;
  var visibleRows = [];

  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function exactKeys(object, keys) {
    return !!object && typeof object === "object" && !Array.isArray(object) &&
      Object.keys(object).length === keys.length && keys.every(function (key) { return own(object, key); });
  }
  function whole(value) { return Number.isSafeInteger(value) && value >= 0; }
  function cursor(value) { return value === null || (typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value)); }
  function publishable(value) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_WALL_TEXT && value.trim() && !/\p{C}/u.test(value);
  }
  function validRow(row) {
    return exactKeys(row, ["name", "ticker"]) && publishable(row.name) && publishable(row.ticker);
  }
  function validReadAt(value) {
    if (typeof value !== "string") return false;
    var at = Date.parse(value);
    return Number.isFinite(at) && new Date(at).toISOString() === value;
  }
  function validSuccess(body) {
    if (!(exactKeys(body, SUCCESS_KEYS) && body.ok === true && whole(body.snapshot_to_block) &&
      whole(body.gap_blocks) && whole(body.watcher_to_block) && body.watcher_to_block >= body.snapshot_to_block &&
      validReadAt(body.read_at) && whole(body.page_limit) && body.page_limit > 0 && body.page_limit <= MAX_PAGE_ROWS &&
      ["latest", "before", "after"].includes(body.mode) && cursor(body.older_cursor) && cursor(body.live_cursor) &&
      /^[0-9a-f]{64}$/.test(body.rows_hash) && /^[0-9a-f]{64}$/.test(body.view_hash) &&
      Array.isArray(body.rows) && body.rows.length <= body.page_limit && body.rows.every(validRow))) return false;
    if (body.mode === "latest") return body.live_cursor !== null;
    if (body.mode === "before") return body.live_cursor === null;
    return body.older_cursor === null && body.live_cursor !== null;
  }
  function validFailure(body) {
    return exactKeys(body, FAILURE_KEYS) && body.ok === false && typeof body.why === "string" && /^[a-z_]{1,32}$/.test(body.why);
  }
  function sha256(text) {
    if (!window.crypto || !window.crypto.subtle) return Promise.reject(new Error("digest"));
    return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (digest) {
      return Array.from(new Uint8Array(digest), function (byte) { return byte.toString(16).padStart(2, "0"); }).join("");
    });
  }
  function ageWords(iso) {
    var age = Date.now() - Date.parse(iso);
    if (age <= 0) return "just now";
    return age < 60000 ? "less than a minute ago" : "more than a minute ago";
  }
  function setBadge(label, kind) {
    badge.textContent = label;
    badge.className = "badge " + (kind === "live" ? "badge-live" : kind === "snapshot" ? "badge-snapshot" : "badge-notdata");
  }
  function cell(tag, text, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }
  function readHref(row) {
    var params = new URLSearchParams();
    params.set("name", row.name);
    params.set("ticker", row.ticker);
    return "/#read=" + params.toString();
  }
  function rowNode(row) {
    var tr = document.createElement("tr");
    tr.setAttribute("data-wall-entry", "");
    tr._wallSearch = (row.name + "\n" + row.ticker).toLocaleLowerCase();
    var href = readHref(row);
    var name = document.createElement("bdi");
    var ticker = document.createElement("bdi");
    name.dir = "auto";
    ticker.dir = "auto";
    name.textContent = row.name;
    ticker.textContent = row.ticker;
    var nameLink = document.createElement("a");
    var tickerLink = document.createElement("a");
    nameLink.className = tickerLink.className = "wall-read";
    nameLink.href = tickerLink.href = href;
    nameLink.appendChild(name);
    tickerLink.appendChild(ticker);
    var nameCell = cell("td", "", "wall-name");
    var tickerCell = cell("td", "", "wall-ticker");
    nameCell.appendChild(nameLink);
    tickerCell.appendChild(tickerLink);
    tr.appendChild(nameCell);
    tr.appendChild(tickerCell);
    return tr;
  }
  function emptyRows(text) {
    var tr = document.createElement("tr");
    var td = cell("td", text, "wall-empty");
    td.colSpan = 2;
    tr.appendChild(td);
    rowsOut.replaceChildren(tr);
  }
  function applyFilter() {
    var query = searchInput ? searchInput.value.trim().toLocaleLowerCase() : "";
    var entries = Array.prototype.slice.call(rowsOut.querySelectorAll("[data-wall-entry]"));
    var shown = false;
    entries.forEach(function (tr) {
      tr.hidden = !!query && tr._wallSearch.indexOf(query) < 0;
      if (!tr.hidden) shown = true;
    });
    if (filterState) filterState.textContent = query && entries.length && !shown
      ? "No declaration on this loaded page matches the local filter."
      : query ? "This filter changes only the loaded view; it makes no request and does not reorder anything." : "";
  }
  function replacePage(rows) {
    var fragment = document.createDocumentFragment();
    if (!rows.length) {
      var empty = document.createElement("tr");
      var message = cell("td", "No publishable self-declared name and ticker pairs are available on this page.", "wall-empty");
      message.colSpan = 2;
      empty.appendChild(message);
      fragment.appendChild(empty);
    } else rows.forEach(function (row) { fragment.appendChild(rowNode(row)); });
    rowsOut.replaceChildren(fragment);
    visibleRows = rows.slice();
    applyFilter();
  }
  function appendDelta(rows, limit) {
    var placeholder = rowsOut.querySelector(".wall-empty");
    if (placeholder && rows.length) rowsOut.replaceChildren();
    rows.forEach(function (row) { rowsOut.appendChild(rowNode(row)); });
    while (rowsOut.querySelectorAll("[data-wall-entry]").length > limit) rowsOut.removeChild(rowsOut.querySelector("[data-wall-entry]"));
    visibleRows = visibleRows.concat(rows).slice(-limit);
    if (!visibleRows.length) emptyRows("No publishable self-declared name and ticker pairs are available on this page.");
    applyFilter();
  }
  function showMeta(body) {
    snapshotOut.textContent = body.snapshot_to_block.toLocaleString("en");
    watcherOut.textContent = body.watcher_to_block.toLocaleString("en");
    gapOut.textContent = body.gap_blocks.toLocaleString("en");
    freshnessOut.textContent = ageWords(body.read_at);
    gapNote.textContent = body.gap_blocks === 0
      ? "The watcher began at the snapshot boundary; no startup block is uncovered."
      : "The stated number of startup blocks is covered by neither source. This wall is not a complete bridge from the snapshot.";
    root.setAttribute("aria-busy", "false");
    pauseBtn.disabled = false;
    retryBtn.hidden = true;
  }
  function updateOlderControl() {
    olderBtn.hidden = !olderCursor;
    olderBtn.disabled = !olderCursor || root.getAttribute("aria-busy") === "true";
  }
  function setPaused(value) {
    paused = value;
    pauseBtn.setAttribute("aria-pressed", paused ? "true" : "false");
    pauseBtn.textContent = paused ? "Resume live updates" : "Pause updates";
  }
  async function accept(body, requestedMode) {
    if (!validSuccess(body) || body.mode !== requestedMode) return "invalid";
    var pageHash = await sha256(JSON.stringify(body.rows));
    if (pageHash !== body.rows_hash) return "invalid";
    if (requestedMode !== "latest" && snapshotBoundary !== body.snapshot_to_block) return "reset";

    if (requestedMode === "after") {
      if (pageLimit !== body.page_limit || pageMode !== "live") return "reset";
      var tentative = visibleRows.concat(body.rows).slice(-body.page_limit);
      var viewHash = await sha256(JSON.stringify(tentative));
      if (viewHash !== body.view_hash) return "invalid";
      appendDelta(body.rows, body.page_limit);
      liveCursor = body.live_cursor;
      hashOut.textContent = body.view_hash;
      showMeta(body);
      setBadge(paused ? "paused" : "live", paused ? "snapshot" : "live");
      statusOut.textContent = body.rows.length
        ? "Live delta verified before the bounded page changed."
        : "Live wall read. No new publishable declaration; the coverage cursor advanced.";
      updateOlderControl();
      return "ok";
    }

    if (body.view_hash !== body.rows_hash) return "invalid";
    snapshotBoundary = body.snapshot_to_block;
    pageLimit = body.page_limit;
    olderCursor = body.older_cursor;
    replacePage(body.rows);
    hashOut.textContent = body.view_hash;
    showMeta(body);
    if (requestedMode === "before") {
      pageMode = "history";
      liveCursor = null;
      setPaused(true);
      setBadge("history", "snapshot");
      statusOut.textContent = "Earlier page verified. Live polling is paused; resume to return to the newest page.";
    } else {
      pageMode = "live";
      liveCursor = body.live_cursor;
      setBadge(paused ? "paused" : "live", paused ? "snapshot" : "live");
      statusOut.textContent = paused
        ? "Updates paused. This verified page is frozen and no request is being made."
        : "Newest page verified. Future polls request only declarations after its coverage cursor.";
    }
    updateOlderControl();
    return "ok";
  }
  function failureText(why, network) {
    if (network) return "This page could not reach its own site. Check the connection and retry.";
    if (why === "snapshot") return "Live wall unavailable: the snapshot boundary could not be read. No rows are shown.";
    if (why === "snapshot_regressed") return "Live wall unavailable: the published snapshot boundary moved behind data already retired. No partial wall is shown.";
    if (why === "stale") return "Live wall unavailable: the watcher's last complete read is too old. No rows are shown.";
    if (why === "behind") return "Live wall unavailable: the watcher has not reached the snapshot boundary. No rows are shown.";
    if (why === "backlog") return "Live wall unavailable: the watcher has not caught up to the last finalized block it observed. No rows are shown.";
    if (why === "unreadable") return "Live wall unavailable: at least one launch in this suffix could not be read. No partial wall is shown.";
    if (why === "backfill") return "Live wall unavailable: stored event metadata cannot prove a complete page. No partial wall is shown.";
    if (why === "migrating") return "Live wall is indexing earlier stored events in bounded steps. It will retry without showing a partial page.";
    if (why === "rate_limited") return "This page asked too often. Pause for a moment and retry.";
    if (why === "watcher" || why === "no_watcher" || why === "no_wall") return "Live wall unavailable: the watcher has no complete reading. No rows are shown.";
    return "This site returned a response the page cannot safely display. No rows are shown.";
  }
  function showFailure(why, network) {
    snapshotBoundary = null;
    pageLimit = null;
    olderCursor = null;
    liveCursor = null;
    visibleRows = [];
    pageMode = "none";
    snapshotOut.textContent = "—";
    watcherOut.textContent = "—";
    gapOut.textContent = "—";
    freshnessOut.textContent = "—";
    hashOut.textContent = "—";
    gapNote.textContent = "Coverage could not be established, so the wall is closed rather than partial.";
    emptyRows("No rows are shown without a fresh, complete and hash-verified response.");
    root.setAttribute("aria-busy", "false");
    retryBtn.hidden = false;
    olderBtn.hidden = true;
    setBadge("unavailable", "none");
    statusOut.textContent = failureText(why, network);
  }
  function cancel() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    if (request) request.abort();
    request = null;
  }
  function schedule() {
    if (!paused && pageMode === "live" && !document.hidden) timer = window.setTimeout(refresh, POLL_MS);
  }
  function endpoint(mode, value) {
    if (mode === "latest") return "/api/wall";
    return "/api/wall?" + mode + "=" + encodeURIComponent(value);
  }
  function requestPage(mode, value) {
    cancel();
    root.setAttribute("aria-busy", "true");
    olderBtn.disabled = true;
    var current = new AbortController();
    request = current;
    return fetch(endpoint(mode, value), { headers: { accept: "application/json" }, cache: "no-store", signal: current.signal }).then(function (response) {
      return response.json().then(function (body) { return { ok: response.ok, body: body }; }, function () { return { ok: false, body: null }; });
    }).then(async function (answer) {
      if (!answer.ok) {
        if (validFailure(answer.body) && answer.body.why === "reset_required" && mode === "after") {
          request = null;
          return requestPage("latest", null);
        }
        showFailure(validFailure(answer.body) ? answer.body.why : null, false);
        return;
      }
      var outcome;
      try { outcome = await accept(answer.body, mode); } catch (e) { outcome = "invalid"; }
      if (outcome === "reset") {
        request = null;
        return requestPage("latest", null);
      }
      if (outcome !== "ok") showFailure(null, false);
    }).catch(function (error) {
      if (!error || error.name !== "AbortError") showFailure(null, true);
    }).finally(function () {
      if (request === current) {
        request = null;
        updateOlderControl();
        schedule();
      }
    });
  }
  function refresh() {
    if (paused || document.hidden) return;
    return liveCursor ? requestPage("after", liveCursor) : requestPage("latest", null);
  }
  function newest() {
    snapshotBoundary = null;
    liveCursor = null;
    pageMode = "none";
    return requestPage("latest", null);
  }

  pauseBtn.addEventListener("click", function () {
    if (!paused) {
      setPaused(true);
      cancel();
      setBadge("paused", "snapshot");
      root.setAttribute("aria-busy", "false");
      statusOut.textContent = "Updates paused. This verified page is frozen and no request is being made.";
      updateOlderControl();
    } else {
      setPaused(false);
      newest();
    }
  });
  olderBtn.addEventListener("click", function () {
    if (!olderCursor) return;
    setPaused(true);
    requestPage("before", olderCursor);
  });
  retryBtn.addEventListener("click", function () { setPaused(false); newest(); });
  if (searchInput) searchInput.addEventListener("input", applyFilter);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) cancel();
    else if (!paused) newest();
  });

  newest();
})();
