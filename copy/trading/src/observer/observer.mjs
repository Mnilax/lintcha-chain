import { SOURCE_STATES } from "../constants.mjs";
import { normalizeAddress, normalizeHash } from "../utils.mjs";
import { AdapterSkip } from "./uniswap-v2-adapter.mjs";

export class Observer {
  constructor({ adapter, targetWallet }) {
    this.adapter = adapter;
    this.targetWallet = normalizeAddress(targetWallet);
    this.cursor = null;
    this.canonical = new Map();
    this.events = new Map();
    this.transitions = [];
  }

  ingestLatest(block, fixtures) {
    const number = Number(block.number);
    const hash = normalizeHash(block.hash);
    const parentHash = normalizeHash(block.parentHash);
    if (!Number.isSafeInteger(number) || number < 0) throw new TypeError("invalid block number");

    const knownHash = this.canonical.get(number);
    if (knownHash && knownHash !== hash) this.#retractFrom(number, "CANONICAL_HASH_CHANGED");

    if (this.cursor && number > this.cursor.number + 1) {
      return { accepted: false, halt: true, reason: "BLOCK_GAP", expected: this.cursor.number + 1, received: number };
    }
    if (this.cursor && number === this.cursor.number + 1 && parentHash !== this.cursor.hash) {
      return { accepted: false, halt: true, reason: "PARENT_HASH_MISMATCH", expectedParent: this.cursor.hash, receivedParent: parentHash };
    }
    if (this.cursor && number < this.cursor.number && knownHash === hash) {
      return this.#decodeFixtures(number, hash, fixtures, true);
    }

    this.canonical.set(number, hash);
    if (!this.cursor || number >= this.cursor.number) this.cursor = { number, hash };
    return this.#decodeFixtures(number, hash, fixtures, false);
  }

  markSafe(number) {
    return this.#advanceState(Number(number), SOURCE_STATES.PROVISIONAL, SOURCE_STATES.CONFIRMED, "SAFE_BLOCK_REACHED");
  }

  markFinalized(number) {
    return this.#advanceState(Number(number), SOURCE_STATES.CONFIRMED, SOURCE_STATES.FINALIZED, "FINALIZED_BLOCK_REACHED");
  }

  snapshot() {
    return {
      cursor: this.cursor ? { ...this.cursor } : null,
      canonical: [...this.canonical.entries()].sort((a, b) => a[0] - b[0]),
      events: [...this.events.values()].map((event) => ({ ...event })),
      transitions: this.transitions.map((item) => ({ ...item })),
    };
  }

  #decodeFixtures(number, hash, fixtures, replay) {
    const created = [];
    const skipped = [];
    let duplicates = 0;
    for (const fixture of fixtures) {
      if (Number(BigInt(fixture.receipt?.blockNumber ?? -1)) !== number || fixture.receipt?.blockHash?.toLowerCase() !== hash) {
        skipped.push({ code: "BLOCK_ENVELOPE_MISMATCH", transactionHash: fixture.transaction?.hash ?? null });
        continue;
      }
      try {
        const canonical = this.adapter.decode(fixture, this.targetWallet);
        const existing = this.events.get(canonical.sourceId);
        if (existing && existing.state !== SOURCE_STATES.RETRACTED) {
          duplicates += 1;
          continue;
        }
        const event = {
          ...canonical,
          state: SOURCE_STATES.PROVISIONAL,
          stateReason: replay && existing ? "REAPPEARED_AFTER_REORG" : "LATEST_BLOCK_OBSERVED",
          revision: (existing?.revision ?? 0) + 1,
        };
        this.events.set(event.sourceId, event);
        this.#transition(event, SOURCE_STATES.PROVISIONAL, event.stateReason);
        created.push({ ...event });
      } catch (error) {
        if (!(error instanceof AdapterSkip)) throw error;
        skipped.push({ code: error.code, detail: error.message, transactionHash: fixture.transaction?.hash ?? null });
      }
    }
    return { accepted: true, halt: false, created, skipped, duplicates };
  }

  #advanceState(number, from, to, reason) {
    const changed = [];
    for (const event of this.events.values()) {
      if (event.state !== from || event.blockNumber > number) continue;
      if (this.canonical.get(event.blockNumber) !== event.blockHash) continue;
      event.state = to;
      event.stateReason = reason;
      event.revision += 1;
      this.#transition(event, to, reason);
      changed.push({ ...event });
    }
    return changed;
  }

  #retractFrom(number, reason) {
    for (const event of this.events.values()) {
      if (event.blockNumber < number || event.state === SOURCE_STATES.RETRACTED) continue;
      event.state = SOURCE_STATES.RETRACTED;
      event.stateReason = reason;
      event.revision += 1;
      this.#transition(event, SOURCE_STATES.RETRACTED, reason);
    }
    for (const blockNumber of [...this.canonical.keys()]) if (blockNumber >= number) this.canonical.delete(blockNumber);
    if (this.cursor?.number >= number) this.cursor = null;
  }

  #transition(event, state, reason) {
    this.transitions.push(Object.freeze({
      id: `${event.sourceId}:${event.revision}`,
      sourceId: event.sourceId,
      state,
      reason,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      revision: event.revision,
    }));
  }
}
