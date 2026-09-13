#!/usr/bin/env node
// Offline JSON CLI for the public identity adapter. No command in this file performs network I/O.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  ENGINE_ID,
  IDENTITY_KIT_SCHEMA,
  IDENTITY_INPUT_SCHEMA,
  LINKS,
  NORMALIZE_FIELDS,
  IdentityInputError,
  normalizeField,
  validateIdentityInput,
  readIdentity
} from "../lib/identity.mjs";
import {
  FactReceiptError,
  validateFactReceipt,
  factReceiptIdentityInput,
  renderFactReceiptResult
} from "../lib/fact-receipt.mjs";
import { publishedManifestOf, validLaunchIndex } from "../lib/published-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultIndex = path.join(root, "site", "launch-index.json");
const defaultManifest = path.join(root, "site", "launch-manifest.json");
const defaultNumbers = path.join(root, "site", "launch-numbers.json");
const conformanceFile = path.join(root, "fixtures", "identity-conformance.json");

class CliError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

const emit = value => process.stdout.write(JSON.stringify(value) + "\n");

function parseOptions(args, allowed) {
  const options = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i];
    if (!option || !option.startsWith("--")) {
      throw new CliError("unexpected_argument", "expected an option, got: " + String(option));
    }
    const name = option.slice(2);
    if (!allowed.includes(name)) throw new CliError("unknown_option", "unknown option: " + option);
    if (Object.prototype.hasOwnProperty.call(options, name)) throw new CliError("repeated_option", "option repeated: " + option);
    if (i + 1 >= args.length) throw new CliError("missing_option_value", "option needs a value: " + option);
    options[name] = args[i + 1];
  }
  return options;
}

function required(options, name) {
  if (!Object.prototype.hasOwnProperty.call(options, name)) throw new CliError("missing_option", "missing required option: --" + name);
  return options[name];
}

function jsonFile(file, label) {
  let text;
  try {
    text = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new CliError("read_failed", "could not read " + label + ": " + error.message);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError("invalid_json", label + " is not valid JSON: " + error.message);
  }
}

function jsonDocument(file, label) {
  let bytes;
  try {
    bytes = file === "-" ? fs.readFileSync(0) : fs.readFileSync(file);
  } catch (error) {
    throw new CliError("read_failed", "could not read " + label + ": " + error.message);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new CliError("invalid_json", label + " is not valid JSON: " + error.message);
  }
  return { bytes, value };
}

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const plain = value => !!value && typeof value === "object" && !Array.isArray(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const instant = value => {
  if (typeof value !== "string") return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
};

function replayCorpus(options, receiptFile) {
  const names = ["index", "manifest", "numbers"];
  const supplied = names.filter(name => options[name] !== undefined);
  if (supplied.length > 0 && supplied.length !== names.length) {
    throw new CliError("incomplete_corpus", "a custom replay corpus requires --index, --manifest, and --numbers together");
  }
  const indexFile = options.index === undefined ? defaultIndex : options.index;
  const manifestFile = options.manifest === undefined ? defaultManifest : options.manifest;
  const numbersFile = options.numbers === undefined ? defaultNumbers : options.numbers;
  const translationsFile = options.translations === undefined ? null : options.translations;
  if ([receiptFile, indexFile, manifestFile, numbersFile, translationsFile].filter(file => file === "-").length > 1) {
    throw new CliError("stdin_conflict", "only one replay document can read from stdin");
  }
  return { indexFile, manifestFile, numbersFile, translationsFile };
}

function replayNumbers(value, manifest) {
  const window = plain(value) && plain(value.window) ? value.window : null;
  const index = plain(value) && plain(value.index) ? value.index : null;
  if (!window || !whole(window.from_block) || !whole(window.to_block) || window.to_block < window.from_block ||
      !whole(window.blocks) || window.blocks !== window.to_block - window.from_block + 1 ||
      !instant(window.from_time) || !instant(window.to_time) || Date.parse(window.to_time) < Date.parse(window.from_time) ||
      !index || index.bytes !== manifest.index.bytes || index.entries_total !== manifest.index.entries_total ||
      !isDeepStrictEqual(index.entries, manifest.index.entries)) {
    throw new CliError("invalid_numbers", "numbers do not bind the manifest counts and a usable snapshot window");
  }
  return window;
}

async function normalizeCommand(args) {
  const options = parseOptions(args, ["field", "value", "platform"]);
  const field = required(options, "field");
  const value = required(options, "value");
  const settings = Object.prototype.hasOwnProperty.call(options, "platform") ? { platform: options.platform } : {};
  const normalized = normalizeField(field, value, settings);
  const output = { ok: true, schema: IDENTITY_KIT_SCHEMA, engine: ENGINE_ID, command: "normalize", field, input: value, normalized };
  if (settings.platform !== undefined) output.platform = settings.platform;
  return output;
}

async function readCommand(args) {
  const options = parseOptions(args, ["input", "index", "manifest"]);
  const inputFile = required(options, "input");
  const indexFile = options.index === undefined ? defaultIndex : options.index;
  const manifestFile = options.manifest === undefined
    ? (options.index === undefined ? defaultManifest : null)
    : options.manifest;
  if (manifestFile === null) throw new CliError("missing_manifest", "a custom --index requires its matching --manifest");
  if ([inputFile, indexFile, manifestFile].filter(file => file === "-").length > 1) {
    throw new CliError("stdin_conflict", "only one of input, index, and manifest can read from stdin");
  }
  const input = validateIdentityInput(jsonFile(inputFile, "input"));
  const index = jsonDocument(indexFile, "index");
  const manifest = publishedManifestOf(jsonFile(manifestFile, "manifest"));
  if (!manifest) throw new CliError("invalid_manifest", "manifest does not satisfy the published corpus contract");
  const indexHash = crypto.createHash("sha256").update(index.bytes).digest("hex");
  if (index.bytes.length !== manifest.index.bytes || indexHash !== manifest.index.sha256) {
    throw new CliError("corpus_mismatch", "index bytes do not match the supplied manifest");
  }
  if (!validLaunchIndex(index.value, { entries: manifest.index.entries, entries_total: manifest.index.entries_total })) {
    throw new CliError("invalid_index", "index does not satisfy the published corpus contract");
  }
  return {
    ok: true,
    schema: IDENTITY_KIT_SCHEMA,
    engine: ENGINE_ID,
    command: "read",
    corpus: { sha256: manifest.index.sha256, bytes: manifest.index.bytes, entries_total: manifest.index.entries_total },
    result: await readIdentity(input, index.value)
  };
}

async function receiptVerifyCommand(args) {
  const options = parseOptions(args, ["receipt"]);
  const receiptFile = required(options, "receipt");
  const document = jsonDocument(receiptFile, "receipt");
  const receipt = validateFactReceipt(document.value);
  return {
    ok: true,
    schema: IDENTITY_KIT_SCHEMA,
    engine: ENGINE_ID,
    command: "receipt-verify",
    receipt: {
      schema: receipt.schema,
      exact_bytes_sha256: sha256(document.bytes),
      source: receipt.source,
      language: receipt.language,
      index_sha256: receipt.snapshot.index_sha256
    },
    verification: {
      receipt_structure: "valid",
      corpus_checked: false,
      result_replayed: false,
      independent_proof: false
    }
  };
}

async function receiptReplayCommand(args) {
  const options = parseOptions(args, ["receipt", "index", "manifest", "numbers", "translations"]);
  const receiptFile = required(options, "receipt");
  const files = replayCorpus(options, receiptFile);
  const receiptDocument = jsonDocument(receiptFile, "receipt");
  const receipt = validateFactReceipt(receiptDocument.value);
  const index = jsonDocument(files.indexFile, "index");
  const manifest = publishedManifestOf(jsonFile(files.manifestFile, "manifest"));
  const numbers = jsonDocument(files.numbersFile, "numbers");
  if (!manifest) throw new CliError("invalid_manifest", "manifest does not satisfy the published corpus contract");
  if (index.bytes.length !== manifest.index.bytes || sha256(index.bytes) !== manifest.index.sha256 ||
      numbers.bytes.length !== manifest.numbers.bytes || sha256(numbers.bytes) !== manifest.numbers.sha256) {
    throw new CliError("corpus_mismatch", "index or numbers bytes do not match the supplied manifest", 1);
  }
  if (!validLaunchIndex(index.value, { entries: manifest.index.entries, entries_total: manifest.index.entries_total })) {
    throw new CliError("invalid_index", "index does not satisfy the published corpus contract");
  }
  const window = replayNumbers(numbers.value, manifest);
  if (receipt.snapshot.index_sha256 !== manifest.index.sha256) {
    throw new CliError("receipt_corpus_mismatch", "receipt names a different index than the supplied manifest", 1);
  }
  if (receipt.snapshot.from_block !== window.from_block || receipt.snapshot.to_block !== window.to_block ||
      receipt.snapshot.from_time !== window.from_time || receipt.snapshot.to_time !== window.to_time) {
    throw new CliError("receipt_snapshot_mismatch", "receipt window differs from the manifest-bound numbers", 1);
  }
  const translationsFile = files.translationsFile || path.join(root, "src", "i18n-src", "launch." + receipt.language + ".json");
  if ([receiptFile, files.indexFile, files.manifestFile, files.numbersFile, translationsFile].filter(file => file === "-").length > 1) {
    throw new CliError("stdin_conflict", "only one replay document can read from stdin");
  }
  const input = validateIdentityInput(factReceiptIdentityInput(receipt));
  const identityResult = await readIdentity(input, index.value);
  const expectedResult = renderFactReceiptResult(identityResult, jsonFile(translationsFile, "translations"), receipt.language);
  if (!isDeepStrictEqual(receipt.result, expectedResult)) {
    throw new CliError("receipt_result_mismatch", "receipt result was not reproduced from its input and supplied corpus", 1);
  }
  return {
    ok: true,
    schema: IDENTITY_KIT_SCHEMA,
    engine: ENGINE_ID,
    command: "receipt-replay",
    receipt: {
      schema: receipt.schema,
      exact_bytes_sha256: sha256(receiptDocument.bytes),
      source: receipt.source,
      language: receipt.language
    },
    corpus: {
      index_sha256: manifest.index.sha256,
      index_bytes: manifest.index.bytes,
      numbers_sha256: manifest.numbers.sha256,
      numbers_bytes: manifest.numbers.bytes,
      entries_total: manifest.index.entries_total
    },
    verification: {
      receipt_structure: "valid",
      corpus: "manifest-bound",
      snapshot: "matches-numbers",
      result: "reproduced",
      chain_rebuilt: false,
      independent_proof: false
    }
  };
}

async function doctorCommand(args) {
  if (args.length) throw new CliError("unexpected_argument", "doctor takes no options");
  const fixture = jsonFile(conformanceFile, "conformance fixture");
  if (!fixture || fixture.schema !== "lintcha-chain/identity-conformance/v1" || fixture.engine !== ENGINE_ID || !Array.isArray(fixture.normalize) || !Array.isArray(fixture.read)) {
    throw new CliError("invalid_fixture", "conformance fixture has an unsupported shape", 1);
  }
  let checks = 0;
  for (const item of fixture.normalize) {
    const settings = item.platform === undefined ? {} : { platform: item.platform };
    const actual = normalizeField(item.field, item.input, settings);
    checks++;
    if (!isDeepStrictEqual(actual, item.expected)) throw new CliError("conformance_failed", "normalization conformance failed for field: " + String(item.field), 1);
  }
  for (const item of fixture.read) {
    const actual = await readIdentity(item.input, item.index);
    checks++;
    if (!isDeepStrictEqual(actual, item.expected)) throw new CliError("conformance_failed", "read conformance failed", 1);
  }
  return { ok: true, schema: IDENTITY_KIT_SCHEMA, engine: ENGINE_ID, command: "doctor", fixture: fixture.schema, checks };
}

function helpCommand(args) {
  if (args.length) throw new CliError("unexpected_argument", "help takes no options");
  return {
    ok: true,
    schema: IDENTITY_KIT_SCHEMA,
    engine: ENGINE_ID,
    command: "help",
    commands: {
      normalize: { required: ["--field", "--value"], optional: ["--platform"], fields: NORMALIZE_FIELDS, platforms: LINKS },
      read: {
        required: ["--input"],
        optional: ["--index", "--manifest"],
        stdin: "use - for only one input file; a custom index requires its matching manifest",
        input_schema: IDENTITY_INPUT_SCHEMA
      },
      "receipt-verify": {
        required: ["--receipt"],
        optional: [],
        scope: "strict receipt structure and exact-byte SHA-256 only; no corpus or result claim"
      },
      "receipt-replay": {
        required: ["--receipt"],
        optional: ["--index", "--manifest", "--numbers", "--translations"],
        corpus: "custom index, manifest, and numbers must be supplied together",
        scope: "replays the receipt locally against manifest-bound artifacts; does not rebuild the chain snapshot"
      },
      doctor: { required: [], optional: [] }
    }
  };
}

async function main(argv) {
  const command = argv[0];
  const args = argv.slice(1);
  if (command === "normalize") return normalizeCommand(args);
  if (command === "read") return readCommand(args);
  if (command === "receipt-verify") return receiptVerifyCommand(args);
  if (command === "receipt-replay") return receiptReplayCommand(args);
  if (command === "doctor") return doctorCommand(args);
  if (command === "help" || command === "--help") return helpCommand(args);
  if (command === undefined) throw new CliError("missing_command", "expected one command: normalize, read, receipt-verify, receipt-replay, doctor, or help");
  throw new CliError("unknown_command", "unknown command: " + command);
}

try {
  emit(await main(process.argv.slice(2)));
} catch (error) {
  const known = error instanceof CliError || error instanceof IdentityInputError || error instanceof FactReceiptError;
  emit({
    ok: false,
    schema: IDENTITY_KIT_SCHEMA,
    engine: ENGINE_ID,
    error: {
      code: known && error.code ? error.code : "internal_error",
      message: known ? error.message : "identity command failed"
    }
  });
  process.exitCode = error instanceof CliError ? error.exitCode : 2;
}
