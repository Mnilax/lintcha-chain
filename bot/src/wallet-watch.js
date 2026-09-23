// A small list of public source wallets. This stores no keys, balances, trades or execution permissions.
// It is separate from the verified holder session even though both use the existing SESSIONS KV binding.
export const WATCH_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MAX_WATCHED_WALLETS = 5;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;

export function publicWatchAddress(text) {
  const address = String(text ?? "").trim();
  return ADDRESS.test(address) && !ZERO_ADDRESS.test(address.toLowerCase()) ? address.toLowerCase() : null;
}

export function bareWatchAddress(text) {
  return publicWatchAddress(text);
}

export function watchKey(telegramUserId) {
  return `copy-watch:${String(telegramUserId)}`;
}

export async function watchedWallets(kv, telegramUserId) {
  if (!kv || typeof kv.get !== "function") throw new Error("WATCH_STORE_UNAVAILABLE");
  const value = await kv.get(watchKey(telegramUserId));
  if (value === null) return [];
  let addresses;
  try { addresses = JSON.parse(value); } catch { throw new Error("WATCH_STORE_INVALID"); }
  if (!Array.isArray(addresses) || addresses.length > MAX_WATCHED_WALLETS ||
      addresses.some((address) => publicWatchAddress(address) !== address) ||
      new Set(addresses).size !== addresses.length) throw new Error("WATCH_STORE_INVALID");
  return addresses;
}

export async function addWatchedWallet(kv, telegramUserId, address) {
  const normalized = publicWatchAddress(address);
  if (!normalized) throw new Error("INVALID_WATCH_ADDRESS");
  const addresses = await watchedWallets(kv, telegramUserId);
  if (addresses.includes(normalized)) return { addresses, added: false };
  if (addresses.length >= MAX_WATCHED_WALLETS) return { addresses, full: true };
  if (typeof kv.put !== "function") throw new Error("WATCH_STORE_UNAVAILABLE");
  const next = [...addresses, normalized];
  await kv.put(watchKey(telegramUserId), JSON.stringify(next), { expirationTtl: WATCH_TTL_SECONDS });
  return { addresses: next, added: true };
}

export async function removeWatchedWallet(kv, telegramUserId, address) {
  const normalized = publicWatchAddress(address);
  if (!normalized) throw new Error("INVALID_WATCH_ADDRESS");
  const addresses = await watchedWallets(kv, telegramUserId);
  if (!addresses.includes(normalized)) return { addresses, removed: false };
  const next = addresses.filter((entry) => entry !== normalized);
  if (next.length) {
    if (typeof kv.put !== "function") throw new Error("WATCH_STORE_UNAVAILABLE");
    await kv.put(watchKey(telegramUserId), JSON.stringify(next), { expirationTtl: WATCH_TTL_SECONDS });
  } else {
    if (typeof kv.delete !== "function") throw new Error("WATCH_STORE_UNAVAILABLE");
    await kv.delete(watchKey(telegramUserId));
  }
  return { addresses: next, removed: true };
}

export async function forgetWatchedWallets(kv, telegramUserId) {
  if (!kv || typeof kv.delete !== "function") throw new Error("WATCH_STORE_UNAVAILABLE");
  await kv.delete(watchKey(telegramUserId));
}
