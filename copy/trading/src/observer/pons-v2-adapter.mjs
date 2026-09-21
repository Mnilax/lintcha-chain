import { CHAIN_ID, PONS_V2_FACTORY, PONS_V2_SELECTORS } from "../constants.mjs";
import { asBigInt, normalizeAddress, normalizeHash } from "../utils.mjs";
import { AdapterSkip } from "./uniswap-v2-adapter.mjs";

export { PONS_V2_FACTORY, PONS_V2_SELECTORS };

export const PONS_V2_TOPICS = Object.freeze({
  CURVE_BUY: "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455",
  CURVE_SELL: "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df",
  TOKEN_LAUNCHED: "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607",
});

function word(input, index) {
  const start = 10 + index * 64;
  const value = input.slice(start, start + 64);
  if (!/^[0-9a-f]{64}$/.test(value)) throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", "invalid calldata word");
  return value;
}

function addressWord(value) {
  if (!/^0{24}[0-9a-f]{40}$/.test(value)) throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", "invalid encoded address");
  return normalizeAddress(`0x${value.slice(24)}`);
}

function topicAddress(value) {
  if (typeof value !== "string" || !/^0x0{24}[0-9a-fA-F]{40}$/.test(value)) {
    throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", "invalid indexed address");
  }
  return normalizeAddress(`0x${value.slice(-40)}`);
}

function dataWords(data, expected) {
  const body = String(data ?? "").toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${expected * 64}}$`).test(body)) {
    throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", "invalid event data");
  }
  return Array.from({ length: expected }, (_, index) => asBigInt(`0x${body.slice(2 + index * 64, 2 + (index + 1) * 64)}`));
}

function provenance(fixture, curve) {
  const record = fixture?.context?.ponsV2Launch;
  if (!record) throw new AdapterSkip("PONS_LAUNCH_PROVENANCE_MISSING");
  if (normalizeAddress(record.factory) !== PONS_V2_FACTORY) throw new AdapterSkip("UNSUPPORTED_FACTORY");
  if (normalizeAddress(record.curve) !== curve) throw new AdapterSkip("PONS_CURVE_MISMATCH");
  if (String(record.eventTopic ?? "").toLowerCase() !== PONS_V2_TOPICS.TOKEN_LAUNCHED) {
    throw new AdapterSkip("PONS_LAUNCH_PROVENANCE_INVALID");
  }
  return {
    token: normalizeAddress(record.token),
    pairToken: normalizeAddress(record.pairToken),
    launchTransactionHash: normalizeHash(record.transactionHash),
  };
}

export class PonsV2CurveObserverAdapter {
  constructor() {
    this.id = "pons-v2-bonding-curve-chain-4663-v1";
  }

  decode(fixture, targetWallet) {
    const tx = fixture?.transaction;
    const receipt = fixture?.receipt;
    if (!tx || !receipt) throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE");
    if (Number(fixture.source?.chainId) !== CHAIN_ID) throw new AdapterSkip("UNSUPPORTED_CHAIN");

    const target = normalizeAddress(targetWallet);
    if (normalizeAddress(tx.from) !== target) throw new AdapterSkip("TARGET_MISMATCH");
    if (receipt.status !== "0x1" && receipt.status !== 1 && receipt.status !== "ok") {
      throw new AdapterSkip("FAILED_TRANSACTION");
    }

    const curve = normalizeAddress(tx.to);
    const launch = provenance(fixture, curve);
    const input = String(tx.input ?? "").toLowerCase();
    if (!/^0x[0-9a-f]+$/.test(input) || input.length !== 202) {
      throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", "expected selector plus three static words");
    }
    const selector = input.slice(0, 10);
    const direction = selector === PONS_V2_SELECTORS.BUY ? "BUY"
      : selector === PONS_V2_SELECTORS.SELL ? "SELL"
        : null;
    if (!direction) throw new AdapterSkip("UNSUPPORTED_SELECTOR", selector);

    const requestedInput = asBigInt(`0x${word(input, 0)}`);
    const minimumOutput = asBigInt(`0x${word(input, 1)}`);
    const recipient = addressWord(word(input, 2));
    if (recipient !== target) throw new AdapterSkip("RECIPIENT_MISMATCH");

    const eventTopic = direction === "BUY" ? PONS_V2_TOPICS.CURVE_BUY : PONS_V2_TOPICS.CURVE_SELL;
    const matchingLogs = receipt.logs.filter((log) =>
      normalizeAddress(log.address) === curve && String(log.topics?.[0] ?? "").toLowerCase() === eventTopic,
    );
    if (matchingLogs.length !== 1) throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", "ambiguous Pons curve event");

    const log = matchingLogs[0];
    const actor = topicAddress(log.topics?.[1]);
    const eventRecipient = topicAddress(log.topics?.[2]);
    if (actor !== target || eventRecipient !== target) throw new AdapterSkip("ACTOR_MISMATCH");
    const [actualInput, actualOutput, fee, tax] = dataWords(log.data, 4);
    if (direction === "BUY" && actualInput > requestedInput) throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", "buy spent more than requested");
    if (direction === "SELL" && actualInput !== requestedInput) throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", "sell input mismatch");
    if (actualOutput < minimumOutput) throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", "output below calldata minimum");
    if (launch.pairToken === "0x0000000000000000000000000000000000000000") {
      const value = asBigInt(tx.value ?? 0);
      if (direction === "BUY" && value !== requestedInput) throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", "native buy value mismatch");
      if (direction === "SELL" && value !== 0n) throw new AdapterSkip("SOURCE_TRANSACTION_UNREADABLE", "native value on sell");
    }

    const txHash = normalizeHash(tx.hash);
    const blockHash = normalizeHash(receipt.blockHash);
    const logIndex = Number(BigInt(log.logIndex));
    return Object.freeze({
      schemaVersion: 1,
      sourceId: `${CHAIN_ID}:${txHash}:${logIndex}`,
      adapterId: this.id,
      chainId: CHAIN_ID,
      transactionHash: txHash,
      logIndex,
      blockNumber: Number(BigInt(receipt.blockNumber)),
      blockHash,
      sourceWallet: target,
      direction,
      venue: "Pons V2 Bonding Curve",
      router: curve,
      curve,
      factory: PONS_V2_FACTORY,
      pairToken: launch.pairToken,
      targetToken: launch.token,
      sourceAmount: actualInput.toString(),
      actualOutput: actualOutput.toString(),
      minimumOutput: minimumOutput.toString(),
      venueFee: fee.toString(),
      creatorTax: tax.toString(),
      launchTransactionHash: launch.launchTransactionHash,
      observedAt: fixture.capturedAt,
    });
  }
}
