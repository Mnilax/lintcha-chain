import { CHAIN_ID } from "../constants.mjs";
import { asBigInt, normalizeAddress } from "../utils.mjs";

export const TRADING_MODES = Object.freeze({
  NOTIFY_ONLY: "NOTIFY_ONLY",
  CONFIRM_EACH: "CONFIRM_EACH",
  COPY_TRADING: "COPY_TRADING",
});

export const SIGNING_ARCHITECTURES = Object.freeze({
  ERC4337_SESSION_KEY: "ERC4337_SESSION_KEY",
  EIP7702_SESSION_KEY: "EIP7702_SESSION_KEY",
});

export class ExecutionAuthorizationRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "ExecutionAuthorizationRefusal";
    this.code = code;
  }
}

export function assertExecutionAuthorization(profile, transaction, { nowSeconds, dailyUsed = 0n } = {}) {
  if (profile?.mode !== TRADING_MODES.COPY_TRADING) throw new ExecutionAuthorizationRefusal("COPY_TRADING_NOT_SELECTED");
  if (profile.status !== "active") throw new ExecutionAuthorizationRefusal("EXECUTION_AUTHORIZATION_INACTIVE");
  if (!Object.values(SIGNING_ARCHITECTURES).includes(profile.architecture)) throw new ExecutionAuthorizationRefusal("UNSUPPORTED_SIGNING_ARCHITECTURE");
  if (profile.chainId !== CHAIN_ID || transaction.chainId !== CHAIN_ID) throw new ExecutionAuthorizationRefusal("EXECUTION_CHAIN_MISMATCH");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(String(profile.authorizationId ?? ""))) throw new ExecutionAuthorizationRefusal("EXECUTION_AUTHORIZATION_MISSING");
  if (!Number.isSafeInteger(profile.expiresAt) || nowSeconds >= profile.expiresAt) throw new ExecutionAuthorizationRefusal("EXECUTION_AUTHORIZATION_EXPIRED");
  const wallet = normalizeAddress(profile.publicAddress);
  const recipient = normalizeAddress(profile.recipient);
  if (wallet !== recipient) throw new ExecutionAuthorizationRefusal("EXECUTION_RECIPIENT_MISMATCH");
  const direction = String(profile.orderDirection ?? "");
  const allowedDirections = new Set(profile.allowedDirections ?? []);
  if (!['BUY', 'SELL'].includes(direction) || !allowedDirections.has(direction)) throw new ExecutionAuthorizationRefusal("EXECUTION_DIRECTION_NOT_ALLOWED");
  if (direction !== "BUY") throw new ExecutionAuthorizationRefusal("AUTO_SELL_NOT_ENABLED");
  if (Number(profile.platformFeeBps ?? 0) !== 0 && !transaction.feeSettlement) {
    throw new ExecutionAuthorizationRefusal("PLATFORM_FEE_ROUTE_UNAVAILABLE");
  }
  const allowedTargets = new Set((profile.allowedTargets ?? []).map(normalizeAddress));
  const calls = [transaction.approval, transaction].filter(Boolean);
  if (calls.length === 0 || calls.some((call) => !allowedTargets.has(normalizeAddress(call.to)))) {
    throw new ExecutionAuthorizationRefusal("EXECUTION_TARGET_NOT_ALLOWED");
  }
  const amount = asBigInt(profile.orderAmount, "orderAmount");
  const maxPerTrade = asBigInt(profile.maxPerTrade, "maxPerTrade");
  const maxPerDay = asBigInt(profile.maxPerDay, "maxPerDay");
  if (amount <= 0n || amount > maxPerTrade) throw new ExecutionAuthorizationRefusal("EXECUTION_TRADE_CAP_EXCEEDED");
  if (asBigInt(dailyUsed, "dailyUsed") + amount > maxPerDay) throw new ExecutionAuthorizationRefusal("EXECUTION_DAILY_CAP_EXCEEDED");
  return Object.freeze({
    authorizationId: profile.authorizationId,
    architecture: profile.architecture,
    wallet,
    callCount: calls.length,
  });
}

export function assertManualSellAuthorization(profile, transaction, { nowSeconds, positionBalance } = {}) {
  if (profile?.mode !== TRADING_MODES.COPY_TRADING) throw new ExecutionAuthorizationRefusal("COPY_TRADING_NOT_SELECTED");
  if (profile.status !== "active") throw new ExecutionAuthorizationRefusal("EXECUTION_AUTHORIZATION_INACTIVE");
  if (!Object.values(SIGNING_ARCHITECTURES).includes(profile.architecture)) throw new ExecutionAuthorizationRefusal("UNSUPPORTED_SIGNING_ARCHITECTURE");
  if (profile.chainId !== CHAIN_ID || transaction.chainId !== CHAIN_ID) throw new ExecutionAuthorizationRefusal("EXECUTION_CHAIN_MISMATCH");
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(String(profile.authorizationId ?? ""))) throw new ExecutionAuthorizationRefusal("EXECUTION_AUTHORIZATION_MISSING");
  if (!Number.isSafeInteger(profile.expiresAt) || nowSeconds >= profile.expiresAt) throw new ExecutionAuthorizationRefusal("EXECUTION_AUTHORIZATION_EXPIRED");
  if (!(profile.allowedDirections ?? []).includes("SELL")) throw new ExecutionAuthorizationRefusal("MANUAL_SELL_NOT_ALLOWED");
  if (profile.orderDirection !== "SELL") throw new ExecutionAuthorizationRefusal("MANUAL_SELL_DIRECTION_REQUIRED");
  const wallet = normalizeAddress(profile.publicAddress);
  if (wallet !== normalizeAddress(profile.recipient)) throw new ExecutionAuthorizationRefusal("EXECUTION_RECIPIENT_MISMATCH");
  if (Number(profile.platformFeeBps ?? 0) !== 0 && !transaction.feeSettlement) throw new ExecutionAuthorizationRefusal("PLATFORM_FEE_ROUTE_UNAVAILABLE");
  const allowedTargets = new Set((profile.allowedTargets ?? []).map(normalizeAddress));
  const calls = [transaction.approval, transaction].filter(Boolean);
  if (calls.length === 0 || calls.some((call) => !allowedTargets.has(normalizeAddress(call.to)))) {
    throw new ExecutionAuthorizationRefusal("EXECUTION_TARGET_NOT_ALLOWED");
  }
  const amount = asBigInt(profile.orderAmount, "orderAmount");
  if (amount <= 0n || amount > asBigInt(positionBalance, "positionBalance")) throw new ExecutionAuthorizationRefusal("MANUAL_SELL_BALANCE_EXCEEDED");
  return Object.freeze({ authorizationId: profile.authorizationId, architecture: profile.architecture, wallet, callCount: calls.length, confirmation: "USER_CALLBACK" });
}
