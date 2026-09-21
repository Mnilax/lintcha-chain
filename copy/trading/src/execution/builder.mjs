import { asBigInt, normalizeAddress } from "../utils.mjs";
import {
  CHAIN_ID,
  PONS_V2_FACTORY,
  PONS_V2_SELECTORS,
  SELECTORS,
  UNISWAP_V2_ROUTER02,
  WRAPPED_NATIVE,
  ZERO_ADDRESS,
} from "../constants.mjs";

function word(value) {
  return asBigInt(value).toString(16).padStart(64, "0");
}

function addressWord(address) {
  return normalizeAddress(address).slice(2).padStart(64, "0");
}

function pathTail(path) {
  return `${word(path.length)}${path.map(addressWord).join("")}`;
}

export function buildExactApproval({ token, spender, amount, chainId }) {
  if (chainId !== CHAIN_ID || normalizeAddress(spender) !== UNISWAP_V2_ROUTER02) throw new Error("UNSUPPORTED_SPENDER");
  return Object.freeze({
    chainId,
    to: normalizeAddress(token),
    value: "0",
    data: `0x095ea7b3${addressWord(spender)}${word(amount)}`,
    approvalAmount: asBigInt(amount).toString(),
    spender: UNISWAP_V2_ROUTER02,
  });
}

export function buildSwapTransaction(quote) {
  if (quote.venue === "PONS_V2_CURVE") return buildPonsV2CurveTransaction(quote);
  if (quote.chainId !== CHAIN_ID || normalizeAddress(quote.router) !== UNISWAP_V2_ROUTER02) throw new Error("UNSUPPORTED_EXECUTION_TARGET");
  const path = quote.path.map(normalizeAddress);
  if (path.length !== 2) throw new Error("MULTIHOP_NOT_SUPPORTED");
  const token = normalizeAddress(quote.targetToken);
  if (quote.direction === "BUY" && (path[0] !== WRAPPED_NATIVE || path[1] !== token)) throw new Error("UNSUPPORTED_PATH");
  if (quote.direction === "SELL" && (path[0] !== token || path[1] !== WRAPPED_NATIVE)) throw new Error("UNSUPPORTED_PATH");
  const deadline = quote.expiresAt;
  let data;
  let value;
  if (quote.direction === "BUY") {
    data = `${SELECTORS.BUY}${word(quote.minimumOutput)}${word(128)}${addressWord(quote.recipient)}${word(deadline)}${pathTail(path)}`;
    value = quote.amountIn;
  } else if (quote.direction === "SELL") {
    data = `${SELECTORS.SELL}${word(quote.amountIn)}${word(quote.minimumOutput)}${word(160)}${addressWord(quote.recipient)}${word(deadline)}${pathTail(path)}`;
    value = "0";
  } else {
    throw new Error("UNSUPPORTED_DIRECTION");
  }
  const transaction = { chainId: CHAIN_ID, to: UNISWAP_V2_ROUTER02, value, data, deadline, quoteId: quote.id };
  if (quote.direction === "SELL") {
    transaction.approval = buildExactApproval({ token, spender: UNISWAP_V2_ROUTER02, amount: quote.amountIn, chainId: CHAIN_ID });
  }
  return Object.freeze(transaction);
}

export function buildPonsV2CurveTransaction(quote) {
  if (quote.chainId !== CHAIN_ID) throw new Error("UNSUPPORTED_CHAIN");
  if (normalizeAddress(quote.factory) !== PONS_V2_FACTORY) throw new Error("UNSUPPORTED_FACTORY");
  if (normalizeAddress(quote.pairToken) !== ZERO_ADDRESS) throw new Error("PONS_ERC20_QUOTE_NOT_SUPPORTED");
  const curve = normalizeAddress(quote.curve);
  const token = normalizeAddress(quote.targetToken);
  const recipient = normalizeAddress(quote.recipient);
  const amountIn = asBigInt(quote.amountIn, "amountIn");
  const minimumOutput = asBigInt(quote.minimumOutput, "minimumOutput");
  if (amountIn <= 0n || minimumOutput <= 0n) throw new Error("INVALID_PONS_AMOUNT");
  if (quote.direction === "BUY") {
    return Object.freeze({
      chainId: CHAIN_ID,
      venue: "PONS_V2_CURVE",
      to: curve,
      value: amountIn.toString(),
      data: `${PONS_V2_SELECTORS.BUY}${word(amountIn)}${word(minimumOutput)}${addressWord(recipient)}`,
      deadline: quote.expiresAt,
      quoteId: quote.id,
      provenance: Object.freeze({ factory: PONS_V2_FACTORY, curve, token }),
    });
  }
  if (quote.direction === "SELL") {
    return Object.freeze({
      chainId: CHAIN_ID,
      venue: "PONS_V2_CURVE",
      to: curve,
      value: "0",
      data: `${PONS_V2_SELECTORS.SELL}${word(amountIn)}${word(minimumOutput)}${addressWord(recipient)}`,
      deadline: quote.expiresAt,
      quoteId: quote.id,
      approval: buildPonsV2ExactApproval({ token, curve, amount: amountIn, chainId: CHAIN_ID, factory: quote.factory }),
      provenance: Object.freeze({ factory: PONS_V2_FACTORY, curve, token }),
    });
  }
  throw new Error("UNSUPPORTED_DIRECTION");
}

export function buildPonsV2ExactApproval({ token, curve, amount, chainId, factory }) {
  if (chainId !== CHAIN_ID || normalizeAddress(factory) !== PONS_V2_FACTORY) throw new Error("UNSUPPORTED_PONS_APPROVAL");
  const spender = normalizeAddress(curve);
  return Object.freeze({
    chainId,
    to: normalizeAddress(token),
    value: "0",
    data: `0x095ea7b3${addressWord(spender)}${word(amount)}`,
    approvalAmount: asBigInt(amount).toString(),
    spender,
  });
}
