// Fact-receipt verification and replay stay offline: structure is not confused with reproduction, while a replay
// requires exact manifest-bound index/numbers artifacts and the current LINTCHA_12 result.
//   node tests/fact_receipt_test.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  FACT_RECEIPT_SCHEMA,
  factReceiptOf,
  factReceiptIdentityInput,
  renderFactReceiptResult,
  validateFactReceipt
} from "../lib/fact-receipt.mjs";
import { readIdentity } from "../lib/identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "tools", "identity.mjs");
const index = JSON.parse(fs.readFileSync(path.join(root, "site", "launch-index.json"), "utf8"));
const numbers = JSON.parse(fs.readFileSync(path.join(root, "site", "launch-numbers.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(root, "site", "launch-manifest.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(root, "src", "i18n-src", "launch.en.json"), "utf8"));
const es = JSON.parse(fs.readFileSync(path.join(root, "src", "i18n-src", "launch.es.json"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lintcha-receipt-"));
let checks = 0;
let failures = 0;
const fail = message => { failures++; console.error("FAIL " + message); };
const ok = (value, message) => { checks++; if (!value) fail(message); };
const eq = (actual, expected, message) => { checks++; if (actual !== expected) fail(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };
const deep = (actual, expected, message) => { checks++; if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };
const clone = value => JSON.parse(JSON.stringify(value));

function run(args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, input, encoding: "utf8" });
  let body;
  try { body = JSON.parse(result.stdout); }
  catch (error) { fail(`CLI stdout must be one JSON value for ${args.join(" ")}: ${error.message}; stdout=${JSON.stringify(result.stdout)}`); body = null; }
  return { ...result, body };
}

function write(name, value) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  return file;
}

const flatInput = {
  name: "x",
  ticker: "x",
  description: "",
  twitter: "",
  telegram: "",
  discord: "",
  website: "",
  farcaster: "",
  logo: "",
  recipient: ""
};
const input = {
  name: flatInput.name,
  ticker: flatInput.ticker,
  description: flatInput.description,
  links: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
  logo: "",
  recipient: ""
};
const identityResult = await readIdentity(input, index);
const rendered = renderFactReceiptResult(identityResult, en, "en");
const rendererFixture = {
  N1: { state: "shared", n: 5, d: 3, first: "2026-09-11" },
  N2: { state: "unique" },
  N3: { state: "unique", ticker: { state: "unique" }, name: { state: "unique" } },
  I1: { state: "empty", links: { twitter: { state: "empty" }, telegram: { state: "empty" }, discord: { state: "empty" }, website: { state: "empty" }, farcaster: { state: "empty" } } },
  I2: { state: "empty" },
  I3: { state: "empty" },
  I4: { state: "too short to compare" }
};
const fixtureRendered = renderFactReceiptResult(rendererFixture, en, "en");
const receipt = {
  schema: FACT_RECEIPT_SCHEMA,
  source: "https://lintcha.com/",
  language: "en",
  snapshot: {
    from_block: numbers.window.from_block,
    to_block: numbers.window.to_block,
    from_time: numbers.window.from_time,
    to_time: numbers.window.to_time,
    index_sha256: manifest.index.sha256
  },
  input: flatInput,
  result: rendered
};

eq(validateFactReceipt(receipt), receipt, "strict validator returns the accepted receipt");
eq(factReceiptOf(receipt), receipt, "nullable adapter accepts the receipt");
deep(factReceiptIdentityInput(receipt), input, "flat page input becomes the strict engine input");
eq(rendered.length, 3, "empty optional recipient omits the paid group");
eq(rendered[0].heading, "What it calls itself", "renderer uses the receipt language");
eq(fixtureRendered[0].checks[0].lines[0].text, "5 launches in the window carry it, from 3 different deployers. First seen 2026-09-11.", "renderer reproduces an exact N1 sentence");
deep(fixtureRendered[1].checks[0].lines[0], { field: "X (Twitter)", text: "X (Twitter) Not filled." }, "renderer reproduces field-prefixed DOM text");
eq(renderFactReceiptResult(rendererFixture, es, "es")[0].heading, "Cómo se llama", "renderer supports a second shipped locale");

for (const [label, mutate] of [
  ["extra envelope field", value => { value.extra = true; }],
  ["language/source disagreement", value => { value.language = "es"; }],
  ["noncanonical source", value => { value.source = "https://lintcha.com/#fragment"; }],
  ["backwards block window", value => { value.snapshot.from_block = value.snapshot.to_block + 1; }],
  ["noncanonical time", value => { value.snapshot.from_time = "not-a-time"; }],
  ["extra input field", value => { value.input.contract = "0x00"; }],
  ["wrong input type", value => { value.input.logo = null; }],
  ["unbounded result shape", value => { value.result[1].checks[0].lines.push({ field: "extra", text: "extra" }); }],
  ["missing check text", value => { value.result[0].checks[0].check = ""; }]
]) {
  const changed = clone(receipt);
  mutate(changed);
  ok(factReceiptOf(changed) === null, "validator refuses " + label);
}

const receiptFile = write("receipt.json", receipt);
const exactBytes = fs.readFileSync(receiptFile);
const verified = run(["receipt-verify", "--receipt", receiptFile]);
eq(verified.status, 0, "receipt-verify exit");
eq(verified.stderr, "", "receipt-verify stderr stays empty");
eq(verified.body.verification.receipt_structure, "valid", "receipt-verify confirms only structure");
eq(verified.body.verification.corpus_checked, false, "receipt-verify does not imply a corpus check");
eq(verified.body.verification.result_replayed, false, "receipt-verify does not imply result reproduction");
eq(verified.body.verification.independent_proof, false, "receipt-verify states the proof boundary");
eq(verified.body.receipt.exact_bytes_sha256, crypto.createHash("sha256").update(exactBytes).digest("hex"), "receipt-verify fingerprints exact file bytes");

const replayed = run(["receipt-replay", "--receipt", receiptFile]);
eq(replayed.status, 0, "default manifest-bound replay exit");
eq(replayed.stderr, "", "replay stderr stays empty");
eq(replayed.body.verification.corpus, "manifest-bound", "replay distinguishes its corpus check");
eq(replayed.body.verification.snapshot, "matches-numbers", "replay binds the recorded window to numbers");
eq(replayed.body.verification.result, "reproduced", "replay reproduces the localized result");
eq(replayed.body.verification.chain_rebuilt, false, "replay does not claim a chain rebuild");
eq(replayed.body.verification.independent_proof, false, "replay states the proof boundary");

const textTampered = clone(receipt);
textTampered.result[0].checks[0].lines[0].text += " altered";
const textTamperedFile = write("receipt-text-tampered.json", textTampered);
eq(run(["receipt-verify", "--receipt", textTamperedFile]).status, 0, "shape-only verification accepts a structurally valid changed sentence");
const textReplay = run(["receipt-replay", "--receipt", textTamperedFile]);
eq(textReplay.status, 1, "changed sentence fails reproduction");
eq(textReplay.body.error.code, "receipt_result_mismatch", "changed sentence has a distinct replay error");

const inputTampered = clone(receipt);
inputTampered.input.name = "a different name";
const inputReplay = run(["receipt-replay", "--receipt", write("receipt-input-tampered.json", inputTampered)]);
eq(inputReplay.status, 1, "changed input with old result fails reproduction");
eq(inputReplay.body.error.code, "receipt_result_mismatch", "input/result disagreement is named");

const corpusTampered = clone(receipt);
corpusTampered.snapshot.index_sha256 = "0".repeat(64);
const corpusReplay = run(["receipt-replay", "--receipt", write("receipt-corpus-tampered.json", corpusTampered)]);
eq(corpusReplay.status, 1, "different receipt corpus fails reproduction");
eq(corpusReplay.body.error.code, "receipt_corpus_mismatch", "different receipt corpus is named");

const windowTampered = clone(receipt);
windowTampered.snapshot.from_block++;
const windowReplay = run(["receipt-replay", "--receipt", write("receipt-window-tampered.json", windowTampered)]);
eq(windowReplay.status, 1, "different receipt window fails reproduction");
eq(windowReplay.body.error.code, "receipt_snapshot_mismatch", "different receipt window is named");

const invalidReceipt = clone(receipt);
invalidReceipt.extra = true;
const invalid = run(["receipt-verify", "--receipt", write("receipt-invalid.json", invalidReceipt)]);
eq(invalid.status, 2, "invalid receipt exits two");
eq(invalid.body.error.code, "invalid_receipt", "invalid receipt has a bounded error");

const incomplete = run(["receipt-replay", "--receipt", receiptFile, "--index", path.join(root, "site", "launch-index.json")]);
eq(incomplete.status, 2, "partial custom corpus exits two");
eq(incomplete.body.error.code, "incomplete_corpus", "partial custom corpus is refused before reading it");

const custom = run([
  "receipt-replay", "--receipt", receiptFile,
  "--index", path.join(root, "site", "launch-index.json"),
  "--manifest", path.join(root, "site", "launch-manifest.json"),
  "--numbers", path.join(root, "site", "launch-numbers.json"),
  "--translations", path.join(root, "src", "i18n-src", "launch.en.json")
]);
eq(custom.status, 0, "complete explicit corpus replays");

const badIndex = fs.readFileSync(path.join(root, "site", "launch-index.json"), "utf8").trimEnd() + " \n";
const badCorpus = run([
  "receipt-replay", "--receipt", receiptFile,
  "--index", write("bad-index.json", badIndex),
  "--manifest", path.join(root, "site", "launch-manifest.json"),
  "--numbers", path.join(root, "site", "launch-numbers.json")
]);
eq(badCorpus.status, 1, "altered index bytes fail closed");
eq(badCorpus.body.error.code, "corpus_mismatch", "altered index bytes are named as a corpus mismatch");

const badStrings = write("bad-strings.json", { "launch.group.name": "only one string" });
const badTranslationReplay = run(["receipt-replay", "--receipt", receiptFile, "--translations", badStrings]);
eq(badTranslationReplay.status, 2, "incomplete translations fail closed");
eq(badTranslationReplay.body.error.code, "invalid_receipt_translations", "incomplete translations have a bounded error");

const help = run(["help"]);
ok(help.body.commands["receipt-verify"].required.includes("--receipt"), "help documents structural receipt verification");
ok(help.body.commands["receipt-replay"].optional.includes("--numbers"), "help documents the manifest-bound numbers input");
ok(help.body.commands["receipt-replay"].scope.includes("does not rebuild"), "help states the replay boundary");

const cliSource = fs.readFileSync(cli, "utf8");
const librarySource = fs.readFileSync(path.join(root, "lib", "fact-receipt.mjs"), "utf8");
ok(!/\bfetch\s*\(/.test(cliSource + librarySource), "receipt verification and replay contain no fetch call");
ok(!/node:https?|https?:\/\//.test(cliSource + librarySource), "receipt verification and replay import no network module or fixed remote URL");

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`${checks} checks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
