import { asBigInt, normalizeAddress } from "../utils.mjs";

export const FREE_PERIOD_SECONDS = 7 * 24 * 60 * 60;
export const PLATFORM_FEE_BPS = 100;

export class FeeSchedule {
  constructor({ version, activationAtSeconds }) {
    if (!Number.isSafeInteger(version) || version <= 0 || !Number.isSafeInteger(activationAtSeconds) || activationAtSeconds < 0) throw new TypeError("invalid fee schedule");
    this.version = version;
    this.activationAtSeconds = activationAtSeconds;
    this.freeUntilSeconds = activationAtSeconds + FREE_PERIOD_SECONDS;
  }

  rateAt(timestampSeconds) {
    if (!Number.isSafeInteger(timestampSeconds)) throw new TypeError("invalid timestamp");
    return timestampSeconds < this.freeUntilSeconds ? 0 : PLATFORM_FEE_BPS;
  }

  preview({ timestampSeconds, feeBaseAmount, feeAsset }) {
    const base = asBigInt(feeBaseAmount, "feeBaseAmount");
    const feeBps = this.rateAt(timestampSeconds);
    const feeAmount = base * BigInt(feeBps) / 10000n;
    return Object.freeze({
      scheduleVersion: this.version,
      activationAtSeconds: this.activationAtSeconds,
      freeUntilSeconds: this.freeUntilSeconds,
      feeBps,
      feeBase: base.toString(),
      feeAsset: normalizeAddress(feeAsset),
      feeAmount: feeAmount.toString(),
      rounding: "FLOOR_TOWARD_ZERO",
    });
  }
}

export function verifyAtomicOutputFee({ preview, grossOutput, userOutput, feeTransferAmount, feeTransferRecipient, expectedRecipient }) {
  const gross = asBigInt(grossOutput);
  const user = asBigInt(userOutput);
  const transfer = asBigInt(feeTransferAmount);
  if (transfer !== BigInt(preview.feeAmount)) throw new Error("FEE_AMOUNT_MISMATCH");
  if (normalizeAddress(feeTransferRecipient) !== normalizeAddress(expectedRecipient)) throw new Error("FEE_RECIPIENT_MISMATCH");
  if (user + transfer !== gross) throw new Error("HIDDEN_OR_MISSING_OUTPUT");
  return Object.freeze({ verified: true, grossOutput: gross.toString(), userOutput: user.toString(), feeAmount: transfer.toString(), asset: preview.feeAsset });
}

function decodeStaticTriplet(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{192}$/.test(value)) {
    throw new Error(`${label}_INVALID_ABI`);
  }
  const body = value.slice(2);
  return {
    token: normalizeAddress(`0x${body.slice(24, 64)}`),
    recipient: normalizeAddress(`0x${body.slice(88, 128)}`),
    amount: BigInt(`0x${body.slice(128, 192)}`),
  };
}

export function decodeUniversalRouterFeeTail({ commands, inputs }) {
  if (typeof commands !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(commands)) throw new Error("INVALID_COMMAND_BYTES");
  const commandBytes = commands.slice(2).match(/.{2}/g).map((value) => Number.parseInt(value, 16) & 0x7f);
  if (!Array.isArray(inputs) || inputs.length !== commandBytes.length) throw new Error("COMMAND_INPUT_LENGTH_MISMATCH");
  if (commandBytes.length < 3 || commandBytes.at(-2) !== 0x06 || commandBytes.at(-1) !== 0x04) {
    throw new Error("PAY_PORTION_SWEEP_TAIL_REQUIRED");
  }
  const pay = decodeStaticTriplet(inputs.at(-2), "PAY_PORTION");
  const sweep = decodeStaticTriplet(inputs.at(-1), "SWEEP");
  if (pay.token !== sweep.token) throw new Error("FEE_SWEEP_ASSET_MISMATCH");
  if (pay.amount > 10000n) throw new Error("INVALID_FEE_BIPS");
  return Object.freeze({
    swapCommands: Object.freeze(commandBytes.slice(0, -2)),
    feeAsset: pay.token,
    feeRecipient: pay.recipient,
    feeBps: Number(pay.amount),
    userRecipient: sweep.recipient,
    userAmountMinimum: sweep.amount.toString(),
  });
}

export function assessUniversalRouterEvidence(evidence) {
  const blockers = [];
  if (!evidence.officialTestnetManifest) blockers.push("OFFICIAL_TESTNET_MANIFEST_MISSING");
  if (!evidence.sourceVersionVerified) blockers.push("SOURCE_VERSION_UNVERIFIED");
  if (!evidence.bytecodePinned) blockers.push("BYTECODE_NOT_PINNED");
  if (!evidence.reproducibleReceipt?.verified) blockers.push("ATOMIC_TESTNET_RECEIPT_MISSING");
  if (!evidence.reproducibleReceipt?.exactUserAndFeeDeltas) blockers.push("EXACT_DELTAS_MISSING");
  return Object.freeze({ accepted: blockers.length === 0, blockers });
}
