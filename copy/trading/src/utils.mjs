import { createHash, timingSafeEqual } from "node:crypto";

export function normalizeAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new TypeError("invalid EVM address");
  }
  return value.toLowerCase();
}

export function normalizeHash(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError("invalid 32-byte hash");
  }
  return value.toLowerCase();
}

export function deterministicId(...parts) {
  return createHash("sha256").update(parts.map(String).join("\n"), "utf8").digest("hex");
}

export function constantTimeHexEqual(left, right) {
  if (!/^[0-9a-f]+$/i.test(left ?? "") || !/^[0-9a-f]+$/i.test(right ?? "") || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function asBigInt(value, label = "value") {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
}

export function deepClone(value) {
  return structuredClone(value);
}

export function redactForAudit(value) {
  const blocked = /seed|mnemonic|private.?key|secret|raw.?transaction/i;
  if (Array.isArray(value)) return value.map(redactForAudit);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !blocked.test(key)).map(([key, item]) => [key, redactForAudit(item)]));
  }
  return value;
}
