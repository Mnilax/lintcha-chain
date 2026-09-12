// Shared activation contracts for the static build and the Worker. Configuration is small enough to reject
// entirely: silently repairing a malformed token address or outbound link would let the two surfaces disagree.

const exactKeys = (value, keys) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

/** The static build and Worker refuse the same complete activation document above this byte ceiling. */
export const TOKEN_CONFIG_BODY_LIMIT = 1024;

const utf8Bytes = value => new TextEncoder().encode(value);

const addressOf = value => {
  if (value === null) return null;
  if (typeof value !== "string" || value !== value.trim() || !/^0x[0-9a-f]{40}$/i.test(value)) return undefined;
  const address = value.toLowerCase();
  return /^0x0{40}$/.test(address) ? undefined : address;
};

const httpsUrlOf = value => {
  if (value === null) return null;
  if (typeof value !== "string" || value !== value.trim() || /[\s\p{C}]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
};

/** A required runtime setting: canonical HTTPS URL or null, never an unsafe best effort. */
export function requiredHttpsUrlOf(value) {
  const url = httpsUrlOf(value);
  return typeof url === "string" ? url : null;
}

/** null means invalid. A configured address and its primary pons destination activate together. */
export function tokenConfigOf(value) {
  const keys = ["address", "pons", "uniswap"];
  if (!exactKeys(value, keys)) return null;
  const address = addressOf(value.address), pons = httpsUrlOf(value.pons), uniswap = httpsUrlOf(value.uniswap);
  if (address === undefined || pons === undefined || uniswap === undefined) return null;
  if (address === null) return pons === null && uniswap === null ? { address, pons, uniswap } : null;
  if (pons === null) return null;
  const config = { address, pons, uniswap };
  return utf8Bytes(JSON.stringify(config)).byteLength <= TOKEN_CONFIG_BODY_LIMIT ? config : null;
}

/** Parse one complete UTF-8 token.json under the same byte contract on disk and over the network. */
export function tokenConfigBytesOf(value) {
  if (!(value instanceof Uint8Array) || value.byteLength > TOKEN_CONFIG_BODY_LIMIT) return null;
  try {
    return tokenConfigOf(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)));
  } catch { return null; }
}

const labelledHttpsLinkOf = value => {
  if (!exactKeys(value, ["href", "label"])) return null;
  const href = httpsUrlOf(value.href);
  if (typeof href !== "string" || typeof value.label !== "string" || value.label !== value.label.trim() ||
      !value.label || /[\p{C}]/u.test(value.label)) return null;
  return { href, label: value.label };
};

/** null means invalid. Missing public accounts are represented only by JSON null, never an empty or unsafe URL. */
export function linksConfigOf(value) {
  const keys = ["x", "telegram"];
  if (!exactKeys(value, keys)) return null;
  const x = value.x === null ? null : Array.isArray(value.x) ? value.x.map(labelledHttpsLinkOf) : undefined;
  const telegram = httpsUrlOf(value.telegram);
  if (x === undefined || (Array.isArray(x) && (!x.length || x.some(link => link === null))) || telegram === undefined) return null;
  if (Array.isArray(x) && new Set(x.map(link => link.href)).size !== x.length) return null;
  return { x, telegram };
}
