import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ADDRESS = /^0x[0-9a-f]{40}$/;
const TOKEN_BODY_LIMIT = 2048;

export const CONFIGURE_SELECTOR = "0xdc63f7f4";
export const LIMITS_SELECTOR = "0x20d7bec1";
export const SET_USER_PAUSED_SELECTOR = "0xb990b559";

function word(value, bits, code) {
  let parsed;
  try { parsed = BigInt(value); } catch { throw new Error(code); }
  if (parsed < 0n || parsed >= (1n << BigInt(bits))) throw new Error(code);
  return parsed.toString(16).padStart(64, "0");
}

function addressWord(address) {
  const normalized = String(address || "").toLowerCase();
  if (!ADDRESS.test(normalized)) throw new Error("INVALID_DELEGATION_WALLET");
  return normalized.slice(2).padStart(64, "0");
}

export function validateActivationLimits(input, { policy, delegationMaxTtlSeconds }, now) {
  let maxTransactionWei, maxDailySpendWei;
  try {
    if (!/^\d{1,39}$/.test(input?.maxTransactionWei || "") || !/^\d{1,39}$/.test(input?.maxDailySpendWei || "")) throw new Error();
    maxTransactionWei = BigInt(input.maxTransactionWei);
    maxDailySpendWei = BigInt(input.maxDailySpendWei);
  } catch { throw new Error("INVALID_DELEGATION_CAP"); }
  if (maxTransactionWei <= 0n || maxDailySpendWei < maxTransactionWei || maxTransactionWei > BigInt(policy.maxTransactionWei) || maxDailySpendWei > BigInt(policy.maxDailySpendWei) || maxTransactionWei >= (1n << 128n) || maxDailySpendWei >= (1n << 128n)) throw new Error("INVALID_DELEGATION_CAP");
  if (!Number.isSafeInteger(input.maxSlippageBps) || input.maxSlippageBps < 0 || input.maxSlippageBps > policy.maxSlippageBps || input.maxSlippageBps > 65_535) throw new Error("INVALID_DELEGATION_SLIPPAGE");
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + delegationMaxTtlSeconds) throw new Error("INVALID_DELEGATION_EXPIRY");
  return Object.freeze({
    maxTransactionWei: maxTransactionWei.toString(),
    maxDailySpendWei: maxDailySpendWei.toString(),
    maxSlippageBps: input.maxSlippageBps,
    expiresAt: input.expiresAt,
  });
}

export function configureTransaction(wrapperAddress, limits, chainId) {
  const to = String(wrapperAddress || "").toLowerCase();
  if (!ADDRESS.test(to) || !Number.isSafeInteger(chainId)) throw new Error("INVALID_AUTO_BUY_EXECUTOR");
  const data = `${CONFIGURE_SELECTOR}${word(limits.maxTransactionWei, 128, "INVALID_DELEGATION_CAP")}${word(limits.maxDailySpendWei, 128, "INVALID_DELEGATION_CAP")}${word(limits.maxSlippageBps, 16, "INVALID_DELEGATION_SLIPPAGE")}${word(limits.expiresAt, 64, "INVALID_DELEGATION_EXPIRY")}`;
  return Object.freeze({ chainId, to, value: "0", data });
}

export function pauseTransaction(wrapperAddress, chainId) {
  const to = String(wrapperAddress || "").toLowerCase();
  if (!ADDRESS.test(to) || !Number.isSafeInteger(chainId)) throw new Error("INVALID_AUTO_BUY_EXECUTOR");
  return Object.freeze({ chainId, to, value: "0", data: `${SET_USER_PAUSED_SELECTOR}${word(1, 8, "INVALID_PAUSE")}` });
}

export function decodeConfiguredLimits(raw) {
  if (!/^0x[0-9a-fA-F]{320}$/.test(raw || "")) throw new Error("ONCHAIN_LIMITS_UNREADABLE");
  const words = Array.from({ length: 5 }, (_, index) => BigInt(`0x${raw.slice(2 + index * 64, 66 + index * 64)}`));
  if (words[0] >= (1n << 128n) || words[1] >= (1n << 128n) || words[2] >= (1n << 16n) || words[3] >= (1n << 64n) || words[4] > 1n) throw new Error("ONCHAIN_LIMITS_UNREADABLE");
  return Object.freeze({ maxTransactionWei: words[0].toString(), maxDailySpendWei: words[1].toString(), maxSlippageBps: Number(words[2]), expiresAt: Number(words[3]), paused: words[4] === 1n });
}

export async function readFinalizedConfiguredLimits({ rpcPool, wrapperAddress, walletAddress }) {
  const health = await rpcPool.healthCheck();
  if (!Number.isSafeInteger(health.finalizedBlock)) throw new Error("RPC_FINALITY_TAGS_UNSUPPORTED");
  const blockTag = `0x${health.finalizedBlock.toString(16)}`;
  // Bind the read-back to one block hash agreed by both providers. health.referenceHash is the common head,
  // not necessarily the conservative finalized block used below.
  const finalizedBlock = await rpcPool.quorumRead("eth_getBlockByNumber", [blockTag, false]);
  if (!finalizedBlock?.hash || Number(BigInt(finalizedBlock.number || -1)) !== health.finalizedBlock) throw new Error("RPC_FINALIZED_BLOCK_UNREADABLE");
  const raw = await rpcPool.quorumRead("eth_call", [{ to: String(wrapperAddress).toLowerCase(), data: `${LIMITS_SELECTOR}${addressWord(walletAddress)}` }, blockTag]);
  return Object.freeze({ limits: decodeConfiguredLimits(raw), blockNumber: health.finalizedBlock, blockHash: String(finalizedBlock.hash).toLowerCase() });
}

export function assertConfiguredLimits(actual, expected, now) {
  if (actual.maxTransactionWei !== expected.maxTransactionWei || actual.maxDailySpendWei !== expected.maxDailySpendWei || actual.maxSlippageBps !== expected.maxSlippageBps || actual.expiresAt !== expected.expiresAt || actual.paused || actual.expiresAt <= now) throw new Error("ONCHAIN_LIMITS_MISMATCH");
  return actual;
}

function encode(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

/** HMAC-bound, short-lived activation challenge. It carries only public limits and a random nonce. */
export class DelegationActivationCodec {
  constructor(secret, { ttlSeconds = 600, random = (size) => randomBytes(size) } = {}) {
    if (!Buffer.isBuffer(secret) || secret.length < 32) throw new Error("ACTIVATION_SECRET_REQUIRED");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600) throw new Error("INVALID_ACTIVATION_TTL");
    this.secret = secret; this.ttlSeconds = ttlSeconds; this.random = random;
  }
  issue({ userId, walletAddress, limits }, now) {
    const payload = { purpose: "AUTO_BUY_ACTIVATION", nonce: this.random(16).toString("hex"), userId: String(userId), walletAddress: String(walletAddress).toLowerCase(), limits, issuedAt: now, expiresAt: now + this.ttlSeconds };
    const body = encode(payload);
    return `${body}.${createHmac("sha256", this.secret).update(body).digest("base64url")}`;
  }
  verify(token, { userId, walletAddress }, now) {
    const [body, signature, extra] = String(token || "").split(".");
    if (!body || !signature || extra || body.length > TOKEN_BODY_LIMIT) throw new Error("INVALID_ACTIVATION_TOKEN");
    const expected = createHmac("sha256", this.secret).update(body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("INVALID_ACTIVATION_TOKEN");
    let payload;
    try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { throw new Error("INVALID_ACTIVATION_TOKEN"); }
    if (payload?.purpose !== "AUTO_BUY_ACTIVATION" || !/^[0-9a-f]{32}$/.test(payload.nonce || "") || payload.userId !== String(userId) || payload.walletAddress !== String(walletAddress).toLowerCase() || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) || now < payload.issuedAt || now >= payload.expiresAt) throw new Error("INVALID_ACTIVATION_TOKEN");
    return Object.freeze(payload);
  }
}
