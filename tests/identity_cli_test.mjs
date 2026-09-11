// Public/offline integration kit: one engine, strict JSON CLI, conformance doctor, and no network code.
//   node tests/identity_cli_test.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  ENGINE_ID,
  IDENTITY_KIT_SCHEMA,
  IDENTITY_INPUT_SCHEMA,
  check,
  normalize,
  normalizeField,
  validateIdentityInput,
  readIdentity
} from "../lib/identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "tools", "identity.mjs");
const require = createRequire(import.meta.url);
const siteEngine = require(path.join(root, "site", "launch.js"));
const packageEngine = await import("lintcha-chain");
let checks = 0;
let failures = 0;
const fail = message => { failures++; console.error("FAIL " + message); };
const ok = (value, message) => { checks++; if (!value) fail(message); };
const eq = (actual, expected, message) => { checks++; if (actual !== expected) fail(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };
const deep = (actual, expected, message) => { checks++; if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };

function run(args, input) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, input, encoding: "utf8" });
  let body;
  try { body = JSON.parse(result.stdout); }
  catch (error) { fail(`CLI stdout must be one JSON value for ${args.join(" ")}: ${error.message}; stdout=${JSON.stringify(result.stdout)}`); body = null; }
  return { ...result, body };
}

// The adapter exports the functions from site/launch.js instead of copying the engine.
eq(ENGINE_ID, "LINTCHA_12", "engine id");
eq(IDENTITY_KIT_SCHEMA, "lintcha-chain/identity-kit/v1", "kit schema");
eq(check, siteEngine.check, "check is the site engine function");
eq(normalize, siteEngine.normalize, "normalizers are the site engine object");
eq(packageEngine.check, siteEngine.check, "package root resolves to the site engine adapter");
eq(normalizeField("ticker", " $bob "), siteEngine.normalize.ticker(" $bob "), "normalizeField delegates to site ticker");
eq(normalizeField("link", "@Bob", { platform: "twitter" }), siteEngine.normalize.link("@Bob", "twitter"), "normalizeField delegates platform link");

const normalized = run(["normalize", "--field", "name", "--value", "  Bob-Coin!  "]);
eq(normalized.status, 0, "normalize exit");
eq(normalized.stderr, "", "normalize stderr stays empty");
deep(normalized.body, {
  ok: true,
  schema: IDENTITY_KIT_SCHEMA,
  engine: ENGINE_ID,
  command: "normalize",
  field: "name",
  input: "  Bob-Coin!  ",
  normalized: "bobcoin"
}, "normalize JSON envelope");

const recipient = run(["normalize", "--field", "recipient", "--value", "0x1234"]);
eq(recipient.status, 0, "recipient normalization exit");
deep(recipient.body.normalized, { value: "", state: "not readable" }, "recipient keeps structured state");

const linked = run(["normalize", "--field", "link", "--value", "@Bob", "--platform", "twitter"]);
eq(linked.status, 0, "platform link exit");
eq(linked.body.normalized, "x.com/bob", "platform link normalized");
eq(linked.body.platform, "twitter", "platform echoed");

const badField = run(["normalize", "--field", "contract", "--value", "0x1234"]);
eq(badField.status, 2, "unknown field exit");
eq(badField.stderr, "", "unknown field stderr stays empty");
eq(badField.body.ok, false, "unknown field envelope");
eq(badField.body.error.code, "unknown_field", "unknown field code");
ok(!Object.prototype.hasOwnProperty.call(badField.body.error, "stack"), "errors expose no stack");

const repeated = run(["normalize", "--field", "name", "--field", "ticker", "--value", "x"]);
eq(repeated.status, 2, "repeated option exit");
eq(repeated.body.error.code, "repeated_option", "repeated option code");

const invalidJson = run(["read", "--input", "-"], "{");
eq(invalidJson.status, 2, "invalid JSON exit");
eq(invalidJson.body.error.code, "invalid_json", "invalid JSON code");

const input = {
  name: "CLI fixture not expected to be common",
  ticker: "CLI_FIXTURE_XYZ",
  description: "one two three four five six seven eight nine ten eleven twelve",
  links: { twitter: "", telegram: "", discord: "", website: "", farcaster: "" },
  logo: "",
  recipient: ""
};
eq(validateIdentityInput(input), input, "strict input validator returns the accepted object");
const index = JSON.parse(fs.readFileSync(path.join(root, "site", "launch-index.json"), "utf8"));
const expectedRead = await readIdentity(input, index);
deep(
  await readIdentity({ ticker: "CLI_FIXTURE_XYZ", links: {} }, index),
  await siteEngine.check({ ticker: "CLI_FIXTURE_XYZ", links: {} }, index),
  "low-level readIdentity keeps the site engine's partial-input contract"
);
const read = run(["read", "--input", "-"], JSON.stringify(input));
eq(read.status, 0, "read exit");
eq(read.stderr, "", "read stderr stays empty");
eq(read.body.command, "read", "read command envelope");
deep(read.body.result, expectedRead, "CLI read equals direct site-engine read");
eq(read.body.corpus.sha256.length, 64, "read receipt includes the verified corpus hash");
eq(read.body.corpus.bytes, fs.statSync(path.join(root, "site", "launch-index.json")).size, "read receipt includes the filesystem byte size");

const typoMarker = "must-not-be-reflected-typo-value";
const typoInput = { ...input, tickr: typoMarker };
delete typoInput.ticker;
const typo = run(["read", "--input", "-"], JSON.stringify(typoInput));
eq(typo.status, 2, "a misspelled top-level field exits two");
eq(typo.body.error.code, "invalid_input_fields", "a misspelled top-level field has a structured code");
ok(!typo.stdout.includes(typoMarker), "a misspelled field error does not reflect its value");

const extraMarker = "must-not-be-reflected-extra-value";
const extra = run(["read", "--input", "-"], JSON.stringify({ ...input, extra: extraMarker }));
eq(extra.status, 2, "an extra top-level field exits two");
eq(extra.body.error.code, "invalid_input_fields", "an extra top-level field has a structured code");
ok(!extra.stdout.includes(extraMarker), "an extra field error does not reflect its value");

const missing = { ...input };
delete missing.recipient;
const missingField = run(["read", "--input", "-"], JSON.stringify(missing));
eq(missingField.status, 2, "a missing top-level field exits two");
eq(missingField.body.error.code, "invalid_input_fields", "a missing top-level field has a structured code");

const wrongType = run(["read", "--input", "-"], JSON.stringify({ ...input, logo: 7 }));
eq(wrongType.status, 2, "a non-string top-level value exits two");
eq(wrongType.body.error.code, "invalid_input_value", "a non-string top-level value has a structured code");

const missingLink = { ...input, links: { ...input.links } };
delete missingLink.links.discord;
const missingLinkField = run(["read", "--input", "-"], JSON.stringify(missingLink));
eq(missingLinkField.status, 2, "a missing link field exits two");
eq(missingLinkField.body.error.code, "invalid_link_fields", "a missing link field has a structured code");

const extraLink = run(["read", "--input", "-"], JSON.stringify({
  ...input,
  links: { ...input.links, matrix: "must-not-be-reflected-link-value" }
}));
eq(extraLink.status, 2, "an extra link field exits two");
eq(extraLink.body.error.code, "invalid_link_fields", "an extra link field has a structured code");
ok(!extraLink.stdout.includes("must-not-be-reflected-link-value"), "an extra link error does not reflect its value");

const wrongLinkType = run(["read", "--input", "-"], JSON.stringify({
  ...input,
  links: { ...input.links, website: null }
}));
eq(wrongLinkType.status, 2, "a non-string link value exits two");
eq(wrongLinkType.body.error.code, "invalid_link_value", "a non-string link value has a structured code");

const unpaired = run(["read", "--input", "-", "--index", "site/token.json"], JSON.stringify(input));
eq(unpaired.status, 2, "a custom index without a manifest is refused");
eq(unpaired.body.error.code, "missing_manifest", "unpaired custom index error code");

const wrongCorpus = run([
  "read", "--input", "-", "--index", "site/token.json", "--manifest", "site/launch-manifest.json"
], JSON.stringify(input));
eq(wrongCorpus.status, 2, "JSON with the wrong corpus bytes is refused");
eq(wrongCorpus.body.error.code, "corpus_mismatch", "wrong corpus error code");

const doctor = run(["doctor"]);
eq(doctor.status, 0, "doctor exit");
eq(doctor.stderr, "", "doctor stderr stays empty");
eq(doctor.body.ok, true, "doctor succeeds");
eq(doctor.body.fixture, "lintcha-chain/identity-conformance/v1", "doctor names fixture schema");
ok(Number.isInteger(doctor.body.checks) && doctor.body.checks > 0, "doctor reports completed checks");

const help = run(["help"]);
eq(help.status, 0, "help exit");
deep(help.body.commands.normalize.fields, ["link", "link-raw", "logo", "recipient", "description", "ticker", "name", "skeleton"], "help exposes exact normalization fields");
ok(help.body.commands.read.required.includes("--input"), "help documents read input");
ok(help.body.commands.read.optional.includes("--manifest"), "help documents the manifest pair");
deep(help.body.commands.read.input_schema, IDENTITY_INPUT_SCHEMA, "help exposes the exact read input schema");
eq(help.body.commands.read.input_schema.additionalProperties, false, "help refuses extra top-level fields");
eq(help.body.commands.read.input_schema.properties.links.additionalProperties, false, "help refuses extra link fields");

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
eq(packageJson.exports["."], "./lib/identity.mjs", "package root export");
eq(packageJson.exports["./fixtures/identity-conformance.json"], "./fixtures/identity-conformance.json", "package conformance fixture export");
eq(packageJson.bin["lintcha-chain"], "./tools/identity.mjs", "package bin");
ok(packageJson.scripts.test.includes("tests/identity_cli_test.mjs"), "root test gate includes the kit");

const cliSource = fs.readFileSync(cli, "utf8");
ok(!/\bfetch\s*\(/.test(cliSource), "CLI contains no fetch call");
ok(!/node:https?|https?:\/\//.test(cliSource), "CLI contains no network module or URL");

console.log(`${checks} checks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
