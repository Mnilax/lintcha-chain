// Runtime contract for the published launch corpus and its small integrity manifest. Pure JavaScript so the
// static builder, Worker and offline kit can agree without copying schema decisions.

export const INDEX_NAMESPACES = Object.freeze([
  "link", "logo", "recipient", "description", "ticker", "name", "ticker_skeleton", "name_skeleton"
]);
const SKELETON = new Set(["ticker_skeleton", "name_skeleton"]);
export const MANIFEST_SCHEMA = "lintcha-chain/published-manifest/v1";
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const plain = value => !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
const whole = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const calendarDate = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = Date.parse(value + "T00:00:00.000Z");
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
};

const countsOf = expected => {
  if (!exactKeys(expected, ["entries", "entries_total"]) || !exactKeys(expected.entries, INDEX_NAMESPACES) || !whole(expected.entries_total)) return null;
  let total = 0;
  for (const namespace of INDEX_NAMESPACES) {
    const count = expected.entries[namespace];
    if (!whole(count)) return null;
    total += count;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total === expected.entries_total ? expected : null;
};

/** A full corpus must match both the entry grammar and the independently published namespace counts. */
export function validLaunchIndex(value, expected) {
  const counts = countsOf(expected);
  if (!counts || !exactKeys(value, INDEX_NAMESPACES)) return false;
  for (const namespace of INDEX_NAMESPACES) {
    const table = value[namespace];
    if (!plain(table) || Object.keys(table).length !== counts.entries[namespace]) return false;
    for (const [key, entry] of Object.entries(table)) {
      const skeleton = SKELETON.has(namespace);
      const fields = skeleton ? ["n", "d", "first", "v"] : ["n", "d", "first"];
      if (!/^[0-9a-f]{16}$/.test(key) || !exactKeys(entry, fields) || !Number.isSafeInteger(entry.n) || entry.n < 2 ||
          !Number.isSafeInteger(entry.d) || entry.d < (namespace === "recipient" ? 2 : 1) || entry.d > entry.n || !calendarDate(entry.first)) return false;
      if (skeleton && (!Number.isSafeInteger(entry.v) || entry.v < 1 || entry.v > entry.n)) return false;
    }
  }
  return true;
}

/** Returns the same bounded object when exact, otherwise null. */
export function publishedManifestOf(value) {
  if (!exactKeys(value, ["schema", "index", "numbers"]) || value.schema !== MANIFEST_SCHEMA) return null;
  if (!exactKeys(value.index, ["sha256", "bytes", "entries", "entries_total"]) ||
      !exactKeys(value.numbers, ["sha256", "bytes"]) || !digest(value.index.sha256) || !digest(value.numbers.sha256) ||
      !whole(value.index.bytes) || value.index.bytes < 1 || value.index.bytes > MAX_FILE_BYTES ||
      !whole(value.numbers.bytes) || value.numbers.bytes < 1 || value.numbers.bytes > MAX_FILE_BYTES ||
      !countsOf({ entries: value.index.entries, entries_total: value.index.entries_total })) return null;
  return value;
}
