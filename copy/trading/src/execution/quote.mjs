import { asBigInt, deterministicId, normalizeAddress, normalizeHash } from "../utils.mjs";
import { CHAIN_ID, UNISWAP_V2_ROUTER02, WRAPPED_NATIVE } from "../constants.mjs";

export class QuoteRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = "QuoteRefusal";
    this.code = code;
  }
}

export class QuoteEngine {
  constructor({ provider, chainId = CHAIN_ID, router = UNISWAP_V2_ROUTER02 }) {
    this.provider = provider;
    this.chainId = chainId;
    this.router = normalizeAddress(router);
  }

  async quote({ direction, targetToken, amountIn, recipient, slippageBps, maxPriceImpactBps, ttlSeconds, nowSeconds, sourceState }) {
    if (this.chainId !== CHAIN_ID || this.router !== UNISWAP_V2_ROUTER02) throw new QuoteRefusal("UNSUPPORTED_EXECUTION_TARGET");
    if (sourceState !== "CONFIRMED" && sourceState !== "FINALIZED") throw new QuoteRefusal("SOURCE_NOT_CONFIRMED");
    if (!['BUY','SELL'].includes(direction)) throw new QuoteRefusal("UNSUPPORTED_DIRECTION");
    if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 10000) throw new QuoteRefusal("INVALID_SLIPPAGE");
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new QuoteRefusal("INVALID_TTL");
    const token = normalizeAddress(targetToken);
    const path = direction === "BUY" ? [WRAPPED_NATIVE, token] : [token, WRAPPED_NATIVE];
    const input = asBigInt(amountIn, "amountIn");
    const block = await this.provider.getBlockReference();
    const result = await this.provider.getAmountsOut({ amountIn: input, path, blockNumber: block.number });
    const output = asBigInt(result.amountOut, "amountOut");
    if (result.priceImpactBps > maxPriceImpactBps) throw new QuoteRefusal("PRICE_IMPACT_EXCEEDED");
    const minimumOutput = output * BigInt(10000 - slippageBps) / 10000n;
    const routeHash = deterministicId(this.chainId, this.router, ...path, input, output, block.number, block.hash);
    const quote = {
      id: deterministicId(routeHash, recipient, nowSeconds, ttlSeconds),
      chainId: this.chainId,
      direction,
      router: this.router,
      spender: direction === "SELL" ? this.router : null,
      recipient: normalizeAddress(recipient),
      targetToken: token,
      path,
      amountIn: input.toString(),
      expectedOutput: output.toString(),
      minimumOutput: minimumOutput.toString(),
      slippageBps,
      priceImpactBps: result.priceImpactBps,
      estimatedGas: String(result.estimatedGas),
      blockNumber: Number(block.number),
      blockHash: normalizeHash(block.hash),
      routeHash,
      createdAt: nowSeconds,
      expiresAt: nowSeconds + ttlSeconds,
    };
    return Object.freeze(quote);
  }
}

export function assertFreshQuote(quote, { nowSeconds, currentBlockHash }) {
  if (nowSeconds > quote.expiresAt) throw new QuoteRefusal("QUOTE_EXPIRED");
  if (currentBlockHash && normalizeHash(currentBlockHash) !== quote.blockHash) throw new QuoteRefusal("QUOTE_BLOCK_CHANGED");
  return true;
}
