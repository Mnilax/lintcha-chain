// The holder check: a one time mark, one signature, one balance read, one address remembered.
//
// What is kept, and nothing else is:
//
//   nonce:<random bytes>   -> the telegram id that asked          fifteen minutes
//   session:<telegram id>  -> the address that signed             three days
//
// No purchase history, no signatures, no addresses of people who failed, no IP, no timestamps beyond the ones
// the store keeps itself. The expiry does the deleting; there is no sweeper to write and none to go wrong.
// /forget removes the session in one call.
//
// The mark is spent when it is looked up, not when the check succeeds. A second POST carrying the same mark is
// refused whatever happened the first time, which is the strict reading and the safe one: a link that can be
// replayed after a failure is a link that can be replayed.

import { SENTENCE } from "./texts.js";
import { recoverPersonal, normalizeAddress } from "./secp256k1.js";
import { balanceOf, decimalsOf } from "./chain.js";

export const NONCE_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_SECONDS = 72 * 60 * 60;

/**
 * The threshold, in whole tokens. Specification section four fixes it at one million and the /verify text says
 * "one million" out loud, so it is a constant here rather than a setting: a setting could drift away from the
 * sentence the reader was shown, and then the bot would be lying in a way nobody would notice.
 */
export const THRESHOLD_WHOLE_TOKENS = 1000000n;

/** The threshold in the token's own base units. */
export const thresholdUnits = decimals => THRESHOLD_WHOLE_TOKENS * 10n ** BigInt(decimals);

const randomHex = (bytes = 16) => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
};

/** A fresh mark for this telegram id, put in the store with its own expiry. Returns the mark. */
export async function newNonce(kv, telegramId) {
  const t = randomHex();
  await kv.put("nonce:" + t, String(telegramId), { expirationTtl: NONCE_TTL_SECONDS });
  return t;
}

/** The telegram id a mark belongs to, spending the mark in the same breath. null when it is used or expired. */
export async function spendNonce(kv, t) {
  if (typeof t !== "string" || !/^[0-9a-f]{8,64}$/.test(t)) return null;
  const key = "nonce:" + t;
  const id = await kv.get(key);
  if (id === null || id === undefined) return null;
  await kv.delete(key);
  return id;
}

export const sessionKey = telegramId => "session:" + String(telegramId);

export async function getSession(kv, telegramId) {
  const a = await kv.get(sessionKey(telegramId));
  return normalizeAddress(a);
}

export async function putSession(kv, telegramId, address) {
  await kv.put(sessionKey(telegramId), address, { expirationTtl: SESSION_TTL_SECONDS });
}

export async function dropSession(kv, telegramId) {
  const had = await kv.get(sessionKey(telegramId));
  if (had === null || had === undefined) return false;
  await kv.delete(sessionKey(telegramId));
  return true;
}

/**
 * The whole check, with no Telegram and no HTTP in it, so a test can run it with a fake store and a fake chain.
 *
 * body:  { t, address, signature }
 * token:  the site's token.json as chain.js read it, passed in rather than fetched again, so one request reads
 *         the site once and a test can hand over whatever state it wants to try
 * Returns one of:
 *   { ok: true,  telegramId, address, balance, decimals }
 *   { ok: false, why: "shape" | "nonce" | "signature" | "unreadable" | "below", telegramId?, need?, balance?, decimals? }
 *
 * The reasons are for this worker's own logging and for the page's wording. The bot's reply to a stranger never
 * spells out which check refused it beyond what the page already knows it sent.
 */
export async function checkHold(env, kv, body, token) {
  const claimed = normalizeAddress(body && body.address);
  const signature = body && typeof body.signature === "string" ? body.signature.trim() : null;
  const t = body && typeof body.t === "string" ? body.t.trim() : null;
  if (!claimed || !signature || !t) return { ok: false, why: "shape" };
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, why: "shape" };

  const telegramId = await spendNonce(kv, t);
  if (!telegramId) return { ok: false, why: "nonce" };

  const signer = recoverPersonal(SENTENCE, signature);
  if (!signer || signer !== claimed) return { ok: false, why: "signature", telegramId };

  const address = token && token.ok ? token.address : null;
  if (!address) return { ok: false, why: "unreadable", telegramId };

  const decimals = await decimalsOf(env, address);
  if (decimals === null) return { ok: false, why: "unreadable", telegramId };
  const balance = await balanceOf(env, address, signer);
  if (balance === null) return { ok: false, why: "unreadable", telegramId };

  const need = thresholdUnits(decimals);
  if (balance < need) return { ok: false, why: "below", telegramId, need, balance, decimals };

  await putSession(kv, telegramId, signer);
  return { ok: true, telegramId, address: signer, balance, decimals };
}
