// verify-vendor: lintcha is the source of the launch engine and this repository only receives copies (VENDOR.md,
// spec section 3). This script reads the table in VENDOR.md, recomputes the sha256 of every listed file as it sits on
// disk, and compares. It exits non-zero on any mismatch, any missing file, and any file under a vendored path
// (site/, src/, tests/, tools/ as they appear in the table) that has neither a row nor an entry in the "owned here"
// list of VENDOR.md (paths only, no sha: the files this repository writes itself), printing one line per problem with
// the path and both hashes. Node standard library only, no dependency.
//   node tools/verify-vendor.mjs [path/to/VENDOR.md]      the tree checked is the directory that table sits in
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// the tree is the directory the table sits in: this repository by default, or a copy of it when a table path is given
// (acceptance criterion 2 alters a vendored file in a copy and expects this script to name it)
const table = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "VENDOR.md"));
const root = path.dirname(table);
const sha256 = p => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const cell = s => s.trim().replace(/^`|`$/g, "");

// ---------------------------------------------------------------- the table: | path here | path in lintcha | sha256 | source commit |
const lines = fs.readFileSync(table, "utf8").split(/\r?\n/);
const rows = [];
const problems = [];
const owned = new Set();   // "owned here": one `path` per line under the heading of that name; paths only, never hashed
let header = null, inOwned = false;
for (const line of lines) {
  if (/^#+\s/.test(line)) { inOwned = /owned here/i.test(line); continue; }
  if (inOwned) { const m = /^\s*[-*]\s+`([^`]+)`\s*$/.exec(line); if (m) owned.add(m[1].trim()); continue; }
  if (!line.startsWith("|")) continue;
  const cells = line.split("|").slice(1, -1).map(cell);
  if (!header) { header = cells.map(c => c.toLowerCase()); continue; }
  if (cells.every(c => /^-+$/.test(c))) continue;
  if (cells.length !== 4) { problems.push(`MALFORMED row: ${line.trim()}`); continue; }
  rows.push({ here: cells[0], source: cells[1], sha: cells[2].toLowerCase(), commit: cells[3] });
}
const want = ["path here", "path in lintcha", "sha256", "source commit"];
if (!header || header.length !== 4 || header.some((h, i) => h !== want[i])) problems.push(`MALFORMED header: expected "${want.join(" | ")}", got "${(header || []).join(" | ")}"`);

// ---------------------------------------------------------------- every row against the disk
const listed = new Map();
let matched = 0;
for (const r of rows) {
  if (listed.has(r.here)) problems.push(`DUPLICATE ${r.here}: listed twice`);
  listed.set(r.here, r);
  if (!/^[0-9a-f]{64}$/.test(r.sha)) { problems.push(`MALFORMED ${r.here}: table "${r.sha}" is not a sha256`); continue; }
  const p = path.join(root, r.here);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) { problems.push(`MISSING ${r.here}: table ${r.sha} file (absent)`); continue; }
  const got = sha256(p);
  if (got !== r.sha) problems.push(`MISMATCH ${r.here}: table ${r.sha} file ${got}`);
  else matched++;
}

// ---------------------------------------------------------------- every file under a vendored path must have a row
const vendoredDirs = [...new Set(rows.map(r => r.here.split("/")[0]).filter(d => d && !d.includes(".")))].sort();
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(path.relative(root, p).split(path.sep).join("/"));
  }
  return out;
}
for (const d of vendoredDirs) {
  const dir = path.join(root, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of walk(dir, []).sort()) if (!listed.has(f) && !owned.has(f)) problems.push(`UNLISTED ${f}: table (no row, not owned here) file ${sha256(path.join(root, f))}`);
}
for (const f of owned) if (listed.has(f)) problems.push(`DUPLICATE ${f}: in the table and in "owned here"`);

// ---------------------------------------------------------------- the owned-here paths themselves
// RULE (the owner's, 2026-09-09): this script asks the FILESYSTEM whether a file exists, never git. A path in "owned
// here" may be tracked or ignored by git; neither is an error. "Owned here" says who is responsible for a file,
// .gitignore says a build output is not committed, and the two lists overlap on purpose (src/i18n/<lang>.json is
// owned here, written by the build, and ignored). The only check on an owned-here path is: it exists on disk, or it
// is a build output listed in .gitignore and may legitimately be absent before a build. Asking git instead would trip
// on the first run after a build.
function ignoredByGit(f) {
  const file = path.join(root, ".gitignore");
  if (!fs.existsSync(file)) return false;
  const base = f.split("/").pop();
  for (let line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    line = line.trim(); if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    if (line.endsWith("/")) { if (f.startsWith(line) || f.includes("/" + line)) return true; continue; }
    if (line.startsWith("*")) { if (base.endsWith(line.slice(1))) return true; continue; }
    if (line === f || line === base) return true;
  }
  return false;
}
for (const f of owned) {
  const p = path.join(root, f);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) continue;
  if (ignoredByGit(f)) continue;   // a build output, absent before a build
  problems.push(`MISSING ${f}: owned here, not on disk, not a build output listed in .gitignore`);
}

for (const p of problems) console.log(p);
console.log(`verify-vendor: ${rows.length} rows, ${matched} matched, ${owned.size} owned here, ${problems.length} problem(s); vendored paths ${vendoredDirs.map(d => d + "/").join(" ")}`);
process.exit(problems.length ? 1 : 0);
