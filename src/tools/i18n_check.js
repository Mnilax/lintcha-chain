// lintcha i18n coverage gate. Node standard library only. Exit non-zero on any failure.
//   node tools/i18n_check.js
// Checks: same key set in every language file (both directions), no empty strings, no leftover [PLACEHOLDER]
// or TODO markers, every bracketed slot and every {var} in the english string also present in the translation.
"use strict";
const fs = require("fs");
const path = require("path");
const dir = path.resolve(__dirname, "..", "i18n");
// coverage scope, stated explicitly (LINTCHA_08 section 5): the key sets of i18n/*.json are the chrome. Role bodies,
// titles, purposes and author strings live in roles/** and are rendered into site/library/** as content; they are never
// keyed, so no key may start with the reserved prefix, and the two directories are outside this gate by declaration.
const EXCLUDED_CONTENT = { dirs: ["roles/", "site/library/", "site/es/library/", "site/pt/library/"], reserved_key_prefix: "library.role.content." };
const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
if (!files.includes("en.json")) { console.error("en.json missing"); process.exit(1); }
const data = {}; files.forEach(f => { data[f.replace(".json", "")] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); });
const en = data.en;
let failures = 0;
const fail = m => { failures++; console.error("FAIL " + m); };
// intentional slots are uppercase ([CONFIRM WORD], [PATH], [SYSTEMS]); lowercase brackets are prose and may be translated
const slots = s => (s.match(/\[[A-Z][A-Z0-9 ,/'-]*\]/g) || []).sort();
const vars = s => (s.match(/\{\w+\}/g) || []).sort();
for (const lang of Object.keys(data)) {
  const d = data[lang];
  for (const k of Object.keys(en)) if (!(k in d)) fail(lang + ": missing key " + k);
  for (const k of Object.keys(d)) if (!(k in en)) fail(lang + ": extra key " + k + " not in en");
  for (const k of Object.keys(d)) {
    const s = d[k];
    if (typeof s !== "string") { fail(lang + ": " + k + " is not a string"); continue; }
    if (!s.trim()) fail(lang + ": empty string at " + k);
    if (/\[PLACEHOLDER\]|\bTODO\b|\bFIXME\b/.test(s)) fail(lang + ": leftover marker at " + k);
    if (k.startsWith(EXCLUDED_CONTENT.reserved_key_prefix)) fail(lang + ": " + k + " keys role content, which is never translated (see EXCLUDED_CONTENT)");
    if (lang !== "en" && k in en) {
      const a = slots(en[k]).join("|"), b = slots(s).join("|");
      if (a !== b) fail(lang + ": bracket slots differ at " + k + " (en " + (a || "none") + " vs " + (b || "none") + ")");
      const va = vars(en[k]).join("|"), vb = vars(s).join("|");
      if (va !== vb) fail(lang + ": {var} tokens differ at " + k + " (en " + (va || "none") + " vs " + (vb || "none") + ")");
    }
  }
  console.log(lang + ": " + Object.keys(d).length + " keys");
}
if (failures) { console.error(failures + " failure(s)"); process.exit(1); }
console.log("i18n check passed: " + Object.keys(data).join(", ") + " complete, " + Object.keys(en).length + " keys each; role content excluded by declaration: " + EXCLUDED_CONTENT.dirs.join(" "));
