const SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const BUY_SELECTOR = "0xb6f9de95";
const SELL_SELECTOR = "0x791ac947";
const PAIR_SWAP_SELECTOR = "0x022c0d9f";
const MAINNET_ROUTER = "0x89e5db8b5aa49aa85ac63f691524311aeb649eba";

function fail(message) {
  throw new Error(`UNSUPPORTED_SWAP: ${message}`);
}

function normalizeAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) fail("invalid address");
  return value.toLowerCase();
}

function words(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x") || (hex.length - 2) % 64 !== 0) fail("malformed ABI data");
  return hex.slice(2).match(/.{64}/g) ?? [];
}

function uint(word) {
  return BigInt(`0x${word}`);
}

function addressWord(word) {
  return normalizeAddress(`0x${word.slice(24)}`);
}

function decodeAddressArray(allWords, offsetBytes) {
  if (offsetBytes % 32n !== 0n) fail("unaligned dynamic offset");
  const start = Number(offsetBytes / 32n);
  if (!Number.isSafeInteger(start) || start >= allWords.length) fail("path offset out of range");
  const length = Number(uint(allWords[start]));
  if (!Number.isSafeInteger(length) || length < 2 || start + 1 + length > allWords.length) fail("invalid path length");
  return allWords.slice(start + 1, start + 1 + length).map(addressWord);
}

function decodeRouterCall(input, value) {
  const selector = input.slice(0, 10).toLowerCase();
  const allWords = words(`0x${input.slice(10)}`);
  if (allWords.length < 5) fail("truncated router calldata");

  if (selector === BUY_SELECTOR) {
    const path = decodeAddressArray(allWords, uint(allWords[1]));
    if (BigInt(value) <= 0n) fail("buy has no native input");
    return {
      selector,
      direction: "BUY",
      sourceAmount: BigInt(value),
      minimumOutput: uint(allWords[0]),
      path,
      recipient: addressWord(allWords[2]),
      deadline: uint(allWords[3]),
    };
  }

  if (selector === SELL_SELECTOR) {
    const path = decodeAddressArray(allWords, uint(allWords[2]));
    if (BigInt(value) !== 0n) fail("sell unexpectedly carries native value");
    return {
      selector,
      direction: "SELL",
      sourceAmount: uint(allWords[0]),
      minimumOutput: uint(allWords[1]),
      path,
      recipient: addressWord(allWords[3]),
      deadline: uint(allWords[4]),
    };
  }

  fail(`selector ${selector} is not allowlisted`);
}

function decodeSwapLog(log) {
  const data = words(log.data);
  if (data.length !== 4) fail("V2 Swap event must contain four amounts");
  return {
    pair: normalizeAddress(log.address),
    amount0In: uint(data[0]),
    amount1In: uint(data[1]),
    amount0Out: uint(data[2]),
    amount1Out: uint(data[3]),
  };
}

export function decodeFixture(fixture) {
  if (!fixture?.transaction || !fixture?.receipt || !fixture?.context?.pairState) fail("incomplete fixture");
  if (fixture.receipt.status !== "0x1") fail("transaction failed");
  if (fixture.transaction.hash?.toLowerCase() !== fixture.receipt.transactionHash?.toLowerCase()) fail("transaction/receipt mismatch");

  const pairState = fixture.context.pairState;
  const expectedPair = normalizeAddress(pairState.pair);
  const token0 = normalizeAddress(pairState.token0);
  const token1 = normalizeAddress(pairState.token1);
  const wrappedNative = normalizeAddress(fixture.context.wrappedNative);
  if (wrappedNative !== token0 && wrappedNative !== token1) fail("pair does not contain wrapped native asset");

  const swapLogs = fixture.receipt.logs.filter((log) =>
    log.address?.toLowerCase() === expectedPair && log.topics?.[0]?.toLowerCase() === SWAP_TOPIC,
  );
  if (swapLogs.length !== 1) fail(`expected exactly one allowlisted pair Swap event, got ${swapLogs.length}`);
  const swap = decodeSwapLog(swapLogs[0]);

  const wrappedIsToken0 = wrappedNative === token0;
  const wrappedIn = wrappedIsToken0 ? swap.amount0In : swap.amount1In;
  const wrappedOut = wrappedIsToken0 ? swap.amount0Out : swap.amount1Out;
  const targetIn = wrappedIsToken0 ? swap.amount1In : swap.amount0In;
  const targetOut = wrappedIsToken0 ? swap.amount1Out : swap.amount0Out;
  let direction;
  let actualInput;
  let actualOutput;
  if (wrappedIn > 0n && targetOut > 0n && wrappedOut === 0n && targetIn === 0n) {
    direction = "BUY";
    actualInput = wrappedIn;
    actualOutput = targetOut;
  } else if (targetIn > 0n && wrappedOut > 0n && wrappedIn === 0n && targetOut === 0n) {
    direction = "SELL";
    actualInput = targetIn;
    actualOutput = wrappedOut;
  } else {
    fail("ambiguous pair-side deltas");
  }

  const targetToken = wrappedIsToken0 ? token1 : token0;
  const topLevelSelector = fixture.transaction.input.slice(0, 10).toLowerCase();
  let call = null;
  if (topLevelSelector === BUY_SELECTOR || topLevelSelector === SELL_SELECTOR) {
    if (fixture.source.chainId !== 4663) fail("router calls are accepted only on the researched mainnet");
    if (normalizeAddress(fixture.transaction.to) !== MAINNET_ROUTER) fail("router address is not allowlisted");
    call = decodeRouterCall(fixture.transaction.input, fixture.transaction.value);
    if (call.direction !== direction) fail("calldata direction disagrees with receipt");
    if (call.path[0] !== (direction === "BUY" ? wrappedNative : targetToken)) fail("unexpected path input");
    if (call.path.at(-1) !== (direction === "BUY" ? targetToken : wrappedNative)) fail("unexpected path output");
  } else if (topLevelSelector === PAIR_SWAP_SELECTOR) {
    if (fixture.source.trustedForProductionResearch) fail("direct pair swaps are fixtures only");
  } else {
    fail(`selector ${topLevelSelector} is not allowlisted`);
  }

  return {
    chainId: fixture.source.chainId,
    blockNumber: BigInt(fixture.receipt.blockNumber).toString(),
    transactionHash: fixture.transaction.hash.toLowerCase(),
    direction,
    venue: fixture.source.venue,
    trustedForProductionResearch: Boolean(fixture.source.trustedForProductionResearch),
    router: call ? normalizeAddress(fixture.transaction.to) : null,
    pair: expectedPair,
    wrappedNative,
    targetToken,
    sourceAmount: (call?.sourceAmount ?? actualInput).toString(),
    actualPairInput: actualInput.toString(),
    actualPairOutput: actualOutput.toString(),
    minimumOutput: call?.minimumOutput?.toString() ?? null,
    recipient: call?.recipient ?? null,
    deadline: call?.deadline?.toString() ?? null,
  };
}
