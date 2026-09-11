import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INDEX_NAMESPACES, MANIFEST_SCHEMA, validLaunchIndex, publishedManifestOf } from "../lib/published-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(fs.readFileSync(path.join(root, "site", "launch-index.json"), "utf8"));
const numbers = JSON.parse(fs.readFileSync(path.join(root, "site", "launch-numbers.json"), "utf8"));
const indexPath = path.join(root, "site", "launch-index.json");
const numbersPath = path.join(root, "site", "launch-numbers.json");
const shippedManifest = JSON.parse(fs.readFileSync(path.join(root, "site", "launch-manifest.json"), "utf8"));
const sha256File = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let checks = 0, failures = 0;
const ok = (value, label) => { checks++; if (!value) { failures++; console.log("  FAIL " + label); } };

ok(validLaunchIndex(index, { entries: numbers.index.entries, entries_total: numbers.index.entries_total }), "the shipped corpus matches its independently published namespace counts and runtime grammar");
ok(!validLaunchIndex({}, { entries: numbers.index.entries, entries_total: numbers.index.entries_total }), "a valid JSON empty object cannot stand in for the corpus");
const emptyTables = Object.fromEntries(INDEX_NAMESPACES.map(namespace => [namespace, {}]));
ok(!validLaunchIndex(emptyTables, { entries: numbers.index.entries, entries_total: numbers.index.entries_total }), "eight empty namespaces cannot report the shipped entry counts");
const badCounts = { entries: { ...numbers.index.entries, link: numbers.index.entries.link + 1 }, entries_total: numbers.index.entries_total + 1 };
ok(!validLaunchIndex(index, badCounts), "a count manifest that disagrees with the corpus is refused");

const manifest = {
  schema: MANIFEST_SCHEMA,
  index: { sha256: "a".repeat(64), bytes: 1, entries: numbers.index.entries, entries_total: numbers.index.entries_total },
  numbers: { sha256: "b".repeat(64), bytes: 1 }
};
ok(publishedManifestOf(manifest) === manifest, "an exact bounded manifest is accepted without rewriting it");
ok(publishedManifestOf({ ...manifest, extra: true }) === null, "an extra manifest field is refused");
ok(publishedManifestOf({ ...manifest, index: { ...manifest.index, sha256: "not-a-hash" } }) === null, "a malformed manifest digest is refused");
ok(publishedManifestOf({ ...manifest, index: { ...manifest.index, entries_total: manifest.index.entries_total + 1 } }) === null, "a manifest total must equal its namespace counts");

ok(publishedManifestOf(shippedManifest) === shippedManifest, "the shipped manifest satisfies the runtime grammar");
ok(shippedManifest.index.bytes === fs.statSync(indexPath).size, "the shipped manifest records the index filesystem byte size");
ok(shippedManifest.numbers.bytes === fs.statSync(numbersPath).size, "the shipped manifest records the numbers filesystem byte size");
ok(shippedManifest.index.sha256 === sha256File(indexPath), "the shipped manifest hashes the exact index bytes");
ok(shippedManifest.numbers.sha256 === sha256File(numbersPath), "the shipped manifest hashes the exact numbers bytes");

console.log(`published contract: ${checks} checks, ${failures} failure(s)`);
process.exitCode = failures ? 1 : 0;
