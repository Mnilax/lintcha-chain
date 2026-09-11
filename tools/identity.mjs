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
import { publishedManifestOf, validLaunchIndex } from "../lib/published-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultIndex = path.join(root, "site", "launch-index.json");
const defaultManifest = path.join(root, "site", "launch-manifest.json");
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
      doctor: { required: [], optional: [] }
    }
  };
}

async function main(argv) {
  const command = argv[0];
  const args = argv.slice(1);
  if (command === "normalize") return normalizeCommand(args);
  if (command === "read") return readCommand(args);
  if (command === "doctor") return doctorCommand(args);
  if (command === "help" || command === "--help") return helpCommand(args);
  if (command === undefined) throw new CliError("missing_command", "expected one command: normalize, read, doctor, or help");
  throw new CliError("unknown_command", "unknown command: " + command);
}

try {
  emit(await main(process.argv.slice(2)));
} catch (error) {
  const known = error instanceof CliError || error instanceof IdentityInputError;
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
