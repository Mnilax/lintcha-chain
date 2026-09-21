import { createHmac } from "node:crypto";
import { constantTimeHexEqual } from "../utils.mjs";

function parseUniqueQuery(initData) {
  const params = new URLSearchParams(initData);
  const seen = new Set();
  const entries = [];
  for (const [key, value] of params) {
    if (seen.has(key)) throw new Error("DUPLICATE_INIT_DATA_FIELD");
    seen.add(key);
    entries.push([key, value]);
  }
  return { params, entries };
}

export function signTelegramInitData(fields, botToken) {
  const entries = Object.entries(fields).filter(([key]) => key !== "hash").sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken, "utf8").digest();
  return createHmac("sha256", secretKey).update(dataCheckString, "utf8").digest("hex");
}

export function validateTelegramInitData(initData, { botToken, nowSeconds, maxAgeSeconds, maxFutureSkewSeconds }) {
  if (!botToken || !Number.isSafeInteger(nowSeconds) || !Number.isSafeInteger(maxAgeSeconds) || !Number.isSafeInteger(maxFutureSkewSeconds)) {
    throw new TypeError("explicit validation policy required");
  }
  const { params, entries } = parseUniqueQuery(initData);
  const givenHash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const userRaw = params.get("user");
  if (!givenHash || !Number.isSafeInteger(authDate) || !userRaw) throw new Error("INCOMPLETE_INIT_DATA");
  const expectedHash = signTelegramInitData(Object.fromEntries(entries.filter(([key]) => key !== "hash" && key !== "signature")), botToken);
  if (!constantTimeHexEqual(givenHash, expectedHash)) throw new Error("INVALID_INIT_DATA_HASH");
  if (authDate > nowSeconds + maxFutureSkewSeconds) throw new Error("INIT_DATA_FROM_FUTURE");
  if (nowSeconds - authDate > maxAgeSeconds) throw new Error("STALE_INIT_DATA");
  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    throw new Error("INVALID_INIT_DATA_USER");
  }
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error("INVALID_INIT_DATA_USER");
  return Object.freeze({ telegramUserId: String(user.id), authDate, queryId: params.get("query_id") ?? null, user });
}
