// Public Node adapter for the same LINTCHA_12 implementation used by the site.
// Keep this file as an adapter: normalization and comparison stay in site/launch.js.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("../site/launch.js");

export const ENGINE_ID = "LINTCHA_12";
export const IDENTITY_KIT_SCHEMA = "lintcha-chain/identity-kit/v1";
export const LINKS = engine.LINKS;
export const NAMESPACES = engine.NAMESPACES;
export const MIN_WORDS = engine.MIN_WORDS;
export const HEX_CHARS = engine.HEX_CHARS;
export const normalize = engine.normalize;
export const words = engine.words;
export const digest = engine.digest;
export const digestSubtle = engine.digestSubtle;
export const check = engine.check;

export const IDENTITY_INPUT_FIELDS = Object.freeze([
  "name",
  "ticker",
  "description",
  "links",
  "logo",
  "recipient"
]);
export const IDENTITY_LINK_FIELDS = Object.freeze([...LINKS]);

const stringSchema = () => Object.freeze({ type: "string" });
const linkProperties = Object.freeze(Object.fromEntries(IDENTITY_LINK_FIELDS.map(field => [field, stringSchema()])));
export const IDENTITY_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: IDENTITY_INPUT_FIELDS,
  properties: Object.freeze({
    name: stringSchema(),
    ticker: stringSchema(),
    description: stringSchema(),
    links: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: IDENTITY_LINK_FIELDS,
      properties: linkProperties
    }),
    logo: stringSchema(),
    recipient: stringSchema()
  })
});

export const NORMALIZE_FIELDS = Object.freeze([
  "link",
  "link-raw",
  "logo",
  "recipient",
  "description",
  "ticker",
  "name",
  "skeleton"
]);

export class IdentityInputError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "IdentityInputError";
    this.code = code;
  }
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IdentityInputError("invalid_" + label, label + " must be a JSON object");
  }
  return value;
}

function hasExactFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
}

// The public CLI calls this strict boundary before reading the corpus. Keep readIdentity
// below as the permissive adapter for callers that intentionally use the site engine's
// partial-input behaviour.
export function validateIdentityInput(value) {
  const input = record(value, "input");
  if (!hasExactFields(input, IDENTITY_INPUT_FIELDS)) {
    throw new IdentityInputError("invalid_input_fields", "input must contain exactly the documented fields");
  }
  for (const field of IDENTITY_INPUT_FIELDS) {
    if (field !== "links" && typeof input[field] !== "string") {
      throw new IdentityInputError("invalid_input_value", "each non-link input field must be a string");
    }
  }
  const links = record(input.links, "links");
  if (!hasExactFields(links, IDENTITY_LINK_FIELDS)) {
    throw new IdentityInputError("invalid_link_fields", "links must contain exactly the documented fields");
  }
  if (!IDENTITY_LINK_FIELDS.every(field => typeof links[field] === "string")) {
    throw new IdentityInputError("invalid_link_value", "each link must be a string");
  }
  return input;
}

export function normalizeField(field, value, options = {}) {
  if (!NORMALIZE_FIELDS.includes(field)) {
    throw new IdentityInputError("unknown_field", "unknown normalization field: " + String(field));
  }
  record(options, "options");
  if (options.platform !== undefined && field !== "link") {
    throw new IdentityInputError("platform_not_allowed", "platform is only valid for the link field");
  }
  if (options.platform !== undefined && !LINKS.includes(options.platform)) {
    throw new IdentityInputError("unknown_platform", "unknown link platform: " + String(options.platform));
  }
  if (field === "link") return normalize.link(value, options.platform);
  if (field === "link-raw") return normalize.linkRaw(value);
  return normalize[field](value);
}

export function readIdentity(input, index) {
  return check(record(input, "input"), record(index, "index"));
}

export default Object.freeze({
  ENGINE_ID,
  IDENTITY_KIT_SCHEMA,
  LINKS,
  NAMESPACES,
  MIN_WORDS,
  HEX_CHARS,
  NORMALIZE_FIELDS,
  IDENTITY_INPUT_FIELDS,
  IDENTITY_LINK_FIELDS,
  IDENTITY_INPUT_SCHEMA,
  normalize,
  normalizeField,
  words,
  digest,
  digestSubtle,
  check,
  validateIdentityInput,
  readIdentity
});
