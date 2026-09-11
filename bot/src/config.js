// Deployment settings arrive as strings in a Worker, but tests and local callers may hand over numbers
// directly. Read only the exact shapes each setting promises: no whitespace, exponent notation,
// fractions, Infinity or implicit truthiness. Callers choose whether an invalid explicit value falls back to a
// safe operating default or closes a feature altogether.

const absent = value => value === undefined || value === null || value === "";

export function integerSetting(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, invalid = fallback } = {}) {
  if (absent(value)) return fallback;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(value)
      ? Number(value)
      : NaN;
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : invalid;
}

/** A BotFather username, normalized without @. Telegram usernames are case-insensitive. */
export function botUsernameOf(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{5,32}$/.test(value) || !/bot$/i.test(value)) return null;
  return value.toLowerCase();
}
