#!/usr/bin/env node
// Rebuild the tail's block range with the collector, and compare.
//
// This is the other half of the promise the snapshot keeps. The index the page reads is collected up to a
// block, hashed, and rebuilt by a command; the tail moves, so it hands out its own block range and its own
// hash instead, and this is the command that checks the hash. Two steps, and neither of them edits anything:
//
//     node tools/launch-collect.mjs --from <from_block> --to <to_block> --out build/tail-range.json
//     node bot/tools/verify-tail.mjs --in build/tail-range.json
//
// The block numbers come from the tail itself: curl https://chain.lintcha.com/api/tail and read from_block and
// to_block. The tool fetches the tail again itself unless --tail <file> hands it one.
//
// Why this lives in bot/ and not in tools/. tools/verify-vendor.mjs walks site/ src/ tests/ tools/ and reports
// any file there that is neither in VENDOR.md's table nor in its owned-here list, and VENDOR.md belongs to
// somebody else. A new file under tools/ would break `npm test` at its first step until that list gained a
// row. Under bot/ it needs nobody's permission, and it is the bot's tail it verifies.
//
// What is compared is the canonical text of the counted tables, defined once in bot/src/tally.js and used by
// both sides, so this tool does not get to decide what equal means.
//
//   node bot/tools/verify-tail.mjs --in build/tail-range.json [--tail build/tail.json] [--url https://…]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tallyText, tallyHash, entryCounts } from "../src/tally.js";
import { NAMESPACES } from "../src/engine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};

const IN = path.resolve(root, opt("in", path.join("build", "tail-range.json")));
const TAIL_FILE = opt("tail", null);
const URL_ = opt("url", "https://chain.lintcha.com/api/tail");

const say = (label, value) => console.log(label.padEnd(38) + value);

async function readTail() {
  if (TAIL_FILE) return JSON.parse(fs.readFileSync(path.resolve(root, TAIL_FILE), "utf8"));
  const r = await fetch(URL_, { headers: { accept: "application/json", "user-agent": "lintcha-chain-verify-tail" } });
  if (!r.ok) throw new Error("the tail answered " + r.status);
  return await r.json();
}

if (!fs.existsSync(IN)) {
  console.error("no collector output at " + IN + "\n\nRun the collector over the tail's own range first:\n" +
    "  node tools/launch-collect.mjs --from <from_block> --to <to_block> --out " + path.relative(root, IN).split(path.sep).join("/"));
  process.exit(1);
}

const collected = JSON.parse(fs.readFileSync(IN, "utf8"));
const tail = await readTail();

const problems = [];

// ---------------------------------------------------------------- the same blocks, or nothing else matters
say("tail from_block", tail.from_block);
say("tail to_block", tail.to_block);
say("collector from", collected.window.from);
say("collector to", collected.window.to);
if (Number(collected.window.from) !== Number(tail.from_block)) problems.push("the collector's window starts at " + collected.window.from + " and the tail's at " + tail.from_block);
if (Number(collected.window.to) !== Number(tail.to_block)) problems.push("the collector's window ends at " + collected.window.to + " and the tail's at " + tail.to_block);

// ---------------------------------------------------------------- the same table
const mine = tallyText(collected.tables);
const theirs = tallyText(tail.tables);
const myHash = await tallyHash(collected.tables);
const theirHash = await tallyHash(tail.tables);

say("collector hash", myHash);
say("tail hash", theirHash);
say("tail's own claim", tail.hash);
if (tail.hash !== theirHash) problems.push("the tail's hash does not match its own table: it says " + tail.hash + " and its table hashes to " + theirHash);
if (myHash !== theirHash) problems.push("the collector's table and the tail's table are not the same table");

// ---------------------------------------------------------------- and where they differ, say where
if (mine !== theirs) {
  const a = entryCounts(collected.tables), b = entryCounts(tail.tables);
  for (const ns of NAMESPACES) {
    const left = Object.keys(collected.tables[ns] || {}), right = Object.keys(tail.tables[ns] || {});
    if (a[ns] !== b[ns]) say("  " + ns + " entries", "collector " + a[ns] + ", tail " + b[ns]);
    const onlyMine = left.filter(h => !right.includes(h)), onlyTheirs = right.filter(h => !left.includes(h));
    for (const h of onlyMine.slice(0, 5)) say("  " + ns + " only in the collector", h);
    for (const h of onlyTheirs.slice(0, 5)) say("  " + ns + " only in the tail", h);
    for (const h of left.filter(x => right.includes(x))) {
      const x = collected.tables[ns][h], y = tail.tables[ns][h];
      if (x.n !== y.n || x.first !== y.first || x.d !== y.d || x.v !== y.v) {
        say("  " + ns + " differs at " + h, JSON.stringify(x) + " against " + JSON.stringify(y));
      }
    }
  }
}

console.log("");
if (problems.length) {
  console.error("the tail does not reproduce:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("the tail reproduces: same blocks, same table, same hash.");
