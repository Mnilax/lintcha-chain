// lintcha launch identity (LINTCHA_12). Reads what a launch calls itself (name, ticker, description, five link
// strings, logo, fee recipient) and reports what those strings are shared with in a frozen index of counted hashes.
// Pure string work: no network, no address resolution, no model, no threshold. Nothing here is a rule: never scored,
// never counted, never compared to the corpus, never on a library scorecard. A separate engine from rules.js.
//
//   I1  link value      each of the five link strings, by value,     unique | shared
//                       then through the alias table (launch-links.js)
//   I2  logo            the logo URI, by value                        unique | shared
//   I3  fee recipient   the creator fee recipient, by value           unique | shared
//   I4  description     after normalization, twelve words or more     unique | shared | too short to compare
//   N1  ticker exact    uppercased, leading $ and whitespace stripped unique | shared
//   N2  name exact      case folded, whitespace collapsed, no punct.  unique | shared
//   N3  lookalike       ticker and name as skeletons                  unique | lookalike
//
// A field that is not filled reports `empty`; a recipient that is not an address reports `not readable`. A check
// that cannot run says so and never guesses.
//
// The index (site/launch-index.json) holds, per namespace, { "<16 hex of sha256(normalized value)>": { n, d, first } }
// and, on the two skeleton namespaces, v: the number of distinct spellings in the group. Nothing else: no addresses,
// no raw strings, no names. Counts start at two (the count floor), so absence reads "no other launch in the window
// carries it" and a count never says "other": the window may hold the launch being pasted and the page cannot tell.
// Shared means the exact hash is in its namespace. Lookalike means the skeleton group holds spellings that differ as
// strings and fold to one shape (v >= 2); a group spelt one way is an exact repeat and N3 shows nothing.
//
// check(input, index) -> Promise of { I1, I2, I3, I4, N1, N2, N3 }; every result is { state, n, d, first } (plus v on
// a lookalike) or a state alone. Hashing uses the platform digest (Node crypto, or Web Crypto in the browser), so the
// api is async.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./launch-skeleton.js"), require("./launch-links.js"), require("crypto"));
  else root.LaunchIdentity = factory(root.LaunchSkeleton, root.LaunchLinks, null);
})(typeof self !== "undefined" ? self : this, function (Skeleton, Links, nodeCrypto) {
  "use strict";
  var LINKS = ["twitter", "telegram", "discord", "website", "farcaster"];
  var NAMESPACES = ["link", "logo", "recipient", "description", "ticker", "name", "ticker_skeleton", "name_skeleton"];
  var MIN_WORDS = 12;                 // a description under this many words is too short to compare
  var HEX_CHARS = 16;                 // 8 bytes of sha256
  var ZERO_ADDRESS = "0x" + new Array(41).join("0");

  // ---------------------------------------------------------------- normalizers
  function str(v) { return v == null ? "" : String(v); }
  function spaces(s) { return s.replace(/\s+/g, " ").trim(); }

  // A link or a logo URI, by value. A web address (http, https or no scheme): the scheme is dropped, the host is
  // lowercased (hosts have no case), a leading "www." and trailing slashes go, a fragment goes; the path keeps its
  // case because invite codes may be case-sensitive. Any other scheme (ipfs, ar, data) is kept whole, trimmed only,
  // because what follows it is a content id with case. Nothing is resolved, nothing is fetched.
  function hostAndRest(s) {
    var a = s.indexOf("/"), b = s.indexOf("?"), cut = a < 0 ? b : (b < 0 ? a : Math.min(a, b));
    return cut < 0 ? [s, ""] : [s.slice(0, cut), s.slice(cut)];
  }
  function linkRaw(v) {
    var s = spaces(str(v).normalize("NFC")), scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
    if (scheme && !/^https?$/i.test(scheme[1])) return s;
    s = s.replace(/^https?:\/\//i, "").replace(/#.*$/, "");
    var hr = hostAndRest(s), host = hr[0].toLowerCase().replace(/^www\./, "");
    return (host + hr[1]).replace(/\/+$/, "");
  }
  // The folded form (I1): the raw form, then the alias table in site/launch-links.js. A bare handle in a field that
  // names its platform (twitter, telegram) is that platform's page; a host in the table is replaced by the host it
  // stands for and its path is lowercased, because there it is one account. Shorteners and redirects never fold.
  function link(v, field) {
    var raw = linkRaw(v), m, hr;
    if (!raw) return raw;
    if (field && Object.prototype.hasOwnProperty.call(Links.PLATFORM, field) && (m = Links.HANDLE.exec(raw))) return Links.PLATFORM[field] + "/" + m[1].toLowerCase();
    hr = hostAndRest(raw);
    if (Object.prototype.hasOwnProperty.call(Links.HOSTS, hr[0])) return Links.HOSTS[hr[0]] + hr[1].toLowerCase();
    return raw;
  }

  // The fee recipient is an address compared as a string; checksum case is cosmetic. The zero address means no
  // recipient was set, which is not a value to share.
  function recipient(v) {
    var s = spaces(str(v)).toLowerCase();
    if (!s) return { value: "", state: "empty" };
    if (!/^0x[0-9a-f]{40}$/.test(s)) return { value: "", state: "not readable" };
    if (s === ZERO_ADDRESS) return { value: "", state: "empty" };
    return { value: s, state: "ok" };
  }

  // The description: lowercase, urls stripped, punctuation and symbols (emoji among them) stripped, whitespace
  // collapsed. Apostrophes are removed without a space so a contraction stays one word.
  function description(v) {
    var s = str(v).normalize("NFKC").toLowerCase()
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/g, " ").replace(/\bwww\.\S+/g, " ")
      .replace(/['\u2019]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ");
    return spaces(s);
  }
  function words(s) { return s ? s.split(" ").length : 0; }

  // The ticker: uppercased, leading dollar signs and whitespace stripped.
  function ticker(v) { return spaces(str(v).normalize("NFC")).replace(/^[\s$]+/, "").toUpperCase(); }

  // The name: case folded, punctuation stripped, whitespace collapsed.
  function name(v) { return spaces(str(v).normalize("NFKC").toLowerCase().replace(/\p{P}/gu, "")); }

  // The skeleton (N3): lowercased, decomposed, marks removed, the table applied one character at a time, then the
  // pairs. The table itself is site/launch-skeleton.js.
  function skeleton(v) {
    var s = str(v).toLowerCase().normalize("NFKD").replace(Skeleton.MARKS, ""), out = "", i;
    for (i = 0; i < s.length; i++) out += Object.prototype.hasOwnProperty.call(Skeleton.CHARS, s[i]) ? Skeleton.CHARS[s[i]] : s[i];
    for (i = 0; i < Skeleton.PAIRS.length; i++) out = out.split(Skeleton.PAIRS[i][0]).join(Skeleton.PAIRS[i][1]);
    return out;
  }

  // ---------------------------------------------------------------- hashing
  function hex(bytes) { var s = "", i; for (i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16); return s; }
  function digestSubtle(value) {
    var bytes = new TextEncoder().encode(value);
    return crypto.subtle.digest("SHA-256", bytes).then(function (buf) { return hex(new Uint8Array(buf)).slice(0, HEX_CHARS); });
  }
  function digestNode(value) {
    return Promise.resolve(nodeCrypto.createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex").slice(0, HEX_CHARS));
  }
  var digest = nodeCrypto ? digestNode : digestSubtle;

  // ---------------------------------------------------------------- the comparison
  function entry(index, ns, h) {
    var table = index && index[ns], e = table && Object.prototype.hasOwnProperty.call(table, h) ? table[h] : null;
    if (!e || typeof e.n !== "number" || e.n < 1) return null;
    return { n: e.n, d: typeof e.d === "number" && e.d >= 1 ? e.d : 1, first: str(e.first), v: typeof e.v === "number" ? e.v : null };
  }
  function exact(index, ns, value) {
    if (!value) return Promise.resolve({ state: "empty" });
    return digest(value).then(function (h) {
      var e = entry(index, ns, h);
      return e ? { state: "shared", n: e.n, d: e.d, first: e.first } : { state: "unique" };
    });
  }
  // Lookalike (N3): the skeleton entry is read directly, no arithmetic. v is the number of distinct spellings in the
  // group: one means every launch in the group spells it the same way (an exact repeat, N1 or N2's business, N3 shows
  // nothing); two or more means the group holds spellings that differ as strings and fold to one shape.
  function lookalike(index, ns, value) {
    if (!value) return Promise.resolve({ state: "empty" });
    return digest(skeleton(value)).then(function (h) {
      var sk = entry(index, ns + "_skeleton", h);
      if (!sk || sk.v === null || sk.v < 2) return { state: "unique" };
      return { state: "lookalike", n: sk.n, d: sk.d, v: sk.v, first: sk.first };
    });
  }
  function fold(results, order) {
    var i, j, states = order.slice(), best = "empty";
    for (i = 0; i < results.length; i++) for (j = 0; j < states.length; j++) if (results[i].state === states[j] && j < states.indexOf(best)) best = states[j];
    return best;
  }

  function check(input, index) {
    input = input || {}; index = index || {};
    var links = input.links || {};
    var jobs = LINKS.map(function (k) { return exact(index, "link", link(links[k], k)); });
    var rec = recipient(input.recipient), desc = description(input.description);
    return Promise.all(jobs.concat([
      exact(index, "logo", linkRaw(input.logo)),
      rec.state === "ok" ? exact(index, "recipient", rec.value) : Promise.resolve({ state: rec.state }),
      !desc ? Promise.resolve({ state: "empty" }) : words(desc) < MIN_WORDS ? Promise.resolve({ state: "too short to compare" }) : exact(index, "description", desc),
      exact(index, "ticker", ticker(input.ticker)),
      exact(index, "name", name(input.name)),
      lookalike(index, "ticker", ticker(input.ticker)),
      lookalike(index, "name", name(input.name))
    ])).then(function (r) {
      var perLink = {}, i;
      for (i = 0; i < LINKS.length; i++) perLink[LINKS[i]] = r[i];
      return {
        I1: { state: fold(r.slice(0, LINKS.length), ["shared", "unique", "empty"]), links: perLink },
        I2: r[5], I3: r[6], I4: r[7], N1: r[8], N2: r[9],
        N3: { state: fold([r[10], r[11]], ["lookalike", "unique", "empty"]), ticker: r[10], name: r[11] }
      };
    });
  }

  return {
    LINKS: LINKS, NAMESPACES: NAMESPACES, MIN_WORDS: MIN_WORDS, HEX_CHARS: HEX_CHARS,
    normalize: { link: link, linkRaw: linkRaw, logo: linkRaw, recipient: recipient, description: description, ticker: ticker, name: name, skeleton: skeleton },
    words: words, digest: digest, digestSubtle: digestSubtle, check: check
  };
});
