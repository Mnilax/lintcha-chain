// The holder check: a one time mark, one signature, one balance read, one address remembered.
//
// What is kept, and nothing else is:
//
//   holder_nonce row       -> the telegram id that asked          fifteen minutes, in the Watch object
//   session:<telegram id>  -> the address that signed             three days, in the sessions KV
//
// No purchase history, no signatures, no addresses of people who failed, no IP, no timestamps beyond the ones
// the store keeps itself. A take deletes its row immediately; the existing minute watchdog removes expired rows.
// /forget removes the session in one call.
//
// The mark is spent when it is looked up, not when the check succeeds. In production the Watch Durable Object
// performs that take synchronously against SQLite, so two concurrent POSTs cannot both receive the owner. A second
// POST carrying the same mark is refused whatever happened the first time.

import { sentenceFor } from "./texts.js";
import { recoverPersonal, normalizeAddress } from "./secp256k1.js";
import { balanceOf, decimalsOf } from "./chain.js";

export const NONCE_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_SECONDS = 72 * 60 * 60;

/**
 * The threshold, in whole tokens. Specification section four fixes it at five hundred thousand and the /verify text says
 * "five hundred thousand" out loud, so it is a constant here rather than a setting: a setting could drift away from the
 * sentence the reader was shown, and then the bot would be lying in a way nobody would notice.
 */
export const THRESHOLD_WHOLE_TOKENS = 500000n;

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
  if (kv && typeof kv.putNonce === "function") {
    const stored = await kv.putNonce(t, String(telegramId));
    if (stored === true) return t;
    const replay = normalizeNonce(stored);
    if (!replay) throw new Error("nonce store refused the mark");
    return replay;
  } else {
    await kv.put("nonce:" + t, String(telegramId), { expirationTtl: NONCE_TTL_SECONDS });
  }
  return t;
}

/** The exact canonical one-time mark, or null. There is deliberately no trimming or case folding. */
export function normalizeNonce(t) {
  if (typeof t !== "string") return null;
  return /^[0-9a-f]{32}$/.test(t) ? t : null;
}

/** The telegram id a mark belongs to, spending the mark in the same breath. null when it is used or expired. */
export async function spendNonce(kv, t) {
  const mark = normalizeNonce(t);
  if (!mark) return null;
  if (kv && typeof kv.takeNonce === "function") return await kv.takeNonce(mark);
  const key = "nonce:" + mark;
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
  // Workers KV is eventually consistent, so a read before this delete cannot prove either that a session
  // exists or that it does not. /forget is deliberately idempotent: issue the deletion every time and report
  // only whether the store accepted that request. The router's wording names the short cache window instead
  // of turning this acknowledgement into a false promise that every edge forgot at once.
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
export async function checkHold(env, kv, body, token, nonces = kv) {
  const claimed = normalizeAddress(body && body.address);
  const signature = body && typeof body.signature === "string" ? body.signature.trim() : null;
  const mark = normalizeNonce(body && body.t);
  if (!claimed || !signature || !mark) return { ok: false, why: "shape" };
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return { ok: false, why: "shape" };

  const telegramId = await spendNonce(nonces, mark);
  if (!telegramId) return { ok: false, why: "nonce" };

  const signer = recoverPersonal(sentenceFor(mark), signature);
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
