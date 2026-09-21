import { decodeFixture } from "./uniswap-v2-decoder.mjs";
import {
  CHAIN_ID,
  SELECTORS,
  UNISWAP_V2_FACTORY,
  UNISWAP_V2_ROUTER02,
  V2_SWAP_TOPIC,
} from "../constants.mjs";
import { normalizeAddress, normalizeHash } from "../utils.mjs";

export class AdapterSkip extends Error {
  constructor(code, detail) {
    super(detail ?? code);
    this.name = "AdapterSkip";
    this.code = code;
  }
}

export class UniswapV2ObserverAdapter {
  constructor() {
    this.id = "uniswap-v2-router02-chain-4663-v1";
  }

  decode(fixture, targetWallet) {
    const tx = fixture?.transaction;
    const receipt = fixture?.receipt;
    if (!tx || !receipt) throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE");
    if (Number(fixture.source?.chainId) !== CHAIN_ID) throw new AdapterSkip("UNSUPPORTED_CHAIN");
    if (normalizeAddress(tx.from) !== normalizeAddress(targetWallet)) throw new AdapterSkip("TARGET_MISMATCH");
    if (normalizeAddress(tx.to) !== UNISWAP_V2_ROUTER02) throw new AdapterSkip("UNSUPPORTED_ROUTER");
    const selector = String(tx.input ?? "").slice(0, 10).toLowerCase();
    if (selector !== SELECTORS.BUY && selector !== SELECTORS.SELL) throw new AdapterSkip("UNSUPPORTED_SELECTOR", selector);
    if (normalizeAddress(fixture.context?.pairState?.factory) !== UNISWAP_V2_FACTORY) throw new AdapterSkip("UNSUPPORTED_FACTORY");

    let decoded;
    try {
      decoded = decodeFixture(fixture);
    } catch (error) {
      throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", error.message);
    }

    const swapLogs = receipt.logs.filter((log) =>
      log.address?.toLowerCase() === decoded.pair && log.topics?.[0]?.toLowerCase() === V2_SWAP_TOPIC,
    );
    if (swapLogs.length !== 1) throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", "ambiguous Swap log");
    const logIndex = Number(BigInt(swapLogs[0].logIndex));
    const txHash = normalizeHash(tx.hash);
    const blockHash = normalizeHash(receipt.blockHash);
    const sourceId = `${CHAIN_ID}:${txHash}:${logIndex}`;

    return Object.freeze({
      schemaVersion: 1,
      sourceId,
      adapterId: this.id,
      chainId: CHAIN_ID,
      transactionHash: txHash,
      logIndex,
      blockNumber: Number(BigInt(receipt.blockNumber)),
      blockHash,
      sourceWallet: normalizeAddress(tx.from),
      direction: decoded.direction,
      router: decoded.router,
      pair: decoded.pair,
      wrappedNative: decoded.wrappedNative,
      targetToken: decoded.targetToken,
      sourceAmount: decoded.sourceAmount,
      actualPairInput: decoded.actualPairInput,
      actualPairOutput: decoded.actualPairOutput,
      minimumOutput: decoded.minimumOutput,
      observedAt: fixture.capturedAt,
    });
  }
}
