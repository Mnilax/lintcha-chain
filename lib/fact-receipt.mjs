// Strict, offline helpers for the fact-receipt JSON emitted by the comparison page.
// A v1 receipt records portable context; it is neither signed nor independent proof.

export const FACT_RECEIPT_SCHEMA = "lintcha-chain/fact-receipt/v1";
export const FACT_RECEIPT_LANGUAGES = Object.freeze(["en", "es", "pt"]);
export const FACT_RECEIPT_INPUT_FIELDS = Object.freeze([
  "name",
  "ticker",
  "description",
  "twitter",
  "telegram",
  "discord",
  "website",
  "farcaster",
  "logo",
  "recipient"
]);

const LANGUAGE_PATHS = Object.freeze({ en: "/", es: "/es/", pt: "/pt/" });
const REQUIRED_TRANSLATIONS = Object.freeze([
  "launch.form.name",
  "launch.form.ticker",
  "launch.form.twitter",
  "launch.form.telegram",
  "launch.form.discord",
  "launch.form.website",
  "launch.form.farcaster",
  "launch.group.name",
  "launch.group.points",
  "launch.group.paid",
  "launch.group.wrote",
  "launch.check.N1",
  "launch.check.N2",
  "launch.check.N3",
  "launch.check.I1",
  "launch.check.I2",
  "launch.check.I3",
  "launch.check.I4",
  "launch.row.shared_one",
  "launch.row.shared_many",
  "launch.row.lookalike",
  "launch.row.lookalike_name",
  "launch.row.unique",
  "launch.row.too_short",
  "launch.row.empty",
  "launch.row.first"
]);

const plain = value => !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
const whole = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const nonempty = value => typeof value === "string" && value.length > 0;
const instant = value => {
  if (typeof value !== "string") return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
};

export class FactReceiptError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "FactReceiptError";
    this.code = code;
  }
}

function validSource(value, language) {
  if (typeof value !== "string") return false;
  let source;
  try { source = new URL(value); } catch { return false; }
  return (source.protocol === "https:" || source.protocol === "http:") &&
    source.username === "" && source.password === "" && source.search === "" && source.hash === "" &&
    source.pathname === LANGUAGE_PATHS[language] && source.href === value;
}

function validLine(value) {
  return exactKeys(value, ["field", "text"]) &&
    (value.field === null || nonempty(value.field)) && nonempty(value.text);
}

function validCheck(value, minLines, maxLines = minLines) {
  return exactKeys(value, ["check", "lines"]) && nonempty(value.check) && Array.isArray(value.lines) &&
    value.lines.length >= minLines && value.lines.length <= maxLines && value.lines.every(validLine);
}

function validGroup(value, checkShapes) {
  return exactKeys(value, ["heading", "checks"]) && nonempty(value.heading) && Array.isArray(value.checks) &&
    value.checks.length === checkShapes.length && value.checks.every((check, index) => validCheck(check, ...checkShapes[index]));
}

function validRenderedResult(value) {
  if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4)) return false;
  if (!plain(value[0]) || !Array.isArray(value[0].checks)) return false;
  if (!validGroup(value[0], value[0].checks.length === 2 ? [[1], [1]] : [[1], [1], [1, 2]])) return false;
  if (value[0].checks.length !== 2 && value[0].checks.length !== 3) return false;
  if (!validGroup(value[1], [[5], [1]])) return false;
  const paid = value.length === 4;
  if (paid && !validGroup(value[2], [[1]])) return false;
  return validGroup(value[paid ? 3 : 2], [[1]]);
}

/**
 * Validate only the receipt's exact, bounded v1 structure and its cross-field source/language/snapshot invariants.
 * This cannot establish that the rendered result follows from the input: use a manifest-bound replay for that.
 */
export function validateFactReceipt(value) {
  if (!exactKeys(value, ["schema", "source", "language", "snapshot", "input", "result"]) || value.schema !== FACT_RECEIPT_SCHEMA) {
    throw new FactReceiptError("invalid_receipt", "receipt does not satisfy the fact-receipt v1 envelope");
  }
  if (!FACT_RECEIPT_LANGUAGES.includes(value.language) || !validSource(value.source, value.language)) {
    throw new FactReceiptError("invalid_receipt_source", "receipt source and language do not identify one comparison route");
  }
  const snapshot = value.snapshot;
  if (!exactKeys(snapshot, ["from_block", "to_block", "from_time", "to_time", "index_sha256"]) ||
      !whole(snapshot.from_block) || !whole(snapshot.to_block) || snapshot.to_block < snapshot.from_block ||
      !instant(snapshot.from_time) || !instant(snapshot.to_time) || Date.parse(snapshot.to_time) < Date.parse(snapshot.from_time) ||
      !digest(snapshot.index_sha256)) {
    throw new FactReceiptError("invalid_receipt_snapshot", "receipt has no usable exact snapshot context");
  }
  if (!exactKeys(value.input, FACT_RECEIPT_INPUT_FIELDS) || !FACT_RECEIPT_INPUT_FIELDS.every(field => typeof value.input[field] === "string")) {
    throw new FactReceiptError("invalid_receipt_input", "receipt input must contain exactly the documented string fields");
  }
  if (!validRenderedResult(value.result)) {
    throw new FactReceiptError("invalid_receipt_result", "receipt result does not have the comparison page's bounded row shape");
  }
  return value;
}

export function factReceiptOf(value) {
  try { return validateFactReceipt(value); } catch { return null; }
}

/** Convert the page's flat form snapshot into the public identity engine input. */
export function factReceiptIdentityInput(receipt) {
  const value = validateFactReceipt(receipt).input;
  return {
    name: value.name,
    ticker: value.ticker,
    description: value.description,
    links: {
      twitter: value.twitter,
      telegram: value.telegram,
      discord: value.discord,
      website: value.website,
      farcaster: value.farcaster
    },
    logo: value.logo,
    recipient: value.recipient
  };
}

export function validateFactReceiptTranslations(value) {
  if (!plain(value) || !REQUIRED_TRANSLATIONS.every(key => nonempty(value[key]))) {
    throw new FactReceiptError("invalid_receipt_translations", "translation document lacks a fact-receipt rendering string");
  }
  return value;
}

/** Render a fresh engine result into the exact localized row structure stored by the current page receipt. */
export function renderFactReceiptResult(identityResult, translations, language) {
  const strings = validateFactReceiptTranslations(translations);
  if (!FACT_RECEIPT_LANGUAGES.includes(language)) {
    throw new FactReceiptError("invalid_receipt_language", "receipt language is not supported");
  }
  const nf = new Intl.NumberFormat(language);
  const t = (key, vars) => vars ? strings[key].replace(/\{(\w+)\}/g, (match, name) => name in vars ? String(vars[name]) : match) : strings[key];
  const sentence = (result, isName = false) => {
    let vars;
    if (result.state === "shared") {
      vars = { n: nf.format(result.n), d: nf.format(result.d) };
      return t(result.d > 1 ? "launch.row.shared_many" : "launch.row.shared_one", vars) +
        (result.first ? " " + t("launch.row.first", { first: result.first }) : "");
    }
    if (result.state === "lookalike") {
      vars = { n: nf.format(result.n), v: nf.format(result.v), d: nf.format(result.d) };
      return t(isName ? "launch.row.lookalike_name" : "launch.row.lookalike", vars) +
        (result.first ? " " + t("launch.row.first", { first: result.first }) : "");
    }
    if (result.state === "unique") return t("launch.row.unique");
    if (result.state === "too short to compare") return t("launch.row.too_short");
    return t("launch.row.empty");
  };
  const line = (result, field = null, isName = false) => ({
    field: field === null ? null : t("launch.form." + field),
    text: (field === null ? "" : t("launch.form." + field) + " ") + sentence(result, isName)
  });
  const check = (id, lines) => ({ check: t("launch.check." + id), lines });
  const group = (name, checks) => ({ heading: t("launch.group." + name), checks });

  const names = [check("N1", [line(identityResult.N1)]), check("N2", [line(identityResult.N2)])];
  const lookalikes = [];
  if (identityResult.N3.ticker.state === "lookalike") lookalikes.push(line(identityResult.N3.ticker, "ticker"));
  if (identityResult.N3.name.state === "lookalike") lookalikes.push(line(identityResult.N3.name, "name", true));
  if (lookalikes.length) names.push(check("N3", lookalikes));

  const links = ["twitter", "telegram", "discord", "website", "farcaster"].map(field => line(identityResult.I1.links[field], field));
  const groups = [
    group("name", names),
    group("points", [check("I1", links), check("I2", [line(identityResult.I2)])])
  ];
  if (identityResult.I3.state === "shared" && identityResult.I3.d >= 2) groups.push(group("paid", [check("I3", [line(identityResult.I3)])]));
  groups.push(group("wrote", [check("I4", [line(identityResult.I4)])]));
  return groups;
}
