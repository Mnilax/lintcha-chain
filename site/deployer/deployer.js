// Retained deployer history. One user-triggered same-origin read, verified rows, no storage or third party.
(function () {
  "use strict";
  var MAX_PAGE_ROWS = 1000;
  var MAX_TEXT = 200;
  var SUCCESS_KEYS = ["ok", "address", "from_block", "to_block", "read_at", "launches_seen", "page_limit", "truncated", "rows_hash", "rows"];
  var FAILURE_KEYS = ["ok", "why"];
  var root = document.querySelector("[data-history]");
  var form = document.querySelector("[data-history-form]");
  var addressInput = document.querySelector("[data-history-address]");
  var readButton = document.querySelector("[data-history-read]");
  var badge = document.querySelector("[data-history-badge]");
  var status = document.querySelector("[data-history-status]");
  var result = document.querySelector("[data-history-result]");
  var tableSection = document.querySelector("[data-history-table-section]");
  var rowsOut = document.querySelector("[data-history-rows]");
  var fromOut = document.querySelector("[data-history-from]");
  var toOut = document.querySelector("[data-history-to]");
  var countOut = document.querySelector("[data-history-count]");
  var freshnessOut = document.querySelector("[data-history-freshness]");
  var scopeOut = document.querySelector("[data-history-scope]");
  var hashOut = document.querySelector("[data-history-hash]");
  var filterInput = document.querySelector("[data-history-filter]");
  var filterState = document.querySelector("[data-history-filter-state]");
  var request = null;

  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function exactKeys(object, keys) {
    return !!object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).length === keys.length && keys.every(function (key) { return own(object, key); });
  }
  function whole(value) { return Number.isSafeInteger(value) && value >= 0; }
  function safeText(value) { return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && value.trim() && !/\p{C}/u.test(value); }
  function validTime(value) { var at = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(at) && new Date(at).toISOString() === value; }
  function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var at = Date.parse(value + "T00:00:00.000Z");
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
  }
  function validRow(row) {
    return exactKeys(row, ["block", "log_index", "date", "name", "ticker"]) && whole(row.block) && whole(row.log_index) && validDate(row.date) &&
      (row.name === null || safeText(row.name)) && (row.ticker === null || safeText(row.ticker));
  }
  function ordered(rows) {
    for (var i = 1; i < rows.length; i++) {
      if (rows[i - 1].block > rows[i].block || (rows[i - 1].block === rows[i].block && rows[i - 1].log_index >= rows[i].log_index)) return false;
    }
    return true;
  }
  function validSuccess(body, asked) {
    if (!(exactKeys(body, SUCCESS_KEYS) && body.ok === true && body.address === asked && /^0x[0-9a-f]{40}$/.test(body.address) &&
      whole(body.from_block) && whole(body.to_block) && (body.from_block <= body.to_block || (body.to_block < Number.MAX_SAFE_INTEGER && body.from_block === body.to_block + 1)) && validTime(body.read_at) &&
      whole(body.launches_seen) && whole(body.page_limit) && body.page_limit > 0 && body.page_limit <= MAX_PAGE_ROWS && typeof body.truncated === "boolean" &&
      /^[0-9a-f]{64}$/.test(body.rows_hash) && Array.isArray(body.rows) && body.rows.length <= body.page_limit && body.rows.every(validRow) && ordered(body.rows))) return false;
    if (!body.rows.every(function (row) { return row.block >= body.from_block && row.block <= body.to_block; })) return false;
    if (body.from_block === body.to_block + 1 && (body.launches_seen !== 0 || body.rows.length !== 0 || body.truncated)) return false;
    return body.truncated ? body.rows.length === body.page_limit && body.launches_seen > body.rows.length : body.launches_seen === body.rows.length;
  }
  function validFailure(body) { return exactKeys(body, FAILURE_KEYS) && body.ok === false && typeof body.why === "string" && /^[a-z_]{1,32}$/.test(body.why); }
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
  function setBadge(text, live) { badge.textContent = text; badge.className = "badge " + (live ? "badge-live" : "badge-notdata"); }
  function cell(text, className) { var td = document.createElement("td"); if (className) td.className = className; td.textContent = text; return td; }
  function readHref(row) {
    if (row.name === null || row.ticker === null || typeof URLSearchParams !== "function") return null;
    var params = new URLSearchParams(); params.set("name", row.name); params.set("ticker", row.ticker);
    return "/#read=" + params.toString();
  }
  function declarationCell(value, href, className) {
    var td = cell("", className);
    if (value === null) { td.textContent = "not published"; return td; }
    var bdi = document.createElement("bdi"); bdi.dir = "auto"; bdi.textContent = value;
    if (!href) { td.appendChild(bdi); return td; }
    var link = document.createElement("a"); link.className = "wall-read"; link.href = href; link.appendChild(bdi); td.appendChild(link); return td;
  }
  function rowNode(row) {
    var tr = document.createElement("tr"); tr.setAttribute("data-history-entry", "");
    tr._historySearch = ((row.name || "") + "\n" + (row.ticker || "")).toLocaleLowerCase();
    var href = readHref(row);
    tr.appendChild(cell(row.block.toLocaleString("en"), "history-block"));
    tr.appendChild(cell(row.date, "history-date"));
    tr.appendChild(declarationCell(row.name, href, "wall-name"));
    tr.appendChild(declarationCell(row.ticker, href, "wall-ticker"));
    return tr;
  }
  function applyFilter() {
    var query = filterInput.value.trim().toLocaleLowerCase(), entries = Array.prototype.slice.call(rowsOut.querySelectorAll("[data-history-entry]")), shown = 0;
    entries.forEach(function (tr) { tr.hidden = !!query && tr._historySearch.indexOf(query) < 0; if (!tr.hidden) shown++; });
    filterState.textContent = query ? (shown ? "This local filter changes no order and makes no request." : "No declaration on this loaded page matches the local filter.") : "";
  }
  function renderRows(rows) {
    var fragment = document.createDocumentFragment();
    if (!rows.length) {
      var tr = document.createElement("tr"), td = cell("No launch from this address is present in the stated retained range.", "wall-empty"); td.colSpan = 4; tr.appendChild(td); fragment.appendChild(tr);
    } else rows.forEach(function (row) { fragment.appendChild(rowNode(row)); });
    rowsOut.replaceChildren(fragment); filterInput.value = ""; applyFilter();
  }
  function failureText(why, network) {
    if (network) return "This page could not reach its own site. Nothing was shown.";
    if (why === "not_started") return "The observer has not established a retained-history boundary yet. Nothing was shown.";
    if (why === "stale" || why === "backlog" || why === "watcher" || why === "no_watcher" || why === "no_history") return "The watcher has no fresh complete history to return. Nothing was shown.";
    if (why === "unreadable" || why === "backfill" || why === "migrating") return "At least one launch inside the retained range cannot be represented completely yet. No partial history was shown.";
    if (why === "rate_limited") return "This page asked too often. Wait a moment and try again.";
    if (why === "query") return "The site refused that address query. Check the address and try again.";
    return "This site returned a response the page cannot safely display. Nothing was shown.";
  }
  function clearResult() { result.hidden = true; tableSection.hidden = true; hashOut.textContent = "—"; }
  function fail(why, network) { clearResult(); root.setAttribute("aria-busy", "false"); readButton.disabled = false; setBadge("unavailable", false); status.textContent = failureText(why, network); }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var address = addressInput.value.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) { fail("query", false); return; }
    if (request) request.abort();
    clearResult(); root.setAttribute("aria-busy", "true"); readButton.disabled = true; setBadge("reading", false); status.textContent = "Reading this site's retained history endpoint.";
    var current = new AbortController(), params = new URLSearchParams(); params.set("address", address); request = current;
    fetch("/api/deployer?" + params.toString(), { headers: { accept: "application/json" }, credentials: "omit", cache: "no-store", signal: current.signal })
      .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }, function () { return { ok: false, body: null }; }); })
      .then(async function (answer) {
        if (!answer.ok) { fail(validFailure(answer.body) ? answer.body.why : null, false); return; }
        if (!validSuccess(answer.body, address)) { fail(null, false); return; }
        var hash = await sha256(JSON.stringify(answer.body.rows));
        if (hash !== answer.body.rows_hash) { fail(null, false); return; }
        renderRows(answer.body.rows);
        fromOut.textContent = answer.body.from_block.toLocaleString("en"); toOut.textContent = answer.body.to_block.toLocaleString("en"); countOut.textContent = answer.body.launches_seen.toLocaleString("en"); freshnessOut.textContent = ageWords(answer.body.read_at);
        scopeOut.textContent = answer.body.truncated ? "The count covers the full retained range; this table is the bounded newest page and says so rather than implying completeness." : "The count and table cover the same retained watcher range.";
        hashOut.textContent = hash; result.hidden = false; tableSection.hidden = false; root.setAttribute("aria-busy", "false"); setBadge("verified", true); status.textContent = "Retained history verified before display.";
      })
      .catch(function (error) { if (!error || error.name !== "AbortError") fail(null, true); })
      .finally(function () { if (request === current) { request = null; readButton.disabled = false; if (root.getAttribute("aria-busy") === "true") root.setAttribute("aria-busy", "false"); } });
  });
  filterInput.addEventListener("input", applyFilter);
})();
