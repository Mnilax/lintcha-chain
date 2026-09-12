// The HTTP identity boundary. It validates the documented full input before the request reaches the watcher;
// normalization and comparison remain in site/launch.js, imported through engine.js, and are not copied here.

import { LINKS } from "./engine.js";

export const ENGINE_ID = "LINTCHA_12";
export const IDENTITY_API_SCHEMA = "lintcha-chain/identity-api/v1";
export const IDENTITY_INPUT_FIELDS = Object.freeze([
  "name",
  "ticker",
  "description",
  "links",
  "logo",
  "recipient"
]);
export const IDENTITY_LINK_FIELDS = Object.freeze([...LINKS]);

const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const exactFields = (value, fields) => {
  if (!record(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every(field => Object.prototype.hasOwnProperty.call(value, field));
};

/** Return the accepted object itself, or null. Errors never reflect a submitted value. */
export function identityInputOf(value) {
  if (!exactFields(value, IDENTITY_INPUT_FIELDS)) return null;
  for (const field of IDENTITY_INPUT_FIELDS) {
    if (field !== "links" && typeof value[field] !== "string") return null;
  }
  if (!exactFields(value.links, IDENTITY_LINK_FIELDS)) return null;
  return IDENTITY_LINK_FIELDS.every(field => typeof value.links[field] === "string") ? value : null;
}
