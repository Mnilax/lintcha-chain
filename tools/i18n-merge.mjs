// i18n merge: the vendored launch.<lang>.json (the launch section's keys, never edited here) and this site's
// chain.<lang>.json, both in src/i18n-src/, are merged into src/i18n/<lang>.json, the directory of languages the
// vendored coverage gate (src/tools/i18n_check.js) reads unchanged. The merged files are build output, owned here and
// ignored by git. A key present in both inputs aborts the merge: nothing overrides a vendored string silently. Node
// standard library only.
//   node tools/i18n-merge.mjs            writes src/i18n/en.json, es.json, pt.json and prints one line per language
// The builder calls merge() itself before it renders anything.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SRC_DIR = path.resolve(here, "..", "src", "i18n-src");
export const I18N_DIR = path.resolve(here, "..", "src", "i18n");
export const LANGS = ["en", "es", "pt"];

const readJson = p => JSON.parse(fs.readFileSync(p, "utf8"));

export function merge(lang) {
  const a = path.join(SRC_DIR, "launch." + lang + ".json"), b = path.join(SRC_DIR, "chain." + lang + ".json");
  fs.mkdirSync(I18N_DIR, { recursive: true });
  const launch = readJson(a), chain = readJson(b);
  const both = Object.keys(chain).filter(k => k in launch);
  if (both.length) throw new Error(`i18n merge aborted: key(s) present in both launch.${lang}.json and chain.${lang}.json: ${both.join(", ")}`);
  const out = { ...launch, ...chain };
  const file = path.join(I18N_DIR, lang + ".json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  return { lang, file, launch: Object.keys(launch).length, chain: Object.keys(chain).length, total: Object.keys(out).length };
}

export function mergeAll() { return LANGS.map(merge); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const r of mergeAll()) console.log(`${r.lang}: ${r.launch} launch keys + ${r.chain} chain keys = ${r.total} -> ${path.relative(process.cwd(), r.file).split(path.sep).join("/")}`);
}
