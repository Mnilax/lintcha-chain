// A pure, client-side renderer for lintcha-chain fact receipts. It accepts only the exact v1 receipt grammar and
// returns one self-contained SVG string, or null. It never fetches, resolves, scores or reinterprets a receipt: the
// pasted values and the already-rendered result lines are copied as text, while the snapshot context is carried in
// full. Untrusted strings are XML-escaped and bounded before any markup is made.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FactReceiptSvg = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SCHEMA = "lintcha-chain/fact-receipt/v1";
  var INPUT_FIELDS = ["name", "ticker", "description", "twitter", "telegram", "discord", "website", "farcaster", "logo", "recipient"];
  var ROOT_KEYS = ["schema", "source", "language", "snapshot", "input", "result"];
  var SNAPSHOT_KEYS = ["from_block", "to_block", "from_time", "to_time", "index_sha256"];
  var WIDTH = 1600, MAX_HEIGHT = 8192, MAX_RECEIPT_CHARS = 65536;
  var MAX_GROUPS = 8, MAX_CHECKS = 16, MAX_LINES = 128;
  var COLORS = { background: "#080a0b", panel: "#0d1011", line: "#293033", text: "#f2f4f3", quiet: "#92999d", accent: "#c7ff1a" };

  function plain(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  function exactKeys(value, keys) {
    return plain(value) && Object.keys(value).length === keys.length && keys.every(function (key) {
      return Object.prototype.hasOwnProperty.call(value, key);
    });
  }
  function whole(value) { return Number.isSafeInteger(value) && value >= 0; }
  function xmlString(value, max, empty) {
    if (typeof value !== "string" || value.length > max || (!empty && !value.length)) return false;
    for (var i = 0; i < value.length; i++) {
      var code = value.charCodeAt(i);
      if (code === 0x9 || code === 0xa || code === 0xd) continue;
      if (code < 0x20 || code === 0xfffe || code === 0xffff) return false;
      if (code >= 0xd800 && code <= 0xdbff) {
        if (++i >= value.length) return false;
        code = value.charCodeAt(i);
        if (code < 0xdc00 || code > 0xdfff) return false;
      } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
  }
  function iso(value) {
    if (!xmlString(value, 32, false)) return false;
    var at = Date.parse(value);
    return Number.isFinite(at) && new Date(at).toISOString() === value;
  }
  function validLine(value) {
    return exactKeys(value, ["field", "text"]) &&
      (value.field === null || (INPUT_FIELDS.indexOf(value.field) !== -1 && xmlString(value.field, 64, false))) &&
      xmlString(value.text, 2048, true);
  }
  function validCheck(value) {
    return exactKeys(value, ["check", "lines"]) && xmlString(value.check, 256, false) &&
      Array.isArray(value.lines) && value.lines.length > 0 && value.lines.length <= MAX_LINES && value.lines.every(validLine);
  }
  function validGroup(value) {
    return exactKeys(value, ["heading", "checks"]) && xmlString(value.heading, 256, false) &&
      Array.isArray(value.checks) && value.checks.length > 0 && value.checks.length <= MAX_CHECKS && value.checks.every(validCheck);
  }

  // The same object is accepted without rewriting only when it is an exact, bounded fact-receipt/v1 value.
  function receiptOf(value) {
    if (!exactKeys(value, ROOT_KEYS) || value.schema !== SCHEMA || !xmlString(value.source, 2048, false) ||
        !xmlString(value.language, 24, false) || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value.language)) return null;
    var snapshot = value.snapshot;
    if (!exactKeys(snapshot, SNAPSHOT_KEYS) || !whole(snapshot.from_block) || !whole(snapshot.to_block) ||
        snapshot.to_block < snapshot.from_block || !iso(snapshot.from_time) || !iso(snapshot.to_time) ||
        Date.parse(snapshot.to_time) < Date.parse(snapshot.from_time) ||
        typeof snapshot.index_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(snapshot.index_sha256)) return null;
    if (!exactKeys(value.input, INPUT_FIELDS) || !INPUT_FIELDS.every(function (field) {
      return xmlString(value.input[field], 4096, true);
    })) return null;
    if (!Array.isArray(value.result) || value.result.length === 0 || value.result.length > MAX_GROUPS || !value.result.every(validGroup)) return null;
    var lineCount = value.result.reduce(function (total, group) {
      return total + group.checks.reduce(function (inside, check) { return inside + check.lines.length; }, 0);
    }, 0);
    if (lineCount > MAX_LINES) return null;
    try { if (JSON.stringify(value).length > MAX_RECEIPT_CHARS) return null; } catch (error) { return null; }
    return value;
  }

  function escapeXml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }
  function wrapped(value, width) {
    var rows = [], physical = String(value).split(/\r\n|\r|\n/);
    physical.forEach(function (line) {
      var glyphs = Array.from(line);
      if (!glyphs.length) { rows.push(""); return; }
      for (var at = 0; at < glyphs.length; at += width) rows.push(glyphs.slice(at, at + width).join(""));
    });
    return rows;
  }
  function text(out, x, y, value, size, color, weight, spacing) {
    out.push('<text x="' + x + '" y="' + y + '" fill="' + color + '" font-family="ui-monospace, SFMono-Regular, Consolas, Liberation Mono, monospace" font-size="' + size + '"' +
      (weight ? ' font-weight="' + weight + '"' : "") + (spacing ? ' letter-spacing="' + spacing + '"' : "") +
      ' xml:space="preserve">' + escapeXml(value) + "</text>");
  }
  function textRows(out, x, y, value, chars, size, color, lineHeight, weight) {
    wrapped(value, chars).forEach(function (row) { text(out, x, y, row, size, color, weight); y += lineHeight; });
    return y;
  }
  function rule(out, x1, y1, x2, y2) {
    out.push('<path d="M ' + x1 + " " + y1 + " L " + x2 + " " + y2 + '" fill="none" stroke="' + COLORS.line + '" stroke-width="1"/>');
  }

  function render(receipt) {
    receipt = receiptOf(receipt);
    if (!receipt) return null;
    var content = [], leftY = 393, rightY = 393;

    text(content, 72, leftY, "PASTED FIELDS", 16, COLORS.accent, "700", "2"); leftY += 37;
    var filled = INPUT_FIELDS.filter(function (field) { return receipt.input[field] !== ""; });
    if (!filled.length) { text(content, 72, leftY, "no filled fields", 18, COLORS.quiet); leftY += 46; }
    filled.forEach(function (field) {
      text(content, 72, leftY, field, 14, COLORS.quiet, "700", "1.2"); leftY += 27;
      leftY = textRows(content, 72, leftY, receipt.input[field], 44, 18, COLORS.text, 26, "500") + 19;
    });

    text(content, 590, rightY, "RENDERED RESULT · COPIED VERBATIM", 16, COLORS.accent, "700", "2"); rightY += 43;
    receipt.result.forEach(function (group) {
      rightY = textRows(content, 590, rightY, group.heading, 82, 18, COLORS.text, 26, "700") + 19;
      group.checks.forEach(function (check) {
        rightY = textRows(content, 614, rightY, check.check, 79, 15, COLORS.quiet, 23, "700") + 7;
        check.lines.forEach(function (line) {
          var value = line.field === null ? line.text : line.field + " · " + line.text;
          content.push('<rect x="590" y="' + (rightY - 15) + '" width="8" height="8" fill="' + COLORS.accent + '"/>');
          rightY = textRows(content, 614, rightY, value, 79, 17, COLORS.text, 25, "400") + 7;
        });
        rightY += 8;
      });
      rightY += 16;
    });

    var height = Math.ceil(Math.max(leftY, rightY) + 126);
    if (height > MAX_HEIGHT) return null;
    var out = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + WIDTH + '" height="' + height + '" viewBox="0 0 ' + WIDTH + " " + height + '" role="img" aria-labelledby="lintcha-receipt-title lintcha-receipt-desc">',
      '<title id="lintcha-receipt-title">lintcha fact receipt</title>',
      '<desc id="lintcha-receipt-desc">Exact pasted fields and rendered comparison lines with their published snapshot context. Strings only, no verdict.</desc>',
      '<rect width="' + WIDTH + '" height="' + height + '" fill="' + COLORS.background + '"/>',
      '<rect x="28" y="28" width="1544" height="' + (height - 56) + '" rx="18" fill="none" stroke="' + COLORS.line + '" stroke-width="1"/>'
    ];
    text(out, 72, 82, "LINTCHA", 20, COLORS.accent, "700", "3");
    text(out, 72, 126, "FACT RECEIPT", 38, COLORS.text, "700", "1");
    text(out, 1094, 86, "strings only · no verdict", 17, COLORS.text, "600");
    text(out, 1094, 116, "portable context, not independent proof", 15, COLORS.quiet, "400");
    rule(out, 72, 154, 1528, 154);

    text(out, 72, 194, "SNAPSHOT WINDOW", 15, COLORS.accent, "700", "2");
    text(out, 72, 226, "blocks", 13, COLORS.quiet, "700", "1");
    text(out, 164, 226, String(receipt.snapshot.from_block) + " — " + String(receipt.snapshot.to_block), 18, COLORS.text, "500");
    text(out, 72, 258, "utc", 13, COLORS.quiet, "700", "1");
    text(out, 164, 258, receipt.snapshot.from_time + " — " + receipt.snapshot.to_time, 16, COLORS.text, "500");
    text(out, 72, 290, "language", 13, COLORS.quiet, "700", "1");
    text(out, 164, 290, receipt.language, 16, COLORS.text, "500");

    text(out, 846, 194, "INDEX SHA-256", 15, COLORS.accent, "700", "2");
    text(out, 846, 229, receipt.snapshot.index_sha256.slice(0, 32), 18, COLORS.text, "500", "0.8");
    text(out, 846, 258, receipt.snapshot.index_sha256.slice(32), 18, COLORS.text, "500", "0.8");
    text(out, 846, 290, "full digest · no shortened identifier", 13, COLORS.quiet, "400");
    rule(out, 72, 334, 1528, 334);
    rule(out, 548, 370, 548, height - 114);
    Array.prototype.push.apply(out, content);
    rule(out, 72, height - 91, 1528, height - 91);
    text(out, 72, height - 52, "lintcha-chain/fact-receipt/v1", 14, COLORS.quiet, "500", "0.8");
    text(out, 1082, height - 52, "generated locally · no network", 14, COLORS.quiet, "500", "0.8");
    out.push("</svg>");
    return out.join("\n");
  }

  return {
    SCHEMA: SCHEMA,
    INPUT_FIELDS: INPUT_FIELDS.slice(),
    WIDTH: WIDTH,
    MAX_HEIGHT: MAX_HEIGHT,
    receiptOf: receiptOf,
    render: render
  };
});
