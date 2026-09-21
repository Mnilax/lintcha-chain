import { CHAIN_ID, PONS_V2_FACTORY, ZERO_ADDRESS } from "../constants.mjs";
import { asBigInt, deterministicId, normalizeAddress, normalizeHash } from "../utils.mjs";
import { QuoteRefusal } from "./quote.mjs";

function amountOut(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) throw new QuoteRefusal("PONS_INSUFFICIENT_LIQUIDITY");
  const output = amountIn * reserveOut / (reserveIn + amountIn);
  if (output <= 0n) throw new QuoteRefusal("PONS_INSUFFICIENT_OUTPUT");
  return output;
}

function impactBps(amountIn, reserveIn, reserveOut, output) {
  const spotOutput = amountIn * reserveOut / reserveIn;
  if (spotOutput <= 0n || output >= spotOutput) return 0;
  return Number((spotOutput - output) * 10_000n / spotOutput);
}

export class PonsV2QuoteEngine {
  constructor({ provider, chainId = CHAIN_ID }) {
    this.provider = provider;
    this.chainId = chainId;
  }

  async quote({ direction, launch, amountIn, recipient, slippageBps, maxPriceImpactBps, ttlSeconds, nowSeconds, sourceState }) {
    if (this.chainId !== CHAIN_ID) throw new QuoteRefusal("UNSUPPORTED_CHAIN");
    if (sourceState !== "CONFIRMED" && sourceState !== "FINALIZED") throw new QuoteRefusal("SOURCE_NOT_CONFIRMED");
    if (!['BUY', 'SELL'].includes(direction)) throw new QuoteRefusal("UNSUPPORTED_DIRECTION");
    if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new QuoteRefusal("INVALID_SLIPPAGE");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new QuoteRefusal("INVALID_TTL");
    if (normalizeAddress(launch.factory) !== PONS_V2_FACTORY) throw new QuoteRefusal("UNSUPPORTED_FACTORY");
    if (normalizeAddress(launch.pairToken) !== ZERO_ADDRESS) throw new QuoteRefusal("PONS_ERC20_QUOTE_NOT_SUPPORTED");

    const curve = normalizeAddress(launch.curve);
    const token = normalizeAddress(launch.token);
    const state = await this.provider.getCurveState({ curve });
    const block = await this.provider.getBlockReference();
    if (state.graduated || state.readyToGraduate) throw new QuoteRefusal("PONS_CURVE_GRADUATED");
    if (normalizeAddress(state.factory) !== PONS_V2_FACTORY || normalizeAddress(state.token) !== token || normalizeAddress(state.pairToken) !== ZERO_ADDRESS) {
      throw new QuoteRefusal("PONS_PROVENANCE_MISMATCH");
    }
    const feeBps = asBigInt(state.feeBps, "feeBps");
    const taxBps = asBigInt(state.creatorTaxBps, "creatorTaxBps");
    if (feeBps + taxBps > 2_000n) throw new QuoteRefusal("PONS_FEE_POLICY_INVALID");
    const input = asBigInt(amountIn, "amountIn");
    const quoteReserve = asBigInt(state.quoteReserve, "quoteReserve");
    const tokenReserve = asBigInt(state.tokenReserve, "tokenReserve");
    let output;
    let pricingInput;
    let reserveIn;
    let reserveOut;
    if (direction === "BUY") {
      pricingInput = input * (10_000n - feeBps - taxBps) / 10_000n;
      reserveIn = quoteReserve;
      reserveOut = tokenReserve;
      output = amountOut(pricingInput, reserveIn, reserveOut);
      const sellable = tokenReserve - asBigInt(state.reservedTokens, "reservedTokens");
      if (sellable <= 0n || output > sellable) throw new QuoteRefusal("PONS_PARTIAL_FILL_NOT_SUPPORTED");
    } else {
      pricingInput = input;
      reserveIn = tokenReserve;
      reserveOut = quoteReserve;
      const gross = amountOut(input, reserveIn, reserveOut);
      output = gross * (10_000n - feeBps - taxBps) / 10_000n;
    }
    const priceImpactBps = impactBps(pricingInput, reserveIn, reserveOut, direction === "SELL" ? output * 10_000n / (10_000n - feeBps - taxBps) : output);
    if (priceImpactBps > maxPriceImpactBps) throw new QuoteRefusal("PRICE_IMPACT_EXCEEDED");
    const minimumOutput = output * BigInt(10_000 - slippageBps) / 10_000n;
    const routeHash = deterministicId(CHAIN_ID, PONS_V2_FACTORY, curve, token, direction, input, output, block.number, block.hash);
    return Object.freeze({
      id: deterministicId(routeHash, recipient, nowSeconds, ttlSeconds),
      venue: "PONS_V2_CURVE",
      chainId: CHAIN_ID,
      direction,
      factory: PONS_V2_FACTORY,
      curve,
      router: curve,
      spender: direction === "SELL" ? curve : null,
      pairToken: ZERO_ADDRESS,
      recipient: normalizeAddress(recipient),
      targetToken: token,
      amountIn: input.toString(),
      expectedOutput: output.toString(),
      minimumOutput: minimumOutput.toString(),
      slippageBps,
      priceImpactBps,
      estimatedGas: String(state.estimatedGas),
      venueFeeBps: feeBps.toString(),
      creatorTaxBps: taxBps.toString(),
      blockNumber: Number(block.number),
      blockHash: normalizeHash(block.hash),
      routeHash,
      createdAt: nowSeconds,
      expiresAt: nowSeconds + ttlSeconds,
    });
  }
}
